import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAllowedOrigin, isAllowedOriginHeader } from "../lib/allowedOrigin";
import { registerBunServer } from "../lib/lifecycle";
import { isPublicPath } from "../lib/publicPath";
import { unauthenticatedResponse } from "../lib/uiRequestSecurity";
import { authenticateRequest } from "./auth";
import { createConcurrencyGate, readRequestBodyLimited } from "./requestLimits";

type WsData = {
	wsTarget: string;
	back: WebSocket | null;
	queue: (string | ArrayBuffer)[];
};

const MAX_WS_QUEUE = 100;
const MAX_BUFFERED_FORWARDS = 16;
export const MAX_TLS_PUBLIC_BODY_BYTES = 2 * 1024;
const DEFAULT_FORWARD_TIMEOUT_MS = 30_000;
const VOICE_FORWARD_TIMEOUT_MS = 70_000;
const TLS_IDLE_TIMEOUT_SECONDS = 75;

const SKIP_REQ = new Set([
	"host",
	"connection",
	"keep-alive",
	"x-hlid-internal",
	"x-hlid-proxy-token",
	"x-hlid-forwarded-proto",
	"x-hlid-forwarded-client-ip",
]);
const SKIP_RES = new Set(["connection", "keep-alive", "transfer-encoding"]);

type HttpForwarderOptions = {
	uiPort: number;
	internalToken: string;
	maxBodyBytes: number;
	maxConcurrent?: number;
	authenticate?: (request: Request) => Promise<boolean>;
	forward?: (input: string, init: RequestInit) => Promise<Response>;
};

function buildForwardHeaders(
	request: Request,
	peerIp: string | undefined,
	internalToken: string,
): Headers {
	const headers = new Headers();
	for (const [key, value] of request.headers.entries()) {
		if (!SKIP_REQ.has(key.toLowerCase())) headers.set(key, value);
	}
	headers.set("x-hlid-forwarded-proto", "https");
	headers.set("x-hlid-forwarded-client-ip", peerIp ?? "");
	headers.set("x-hlid-proxy-token", internalToken);
	return headers;
}

function proxyResponse(upstream: Response): Response {
	const headers = new Headers();
	for (const [key, value] of upstream.headers.entries()) {
		if (SKIP_RES.has(key.toLowerCase())) continue;
		if (key.toLowerCase() === "set-cookie") headers.append(key, value);
		else headers.set(key, value);
	}
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

function isExpectedUpstreamFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("abort") ||
		message.includes("Abort") ||
		message.includes("ConnectionRefused") ||
		message.includes("ECONNREFUSED") ||
		(error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ConnectionRefused")
	);
}

async function forwardRequest(
	forward: NonNullable<HttpForwarderOptions["forward"]>,
	input: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await forward(input, { ...init, signal: controller.signal });
	} catch (error) {
		if (!isExpectedUpstreamFailure(error)) {
			console.error("[tlsProxy] upstream fetch failed:", error);
		}
		return new Response("Service Unavailable", { status: 503 });
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Build the bounded HTTP half of the TLS proxy. Authentication and admission
 * happen before any body bytes are read, which keeps untrusted requests from
 * consuming the proxy's buffering budget.
 */
export function createTlsHttpForwarder({
	uiPort,
	internalToken,
	maxBodyBytes,
	maxConcurrent = MAX_BUFFERED_FORWARDS,
	authenticate = authenticateRequest,
	forward = fetch,
}: HttpForwarderOptions): (req: Request, peerIp?: string) => Promise<Response> {
	const gate = createConcurrencyGate(maxConcurrent);

	return async (req, peerIp) => {
		const url = new URL(req.url);
		if (!isPublicPath(url.pathname) && !(await authenticate(req))) {
			return unauthenticatedResponse(req);
		}

		const hasBody = req.method !== "GET" && req.method !== "HEAD";
		const release = hasBody ? gate.tryEnter() : () => {};
		if (!release) {
			return Response.json(
				{ error: "proxy_capacity_reached" },
				{ status: 429, headers: { "retry-after": "1" } },
			);
		}

		try {
			let body: ArrayBuffer | undefined;
			if (hasBody) {
				const limit = isPublicPath(url.pathname)
					? Math.min(maxBodyBytes, MAX_TLS_PUBLIC_BODY_BYTES)
					: maxBodyBytes;
				try {
					const limited = await readRequestBodyLimited(req, limit);
					if (!limited.ok) return limited.response;
					body = limited.body;
				} catch {
					return new Response("Client Disconnected", { status: 499 });
				}
			}

			const upstream = await forwardRequest(
				forward,
				`http://127.0.0.1:${uiPort}${url.pathname}${url.search}`,
				{
					method: req.method,
					headers: buildForwardHeaders(req, peerIp, internalToken),
					body,
				},
				url.pathname === "/api/voice/transcribe"
					? VOICE_FORWARD_TIMEOUT_MS
					: DEFAULT_FORWARD_TIMEOUT_MS,
			);
			return proxyResponse(upstream);
		} finally {
			release();
		}
	};
}

export type TlsProxyOptions = {
	tlsPort: number;
	uiPort: number;
	wsPort: number;
	bindHost: string;
	certPath: string;
	keyPath: string;
	localNetworkAccess: boolean;
	internalToken: string;
	maxBodyBytes: number;
};

export function startTlsProxy({
	tlsPort,
	uiPort,
	wsPort,
	bindHost,
	certPath,
	keyPath,
	localNetworkAccess,
	internalToken,
	maxBodyBytes,
}: TlsProxyOptions): void {
	const certBuf = readFileSync(certPath);
	const x509 = new X509Certificate(certBuf);
	const san = x509.subjectAltName ?? "";
	const dnsSan = san.split(/,\s*/).find((s) => s.startsWith("DNS:"));
	const tlsHostname = dnsSan ? dnsSan.slice(4) : "localhost";
	const forwardHttp = createTlsHttpForwarder({
		uiPort,
		internalToken,
		maxBodyBytes,
	});

	registerBunServer(
		Bun.serve<WsData>({
			port: tlsPort,
			hostname: bindHost,
			// Local Whisper may legitimately take up to 60 seconds. Keep the public
			// Tailscale connection alive long enough to return that response.
			idleTimeout: TLS_IDLE_TIMEOUT_SECONDS,
			maxRequestBodySize: maxBodyBytes,
			tls: {
				cert: Bun.file(certPath),
				key: Bun.file(keyPath),
			},
			websocket: {
				open(ws) {
					ws.data.queue = [];
					const BunWebSocket = WebSocket as unknown as new (
						url: string,
						options: { headers: Record<string, string> },
					) => WebSocket;
					const back = new BunWebSocket(ws.data.wsTarget, {
						headers: { "x-hlid-internal": internalToken },
					});
					ws.data.back = back;
					const connectTimeout = setTimeout(() => {
						if (back.readyState === WebSocket.CONNECTING) {
							ws.data.queue = [];
							back.close();
							ws.close();
						}
					}, 10_000);
					back.onopen = () => {
						clearTimeout(connectTimeout);
						for (const msg of ws.data.queue) ws.data.back?.send(msg);
						ws.data.queue = [];
					};
					back.onmessage = (ev) => {
						if (ws.readyState === WebSocket.OPEN) ws.send(ev.data);
					};
					back.onclose = () => {
						clearTimeout(connectTimeout);
						ws.close();
					};
					back.onerror = () => {
						clearTimeout(connectTimeout);
						ws.close();
					};
				},
				message(ws, data) {
					// Normalize to string | ArrayBuffer — Uint8Array<ArrayBufferLike> is
					// not assignable to WebSocket.send()'s BufferSource without a copy.
					const payload: string | ArrayBuffer =
						typeof data === "string"
							? data
							: (data.buffer.slice(
									data.byteOffset,
									data.byteOffset + data.byteLength,
								) as ArrayBuffer);
					if (ws.data.back?.readyState === WebSocket.OPEN) {
						ws.data.back.send(payload);
					} else if (ws.data.back?.readyState === WebSocket.CONNECTING) {
						if (ws.data.queue.length >= MAX_WS_QUEUE) {
							ws.data.queue.shift(); // drop oldest to bound memory
						}
						ws.data.queue.push(payload);
					} else {
						// Backend CLOSING or CLOSED — drop message and shut down client.
						ws.close();
					}
				},
				close(ws) {
					ws.data.back?.close();
				},
			},
			async fetch(req, server) {
				const peerIp = server.requestIP(req)?.address;
				if (!isAllowedOrigin(peerIp, localNetworkAccess)) {
					return new Response("Forbidden", { status: 403 });
				}

				const url = new URL(req.url);

				if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
					if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
						if (
							!isAllowedOriginHeader(
								req.headers.get("origin"),
								localNetworkAccess,
							)
						) {
							return new Response("Forbidden", { status: 403 });
						}
						if (!(await authenticateRequest(req))) {
							return new Response("Unauthorized", { status: 401 });
						}
						const upgraded = server.upgrade(req, {
							data: {
								wsTarget: `ws://127.0.0.1:${wsPort}${url.pathname}${url.search}`,
								back: null,
								queue: [],
							},
						});
						if (!upgraded)
							return new Response("WebSocket upgrade failed", { status: 500 });
						return undefined;
					}
					return new Response("Bad Request", { status: 400 });
				}

				return forwardHttp(req, peerIp);
			},
		}),
	);

	console.log(
		`TLS proxy listening on :${tlsPort} → https://${tlsHostname}:${tlsPort}`,
	);
}
