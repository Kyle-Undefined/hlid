import type { ServerWebSocket } from "bun";
import { readRequestBodyLimited } from "./requestLimits";

export type ProjectPreviewRelayWsData = {
	isProjectPreviewRelay: true;
	wsTarget: string;
	back: WebSocket | null;
	queue: Array<string | ArrayBuffer>;
};

type RelayTarget = {
	port: number;
};

const MAX_RELAY_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_TRANSFORM_BYTES = 20 * 1024 * 1024;
const MAX_WS_QUEUE = 100;
const RELAY_PATH = /^\/api\/project-previews\/([0-9a-f-]+)\/relay(?:\/(.*))?$/i;
const STRIP_REQUEST_HEADERS = new Set([
	"authorization",
	"connection",
	"cookie",
	"host",
	"origin",
	"proxy-authorization",
	"referer",
	"x-hlid-internal",
	"x-hlid-proxy-token",
]);
const STRIP_RESPONSE_HEADERS = new Set([
	"connection",
	"content-security-policy",
	"content-security-policy-report-only",
	"content-encoding",
	"content-length",
	"set-cookie",
	"transfer-encoding",
	"x-frame-options",
]);
const RELAY_CONTENT_SECURITY_POLICY = [
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

export function parseProjectPreviewRelayPath(
	pathname: string,
): { previewId: string; targetPath: string; prefix: string } | null {
	const match = pathname.match(RELAY_PATH);
	if (!match) return null;
	const previewId = match[1];
	const targetPath = `/${match[2] ?? ""}`;
	return {
		previewId,
		targetPath,
		prefix: `/api/project-previews/${previewId}/relay`,
	};
}

export function parseProjectPreviewRelayWebSocket(
	request: Request,
	pathname: string,
): ReturnType<typeof parseProjectPreviewRelayPath> {
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return null;
	}
	return parseProjectPreviewRelayPath(pathname);
}

function relayRequestHeaders(request: Request, port: number): Headers {
	const headers = new Headers();
	for (const [key, value] of request.headers.entries()) {
		if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
	}
	headers.set("accept-encoding", "identity");
	headers.set("origin", `http://127.0.0.1:${port}`);
	return headers;
}

function rewriteRootReferences(
	text: string,
	contentType: string,
	prefix: string,
): string {
	if (contentType.includes("text/html")) {
		return text
			.replace(/\b(src|href|action|poster)=("|')\/(?!\/)/gi, `$1=$2${prefix}/`)
			.replace(/url\((["']?)\/(?!\/)/gi, `url($1${prefix}/`);
	}
	if (
		contentType.includes("javascript") ||
		contentType.includes("ecmascript")
	) {
		return text.replace(/(["'`])\/(?!\/)/g, `$1${prefix}/`);
	}
	if (contentType.includes("text/css")) {
		return text.replace(/url\((["']?)\/(?!\/)/gi, `url($1${prefix}/`);
	}
	return text;
}

function relayBootstrap(prefix: string): string {
	const value = JSON.stringify(prefix);
	return `<script>(()=>{const p=${value};const rewrite=(value)=>{try{const url=new URL(typeof value==="string"?value:value.url,location.href);if(url.origin===location.origin&&!url.pathname.startsWith(p)){url.pathname=p+url.pathname;return url.toString()}}catch{}return value};const NativeWebSocket=window.WebSocket;const RelayWebSocket=function(url,protocols){return new NativeWebSocket(rewrite(url),protocols)};Object.setPrototypeOf(RelayWebSocket,NativeWebSocket);RelayWebSocket.prototype=NativeWebSocket.prototype;window.WebSocket=RelayWebSocket;const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>nativeFetch(typeof input==="string"?rewrite(input):input,init);const nativeOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){return nativeOpen.call(this,method,rewrite(url),...rest)};const previewId=p.split("/")[3]||"";const route=()=>{const pathname=location.pathname.startsWith(p)?location.pathname.slice(p.length)||"/":location.pathname;return pathname+location.search+location.hash};const sendState=()=>{if(parent===window)return;parent.postMessage({type:"hlid:project-preview-state",version:1,preview_id:previewId,path:route(),width:Math.round(innerWidth),height:Math.round(innerHeight),scroll_x:Math.round(scrollX),scroll_y:Math.round(scrollY)},"*")};let scheduled=false;const scheduleState=()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;sendState()})};for(const name of ["load","resize","scroll","hashchange","popstate"])addEventListener(name,scheduleState,{passive:true});for(const name of ["pushState","replaceState"]){const native=history[name];history[name]=function(...args){const result=native.apply(this,args);scheduleState();return result}}addEventListener("message",(event)=>{if(event.data?.type==="hlid:project-preview-state-request")sendState()});queueMicrotask(sendState)})();</script>`;
}

function injectRelayBootstrap(html: string, prefix: string): string {
	const script = relayBootstrap(prefix);
	const head = html.search(/<head(?:\s[^>]*)?>/i);
	if (head >= 0) {
		const end = html.indexOf(">", head);
		if (end >= 0)
			return `${html.slice(0, end + 1)}${script}${html.slice(end + 1)}`;
	}
	return `${script}${html}`;
}

async function relayResponse(
	upstream: Response,
	prefix: string,
): Promise<Response> {
	const headers = new Headers();
	for (const [key, value] of upstream.headers.entries()) {
		if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
	}
	const location = headers.get("location");
	if (location?.startsWith("/")) {
		headers.set("location", `${prefix}${location}`);
	}
	const contentType = headers.get("content-type")?.toLowerCase() ?? "";
	const transform =
		contentType.includes("text/html") ||
		contentType.includes("javascript") ||
		contentType.includes("ecmascript") ||
		contentType.includes("text/css");
	if (!transform) {
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	}
	const body = await upstream.arrayBuffer();
	if (body.byteLength > MAX_TRANSFORM_BYTES) {
		return new Response("Preview response is too large to relay safely.", {
			status: 502,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}
	let text = new TextDecoder().decode(body);
	text = rewriteRootReferences(text, contentType, prefix);
	if (contentType.includes("text/html")) {
		text = injectRelayBootstrap(text, prefix);
		headers.set("content-security-policy", RELAY_CONTENT_SECURITY_POLICY);
	}
	headers.set("cache-control", "no-store");
	return new Response(text, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

export async function handleProjectPreviewRelayRequest(
	url: URL,
	request: Request,
	resolveTarget: (previewId: string) => RelayTarget,
): Promise<Response | null> {
	const relay = parseProjectPreviewRelayPath(url.pathname);
	if (!relay) return null;
	let target: RelayTarget;
	try {
		target = resolveTarget(relay.previewId);
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 404, headers: { "cache-control": "no-store" } },
		);
	}
	let body: ArrayBuffer | undefined;
	if (request.method !== "GET" && request.method !== "HEAD") {
		const limited = await readRequestBodyLimited(
			request,
			MAX_RELAY_REQUEST_BYTES,
		);
		if (!limited.ok) return limited.response;
		body = limited.body;
	}
	try {
		const upstream = await fetch(
			`http://127.0.0.1:${target.port}${relay.targetPath}${url.search}`,
			{
				method: request.method,
				headers: relayRequestHeaders(request, target.port),
				body,
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			},
		);
		return relayResponse(upstream, relay.prefix);
	} catch {
		return new Response("Project Preview is unavailable.", {
			status: 502,
			headers: {
				"cache-control": "no-store",
				"content-type": "text/plain; charset=utf-8",
			},
		});
	}
}

export function createProjectPreviewRelayWsHandlers() {
	return {
		open(ws: ServerWebSocket<ProjectPreviewRelayWsData>) {
			const back = new WebSocket(ws.data.wsTarget);
			ws.data.back = back;
			const timeout = setTimeout(() => {
				if (back.readyState === WebSocket.CONNECTING) {
					ws.data.queue = [];
					back.close();
					ws.close();
				}
			}, 10_000);
			back.onopen = () => {
				clearTimeout(timeout);
				for (const message of ws.data.queue) back.send(message);
				ws.data.queue = [];
			};
			back.onmessage = (event) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(event.data);
			};
			back.onclose = () => {
				clearTimeout(timeout);
				ws.close();
			};
			back.onerror = () => {
				clearTimeout(timeout);
				ws.close();
			};
		},
		message(
			ws: ServerWebSocket<ProjectPreviewRelayWsData>,
			data: string | Buffer,
		) {
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
		close(ws: ServerWebSocket<ProjectPreviewRelayWsData>) {
			ws.data.back?.close();
		},
	};
}
