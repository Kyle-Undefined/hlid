import "./prelude";
import * as db from "../db";
import { isAllowedOrigin, isAllowedOriginHeader } from "../lib/allowedOrigin";
import { registerBunServer } from "../lib/lifecycle";
import { loadToken, verifyToken } from "../lib/token";
import type { AgentProvider, McpServerStatus } from "./agentProvider";
import { handleAttachmentRoute } from "./attachmentRoutes";
import { openInBrowser } from "./browser";
import { ClaudeProvider } from "./claudeProvider";
import { loadConfig } from "./config";
import { handleDbRoute } from "./dbRoutes";
import { startProviderProxy } from "./proxy";
import { SessionManager } from "./session";
import { startTlsProxy } from "./tlsProxy";
import { startUiServer } from "./uiServer";
import { syncWrappers } from "./wrappers";
import { createWsHandlers } from "./wsHandlers";

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

const config = loadConfig();
syncWrappers(config.agents ?? []);

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

const providers = new Map<string, AgentProvider>([
	["claude", new ClaudeProvider()],
]);
const session = new SessionManager(config, providers);
const SERVER_TOKEN = loadToken();

// Restore cached MCP status from previous run so cockpit shows servers before first query
void db.getSetting("mcp_status_cache").then((cached) => {
	if (!cached) return;
	try {
		session.restoreMcpStatus(JSON.parse(cached) as McpServerStatus[]);
	} catch {}
});

const PORT = config.server.port + 1; // 3001 when TanStack Start is on 3000
const UI_PORT = config.server.port;

// Per-provider transparent proxies. Each provider with proxyConfig gets its own
// proxy that captures utilization headers and sets the provider's base URL env var.
const anthropicUpstream = (
	process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
).replace(/\/$/, "");

for (const provider of session.getAllProviders()) {
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

registerBunServer(
	Bun.serve({
		port: PORT,
		hostname: BIND_HOST,
		...tlsConfig,

		async fetch(req, server) {
			const url = new URL(req.url);

			if (
				!isAllowedOrigin(
					server.requestIP(req)?.address,
					config.server.local_network_access,
				)
			) {
				return new Response("Forbidden", { status: 403 });
			}

			// C3: For state-mutating requests, reject cross-origin Origin headers.
			// Server fn calls from TanStack Start have no Origin header and are allowed.
			if (
				req.method !== "GET" &&
				req.method !== "HEAD" &&
				!isAllowedOriginHeader(
					req.headers.get("origin"),
					config.server.local_network_access,
				)
			) {
				return new Response("Forbidden", { status: 403 });
			}

			if (url.pathname === "/ws") {
				// C2: Reject cross-origin WS connections (prevents drive-by chat execution)
				if (
					!isAllowedOriginHeader(
						req.headers.get("origin"),
						config.server.local_network_access,
					)
				) {
					return new Response("Forbidden", { status: 403 });
				}
				if (!verifyToken(url.searchParams.get("token"), SERVER_TOKEN)) {
					return new Response("Unauthorized", { status: 401 });
				}
				if (server.upgrade(req, { data: undefined })) return undefined;
				return new Response("WebSocket upgrade required", { status: 426 });
			}

			if (url.pathname === "/status") {
				return Response.json(session.getStatus());
			}

			if (url.pathname === "/providers" && req.method === "GET") {
				const list = await Promise.all(
					session.getAllProviders().map(async (p) => {
						const check = p.check
							? await p
									.check()
									.catch(() => ({ available: false, reason: "check failed" }))
							: null;
						return {
							id: p.providerId,
							label: p.label ?? p.providerId,
							available: check?.available ?? true,
							unavailableReason:
								check?.available === false ? check.reason : undefined,
						};
					}),
				);
				return Response.json({ providers: list });
			}

			if (url.pathname === "/mcp-status" && req.method === "GET") {
				return Response.json(session.getLastMcpStatus() ?? []);
			}

			const dbResult = await handleDbRoute(url, req);
			if (dbResult) return dbResult;

			const attResult = await handleAttachmentRoute(url, req, config);
			if (attResult) return attResult;

			return new Response("Not found", { status: 404 });
		},

		websocket: createWsHandlers(session),
	}),
);

console.log(`Hlid server on :${PORT}${process.env.HLID_TLS ? " (TLS)" : ""}`);

// ----- TLS proxy (tls_proxy_port, default 3443) ---------------------------
// Terminates TLS and forwards plain HTTP → UI_PORT, plain WS → PORT.
// Starts whenever cert+key are configured; no separate process needed.
if (config.server.tls_cert_path && config.server.tls_key_path) {
	startTlsProxy(
		config.server.tls_proxy_port,
		UI_PORT,
		PORT,
		BIND_HOST,
		config.server.tls_cert_path,
		config.server.tls_key_path,
		config.server.local_network_access,
	);
}
