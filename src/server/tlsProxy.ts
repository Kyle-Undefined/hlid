import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAllowedOrigin, isAllowedOriginHeader } from "../lib/allowedOrigin";
import { registerBunServer } from "../lib/lifecycle";

type WsData = {
	wsTarget: string;
	back: WebSocket | null;
	queue: (string | ArrayBuffer)[];
};

const MAX_WS_QUEUE = 100;

const SKIP_REQ = new Set(["host", "connection", "keep-alive"]);
const SKIP_RES = new Set(["connection", "keep-alive", "transfer-encoding"]);

export function startTlsProxy(
	tlsPort: number,
	uiPort: number,
	wsPort: number,
	bindHost: string,
	certPath: string,
	keyPath: string,
	localNetworkAccess: boolean,
): void {
	const certBuf = readFileSync(certPath);
	const x509 = new X509Certificate(certBuf);
	const san = x509.subjectAltName ?? "";
	const dnsSan = san.split(/,\s*/).find((s) => s.startsWith("DNS:"));
	const tlsHostname = dnsSan ? dnsSan.slice(4) : "localhost";

	registerBunServer(
		Bun.serve<WsData>({
			port: tlsPort,
			hostname: bindHost,
			idleTimeout: 35,
			tls: {
				cert: Bun.file(certPath),
				key: Bun.file(keyPath),
			},
			websocket: {
				open(ws) {
					ws.data.queue = [];
					const back = new WebSocket(ws.data.wsTarget);
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
				if (
					!isAllowedOrigin(server.requestIP(req)?.address, localNetworkAccess)
				) {
					return new Response("Forbidden", { status: 403 });
				}

				const url = new URL(req.url);

				if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
					if (url.pathname === "/ws") {
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
								wsTarget: `ws://127.0.0.1:${wsPort}/ws${url.search}`,
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

				const fwdHeaders = new Headers();
				for (const [k, v] of req.headers.entries()) {
					if (!SKIP_REQ.has(k.toLowerCase())) fwdHeaders.set(k, v);
				}

				// Buffer body before forwarding — avoids stream-abort propagation when
				// the browser cancels an in-flight request mid-proxy (e.g. quick nav).
				let body: ArrayBuffer | undefined;
				if (req.method !== "GET" && req.method !== "HEAD") {
					try {
						body = await req.arrayBuffer();
					} catch {
						// Client disconnected before body was fully received — nothing to forward.
						return new Response("Client Disconnected", { status: 499 });
					}
				}

				let upstream: Response;
				try {
					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), 30_000);
					upstream = await fetch(
						`http://127.0.0.1:${uiPort}${url.pathname}${url.search}`,
						{
							method: req.method,
							headers: fwdHeaders,
							body,
							signal: controller.signal,
						},
					);
					clearTimeout(timeoutId);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					const isExpected =
						msg.includes("abort") ||
						msg.includes("Abort") ||
						msg.includes("ConnectionRefused") ||
						msg.includes("ECONNREFUSED") ||
						(err instanceof Error &&
							"code" in err &&
							(err as NodeJS.ErrnoException).code === "ConnectionRefused");
					if (!isExpected) {
						console.error("[tlsProxy] upstream fetch failed:", err);
					}
					return new Response("Service Unavailable", { status: 503 });
				}

				const resHeaders = new Headers();
				for (const [k, v] of upstream.headers.entries()) {
					if (SKIP_RES.has(k.toLowerCase())) continue;
					if (k.toLowerCase() === "set-cookie") {
						resHeaders.append(k, v);
					} else {
						resHeaders.set(k, v);
					}
				}

				return new Response(upstream.body, {
					status: upstream.status,
					statusText: upstream.statusText,
					headers: resHeaders,
				});
			},
		}),
	);

	console.log(
		`TLS proxy listening on :${tlsPort} → https://${tlsHostname}:${tlsPort}`,
	);
}
