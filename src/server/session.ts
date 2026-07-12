import { mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { ToolCall } from "@umbod/core";
import type { HlidConfig } from "../config";
import * as db from "../db";
import { resolveClaudeExecutable } from "../lib/claudePath";
import { expandTilde, pathStartsWith, toLogical } from "../lib/paths";
import { SESSION_LABEL_LENGTH } from "../lib/utils";
import {
	computeAllowedAgentRealPaths,
	isAllowedAgentPath,
	resolveAgentMode,
} from "./agentPaths";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	AgentToolDecision,
	CanUseTool,
	McpServerStatus,
	ProviderAccountInfo,
} from "./agentProvider";
import { ingestPlanHtml } from "./attachments";
import { loadConfig } from "./config";
import { resolveExecutionContext } from "./executionContext";
import { parseAskUserQuestion } from "./parseAskUserQuestion";
import { persistAlwaysAllowedTool } from "./permissionStore";
import {
	AskUserQuestionManager,
	PermissionManager,
	PlanModeManager,
} from "./permissions";
import { buildPlanHtmlInstructions, buildPrompt } from "./promptBuilder";
import type {
	AgentSleepMessage,
	AskUserQuestionAnswers,
	AskUserQuestionNotes,
	ChatAttachment,
	ServerMessage,
} from "./protocol";
import { mapMcpServer } from "./protocol";
import { applyReading, updateWindowMark } from "./proxy";
import { generateTurnRecap } from "./recap";
import { SessionTurnQueue } from "./sessionTurnQueue";
import { authorizeHlidTool, registerUmbodApprovalSession } from "./umbod";
import {
	reportRateLimitSignal,
	type SleepDecision,
	skipSleep as skipProviderSleep,
	sleepUntilAllowed,
} from "./usageGate";

/** Fallback context window size when the SDK omits it from result metadata. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Fire-and-forget DB error: console.error + append to log table. */
function logDbError(operation: string, err: unknown): void {
	console.error(`[db] ${operation} failed:`, err);
	void db.appendLog("error", "db", `${operation} failed`, {
		error: String(err),
	});
}

/** Mutable accumulator for per-turn SDK event state, threaded through the event loop. */
type TurnState = {
	receivedAny: boolean;
	assistantText: string;
	lastAssistantText: string;
	lastBlockType: "text" | "tool_use" | null;
	lastActualModel: string | null;
	lastTurnUsage: {
		input_tokens: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	} | null;
	lastKnownContextWindow: number | null;
	hadToolEvents: boolean;
	lastAssistantSeq: number;
	pendingToolEvents: { toolId: string; name: string; input: unknown }[];
	pendingToolResults: Map<string, { content: string; isError: boolean }>;
	/**
	 * Reserved seq for the assistant message of this turn. Allocated lazily on
	 * the first text_delta or tool_start so live writes (text streaming, tool
	 * event inserts) attach to a real row that mid-turn reloads can render.
	 */
	reservedAssistantSeq: number | null;
	persistedToolIds: Set<string>;
	/**
	 * Throttled text-write state: a setTimeout handle that flushes the current
	 * `assistantText` to the DB row. Many chunks arrive per second; rewriting
	 * the full text column on each one would be O(N²) bytes written across the
	 * turn. Coalescing into ~150ms windows keeps liveness while bounding I/O.
	 */
	textWriteTimer: ReturnType<typeof setTimeout> | null;
	textWriteDirty: boolean;
	lastTurnToolEvents: { toolId: string; name: string; input: unknown }[];
	sdkSummary: string | null;
};

// Coalesce live assistant-text writes. 800ms balances persistence liveness
// against event-loop saturation on Windows (antivirus scans each SQLite write).
const TEXT_WRITE_THROTTLE_MS = 800;

type RunQueryArgs = [
	userMessage: string,
	emit: (msg: ServerMessage) => void,
	sessionId?: string,
	skillContext?: string,
	attachments?: ChatAttachment[],
	agentCwd?: string,
	turnId?: string,
	planMode?: boolean,
	planHtml?: boolean,
];

export type SessionState = "idle" | "running" | "error";

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set([
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
]);

type AgentSettings = {
	model?: string;
	effort?: string;
	maxTurns?: number;
	permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
	recapModel?: string;
};

function configuredAgentSettings(
	agent: NonNullable<HlidConfig["agents"]>[number],
): AgentSettings | null {
	const settings: AgentSettings = {};
	if (agent.model) settings.model = agent.model;
	if (agent.effort) settings.effort = agent.effort;
	if (agent.max_turns) settings.maxTurns = agent.max_turns;
	if (agent.permission_mode) settings.permissionMode = agent.permission_mode;
	if (agent.recap_model) settings.recapModel = agent.recap_model;
	return Object.keys(settings).length > 0 ? settings : null;
}

function buildAgentQueryParams(options: {
	activeCwd: string;
	resumeProviderSessionId: string | null;
	extraDirs: Set<string>;
	signal: AbortSignal | undefined;
	agentSettings: AgentSettings | undefined;
	defaultModel: string | undefined;
	configuredPermissionMode: PermissionMode;
	planMode: boolean | undefined;
	planHtmlPath: string | null;
	defaultEffort: string | undefined;
	defaultMaxTurns: number | undefined;
	executable: string | undefined;
	canUseTool: CanUseTool;
}): AgentQueryParams {
	const implementationPermissionMode =
		options.configuredPermissionMode === "plan"
			? "default"
			: options.configuredPermissionMode;
	return {
		cwd: options.activeCwd,
		sessionId: options.resumeProviderSessionId ?? undefined,
		additionalDirectories:
			options.extraDirs.size > 0
				? Array.from(options.extraDirs).map(toLogical)
				: undefined,
		signal: options.signal,
		model: options.agentSettings?.model ?? options.defaultModel,
		permissionMode: options.planMode
			? "plan"
			: options.configuredPermissionMode,
		policyEnforced: loadConfig()?.umbod?.enabled ?? false,
		...(options.planMode ? { implementationPermissionMode } : {}),
		...(options.planMode && options.planHtmlPath
			? { planHtmlPath: toLogical(options.planHtmlPath) }
			: {}),
		effort: options.agentSettings?.effort ?? options.defaultEffort,
		maxTurns: options.agentSettings?.maxTurns ?? options.defaultMaxTurns,
		executable: options.executable,
		settingSources: ["user", "project", "local"],
		canUseTool: options.canUseTool,
	};
}

function buildQueryData(
	event: Extract<AgentEvent, { type: "done" }>,
	turn: TurnState,
): {
	queryData: db.QueryData;
	primaryModel:
		| { contextWindow?: number; maxOutputTokens?: number }
		| undefined;
	tokensInContext: number | null;
} {
	const primaryModel = event.modelUsage
		? Object.values(event.modelUsage)[0]
		: undefined;
	if (primaryModel?.contextWindow) {
		turn.lastKnownContextWindow = primaryModel.contextWindow;
	}
	const tokensInContext = turn.lastTurnUsage
		? turn.lastTurnUsage.input_tokens +
			(turn.lastTurnUsage.cache_read_input_tokens ?? 0) +
			(turn.lastTurnUsage.cache_creation_input_tokens ?? 0)
		: null;
	return {
		primaryModel,
		tokensInContext,
		queryData: {
			cost: event.cost ?? 0,
			input_tokens: event.usage?.inputTokens ?? 0,
			output_tokens: event.usage?.outputTokens ?? 0,
			cache_read_tokens: event.usage?.cacheReadTokens ?? 0,
			cache_creation_tokens: event.usage?.cacheCreationTokens ?? 0,
			duration_ms: event.durationMs,
			turns: event.turns,
			context_window:
				primaryModel?.contextWindow ?? turn.lastKnownContextWindow ?? null,
			stop_reason: event.stopReason ?? null,
			tokens_in_context: tokensInContext,
		},
	};
}

function buildAgentMaps(config: HlidConfig): {
	providers: Map<string, string>;
	settings: Map<string, AgentSettings>;
} {
	const providers = new Map<string, string>();
	const settings = new Map<string, AgentSettings>();
	for (const agent of config.agents ?? []) {
		try {
			const realPath = realpathSync(expandTilde(agent.path));
			providers.set(realPath, agent.provider ?? "claude");
			const agentSettings = configuredAgentSettings(agent);
			if (agentSettings) settings.set(realPath, agentSettings);
		} catch {
			// Paths may not exist yet; they become available on the next config sync.
		}
	}
	return { providers, settings };
}

function createTurnState(): TurnState {
	return {
		receivedAny: false,
		assistantText: "",
		lastAssistantText: "",
		lastBlockType: null,
		lastActualModel: null,
		lastTurnUsage: null,
		lastKnownContextWindow: null,
		hadToolEvents: false,
		lastAssistantSeq: -1,
		pendingToolEvents: [],
		pendingToolResults: new Map(),
		reservedAssistantSeq: null,
		persistedToolIds: new Set(),
		textWriteTimer: null,
		textWriteDirty: false,
		lastTurnToolEvents: [],
		sdkSummary: null,
	};
}

export class SessionManager {
	private providers: Map<string, AgentProvider>;
	private vaultProviderId!: string;
	private agentProviderMap: Map<string, string> = new Map();
	private agentSettingsMap: Map<string, AgentSettings> = new Map();
	private state: SessionState = "idle";
	private abortController: AbortController | null = null;
	private model!: string;
	private effort!: string;
	private maxTurns: number | undefined;
	private vaultPath!: string;
	private permissionMode!: PermissionMode;
	private claudeExecutable: string | undefined;
	private codexExecutable: string | undefined;
	// Provider session ID for the active chat. Captured from the `session_start`
	// event on first turn, persisted per chat row, and passed back via `sessionId`
	// on subsequent turns so the provider manages history natively.
	private providerSessionId: string | null = null;
	private providerSessionProviderId: string | null = null;
	private unregisterUmbodApprovalSession: (() => void) | null = null;
	private permissions = new PermissionManager();
	private askUserQuestions = new AskUserQuestionManager();
	private planModeManager = new PlanModeManager();
	// Deterministic path the agent is asked to write its HTML plan to (plan
	// mode + html_plans on). Set per turn in runOneTurn; the storage root pairs
	// with it for relic ingestion at the ExitPlanMode intercept.
	private planHtmlPath: string | null = null;
	private planHtmlStorageRoot: string | null = null;
	/** Tools approved for the entire hlid session (survives provider subprocess restarts). */
	private sessionAllowedTools = new Set<string>();
	private currentSessionId: string | null = null;
	private currentSessionLabel: string | null = null;
	private messageSeq = 0;
	private lastMcpStatus: McpServerStatus[] | null = null;
	private probing = false;
	private agentCwd: string | undefined;
	private agentMode: "cwd" | "context" = "cwd";
	private allowedAgentRealPaths: string[] = [];
	private turnRecaps!: boolean;
	private recapModel!: string;
	// Slice A: re-entrant runQuery. Concurrent calls (typed-while-running) are
	// queued FIFO and drained serially. State stays "running" until the queue
	// fully drains.
	private turnQueue = new SessionTurnQueue<RunQueryArgs>();
	private isDraining = false;
	// Slice B: long-lived AgentSession per chat. Cached by chat-scoped key so
	// consecutive turns reuse one provider.query() invocation. Tear down on
	// chat switch / clearHistory / abort.
	private agentSession: AgentSession | null = null;
	private agentSessionKey: string | null = null;
	// Slice C: turn id of the currently running turn — threaded into the
	// emitted `done` event so clients can correlate completions to specific
	// submissions (and pop their queue display FIFO by id).
	private currentTurnId: string | undefined;
	// Auto-sleep: last emitted "sleeping" message, kept for sync replay so a
	// reconnecting client sees the banner. Cleared on wake/abort.
	private sleepState: AgentSleepMessage | null = null;

	constructor(config: HlidConfig, providers: Map<string, AgentProvider>) {
		this.providers = providers;
		this.applyConfig(config);
	}

	/**
	 * Resolves the provider to use for a given agentCwd. If agentCwd is set,
	 * looks up the provider mapped for that path; otherwise uses the vault
	 * provider. Falls back to the first provider in the map if the resolved id
	 * is not found.
	 */
	private resolveProvider(agentCwd?: string): AgentProvider {
		let providerId: string;
		if (agentCwd) {
			providerId = this.agentProviderMap.get(agentCwd) ?? this.vaultProviderId;
		} else {
			providerId = this.vaultProviderId;
		}
		return (
			this.providers.get(providerId) ??
			this.providers.values().next().value ??
			(() => {
				throw new Error(`No providers registered`);
			})()
		);
	}

	/** Apply runtime settings from config. Shared by constructor, reinitialize, and syncConfig. */
	private applyConfig(config: HlidConfig): void {
		this.vaultPath = config.vault.path || process.env.HOME || "/";
		this.vaultProviderId = config.vault_provider ?? "claude";
		const codexConfig = config.codex ?? {
			model: "",
			effort: "medium" as const,
			permission_mode: "default" as const,
			turn_recaps: true,
		};
		const providerDefaults =
			this.vaultProviderId === "codex" ? codexConfig : config.claude;
		this.model = providerDefaults.model;
		this.effort = providerDefaults.effort;
		this.maxTurns = providerDefaults.max_turns;
		this.permissionMode = providerDefaults.permission_mode;
		this.turnRecaps = providerDefaults.turn_recaps ?? true;
		this.recapModel =
			providerDefaults.recap_model ??
			(this.vaultProviderId === "codex" ? "" : "claude-haiku-4-5");
		this.claudeExecutable = resolveClaudeExecutable();
		this.codexExecutable = codexConfig.executable;
		this.allowedAgentRealPaths = computeAllowedAgentRealPaths(config);
		const agentMaps = buildAgentMaps(config);
		this.agentProviderMap = agentMaps.providers;
		this.agentSettingsMap = agentMaps.settings;
	}

	reinitialize(config: HlidConfig): void {
		this.abort();
		this.applyConfig(config);
		this.state = "idle";
		this.currentSessionId = null;
		this.currentSessionLabel = null;
		this.providerSessionId = null;
		this.providerSessionProviderId = null;
		this.messageSeq = 0;
		this.sessionAllowedTools.clear();
		db.clearCurrentSessionId().catch((e) =>
			logDbError("clearCurrentSessionId", e),
		);
	}

	// Lightweight config refresh — updates runtime settings without resetting
	// session history or conversation continuity. Safe to call when idle.
	// Returns true if the model changed (so callers can broadcast a status update).
	syncConfig(config: HlidConfig): boolean {
		const providerId = config.vault_provider ?? "claude";
		const codexConfig = config.codex ?? {
			model: "",
			effort: "medium" as const,
			permission_mode: "default" as const,
			turn_recaps: true,
		};
		const providerDefaults =
			providerId === "codex" ? codexConfig : config.claude;
		const modelChanged = this.model !== providerDefaults.model;
		this.applyConfig(config);
		return modelChanged;
	}

	getStatus(): {
		state: SessionState;
		model: string;
		permission_mode: PermissionMode;
	} {
		return {
			state: this.state,
			model: this.model,
			permission_mode: this.permissionMode,
		};
	}

	/**
	 * Mid-session model switch (Chunk 6). Session-scoped: updates the field
	 * `runOneTurn` reads for vault chats and delegates to the live
	 * AgentSession (if one exists) so the change is effective starting with
	 * the very next turn instead of waiting for a fresh session. No-op on
	 * providers whose AgentSession doesn't implement setModel (e.g. codex's
	 * setModel always exists, but a future provider might not).
	 * `undefined` resets to the provider default (mirrors the SDK's own
	 * setModel(model?: string) semantics).
	 */
	async setModel(model?: string): Promise<void> {
		this.model = model ?? "";
		await this.agentSession?.setModel?.(model);
	}

	/**
	 * Mid-session permission-mode switch (Chunk 6). Validates against the
	 * known modes before mutating any state — an invalid mode throws rather
	 * than silently no-op'ing so the caller (wsHandlers) can surface a clear
	 * error to the client. Session-scoped like setModel: updates the field
	 * `runOneTurn` reads and delegates to the live AgentSession so the
	 * change applies starting with the next turn.
	 */
	async setPermissionMode(mode: string): Promise<void> {
		if (!KNOWN_PERMISSION_MODES.has(mode)) {
			throw new Error(`Unknown permission mode: ${mode}`);
		}
		this.permissionMode = mode as PermissionMode;
		await this.agentSession?.setPermissionMode?.(mode);
	}

	/**
	 * Account info for this session's live AgentSession, or null when there
	 * isn't one (idle session, or the active provider doesn't expose
	 * accountInfo — e.g. codex). Never spawns a session to answer this.
	 */
	async getAccountInfo(): Promise<ProviderAccountInfo | null> {
		if (!this.agentSession?.accountInfo) return null;
		try {
			return await this.agentSession.accountInfo();
		} catch {
			return null;
		}
	}

	getCurrentSessionId(): string | null {
		return this.currentSessionId;
	}

	getSessionLabel(): string | null {
		return this.currentSessionLabel;
	}

	/** Sync the in-memory label after a DB rename so live status shows it. */
	setSessionLabel(label: string): void {
		this.currentSessionLabel = label;
	}

	getLastMcpStatus(): McpServerStatus[] | null {
		return this.lastMcpStatus;
	}

	restoreMcpStatus(statuses: McpServerStatus[]): void {
		this.lastMcpStatus = statuses;
	}

	private async runProbe(
		inspect: (session: AgentSession) => Promise<void>,
	): Promise<void> {
		if (this.probing || this.state === "running") return;
		this.probing = true;
		const ac = new AbortController();
		const timeout = setTimeout(() => ac.abort(), 30_000);
		try {
			const provider = this.resolveProvider();
			const session = provider.query({
				cwd: this.vaultPath,
				signal: ac.signal,
				permissionMode: "default",
				effort: "low",
				maxTurns: 1,
				persistSession: false,
				settingSources: ["user", "project"],
				executable:
					provider.providerId === "claude"
						? this.claudeExecutable
						: this.codexExecutable,
				canUseTool: () =>
					Promise.resolve({ behavior: "deny" as const, message: "probe" }),
			});
			if (provider.probeRequiresTurn) {
				await session.send(".");
				for await (const _ of session) {
					await inspect(session);
					break;
				}
			} else {
				await inspect(session);
			}
			session.cancel();
		} catch {
			// Abort errors are expected when a probe reaches its time limit.
		} finally {
			clearTimeout(timeout);
			this.probing = false;
		}
	}

	async probeMcpStatus(emit: (msg: ServerMessage) => void): Promise<void> {
		await this.runProbe(async (session) => {
			const statuses = (await session.mcpServerStatus?.()) ?? [];
			this.lastMcpStatus = statuses;
			emit({ type: "mcp_status", servers: statuses.map(mapMcpServer) });
		});
	}

	async probeSlashCommands(emit: (msg: ServerMessage) => void): Promise<void> {
		await this.runProbe(async (session) => {
			const commands = (await session.supportedCommands?.()) ?? [];
			emit({ type: "slash_commands", commands });
		});
	}

	isRunning(): boolean {
		return this.state === "running";
	}

	abort(): void {
		this.unregisterUmbodApprovalSession?.();
		this.unregisterUmbodApprovalSession = null;
		this.permissions.clearAll();
		this.askUserQuestions.clearAll();
		this.planModeManager.clearAll();
		// Drop queued turns so abort cancels everything in flight, not just
		// the currently running turn.
		this.turnQueue.resolveAll();
		this.abortController?.abort();
		// Slice B: tear down the long-lived AgentSession so the next runQuery
		// rebuilds the SDK stream from scratch.
		this.agentSession?.cancel();
		this.agentSession = null;
		this.agentSessionKey = null;
	}

	handlePermissionResponse(
		id: string,
		approved: boolean,
		saveScope?: "session" | "local",
		denyMessage?: string,
	): void {
		this.permissions.complete(id, approved, saveScope, denyMessage);
	}

	getPendingPermissionRequests(): Extract<
		ServerMessage,
		{ type: "permission_request" }
	>[] {
		return this.permissions.getPending();
	}

	getPendingAskUserQuestions(): Extract<
		ServerMessage,
		{ type: "ask_user_question" }
	>[] {
		return this.askUserQuestions.getPending();
	}

	handleAskUserQuestionResponse(
		id: string,
		answers: AskUserQuestionAnswers,
		notes?: AskUserQuestionNotes,
	): void {
		this.askUserQuestions.complete(id, answers, notes);
	}

	handlePlanModeExitResponse(
		id: string,
		decision: "approved" | "edited" | "cancelled",
		feedback?: string,
	): void {
		this.planModeManager.complete(id, decision, feedback);
	}

	getPendingPlanModeExits(): Extract<
		ServerMessage,
		{ type: "plan_mode_exit" }
	>[] {
		return this.planModeManager.getPending();
	}

	clearHistory(): void {
		this.unregisterUmbodApprovalSession?.();
		this.unregisterUmbodApprovalSession = null;
		this.currentSessionId = null;
		this.currentSessionLabel = null;
		this.providerSessionId = null;
		this.providerSessionProviderId = null;
		this.messageSeq = 0;
		this.agentCwd = undefined;
		this.agentMode = "cwd";
		this.sessionAllowedTools.clear();
		this.askUserQuestions.clearAll();
		this.planModeManager.clearAll();
		// Drop any queued (not-yet-started) turns silently.
		this.turnQueue.resolveAll();
		// Slice B: tear down the AgentSession (cancels any running turn) so the
		// next runQuery starts a fresh SDK stream for the new chat.
		this.agentSession?.cancel();
		this.agentSession = null;
		this.agentSessionKey = null;
		db.clearCurrentSessionId().catch((e) =>
			logDbError("clearCurrentSessionId", e),
		);
	}

	/**
	 * Switches to the given session (loading saved state from DB) and resolves
	 * the agent cwd. Creates the session row when this is the first message.
	 * Must run before buildPrompt so messageSeq, agentCwd, and agentMode are
	 * correct for the turn.
	 */
	private async initSessionContext(
		sessionId: string | undefined,
		agentCwd: string | undefined,
		userMessage: string,
	): Promise<void> {
		if (sessionId && sessionId !== this.currentSessionId) {
			this.agentCwd = undefined;
			this.agentMode = "cwd";
			this.sessionAllowedTools.clear();
			const [prior, savedAgentCwd, savedProviderId, savedProviderSessionId] =
				await Promise.all([
					db.getSessionMessages(sessionId),
					db.getSessionAgentCwd(sessionId),
					db.getSessionProviderId(sessionId),
					db.getSessionProviderSession(sessionId),
				]);
			this.messageSeq = prior.length;
			this.currentSessionId = sessionId;
			this.providerSessionId = savedProviderSessionId;
			this.providerSessionProviderId = savedProviderId;
			if (savedAgentCwd) {
				this.agentCwd = savedAgentCwd;
				this.agentMode = resolveAgentMode(savedAgentCwd);
			}
			db.setCurrentSessionId(sessionId).catch((e) =>
				logDbError("setCurrentSessionId", e),
			);
		}

		// Set agent dir + mode on first message of an agent session (in-memory).
		// Registration is gated by allow_external_agents at save time; here we
		// just confirm the path still matches a registered agent before locking
		// it onto the session. Mode is locked once and survives until session end.
		if (agentCwd && !this.agentCwd) {
			try {
				this.allowedAgentRealPaths = computeAllowedAgentRealPaths(loadConfig());
				const realAgent = realpathSync(expandTilde(agentCwd));
				if (isAllowedAgentPath(this.allowedAgentRealPaths, realAgent)) {
					this.agentCwd = realAgent;
					this.agentMode = resolveAgentMode(realAgent);
				}
			} catch {
				// path doesn't exist or symlink cycle, deny
			}
		}

		// Create DB session record for new sessions
		if (sessionId && this.messageSeq === 0) {
			const label = userMessage.slice(0, SESSION_LABEL_LENGTH).toUpperCase();
			this.currentSessionLabel = label;
			await db.createSession(sessionId, label, this.model);
		}

		// Persist agent cwd after session row exists
		if (this.agentCwd && sessionId && agentCwd) {
			db.setSessionAgentCwd(sessionId, this.agentCwd).catch((e) => {
				console.error("[session] setSessionAgentCwd failed:", e);
			});
		}
	}

	/** Handle session_start: capture and persist the provider session ID. */
	private handleSessionStart(
		event: Extract<AgentEvent, { type: "session_start" }>,
		sessionId: string | undefined,
		provider: AgentProvider,
		emit: (msg: ServerMessage) => void,
	): void {
		const newId = event.sessionId;
		// Always update on every session_start — the provider may reassign on
		// compaction/fork, and we want the latest valid id persisted for the next
		// turn's resume.
		if (newId) {
			if (newId !== this.providerSessionId) {
				this.providerSessionId = newId;
				this.providerSessionProviderId = provider.providerId;
				if (sessionId) {
					void db
						.setSessionProviderSession(sessionId, provider.providerId, newId)
						.catch((e) => logDbError("setSessionProviderSession", e));
				}
			}
			this.unregisterUmbodApprovalSession?.();
			this.unregisterUmbodApprovalSession = registerUmbodApprovalSession(
				newId,
				(call, reason) =>
					this.promptForHookApproval(call, reason, provider, emit),
			);
		}
	}

	private promptForHookApproval(
		call: ToolCall,
		reason: string,
		provider: AgentProvider,
		emit: (msg: ServerMessage) => void,
	): Promise<"allow" | "block"> {
		const toolUseID = call.toolUseId ?? `umbod-${Date.now()}`;
		const toolName = call.tool;
		const request = {
			type: "permission_request" as const,
			id: toolUseID,
			toolName,
			title: `${provider.label ?? provider.providerId} wants to use ${toolName}`,
			description: reason,
			input: call.inputs,
		};
		return new Promise((finish) => {
			if (this.sessionAllowedTools.has(toolName)) {
				finish("allow");
				return;
			}
			this.permissions.register(toolUseID, request, (approved, saveScope) => {
				if (approved && saveScope === "session")
					this.sessionAllowedTools.add(toolName);
				if (approved && saveScope === "local") {
					try {
						persistAlwaysAllowedTool(
							call.workingDirectory ?? this.vaultPath,
							toolName,
						);
					} catch (error) {
						console.error(
							"[session] failed to write always-allow rule:",
							error,
						);
					}
				}
				finish(approved ? "allow" : "block");
			});
			emit(request);
		});
	}

	/** Handle rate_limit event: emit and persist utilization to DB settings. */
	private handleRateLimit(
		event: Extract<AgentEvent, { type: "rate_limit" }>,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): void {
		const providerId = provider.providerId;
		// The Claude Agent SDK emits "seven_day" / "seven_day_sonnet" but hlid
		// uses "weekly" / "weekly_sonnet" as canonical window IDs everywhere
		// (DB settings keys, providerWindows map, applyRateLimitToSnapshot).
		// Translate here so the rest of the system sees consistent names.
		const SDK_TO_WINDOW_ID: Record<string, string> = {
			five_hour: "five_hour",
			seven_day: "weekly",
			seven_day_sonnet: "weekly_sonnet",
		};
		const windowId = event.rateLimitType
			? (SDK_TO_WINDOW_ID[event.rateLimitType] ?? event.rateLimitType)
			: undefined;
		emit({
			type: "rate_limit",
			status: event.status,
			rateLimitType: windowId,
			utilization: event.utilization,
			resetsAt: event.resetsAt as number | undefined,
			providerId,
		});
		// Feed the auto-sleep gate before the utilization guard below — a hard
		// rejection can arrive without a utilization reading.
		reportRateLimitSignal(
			providerId,
			windowId,
			event.status,
			event.resetsAt ?? null,
			loadConfig()?.auto_sleep,
		);
		// Persist for usage windows display, skip if utilization is null
		// (proxy server writes the authoritative value from API response headers)
		if (event.utilization != null && windowId) {
			void db.saveSetting(
				`rl_${providerId}_${windowId}`,
				JSON.stringify({
					utilization: event.utilization,
					resetsAt: event.resetsAt ?? null,
					windowId,
				}),
			);
			// Mirror into the in-memory high-water mark so /db/usage-windows
			// overlay reflects live values immediately (not just on next cold start).
			updateWindowMark(
				providerId,
				windowId,
				event.utilization,
				event.resetsAt ?? null,
			);
		}
	}

	private async persistAssistantMessage(
		sessionId: string,
		turn: TurnState,
	): Promise<number> {
		const reused = turn.reservedAssistantSeq != null;
		const assistantSeq = turn.reservedAssistantSeq ?? this.messageSeq++;
		if (turn.textWriteTimer) {
			clearTimeout(turn.textWriteTimer);
			turn.textWriteTimer = null;
		}
		turn.textWriteDirty = false;
		if (reused) {
			await db.setMessageText(sessionId, assistantSeq, turn.assistantText);
		} else {
			await db.appendMessage(
				sessionId,
				assistantSeq,
				"assistant",
				turn.assistantText,
			);
		}
		return assistantSeq;
	}

	private persistPendingToolEvents(
		sessionId: string,
		assistantSeq: number,
		turn: TurnState,
		operationSuffix: string,
	): void {
		for (const toolEvent of turn.pendingToolEvents) {
			const result = turn.pendingToolResults.get(toolEvent.toolId);
			if (turn.persistedToolIds.has(toolEvent.toolId)) {
				if (result) {
					db.setToolEventResult(
						sessionId,
						toolEvent.toolId,
						result.content,
						result.isError,
					).catch((error) =>
						logDbError(`setToolEventResult (${operationSuffix})`, error),
					);
				}
				continue;
			}
			db.appendToolEvent(
				sessionId,
				assistantSeq,
				toolEvent.toolId,
				toolEvent.name,
				toolEvent.input,
			)
				.then(() => {
					if (result) {
						return db.setToolEventResult(
							sessionId,
							toolEvent.toolId,
							result.content,
							result.isError,
						);
					}
				})
				.catch((error) =>
					logDbError(`appendToolEvent (${operationSuffix})`, error),
				);
		}
	}

	/** Handle done event: persist query + assistant message to DB, emit done. */
	private async handleDone(
		event: Extract<AgentEvent, { type: "done" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): Promise<void> {
		const { primaryModel, tokensInContext, queryData } = buildQueryData(
			event,
			turn,
		);
		if (sessionId) {
			await db.recordQuery(sessionId, queryData, provider.providerId);
			if (turn.lastActualModel) {
				db.setSessionActualModel(sessionId, turn.lastActualModel).catch((e) => {
					console.error("[db] setSessionActualModel failed:", e);
				});
			}
			if (turn.assistantText) {
				turn.lastAssistantText = turn.assistantText;
				const assistantSeq = await this.persistAssistantMessage(
					sessionId,
					turn,
				);
				turn.lastAssistantSeq = assistantSeq;
				this.persistPendingToolEvents(sessionId, assistantSeq, turn, "done");
				turn.lastTurnToolEvents = [...turn.pendingToolEvents];
				turn.pendingToolEvents.length = 0;
				turn.pendingToolResults.clear();
				turn.persistedToolIds.clear();
				turn.reservedAssistantSeq = null;
				turn.assistantText = "";
			}
		}
		emit({
			type: "done",
			session_id: sessionId,
			...(this.currentTurnId !== undefined
				? { turn_id: this.currentTurnId }
				: {}),
			cost: event.cost ?? null,
			turns: event.turns,
			duration_ms: event.durationMs,
			input_tokens: queryData.input_tokens,
			output_tokens: queryData.output_tokens,
			cache_read_tokens: queryData.cache_read_tokens,
			cache_creation_tokens: queryData.cache_creation_tokens,
			context_window: queryData.context_window ?? DEFAULT_CONTEXT_WINDOW,
			max_output_tokens: primaryModel?.maxOutputTokens ?? null,
			stop_reason: queryData.stop_reason,
			tokens_in_context: tokensInContext,
		});
	}

	/**
	 * Processes the provider AgentEvent stream for one query, updating
	 * turn state in place.
	 */
	/**
	 * Schedule a throttled DB write of the accumulated assistant text. Called on
	 * every text_delta. The first chunk after an idle window starts a 150ms
	 * timer; subsequent chunks within the window mark the row dirty without
	 * rescheduling. When the timer fires, the *current* (latest) text is
	 * written, so coalesced chunks land in a single UPDATE.
	 */
	private scheduleTextWrite(turn: TurnState, sessionId: string): void {
		const seq = turn.reservedAssistantSeq;
		if (seq == null) return;
		turn.textWriteDirty = true;
		if (turn.textWriteTimer) return;
		turn.textWriteTimer = setTimeout(() => {
			turn.textWriteTimer = null;
			turn.textWriteDirty = false;
			void db
				.setMessageText(sessionId, seq, turn.assistantText)
				.catch((e) => logDbError("setMessageText (live)", e));
		}, TEXT_WRITE_THROTTLE_MS);
	}

	/**
	 * Allocate the assistant message seq + insert an empty placeholder row on
	 * first call. Subsequent calls return the same seq. Used by text_delta and
	 * tool_start so live writes (text streaming, tool_event inserts) attach to
	 * a real row that mid-turn reloads can render.
	 */
	private ensureAssistantRow(turn: TurnState, sessionId: string): number {
		if (turn.reservedAssistantSeq != null) return turn.reservedAssistantSeq;
		const seq = this.messageSeq++;
		turn.reservedAssistantSeq = seq;
		void db
			.appendMessage(sessionId, seq, "assistant", "")
			.catch((e) => logDbError("appendMessage (placeholder)", e));
		return seq;
	}

	private handleTextDelta(
		event: Extract<AgentEvent, { type: "text_delta" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): void {
		const text =
			turn.lastBlockType === "tool_use" &&
			event.text &&
			!event.text.startsWith("\n")
				? `\n\n${event.text}`
				: event.text;
		turn.assistantText += text;
		emit({ type: "chunk", text });
		if (sessionId) {
			this.ensureAssistantRow(turn, sessionId);
			this.scheduleTextWrite(turn, sessionId);
		}
		turn.lastBlockType = "text";
	}

	private handleToolStart(
		event: Extract<AgentEvent, { type: "tool_start" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): void {
		turn.hadToolEvents = true;
		if (event.name === "ExitPlanMode") {
			turn.lastBlockType = "tool_use";
			return;
		}
		turn.pendingToolEvents.push({
			toolId: event.toolId,
			name: event.name,
			input: event.input,
		});
		emit({
			type: "tool_event",
			id: event.toolId,
			name: event.name,
			input: event.input,
		});
		if (sessionId) {
			const seq = this.ensureAssistantRow(turn, sessionId);
			const toolId = event.toolId;
			void db
				.appendToolEvent(sessionId, seq, toolId, event.name, event.input)
				.then(() => turn.persistedToolIds.add(toolId))
				.catch((e) => logDbError("appendToolEvent (live)", e));
		}
		turn.lastBlockType = "tool_use";
	}

	private handleToolResult(
		event: Extract<AgentEvent, { type: "tool_result" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): void {
		emit({
			type: "tool_result",
			id: event.toolId,
			content: event.content,
			...(event.isError ? { isError: true } : {}),
		});
		turn.pendingToolResults.set(event.toolId, {
			content: event.content,
			isError: event.isError === true,
		});
		if (sessionId && turn.persistedToolIds.has(event.toolId)) {
			void db
				.setToolEventResult(
					sessionId,
					event.toolId,
					event.content,
					event.isError === true,
				)
				.catch((e) => logDbError("setToolEventResult (live)", e));
		}
	}

	private handleUsage(
		event: Extract<AgentEvent, { type: "usage" }>,
		turn: TurnState,
		emit: (msg: ServerMessage) => void,
	): void {
		const cacheRead = event.cacheReadTokens ?? 0;
		const cacheCreation = event.cacheCreationTokens ?? 0;
		turn.lastTurnUsage = {
			input_tokens: event.inputTokens,
			cache_read_input_tokens: event.cacheReadTokens,
			cache_creation_input_tokens: event.cacheCreationTokens,
		};
		turn.lastActualModel = event.model ?? null;
		if (event.contextWindow) turn.lastKnownContextWindow = event.contextWindow;
		emit({
			type: "usage_update",
			input_tokens: event.inputTokens,
			output_tokens: event.outputTokens,
			cache_read_tokens: cacheRead,
			cache_creation_tokens: cacheCreation,
			tokens_in_context: event.inputTokens + cacheRead + cacheCreation,
			actualModel: event.model,
			context_window: turn.lastKnownContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		});
	}

	private async handleConversationEvent(
		event: AgentEvent,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		turn: TurnState,
		provider: AgentProvider,
	): Promise<boolean> {
		switch (event.type) {
			case "session_start":
				this.handleSessionStart(event, sessionId, provider, emit);
				break;
			case "text_delta":
				this.handleTextDelta(event, turn, sessionId, emit);
				break;
			case "tool_start":
				this.handleToolStart(event, turn, sessionId, emit);
				break;
			case "tool_result":
				this.handleToolResult(event, turn, sessionId, emit);
				break;
			case "usage":
				this.handleUsage(event, turn, emit);
				break;
			case "summary":
				turn.sdkSummary = event.text;
				emit({ type: "tool_use_summary", summary: event.text });
				break;
			case "rate_limit":
				this.handleRateLimit(event, emit, provider);
				break;
			case "local_command_output":
				emit({ type: "local_command_output", content: event.content });
				break;
			case "mcp_status":
				this.lastMcpStatus = event.servers;
				emit({ type: "mcp_status", servers: event.servers.map(mapMcpServer) });
				break;
			case "done":
				await this.handleDone(event, turn, sessionId, emit, provider);
				return true;
		}
		return false;
	}

	private async iterateConversation(
		session: AgentSession,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		turn: TurnState,
		provider: AgentProvider,
	): Promise<void> {
		let mcpChecked = false;
		for await (const event of session) {
			turn.receivedAny = true;
			if (!mcpChecked) {
				mcpChecked = true;
				if (session.mcpServerStatus) {
					void session
						.mcpServerStatus()
						.then((statuses) => {
							this.lastMcpStatus = statuses;
							emit({ type: "mcp_status", servers: statuses.map(mapMcpServer) });
						})
						.catch(() => {});
				}
			}
			if (event.type === "done") {
				await this.refreshProviderUsage(session, provider);
			}
			if (
				await this.handleConversationEvent(
					event,
					sessionId,
					emit,
					turn,
					provider,
				)
			)
				return;
		}
	}

	/**
	 * Submit a turn. Re-entrant: if a turn is already running, this call queues
	 * behind it and resolves when *its* turn completes. Status stays "running"
	 * across queued turns and only flips to "idle" when the queue is fully
	 * drained (mirrors CLI behavior — typed-while-running messages are accepted
	 * and processed at the next turn boundary).
	 */
	async runQuery(...args: RunQueryArgs): Promise<void> {
		const completion = this.turnQueue.enqueue(args, args[6]);
		if (!this.isDraining) void this.drainTurnQueue();
		return completion;
	}

	/**
	 * Slice C: drop a not-yet-started turn from the queue. Returns true if a
	 * matching pending turn was found and removed (its promise resolves
	 * silently). Returns false if the turn id is unknown OR refers to the
	 * currently running turn (which has already been shifted off the queue
	 * — use abort() to stop it instead).
	 */
	/**
	 * Slice C polish: snapshot of the server's queue state. Used by clients
	 * (on connect / sync) to prune orphan chatQueue entries — e.g. items
	 * that were _sent before a server restart and have no matching QueuedTurn
	 * anymore.
	 */
	getQueueState(): {
		pending_turn_ids: string[];
		running_turn_id: string | null;
	} {
		return {
			pending_turn_ids: this.turnQueue.pendingTurnIds(),
			running_turn_id:
				this.state === "running" ? (this.currentTurnId ?? null) : null,
		};
	}

	cancelQueued(turnId: string): boolean {
		return this.turnQueue.cancel(turnId);
	}

	/**
	 * Slice C: move a queued turn to the head of the queue and interrupt the
	 * currently running turn so the promoted msg runs next. Returns false if
	 * the turn id is unknown OR refers to the running turn (already shifted
	 * off the queue). The current turn's partial output is preserved by the
	 * SDK's interrupt mechanism — the promoted turn runs as a fresh user msg
	 * in the same session.
	 */
	promoteQueued(turnId: string): boolean {
		if (!this.turnQueue.promote(turnId)) return false;
		// Interrupt current — drain loop's await iterateConversation returns,
		// drain proceeds to the next queue head (the promoted turn).
		void this.agentSession?.interrupt?.();
		return true;
	}

	private async drainTurnQueue(): Promise<void> {
		if (this.isDraining) return;
		this.isDraining = true;

		// Initialize the abortController once for the whole drain. Status
		// running is emitted PER ITERATION below (with turn_id) so the client
		// can distinguish "queued behind" from "currently running."
		const head = this.turnQueue.peek();
		if (head && this.state !== "running") {
			this.state = "running";
			this.abortController = new AbortController();
		}

		let lastEmit: ((msg: ServerMessage) => void) | null = null;
		try {
			while (this.turnQueue.length > 0) {
				const next = this.turnQueue.shift();
				if (!next) break;
				// Recover from a prior turn's error so the next queued turn runs
				// cleanly. Per-turn errors are already signaled to the UI via the
				// "error" event emitted from runOneTurn.
				if (this.state === "error") this.state = "running";
				lastEmit = next.args[1];
				try {
					await this.runOneTurn(...next.args);
					next.resolve();
				} catch (err) {
					next.reject(err instanceof Error ? err : new Error(String(err)));
				}
			}
		} finally {
			this.isDraining = false;
			this.abortController = null;
			// Settle final state. Per-turn errors set state="error" via the
			// runOneTurn catch; preserve that. Otherwise return to idle.
			if (this.state === "running") this.state = "idle";
			lastEmit?.({
				type: "status",
				state: this.state,
				model: this.model,
				permission_mode: this.permissionMode,
			});
		}
	}

	/**
	 * Auto-sleep gate. Blocks while the provider's five_hour window is at the
	 * configured threshold (or hard-limited) and auto_sleep is enabled, waking
	 * at the window reset, on "resume now", or on abort. Emits agent_sleep
	 * transitions and tracks sleepState for sync replay.
	 *
	 * Known limitation: with Umbod disabled AND permission_mode
	 * bypassPermissions, providers never call canUseTool (claude sets
	 * allowDangerouslySkipPermissions; codex auto-approves server requests), so
	 * only the turn-boundary gate applies there. With Umbod enabled every tool
	 * routes through canUseTool and both gates hold.
	 */
	private async gateOnUsage(
		provider: AgentProvider,
		emit: (msg: ServerMessage) => void,
	): Promise<"proceeded" | "aborted"> {
		const cfg = loadConfig()?.auto_sleep;
		if (!cfg?.enabled) return "proceeded";
		const providerId = provider.providerId;
		return sleepUntilAllowed({
			providerId,
			cfg,
			signal: this.abortController?.signal ?? undefined,
			onSleep: (decision: SleepDecision) => {
				const message: AgentSleepMessage = {
					type: "agent_sleep",
					state: "sleeping",
					providerId,
					windowId: decision.windowId,
					until: decision.until,
					reason: decision.reason,
					...(decision.utilization != null
						? { utilization: decision.utilization }
						: {}),
					...(this.currentSessionId
						? { session_id: this.currentSessionId }
						: {}),
				};
				this.sleepState = message;
				emit(message);
			},
			onWake: (cause) => {
				this.sleepState = null;
				emit({
					type: "agent_sleep",
					state: "resumed",
					providerId,
					cause,
					...(this.currentSessionId
						? { session_id: this.currentSessionId }
						: {}),
				});
			},
		});
	}

	/** "Resume now": wake every session sleeping on this session's provider. */
	skipSleep(): void {
		skipProviderSleep(this.resolveProvider(this.agentCwd).providerId);
	}

	/** Pending sleep banner for sync replay, or null when not sleeping. */
	getSleepState(): AgentSleepMessage | null {
		return this.sleepState;
	}

	private createToolPermissionHandler(
		provider: AgentProvider,
		activeCwd: string,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): CanUseTool {
		return (toolName, input, { toolUseID, title, displayName, description }) =>
			new Promise((resolve) => {
				const passInput = input as Record<string, unknown>;
				if (toolName === "AskUserQuestion") {
					this.interceptAskUserQuestion(
						passInput,
						toolUseID,
						title,
						sessionId,
						emit,
						resolve,
					);
					return;
				}
				if (this.isPreApprovedPlanWrite(toolName, passInput)) {
					resolve({ behavior: "allow", updatedInput: passInput });
					return;
				}
				if (toolName === "ExitPlanMode") {
					this.interceptExitPlanMode(
						passInput,
						toolUseID,
						sessionId,
						emit,
						resolve,
					);
					return;
				}
				this.resolveToolPermission({
					provider,
					activeCwd,
					sessionId,
					emit,
					toolName,
					toolUseID,
					title,
					displayName,
					description,
					passInput,
					resolve,
				});
			});
	}

	/** AskUserQuestion never shows a permission card: persist the questions, emit the modal, and resolve with the user's answers merged into the tool input. */
	private interceptAskUserQuestion(
		passInput: Record<string, unknown>,
		toolUseID: string,
		title: string | undefined,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		resolve: (decision: AgentToolDecision) => void,
	): void {
		const { questions } = parseAskUserQuestion(passInput, title);
		const request = {
			type: "ask_user_question" as const,
			id: toolUseID,
			questions,
		};
		if (sessionId) {
			void db
				.appendAskUserQuestion(
					sessionId,
					toolUseID,
					this.messageSeq++,
					JSON.stringify(questions),
				)
				.catch((error) => logDbError("appendAskUserQuestion", error));
		} else {
			this.messageSeq++;
		}
		this.askUserQuestions.register(toolUseID, request, (answers, notes) => {
			const existing = (passInput.answers as Record<string, string>) ?? {};
			const sdkAnswers: Record<string, string> = { ...existing };
			for (const [question, picks] of Object.entries(answers)) {
				const note = notes?.[question]?.trim();
				sdkAnswers[question] = note
					? `${picks.join(", ")}\n\nNotes: ${note}`
					: picks.join(", ");
			}
			resolve({
				behavior: "allow",
				updatedInput: { ...passInput, answers: sdkAnswers },
			});
		});
		emit(request);
	}

	/**
	 * Plan-mode HTML handoff: the agent is instructed to write its plan
	 * document to exactly this.planHtmlPath, so that one write is
	 * pre-approved (plan mode otherwise routes writes through the
	 * permission card).
	 */
	private isPreApprovedPlanWrite(
		toolName: string,
		passInput: Record<string, unknown>,
	): boolean {
		return Boolean(
			this.planHtmlPath &&
				(toolName === "Write" || toolName === "Edit") &&
				typeof passInput.file_path === "string" &&
				(resolvePath(passInput.file_path) === this.planHtmlPath ||
					passInput.file_path === toLogical(this.planHtmlPath)),
		);
	}

	/** ExitPlanMode becomes a plan proposal: ingest the HTML artifact, persist the proposal, and resolve allow/deny from the user's decision on the plan card. */
	private interceptExitPlanMode(
		passInput: Record<string, unknown>,
		toolUseID: string,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		resolve: (decision: AgentToolDecision) => void,
	): void {
		const planText =
			typeof passInput.plan === "string"
				? passInput.plan
				: JSON.stringify(passInput.plan ?? "");
		const planSeq = this.messageSeq++;
		// Keep Raven visibly active while the HTML artifact is validated,
		// copied, linked, and persisted before the proposal can be shown.
		this.emitRunningStatus(emit);
		void (async () => {
			let htmlRelicId: string | null = null;
			if (this.planHtmlPath && this.planHtmlStorageRoot && sessionId) {
				htmlRelicId = await ingestPlanHtml({
					sourcePath: this.planHtmlPath,
					plansDir: resolvePath(this.planHtmlStorageRoot, ".hlid", "plans"),
					storageRoot: this.planHtmlStorageRoot,
					sessionId,
					planSeq,
					maxBytes: loadConfig().attachments.max_bytes,
				});
			}
			const request = {
				type: "plan_mode_exit" as const,
				id: toolUseID,
				input: passInput,
				...(htmlRelicId ? { html_relic_id: htmlRelicId } : {}),
			};
			if (sessionId) {
				void db
					.appendPlanProposal(
						sessionId,
						toolUseID,
						planSeq,
						planText,
						"pending",
						htmlRelicId,
					)
					.catch((error) => logDbError("appendPlanProposal", error));
			}
			this.planModeManager.register(
				toolUseID,
				request,
				(decision, feedback) => {
					if (sessionId) {
						void db
							.setPlanProposalDecision(sessionId, toolUseID, decision)
							.catch((error) => logDbError("setPlanProposalDecision", error));
					}
					if (decision === "approved") {
						resolve({ behavior: "allow", updatedInput: passInput });
					} else {
						resolve({
							behavior: "deny",
							message:
								decision === "edited"
									? `User requested changes to the plan:\n\n${feedback ?? ""}`
									: "Plan was cancelled by the user.",
						});
					}
				},
			);
			// Re-broadcast after registration so pool-wide status includes the
			// pending plan interaction before the modal event arrives.
			this.emitRunningStatus(emit);
			if (htmlRelicId) {
				emit({
					type: "attachment_created",
					id: htmlRelicId,
					kind: "ephemeral",
				});
			}
			emit(request);
		})();
	}

	/** Generic tool path: usage gate, then Umbod policy, then (if the policy defers) the interactive permission card. */
	private resolveToolPermission(options: {
		provider: AgentProvider;
		activeCwd: string;
		sessionId: string | undefined;
		emit: (msg: ServerMessage) => void;
		toolName: string;
		toolUseID: string;
		title: string | undefined;
		displayName: string | undefined;
		description: string | undefined;
		passInput: Record<string, unknown>;
		resolve: (decision: AgentToolDecision) => void;
	}): void {
		const {
			provider,
			activeCwd,
			sessionId,
			emit,
			toolName,
			toolUseID,
			title,
			displayName,
			description,
			passInput,
			resolve,
		} = options;
		const request = {
			type: "permission_request" as const,
			id: toolUseID,
			toolName,
			title:
				title ??
				`${provider.label ?? provider.providerId} wants to use ${toolName}`,
			displayName,
			description,
			input: passInput as Record<string, unknown> | undefined,
		};
		let denyMessage: string | undefined;
		const prompt = (reason?: string) =>
			new Promise<"allow" | "block">((finish) => {
				if (this.sessionAllowedTools.has(toolName)) {
					finish("allow");
					return;
				}
				this.permissions.register(
					toolUseID,
					{ ...request, description: reason ?? request.description },
					(approved, saveScope, customDenyMessage) => {
						this.permissions.delete(toolUseID);
						if (!approved) {
							denyMessage = customDenyMessage;
							finish("block");
							return;
						}
						if (saveScope === "session") this.sessionAllowedTools.add(toolName);
						if (saveScope === "local") {
							try {
								persistAlwaysAllowedTool(activeCwd, toolName);
							} catch (error) {
								console.error(
									"[session] failed to write always-allow rule:",
									error,
								);
							}
						}
						finish("allow");
					},
				);
				emit({ ...request, description: reason ?? request.description });
			});

		// Usage gate BEFORE the policy/permission pipeline so no permission
		// card is ever shown into a sleeping session, and any resolution
		// (allow or deny both resume the model = spend) waits for the window.
		void this.gateOnUsage(provider, emit)
			.then((gate) => {
				if (gate === "aborted") {
					resolve({
						behavior: "deny",
						message: "Aborted while sleeping on usage limit",
					});
					return;
				}
				return authorizeHlidTool({
					agent: provider.providerId,
					tool: toolName,
					input: passInput,
					cwd: activeCwd,
					sessionId,
					toolUseId: toolUseID,
					// Once Umbod is enabled it is the policy authority. Provider-level
					// bypassPermissions must not turn an Umbod `approve` decision into a
					// silent allow; the approval still belongs in the originating chat.
					bypassApproval: false,
					prompt: (reason) => prompt(reason),
				}).then(async (policy) => {
					const decision = policy?.decision ?? (await prompt());
					resolve(
						decision === "allow"
							? { behavior: "allow", updatedInput: passInput }
							: {
									behavior: "deny",
									message:
										policy?.policyDecision === "block"
											? policy.reason
											: (denyMessage ?? "Denied by user"),
								},
					);
				});
			})
			.catch((error) => {
				resolve({
					behavior: "deny",
					message: `Umbod policy error: ${error instanceof Error ? error.message : String(error)}`,
				});
			});
	}

	/** Emit the running-status heartbeat for the current turn. */
	private emitRunningStatus(emit: (msg: ServerMessage) => void): void {
		emit({
			type: "status",
			state: "running",
			model: this.model,
			permission_mode: this.permissionMode,
			...(this.currentTurnId !== undefined
				? { turn_id: this.currentTurnId }
				: {}),
		});
	}

	/**
	 * Arm or clear the HTML-plan handoff path for this turn. When armed, the
	 * prompt gains buildPlanHtmlInstructions(path), the Write/Edit permission
	 * handler auto-allows that exact path, and the ExitPlanMode intercept
	 * ingests the file as an ephemeral relic.
	 */
	private syncPlanHtmlPath(
		enabled: boolean,
		sessionId: string | undefined,
	): void {
		if (!enabled || !sessionId) {
			this.planHtmlPath = null;
			this.planHtmlStorageRoot = null;
			return;
		}
		const storageRoot = resolvePath(
			expandTilde(this.agentCwd ?? this.vaultPath),
		);
		const path = resolvePath(
			storageRoot,
			".hlid",
			"plans",
			`plan-${sessionId}.html`,
		);
		if (!pathStartsWith(storageRoot, path)) {
			this.planHtmlPath = null;
			this.planHtmlStorageRoot = null;
			return;
		}
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		} catch (error) {
			console.warn("[session] could not prepare HTML plan directory:", error);
			this.planHtmlPath = null;
			this.planHtmlStorageRoot = null;
			return;
		}
		this.planHtmlPath = path;
		this.planHtmlStorageRoot = storageRoot;
	}

	private async persistUserMessage(
		sessionId: string | undefined,
		userMessage: string,
		attachments: ChatAttachment[],
	): Promise<void> {
		const userSeq = this.messageSeq++;
		if (!sessionId) return;
		await db.appendMessage(sessionId, userSeq, "user", userMessage);
		for (const attachment of attachments) {
			await db
				.linkAttachmentToMessage(attachment.id, sessionId, userSeq)
				.catch((error) => {
					console.error("[session] linkAttachmentToMessage failed:", error);
				});
		}
	}

	private getOrCreateAgentSession(options: {
		provider: AgentProvider;
		sessionId: string | undefined;
		resumeProviderSessionId: string | null;
		activeCwd: string;
		extraDirs: Set<string>;
		executable: string | undefined;
		agentSettings: AgentSettings | undefined;
		planMode: boolean | undefined;
		emit: (msg: ServerMessage) => void;
	}): AgentSession {
		const {
			provider,
			sessionId,
			resumeProviderSessionId,
			activeCwd,
			extraDirs,
			executable,
			agentSettings,
			planMode,
			emit,
		} = options;
		const desiredKey = `${provider.providerId}|${sessionId ?? "ephemeral"}|${this.agentCwd ?? ""}`;
		if (this.agentSession && this.agentSessionKey !== desiredKey) {
			this.agentSession.cancel();
			this.agentSession = null;
			this.agentSessionKey = null;
		}
		if (this.agentSession) return this.agentSession;
		const configuredPermissionMode =
			agentSettings?.permissionMode ?? this.permissionMode;
		const session = provider.query(
			buildAgentQueryParams({
				activeCwd,
				resumeProviderSessionId,
				extraDirs,
				signal: this.abortController?.signal,
				agentSettings,
				defaultModel: this.agentCwd ? undefined : this.model,
				configuredPermissionMode,
				planMode,
				planHtmlPath: this.planHtmlPath,
				defaultEffort: this.effort,
				defaultMaxTurns: this.maxTurns,
				executable,
				canUseTool: this.createToolPermissionHandler(
					provider,
					activeCwd,
					sessionId,
					emit,
				),
			}),
		);
		this.agentSession = session;
		this.agentSessionKey = desiredKey;
		return session;
	}

	private prepareProviderForTurn(sessionId: string | undefined): {
		provider: AgentProvider;
		agentSettings: AgentSettings | undefined;
		resumeProviderSessionId: string | null;
	} {
		const provider = this.resolveProvider(this.agentCwd);
		const agentSettings = this.agentCwd
			? this.agentSettingsMap.get(this.agentCwd)
			: undefined;
		const sameProvider = this.providerSessionProviderId === provider.providerId;
		const resumeProviderSessionId = sameProvider
			? this.providerSessionId
			: null;
		if (!sameProvider) {
			this.providerSessionId = null;
			this.providerSessionProviderId = provider.providerId;
		}
		if (sessionId) {
			void db
				.setSessionProviderId(sessionId, provider.providerId)
				.catch((error) => logDbError("setSessionProviderId", error));
		}
		return { provider, agentSettings, resumeProviderSessionId };
	}

	private scheduleTurnRecap(options: {
		turn: TurnState;
		sessionId: string | undefined;
		userMessage: string;
		emit: (msg: ServerMessage) => void;
		provider: AgentProvider;
		agentSettings: AgentSettings | undefined;
	}): void {
		const { turn, sessionId, userMessage, emit, provider, agentSettings } =
			options;
		if (!turn.hadToolEvents || !this.turnRecaps || !turn.lastAssistantText)
			return;
		const executable =
			provider.providerId === "claude"
				? this.claudeExecutable
				: this.codexExecutable;
		void generateTurnRecap(
			sessionId ?? null,
			turn.lastAssistantSeq,
			userMessage,
			turn.lastTurnToolEvents,
			turn.lastAssistantText,
			emit,
			this.vaultPath,
			executable,
			turn.sdkSummary,
			provider,
			agentSettings?.recapModel ?? this.recapModel,
		).catch(() => {});
	}

	private async refreshProviderUsage(
		agentSession: AgentSession,
		provider: AgentProvider,
	): Promise<void> {
		if (!agentSession.usageWindows) return;
		try {
			const readings = await agentSession.usageWindows();
			await Promise.all(
				readings.map((reading) => applyReading(provider.providerId, reading)),
			);
		} catch {
			// Usage enrichment is best-effort and must never fail an otherwise
			// successful agent turn.
		}
	}

	private async runOneTurn(...args: RunQueryArgs): Promise<void> {
		const [
			userMessage,
			emit,
			sessionId,
			skillContext,
			attachments,
			agentCwd,
			turnId,
			planMode,
			planHtml,
		] = args;
		this.currentTurnId = turnId;
		await this.initSessionContext(sessionId, agentCwd, userMessage);
		this.syncPlanHtmlPath(Boolean(planMode && planHtml), sessionId);

		// Slice C: emit status=running AFTER initSessionContext so getCurrentSessionId()
		// is non-null when clients receive this event. This lets the ledger detect new
		// sessions immediately via the non-null db_session_id in sessions_status broadcasts.
		this.emitRunningStatus(emit);

		// Resolve provider after initSessionContext so this.agentCwd is final.
		const {
			provider: currentProvider,
			agentSettings,
			resumeProviderSessionId,
		} = this.prepareProviderForTurn(sessionId);

		// Turn-boundary usage gate: hold the turn before any provider spend.
		// State stays "running" while sleeping; agent_sleep carries the nuance.
		if ((await this.gateOnUsage(currentProvider, emit)) === "aborted") return;

		const turn = createTurnState();

		try {
			const { prompt, safeAttachments } = buildPrompt({
				vaultPath: this.vaultPath,
				allowedAgentRealPaths: this.allowedAgentRealPaths,
				agentMode: this.agentMode,
				agentCwd: this.agentCwd,
				claudeSessionId: resumeProviderSessionId,
				userMessage,
				skillContext,
				attachments,
				...(this.planHtmlPath
					? {
							planHtmlInstructions: buildPlanHtmlInstructions(
								this.planHtmlPath,
							),
						}
					: {}),
			});
			// With `resume`, the CLI maintains conversation state on its end. We
			// send only the new user turn — no transcript replay.
			await this.persistUserMessage(sessionId, userMessage, safeAttachments);

			const { activeCwd, extraDirs, executable } = resolveExecutionContext({
				agentMode: this.agentMode,
				agentCwd: this.agentCwd,
				vaultPath: this.vaultPath,
				allowedAgentRealPaths: this.allowedAgentRealPaths,
				claudeExecutable:
					currentProvider.providerId === "claude"
						? this.claudeExecutable
						: this.codexExecutable,
				wrapperCommand:
					currentProvider.providerId === "codex" ? "codex" : "claude",
				safeAttachments,
			});
			const agentSession = this.getOrCreateAgentSession({
				provider: currentProvider,
				sessionId,
				resumeProviderSessionId,
				activeCwd,
				extraDirs,
				executable,
				agentSettings,
				planMode,
				emit,
			});
			const configuredPermissionMode =
				agentSettings?.permissionMode ?? this.permissionMode;
			await agentSession.setPermissionMode?.(
				planMode ? "plan" : configuredPermissionMode,
			);
			agentSession.setPlanHtmlPath?.(
				this.planHtmlPath ? toLogical(this.planHtmlPath) : undefined,
			);

			// Slice B: deliver this turn's user message via send() rather than
			// passing it as a one-shot prompt. The long-lived stream pushes it
			// onto the SDK's input AsyncIterable and the next assistant turn
			// runs inside the same SDK query.
			await agentSession.send(prompt);

			await this.iterateConversation(
				agentSession,
				sessionId,
				emit,
				turn,
				currentProvider,
			);
			// Per-turn success: drainTurnQueue settles the final session state
			// after the queue empties. Successful turns leave state alone so the
			// drain loop sees "running" → resets to "idle" at end.

			this.scheduleTurnRecap({
				turn,
				sessionId,
				userMessage,
				emit,
				provider: currentProvider,
				agentSettings,
			});
		} catch (err) {
			this.state = "error";
			const msg = err instanceof Error ? err.message : "Unknown error";
			console.error("[session] runQuery error:", err);
			void db.appendLog("error", "session", "runQuery error", {
				message: msg,
				name: err instanceof Error ? err.name : undefined,
				stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
			});
			emit({ type: "error", message: msg });
			// Slice B: tear down the AgentSession on error — its iterator may
			// be in an inconsistent state. The next queued turn (or new
			// runQuery) rebuilds a fresh SDK stream.
			this.agentSession?.cancel();
			this.agentSession = null;
			this.agentSessionKey = null;
		} finally {
			// Persist any remaining assistant text (the success path clears it).
			if (turn.assistantText && sessionId) {
				try {
					const assistantSeq = await this.persistAssistantMessage(
						sessionId,
						turn,
					);
					this.persistPendingToolEvents(
						sessionId,
						assistantSeq,
						turn,
						"finally",
					);
				} catch (error) {
					logDbError("appendMessage (assistant)", error);
				}
			}
			// drainTurnQueue handles the final status emit + abortController
			// reset after the queue fully drains. We intentionally do not emit
			// per-turn status here so queued turns never see a transient idle
			// flicker between turns.
		}
	}
}
