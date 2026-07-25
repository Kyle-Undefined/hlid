import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { isAllowedOrigin, isAllowedOriginHeader } from "../lib/allowedOrigin";
import { registerBunServer } from "../lib/lifecycle";
import { isPublicPath } from "../lib/publicPath";
import { unauthenticatedResponse } from "../lib/uiRequestSecurity";
import { authenticateRequest, readCookie } from "./auth";
import { SERVER_FN_NAMES } from "./embedded-server-fn-names";
import { compressHttpResponse } from "./httpCompression";
import {
	parseProjectPreviewRelayPath,
	projectPreviewSelectionCookieHeader,
	projectPreviewWebSocketProtocols,
	selectedProjectPreviewId,
} from "./projectPreviewRelay";
import { createRequestObserver } from "./requestDiagnostics";
import { createConcurrencyGate, readRequestBodyLimited } from "./requestLimits";
import type { UiForward } from "./uiServer";

type WsData = {
	wsTarget: string;
	back: WebSocket | null;
	queue: (string | ArrayBuffer)[];
	forwardHeaders?: Record<string, string>;
	protocols?: string[];
};

const MAX_WS_QUEUE = 100;
const MAX_BUFFERED_FORWARDS = 16;
export const MAX_TLS_PUBLIC_BODY_BYTES = 2 * 1024;
const DEFAULT_FORWARD_TIMEOUT_MS = 30_000;
const SAFE_FORWARD_FIRST_ATTEMPT_MS = 5_000;
const VOICE_FORWARD_TIMEOUT_MS = 70_000;
const TLS_IDLE_TIMEOUT_SECONDS = 75;
const PREVIEW_SELECTION_TTL_MS = 4 * 60 * 60 * 1_000;
const MAX_REMEMBERED_PREVIEW_CLIENTS = 64;
const PREVIEW_RELAY_PATH =
	/^\/api\/project-previews\/[0-9a-f-]+\/relay(?:\/|$)/i;
const observeTlsForward = createRequestObserver({
	scope: "tls-proxy",
	requestName: (request) => {
		const pathname = new URL(request.url).pathname;
		if (!pathname.startsWith("/_serverFn/")) return undefined;
		const id = pathname.slice("/_serverFn/".length).split("/")[0];
		return id ? SERVER_FN_NAMES[id] : undefined;
	},
	slowRequestMs: () => undefined,
	// The UI listener records returned 5xx responses with richer context. The
	// proxy only needs to record failures that prevent reaching that listener.
	reportServerErrors: false,
});

const SKIP_REQ = new Set([
	"host",
	"connection",
	"keep-alive",
	"x-hlid-internal",
	"x-hlid-preview-origin",
	"x-hlid-proxy-token",
	"x-hlid-forwarded-proto",
	"x-hlid-forwarded-client-ip",
]);
const SKIP_RES = new Set(["connection", "keep-alive", "transfer-encoding"]);

type HttpForwarderOptions = {
	uiPort: number;
	apiPort?: number;
	internalToken: string;
	maxBodyBytes: number;
	maxConcurrent?: number;
	authenticate?: (request: Request) => Promise<boolean>;
	forward?: (input: string, init: RequestInit) => Promise<Response>;
	apiForward?: (input: string, init: RequestInit) => Promise<Response>;
	forwardHeaders?: Record<string, string>;
};

function buildForwardHeaders(
	request: Request,
	peerIp: string | undefined,
	internalToken: string,
	forwardHeaders?: Record<string, string>,
): Headers {
	const headers = new Headers();
	for (const [key, value] of request.headers.entries()) {
		if (!SKIP_REQ.has(key.toLowerCase())) headers.set(key, value);
	}
	headers.set("x-hlid-forwarded-proto", "https");
	headers.set("x-hlid-forwarded-client-ip", peerIp ?? "");
	headers.set("x-hlid-proxy-token", internalToken);
	for (const [name, value] of Object.entries(forwardHeaders ?? {})) {
		headers.set(name, value);
	}
	// Bun fetch transparently decodes compressed upstream bodies but preserves
	// Content-Encoding. Request identity bytes on the loopback hop so the public
	// proxy never labels already-decoded HTML as gzip.
	headers.set("accept-encoding", "identity");
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

async function forwardAttempt(
	forward: NonNullable<HttpForwarderOptions["forward"]>,
	input: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	let rejectTimeout: ((reason?: unknown) => void) | undefined;
	const timeoutPromise = new Promise<Response>((_resolve, reject) => {
		rejectTimeout = reject;
	});
	const timeoutId = setTimeout(() => {
		controller.abort();
		rejectTimeout?.(controller.signal.reason);
	}, timeoutMs);
	try {
		return await Promise.race([
			forward(input, { ...init, signal: controller.signal }),
			timeoutPromise,
		]);
	} finally {
		clearTimeout(timeoutId);
	}
}

async function forwardRequest(
	forward: NonNullable<HttpForwarderOptions["forward"]>,
	input: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const requestHeaders = new Headers(init.headers);
	const requestId = requestHeaders.get("x-hlid-request-id");
	const method = init.method?.toUpperCase() ?? "GET";
	const diagnosticRequest = new Request(input, {
		method,
		headers: requestId ? { "x-hlid-request-id": requestId } : undefined,
	});
	try {
		return await observeTlsForward(diagnosticRequest, async () => {
			if (method !== "GET" && method !== "HEAD") {
				return forwardAttempt(forward, input, init, timeoutMs);
			}

			const deadline = performance.now() + timeoutMs;
			try {
				return await forwardAttempt(
					forward,
					input,
					init,
					Math.min(SAFE_FORWARD_FIRST_ATTEMPT_MS, timeoutMs),
				);
			} catch {
				const remainingMs = Math.floor(deadline - performance.now());
				if (remainingMs <= 0) throw new Error("TLS upstream timed out");
				return forwardAttempt(forward, input, init, remainingMs);
			}
		});
	} catch {
		return new Response("Service Unavailable", { status: 503 });
	}
}

/**
 * Build the bounded HTTP half of the TLS proxy. Authentication and admission
 * happen before any body bytes are read, which keeps untrusted requests from
 * consuming the proxy's buffering budget.
 */
export function createTlsHttpForwarder({
	uiPort,
	apiPort,
	internalToken,
	maxBodyBytes,
	maxConcurrent = MAX_BUFFERED_FORWARDS,
	authenticate = authenticateRequest,
	forward = fetch,
	apiForward = fetch,
	forwardHeaders,
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

			const previewRelay = url.pathname.startsWith("/api/project-previews/");
			const targetPort = previewRelay ? (apiPort ?? uiPort) : uiPort;
			const upstream = await forwardRequest(
				previewRelay ? apiForward : forward,
				`http://127.0.0.1:${targetPort}${url.pathname}${url.search}`,
				{
					method: req.method,
					headers: buildForwardHeaders(
						req,
						peerIp,
						internalToken,
						forwardHeaders,
					),
					body,
				},
				url.pathname === "/api/voice/transcribe"
					? VOICE_FORWARD_TIMEOUT_MS
					: DEFAULT_FORWARD_TIMEOUT_MS,
			);
			// Compress exactly once at the public edge, negotiated against the real
			// browser request rather than the proxy's internal fetch implementation.
			return compressHttpResponse(req, proxyResponse(upstream));
		} finally {
			release();
		}
	};
}

export type TlsProxyOptions = {
	tlsPort: number;
	uiPort: number;
	wsPort: number;
	apiPort?: number;
	bindHost: string;
	certPath: string;
	keyPath: string;
	localNetworkAccess: boolean;
	internalToken: string;
	maxBodyBytes: number;
	forward?: UiForward;
};

function createTlsWebSocketHandlers(internalToken: string) {
	return {
		open(ws: ServerWebSocket<WsData>) {
			ws.data.queue = [];
			const BunWebSocket = WebSocket as unknown as new (
				url: string,
				options: {
					headers: Record<string, string>;
					protocols?: string[];
				},
			) => WebSocket;
			const back = new BunWebSocket(ws.data.wsTarget, {
				headers: {
					"x-hlid-internal": internalToken,
					...(ws.data.forwardHeaders ?? {}),
				},
				protocols: ws.data.protocols,
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
				for (const message of ws.data.queue) ws.data.back?.send(message);
				ws.data.queue = [];
			};
			back.onmessage = (event) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(event.data);
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
		message(ws: ServerWebSocket<WsData>, data: string | Buffer) {
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
				if (ws.data.queue.length >= MAX_WS_QUEUE) ws.data.queue.shift();
				ws.data.queue.push(payload);
			} else {
				ws.close();
			}
		},
		close(ws: ServerWebSocket<WsData>) {
			ws.data.back?.close();
		},
	};
}

export function startTlsProxy({
	tlsPort,
	uiPort,
	wsPort,
	apiPort,
	bindHost,
	certPath,
	keyPath,
	localNetworkAccess,
	internalToken,
	maxBodyBytes,
	forward,
}: TlsProxyOptions): void {
	const certBuf = readFileSync(certPath);
	const x509 = new X509Certificate(certBuf);
	const san = x509.subjectAltName ?? "";
	const dnsSan = san.split(/,\s*/).find((s) => s.startsWith("DNS:"));
	const tlsHostname = dnsSan ? dnsSan.slice(4) : "localhost";
	const forwardHttp = createTlsHttpForwarder({
		uiPort,
		apiPort,
		internalToken,
		maxBodyBytes,
		forward,
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
			websocket: createTlsWebSocketHandlers(internalToken),
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
				if (PREVIEW_RELAY_PATH.test(url.pathname)) {
					return new Response("Use the isolated Project Preview origin.", {
						status: 421,
					});
				}

				return forwardHttp(req, peerIp);
			},
		}),
	);

	console.log(
		`TLS proxy listening on :${tlsPort} → https://${tlsHostname}:${tlsPort}`,
	);

	const previewTlsPort = tlsPort + 1;
	const previewForward = createTlsHttpForwarder({
		uiPort: apiPort ?? wsPort,
		apiPort: apiPort ?? wsPort,
		internalToken,
		maxBodyBytes,
		authenticate: async () => true,
		forwardHeaders: { "x-hlid-preview-origin": "1" },
	});
	const previewSelections = new Map<
		string,
		{ previewId: string; lastUsedAt: number }
	>();
	const rememberedPreview = (
		request: Request,
		explicitPreviewId?: string,
	): string | null => {
		const sessionToken = readCookie(request);
		if (!sessionToken) return null;
		const client = createHash("sha256").update(sessionToken).digest("hex");
		const now = Date.now();
		if (explicitPreviewId) {
			previewSelections.set(client, {
				previewId: explicitPreviewId,
				lastUsedAt: now,
			});
			if (previewSelections.size > MAX_REMEMBERED_PREVIEW_CLIENTS) {
				for (const [key, selection] of previewSelections) {
					if (now - selection.lastUsedAt > PREVIEW_SELECTION_TTL_MS) {
						previewSelections.delete(key);
					}
				}
				while (previewSelections.size > MAX_REMEMBERED_PREVIEW_CLIENTS) {
					const oldest = previewSelections.keys().next().value;
					if (!oldest) break;
					previewSelections.delete(oldest);
				}
			}
			return explicitPreviewId;
		}
		const selection = previewSelections.get(client);
		if (!selection || now - selection.lastUsedAt > PREVIEW_SELECTION_TTL_MS) {
			previewSelections.delete(client);
			return null;
		}
		selection.lastUsedAt = now;
		return selection.previewId;
	};
	registerBunServer(
		Bun.serve<WsData>({
			port: previewTlsPort,
			hostname: bindHost,
			idleTimeout: TLS_IDLE_TIMEOUT_SECONDS,
			maxRequestBodySize: maxBodyBytes,
			tls: {
				cert: Bun.file(certPath),
				key: Bun.file(keyPath),
			},
			websocket: createTlsWebSocketHandlers(internalToken),
			async fetch(req, server) {
				const peerIp = server.requestIP(req)?.address;
				if (!isAllowedOrigin(peerIp, localNetworkAccess)) {
					return new Response("Forbidden", { status: 403 });
				}
				const url = new URL(req.url);
				const explicitPreviewId = parseProjectPreviewRelayPath(
					url.pathname,
				)?.previewId;
				const selectedPreviewId =
					explicitPreviewId ??
					rememberedPreview(req) ??
					selectedProjectPreviewId(req.headers.get("cookie"));
				if (!explicitPreviewId && !selectedPreviewId) {
					return new Response("Not found", { status: 404 });
				}
				if (!(await authenticateRequest(req))) {
					return new Response("Unauthorized", {
						status: 401,
						headers: { "cache-control": "no-store" },
					});
				}
				if (explicitPreviewId) {
					rememberedPreview(req, explicitPreviewId);
				}
				if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
					if (
						!isAllowedOriginHeader(
							req.headers.get("origin"),
							localNetworkAccess,
						)
					) {
						return new Response("Forbidden", { status: 403 });
					}
					const upgraded = server.upgrade(req, {
						data: {
							wsTarget: `ws://127.0.0.1:${wsPort}${url.pathname}${url.search}`,
							back: null,
							queue: [],
							forwardHeaders: {
								"x-hlid-preview-origin": "1",
								...(req.headers.get("cookie")
									? { cookie: req.headers.get("cookie") ?? "" }
									: {}),
							},
							protocols: projectPreviewWebSocketProtocols(req),
						},
					});
					if (!upgraded) {
						return new Response("WebSocket upgrade failed", { status: 500 });
					}
					return undefined;
				}
				if (!explicitPreviewId && selectedPreviewId) {
					const headers = new Headers(req.headers);
					headers.set(
						"cookie",
						projectPreviewSelectionCookieHeader(
							req.headers.get("cookie"),
							selectedPreviewId,
						),
					);
					return previewForward(new Request(req, { headers }), peerIp);
				}
				return previewForward(req, peerIp);
			},
		}),
	);
	console.log(
		`Project Preview TLS relay on :${previewTlsPort} → https://${tlsHostname}:${previewTlsPort}`,
	);
}
