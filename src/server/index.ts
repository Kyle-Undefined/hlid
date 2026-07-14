import "./prelude";
import type { Server, ServerWebSocket } from "bun";
import * as db from "../db";
import { isAllowedOrigin, isAllowedOriginHeader } from "../lib/allowedOrigin";
import { registerBunServer } from "../lib/lifecycle";
import { loadToken, verifyToken } from "../lib/token";
import { AcpProvider } from "./acpProvider";
import { AcpRegistry } from "./acpRegistry";
import { createAcpRouteHandler } from "./acpRoutes";
import type { AgentProvider, McpServerStatus } from "./agentProvider";
import { buildApiIndex } from "./apiIndex";
import { handleAttachmentRoute } from "./attachmentRoutes";
import {
	authorizeServiceRequest,
	isLoopback,
	resetAuthentication,
} from "./auth";
import { openInBrowser } from "./browser";
import { ClaudeProvider } from "./claudeProvider";
import { closeAllCodexAppServers, listCodexAppServers } from "./codexAppServer";
import { CodexProvider } from "./codexProvider";
import { loadConfig } from "./config";
import { handleDbRoute } from "./dbRoutes";
import { getLiveSessionsStatus } from "./liveSessions";
import { createModelCatalog } from "./providerCatalog";
import { startProviderProxy } from "./proxy";
import { bootstrapPtyRuntime } from "./pty-bootstrap";
import {
	contentLengthExceeds,
	MAX_VOICE_BODY_BYTES,
	MULTIPART_OVERHEAD_BYTES,
	payloadTooLarge,
} from "./requestLimits";
import { broadcast } from "./runState";
import {
	createAuthenticatedRouteHandler,
	createServerRequestPolicy,
} from "./serverRequestPolicy";
import { SessionPool } from "./sessionPool";
import { ShellSessionPool } from "./shellSessionPool";
import { createShellUpgradeHandler } from "./shellUpgrade";
import { resolveAllowedTerminalCwd } from "./terminalAccess";
import { TerminalSessionPool } from "./terminalSessionPool";
import { createTerminalUpgradeHandler } from "./terminalUpgrade";
import { startTlsProxy } from "./tlsProxy";
import { startUiServer } from "./uiServer";
import { bootstrapUmbod, closeUmbod } from "./umbod";
import { VoiceModelManager } from "./voice";
import { bootstrapVoiceRuntime } from "./voice-bootstrap";
import { syncWrappers } from "./wrappers";
import { createWsHandlers, type WsData } from "./wsHandlers";
import { createShellWsHandlers, type ShellWsData } from "./wsHandlers.shell";
import {
	createTerminalWsHandlers,
	type TerminalWsData,
} from "./wsHandlers.terminal";
import { MAX_WS_PAYLOAD_BYTES } from "./wsSchemas";

if (process.argv[2] === "auth" && process.argv[3] === "reset") {
	await resetAuthentication();
	console.log(
		"Hlid authentication reset. Restart Hlid to create a new password.",
	);
	process.exit(0);
}

// In a compiled exe (--windows-hide-console), any write to stdout/stderr causes
// Bun to call AllocConsole(), making Windows show a console window. Redirect
// all console output to the DB log so no console is ever allocated.
if (process.execPath.endsWith(".exe")) {
	const toDb = (level: "info" | "warn" | "error", args: unknown[]) => {
		const msg = args
			.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
			.join(" ");
		void db.appendLog(level, "console", msg);
	};
	console.log = (...a) => toDb("info", a);
	console.info = (...a) => toDb("info", a);
	console.warn = (...a) => toDb("warn", a);
	console.error = (...a) => toDb("error", a);
	console.debug = () => {};
}

// CLI flags. `--background` = silent boot (used by the autostart registry entry).
// `--restart` = post-update relaunch; implies background and skips the running-
// instance probe (the old instance was just replaced, not still running).
// No flag = interactive launch (double-click); we'll open the browser once the
// server is ready.
const RESTART_MODE = process.argv.includes("--restart");
const BACKGROUND_MODE = RESTART_MODE || process.argv.includes("--background");

const restartParentArg = process.argv.find((arg) =>
	arg.startsWith("--restart-parent="),
);
if (restartParentArg) {
	const parentPid = Number(restartParentArg.slice("--restart-parent=".length));
	const deadline = Date.now() + 30_000;
	while (
		Number.isInteger(parentPid) &&
		parentPid > 0 &&
		Date.now() < deadline
	) {
		try {
			process.kill(parentPid, 0);
			await new Promise((resolve) => setTimeout(resolve, 100));
		} catch {
			break;
		}
	}
}

const config = loadConfig();
syncWrappers(config.agents ?? []);
await bootstrapUmbod().catch((error) => {
	console.error(
		"[umbod] failed to initialize:",
		error instanceof Error ? error.message : String(error),
	);
});

// Bind localhost-only by default. Opt-in to LAN/Tailscale exposure via
// `local_network_access = true` in hlid.config.toml (requires restart).
const BIND_HOST = config.server.local_network_access ? "0.0.0.0" : "127.0.0.1";

// If a previous instance is already running on our UI port, treat this launch
// as a "click to open", surface the running UI in a browser and exit. This
// makes double-clicking hlid.exe a friendly no-op when it's already up.
// Skipped on --restart: the old instance was deliberately replaced.
if (process.execPath.endsWith(".exe") && !RESTART_MODE) {
	const probeUrl = `http://127.0.0.1:${config.server.port}/`;
	try {
		const res = await fetch(probeUrl, {
			signal: AbortSignal.timeout(800),
		});
		if (res.ok) {
			if (!BACKGROUND_MODE) openInBrowser(probeUrl);
			process.exit(0);
		}
	} catch {
		// no running instance, proceed to start one
	}
}

const acpRegistry = new AcpRegistry();
const handleAcpRoute = createAcpRouteHandler({
	registry: acpRegistry,
	loadConfig,
});
const acpCatalog = await acpRegistry.catalog(config);
const providers = new Map<string, AgentProvider>([
	["claude", new ClaudeProvider()],
	["codex", new CodexProvider()],
]);
for (const item of acpCatalog.filter((candidate) => candidate.enabled)) {
	const configured = (config.acp_agents ?? []).find(
		(agent) => agent.id === item.id,
	);
	providers.set(
		item.providerId,
		new AcpProvider({
			id: item.providerId,
			label: item.name,
			command: item.command,
			args: item.args,
			env: { ...item.env, ...configured?.env },
		}),
	);
}
for (const provider of providers.values()) {
	if (provider.usageWindows) {
		db.registerProvider(
			provider.providerId,
			provider.label ?? provider.providerId,
			[...provider.usageWindows],
		);
	}
}
// Non-blocking boot warm-up of live model catalogs (mirrors the
// `void db.getSetting(...)` MCP status restore pattern below).
const modelCatalog = createModelCatalog(providers);
modelCatalog.warm();
const pool = new SessionPool(config, providers);
const voice = new VoiceModelManager(
	config.voice,
	await bootstrapVoiceRuntime(),
);
voice.warmCatalog();
void voice.initialize();
const ptyWorkerPath = await bootstrapPtyRuntime();
const terminalPool = new TerminalSessionPool(ptyWorkerPath, () => {
	broadcast({
		type: "sessions_status",
		sessions: getLiveSessionsStatus(pool, terminalPool),
	});
});
const shellPool = new ShellSessionPool(ptyWorkerPath);
const SERVER_TOKEN = loadToken();
const MAX_ACTIVE_VOICE_REQUESTS = 2;
let activeVoiceRequests = 0;

// Restore cached MCP status from previous run so cockpit shows servers before first query
void db.getSetting("mcp_status_cache").then((cached) => {
	if (!cached) return;
	try {
		pool
			.vaultEntry()
			.manager.restoreMcpStatus(JSON.parse(cached) as McpServerStatus[]);
	} catch {}
});

// Graceful shutdown: abort all running sessions on SIGTERM / SIGINT
process.on("SIGTERM", () => {
	voice.close();
	pool.closeAll();
	terminalPool.closeAll();
	shellPool.closeAll();
	closeAllCodexAppServers();
	closeUmbod();
	process.exit(0);
});
process.on("SIGINT", () => {
	voice.close();
	pool.closeAll();
	terminalPool.closeAll();
	shellPool.closeAll();
	closeAllCodexAppServers();
	closeUmbod();
	process.exit(0);
});

const PORT = config.server.port + 1; // 3001 when TanStack Start is on 3000
const UI_PORT = config.server.port;

// Per-provider transparent proxies. Each provider with proxyConfig gets its own
// proxy that captures utilization headers and sets the provider's base URL env var.
const anthropicUpstream = (
	process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
).replace(/\/$/, "");

for (const provider of providers.values()) {
	if (provider.proxyConfig) {
		void startProviderProxy(provider, anthropicUpstream);
	}
}

// ----- UI server (port = config.server.port, default 3000) ---------------
// Serves embedded SPA assets and forwards everything else (server fns,
// /api/*, etc.) to TanStack Start's fetch handler.
//
// Only runs from the compiled exe. In dev (`bun run dev:all`), Vite owns
// port 3000 and serves the UI with HMR.

const isCompiled = process.execPath.endsWith(".exe");

if (isCompiled) {
	await startUiServer(UI_PORT, BIND_HOST);

	// Interactive launch (double-click) gets a browser pop. Autostart-at-login
	// (registry value carries `--background`) does not.
	if (!BACKGROUND_MODE) {
		openInBrowser(`http://127.0.0.1:${UI_PORT}/`);
	}
}

// ----- WS / API server (port + 1, default 3001) ---------------------------

const tlsConfig =
	process.env.HLID_TLS &&
	config.server.tls_cert_path &&
	config.server.tls_key_path
		? {
				tls: {
					cert: Bun.file(config.server.tls_cert_path),
					key: Bun.file(config.server.tls_key_path),
				},
			}
		: {};

type AppServer = Server<WsData | TerminalWsData | ShellWsData>;

const upgradeTerminalWebSocket = createTerminalUpgradeHandler({
	defaultCwd: config.vault.path,
	resolveCwd: (requestedCwd) => resolveAllowedTerminalCwd(config, requestedCwd),
	createSession: async (sessionId) => {
		await db.createSession(sessionId, "Terminal session", "claude-cli");
	},
	getSessionLabel: async (sessionId) =>
		(await db.getSessionById(sessionId))?.label ?? null,
	getResumeId: db.getSessionClaudeId,
});

const upgradeShellWebSocket = createShellUpgradeHandler({
	defaultCwd: config.vault.path,
	resolveCwd: (requestedCwd) => resolveAllowedTerminalCwd(config, requestedCwd),
});

async function handleWebSocketRoute(
	req: Request,
	server: AppServer,
	url: URL,
	peerIp: string | undefined,
): Promise<Response | undefined | null> {
	if (
		url.pathname !== "/ws" &&
		url.pathname !== "/ws/terminal" &&
		url.pathname !== "/ws/shell"
	)
		return null;
	if (
		!isAllowedOriginHeader(
			req.headers.get("origin"),
			config.server.local_network_access,
		)
	) {
		return new Response("Forbidden", { status: 403 });
	}
	if (!(await authorizeServiceRequest(req, peerIp, SERVER_TOKEN))) {
		return new Response("Unauthorized", { status: 401 });
	}
	if (url.pathname === "/ws/terminal") {
		return upgradeTerminalWebSocket(url, (data) =>
			server.upgrade(req, { data }),
		);
	}
	if (url.pathname === "/ws/shell") {
		return upgradeShellWebSocket(url, (data) => server.upgrade(req, { data }));
	}
	if (
		server.upgrade(req, {
			data: { isTerminal: false, subscribedSessionId: "" },
		})
	) {
		return undefined;
	}
	return new Response("WebSocket upgrade required", { status: 426 });
}

function handleCodexRoute(url: URL, req: Request): Response | null {
	if (url.pathname === "/codex/app-servers" && req.method === "GET") {
		return Response.json(listCodexAppServers());
	}
	if (url.pathname !== "/codex/app-servers/restart" || req.method !== "POST") {
		return null;
	}
	const closed = listCodexAppServers().filter((server) => server.alive).length;
	closeAllCodexAppServers();
	return Response.json({ ok: true, closed });
}

async function handleProviderRoute(url: URL, req: Request) {
	if (url.pathname !== "/providers" || req.method !== "GET") return null;
	const refresh = url.searchParams.get("refresh") === "1";
	const list = await Promise.all(
		[...providers.values()].map(async (provider) => {
			const check = provider.check
				? await provider
						.check()
						.catch(() => ({ available: false, reason: "check failed" }))
				: null;
			const providerRefresh = refresh && check?.available !== false;
			return {
				id: provider.providerId,
				label: provider.label ?? provider.providerId,
				available: check?.available ?? true,
				unavailableReason:
					check?.available === false ? check.reason : undefined,
				models: await modelCatalog.modelsFor(provider, providerRefresh),
				effortLevels: provider.effortLevels,
				permissionModes: provider.permissionModes,
			};
		}),
	);
	return Response.json({ providers: list });
}

async function downloadVoiceModel(req: Request): Promise<Response> {
	try {
		const { model } = (await req.json()) as { model?: string };
		if (!model) {
			return Response.json({ error: "model is required" }, { status: 400 });
		}
		void voice
			.download(model)
			.catch((error) => console.error("[voice] download failed:", error));
		return Response.json({ ok: true }, { status: 202 });
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: 400 });
	}
}

function deleteVoiceModel(url: URL): Response {
	try {
		const model = url.searchParams.get("model");
		if (!model) {
			return Response.json({ error: "model is required" }, { status: 400 });
		}
		voice.deleteModel(model);
		return Response.json({ ok: true });
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: 409 });
	}
}

async function transcribeVoice(req: Request): Promise<Response> {
	if (contentLengthExceeds(req, MAX_VOICE_BODY_BYTES)) {
		return payloadTooLarge(MAX_VOICE_BODY_BYTES);
	}
	if (activeVoiceRequests >= MAX_ACTIVE_VOICE_REQUESTS) {
		return Response.json(
			{ error: "voice transcription capacity reached" },
			{ status: 429, headers: { "retry-after": "1" } },
		);
	}
	activeVoiceRequests++;
	try {
		const form = await req.formData();
		const audio = form.get("audio");
		if (!(audio instanceof Blob)) {
			return Response.json({ error: "audio is required" }, { status: 400 });
		}
		const language = String(form.get("language") ?? config.voice.language);
		return Response.json(await voice.transcribe(audio, language));
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: 503 });
	} finally {
		activeVoiceRequests--;
	}
}

type ServerRouteHandler = (
	url: URL,
	request: Request,
) => Response | Promise<Response>;

const VOICE_ROUTE_HANDLERS: Record<string, ServerRouteHandler> = {
	"GET /voice": async (url) => {
		const refresh = url.searchParams.get("refresh") === "1";
		return Response.json({
			status: voice.status(),
			models: await voice.models(refresh),
		});
	},
	"POST /voice/sync": async () => {
		await voice.syncConfig(loadConfig().voice);
		return Response.json({ status: voice.status() });
	},
	"POST /voice/download": (_url, request) => downloadVoiceModel(request),
	"POST /voice/download/cancel": async () => {
		voice.cancelDownload();
		return Response.json({ ok: true });
	},
	"DELETE /voice/model": (url) => deleteVoiceModel(url),
	"POST /voice/transcribe": (_url, request) => transcribeVoice(request),
};

async function handleVoiceRoute(url: URL, req: Request) {
	const handler = VOICE_ROUTE_HANDLERS[`${req.method} ${url.pathname}`];
	return handler ? handler(url, req) : null;
}

async function handleAccountRoute(url: URL, req: Request) {
	if (url.pathname !== "/account" || req.method !== "GET") return null;
	for (const entry of pool.getAllEntries()) {
		const info = await entry.manager.getAccountInfo();
		if (info) return Response.json(info);
	}
	return Response.json(null);
}

const handleAuthenticatedRoute = createAuthenticatedRouteHandler({
	getStatus: () => pool.vaultEntry().manager.getStatus(),
	getApiIndex: () => buildApiIndex(PORT, UI_PORT),
	orderedHandlers: [
		handleCodexRoute,
		handleProviderRoute,
		handleAcpRoute,
		handleVoiceRoute,
		handleAccountRoute,
	],
	getMcpStatus: () => pool.vaultEntry().manager.getLastMcpStatus() ?? [],
	handleDb: (url, req) => handleDbRoute(url, req, pool, terminalPool),
	handleAttachment: (url, req) => handleAttachmentRoute(url, req, config),
});

const handleServerRequest = createServerRequestPolicy<AppServer>({
	isPeerAllowed: (address) =>
		isAllowedOrigin(address, config.server.local_network_access),
	isMutationOriginAllowed: (origin) =>
		isAllowedOriginHeader(origin, config.server.local_network_access),
	handleWebSocket: (request, url, address, server) =>
		handleWebSocketRoute(request, server, url, address),
	authorize: (request, address) =>
		authorizeServiceRequest(request, address, SERVER_TOKEN),
	handleAuthenticated: handleAuthenticatedRoute,
});

async function handleServerFetch(
	req: Request,
	server: AppServer,
): Promise<Response | undefined> {
	const peerIp = server.requestIP(req)?.address;
	const url = new URL(req.url);
	if (req.method === "POST" && url.pathname === "/internal/cli-updates/drain") {
		if (
			!isLoopback(peerIp) ||
			!verifyToken(req.headers.get("x-hlid-internal"), SERVER_TOKEN)
		) {
			return new Response("Forbidden", { status: 403 });
		}
		const sessions = pool.getSize();
		const appServers = listCodexAppServers().filter(
			(entry) => entry.alive,
		).length;
		pool.closeAll();
		closeAllCodexAppServers();
		broadcast({
			type: "sessions_status",
			sessions: getLiveSessionsStatus(pool, terminalPool),
		});
		return Response.json({
			ok: true,
			data: { sessions, appServers },
		});
	}
	return handleServerRequest(req, peerIp, server);
}

registerBunServer(
	Bun.serve<WsData | TerminalWsData | ShellWsData>({
		port: PORT,
		hostname: BIND_HOST,
		maxRequestBodySize: Math.max(
			MAX_VOICE_BODY_BYTES,
			config.attachments.max_bytes + MULTIPART_OVERHEAD_BYTES,
		),
		...tlsConfig,

		fetch: handleServerFetch,

		websocket: (() => {
			const chatHandlers = createWsHandlers(pool, terminalPool);
			const termHandlers = createTerminalWsHandlers(terminalPool);
			const shellHandlers = createShellWsHandlers(shellPool);
			type ChatWs = Parameters<typeof chatHandlers.open>[0];
			type TerminalWs = ServerWebSocket<TerminalWsData>;
			type ShellWs = ServerWebSocket<ShellWsData>;
			type AppWs = ChatWs | TerminalWs | ShellWs;
			type WsMessage = Parameters<typeof chatHandlers.message>[1];
			const isTerminalWs = (ws: AppWs): ws is TerminalWs =>
				"isTerminal" in ws.data && ws.data.isTerminal === true;
			const isShellWs = (ws: AppWs): ws is ShellWs =>
				"isShell" in ws.data && ws.data.isShell === true;
			return {
				maxPayloadLength: MAX_WS_PAYLOAD_BYTES,
				open(ws: AppWs) {
					if (isTerminalWs(ws)) termHandlers.open(ws);
					else if (isShellWs(ws)) shellHandlers.open(ws);
					else chatHandlers.open(ws);
				},
				message(ws: AppWs, data: WsMessage) {
					if (isTerminalWs(ws)) termHandlers.message(ws, data);
					else if (isShellWs(ws)) shellHandlers.message(ws, data);
					else chatHandlers.message(ws, data);
				},
				close(ws: AppWs) {
					if (isTerminalWs(ws)) termHandlers.close(ws);
					else if (isShellWs(ws)) shellHandlers.close(ws);
					else chatHandlers.close(ws);
				},
			};
		})(),
	}),
);

console.log(`Hlid server on :${PORT}${process.env.HLID_TLS ? " (TLS)" : ""}`);

// ----- TLS proxy (tls_proxy_port, default 3443) ---------------------------
// Terminates TLS and forwards plain HTTP → UI_PORT, plain WS → PORT.
// Starts whenever cert+key are configured; no separate process needed.
if (config.server.tls_cert_path && config.server.tls_key_path) {
	startTlsProxy({
		tlsPort: config.server.tls_proxy_port,
		uiPort: UI_PORT,
		wsPort: PORT,
		bindHost: BIND_HOST,
		certPath: config.server.tls_cert_path,
		keyPath: config.server.tls_key_path,
		localNetworkAccess: config.server.local_network_access,
		internalToken: SERVER_TOKEN,
		maxBodyBytes: Math.max(
			MAX_VOICE_BODY_BYTES,
			config.attachments.max_bytes + MULTIPART_OVERHEAD_BYTES,
		),
	});
}
