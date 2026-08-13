import "./prelude";
import type { Server, ServerWebSocket } from "bun";
import type { HlidConfig } from "../config";
import * as db from "../db";
import { isAllowedOrigin, isAllowedOriginHeader } from "../lib/allowedOrigin";
import { resolveClaudeExecutable } from "../lib/claudePath";
import { resolveCodexExecutable } from "../lib/codexPath";
import { writeConfig } from "../lib/config-writer";
import { resolveDevServerPort } from "../lib/devServerPort";
import {
	registerInternalApiBase,
	registerInternalApiHandler,
} from "../lib/internalApiTransport";
import {
	exitAfterShutdownCleanup,
	registerBunServer,
	registerShutdownCleanup,
} from "../lib/lifecycle";
import { ACP_MANAGED_DIR } from "../lib/paths";
import {
	CLIPROXY_CODEX_HARNESS_PROVIDER_ID,
	CLIPROXY_CODEX_PROVIDER_ID,
	CLIPROXY_OPENCODE_PROVIDER_ID,
} from "../lib/providerIds";
import { loadToken, verifyToken } from "../lib/token";
import { uid } from "../lib/utils";
import {
	createAcpExecutionAdapter,
	windowsPathToWsl,
} from "./acpExecutionAdapter";
import { AcpManagedInstaller } from "./acpManagedInstall";
import { persistedAcpTargetPlatformEvidenceStore } from "./acpPlatformEvidence";
import { inspectAcpAgent } from "./acpProvider";
import { type AcpCatalogItem, AcpRegistry } from "./acpRegistry";
import { createAcpRouteHandler } from "./acpRoutes";
import {
	type AcpRuntimeSyncResult,
	acpRuntimeFingerprint,
	createConfiguredAcpProvider,
	syncAcpRuntimeProviders,
} from "./acpRuntime";
import type { AgentProvider, McpServerStatus } from "./agentProvider";
import { buildApiIndex } from "./apiIndex";
import { handleAttachmentRoute } from "./attachmentRoutes";
import { unlinkPaths } from "./attachments";
import {
	authorizeServiceRequest,
	isLoopback,
	resetAuthentication,
} from "./auth";
import { openInBrowser } from "./browser";
import { ClaudeProvider } from "./claudeProvider";
import { getClaudeWarmupSnapshot, prewarmClaudeCli } from "./claudeWarmup";
import { observeCliProxyInstallJob } from "./cliproxyInstallJob";
import { CliProxyManager, MANAGED_CLIPROXY_BASE_URL } from "./cliproxyManager";
import {
	CliProxyCodexProvider,
	type CliProxyConnection,
	CliProxyNativeCodexProvider,
	CliProxyOpenCodeProvider,
} from "./cliproxyProvider";
import {
	closeAllCodexAppServers,
	closeIdleCodexAppServers,
	listCodexAppServers,
	prewarmCodexAppServer,
	waitForCodexAppServerTerminations,
} from "./codexAppServer";
import {
	CodexProvider,
	codexLaunchConfig,
	invalidateCodexHostCapabilities,
	refreshCodexHostCapabilities,
} from "./codexProvider";
import {
	getCodexRealtimeBackendStatus,
	resetCodexRealtimeBackendStatus,
} from "./codexRealtimeStatus";
import { loadConfig } from "./config";
import {
	formatPersistentConsoleMessage,
	HLID_SERVER_RUN_LOG_MESSAGE,
	HLID_SERVER_RUN_LOG_SOURCE,
} from "./consoleLog";
import {
	bumpDataRevision,
	getDataRevisions,
	subscribeDataRevisions,
} from "./dataRevision";
import { handleDbRoute } from "./dbRoutes";
import { resolveExecutionContext } from "./executionContext";
import { createExtensionRouteHandler } from "./extensionRoutes";
import { HlidDelegationManager } from "./hlidDelegation";
import { createHlidDelegationRouteHandler } from "./hlidDelegationRoutes";
import { INTERNAL_HLID_MCP_FLAG, runHlidMcpServer } from "./hlidMcpServer";
import { migrateLegacyAttachmentsToLibrary } from "./libraryMigration";
import { getLiveSessionsStatus } from "./liveSessions";
import { MicrosoftSpeechManager } from "./microsoftSpeech";
import { warmObsidianConnection } from "./obsidianConnectionCache";
import {
	INTERNAL_OBSIDIAN_MCP_FLAG,
	runObsidianMcpServer,
} from "./obsidianMcpServer";
import { projectPreviewManager } from "./projectPreview";
import {
	createProjectPreviewRelayWsHandlers,
	type ProjectPreviewRelayWsData,
	parseProjectPreviewRelayWebSocket,
	projectPreviewRelayWebSocketHeaders,
	projectPreviewUpstreamTarget,
	projectPreviewWebSocketProtocols,
	selectedProjectPreviewRelayUrl,
} from "./projectPreviewRelay";
import { handleProjectPreviewRoute } from "./projectPreviewRoutes";
import { createProviderAppRouteHandler } from "./providerAppRoutes";
import {
	createModelCatalog,
	createProviderCapabilityCatalog,
	createProviderCatalogSnapshot,
	type ProviderCatalogSnapshot,
	providerCatalogRequestOptions,
} from "./providerCatalog";
import { seedWindowMarks, startProviderProxy } from "./proxy";
import { bootstrapPtyRuntime } from "./pty-bootstrap";
import { deliverPushEvent } from "./pushDelivery";
import { PushNotificationCoordinator } from "./pushNotificationCoordinator";
import { handlePushRoute } from "./pushRoutes";
import { createReadAloudRouteHandler } from "./readAloudRoutes";
import {
	acpProviderOperationSlowRequestThreshold,
	createRequestObserver,
	projectPreviewSlowRequestThreshold,
	startEventLoopLagMonitor,
} from "./requestDiagnostics";
import {
	contentLengthExceeds,
	MAX_VOICE_BODY_BYTES,
	MULTIPART_OVERHEAD_BYTES,
	payloadTooLarge,
} from "./requestLimits";
import {
	runRoutineNow,
	startRoutineScheduler,
	stopRoutineScheduler,
} from "./routineScheduler";
import { broadcast, subscribeSessionsStatusBroadcast } from "./runState";
import {
	createAuthenticatedRouteHandler,
	createServerRequestPolicy,
} from "./serverRequestPolicy";
import { SessionPool } from "./sessionPool";
import { ShellSessionPool } from "./shellSessionPool";
import { createShellUpgradeHandler } from "./shellUpgrade";
import { handleSkillRoute } from "./skillRoutes";
import { refreshLiveClaudeSkills } from "./skillRuntimeRefresh";
import { probeExistingInstance } from "./startupProbe";
import { resolveAllowedTerminalCwd } from "./terminalAccess";
import { TerminalSessionPool } from "./terminalSessionPool";
import { createTerminalUpgradeHandler } from "./terminalUpgrade";
import { startTlsProxy } from "./tlsProxy";
import { TtsModelManager } from "./tts";
import { INTERNAL_TTS_RUNTIME_FLAG, runTtsRuntimeServer } from "./tts-runtime";
import { startUiServer } from "./uiServer";
import { markUiServerReady } from "./uiStartupGate";
import { bootstrapUmbod, closeUmbod } from "./umbod";
import { invalidateVaultSnapshot, warmVaultSnapshot } from "./vaultSnapshot";
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

if (process.argv.includes(INTERNAL_TTS_RUNTIME_FLAG)) {
	await runTtsRuntimeServer();
}

if (process.argv.includes(INTERNAL_HLID_MCP_FLAG)) {
	await runHlidMcpServer();
	process.exit(0);
}

if (process.argv.includes(INTERNAL_OBSIDIAN_MCP_FLAG)) {
	await runObsidianMcpServer();
	process.exit(0);
}

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
		const msg = formatPersistentConsoleMessage(level, args);
		if (!msg) return;
		void db.appendLog(level, "console", msg);
	};
	console.log = (...a) => toDb("info", a);
	console.info = (...a) => toDb("info", a);
	console.warn = (...a) => toDb("warn", a);
	console.error = (...a) => toDb("error", a);
	console.debug = () => {};
}

// CLI flags. `--background` = silent boot (used by the autostart registry entry).
// `--restart` = post-update relaunch and implies background. Compiled launches
// still probe for a newer competing instance before doing any startup work.
// No flag = interactive launch (double-click); we'll open the browser once the
// server is ready.
const RESTART_MODE = process.argv.includes("--restart");
const BACKGROUND_MODE = RESTART_MODE || process.argv.includes("--background");

const restartParentArg = process.argv.find((arg) =>
	arg.startsWith("--restart-parent="),
);
if (restartParentArg && process.platform !== "win32") {
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

const loadedConfig = loadConfig();
const resolvedDevPort = resolveDevServerPort(loadedConfig.server.port);
const config =
	resolvedDevPort === loadedConfig.server.port
		? loadedConfig
		: {
				...loadedConfig,
				server: { ...loadedConfig.server, port: resolvedDevPort },
			};
registerInternalApiBase(`http://127.0.0.1:${config.server.port + 1}`);

// Bind localhost-only by default. Opt-in to LAN/Tailscale exposure via
// `local_network_access = true` in hlid.config.toml (requires restart).
const BIND_HOST = config.server.local_network_access ? "0.0.0.0" : "127.0.0.1";

// If an instance is already running on our UI port, treat this launch as a
// friendly no-op. This also covers a user manually launching Hlid while a
// restart replacement is queued: the late replacement must not contend for
// Umbod or UI ports. The restart trampoline has already waited for its old
// parent, so any responder here is a newer competing instance.
if (process.execPath.endsWith(".exe")) {
	const runningUrl = await probeExistingInstance(config.server.port);
	if (runningUrl) {
		if (!BACKGROUND_MODE) openInBrowser(runningUrl);
		process.exit(0);
	}
}

await db.appendLog(
	"info",
	HLID_SERVER_RUN_LOG_SOURCE,
	HLID_SERVER_RUN_LOG_MESSAGE,
);

// A clustered set of otherwise unrelated request timeouts usually means the
// single server event loop was delayed. Log only material stalls, with a
// cooldown and sleep-gap filter handled by the monitor. Start it only after the
// competing-instance probe so a friendly second launch cannot write current-run
// diagnostics into the active server's Event Log.
startEventLoopLagMonitor();

// Mutating startup work must happen only after the existing-instance probe.
// A friendly second launch should not contend for Umbod's port, rewrite
// wrappers, or start provider proxies before it exits.
syncWrappers(config.agents ?? []);
await migrateLegacyAttachmentsToLibrary().catch((error) => {
	console.warn(
		"[library] legacy relic migration deferred:",
		error instanceof Error ? error.message : String(error),
	);
});
await bootstrapUmbod().catch((error) => {
	console.error(
		"[umbod] failed to initialize:",
		error instanceof Error ? error.message : String(error),
	);
});

let acpPlatformReconciliationReady = false;
let acpPlatformReconciliationQueued = false;

function requestAcpPlatformReconciliation(): void {
	acpPlatformReconciliationQueued = true;
	if (!acpPlatformReconciliationReady) return;
	queueMicrotask(() => {
		if (!acpPlatformReconciliationQueued) return;
		acpPlatformReconciliationQueued = false;
		void syncAcpRuntime(undefined, false).catch((error) => {
			console.warn(
				"[acp] platform reconciliation deferred:",
				error instanceof Error ? error.message : String(error),
			);
		});
	});
}

const acpRegistry = new AcpRegistry(undefined, undefined, {
	platformEvidence: persistedAcpTargetPlatformEvidenceStore,
	onPlatformChange: requestAcpPlatformReconciliation,
});
const acpManagedInstaller = new AcpManagedInstaller(ACP_MANAGED_DIR, {
	toTargetPath: ({ hostPath, target }) => {
		if (target.kind === "host") return hostPath;
		const translated = windowsPathToWsl(hostPath);
		if (!translated) {
			throw new Error(
				"Hlid's managed integration directory is not visible from WSL",
			);
		}
		return translated;
	},
	probe: async ({ agentId, target, command, args, env, hostCwd, signal }) => {
		if (signal.aborted) throw signal.reason;
		const inspected = await inspectAcpAgent(
			{
				id: `acp:${agentId}`,
				label: agentId,
				command,
				args,
				env,
				target,
				discoveryCwd: hostCwd,
				executionAdapter: createAcpExecutionAdapter,
			},
			undefined,
			signal,
		);
		if (signal.aborted) throw signal.reason;
		return { observedVersion: inspected.agentInfo?.version ?? undefined };
	},
	refresh: async () => {
		acpRegistry.invalidateAvailability();
		await syncAcpRuntime();
	},
});
acpRegistry.attachManagedCatalog(acpManagedInstaller);
const handleAcpRoute = createAcpRouteHandler({
	registry: acpRegistry,
	loadConfig,
	importSession: async (input) => {
		const result = await db.createProviderNativeSessionImport({
			id: uid(),
			label:
				input.providerSession.title?.trim().slice(0, 160) ||
				`${input.providerLabel} provider session`,
			agentCwd: input.cwd,
			providerId: input.providerId,
			providerSessionId: input.providerSession.sessionId,
			providerRuntimeIdentity: input.providerRuntimeIdentity,
		});
		if (result.created || result.rebound) bumpDataRevision("sessions");
		return result;
	},
	syncRuntime: (materialized) => syncAcpRuntime(materialized),
	managedInstaller: acpManagedInstaller,
	managedMutationAuthorized: (request) =>
		verifyToken(request.headers.get("x-hlid-internal"), SERVER_TOKEN),
});
const handleExtensionRoute = createExtensionRouteHandler({
	loadConfig,
	onChanged: async (latest) => {
		invalidateVaultSnapshot("provider-extension-mutation", latest);
		providerCatalogSnapshot.invalidate();
		invalidateCodexHostCapabilities();
		void refreshCodexHostCapabilities().catch((error) => {
			console.warn(
				"[extensions] Codex host capability refresh deferred:",
				error instanceof Error ? error.message : String(error),
			);
		});
		const idleEntries = [...pool.getAllEntries()].filter((entry) =>
			entry.manager.retireProviderRuntime(),
		);
		closeIdleCodexAppServers();
		await Promise.all(
			idleEntries.map((entry) =>
				entry.manager
					.refreshProviderMetadata((message) =>
						entry.runState.broadcast(message),
					)
					.catch((error) => {
						console.warn(
							"[extensions] provider refresh deferred:",
							error instanceof Error ? error.message : String(error),
						);
						return false;
					}),
			),
		);
		bumpDataRevision("providers", "mcp", "vault");
	},
});
const acpCatalog = await acpRegistry.catalog(config, false, false, {
	agentIds: (config.acp_agents ?? []).map((agent) => agent.id),
});
const cliProxy = new CliProxyManager(config.cliproxy);
const providers = new Map<string, AgentProvider>([
	["claude", new ClaudeProvider()],
	[
		"codex",
		new CodexProvider({
			realtimeEnabled: () => loadConfig().voice.codex_live_mode === true,
			metadataExecutable: () =>
				loadConfig().codex.executable ?? resolveCodexExecutable(),
		}),
	],
]);
function cliProxyProviders(connection: CliProxyConnection): AgentProvider[] {
	const routed: AgentProvider[] = [
		new CliProxyCodexProvider(connection),
		new CliProxyNativeCodexProvider(connection),
	];
	const openCode = acpCatalog.find((candidate) => candidate.id === "opencode");
	const hostOpenCode = openCode?.targets.find(
		(target) => target.target.kind === "host" && target.available,
	);
	if (hostOpenCode) {
		routed.push(
			new CliProxyOpenCodeProvider(connection, {
				command: hostOpenCode.command,
				args: hostOpenCode.args,
				env: hostOpenCode.env,
			}),
		);
	}
	return routed;
}
const initialCliProxyConnection = cliProxy.connection();
let activeCliProxyConnection = initialCliProxyConnection;
if (initialCliProxyConnection) {
	for (const provider of cliProxyProviders(initialCliProxyConnection)) {
		providers.set(provider.providerId, provider);
	}
}
const managedAcpFingerprints = new Map<string, string>();
for (const item of acpCatalog.filter((candidate) => candidate.enabled)) {
	providers.set(item.providerId, createConfiguredAcpProvider(item, config));
	managedAcpFingerprints.set(
		item.providerId,
		acpRuntimeFingerprint(item, config),
	);
}
for (const provider of providers.values()) {
	db.registerProvider(
		provider.providerId,
		provider.label ?? provider.providerId,
		provider.usageWindows ? [...provider.usageWindows] : [],
	);
}
// Keep live model discovery demand-driven. In particular, Codex implements
// `listModels()` through its app-server, so warming this cache during boot
// would retain a roughly 100 MB helper process before anyone selects Codex.
let providerCatalogSnapshot: ProviderCatalogSnapshot;
const publishProviderMetadataRevision = (providerId: string) => {
	// Live model and capability discovery is observational metadata scoped by
	// provider runtime and workspace. The request that performed the discovery
	// receives that result directly, while the server snapshot is invalidated so
	// later cached reads can consume it. Do not bump the global providers data
	// revision here: a Windows OpenCode inspection must not invalidate an already
	// current WSL catalog (or vice versa) and force another provider process when
	// the user switches workspaces.
	providerCatalogSnapshot.invalidateMetadata(providerId);
};
const modelCatalog = createModelCatalog(providers, (providerId) => {
	publishProviderMetadataRevision(providerId);
});
const providerCapabilityCatalog = createProviderCapabilityCatalog(
	providers,
	config.vault.path || process.cwd(),
	(providerId) => {
		publishProviderMetadataRevision(providerId);
	},
);
providerCatalogSnapshot = createProviderCatalogSnapshot(
	() => providers.values(),
	{
		modelsFor: modelCatalog.modelsFor,
		refreshModelsFor: modelCatalog.refreshModelsFor,
		cachedModelsFor: modelCatalog.cachedModelsFor,
		capabilitiesFor: providerCapabilityCatalog.capabilitiesFor,
		cachedCapabilitiesFor: providerCapabilityCatalog.cachedCapabilitiesFor,
	},
	{ discoveryCwd: () => loadConfig().vault.path || process.cwd() },
);
const handleProviderAppRoute = createProviderAppRouteHandler({
	getProvider: (providerId) => providers.get(providerId),
	loadConfig,
	onAuthenticationStarted: () => {
		providerCatalogSnapshot.invalidate();
		bumpDataRevision("providers", "mcp");
	},
});
let cliProxyAccountsKey = JSON.stringify(cliProxy.status().accounts);
let activeCodexRealtimeEnabled = config.voice.codex_live_mode === true;
let activeCodexExecutable = config.codex.executable ?? resolveCodexExecutable();
let providerCatalogRevision = getDataRevisions().providers;
subscribeDataRevisions((revisions) => {
	if (revisions.providers !== providerCatalogRevision) {
		providerCatalogRevision = revisions.providers;
		providerCatalogSnapshot.invalidate();
	}
	broadcast({ type: "data_revisions", revisions });
});
warmVaultSnapshot();
warmObsidianConnection(config.vault.name);
const pool = new SessionPool(config, providers);
await db.stopActiveProjectPreviewsAfterRestart();
const reconciledDelegations =
	await db.reconcileOrphanedHlidDelegationsAfterRestart();
const interruptedDelegations =
	await db.interruptActiveHlidDelegationsAfterRestart();
if (reconciledDelegations > 0 || interruptedDelegations > 0) {
	bumpDataRevision("sessions");
}
void cliProxy
	.initialize()
	.then(() =>
		cliProxy.syncWslAgents((config.agents ?? []).map((agent) => agent.path)),
	)
	.catch((error) => {
		console.error(
			"[cliproxy] failed to initialize:",
			error instanceof Error ? error.message : String(error),
		);
	});
const voice = new VoiceModelManager(
	config.voice,
	await bootstrapVoiceRuntime(),
);
voice.warmCatalog();
void voice.initialize();
const tts = new TtsModelManager(config.voice);
void tts.initialize().catch((error) => {
	console.error(
		"[tts] failed to initialize:",
		error instanceof Error ? error.message : String(error),
	);
});
const microsoftSpeech = new MicrosoftSpeechManager();
const handleReadAloudRoute = createReadAloudRouteHandler({
	speech: microsoftSpeech,
	tts: {
		synthesize: (text, voiceId, speed) => tts.synthesize(text, voiceId, speed),
	},
	getAssistantMessageText: db.getAssistantMessageText,
	getNeuralSettings: () => {
		const voiceConfig = loadConfig().voice;
		return {
			voiceId: voiceConfig.tts_voice,
			rate: voiceConfig.read_aloud_rate,
		};
	},
});
const ptyWorkerPath = await bootstrapPtyRuntime();
const terminalPool = new TerminalSessionPool(ptyWorkerPath, () => {
	broadcast({
		type: "sessions_status",
		sessions: getLiveSessionsStatus(pool, terminalPool),
	});
});
const broadcastLiveSessions = () => {
	broadcast({
		type: "sessions_status",
		sessions: getLiveSessionsStatus(pool, terminalPool),
	});
};
const pushNotificationCoordinator = new PushNotificationCoordinator({
	deliver: async (event) => {
		await deliverPushEvent({
			kind: event.kind,
			sessionId: event.sessionId,
			label: event.label,
			reason: event.reason,
			url: event.url,
			createdAt: event.occurredAt,
			expiresAt: event.expiresAt,
		});
	},
});
// Establish the current process state as a quiet baseline before observing
// later transitions. Restarting Hlid must not replay stale attention as push.
pushNotificationCoordinator.observe(getLiveSessionsStatus(pool, terminalPool));
const unsubscribePushNotifications = subscribeSessionsStatusBroadcast(
	(sessions) => pushNotificationCoordinator.observe(sessions),
);
pool.setStatusChangeHandler(broadcastLiveSessions);
let durableDelegationRefresh: Promise<void> | null = null;
let durableDelegationRefreshAgain = false;
const refreshDurableDelegationAttention = (): Promise<void> => {
	if (durableDelegationRefresh) {
		durableDelegationRefreshAgain = true;
		return durableDelegationRefresh;
	}
	durableDelegationRefresh = (async () => {
		do {
			durableDelegationRefreshAgain = false;
			await pool.refreshDurableDelegationAttention();
		} while (durableDelegationRefreshAgain);
	})().finally(() => {
		durableDelegationRefresh = null;
	});
	return durableDelegationRefresh;
};
await refreshDurableDelegationAttention();
const hlidDelegationManager = new HlidDelegationManager(
	pool,
	(cwd) =>
		providerCatalogSnapshot.get({
			refresh: true,
			preferCachedModels: false,
			discoveryCwd: cwd,
		}),
	() => {
		bumpDataRevision("sessions");
		broadcastLiveSessions();
		void refreshDurableDelegationAttention()
			.then(broadcastLiveSessions)
			.catch((error) => {
				console.error(
					"[delegation attention] refresh failed:",
					error instanceof Error ? error.message : String(error),
				);
			});
	},
);
const handleHlidDelegationRoute = createHlidDelegationRouteHandler(
	hlidDelegationManager,
);
await startRoutineScheduler(
	pool,
	hlidDelegationManager,
	(cwd) =>
		providerCatalogSnapshot.get({
			refresh: true,
			preferCachedModels: false,
			discoveryCwd: cwd,
		}),
	broadcastLiveSessions,
).catch((error) => {
	console.error(
		"[routines] failed to initialize:",
		error instanceof Error ? error.message : String(error),
	);
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

async function cleanupForShutdown(): Promise<void> {
	unsubscribePushNotifications();
	pushNotificationCoordinator.close();
	stopRoutineScheduler();
	cliProxy.close();
	voice.close();
	tts.close();
	await pool.closeAllAndWait();
	terminalPool.closeAll();
	shellPool.closeAll();
	closeAllCodexAppServers();
	closeUmbod();
	await waitForCodexAppServerTerminations();
	await projectPreviewManager.closeAll();
}

registerShutdownCleanup(cleanupForShutdown);

// Graceful shutdown: stop providers while retaining durable pre-dispatch turns.
process.on("SIGTERM", exitAfterShutdownCleanup);
process.on("SIGINT", exitAfterShutdownCleanup);

const PORT = config.server.port + 1; // 3001 when TanStack Start is on 3000
const UI_PORT = config.server.port;
const CODEX_STARTUP_WARM_TIMEOUT_MS = 3_000;
const observeApiRequest = createRequestObserver({
	scope: "internal-api",
	slowRequestMs: (request) => {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/voice/transcribe") return 70_000;
		if (pathname.startsWith("/read-aloud/")) return 10_000;
		if (pathname === "/api/attachments/upload") return 30_000;
		if (pathname.startsWith("/api/attachments/")) return 10_000;
		const acpThreshold = acpProviderOperationSlowRequestThreshold(pathname);
		if (acpThreshold !== undefined) return acpThreshold;
		const previewThreshold = projectPreviewSlowRequestThreshold(pathname);
		if (previewThreshold !== undefined) return previewThreshold;
		if (pathname.startsWith("/hlid-agents/") && pathname.endsWith("/wait")) {
			return 65_000;
		}
		return 1_000;
	},
});

// Per-provider transparent proxies. Each provider with proxyConfig gets its own
// proxy that captures utilization headers and sets the provider's base URL env var.
const anthropicUpstream = (
	process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
).replace(/\/$/, "");

const providerProxyStarts: Promise<void>[] = [];
for (const provider of providers.values()) {
	if (provider.proxyConfig) {
		providerProxyStarts.push(startProviderProxy(provider, anthropicUpstream));
	} else if (provider.usageWindows?.length) {
		// Providers such as Codex report windows through their control API rather
		// than an HTTP proxy. Hydrate their last durable reading before Raven can
		// submit the first post-restart turn.
		providerProxyStarts.push(
			seedWindowMarks(
				provider.providerId,
				provider.usageWindows.map((window) => window.windowId),
			),
		);
	}
}

// ----- UI server (port = config.server.port, default 3000) ---------------
// Serves embedded SPA assets and forwards everything else (server fns,
// /api/*, etc.) to TanStack Start's fetch handler.
//
// Only runs from the compiled exe. In dev (`bun run dev:all`), Vite owns
// port 3000 and serves the UI with HMR.

const isCompiled = process.execPath.endsWith(".exe");
let directUiForward: import("./uiServer").UiForward | undefined;

if (isCompiled) {
	directUiForward = await startUiServer(UI_PORT, BIND_HOST, {
		wsPort: PORT,
		internalToken: SERVER_TOKEN,
		localNetworkAccess: config.server.local_network_access,
	});

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

type AppServer = Server<
	WsData | TerminalWsData | ShellWsData | ProjectPreviewRelayWsData
>;

const upgradeTerminalWebSocket = createTerminalUpgradeHandler({
	defaultCwd: config.vault.path,
	resolveCwd: (requestedCwd) => resolveAllowedTerminalCwd(config, requestedCwd),
	createSession: async (sessionId) => {
		await db.createSession(sessionId, "Terminal session", "claude-cli");
	},
	getSessionPresentation: async (sessionId) => {
		const row = await db.getSessionById(sessionId);
		return {
			label: row?.label ?? null,
			pinned: row?.pinned === 1,
			forkParentSessionId: row?.fork_parent_session_id ?? null,
			forkParentLabel: row?.fork_parent_label ?? null,
			forkKind: row?.fork_kind ?? null,
		};
	},
	getResumeId: db.getSessionClaudeId,
});

const upgradeShellWebSocket = createShellUpgradeHandler({
	defaultCwd: config.vault.path,
	resolveCwd: (requestedCwd) => resolveAllowedTerminalCwd(config, requestedCwd),
});

function isProjectPreviewOriginRequest(req: Request, url: URL): boolean {
	if (req.headers.get("x-hlid-preview-origin") === "1") return true;
	const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
	return (
		port === PORT &&
		!req.headers.has("x-hlid-internal") &&
		!req.headers.has("x-hlid-proxy-token")
	);
}

async function handleWebSocketRoute(
	req: Request,
	server: AppServer,
	url: URL,
	peerIp: string | undefined,
): Promise<Response | undefined | null> {
	const selectedUrl = isProjectPreviewOriginRequest(req, url)
		? selectedProjectPreviewRelayUrl(url, req.headers.get("cookie"))
		: null;
	const effectiveUrl = selectedUrl ?? url;
	const previewRelay = parseProjectPreviewRelayWebSocket(
		req,
		effectiveUrl.pathname,
	);
	if (
		url.pathname !== "/ws" &&
		url.pathname !== "/ws/terminal" &&
		url.pathname !== "/ws/shell" &&
		!previewRelay
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
	if (previewRelay) {
		let target: ReturnType<typeof projectPreviewManager.relayTarget>;
		try {
			target = projectPreviewManager.relayTarget(previewRelay.previewId);
		} catch {
			return new Response("Project Preview is unavailable", { status: 404 });
		}
		const upstreamTarget = projectPreviewUpstreamTarget(
			target.port,
			previewRelay.targetPath,
		);
		if (
			server.upgrade(req, {
				data: {
					isProjectPreviewRelay: true,
					wsTarget: `ws://127.0.0.1:${upstreamTarget.port}${upstreamTarget.path}${effectiveUrl.search}`,
					back: null,
					queue: [],
					protocols: projectPreviewWebSocketProtocols(req),
					upstreamHeaders: projectPreviewRelayWebSocketHeaders(
						req,
						previewRelay.previewId,
						target.capability,
					),
				},
			})
		) {
			return undefined;
		}
		return new Response("WebSocket upgrade required", { status: 426 });
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
			data: {
				isTerminal: false,
				subscribedSessionId: "",
				batchedReplay: url.searchParams.get("replay_batch") === "1",
			},
		})
	) {
		return undefined;
	}
	return new Response("WebSocket upgrade required", { status: 426 });
}

function handleCodexRoute(url: URL, req: Request): Response | null {
	if (url.pathname === "/claude/warmup" && req.method === "GET") {
		return Response.json(getClaudeWarmupSnapshot());
	}
	if (url.pathname === "/codex/app-servers" && req.method === "GET") {
		return Response.json(listCodexAppServers());
	}
	if (url.pathname !== "/codex/app-servers/restart" || req.method !== "POST") {
		return null;
	}
	const closed = listCodexAppServers().filter((server) => server.alive).length;
	closeAllCodexAppServers();
	const codex = providers.get("codex");
	if (codex) {
		modelCatalog.register(codex, { refreshIdentity: true });
		providerCapabilityCatalog.register(codex);
	}
	providerCatalogSnapshot.invalidate();
	invalidateCodexHostCapabilities();
	bumpDataRevision("providers");
	return Response.json({ ok: true, closed });
}

async function handleProviderRoute(url: URL, req: Request) {
	if (url.pathname !== "/providers" || req.method !== "GET") return null;
	if (
		(url.searchParams.get("refresh") === "1" ||
			url.searchParams.get("host_capabilities_wait") === "1") &&
		url.searchParams.get("host_capabilities") === "1"
	) {
		await refreshCodexHostCapabilities();
	}
	let requestOptions: ReturnType<typeof providerCatalogRequestOptions>;
	try {
		requestOptions = providerCatalogRequestOptions(url.searchParams);
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
	try {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const result = await providerCatalogSnapshot.getVersioned(requestOptions);
			if (!providerCatalogSnapshot.isCurrentVersion(result.version)) continue;
			const revision = getDataRevisions().providers;
			if (!providerCatalogSnapshot.isCurrentVersion(result.version)) continue;
			return Response.json(
				{ providers: result.providers },
				{
					headers: {
						"x-hlid-providers-revision": String(revision),
					},
				},
			);
		}
	} catch {
		// Fall through to the same bounded failure returned after a late invalidation.
	}
	return Response.json(
		{ error: "Provider catalog changed repeatedly during refresh" },
		{ status: 503 },
	);
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

async function downloadTtsModel(req: Request): Promise<Response> {
	try {
		const { model } = (await req.json()) as { model?: string };
		if (!model) {
			return Response.json({ error: "model is required" }, { status: 400 });
		}
		void tts
			.download(model)
			.catch((error) => console.error("[tts] download failed:", error));
		return Response.json({ ok: true }, { status: 202 });
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: 400 });
	}
}

async function deleteTtsModel(url: URL): Promise<Response> {
	try {
		const model = url.searchParams.get("model");
		if (!model) {
			return Response.json({ error: "model is required" }, { status: 400 });
		}
		await tts.deleteModel(model);
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

async function handleConflictRoute(
	handlers: Record<string, ServerRouteHandler>,
	url: URL,
	request: Request,
): Promise<Response | null> {
	const handler = handlers[`${request.method} ${url.pathname}`];
	if (!handler) return null;
	try {
		return await handler(url, request);
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 409 },
		);
	}
}

let cliProxyRuntimeSyncTail: Promise<void> = Promise.resolve();
let acpRuntimeSyncTail: Promise<AcpRuntimeSyncResult> = Promise.resolve({
	added: [],
	removed: [],
	replaced: [],
	availabilityUpdated: [],
});

type MaterializedAcpRuntimeCatalog = {
	config: HlidConfig;
	catalog: AcpCatalogItem[];
};

function sameConfigSnapshot(left: HlidConfig, right: HlidConfig): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

async function applyAcpRuntimeConfig(
	materialized?: MaterializedAcpRuntimeCatalog,
	refreshRuntimeEvidence = true,
): Promise<AcpRuntimeSyncResult> {
	const latest = loadConfig();
	const catalog =
		materialized && sameConfigSnapshot(latest, materialized.config)
			? materialized.catalog
			: await acpRegistry.catalog(latest, false, refreshRuntimeEvidence, {
					agentIds: (latest.acp_agents ?? []).map((agent) => agent.id),
				});
	const result = await syncAcpRuntimeProviders({
		config: latest,
		catalog,
		providers,
		fingerprints: managedAcpFingerprints,
		retireProviderSessions: (providerIds, options) =>
			pool.retireProviderSessions(providerIds, options),
		registerProvider: (provider, replaced) => {
			modelCatalog.register(provider, { refreshIdentity: replaced });
			providerCapabilityCatalog.register(provider, {
				refreshIdentity: replaced,
			});
			db.registerProvider(
				provider.providerId,
				provider.label ?? provider.providerId,
				provider.usageWindows ? [...provider.usageWindows] : [],
			);
		},
	});
	pool.syncConfig(latest);
	if (
		result.added.length > 0 ||
		result.removed.length > 0 ||
		result.replaced.length > 0 ||
		result.availabilityUpdated.length > 0
	) {
		providerCatalogSnapshot.invalidate();
		bumpDataRevision("providers");
	}
	return result;
}

function syncAcpRuntime(
	materialized?: MaterializedAcpRuntimeCatalog,
	refreshRuntimeEvidence = true,
): Promise<AcpRuntimeSyncResult> {
	const pending = acpRuntimeSyncTail.then(() =>
		applyAcpRuntimeConfig(materialized, refreshRuntimeEvidence),
	);
	acpRuntimeSyncTail = pending.catch(() => ({
		added: [],
		removed: [],
		replaced: [],
		availabilityUpdated: [],
	}));
	return pending;
}

acpPlatformReconciliationReady = true;
if (acpPlatformReconciliationQueued) requestAcpPlatformReconciliation();

async function applyCliProxyRuntimeConfig(): Promise<void> {
	const latest = loadConfig();
	const nextCodexExecutable =
		latest.codex.executable ?? resolveCodexExecutable();
	const codexRealtimeChanged =
		(latest.voice.codex_live_mode === true) !== activeCodexRealtimeEnabled;
	const codexExecutableChanged = nextCodexExecutable !== activeCodexExecutable;
	await cliProxy.syncConfig(latest.cliproxy);
	await cliProxy.syncWslAgents(
		(latest.agents ?? []).map((agent) => agent.path),
	);
	const connection = cliProxy.connection();
	const connectionChanged =
		connection?.base_url !== activeCliProxyConnection?.base_url ||
		connection?.api_key !== activeCliProxyConnection?.api_key;
	const cliProxyProviderIds = [
		CLIPROXY_CODEX_PROVIDER_ID,
		CLIPROXY_CODEX_HARNESS_PROVIDER_ID,
		CLIPROXY_OPENCODE_PROVIDER_ID,
	] as const;
	if (connectionChanged) {
		const retiredProviderIds = cliProxyProviderIds.filter((providerId) =>
			providers.has(providerId),
		);
		for (const providerId of retiredProviderIds) {
			providers.delete(providerId);
		}
		await pool.retireProviderSessions(retiredProviderIds);
		if (connection) {
			for (const provider of cliProxyProviders(connection)) {
				providers.set(provider.providerId, provider);
				modelCatalog.register(provider);
				providerCapabilityCatalog.register(provider);
				db.registerProvider(
					provider.providerId,
					provider.label ?? provider.providerId,
					provider.usageWindows ? [...provider.usageWindows] : [],
				);
			}
		}
		activeCliProxyConnection = connection;
		providerCatalogSnapshot.invalidate();
		bumpDataRevision("providers");
	}
	pool.syncConfig(latest);
	if (codexRealtimeChanged || codexExecutableChanged) {
		activeCodexRealtimeEnabled = latest.voice.codex_live_mode === true;
		activeCodexExecutable = nextCodexExecutable;
		resetCodexRealtimeBackendStatus();
		const codex = providers.get("codex");
		if (codex) {
			providerCapabilityCatalog.register(codex);
			if (codexExecutableChanged) {
				modelCatalog.register(codex, { refreshIdentity: true });
			}
		}
		providerCatalogSnapshot.invalidate();
		bumpDataRevision("providers");

		if (nextCodexExecutable) {
			const launch = codexLaunchConfig({
				cwd: latest.vault.path || process.cwd(),
				executable: nextCodexExecutable,
				enableRealtime: activeCodexRealtimeEnabled,
			});
			void prewarmCodexAppServer(
				launch.appServer,
				CODEX_STARTUP_WARM_TIMEOUT_MS,
			).catch((error) => {
				console.warn(
					"[codex app-server] runtime config warm-up failed:",
					error instanceof Error ? error.message : String(error),
				);
			});
		}
	}
}

function syncCliProxyRuntime(): Promise<void> {
	const pending = cliProxyRuntimeSyncTail.then(() =>
		applyCliProxyRuntimeConfig(),
	);
	// Keep the queue usable after a failed sync while returning the original
	// rejection to the caller that owns this attempt.
	cliProxyRuntimeSyncTail = pending.catch(() => {});
	return pending;
}

function syncCliProxyAccountCatalogs(): void {
	const nextKey = JSON.stringify(cliProxy.status().accounts);
	if (nextKey === cliProxyAccountsKey) return;
	cliProxyAccountsKey = nextKey;
	for (const providerId of [
		CLIPROXY_CODEX_PROVIDER_ID,
		CLIPROXY_CODEX_HARNESS_PROVIDER_ID,
		CLIPROXY_OPENCODE_PROVIDER_ID,
	]) {
		const provider = providers.get(providerId);
		if (provider) {
			modelCatalog.register(provider);
			providerCapabilityCatalog.register(provider);
		}
	}
	providerCatalogSnapshot.invalidate();
	bumpDataRevision("providers");
}

function writeManagedCliProxyConfig(enabled: boolean): void {
	const latest = loadConfig();
	writeConfig({
		...latest,
		cliproxy: {
			...latest.cliproxy,
			enabled,
			mode: "managed",
			base_url: MANAGED_CLIPROXY_BASE_URL,
			api_key: "",
		},
	});
}

const CLIPROXY_ROUTE_HANDLERS: Record<string, ServerRouteHandler> = {
	"GET /cliproxy": async (url) => {
		if (url.searchParams.get("refresh") === "1") {
			await cliProxy.refreshRelease();
		}
		syncCliProxyAccountCatalogs();
		return Response.json(cliProxy.status());
	},
	"POST /cliproxy/sync": async () => {
		await syncCliProxyRuntime();
		return Response.json(cliProxy.status());
	},
	"POST /cliproxy/install": async () => {
		const status = observeCliProxyInstallJob(
			cliProxy.startInstall(),
			async () => {
				writeManagedCliProxyConfig(true);
				await syncCliProxyRuntime();
			},
			(error) => {
				console.error(
					"[cliproxy] install failed:",
					error instanceof Error ? error.message : String(error),
				);
			},
		);
		return Response.json(status, { status: 202 });
	},
	"POST /cliproxy/start": async () => {
		writeManagedCliProxyConfig(true);
		await syncCliProxyRuntime();
		return Response.json(cliProxy.status());
	},
	"POST /cliproxy/stop": async () => {
		writeManagedCliProxyConfig(false);
		await syncCliProxyRuntime();
		return Response.json(cliProxy.status());
	},
	"POST /cliproxy/oauth": async (url) => {
		const provider = url.searchParams.get("provider") ?? "codex";
		if (!["codex", "claude", "antigravity", "kimi", "xai"].includes(provider)) {
			throw new Error("unsupported CLIProxy OAuth provider");
		}
		const status = cliProxy.beginOAuth(
			provider as import("./cliproxyManager").CliProxyOAuthProviderId,
		);
		return Response.json(status, { status: 202 });
	},
	"DELETE /cliproxy": async () => {
		await cliProxy.remove();
		writeManagedCliProxyConfig(false);
		await syncCliProxyRuntime();
		return Response.json(cliProxy.status());
	},
};

async function handleCliProxyRoute(url: URL, req: Request) {
	return handleConflictRoute(CLIPROXY_ROUTE_HANDLERS, url, req);
}

const VOICE_ROUTE_HANDLERS: Record<string, ServerRouteHandler> = {
	"GET /voice": async (url) => {
		const refresh = url.searchParams.get("refresh") === "1";
		return Response.json({
			status: voice.status(),
			models: await voice.models(refresh),
			codexRealtimeBackend: getCodexRealtimeBackendStatus(),
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

const TTS_ROUTE_HANDLERS: Record<string, ServerRouteHandler> = {
	"GET /tts": async () =>
		Response.json({
			status: tts.status(),
			models: tts.models(),
		}),
	"POST /tts/sync": async () => {
		await tts.syncConfig(loadConfig().voice);
		return Response.json({ status: tts.status() });
	},
	"POST /tts/download": (_url, request) => downloadTtsModel(request),
	"POST /tts/download/cancel": async () => {
		tts.cancelDownload();
		return Response.json({ ok: true });
	},
	"DELETE /tts/model": (url) => deleteTtsModel(url),
};

async function handleTtsRoute(url: URL, req: Request) {
	return handleConflictRoute(TTS_ROUTE_HANDLERS, url, req);
}

async function handleAccountRoute(url: URL, req: Request) {
	if (url.pathname !== "/account" || req.method !== "GET") return null;
	for (const entry of pool.getAllEntries()) {
		const info = await entry.manager.getAccountInfo();
		if (info) return Response.json(info);
	}
	return Response.json(null);
}

async function handleRoutineRoute(url: URL, req: Request) {
	if (req.method !== "POST") return null;
	if (url.pathname === "/routines/changed") {
		bumpDataRevision("routines");
		return Response.json({ ok: true });
	}
	if (url.pathname !== "/routines/run") return null;
	try {
		const body = (await req.json()) as { id?: unknown };
		if (typeof body.id !== "string" || !body.id) {
			return Response.json(
				{ error: "Routine id is required" },
				{ status: 400 },
			);
		}
		return Response.json(await runRoutineNow(body.id), { status: 202 });
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 409 },
		);
	}
}

const handleAuthenticatedRoute = createAuthenticatedRouteHandler({
	getStatus: () => pool.vaultEntry().manager.getStatus(),
	getApiIndex: () => buildApiIndex(PORT, UI_PORT),
	orderedHandlers: [
		handleCodexRoute,
		handleProviderRoute,
		handleProviderAppRoute,
		handleAcpRoute,
		handleExtensionRoute,
		handleCliProxyRoute,
		handleVoiceRoute,
		handleTtsRoute,
		handleReadAloudRoute,
		handleAccountRoute,
		handleRoutineRoute,
		handleHlidDelegationRoute,
		handleProjectPreviewRoute,
		handlePushRoute,
		(url, request) =>
			handleSkillRoute(url, request, config, providers, {
				refreshProviderSkills: () =>
					refreshLiveClaudeSkills(pool.getAllEntries()),
			}),
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

function invalidCliUpdateLeaseResponse(): Response {
	return Response.json({ error: "Invalid CLI update lease" }, { status: 409 });
}

async function requestedCliUpdateLease(
	req: Request,
	peerIp: string | undefined,
): Promise<string | Response> {
	if (
		!isLoopback(peerIp) ||
		!verifyToken(req.headers.get("x-hlid-internal"), SERVER_TOKEN)
	) {
		return new Response("Forbidden", { status: 403 });
	}
	const body = (await req.json().catch(() => null)) as {
		leaseId?: unknown;
	} | null;
	return typeof body?.leaseId === "string" &&
		body.leaseId.length > 0 &&
		body.leaseId.length <= 200
		? body.leaseId
		: invalidCliUpdateLeaseResponse();
}

async function dispatchServerFetch(
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
		const leaseId = pool.beginCliUpdateLease();
		const sessions = pool.getSize();
		const appServers = listCodexAppServers().filter(
			(entry) => entry.alive,
		).length;
		try {
			await pool.closeAllAndWait();
			closeAllCodexAppServers();
		} catch (error) {
			pool.releaseCliUpdateLease(leaseId);
			throw error;
		}
		broadcast({
			type: "sessions_status",
			sessions: getLiveSessionsStatus(pool, terminalPool),
		});
		return Response.json({
			ok: true,
			data: { sessions, appServers, leaseId },
		});
	}
	if (
		req.method === "POST" &&
		url.pathname === "/internal/cli-updates/heartbeat"
	) {
		const leaseId = await requestedCliUpdateLease(req, peerIp);
		if (leaseId instanceof Response) return leaseId;
		if (!pool.renewCliUpdateLease(leaseId))
			return invalidCliUpdateLeaseResponse();
		return Response.json({ ok: true });
	}
	if (
		req.method === "POST" &&
		url.pathname === "/internal/cli-updates/reconcile-acp"
	) {
		const leaseId = await requestedCliUpdateLease(req, peerIp);
		if (leaseId instanceof Response) return leaseId;
		if (!pool.ownsCliUpdateLease(leaseId))
			return invalidCliUpdateLeaseResponse();
		await syncAcpRuntime();
		if (!pool.releaseCliUpdateLease(leaseId)) {
			return Response.json(
				{ error: "CLI update lease expired during runtime refresh" },
				{ status: 409 },
			);
		}
		return Response.json({ ok: true });
	}
	if (
		req.method === "POST" &&
		url.pathname === "/internal/cli-updates/release"
	) {
		const leaseId = await requestedCliUpdateLease(req, peerIp);
		if (leaseId instanceof Response) return leaseId;
		if (!pool.releaseCliUpdateLease(leaseId)) {
			return invalidCliUpdateLeaseResponse();
		}
		return Response.json({ ok: true });
	}
	if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		const selectedUrl = isProjectPreviewOriginRequest(req, url)
			? selectedProjectPreviewRelayUrl(url, req.headers.get("cookie"))
			: null;
		if (selectedUrl) {
			return handleServerRequest(new Request(selectedUrl, req), peerIp, server);
		}
	}
	return handleServerRequest(req, peerIp, server);
}

async function handleServerFetch(
	req: Request,
	server: AppServer,
): Promise<Response | undefined> {
	return observeApiRequest(req, () => dispatchServerFetch(req, server));
}

const internalApiServer = Bun.serve<
	WsData | TerminalWsData | ShellWsData | ProjectPreviewRelayWsData
>({
	port: PORT,
	hostname: BIND_HOST,
	maxRequestBodySize: Math.max(
		MAX_VOICE_BODY_BYTES,
		config.attachments.max_bytes + MULTIPART_OVERHEAD_BYTES,
	),
	...tlsConfig,

	fetch: handleServerFetch,

	websocket: (() => {
		const chatHandlers = createWsHandlers(pool, terminalPool, shellPool);
		const termHandlers = createTerminalWsHandlers(terminalPool);
		const shellHandlers = createShellWsHandlers(shellPool);
		const previewRelayHandlers = createProjectPreviewRelayWsHandlers();
		type ChatWs = Parameters<typeof chatHandlers.open>[0];
		type TerminalWs = ServerWebSocket<TerminalWsData>;
		type ShellWs = ServerWebSocket<ShellWsData>;
		type PreviewRelayWs = ServerWebSocket<ProjectPreviewRelayWsData>;
		type AppWs = ChatWs | TerminalWs | ShellWs | PreviewRelayWs;
		type WsMessage = Parameters<typeof chatHandlers.message>[1];
		const isTerminalWs = (ws: AppWs): ws is TerminalWs =>
			"isTerminal" in ws.data && ws.data.isTerminal === true;
		const isShellWs = (ws: AppWs): ws is ShellWs =>
			"isShell" in ws.data && ws.data.isShell === true;
		const isPreviewRelayWs = (ws: AppWs): ws is PreviewRelayWs =>
			"isProjectPreviewRelay" in ws.data &&
			ws.data.isProjectPreviewRelay === true;
		return {
			maxPayloadLength: MAX_WS_PAYLOAD_BYTES,
			open(ws: AppWs) {
				if (isPreviewRelayWs(ws)) previewRelayHandlers.open(ws);
				else if (isTerminalWs(ws)) termHandlers.open(ws);
				else if (isShellWs(ws)) shellHandlers.open(ws);
				else chatHandlers.open(ws);
			},
			message(ws: AppWs, data: WsMessage) {
				if (isPreviewRelayWs(ws)) previewRelayHandlers.message(ws, data);
				else if (isTerminalWs(ws)) termHandlers.message(ws, data);
				else if (isShellWs(ws)) shellHandlers.message(ws, data);
				else chatHandlers.message(ws, data);
			},
			close(ws: AppWs) {
				if (isPreviewRelayWs(ws)) previewRelayHandlers.close(ws);
				else if (isTerminalWs(ws)) termHandlers.close(ws);
				else if (isShellWs(ws)) shellHandlers.close(ws);
				else chatHandlers.close(ws);
			},
		};
	})(),
});
registerBunServer(internalApiServer);
registerInternalApiHandler(async (request) => {
	const response = await observeApiRequest(request, () =>
		handleServerRequest(request, "127.0.0.1", internalApiServer),
	);
	return response ?? new Response("Not found", { status: 404 });
});

console.log(`Hlid server on :${PORT}${process.env.HLID_TLS ? " (TLS)" : ""}`);

// ----- TLS proxy (tls_proxy_port, default 3443) ---------------------------
// Terminates TLS and forwards plain HTTP → UI_PORT, plain WS → PORT.
// Starts whenever cert+key are configured; no separate process needed.
if (config.server.tls_cert_path && config.server.tls_key_path) {
	startTlsProxy({
		tlsPort: config.server.tls_proxy_port,
		uiPort: UI_PORT,
		wsPort: PORT,
		apiPort: PORT,
		bindHost: BIND_HOST,
		certPath: config.server.tls_cert_path,
		keyPath: config.server.tls_key_path,
		localNetworkAccess: config.server.local_network_access,
		internalToken: SERVER_TOKEN,
		maxBodyBytes: Math.max(
			MAX_VOICE_BODY_BYTES,
			config.attachments.max_bytes + MULTIPART_OVERHEAD_BYTES,
		),
		forward: directUiForward,
	});
}

// Provider proxy initialization seeds the usage state Ledger reads and installs
// the provider base URL. Keep the standalone startup splash visible until those
// lightweight local steps and every public listener are ready.
const providerProxyResults = await Promise.allSettled(providerProxyStarts);
for (const result of providerProxyResults) {
	if (result.status === "rejected") {
		console.warn(
			"[proxy] initialization failed before listener startup:",
			result.reason,
		);
	}
}
const restoredPendingTurns = await pool.restoreDurableTurns(() => {
	bumpDataRevision("sessions");
	broadcast({
		type: "sessions_status",
		sessions: getLiveSessionsStatus(pool, terminalPool),
	});
});
if (restoredPendingTurns.restored > 0 || restoredPendingTurns.discarded > 0) {
	bumpDataRevision("sessions");
}
// Populate provider metadata while the splash is visible, but never hold it
// for more than three seconds. Codex keeps its shared app-server available for
// metadata RPCs. Claude snapshots commands/skills and MCP status for the vault
// and configured agent scopes, then closes each metadata-only process. Raven
// reads those snapshots without starting a chat process.
if (isCompiled) {
	const warmups: Promise<void>[] = [];
	const codexExecutable = config.codex.executable ?? resolveCodexExecutable();
	if (codexExecutable) {
		const codexLaunch = codexLaunchConfig({
			cwd: config.vault.path || process.cwd(),
			executable: codexExecutable,
			enableRealtime: config.voice.codex_live_mode === true,
		});
		warmups.push(
			prewarmCodexAppServer(
				codexLaunch.appServer,
				CODEX_STARTUP_WARM_TIMEOUT_MS,
			)
				.then((warmed) => {
					if (!warmed) {
						console.warn(
							"[codex app-server] startup warm-up exceeded 3000ms; continuing in background",
						);
					}
				})
				.catch((error) => {
					console.warn(
						"[codex app-server] startup warm-up failed:",
						error instanceof Error ? error.message : String(error),
					);
				}),
		);
	}
	const vaultPath = config.vault.path || process.cwd();
	const claudeExecutable = resolveClaudeExecutable();
	// Startup discovery is process-wide, not one probe per configured agent.
	// Agent-specific metadata is populated when that agent is actually used.
	// Fan-out here can overwhelm a cold WSL service and make every distro look
	// unavailable until Windows recovers it.
	const claudeScopes = [
		{
			cacheCwd: vaultPath,
			agentCwd: undefined,
			agentMode: "cwd" as const,
		},
	];
	const uniqueClaudeScopes = [
		...new Map(claudeScopes.map((scope) => [scope.cacheCwd, scope])).values(),
	];
	warmups.push(
		Promise.all(
			uniqueClaudeScopes.map((scope) => {
				const execution = resolveExecutionContext({
					agentMode: scope.agentMode,
					agentCwd: scope.agentCwd,
					vaultPath,
					// Startup metadata has no attachments/resources, so it does not need
					// canonical agent roots. Avoid probing every WSL UNC share here.
					allowedAgentRealPaths: [],
					claudeExecutable,
					safeAttachments: [],
				});
				return prewarmClaudeCli({
					executable: execution.executable,
					cwd: execution.activeCwd,
					cacheCwd: scope.cacheCwd,
					additionalDirectories: [...execution.extraDirs],
					waitTimeoutMs: CODEX_STARTUP_WARM_TIMEOUT_MS,
				});
			}),
		)
			.then((results) => {
				const continuing = results.filter((warmed) => !warmed).length;
				if (continuing > 0) {
					console.warn(
						`[claude metadata] ${continuing} startup scan(s) exceeded 3000ms; continuing in background`,
					);
				}
			})
			.catch((error) => {
				console.warn(
					"[claude metadata] startup scan failed:",
					error instanceof Error ? error.message : String(error),
				);
			}),
	);
	await Promise.all(warmups);
	providerCapabilityCatalog.warm();
	markUiServerReady();
}

void (async () => {
	await unlinkPaths(
		(await db.listPendingFileDeletions()).map((entry) => entry.path),
	);
	return db.runPostUpgradeStorageMaintenance();
})()
	.then((result) => {
		const changed =
			result.codexTranscriptsCompacted +
			result.toolImagesSanitized +
			result.toolSummariesBackfilled +
			result.managedImagesProcessed;
		if (changed > 0) {
			console.log(
				`[storage] compacted ${result.codexTranscriptsCompacted} Codex transcript payloads, ${result.toolImagesSanitized} embedded images, ${result.toolSummariesBackfilled} tool summaries, and inspected ${result.managedImagesProcessed} managed PNGs (${result.managedImageBytesSaved} bytes saved)`,
			);
			bumpDataRevision("storage");
		}
	})
	.catch((error) => {
		console.warn(
			"[storage] post-upgrade compaction failed; it will retry after restart:",
			error instanceof Error ? error.message : String(error),
		);
	});
