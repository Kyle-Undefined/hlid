import { randomBytes } from "node:crypto";
import type { Server } from "bun";
import { verifyToken } from "../lib/token";
import {
	projectPreviewResponseSetCookies,
	projectPreviewUpstreamTarget,
	projectPreviewWebSocketProtocols,
} from "./projectPreviewRelay";
import {
	PROJECT_PREVIEW_AUTH_HEADER,
	type ProjectPreviewCapability,
	projectPreviewCapabilityHeaders,
} from "./projectPreviewTrust";
import { readRequestBodyLimited } from "./requestLimits";
import {
	createWebSocketBridgeHandlers,
	type WebSocketBridgeData,
} from "./webSocketBridge";

const AGENT_RELAY_COOKIE_PREFIX = "__hlid_agent_preview_";
const AGENT_RELAY_BACKEND_PATH = "/__hlid_backend__";
const MAX_AGENT_RELAY_HTML_BYTES = 20 * 1024 * 1024;
const AGENT_RELAY_UPSTREAM_TIMEOUT_MS = 10_000;
export const PROJECT_PREVIEW_AGENT_RELAY_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const STRIP_REQUEST_HEADERS = new Set([
	"connection",
	"content-length",
	"host",
	"origin",
	"proxy-authorization",
	"referer",
	PROJECT_PREVIEW_AUTH_HEADER,
	"sec-websocket-accept",
	"sec-websocket-extensions",
	"sec-websocket-key",
	"sec-websocket-protocol",
	"sec-websocket-version",
	"transfer-encoding",
	"upgrade",
	"x-hlid-forwarded-client-ip",
	"x-hlid-forwarded-proto",
	"x-hlid-internal",
	"x-hlid-preview-origin",
	"x-hlid-proxy-token",
]);
const STRIP_RESPONSE_HEADERS = new Set([
	"connection",
	"content-encoding",
	"content-length",
	"content-security-policy",
	"content-security-policy-report-only",
	"set-cookie",
	"transfer-encoding",
]);
const AGENT_RELAY_CONTENT_SECURITY_POLICY = [
	"default-src 'self' data: blob:",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"worker-src 'self' blob:",
	"form-action 'self'",
	"base-uri 'none'",
	"object-src 'none'",
].join("; ");

export type ProjectPreviewAgentRelayBrowserAccess = Readonly<{
	origin: string;
	cookieName: string;
	cookieToken: string;
}>;

export type ProjectPreviewAgentRelay = {
	browserAccess: ProjectPreviewAgentRelayBrowserAccess;
	close(): Promise<void>;
};

export type ProjectPreviewAgentRelayFactory = (input: {
	targetPort: number;
	capability: ProjectPreviewCapability;
}) => Promise<ProjectPreviewAgentRelay>;

type AgentRelayWebSocketData = WebSocketBridgeData & {
	upstreamHeaders: Record<string, string>;
};

function cookieValue(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(/;\s*/)) {
		const equals = part.indexOf("=");
		if (equals <= 0 || part.slice(0, equals) !== name) continue;
		return part.slice(equals + 1);
	}
	return null;
}

export function projectPreviewAgentRelayUpstreamCookies(
	header: string | null,
): string | null {
	if (!header) return null;
	const cookies = header.split(/;\s*/).filter((part) => {
		const equals = part.indexOf("=");
		return (
			equals > 0 && !part.slice(0, equals).startsWith(AGENT_RELAY_COOKIE_PREFIX)
		);
	});
	return cookies.length > 0 ? cookies.join("; ") : null;
}

function requestHeaders(
	request: Request,
	targetPort: number,
	capability: ProjectPreviewCapability,
): Headers {
	const headers = new Headers();
	for (const [name, value] of request.headers.entries()) {
		if (!STRIP_REQUEST_HEADERS.has(name.toLowerCase()) && name !== "cookie") {
			headers.set(name, value);
		}
	}
	const cookies = projectPreviewAgentRelayUpstreamCookies(
		request.headers.get("cookie"),
	);
	if (cookies) headers.set("cookie", cookies);
	headers.set("accept-encoding", "identity");
	headers.set("origin", `http://127.0.0.1:${targetPort}`);
	for (const [name, value] of Object.entries(
		projectPreviewCapabilityHeaders(capability),
	)) {
		headers.set(name, value);
	}
	return headers;
}

function responseHeaders(headers: Headers): Headers {
	const forwarded = new Headers();
	for (const [name, value] of headers.entries()) {
		if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) {
			forwarded.set(name, value);
		}
	}
	for (const value of projectPreviewResponseSetCookies(headers)) {
		const name = value.slice(0, value.indexOf("=")).trim();
		if (!name.startsWith(AGENT_RELAY_COOKIE_PREFIX)) {
			forwarded.append("set-cookie", value);
		}
	}
	return forwarded;
}

export function projectPreviewAgentRelayBootstrap(): string {
	return `<script>(()=>{document.currentScript?.remove();const sw=navigator.serviceWorker;if(sw){const blocked=()=>Promise.reject(new DOMException("Service workers are disabled in Hlid Project Preview.","SecurityError"));try{Object.defineProperty(sw,"register",{configurable:true,value:blocked})}catch{try{sw.register=blocked}catch{}}void sw.getRegistrations().then((registrations)=>Promise.all(registrations.map((registration)=>registration.unregister()))).catch(()=>{})}const backend=${JSON.stringify(AGENT_RELAY_BACKEND_PATH)};const rewrite=(value)=>{try{const source=typeof value==="string"?value:value instanceof URL?value.href:value.url;const url=new URL(source,location.href);const pagePort=Number(location.port||80);const targetPort=Number(url.port||(url.protocol==="https:"||url.protocol==="wss:"?443:80));const socket=url.protocol==="ws:"||url.protocol==="wss:";const sameEndpoint=url.hostname===location.hostname&&targetPort===pagePort;if(url.hostname===location.hostname&&targetPort===pagePort+1){url.protocol=socket?"ws:":location.protocol;url.host=location.host;url.pathname=backend+url.pathname;return url.toString()}if(socket&&sameEndpoint&&(url.pathname==="/ws"||url.pathname.startsWith("/ws/"))){url.pathname=backend+url.pathname;return url.toString()}}catch{}return value};const NativeWebSocket=window.WebSocket;const RelayWebSocket=function(url,protocols){return new NativeWebSocket(rewrite(url),protocols)};Object.setPrototypeOf(RelayWebSocket,NativeWebSocket);RelayWebSocket.prototype=NativeWebSocket.prototype;window.WebSocket=RelayWebSocket;const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>nativeFetch(typeof input==="string"?rewrite(input):input,init);const nativeOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){return nativeOpen.call(this,method,rewrite(url),...rest)}})();</script>`;
}

function injectBootstrap(html: string): string {
	const script = projectPreviewAgentRelayBootstrap();
	const head = html.search(/<head(?:\s[^>]*)?>/i);
	if (head >= 0) {
		const end = html.indexOf(">", head);
		if (end >= 0) {
			return `${html.slice(0, end + 1)}${script}${html.slice(end + 1)}`;
		}
	}
	return `${script}${html}`;
}

function rewriteLocation(
	location: string,
	targetPort: number,
	relayOrigin: string,
): string {
	try {
		const resolved = new URL(location, `http://127.0.0.1:${targetPort}`);
		if (
			(resolved.hostname === "127.0.0.1" ||
				resolved.hostname === "localhost") &&
			resolved.port === String(targetPort)
		) {
			return `${relayOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`;
		}
		if (
			(resolved.hostname === "127.0.0.1" ||
				resolved.hostname === "localhost") &&
			resolved.port === String(targetPort + 1)
		) {
			return `${relayOrigin}${AGENT_RELAY_BACKEND_PATH}${resolved.pathname}${resolved.search}${resolved.hash}`;
		}
	} catch {}
	return location;
}

async function relayHttpResponse(
	upstream: Response,
	targetPort: number,
	relayOrigin: string,
): Promise<Response> {
	const headers = responseHeaders(upstream.headers);
	headers.set("content-security-policy", AGENT_RELAY_CONTENT_SECURITY_POLICY);
	const location = headers.get("location");
	if (location) {
		headers.set("location", rewriteLocation(location, targetPort, relayOrigin));
	}
	const contentType = headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.includes("text/html")) {
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	}
	const body = await upstream.arrayBuffer();
	if (body.byteLength > MAX_AGENT_RELAY_HTML_BYTES) {
		return new Response("Project Preview response is too large.", {
			status: 502,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}
	return new Response(injectBootstrap(new TextDecoder().decode(body)), {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

function randomRelayAccess(): Omit<
	ProjectPreviewAgentRelayBrowserAccess,
	"origin"
> & { hostname: string } {
	const id = randomBytes(16).toString("hex");
	return {
		hostname: `hlid-${id}.localhost`,
		cookieName: `${AGENT_RELAY_COOKIE_PREFIX}${id}`,
		cookieToken: randomBytes(32).toString("base64url"),
	};
}

export const createProjectPreviewAgentRelay: ProjectPreviewAgentRelayFactory =
	async ({ targetPort, capability }) => {
		const access = randomRelayAccess();
		const websocket = createWebSocketBridgeHandlers<AgentRelayWebSocketData>({
			headers: (data) => data.upstreamHeaders,
		});
		let server: Server<AgentRelayWebSocketData>;
		server = Bun.serve<AgentRelayWebSocketData>({
			hostname: "127.0.0.1",
			port: 0,
			websocket,
			async fetch(request, bunServer) {
				const relayOrigin = `http://${access.hostname}:${server.port}`;
				const url = new URL(request.url);
				if (url.origin !== relayOrigin) {
					return new Response("Misdirected request", { status: 421 });
				}
				if (
					!verifyToken(
						cookieValue(request.headers.get("cookie"), access.cookieName),
						access.cookieToken,
					)
				) {
					return new Response("Unauthorized", {
						status: 401,
						headers: { "cache-control": "no-store" },
					});
				}
				const target = projectPreviewUpstreamTarget(targetPort, url.pathname);
				const headers = requestHeaders(request, target.port, capability);
				if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
					const upgraded = bunServer.upgrade(request, {
						data: {
							wsTarget: `ws://127.0.0.1:${target.port}${target.path}${url.search}`,
							back: null,
							queue: [],
							protocols: projectPreviewWebSocketProtocols(request),
							upstreamHeaders: Object.fromEntries(headers.entries()),
						},
					});
					return upgraded
						? undefined
						: new Response("WebSocket upgrade failed", { status: 500 });
				}
				let body: ArrayBuffer | undefined;
				if (request.method !== "GET" && request.method !== "HEAD") {
					const limited = await readRequestBodyLimited(
						request,
						PROJECT_PREVIEW_AGENT_RELAY_MAX_REQUEST_BYTES,
					);
					if (!limited.ok) return limited.response;
					body = limited.body;
				}
				const upstream = await fetch(
					`http://127.0.0.1:${target.port}${target.path}${url.search}`,
					{
						method: request.method,
						headers,
						body,
						redirect: "manual",
						signal: AbortSignal.any([
							request.signal,
							AbortSignal.timeout(AGENT_RELAY_UPSTREAM_TIMEOUT_MS),
						]),
					},
				);
				return relayHttpResponse(upstream, targetPort, relayOrigin);
			},
		});
		const browserAccess: ProjectPreviewAgentRelayBrowserAccess = {
			origin: `http://${access.hostname}:${server.port}`,
			cookieName: access.cookieName,
			cookieToken: access.cookieToken,
		};
		let closed = false;
		return {
			browserAccess,
			async close() {
				if (closed) return;
				closed = true;
				await server.stop(true);
			},
		};
	};
