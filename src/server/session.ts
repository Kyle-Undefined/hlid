import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HlidConfig } from "../config";
import * as db from "../db";
import { resolveClaudeExecutable } from "../lib/claudePath";
import { expandTilde, toLogical } from "../lib/paths";
import { SESSION_LABEL_LENGTH } from "../lib/utils";
import {
	computeAllowedAgentRealPaths,
	isAllowedAgentPath,
	resolveAgentMode,
} from "./agentPaths";
import type {
	AgentEvent,
	AgentProvider,
	AgentSession,
	McpServerStatus,
} from "./agentProvider";
import { loadConfig } from "./config";
import { resolveExecutionContext } from "./executionContext";
import { parseAskUserQuestion } from "./parseAskUserQuestion";
import {
	AskUserQuestionManager,
	PermissionManager,
	PlanModeManager,
} from "./permissions";
import { buildPrompt } from "./promptBuilder";
import type {
	AskUserQuestionAnswers,
	AskUserQuestionNotes,
	ChatAttachment,
	ServerMessage,
} from "./protocol";
import { mapMcpServer } from "./protocol";
import { updateWindowMark } from "./proxy";
import { generateTurnRecap } from "./recap";

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
];

type QueuedTurn = {
	args: RunQueryArgs;
	turnId?: string;
	resolve: () => void;
	reject: (err: Error) => void;
};

export type SessionState = "idle" | "running" | "error";

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

type AgentSettings = {
	model?: string;
	effort?: string;
	maxTurns?: number;
	permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
	recapModel?: string;
};

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
	private permissions = new PermissionManager();
	private askUserQuestions = new AskUserQuestionManager();
	private planModeManager = new PlanModeManager();
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
	private turnQueue: QueuedTurn[] = [];
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

	constructor(config: HlidConfig, providers: Map<string, AgentProvider>) {
		this.providers = providers;
		this.applyConfig(config);
	}

	/** Returns all registered providers for use by callers (e.g. proxy startup). */
	getAllProviders(): AgentProvider[] {
		return [...this.providers.values()];
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
		// Build agentPath → providerId map from config
		this.agentProviderMap = new Map();
		this.agentSettingsMap = new Map();
		for (const agent of config.agents ?? []) {
			try {
				const realPath = realpathSync(expandTilde(agent.path));
				this.agentProviderMap.set(realPath, agent.provider ?? "claude");
				const settings: AgentSettings = {};
				if (agent.model) settings.model = agent.model;
				if (agent.effort) settings.effort = agent.effort;
				if (agent.max_turns) settings.maxTurns = agent.max_turns;
				if (agent.permission_mode)
					settings.permissionMode = agent.permission_mode;
				if (agent.recap_model) settings.recapModel = agent.recap_model;
				if (Object.keys(settings).length > 0) {
					this.agentSettingsMap.set(realPath, settings);
				}
			} catch {
				// path doesn't exist yet — best-effort, skip
			}
		}
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

	getStatus(): { state: SessionState; model: string } {
		return { state: this.state, model: this.model };
	}

	getCurrentSessionId(): string | null {
		return this.currentSessionId;
	}

	getSessionLabel(): string | null {
		return this.currentSessionLabel;
	}

	getLastMcpStatus(): McpServerStatus[] | null {
		return this.lastMcpStatus;
	}

	restoreMcpStatus(statuses: McpServerStatus[]): void {
		this.lastMcpStatus = statuses;
	}

	async probeMcpStatus(emit: (msg: ServerMessage) => void): Promise<void> {
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
			// Slice B: streaming-input mode is lazy — the SDK query won't
			// open until first send(). A trivial "." kicks off init so
			// mcpServerStatus() has a query to query against; canUseTool
			// denies any tool call so the SDK exits quickly.
			await session.send(".");
			for await (const _ of session) {
				const statuses = (await session.mcpServerStatus?.()) ?? [];
				this.lastMcpStatus = statuses;
				emit({ type: "mcp_status", servers: statuses.map(mapMcpServer) });
				session.cancel();
				break;
			}
		} catch {
			// abort errors expected
		} finally {
			clearTimeout(timeout);
			this.probing = false;
		}
	}

	async probeSlashCommands(emit: (msg: ServerMessage) => void): Promise<void> {
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
			await session.send(".");
			for await (const _ of session) {
				const commands = (await session.supportedCommands?.()) ?? [];
				emit({ type: "slash_commands", commands });
				session.cancel();
				break;
			}
		} catch {
			// abort errors expected
		} finally {
			clearTimeout(timeout);
			this.probing = false;
		}
	}

	isRunning(): boolean {
		return this.state === "running";
	}

	abort(): void {
		this.permissions.clearAll();
		this.askUserQuestions.clearAll();
		this.planModeManager.clearAll();
		// Drop queued turns so abort cancels everything in flight, not just
		// the currently running turn.
		const dropped = this.turnQueue.splice(0);
		for (const t of dropped) t.resolve();
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
		const dropped = this.turnQueue.splice(0);
		for (const t of dropped) t.resolve();
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
	): void {
		const newId = event.sessionId;
		// Always update on every session_start — the provider may reassign on
		// compaction/fork, and we want the latest valid id persisted for the next
		// turn's resume.
		if (newId && newId !== this.providerSessionId) {
			this.providerSessionId = newId;
			this.providerSessionProviderId = provider.providerId;
			if (sessionId) {
				void db
					.setSessionProviderSession(sessionId, provider.providerId, newId)
					.catch((e) => logDbError("setSessionProviderSession", e));
			}
		}
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

	/** Handle done event: persist query + assistant message to DB, emit done. */
	private async handleDone(
		event: Extract<AgentEvent, { type: "done" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		provider: AgentProvider,
	): Promise<void> {
		const primaryModel = event.modelUsage
			? Object.values(event.modelUsage)[0]
			: undefined;
		// Persist so subsequent usage_update events can carry context_window
		// to the gauge without waiting for the next done.
		if (primaryModel?.contextWindow) {
			turn.lastKnownContextWindow = primaryModel.contextWindow;
		}
		const tokensInContext = turn.lastTurnUsage
			? turn.lastTurnUsage.input_tokens +
				(turn.lastTurnUsage.cache_read_input_tokens ?? 0) +
				(turn.lastTurnUsage.cache_creation_input_tokens ?? 0)
			: null;
		const queryData: db.QueryData = {
			cost: event.cost ?? 0,
			input_tokens: event.usage?.inputTokens ?? 0,
			output_tokens: event.usage?.outputTokens ?? 0,
			cache_read_tokens: event.usage?.cacheReadTokens ?? 0,
			cache_creation_tokens: event.usage?.cacheCreationTokens ?? 0,
			duration_ms: event.durationMs,
			turns: event.turns,
			context_window: primaryModel?.contextWindow ?? null,
			stop_reason: event.stopReason ?? null,
			tokens_in_context: tokensInContext,
		};
		if (sessionId) {
			await db.recordQuery(sessionId, queryData, provider.providerId);
			if (turn.lastActualModel) {
				db.setSessionActualModel(sessionId, turn.lastActualModel).catch((e) => {
					console.error("[db] setSessionActualModel failed:", e);
				});
			}
			if (turn.assistantText) {
				turn.lastAssistantText = turn.assistantText;
				// Reuse the seq reserved at first tool_start so live-persisted
				// tool_event rows correctly link to this assistant message. If no
				// tools ran this turn, allocate a fresh seq now.
				const reused = turn.reservedAssistantSeq != null;
				const assistantSeq = turn.reservedAssistantSeq ?? this.messageSeq++;
				turn.lastAssistantSeq = assistantSeq;
				// Cancel any pending throttled text write — done writes the final
				// text authoritatively below.
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
				for (const te of turn.pendingToolEvents) {
					const result = turn.pendingToolResults.get(te.toolId);
					if (turn.persistedToolIds.has(te.toolId)) {
						// Already inserted live on tool_start. Just write the result
						// if it didn't land at tool_result time (e.g., race or no
						// tool_result event for this tool — defensive).
						if (result) {
							db.setToolEventResult(
								sessionId,
								te.toolId,
								result.content,
								result.isError,
							).catch((e) => logDbError("setToolEventResult (done)", e));
						}
						continue;
					}
					db.appendToolEvent(
						sessionId,
						assistantSeq,
						te.toolId,
						te.name,
						te.input,
					)
						.then(() => {
							if (result) {
								return db.setToolEventResult(
									sessionId,
									te.toolId,
									result.content,
									result.isError,
								);
							}
						})
						.catch((e) => logDbError("appendToolEvent", e));
				}
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
			if (event.type === "session_start") {
				this.handleSessionStart(event, sessionId, provider);
			} else if (event.type === "text_delta") {
				let text = event.text;
				// Prepend blank line when text follows a tool block so markdown renders cleanly.
				if (
					turn.lastBlockType === "tool_use" &&
					text &&
					!text.startsWith("\n")
				) {
					text = `\n\n${text}`;
				}
				turn.assistantText += text;
				emit({ type: "chunk", text });
				// Stream the accumulated text to DB so the front end is a thin
				// viewer: nav-away/back during a turn rehydrates the partial text
				// from the DB instead of relying on the unmount-time buffer. Writes
				// are coalesced into ~150ms windows to bound I/O across long turns
				// (rewriting the full text column on every chunk would be O(N²)
				// bytes written).
				if (sessionId) {
					this.ensureAssistantRow(turn, sessionId);
					this.scheduleTextWrite(turn, sessionId);
				}
				turn.lastBlockType = "text";
			} else if (event.type === "tool_start") {
				turn.hadToolEvents = true;
				// ExitPlanMode renders as a dedicated PlanCard via plan_mode_exit
				// (emitted from canUseTool). Skip both the tool_event broadcast and
				// the pendingToolEvents persistence path so the chat doesn't show
				// both a tool block and a plan card. Real ExitPlanMode tools never
				// run to completion until the user approves anyway.
				if (event.name === "ExitPlanMode") {
					turn.lastBlockType = "tool_use";
					continue;
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
				// Persist live so SPA nav / browser refresh during a running query
				// can show the call once history reloads (DB is the source of truth
				// when the in-page reducer state is gone). Reserve the assistant_seq
				// once per turn; the assistant message row is written at done with
				// the same seq.
				if (sessionId) {
					const seq = this.ensureAssistantRow(turn, sessionId);
					const toolId = event.toolId;
					void db
						.appendToolEvent(sessionId, seq, toolId, event.name, event.input)
						.then(() => {
							// Mark persisted only after the INSERT succeeded so handleDone
							// won't skip a re-insert when this row never landed.
							turn.persistedToolIds.add(toolId);
						})
						.catch((e) => logDbError("appendToolEvent (live)", e));
				}
				turn.lastBlockType = "tool_use";
			} else if (event.type === "tool_result") {
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
				// Persist result if the tool_event row is in flight. Both the
				// INSERT (live) and this UPDATE go through Bun's serialized DB
				// queue, so the UPDATE always observes the row.
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
			} else if (event.type === "usage") {
				const cacheRead = event.cacheReadTokens ?? 0;
				const cacheCreation = event.cacheCreationTokens ?? 0;
				turn.lastTurnUsage = {
					input_tokens: event.inputTokens,
					cache_read_input_tokens: event.cacheReadTokens,
					cache_creation_input_tokens: event.cacheCreationTokens,
				};
				turn.lastActualModel = event.model ?? null;
				// Stream per-turn usage so context gauge updates without waiting for done.
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
			} else if (event.type === "summary") {
				turn.sdkSummary = event.text;
				emit({ type: "tool_use_summary", summary: event.text });
			} else if (event.type === "rate_limit") {
				this.handleRateLimit(event, emit, provider);
			} else if (event.type === "local_command_output") {
				emit({ type: "local_command_output", content: event.content });
			} else if (event.type === "mcp_status") {
				this.lastMcpStatus = event.servers;
				emit({ type: "mcp_status", servers: event.servers.map(mapMcpServer) });
			} else if (event.type === "done") {
				await this.handleDone(event, turn, sessionId, emit, provider);
				// Slice B: long-lived session — break at the turn boundary so
				// runOneTurn returns; the iterator stays open for the next
				// runQuery to resume.
				return;
			}
		}
	}

	/**
	 * Submit a turn. Re-entrant: if a turn is already running, this call queues
	 * behind it and resolves when *its* turn completes. Status stays "running"
	 * across queued turns and only flips to "idle" when the queue is fully
	 * drained (mirrors CLI behavior — typed-while-running messages are accepted
	 * and processed at the next turn boundary).
	 */
	async runQuery(
		userMessage: string,
		emit: (msg: ServerMessage) => void,
		sessionId?: string,
		skillContext?: string,
		attachments?: ChatAttachment[],
		agentCwd?: string,
		turnId?: string,
		planMode?: boolean,
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.turnQueue.push({
				args: [
					userMessage,
					emit,
					sessionId,
					skillContext,
					attachments,
					agentCwd,
					turnId,
					planMode,
				],
				turnId,
				resolve,
				reject,
			});
			if (!this.isDraining) void this.drainTurnQueue();
		});
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
			pending_turn_ids: this.turnQueue
				.map((t) => t.turnId)
				.filter((id): id is string => id !== undefined),
			running_turn_id:
				this.state === "running" ? (this.currentTurnId ?? null) : null,
		};
	}

	cancelQueued(turnId: string): boolean {
		const idx = this.turnQueue.findIndex((t) => t.turnId === turnId);
		if (idx === -1) return false;
		const [removed] = this.turnQueue.splice(idx, 1);
		removed.resolve();
		return true;
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
		const idx = this.turnQueue.findIndex((t) => t.turnId === turnId);
		if (idx === -1) return false;
		if (idx > 0) {
			const [promoted] = this.turnQueue.splice(idx, 1);
			this.turnQueue.unshift(promoted);
		}
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
		const head = this.turnQueue[0];
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
			});
		}
	}

	private async runOneTurn(
		userMessage: string,
		emit: (msg: ServerMessage) => void,
		sessionId?: string,
		skillContext?: string,
		attachments?: ChatAttachment[],
		agentCwd?: string,
		turnId?: string,
		planMode?: boolean,
	): Promise<void> {
		this.currentTurnId = turnId;
		await this.initSessionContext(sessionId, agentCwd, userMessage);

		// Slice C: emit status=running AFTER initSessionContext so getCurrentSessionId()
		// is non-null when clients receive this event. This lets the ledger detect new
		// sessions immediately via the non-null db_session_id in sessions_status broadcasts.
		emit({
			type: "status",
			state: "running",
			model: this.model,
			...(turnId !== undefined ? { turn_id: turnId } : {}),
		});

		// Resolve provider after initSessionContext so this.agentCwd is final.
		const currentProvider = this.resolveProvider(this.agentCwd);
		const agentSettings = this.agentCwd
			? this.agentSettingsMap.get(this.agentCwd)
			: undefined;
		const resumeProviderSessionId =
			this.providerSessionProviderId === currentProvider.providerId
				? this.providerSessionId
				: null;
		if (this.providerSessionProviderId !== currentProvider.providerId) {
			this.providerSessionId = null;
			this.providerSessionProviderId = currentProvider.providerId;
		}
		if (sessionId) {
			void db
				.setSessionProviderId(sessionId, currentProvider.providerId)
				.catch((e) => logDbError("setSessionProviderId", e));
		}

		const turn: TurnState = {
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
			});
			// With `resume`, the CLI maintains conversation state on its end. We
			// send only the new user turn — no transcript replay.
			const userSeq = this.messageSeq++;
			if (sessionId) {
				await db.appendMessage(sessionId, userSeq, "user", userMessage);
				for (const a of safeAttachments) {
					await db
						.linkAttachmentToMessage(a.id, sessionId, userSeq)
						.catch((e) => {
							console.error("[session] linkAttachmentToMessage failed:", e);
						});
				}
			}

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
			const providerExecutable = executable;
			// Slice B: long-lived AgentSession per chat. Cache by sessionId +
			// agentCwd so consecutive turns within the same chat reuse one
			// underlying SDK query. Different chat or different agent →
			// tear down + rebuild. Resume retry (rotated/wiped session) is
			// handled inside the provider. canUseTool stays here since it
			// references session state.
			const desiredKey = `${currentProvider.providerId}|${sessionId ?? "ephemeral"}|${this.agentCwd ?? ""}`;
			if (this.agentSession && this.agentSessionKey !== desiredKey) {
				this.agentSession.cancel();
				this.agentSession = null;
				this.agentSessionKey = null;
			}
			let agentSession = this.agentSession;
			if (!agentSession) {
				agentSession = currentProvider.query({
					cwd: activeCwd,
					sessionId: resumeProviderSessionId ?? undefined,
					additionalDirectories:
						extraDirs.size > 0
							? Array.from(extraDirs).map(toLogical)
							: undefined,
					signal: this.abortController?.signal,
					// Vault sessions use the configured model. Agent sessions use agent-specific
					// model override when set, or defer to CLAUDE.md when no override.
					model:
						agentSettings?.model ?? (this.agentCwd ? undefined : this.model),
					permissionMode: planMode
						? "plan"
						: (agentSettings?.permissionMode ?? this.permissionMode),
					effort: agentSettings?.effort ?? this.effort,
					maxTurns: agentSettings?.maxTurns ?? this.maxTurns,
					executable: providerExecutable,
					// Each cwd loads its own user global + project settings +
					// local file. Vault chats see vault hooks/MCP/CLAUDE.md;
					// agent chats see that agent's. canUseTool stays sole
					// permission authority as long as settings files contain
					// only allow-rules written by Hlid (no permissions.deny,
					// no PreToolUse hooks).
					settingSources: ["user", "project", "local"],
					canUseTool: (
						toolName,
						input,
						{ toolUseID, title, displayName, description },
					) =>
						new Promise((resolve) => {
							const passInput = input as Record<string, unknown>;

							// AskUserQuestion: surface options to UI, auto-allow on selection.
							// Never shows as a permission prompt — the user picks from the
							// supplied options and that choice is injected as the tool answer.
							if (toolName === "AskUserQuestion") {
								const { questions } = parseAskUserQuestion(passInput, title);
								const askReq = {
									type: "ask_user_question" as const,
									id: toolUseID,
									questions,
								};
								const askSeq = this.messageSeq++;
								if (sessionId) {
									void db
										.appendAskUserQuestion(
											sessionId,
											toolUseID,
											askSeq,
											JSON.stringify(questions),
										)
										.catch((e) => logDbError("appendAskUserQuestion", e));
								}
								this.askUserQuestions.register(
									toolUseID,
									askReq,
									(answers, notes) => {
										// SDK contract: AskUserQuestionOutput.answers is keyed by
										// question text and string-valued (multi-select answers are
										// comma-separated). A flat `answer` field caused the SDK to
										// fall back to a default option (often the last).
										const existing =
											(passInput.answers as Record<string, string>) ?? {};
										const sdkAnswers: Record<string, string> = { ...existing };
										for (const [q, picks] of Object.entries(answers)) {
											const note = notes?.[q]?.trim();
											sdkAnswers[q] = note
												? `${picks.join(", ")}\n\nNotes: ${note}`
												: picks.join(", ");
										}
										resolve({
											behavior: "allow" as const,
											updatedInput: {
												...passInput,
												answers: sdkAnswers,
											},
										});
									},
								);
								emit(askReq);
								return;
							}

							// ExitPlanMode: surface plan approval UI to user.
							// Approve → Claude exits plan mode and implements.
							// Edit → deny with feedback so Claude revises the plan.
							// Cancel → deny so Claude stops.
							if (toolName === "ExitPlanMode") {
								const exitReq = {
									type: "plan_mode_exit" as const,
									id: toolUseID,
									input: passInput,
								};
								const planText =
									typeof passInput.plan === "string"
										? passInput.plan
										: JSON.stringify(passInput.plan ?? "");
								const planSeq = this.messageSeq++;
								if (sessionId) {
									void db
										.appendPlanProposal(
											sessionId,
											toolUseID,
											planSeq,
											planText,
											"pending",
										)
										.catch((e) => logDbError("appendPlanProposal", e));
								}
								this.planModeManager.register(
									toolUseID,
									exitReq,
									(decision, feedback) => {
										if (sessionId) {
											void db
												.setPlanProposalDecision(sessionId, toolUseID, decision)
												.catch((e) => logDbError("setPlanProposalDecision", e));
										}
										if (decision === "approved") {
											resolve({
												behavior: "allow" as const,
												updatedInput: passInput,
											});
										} else if (decision === "edited") {
											resolve({
												behavior: "deny" as const,
												message: `User requested changes to the plan:\n\n${feedback ?? ""}`,
											});
										} else {
											resolve({
												behavior: "deny" as const,
												message: "Plan was cancelled by the user.",
											});
										}
									},
								);
								emit(exitReq);
								return;
							}

							// Session-approved: auto-allow without prompting.
							// Survives provider subprocess restarts since we track it ourselves.
							if (this.sessionAllowedTools.has(toolName)) {
								resolve({
									behavior: "allow" as const,
									updatedInput: passInput,
								});
								return;
							}

							const permReq = {
								type: "permission_request" as const,
								id: toolUseID,
								toolName,
								title:
									title ??
									`${currentProvider.label ?? currentProvider.providerId} wants to use ${toolName}`,
								displayName,
								description,
								input: input as Record<string, unknown> | undefined,
							};
							// Provider runtime requires `updatedInput` on the allow branch even
							// though the type marks it optional. Pass the original input unchanged
							// as a no-op so the tool runs as requested.
							this.permissions.register(
								toolUseID,
								permReq,
								(approved, saveScope, denyMessage) => {
									this.permissions.delete(toolUseID);
									if (!approved) {
										resolve({
											behavior: "deny" as const,
											message: denyMessage ?? "Denied by user",
										});
									} else if (saveScope === "session") {
										// Track in our own set so it survives provider subprocess restarts.
										this.sessionAllowedTools.add(toolName);
										resolve({
											behavior: "allow" as const,
											updatedInput: passInput,
										});
									} else if (saveScope === "local") {
										// Write to settings.local.json (gitignored, user-specific).
										// Loaded by the provider via settingSources "local" so the next
										// subprocess picks up the rule automatically.
										try {
											const settingsPath = join(
												activeCwd,
												".claude",
												"settings.local.json",
											);
											let settings: {
												permissions?: {
													allow?: string[];
													deny?: string[];
												};
											} = {};
											try {
												settings = JSON.parse(
													readFileSync(settingsPath, "utf8"),
												);
											} catch (e) {
												if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
													console.error(
														"[session] Failed to parse settings.local.json:",
														e,
													);
												}
											}
											const allow = settings.permissions?.allow ?? [];
											if (!allow.includes(toolName)) {
												settings.permissions = {
													...settings.permissions,
													allow: [...allow, toolName],
												};
												mkdirSync(join(activeCwd, ".claude"), {
													recursive: true,
												});
												writeFileSync(
													settingsPath,
													`${JSON.stringify(settings, null, 2)}\n`,
													"utf8",
												);
											}
										} catch (e) {
											console.error(
												"[session] failed to write always-allow rule:",
												e,
											);
										}
										resolve({
											behavior: "allow" as const,
											updatedInput: passInput,
										});
									} else {
										resolve({
											behavior: "allow" as const,
											updatedInput: passInput,
										});
									}
								},
							);
							emit(permReq);
						}),
				});
				this.agentSession = agentSession;
				this.agentSessionKey = desiredKey;
			}

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

			// Fire a recap after turns with tool use (async, best-effort).
			if (turn.hadToolEvents && this.turnRecaps && turn.lastAssistantText) {
				const recapModel = agentSettings?.recapModel ?? this.recapModel;
				const recapExecutable =
					currentProvider.providerId === "claude"
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
					recapExecutable,
					turn.sdkSummary,
					currentProvider,
					recapModel,
				).catch(() => {});
			}
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
			// Persist any remaining assistant text (error/abort path. Result block clears it on success)
			if (turn.assistantText) {
				if (sessionId) {
					const reused = turn.reservedAssistantSeq != null;
					const assistantSeq = turn.reservedAssistantSeq ?? this.messageSeq++;
					if (turn.textWriteTimer) {
						clearTimeout(turn.textWriteTimer);
						turn.textWriteTimer = null;
					}
					turn.textWriteDirty = false;
					try {
						if (reused) {
							await db.setMessageText(
								sessionId,
								assistantSeq,
								turn.assistantText,
							);
						} else {
							await db.appendMessage(
								sessionId,
								assistantSeq,
								"assistant",
								turn.assistantText,
							);
						}
						for (const te of turn.pendingToolEvents) {
							const result = turn.pendingToolResults.get(te.toolId);
							if (turn.persistedToolIds.has(te.toolId)) {
								if (result) {
									db.setToolEventResult(
										sessionId,
										te.toolId,
										result.content,
										result.isError,
									).catch((e) => logDbError("setToolEventResult (finally)", e));
								}
								continue;
							}
							db.appendToolEvent(
								sessionId,
								assistantSeq,
								te.toolId,
								te.name,
								te.input,
							)
								.then(() => {
									if (result) {
										return db.setToolEventResult(
											sessionId,
											te.toolId,
											result.content,
											result.isError,
										);
									}
								})
								.catch((e) => logDbError("appendToolEvent (finally)", e));
						}
					} catch (e) {
						logDbError("appendMessage (assistant)", e);
					}
				}
				// Without a sessionId there's nowhere to persist orphaned
				// assistant text. The CLI's own session record (managed via
				// `resume`) holds the model-side context regardless.
			}
			// drainTurnQueue handles the final status emit + abortController
			// reset after the queue fully drains. We intentionally do not emit
			// per-turn status here so queued turns never see a transient idle
			// flicker between turns.
		}
	}
}
