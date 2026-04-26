import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HlidConfig } from "../config";
import * as db from "../db";
import type { ServerMessage } from "./protocol";

function resolveClaudeExecutable(configOverride?: string): string | undefined {
	if (configOverride) return configOverride;
	// On linux x64, SDK prefers musl binary but WSL2/glibc systems can't run it.
	// Fall back to glibc variant if musl libc is absent.
	if (process.platform === "linux" && process.arch === "x64") {
		const muslLib = "/lib/ld-musl-x86_64.so.1";
		if (!existsSync(muslLib)) {
			const glibcBin = resolve(
				import.meta.dirname,
				"../../node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
			);
			if (existsSync(glibcBin)) return glibcBin;
		}
	}
	return undefined;
}

export type SessionState = "idle" | "running" | "error";

type Turn = { role: "user" | "assistant"; text: string };

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export class SessionManager {
	private state: SessionState = "idle";
	private abortController: AbortController | null = null;
	private model: string;
	private effort: "low" | "medium" | "high" | "xhigh" | "max";
	private maxTurns: number | undefined;
	private vaultPath: string;
	private permissionMode: PermissionMode;
	private claudeExecutable: string | undefined;
	private history: Turn[] = [];
	private pendingPermissions = new Map<string, (approved: boolean) => void>();
	private pendingPermissionData = new Map<
		string,
		Extract<ServerMessage, { type: "permission_request" }>
	>();
	private currentSessionId: string | null = null;
	private messageSeq = 0;

	constructor(config: HlidConfig) {
		this.model = config.claude.model;
		this.effort = config.claude.effort;
		this.maxTurns = config.claude.max_turns;
		this.vaultPath = config.vault.path || process.env.HOME || "/";
		this.permissionMode = config.claude.permission_mode;
		this.claudeExecutable = resolveClaudeExecutable(config.claude.executable);
	}

	reinitialize(config: HlidConfig): void {
		this.abort();
		this.model = config.claude.model;
		this.effort = config.claude.effort;
		this.maxTurns = config.claude.max_turns;
		this.vaultPath = config.vault.path || process.env.HOME || "/";
		this.permissionMode = config.claude.permission_mode;
		this.claudeExecutable = resolveClaudeExecutable(config.claude.executable);
		this.history = [];
		this.state = "idle";
		this.currentSessionId = null;
		this.messageSeq = 0;
		db.clearCurrentSessionId().catch((e) =>
			console.error("[db] clearCurrentSessionId failed:", e),
		);
	}

	getStatus(): { state: SessionState; model: string } {
		return { state: this.state, model: this.model };
	}

	isRunning(): boolean {
		return this.state === "running";
	}

	abort(): void {
		const resolvers = Array.from(this.pendingPermissions.values());
		this.pendingPermissions.clear();
		this.pendingPermissionData.clear();
		this.abortController?.abort();
		for (const resolve of resolvers) resolve(false);
	}

	handlePermissionResponse(id: string, approved: boolean): void {
		this.pendingPermissions.get(id)?.(approved);
		this.pendingPermissionData.delete(id);
	}

	getPendingPermissionRequests(): Extract<
		ServerMessage,
		{ type: "permission_request" }
	>[] {
		return Array.from(this.pendingPermissionData.values());
	}

	clearHistory(): void {
		this.history = [];
		this.currentSessionId = null;
		this.messageSeq = 0;
		db.clearCurrentSessionId().catch((e) =>
			console.error("[db] clearCurrentSessionId failed:", e),
		);
	}

	private buildPrompt(userMessage: string): string {
		if (this.history.length === 0) return userMessage;

		const ctx = this.history
			.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
			.join("\n\n");

		return `Conversation so far:\n${ctx}\n\nUser: ${userMessage}`;
	}

	async runQuery(
		userMessage: string,
		emit: (msg: ServerMessage) => void,
		sessionId?: string,
		skillContext?: string,
	): Promise<void> {
		if (this.state === "running") {
			emit({ type: "error", message: "Session already running" });
			return;
		}

		// Set running immediately — prevents TOCTOU from concurrent chat messages
		this.state = "running";
		this.abortController = new AbortController();
		emit({ type: "status", state: "running", model: this.model });

		// Switch or initialize session context
		if (sessionId && sessionId !== this.currentSessionId) {
			const prior = await db.getSessionMessages(sessionId);
			this.history = prior.map((m) => ({
				role: m.role as "user" | "assistant",
				text: m.text,
			}));
			this.messageSeq = prior.length;
			this.currentSessionId = sessionId;
			db.setCurrentSessionId(sessionId).catch((e) =>
				console.error("[db] setCurrentSessionId failed:", e),
			);
		}

		// Create DB session record for new sessions
		if (sessionId && this.messageSeq === 0) {
			const label = userMessage.slice(0, 40).toUpperCase();
			await db.createSession(sessionId, label, this.model);
		}

		let assistantText = "";
		let lastTurnUsage: {
			input_tokens: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		} | null = null;
		const pendingToolEvents: {
			toolId: string;
			name: string;
			input: unknown;
		}[] = [];

		try {
			// For vault skills: skillContext is the absolute file path.
			// Validate it stays within the vault before interpolating into the prompt.
			// For Claude skills (skillContext absent): message starts with '/' and CLI handles
			// the slash command natively from ~/.claude/skills/ — keep the slash intact.
			const safeSkillContext = skillContext?.startsWith(`${this.vaultPath}/`)
				? skillContext
				: undefined;
			const claudeMessage = safeSkillContext
				? `Please read the skill file at \`${safeSkillContext}\` and follow its instructions.\n\nUser: ${userMessage || "(no additional input)"}`
				: userMessage;
			const prompt = this.buildPrompt(claudeMessage);
			this.history.push({ role: "user", text: claudeMessage });
			const userSeq = this.messageSeq++;
			if (sessionId) {
				await db.appendMessage(sessionId, userSeq, "user", userMessage);
			}

			const conversation = query({
				prompt,
				options: {
					cwd: this.vaultPath,
					abortController: this.abortController,
					permissionMode: this.permissionMode,
					effort: this.effort,
					...(this.maxTurns !== undefined && { maxTurns: this.maxTurns }),
					...(this.claudeExecutable !== undefined && {
						pathToClaudeCodeExecutable: this.claudeExecutable,
					}),
					allowDangerouslySkipPermissions:
						this.permissionMode === "bypassPermissions",
					persistSession: false,
					canUseTool: (
						toolName,
						input,
						{ toolUseID, title, displayName, description },
					) =>
						new Promise((resolve) => {
							const permReq = {
								type: "permission_request" as const,
								id: toolUseID,
								toolName,
								title: title ?? `Claude wants to use ${toolName}`,
								displayName,
								description,
								input: input as Record<string, unknown> | undefined,
							};
							this.pendingPermissionData.set(toolUseID, permReq);
							this.pendingPermissions.set(toolUseID, (approved) => {
								this.pendingPermissions.delete(toolUseID);
								this.pendingPermissionData.delete(toolUseID);
								resolve(
									approved
										? { behavior: "allow" as const }
										: { behavior: "deny" as const, message: "Denied by user" },
								);
							});
							emit(permReq);
						}),
				},
			});

			for await (const message of conversation) {
				if (message.type === "assistant") {
					if (message.message.usage) {
						const u = message.message.usage;
						lastTurnUsage = {
							input_tokens: u.input_tokens,
							cache_read_input_tokens: u.cache_read_input_tokens ?? undefined,
							cache_creation_input_tokens:
								u.cache_creation_input_tokens ?? undefined,
						};
					}
					for (const block of message.message.content) {
						if (block.type === "text") {
							assistantText += block.text;
							emit({ type: "chunk", text: block.text });
						}
						if (block.type === "tool_use") {
							pendingToolEvents.push({
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
						}
					}
				}

				if (message.type === "rate_limit_event") {
					const info = message.rate_limit_info;
					emit({
						type: "rate_limit",
						status: info.status,
						rateLimitType: info.rateLimitType,
						utilization: info.utilization,
						resetsAt: info.resetsAt,
					});
					// Persist for usage windows display
					const resetsAt = info.resetsAt ?? 0;
					const settingsKey =
						resetsAt - Date.now() / 1000 <= 5 * 3600 + 300
							? "rl_5hr"
							: "rl_weekly";
					void db.saveSetting(
						settingsKey,
						JSON.stringify({
							utilization: info.utilization ?? null,
							resetsAt: info.resetsAt ?? null,
							rateLimitType: info.rateLimitType ?? null,
						}),
					);
				}

				if (message.type === "result") {
					const primaryModel = Object.values(message.modelUsage ?? {})[0];
					const queryData: db.QueryData = {
						cost: message.total_cost_usd ?? 0,
						input_tokens: message.usage?.input_tokens ?? 0,
						output_tokens: message.usage?.output_tokens ?? 0,
						cache_read_tokens: message.usage?.cache_read_input_tokens ?? 0,
						cache_creation_tokens:
							message.usage?.cache_creation_input_tokens ?? 0,
						duration_ms: message.duration_ms ?? 0,
						turns: message.num_turns,
						context_window: primaryModel?.contextWindow ?? null,
						stop_reason: message.stop_reason ?? null,
					};
					// Slash commands (e.g. /triage-inbox) produce no streaming text —
					// their output lands in message.result instead of assistant chunks.
					if (
						!assistantText &&
						message.subtype === "success" &&
						message.result
					) {
						assistantText = message.result;
						emit({ type: "chunk", text: message.result });
					}
					if (sessionId) {
						await db.recordQuery(sessionId, queryData);
						if (assistantText) {
							const assistantSeq = this.messageSeq++;
							await db.appendMessage(
								sessionId,
								assistantSeq,
								"assistant",
								assistantText,
							);
							// Only push to in-memory history after DB write succeeds
							this.history.push({ role: "assistant", text: assistantText });
							for (const te of pendingToolEvents) {
								db.appendToolEvent(
									sessionId,
									assistantSeq,
									te.toolId,
									te.name,
									te.input,
								).catch((e) =>
									console.error("[db] appendToolEvent failed:", e),
								);
							}
							pendingToolEvents.length = 0;
							assistantText = "";
						}
					}
					const tokensInContext = lastTurnUsage
						? lastTurnUsage.input_tokens +
							(lastTurnUsage.cache_read_input_tokens ?? 0) +
							(lastTurnUsage.cache_creation_input_tokens ?? 0)
						: null;
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
						context_window: queryData.context_window ?? 200_000,
						max_output_tokens: primaryModel?.maxOutputTokens ?? null,
						stop_reason: queryData.stop_reason,
						tokens_in_context: tokensInContext,
					});
				}
			}

			this.state = "idle";
		} catch (err) {
			this.state = "error";
			const msg = err instanceof Error ? err.message : "Unknown error";
			console.error("[session] runQuery error:", err);
			emit({ type: "error", message: msg });
		} finally {
			// Persist any remaining assistant text (error/abort path — result block clears it on success)
			if (assistantText) {
				if (sessionId) {
					const assistantSeq = this.messageSeq++;
					try {
						await db.appendMessage(
							sessionId,
							assistantSeq,
							"assistant",
							assistantText,
						);
						// Only push to in-memory history after DB write succeeds
						this.history.push({ role: "assistant", text: assistantText });
						for (const te of pendingToolEvents) {
							db.appendToolEvent(
								sessionId,
								assistantSeq,
								te.toolId,
								te.name,
								te.input,
							).catch((e) =>
								console.error("[db] appendToolEvent (finally) failed:", e),
							);
						}
					} catch (e) {
						console.error("[db] appendMessage (assistant) failed:", e);
					}
				} else {
					this.history.push({ role: "assistant", text: assistantText });
				}
			}
			this.abortController = null;
			emit({ type: "status", state: this.state, model: this.model });
		}
	}
}
