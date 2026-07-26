import type { ServerWebSocket } from "bun";
import { init, parse } from "es-module-lexer";
import { readRequestBodyLimited } from "./requestLimits";

export type ProjectPreviewRelayWsData = {
	isProjectPreviewRelay: true;
	wsTarget: string;
	back: WebSocket | null;
	queue: Array<string | ArrayBuffer>;
	upstreamHeaders: Record<string, string>;
	protocols?: string[];
};

type RelayTarget = {
	port: number;
};

const MAX_RELAY_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_TRANSFORM_BYTES = 20 * 1024 * 1024;
const MAX_WS_QUEUE = 100;
const RELAY_UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_TRANSFORM_CACHE_ENTRIES = 128;
const MAX_TRANSFORM_CACHE_BYTES = 32 * 1024 * 1024;
export const PROJECT_PREVIEW_OPEN_PARAM = "__hlid_preview_open";
const PREVIEW_SELECTION_COOKIE = "__hlid_preview_selection";
const PREVIEW_BACKEND_PATH = "/__hlid_backend__";
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
	"x-hlid-preview-origin",
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

type CachedRelayTransform = {
	body: string;
	bytes: number;
	previewId: string;
};

const transformCache = new Map<string, CachedRelayTransform>();
const relayControllers = new Map<string, Set<AbortController>>();
let transformCacheBytes = 0;

function transformCacheKey(
	previewId: string,
	requestTarget: string,
	etag: string,
): string {
	return `${previewId}\0${requestTarget}\0${etag}`;
}

function cachedTransform(key: string): CachedRelayTransform | null {
	const cached = transformCache.get(key);
	if (!cached) return null;
	// Refresh insertion order so the bounded map behaves like an LRU.
	transformCache.delete(key);
	transformCache.set(key, cached);
	return cached;
}

function cacheTransform(key: string, value: CachedRelayTransform): void {
	const previous = transformCache.get(key);
	if (previous) {
		transformCacheBytes -= previous.bytes;
		transformCache.delete(key);
	}
	transformCache.set(key, value);
	transformCacheBytes += value.bytes;
	while (
		transformCache.size > MAX_TRANSFORM_CACHE_ENTRIES ||
		transformCacheBytes > MAX_TRANSFORM_CACHE_BYTES
	) {
		const oldestKey = transformCache.keys().next().value;
		if (typeof oldestKey !== "string") break;
		const oldest = transformCache.get(oldestKey);
		transformCache.delete(oldestKey);
		transformCacheBytes -= oldest?.bytes ?? 0;
	}
}

function registerRelayController(
	previewId: string,
	controller: AbortController,
): () => void {
	const controllers = relayControllers.get(previewId) ?? new Set();
	controllers.add(controller);
	relayControllers.set(previewId, controllers);
	return () => {
		controllers.delete(controller);
		if (controllers.size === 0) relayControllers.delete(previewId);
	};
}

/** Abort in-flight work and release transformed assets owned by one preview. */
export function disposeProjectPreviewRelay(previewId?: string): void {
	if (previewId === undefined) {
		for (const controllers of relayControllers.values()) {
			for (const controller of controllers) controller.abort();
		}
		relayControllers.clear();
		transformCache.clear();
		transformCacheBytes = 0;
		return;
	}
	for (const controller of relayControllers.get(previewId) ?? []) {
		controller.abort();
	}
	relayControllers.delete(previewId);
	for (const [key, cached] of transformCache) {
		if (cached.previewId !== previewId) continue;
		transformCache.delete(key);
		transformCacheBytes -= cached.bytes;
	}
}

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

export function projectPreviewWebSocketProtocols(
	request: Request,
): string[] | undefined {
	const protocols = request.headers
		.get("sec-websocket-protocol")
		?.split(",")
		.map((protocol) => protocol.trim())
		.filter(Boolean);
	return protocols && protocols.length > 0 ? protocols : undefined;
}

export function selectedProjectPreviewId(
	cookieHeader: string | null,
): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(/;\s*/)) {
		const [name, value] = part.split("=", 2);
		if (
			name === PREVIEW_SELECTION_COOKIE &&
			value &&
			/^[0-9a-f-]+$/i.test(value)
		) {
			return value;
		}
	}
	return null;
}

export function projectPreviewSelectionCookieHeader(
	cookieHeader: string | null,
	previewId: string,
): string {
	const cookies = (cookieHeader ?? "").split(/;\s*/).filter((cookie) => {
		const equals = cookie.indexOf("=");
		return (
			cookie &&
			(equals < 0 || cookie.slice(0, equals) !== PREVIEW_SELECTION_COOKIE)
		);
	});
	cookies.push(`${PREVIEW_SELECTION_COOKIE}=${previewId}`);
	return cookies.join("; ");
}

export function projectPreviewSelectionRedirect(
	url: URL,
	resolveTarget: (previewId: string) => RelayTarget,
): Response | null {
	if (url.searchParams.get(PROJECT_PREVIEW_OPEN_PARAM) !== "1") return null;
	const relay = parseProjectPreviewRelayPath(url.pathname);
	if (!relay) return null;
	try {
		resolveTarget(relay.previewId);
	} catch {
		return new Response("Project Preview is unavailable.", { status: 404 });
	}
	const location = new URL(relay.targetPath, url);
	for (const [name, value] of url.searchParams) {
		if (name !== PROJECT_PREVIEW_OPEN_PARAM) {
			location.searchParams.append(name, value);
		}
	}
	return new Response(null, {
		status: 302,
		headers: {
			"cache-control": "no-store",
			location: `${location.pathname}${location.search}${location.hash}`,
			"set-cookie": `${PREVIEW_SELECTION_COOKIE}=${relay.previewId}; Path=/; HttpOnly; SameSite=Strict`,
		},
	});
}

export function selectedProjectPreviewRelayUrl(
	url: URL,
	cookieHeader: string | null,
): URL | null {
	if (parseProjectPreviewRelayPath(url.pathname)) return null;
	const previewId = selectedProjectPreviewId(cookieHeader);
	if (!previewId) return null;
	const selected = new URL(url);
	selected.pathname = `/api/project-previews/${previewId}/relay${url.pathname}`;
	return selected;
}

export function projectPreviewUpstreamTarget(
	port: number,
	targetPath: string,
): { port: number; path: string } {
	if (
		targetPath === PREVIEW_BACKEND_PATH ||
		targetPath.startsWith(`${PREVIEW_BACKEND_PATH}/`)
	) {
		return {
			port: port + 1,
			path: targetPath.slice(PREVIEW_BACKEND_PATH.length) || "/",
		};
	}
	return { port, path: targetPath };
}

function relayRequestHeaders(
	request: Request,
	port: number,
	previewId: string,
): Headers {
	const headers = new Headers();
	for (const [key, value] of request.headers.entries()) {
		if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
	}
	const cookie = projectPreviewUpstreamCookieHeader(
		request.headers.get("cookie"),
		previewId,
	);
	if (cookie) headers.set("cookie", cookie);
	headers.set("accept-encoding", "identity");
	headers.set("origin", `http://127.0.0.1:${port}`);
	return headers;
}

function previewCookiePrefix(previewId: string): string {
	return `__hlid_preview_${previewId.replaceAll("-", "")}__`;
}

export function projectPreviewUpstreamCookieHeader(
	header: string | null,
	previewId: string,
): string | null {
	if (!header) return null;
	const prefix = previewCookiePrefix(previewId);
	const cookies: string[] = [];
	for (const part of header.split(/;\s*/)) {
		const equals = part.indexOf("=");
		if (equals <= prefix.length) continue;
		const name = part.slice(0, equals);
		if (!name.startsWith(prefix)) continue;
		const upstreamName = name.slice(prefix.length);
		if (!upstreamName || /[\s;=]/.test(upstreamName)) continue;
		cookies.push(`${upstreamName}=${part.slice(equals + 1)}`);
	}
	return cookies.length > 0 ? cookies.join("; ") : null;
}

function responseSetCookies(headers: Headers): string[] {
	const extended = headers as Headers & { getSetCookie?: () => string[] };
	const values = extended.getSetCookie?.();
	if (values && values.length > 0) return values;
	const combined = headers.get("set-cookie");
	return combined ? [combined] : [];
}

function rewritePreviewSetCookie(
	value: string,
	previewId: string,
): string | null {
	const parts = value.split(";").map((part) => part.trim());
	const pair = parts.shift();
	const equals = pair?.indexOf("=") ?? -1;
	if (!pair || equals <= 0) return null;
	const name = pair.slice(0, equals).trim();
	if (!name || /[\s;=]/.test(name)) return null;
	const attributes = parts.filter(
		(part) => !/^path\s*=/i.test(part) && !/^domain\s*=/i.test(part),
	);
	return [
		`${previewCookiePrefix(previewId)}${name}=${pair.slice(equals + 1)}`,
		"Path=/",
		...attributes,
	].join("; ");
}

async function rewriteJavascriptReferences(
	text: string,
	prefix: string,
): Promise<string> {
	await init;
	const [imports] = parse(text);
	const insertions = new Set<number>();
	for (const imported of imports) {
		if (!imported.n?.startsWith("/") || imported.n.startsWith("//")) continue;
		const position = text.indexOf(imported.n, imported.s);
		if (position >= imported.s && position < imported.e) {
			insertions.add(position);
		}
	}
	const rootedRuntimeReference =
		/(\b(?:export\s+default|new\s+(?:URL|Worker|SharedWorker)|fetch|EventSource)\s*\(\s*|\b(?:src|href|poster|url)\s*:\s*)(["'`])\/(?!\/)/g;
	for (const match of text.matchAll(rootedRuntimeReference)) {
		const quote = match[2];
		const matchIndex = match.index;
		if (!quote || matchIndex === undefined) continue;
		insertions.add(matchIndex + match[0].lastIndexOf(quote) + 1);
	}
	let rewritten = text;
	for (const position of [...insertions].sort((a, b) => b - a)) {
		rewritten =
			rewritten.slice(0, position) + prefix + rewritten.slice(position);
	}
	return rewritten;
}

async function rewriteRootReferences(
	text: string,
	contentType: string,
	prefix: string,
): Promise<string> {
	if (contentType.includes("text/html")) {
		return text
			.replace(/\b(src|href|action|poster)=("|')\/(?!\/)/gi, `$1=$2${prefix}/`)
			.replace(/url\((["']?)\/(?!\/)/gi, `url($1${prefix}/`)
			.replace(/(["'`])\/assets\//g, `$1${prefix}/assets/`);
	}
	if (
		contentType.includes("javascript") ||
		contentType.includes("ecmascript")
	) {
		return rewriteJavascriptReferences(text, prefix);
	}
	if (contentType.includes("text/css")) {
		return text.replace(/url\((["']?)\/(?!\/)/gi, `url($1${prefix}/`);
	}
	return text;
}

function relayBootstrap(prefix: string): string {
	const value = JSON.stringify(prefix);
	// Every preview shares the isolated relay origin. A previewed PWA must not
	// install a root-scoped worker that controls later previews or reloads the
	// current frame during its update lifecycle.
	const serviceWorkerGuard =
		'<script>(()=>{const sw=navigator.serviceWorker;if(!sw)return;const blocked=()=>Promise.reject(new DOMException("Service workers are disabled in Hlid Project Preview.","SecurityError"));try{Object.defineProperty(sw,"register",{configurable:true,value:blocked})}catch{try{sw.register=blocked}catch{}}void sw.getRegistrations().then((registrations)=>Promise.all(registrations.map((registration)=>registration.unregister()))).catch(()=>{})})();</script>';
	return `${serviceWorkerGuard}<script>(()=>{const p=${value};const rewrite=(value)=>{try{const url=new URL(typeof value==="string"?value:value.url,location.href);const pagePort=Number(location.port||(location.protocol==="https:"?443:80));const targetPort=Number(url.port||(url.protocol==="https:"||url.protocol==="wss:"?443:80));const sameEndpoint=url.hostname===location.hostname&&targetPort===pagePort;const adjacentEndpoint=url.hostname===location.hostname&&targetPort===pagePort+1;const socket=url.protocol==="ws:"||url.protocol==="wss:";if(adjacentEndpoint){url.protocol=socket?(location.protocol==="https:"?"wss:":"ws:"):location.protocol;url.host=location.host;url.pathname=p+"/__hlid_backend__"+url.pathname;return url.toString()}if(sameEndpoint&&!url.pathname.startsWith(p)){const backendSocket=socket&&(url.pathname==="/ws"||url.pathname.startsWith("/ws/"));url.pathname=p+(backendSocket?"/__hlid_backend__":"")+url.pathname;return url.toString()}}catch{}return value};const NativeWebSocket=window.WebSocket;const RelayWebSocket=function(url,protocols){return new NativeWebSocket(rewrite(url),protocols)};Object.setPrototypeOf(RelayWebSocket,NativeWebSocket);RelayWebSocket.prototype=NativeWebSocket.prototype;window.WebSocket=RelayWebSocket;const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>nativeFetch(typeof input==="string"?rewrite(input):input,init);const nativeOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){return nativeOpen.call(this,method,rewrite(url),...rest)};const previewId=p.split("/")[3]||"";const route=()=>{const pathname=location.pathname.startsWith(p)?location.pathname.slice(p.length)||"/":location.pathname;return pathname+location.search+location.hash};const sendState=()=>{if(parent===window)return;parent.postMessage({type:"hlid:project-preview-state",version:1,preview_id:previewId,path:route(),width:Math.round(innerWidth),height:Math.round(innerHeight),scroll_x:Math.round(scrollX),scroll_y:Math.round(scrollY)},"*")};let scheduled=false;const scheduleState=()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;sendState()})};for(const name of ["load","resize","scroll","hashchange","popstate"])addEventListener(name,scheduleState,{passive:true});for(const name of ["pushState","replaceState"]){const native=history[name];history[name]=function(...args){const result=native.apply(this,args);scheduleState();return result}}addEventListener("message",(event)=>{if(event.data?.type==="hlid:project-preview-state-request")sendState()});queueMicrotask(sendState);document.currentScript?.remove()})();</script>`;
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
	previewId: string,
	prefix: string,
	requestTarget: string,
	method: string,
): Promise<Response> {
	const headers = new Headers();
	for (const [key, value] of upstream.headers.entries()) {
		if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
	}
	for (const value of responseSetCookies(upstream.headers)) {
		const rewritten = rewritePreviewSetCookie(value, previewId);
		if (rewritten) headers.append("set-cookie", rewritten);
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
	const cacheable =
		method === "GET" &&
		upstream.status === 200 &&
		!contentType.includes("text/html") &&
		!upstream.headers.has("set-cookie");
	const etag = cacheable ? upstream.headers.get("etag") : null;
	const cacheKey = etag
		? transformCacheKey(previewId, requestTarget, etag)
		: null;
	const cached = cacheKey ? cachedTransform(cacheKey) : null;
	if (cached) {
		void upstream.body?.cancel().catch(() => {});
		headers.set("cache-control", "no-store");
		return new Response(cached.body, {
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
	text = await rewriteRootReferences(text, contentType, prefix);
	if (contentType.includes("text/html")) {
		text = injectRelayBootstrap(text, prefix);
		headers.set("content-security-policy", RELAY_CONTENT_SECURITY_POLICY);
	}
	if (cacheKey) {
		cacheTransform(cacheKey, {
			body: text,
			bytes: new TextEncoder().encode(text).byteLength,
			previewId,
		});
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
	const lifecycleController = new AbortController();
	const unregisterController = registerRelayController(
		relay.previewId,
		lifecycleController,
	);
	const timeoutSignal = AbortSignal.timeout(RELAY_UPSTREAM_TIMEOUT_MS);
	try {
		const upstreamTarget = projectPreviewUpstreamTarget(
			target.port,
			relay.targetPath,
		);
		const requestTarget = `${upstreamTarget.port}${upstreamTarget.path}${url.search}`;
		const upstream = await fetch(
			`http://127.0.0.1:${upstreamTarget.port}${upstreamTarget.path}${url.search}`,
			{
				method: request.method,
				headers: relayRequestHeaders(
					request,
					upstreamTarget.port,
					relay.previewId,
				),
				body,
				redirect: "manual",
				signal: AbortSignal.any([
					request.signal,
					lifecycleController.signal,
					timeoutSignal,
				]),
			},
		);
		return relayResponse(
			upstream,
			relay.previewId,
			relay.prefix,
			requestTarget,
			request.method,
		);
	} catch {
		const cancelled =
			request.signal.aborted || lifecycleController.signal.aborted;
		const timedOut = timeoutSignal.aborted && !cancelled;
		return new Response(
			cancelled
				? null
				: timedOut
					? "Project Preview timed out."
					: "Project Preview is unavailable.",
			{
				status: cancelled ? 499 : timedOut ? 504 : 502,
				headers: {
					"cache-control": "no-store",
					"content-type": "text/plain; charset=utf-8",
				},
			},
		);
	} finally {
		unregisterController();
	}
}

export function createProjectPreviewRelayWsHandlers() {
	return {
		open(ws: ServerWebSocket<ProjectPreviewRelayWsData>) {
			const BunWebSocket = WebSocket as unknown as new (
				url: string,
				options?: {
					headers: Record<string, string>;
					protocols?: string[];
				},
			) => WebSocket;
			const back = new BunWebSocket(ws.data.wsTarget, {
				headers: ws.data.upstreamHeaders,
				protocols: ws.data.protocols,
			});
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
