import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
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
import { loadConfig } from "./config";
import { resolveExecutionContext } from "./executionContext";
import {
	AskUserQuestionManager,
	PermissionManager,
	PlanModeManager,
} from "./permissions";
import { buildPrompt } from "./promptBuilder";
import type { ChatAttachment, ServerMessage } from "./protocol";
import { mapMcpServer } from "./protocol";
import { generateTurnRecap } from "./recap";

/** Fallback context window size when the SDK omits it from result metadata. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Union of all SDK event types yielded by the query() async iterable. */
type SdkMessage =
	ReturnType<typeof query> extends AsyncIterable<infer T> ? T : never;

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
	lastTurnToolEvents: { toolId: string; name: string; input: unknown }[];
};

export type SessionState = "idle" | "running" | "error";

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export class SessionManager {
	private state: SessionState = "idle";
	private abortController: AbortController | null = null;
	private model!: string;
	private effort!: "low" | "medium" | "high" | "xhigh" | "max";
	private maxTurns: number | undefined;
	private vaultPath!: string;
	private permissionMode!: PermissionMode;
	private claudeExecutable: string | undefined;
	// SDK session UUID for the active chat. Captured from the `system/init`
	// event on first turn, persisted per chat row, and passed back to query()
	// via `resume` on subsequent turns so the CLI manages history natively.
	private claudeSessionId: string | null = null;
	private permissions = new PermissionManager();
	private askUserQuestions = new AskUserQuestionManager();
	private planModeManager = new PlanModeManager();
	/** Tools approved for the entire hlid session (survives SDK subprocess restarts). */
	private sessionAllowedTools = new Set<string>();
	private currentSessionId: string | null = null;
	private messageSeq = 0;
	private lastMcpStatus: McpServerStatus[] | null = null;
	private probing = false;
	private agentCwd: string | undefined;
	private agentMode: "cwd" | "context" = "cwd";
	private allowedAgentRealPaths: string[] = [];
	private turnRecaps!: boolean;

	constructor(config: HlidConfig) {
		this.applyConfig(config);
	}

	/** Apply runtime settings from config. Shared by constructor, reinitialize, and syncConfig. */
	private applyConfig(config: HlidConfig): void {
		this.model = config.claude.model;
		this.effort = config.claude.effort;
		this.maxTurns = config.claude.max_turns;
		this.vaultPath = config.vault.path || process.env.HOME || "/";
		this.permissionMode = config.claude.permission_mode;
		this.turnRecaps = config.claude.turn_recaps ?? true;
		this.claudeExecutable = resolveClaudeExecutable();
		this.allowedAgentRealPaths = computeAllowedAgentRealPaths(config);
	}

	reinitialize(config: HlidConfig): void {
		this.abort();
		this.applyConfig(config);
		this.state = "idle";
		this.currentSessionId = null;
		this.claudeSessionId = null;
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
		const modelChanged = this.model !== config.claude.model;
		this.applyConfig(config);
		return modelChanged;
	}

	getStatus(): { state: SessionState; model: string } {
		return { state: this.state, model: this.model };
	}

	getCurrentSessionId(): string | null {
		return this.currentSessionId;
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
			const conv = query({
				prompt: ".",
				options: {
					cwd: this.vaultPath,
					abortController: ac,
					permissionMode: "default",
					effort: "low" as const,
					maxTurns: 1,
					persistSession: false,
					settingSources: ["user", "project"],
					...(this.claudeExecutable !== undefined && {
						pathToClaudeCodeExecutable: this.claudeExecutable,
					}),
					allowDangerouslySkipPermissions: false,
					canUseTool: () =>
						Promise.resolve({ behavior: "deny" as const, message: "probe" }),
				},
			});
			for await (const _ of conv) {
				const statuses = await conv.mcpServerStatus();
				this.lastMcpStatus = statuses;
				emit({ type: "mcp_status", servers: statuses.map(mapMcpServer) });
				ac.abort();
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
		this.abortController?.abort();
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

	handleAskUserQuestionResponse(id: string, selectedOption: string): void {
		this.askUserQuestions.complete(id, selectedOption);
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
		this.claudeSessionId = null;
		this.messageSeq = 0;
		this.agentCwd = undefined;
		this.agentMode = "cwd";
		this.sessionAllowedTools.clear();
		this.askUserQuestions.clearAll();
		this.planModeManager.clearAll();
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
			const [prior, savedAgentCwd, savedClaudeId] = await Promise.all([
				db.getSessionMessages(sessionId),
				db.getSessionAgentCwd(sessionId),
				db.getSessionClaudeId(sessionId),
			]);
			this.messageSeq = prior.length;
			this.currentSessionId = sessionId;
			this.claudeSessionId = savedClaudeId;
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
			await db.createSession(sessionId, label, this.model);
		}

		// Persist agent cwd after session row exists
		if (this.agentCwd && sessionId && agentCwd) {
			db.setSessionAgentCwd(sessionId, this.agentCwd).catch((e) => {
				console.error("[session] setSessionAgentCwd failed:", e);
			});
		}
	}

	/** Handle system/init: capture and persist the SDK session UUID. */
	private handleInit(
		message: Extract<SdkMessage, { type: "system"; subtype: "init" }>,
		sessionId: string | undefined,
	): void {
		const newId = message.session_id;
		// Always update on every init — the CLI may reassign on compaction/fork,
		// and we want the latest valid id persisted for the next turn's resume.
		if (newId && newId !== this.claudeSessionId) {
			this.claudeSessionId = newId;
			if (sessionId) {
				void db
					.setSessionClaudeId(sessionId, newId)
					.catch((e) => logDbError("setSessionClaudeId", e));
			}
		}
	}

	/** Handle assistant message: emit usage_update and stream content blocks. */
	private handleAssistant(
		message: Extract<SdkMessage, { type: "assistant" }>,
		turn: TurnState,
		emit: (msg: ServerMessage) => void,
	): void {
		if (message.message.usage) {
			const u = message.message.usage;
			turn.lastTurnUsage = {
				input_tokens: u.input_tokens,
				cache_read_input_tokens: u.cache_read_input_tokens ?? undefined,
				cache_creation_input_tokens: u.cache_creation_input_tokens ?? undefined,
			};
			// Stream a per-turn usage snapshot so the context gauge / stats
			// panel update with each model inference instead of waiting for
			// the result boundary.
			const cacheRead = u.cache_read_input_tokens ?? 0;
			const cacheCreation = u.cache_creation_input_tokens ?? 0;
			const actualModel = message.message.model;
			turn.lastActualModel = actualModel ?? null;
			emit({
				type: "usage_update",
				input_tokens: u.input_tokens,
				output_tokens: u.output_tokens,
				cache_read_tokens: cacheRead,
				cache_creation_tokens: cacheCreation,
				tokens_in_context: u.input_tokens + cacheRead + cacheCreation,
				actualModel,
				...(turn.lastKnownContextWindow != null
					? { context_window: turn.lastKnownContextWindow }
					: {}),
			});
		}
		for (const block of message.message.content) {
			if (block.type === "text") {
				let chunkText = block.text;
				if (
					turn.lastBlockType === "tool_use" &&
					chunkText &&
					!chunkText.startsWith("\n")
				) {
					chunkText = `\n\n${chunkText}`;
				}
				turn.assistantText += chunkText;
				emit({ type: "chunk", text: chunkText });
				turn.lastBlockType = "text";
			}
			if (block.type === "tool_use") {
				turn.hadToolEvents = true;
				turn.pendingToolEvents.push({
					toolId: block.id,
					name: block.name,
					input: block.input,
				});
				emit({
					type: "tool_event",
					id: block.id,
					name: block.name,
					input: block.input,
				});
				turn.lastBlockType = "tool_use";
			}
		}
	}

	/** Handle rate_limit_event: emit and persist utilization to DB settings. */
	private handleRateLimit(
		message: Extract<SdkMessage, { type: "rate_limit_event" }>,
		emit: (msg: ServerMessage) => void,
	): void {
		const info = message.rate_limit_info;
		emit({
			type: "rate_limit",
			status: info.status,
			rateLimitType: info.rateLimitType,
			utilization: info.utilization,
			resetsAt: info.resetsAt,
		});
		// Persist for usage windows display, skip if utilization is null
		// (proxy server writes the authoritative value from API response headers)
		if (info.utilization != null) {
			const settingsKey =
				info.rateLimitType === "five_hour" ? "rl_5hr" : "rl_weekly";
			void db.saveSetting(
				settingsKey,
				JSON.stringify({
					utilization: info.utilization,
					resetsAt: info.resetsAt ?? null,
					rateLimitType: info.rateLimitType ?? null,
				}),
			);
		}
	}

	/** Handle result: persist query + assistant message to DB, emit done. */
	private async handleResult(
		message: Extract<SdkMessage, { type: "result" }>,
		turn: TurnState,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
	): Promise<void> {
		const primaryModel = Object.values(message.modelUsage ?? {})[0];
		// Persist so subsequent usage_update messages can carry context_window
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
			cost: message.total_cost_usd ?? 0,
			input_tokens: message.usage?.input_tokens ?? 0,
			output_tokens: message.usage?.output_tokens ?? 0,
			cache_read_tokens: message.usage?.cache_read_input_tokens ?? 0,
			cache_creation_tokens: message.usage?.cache_creation_input_tokens ?? 0,
			duration_ms: message.duration_ms ?? 0,
			turns: message.num_turns,
			context_window: primaryModel?.contextWindow ?? null,
			stop_reason: message.stop_reason ?? null,
			tokens_in_context: tokensInContext,
		};
		// Slash commands (e.g. /triage-inbox) produce no streaming text.
		// Their output lands in message.result instead of assistant chunks.
		if (
			!turn.assistantText &&
			message.subtype === "success" &&
			message.result
		) {
			turn.assistantText = message.result;
			emit({ type: "chunk", text: message.result });
		}
		if (sessionId) {
			await db.recordQuery(sessionId, queryData);
			if (turn.lastActualModel) {
				db.setSessionActualModel(sessionId, turn.lastActualModel).catch((e) => {
					console.error("[db] setSessionActualModel failed:", e);
				});
			}
			if (turn.assistantText) {
				turn.lastAssistantText = turn.assistantText;
				turn.lastAssistantSeq = this.messageSeq;
				const assistantSeq = this.messageSeq++;
				await db.appendMessage(
					sessionId,
					assistantSeq,
					"assistant",
					turn.assistantText,
				);
				for (const te of turn.pendingToolEvents) {
					db.appendToolEvent(
						sessionId,
						assistantSeq,
						te.toolId,
						te.name,
						te.input,
					).catch((e) => logDbError("appendToolEvent", e));
				}
				turn.lastTurnToolEvents = [...turn.pendingToolEvents];
				turn.pendingToolEvents.length = 0;
				turn.assistantText = "";
			}
		}
		emit({
			type: "done",
			session_id: sessionId,
			cost: message.total_cost_usd ?? null,
			turns: message.num_turns,
			duration_ms: message.duration_ms ?? 0,
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
	 * Processes the SDK async event stream for one query attempt, updating
	 * turn state in place. Called once for a fresh query and potentially a
	 * second time on a resume-fallback retry (same turn object, receivedAny
	 * tracks whether any message arrived before failure).
	 */
	private async iterateConversation(
		conversation: ReturnType<typeof query>,
		sessionId: string | undefined,
		emit: (msg: ServerMessage) => void,
		turn: TurnState,
	): Promise<void> {
		let mcpChecked = false;
		for await (const message of conversation) {
			turn.receivedAny = true;
			if (!mcpChecked) {
				mcpChecked = true;
				void conversation
					.mcpServerStatus()
					.then((statuses) => {
						this.lastMcpStatus = statuses;
						emit({ type: "mcp_status", servers: statuses.map(mapMcpServer) });
					})
					.catch(() => {});
			}
			if (message.type === "system" && message.subtype === "init") {
				this.handleInit(message, sessionId);
			}
			if (message.type === "assistant") {
				this.handleAssistant(message, turn, emit);
			}
			if (message.type === "tool_use_summary") {
				emit({ type: "tool_use_summary", summary: message.summary });
			}
			if (message.type === "rate_limit_event") {
				this.handleRateLimit(message, emit);
			}
			if (message.type === "result") {
				await this.handleResult(message, turn, sessionId, emit);
			}
		}
	}

	async runQuery(
		userMessage: string,
		emit: (msg: ServerMessage) => void,
		sessionId?: string,
		skillContext?: string,
		attachments?: ChatAttachment[],
		agentCwd?: string,
	): Promise<void> {
		if (this.state === "running") {
			emit({ type: "error", message: "Session already running" });
			return;
		}

		// Set running immediately, prevents TOCTOU from concurrent chat messages
		this.state = "running";
		this.abortController = new AbortController();
		emit({ type: "status", state: "running", model: this.model });

		await this.initSessionContext(sessionId, agentCwd, userMessage);

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
			lastTurnToolEvents: [],
		};

		try {
			const { prompt, safeAttachments } = buildPrompt({
				vaultPath: this.vaultPath,
				allowedAgentRealPaths: this.allowedAgentRealPaths,
				agentMode: this.agentMode,
				agentCwd: this.agentCwd,
				claudeSessionId: this.claudeSessionId,
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
				claudeExecutable: this.claudeExecutable,
				safeAttachments,
			});
			// `persistSession` defaults to true. Required for `resume` to work —
			// the SDK persists conversation state to ~/.claude/projects/ and
			// reloads it on the next call when `resume` is set. We capture the
			// SDK's session UUID from the first `system/init` event, persist it
			// per chat row, and pass it back here on subsequent turns.
			//
			// Inlined inside `startQuery` so query()'s `options` parameter gives
			// `canUseTool` its contextual type (extracting to a helper widens
			// PermissionUpdate to unknown[] and breaks the SDK type bound).
			const startQuery = (resumeId: string | null) =>
				query({
					prompt,
					options: {
						cwd: activeCwd,
						...(extraDirs.size > 0
							? {
									additionalDirectories: Array.from(extraDirs).map(toLogical),
								}
							: {}),
						abortController: this.abortController ?? undefined,
						// Vault sessions use the configured model. Agent sessions defer to
						// whatever is configured in the agent's CLAUDE.md or local settings.
						...(this.agentCwd ? {} : { model: this.model }),
						permissionMode: this.permissionMode,
						effort: this.effort,
						...(this.maxTurns !== undefined && { maxTurns: this.maxTurns }),
						...(executable !== undefined && {
							pathToClaudeCodeExecutable: executable,
						}),
						allowDangerouslySkipPermissions:
							this.permissionMode === "bypassPermissions",
						// Each cwd loads its own user global + project settings +
						// local file. Vault chats see vault hooks/MCP/CLAUDE.md;
						// agent chats see that agent's. canUseTool stays sole
						// permission authority as long as settings files contain
						// only allow-rules written by Hlid (no permissions.deny,
						// no PreToolUse hooks).
						settingSources: ["user", "project"],
						...(resumeId !== null ? { resume: resumeId } : {}),
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
									const question =
										typeof passInput.question === "string"
											? passInput.question
											: (title ?? "Question from Claude");
									const options = Array.isArray(passInput.options)
										? (passInput.options as unknown[]).filter(
												(o): o is string => typeof o === "string",
											)
										: [];
									const askReq = {
										type: "ask_user_question" as const,
										id: toolUseID,
										question,
										options,
									};
									this.askUserQuestions.register(
										toolUseID,
										askReq,
										(selectedOption) => {
											resolve({
												behavior: "allow" as const,
												updatedInput: {
													...passInput,
													answer: selectedOption,
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
									this.planModeManager.register(
										toolUseID,
										exitReq,
										(decision, feedback) => {
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
								// Survives SDK subprocess restarts since we track it ourselves.
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
									title: title ?? `Claude wants to use ${toolName}`,
									displayName,
									description,
									input: input as Record<string, unknown> | undefined,
								};
								// SDK runtime Zod schema requires `updatedInput` on the allow
								// branch even though the .d.ts marks it optional. Pass the
								// original input unchanged as a no-op so the tool runs as
								// requested.
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
											// Track in our own set so it survives SDK subprocess restarts.
											this.sessionAllowedTools.add(toolName);
											resolve({
												behavior: "allow" as const,
												updatedInput: passInput,
											});
										} else if (saveScope === "local") {
											// Write directly to project settings.json (in settingSources)
											// so the next subprocess picks up the rule. localSettings
											// maps to settings.local.json which is excluded from
											// settingSources, so we handle persistence ourselves.
											try {
												const settingsPath = join(
													activeCwd,
													".claude",
													"settings.json",
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
												} catch {}
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
					},
				});

			// Run with resume if we have a captured session id, else fresh.
			// On resume failure (no `system/init` ever fired), retry once
			// without resume — covers the case where the SDK's persisted
			// session record was rotated/wiped between turns.
			const triedResume = this.claudeSessionId !== null;
			try {
				await this.iterateConversation(
					startQuery(this.claudeSessionId),
					sessionId,
					emit,
					turn,
				);
			} catch (err) {
				if (triedResume && !turn.receivedAny) {
					console.warn(
						"[session] resume failed before any message, retrying fresh:",
						err,
					);
					void db.appendLog(
						"warn",
						"session",
						"resume failed, retrying fresh",
						{
							error: err instanceof Error ? err.message : String(err),
							claude_session_id: this.claudeSessionId,
						},
					);
					this.claudeSessionId = null;
					if (sessionId) {
						await db.setSessionClaudeId(sessionId, null).catch((e) => {
							console.error("[db] setSessionClaudeId(null) failed:", e);
						});
					}
					await this.iterateConversation(
						startQuery(null),
						sessionId,
						emit,
						turn,
					);
				} else {
					throw err;
				}
			}

			this.state = "idle";

			// Fire a Haiku recap after turns with tool use (async, best-effort).
			if (turn.hadToolEvents && this.turnRecaps && turn.lastAssistantText) {
				void generateTurnRecap(
					sessionId ?? null,
					turn.lastAssistantSeq,
					userMessage,
					turn.lastTurnToolEvents,
					turn.lastAssistantText,
					emit,
					this.vaultPath,
					this.claudeExecutable,
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
		} finally {
			// Persist any remaining assistant text (error/abort path. Result block clears it on success)
			if (turn.assistantText) {
				if (sessionId) {
					const assistantSeq = this.messageSeq++;
					try {
						await db.appendMessage(
							sessionId,
							assistantSeq,
							"assistant",
							turn.assistantText,
						);
						for (const te of turn.pendingToolEvents) {
							db.appendToolEvent(
								sessionId,
								assistantSeq,
								te.toolId,
								te.name,
								te.input,
							).catch((e) => logDbError("appendToolEvent (finally)", e));
						}
					} catch (e) {
						logDbError("appendMessage (assistant)", e);
					}
				}
				// Without a sessionId there's nowhere to persist orphaned
				// assistant text. The CLI's own session record (managed via
				// `resume`) holds the model-side context regardless.
			}
			this.abortController = null;
			emit({ type: "status", state: this.state, model: this.model });
		}
	}
}
