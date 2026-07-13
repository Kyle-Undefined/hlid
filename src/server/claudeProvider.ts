import type {
	SDKControlGetUsageResponse,
	SDKMessage,
	EffortLevel as SdkEffortLevel,
	ModelInfo as SdkModelInfo,
	PermissionMode as SdkPermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeExecutable } from "../lib/claudePath";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	McpServerStatus,
	ProviderAccountInfo,
	ProviderContextUsage,
	ProviderEffortInfo,
	ProviderModelInfo,
	ProviderWindowReading,
	SendOptions,
	SlashCommand,
	SubagentSnapshot,
} from "./agentProvider";

/**
 * Permission modes hlid's AgentQueryParams/agent-agnostic layer knows about.
 * The SDK's PermissionMode also includes 'dontAsk' | 'auto', which hlid never
 * sends — setPermissionMode() rejects anything outside this set with a clear
 * error rather than silently forwarding an unsupported mode to the SDK.
 */
const KNOWN_PERMISSION_MODES = new Set<string>([
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
]);

function effectiveSdkPermissionMode(
	mode: AgentQueryParams["permissionMode"],
	policyEnforced: boolean,
): SdkPermissionMode {
	// When Umbod is enabled it owns tool authorization. Claude must stay in its
	// ordinary SDK mode; forwarding bypassPermissions would require the process
	// to have been launched with --dangerously-skip-permissions and fails on the
	// second turn of an otherwise healthy long-lived session.
	return policyEnforced && mode === "bypassPermissions"
		? "default"
		: (mode ?? "default");
}

type SdkQuery = ReturnType<typeof query>;

type ClaudeUsageWindow = {
	utilization: number | null;
	resets_at: string | null;
};

function usageResetTime(value: string | null | undefined): number | null {
	if (!value) return null;
	const millis = Date.parse(value);
	return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

function mapUsageWindow(
	window: ClaudeUsageWindow | null | undefined,
	windowId: string,
	label: string,
): ProviderWindowReading[] {
	const raw = window?.utilization;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return [];
	return [
		{
			windowId,
			label,
			// The structured Claude usage API documents utilization as 0-100.
			utilization: Math.min(Math.max(raw / 100, 0), 1),
			remaining: null,
			limit: null,
			resetsAt: usageResetTime(window?.resets_at),
		},
	];
}

/** Normalize Claude's structured /usage response into Hlid window readings. */
export function mapClaudeUsageWindows(
	response: Pick<
		SDKControlGetUsageResponse,
		"rate_limits_available" | "rate_limits"
	>,
): ProviderWindowReading[] {
	if (!response.rate_limits_available || !response.rate_limits) return [];
	return [
		...mapUsageWindow(response.rate_limits.five_hour, "five_hour", "5-HOUR"),
		...mapUsageWindow(response.rate_limits.seven_day, "weekly", "7-DAY"),
		...mapUsageWindow(
			response.rate_limits.seven_day_sonnet,
			"weekly_sonnet",
			"SONNET",
		),
	];
}

// SDKUserMessage shape per @anthropic-ai/claude-agent-sdk's sdk.d.ts. Kept
// minimal here to avoid pulling the deep SDK type — the SDK accepts any
// object matching this shape.
type SdkUserMessage = {
	type: "user";
	message: { role: "user"; content: Array<{ type: "text"; text: string }> };
	parent_tool_use_id: null;
	priority?: "now" | "next" | "later";
};

/**
 * Internal queue+waiter feeding the SDK's AsyncIterable<SDKUserMessage> input.
 * Slice B: replaces the per-turn `prompt: string` model with a long-lived
 * stream — multiple send() calls on the AgentSession push onto this queue;
 * the SDK consumes them as separate user turns.
 */
class InputStream {
	private buffer: SdkUserMessage[] = [];
	private waiters: Array<(v: SdkUserMessage | null) => void> = [];
	private closed = false;

	push(msg: SdkUserMessage): void {
		if (this.closed) return;
		const w = this.waiters.shift();
		if (w) w(msg);
		else this.buffer.push(msg);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		while (this.waiters.length > 0) {
			const w = this.waiters.shift();
			w?.(null);
		}
	}

	async *iterate(): AsyncGenerator<SdkUserMessage> {
		while (true) {
			if (this.buffer.length > 0) {
				const next = this.buffer.shift();
				if (next) yield next;
				continue;
			}
			if (this.closed) return;
			const next = await new Promise<SdkUserMessage | null>((resolve) => {
				this.waiters.push(resolve);
			});
			if (next === null) return;
			yield next;
		}
	}
}

function buildSdkUserMessage(
	text: string,
	priority: "now" | "next" | "later",
): SdkUserMessage {
	return {
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
		parent_tool_use_id: null,
		priority,
	};
}

type EventTranslation = {
	events: AgentEvent[];
	hadText: boolean;
};

type ClaudeTaskMessage = Extract<SDKMessage, { type: "system" }> &
	Record<string, unknown>;

type ClaudeSubagentMetadata = Pick<SubagentSnapshot, "name" | "model">;

class ClaudeSubagentTracker {
	private snapshots = new Map<string, SubagentSnapshot>();
	private toolIds = new Map<string, string>();
	private toolMetadata = new Map<string, ClaudeSubagentMetadata>();

	/** Capture fields exposed on Claude's Agent tool before task_started arrives. */
	recordTool(toolId: string, input: unknown): SubagentSnapshot | undefined {
		const toolInput =
			typeof input === "object" && input !== null
				? (input as Record<string, unknown>)
				: {};
		const previous = this.toolMetadata.get(toolId);
		const metadata: ClaudeSubagentMetadata = {
			...previous,
			...(typeof toolInput.name === "string" && toolInput.name
				? { name: toolInput.name }
				: {}),
			...(typeof toolInput.model === "string" && toolInput.model
				? { model: toolInput.model }
				: previous?.model
					? { model: previous.model }
					: {}),
		};
		this.toolMetadata.set(toolId, metadata);

		for (const [taskId, mappedToolId] of this.toolIds) {
			if (mappedToolId !== toolId) continue;
			const current = this.snapshots.get(taskId);
			if (!current) return undefined;
			const subagent = { ...current, ...metadata };
			this.snapshots.set(taskId, subagent);
			return subagent;
		}
		return undefined;
	}

	snapshotForTool(toolId: string): SubagentSnapshot | undefined {
		for (const [taskId, mappedToolId] of this.toolIds) {
			if (mappedToolId === toolId) return this.snapshots.get(taskId);
		}
		return undefined;
	}

	/** Look up the current snapshot + originating toolId for a task, or null if untracked. */
	private resolveTask(
		taskId: string,
	): { current: SubagentSnapshot; toolId: string } | null {
		const current = this.snapshots.get(taskId);
		const toolId = this.toolIds.get(taskId);
		if (!current || !toolId) return null;
		return { current, toolId };
	}

	/**
	 * Resolve taskId, apply `patch` to build the next snapshot, store it, and
	 * emit the resulting tool_update event. Returns [] for an untracked taskId.
	 */
	private updateTask(
		taskId: string,
		patch: (current: SubagentSnapshot, toolId: string) => SubagentSnapshot,
	): AgentEvent[] {
		const resolved = this.resolveTask(taskId);
		if (!resolved) return [];
		const { current, toolId } = resolved;
		const subagent = patch(current, toolId);
		this.snapshots.set(taskId, subagent);
		return [{ type: "tool_update", toolId, subagent }];
	}

	/** Pull the raw usage delta + summary text off a task message, if present. */
	private extractUsageSummary(message: ClaudeTaskMessage): {
		usage:
			| { total_tokens?: number; tool_uses?: number; duration_ms?: number }
			| undefined;
		summary: string | undefined;
	} {
		return {
			usage: message.usage as
				| { total_tokens?: number; tool_uses?: number; duration_ms?: number }
				| undefined,
			summary:
				typeof message.summary === "string" ? message.summary : undefined,
		};
	}

	/** Merge partial usage fields (only known-number ones) onto the current usage. */
	private mergeUsage(
		current: SubagentSnapshot["usage"],
		usage:
			| { total_tokens?: number; tool_uses?: number; duration_ms?: number }
			| undefined,
	): SubagentSnapshot["usage"] {
		return {
			...current,
			...(typeof usage?.total_tokens === "number"
				? { totalTokens: usage.total_tokens }
				: {}),
			...(typeof usage?.tool_uses === "number"
				? { toolUses: usage.tool_uses }
				: {}),
			...(typeof usage?.duration_ms === "number"
				? { durationMs: usage.duration_ms }
				: {}),
		};
	}

	handleSystem(message: ClaudeTaskMessage): AgentEvent[] {
		const subtype = String(message.subtype ?? "");
		if (subtype === "task_started") return this.handleStarted(message);
		if (subtype === "task_progress") return this.handleProgress(message);
		if (subtype === "task_updated") return this.handleUpdated(message);
		if (subtype === "task_notification")
			return this.handleNotification(message);
		return [];
	}

	handleToolProgress(
		message: Extract<SDKMessage, { type: "tool_progress" }>,
	): AgentEvent[] {
		if (!message.task_id) return [];
		const current = this.snapshots.get(message.task_id);
		const toolId = this.toolIds.get(message.task_id);
		if (!current || !toolId) return [];
		const subagent: SubagentSnapshot = {
			...current,
			lastTool: message.tool_name,
			currentStep: `Using ${message.tool_name}`,
			usage: {
				...current.usage,
				durationMs: Math.round(message.elapsed_time_seconds * 1000),
			},
		};
		this.snapshots.set(message.task_id, subagent);
		return [{ type: "tool_update", toolId, subagent }];
	}

	private handleStarted(message: ClaudeTaskMessage): AgentEvent[] {
		const taskId = String(message.task_id ?? "");
		const isSubagent =
			message.task_type === "subagent" ||
			typeof message.subagent_type === "string";
		if (!taskId || !isSubagent || message.skip_transcript === true) return [];
		const originatingToolId =
			typeof message.tool_use_id === "string" && message.tool_use_id
				? message.tool_use_id
				: `claude-task-${taskId}`;
		const prompt =
			typeof message.prompt === "string" ? message.prompt : undefined;
		const description =
			typeof message.description === "string" ? message.description : undefined;
		const metadata = this.toolMetadata.get(originatingToolId);
		const subagent: SubagentSnapshot = {
			provider: "claude",
			agentId: taskId,
			taskId,
			...metadata,
			...(typeof message.subagent_type === "string"
				? { label: message.subagent_type }
				: {}),
			...(prompt ? { prompt } : {}),
			...(description ? { description, currentStep: description } : {}),
			status: "running",
			startedAtMs: Date.now(),
		};
		this.snapshots.set(taskId, subagent);
		this.toolIds.set(taskId, originatingToolId);
		if (typeof message.tool_use_id === "string" && message.tool_use_id) {
			return [{ type: "tool_update", toolId: originatingToolId, subagent }];
		}
		return [
			{
				type: "tool_start",
				toolId: originatingToolId,
				name: "Subagent",
				input: prompt ? { prompt } : {},
				subagent,
			},
		];
	}

	private handleProgress(message: ClaudeTaskMessage): AgentEvent[] {
		const taskId = String(message.task_id ?? "");
		const { usage, summary } = this.extractUsageSummary(message);
		return this.updateTask(taskId, (current) => {
			const description =
				typeof message.description === "string"
					? message.description
					: current.description;
			const lastTool =
				typeof message.last_tool_name === "string"
					? message.last_tool_name
					: current.lastTool;
			return {
				...current,
				...(description ? { description } : {}),
				...(lastTool ? { lastTool } : {}),
				currentStep:
					summary ??
					(lastTool
						? `Using ${lastTool}`
						: (description ?? current.currentStep)),
				usage: this.mergeUsage(current.usage, usage),
			};
		});
	}

	private handleUpdated(message: ClaudeTaskMessage): AgentEvent[] {
		const taskId = String(message.task_id ?? "");
		const patch = (message.patch ?? {}) as Record<string, unknown>;
		const rawStatus = String(patch.status ?? "");
		const status: SubagentSnapshot["status"] =
			rawStatus === "completed"
				? "completed"
				: rawStatus === "failed" || rawStatus === "killed"
					? "failed"
					: rawStatus === "paused"
						? "paused"
						: rawStatus === "pending"
							? "pending"
							: "running";
		const terminal = status === "completed" || status === "failed";
		return this.updateTask(taskId, (current) => ({
			...current,
			status,
			...(typeof patch.description === "string"
				? { description: patch.description, currentStep: patch.description }
				: {}),
			...(typeof patch.error === "string" ? { currentStep: patch.error } : {}),
			...(terminal
				? {
						endedAtMs:
							typeof patch.end_time === "number" ? patch.end_time : Date.now(),
					}
				: {}),
		}));
	}

	private handleNotification(message: ClaudeTaskMessage): AgentEvent[] {
		const taskId = String(message.task_id ?? "");
		const rawStatus = String(message.status ?? "");
		const status: SubagentSnapshot["status"] =
			rawStatus === "completed"
				? "completed"
				: rawStatus === "stopped"
					? "interrupted"
					: "failed";
		const { usage, summary } = this.extractUsageSummary(message);
		return this.updateTask(taskId, (current) => ({
			...current,
			status,
			...(summary ? { currentStep: summary } : {}),
			endedAtMs: Date.now(),
			usage: this.mergeUsage(current.usage, usage),
		}));
	}
}

function translateSystemMessage(
	message: Extract<SDKMessage, { type: "system" }>,
	hadText: boolean,
	tracker: ClaudeSubagentTracker,
): EventTranslation {
	if (message.subtype === "init") {
		return {
			events: [{ type: "session_start", sessionId: message.session_id }],
			hadText,
		};
	}
	if ((message as { subtype: string }).subtype === "local_command_output") {
		return {
			events: [
				{
					type: "local_command_output",
					content: (message as { content: string }).content,
				},
			],
			hadText,
		};
	}
	const taskEvents = tracker.handleSystem(message as ClaudeTaskMessage);
	if (taskEvents.length > 0) return { events: taskEvents, hadText };
	return { events: [], hadText };
}

function translateUserMessage(
	message: Extract<SDKMessage, { type: "user" }>,
	hadText: boolean,
): EventTranslation {
	const content = (message as { message?: { content?: unknown } }).message
		?.content;
	if (!Array.isArray(content)) return { events: [], hadText };
	const events = content.flatMap((block: Record<string, unknown>) => {
		if (block.type !== "tool_result") return [];
		const text = normalizeToolResultContent(block.content);
		return [
			{
				type: "tool_result" as const,
				toolId: String(block.tool_use_id ?? ""),
				content: truncateToolResult(text),
				...(block.is_error === true ? { isError: true } : {}),
			},
		];
	});
	return { events, hadText };
}

function translateAssistantMessage(
	message: Extract<SDKMessage, { type: "assistant" }>,
	hadText: boolean,
	tracker: ClaudeSubagentTracker,
): EventTranslation {
	const events: AgentEvent[] = [];
	const usage = message.message.usage;
	if (usage) {
		events.push({
			type: "usage",
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
			cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
			model: message.message.model,
		});
	}
	let nextHadText = hadText;
	for (const block of message.message.content) {
		if (block.type === "text") {
			nextHadText = true;
			events.push({ type: "text_delta", text: block.text });
		} else if (block.type === "tool_use") {
			const subagent =
				tracker.recordTool(block.id, block.input) ??
				tracker.snapshotForTool(block.id);
			events.push({
				type: "tool_start",
				toolId: block.id,
				name: block.name,
				input: block.input,
				...(subagent ? { subagent } : {}),
			});
		}
	}
	return { events, hadText: nextHadText };
}

function rateLimitResetTime(value: number | string | undefined): number | null {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		return Math.floor(new Date(value).getTime() / 1000);
	}
	return null;
}

function translateRateLimitMessage(
	message: Extract<SDKMessage, { type: "rate_limit_event" }>,
	hadText: boolean,
): EventTranslation {
	const info = message.rate_limit_info;
	const utilization =
		info.utilization != null && info.utilization >= 1
			? info.utilization / 100
			: info.utilization;
	return {
		events: [
			{
				type: "rate_limit",
				status: info.status,
				rateLimitType: info.rateLimitType,
				utilization,
				resetsAt: rateLimitResetTime(info.resetsAt),
			},
		],
		hadText,
	};
}

function resultUsage(
	message: Extract<SDKMessage, { type: "result" }>,
): Extract<AgentEvent, { type: "done" }>["usage"] {
	if (!message.usage) return undefined;
	return {
		inputTokens: message.usage.input_tokens,
		outputTokens: message.usage.output_tokens,
		cacheReadTokens: message.usage.cache_read_input_tokens ?? undefined,
		cacheCreationTokens: message.usage.cache_creation_input_tokens ?? undefined,
	};
}

function translateResultMessage(
	message: Extract<SDKMessage, { type: "result" }>,
	hadText: boolean,
): EventTranslation {
	const events: AgentEvent[] = [];
	if (!hadText && message.subtype === "success" && message.result) {
		events.push({ type: "text_delta", text: message.result });
	}
	events.push({
		type: "done",
		// Claude Code reports an API-equivalent per-run dollar value, not an
		// invoice-authoritative charge. Subscription runs incur no per-turn API
		// bill, and gateways may apply their own routing, discounts, or markup.
		// Keep it estimated unless a future billing integration supplies actuals.
		estimatedCost: message.total_cost_usd,
		turns: message.num_turns,
		durationMs: message.duration_ms ?? 0,
		stopReason: message.stop_reason ?? undefined,
		modelUsage: message.modelUsage as
			| Record<string, { contextWindow: number; maxOutputTokens: number }>
			| undefined,
		usage: resultUsage(message),
	});
	return { events, hadText: false };
}

function translateSdkMessage(
	message: SDKMessage,
	hadText: boolean,
	tracker: ClaudeSubagentTracker,
): EventTranslation {
	switch (message.type) {
		case "system":
			return translateSystemMessage(message, hadText, tracker);
		case "user":
			return translateUserMessage(message, hadText);
		case "assistant":
			return translateAssistantMessage(message, hadText, tracker);
		case "tool_use_summary":
			return {
				events: [{ type: "summary", text: message.summary }],
				hadText,
			};
		case "tool_progress":
			return { events: tracker.handleToolProgress(message), hadText };
		case "rate_limit_event":
			return translateRateLimitMessage(message, hadText);
		case "result":
			return translateResultMessage(message, hadText);
		default:
			return { events: [], hadText };
	}
}

class ClaudeAgentSession implements AgentSession {
	private abortController: AbortController;
	private makeQuery: (
		input: AsyncIterable<SdkUserMessage>,
		resumeId: string | undefined,
	) => SdkQuery;
	private resumeId: string | undefined;
	private inputStream: InputStream = new InputStream();
	private sdkQuery: SdkQuery | null = null;
	private cachedIter: AsyncIterator<AgentEvent> | null = null;
	private firstSend: SdkUserMessage | null = null;
	private receivedAnyEvent = false;
	private retriedWithoutResume = false;
	private subagents = new ClaudeSubagentTracker();

	constructor(
		makeQuery: (
			input: AsyncIterable<SdkUserMessage>,
			resumeId: string | undefined,
		) => SdkQuery,
		abortController: AbortController,
		resumeId: string | undefined,
		private readonly policyEnforced: boolean,
	) {
		this.makeQuery = makeQuery;
		this.abortController = abortController;
		this.resumeId = resumeId;
	}

	cancel(): void {
		this.inputStream.close();
		this.abortController.abort();
	}

	closeInput(): void {
		this.inputStream.close();
	}

	async interrupt(): Promise<void> {
		// SDK's Query.interrupt() is only available in streaming-input mode,
		// which we always use. Stops the current assistant turn early; the
		// session stays alive for subsequent send()s.
		if (!this.sdkQuery) return;
		await this.sdkQuery.interrupt();
	}

	async send(message: string, opts?: SendOptions): Promise<void> {
		const sdkMsg = buildSdkUserMessage(message, opts?.priority ?? "next");
		// Capture the first send so we can replay it if cold-resume retry kicks in.
		if (this.firstSend === null) this.firstSend = sdkMsg;
		// Lazily open the SDK query on first send so an empty session that's
		// never sent doesn't spawn the CLI.
		this.ensureSdkQuery();
		this.inputStream.push(sdkMsg);
	}

	async mcpServerStatus(): Promise<McpServerStatus[]> {
		if (!this.sdkQuery) return [];
		return this.sdkQuery.mcpServerStatus() as Promise<McpServerStatus[]>;
	}

	async supportedCommands(): Promise<SlashCommand[]> {
		if (!this.sdkQuery) return [];
		return this.sdkQuery.supportedCommands() as Promise<SlashCommand[]>;
	}

	async usageWindows(): Promise<ProviderWindowReading[]> {
		if (!this.sdkQuery) return [];
		try {
			const usage =
				await this.sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
			return mapClaudeUsageWindows(usage);
		} catch {
			// API-key/Bedrock/Vertex sessions and older Claude builds may not expose
			// subscription limits. Header/event tracking remains the fallback.
			return [];
		}
	}

	async contextUsage(): Promise<ProviderContextUsage | null> {
		if (!this.sdkQuery) return null;
		try {
			const usage = await this.sdkQuery.getContextUsage();
			const contextWindow = usage.rawMaxTokens || usage.maxTokens;
			if (usage.totalTokens < 0 || contextWindow <= 0) return null;
			return {
				contextTokens: usage.totalTokens,
				contextWindow,
				...(usage.model ? { model: usage.model } : {}),
			};
		} catch {
			// Older Claude builds may not expose the context control method.
			return null;
		}
	}

	/**
	 * Mid-session model switch. Delegates to the SDK Query's setModel(), only
	 * available once the stream is open (first send() has happened). No-op
	 * when the SDK query hasn't been created yet — mirrors the
	 * mcpServerStatus()/supportedCommands() null-guard pattern.
	 */
	async setModel(model?: string): Promise<void> {
		if (!this.sdkQuery) return;
		await this.sdkQuery.setModel(model);
	}

	/**
	 * Mid-session permission-mode switch. Validates against the modes hlid's
	 * AgentQueryParams supports before forwarding to the SDK — the SDK's
	 * PermissionMode is a superset ('dontAsk' | 'auto' besides ours) that
	 * hlid has no UI/config path for, so an unknown value is rejected here
	 * rather than passed through.
	 */
	async setPermissionMode(mode: string): Promise<void> {
		if (!KNOWN_PERMISSION_MODES.has(mode)) {
			throw new Error(`Unknown permission mode: ${mode}`);
		}
		if (!this.sdkQuery) return;
		await this.sdkQuery.setPermissionMode(
			effectiveSdkPermissionMode(
				mode as AgentQueryParams["permissionMode"],
				this.policyEnforced,
			),
		);
	}

	/**
	 * Account info for the authenticated session. Returns null when the SDK
	 * query hasn't been created yet (mirrors the other optional methods'
	 * null-guard) or when the SDK call itself fails (e.g. not logged in).
	 */
	async accountInfo(): Promise<ProviderAccountInfo | null> {
		if (!this.sdkQuery) return null;
		try {
			const info = await this.sdkQuery.accountInfo();
			return {
				email: info.email,
				organization: info.organization,
				subscriptionType: info.subscriptionType,
			};
		} catch {
			return null;
		}
	}

	private ensureSdkQuery(): void {
		if (this.sdkQuery) return;
		this.sdkQuery = this.makeQuery(this.inputStream.iterate(), this.resumeId);
	}

	[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
		if (!this.cachedIter) {
			this.cachedIter = this.createIterator();
		}
		const inner = this.cachedIter;
		// Wrap so that `for await` breaking out of the loop (via `return` in
		// iterateConversation when a `done` event arrives) does NOT call
		// inner.return() and close the underlying AsyncGenerator. Without this
		// wrap, the cached iterator gets terminated at the first turn boundary
		// and subsequent runQuery calls receive no events forever — observed
		// as "second user message sits with no response".
		return {
			next: () => inner.next(),
			return: async () =>
				({ value: undefined, done: true }) as IteratorResult<AgentEvent>,
		};
	}

	private createIterator(): AsyncIterator<AgentEvent> {
		// Capture `this` for the generator below.
		const self = this;
		const generator = (async function* (): AsyncGenerator<AgentEvent> {
			self.ensureSdkQuery();
			try {
				yield* self.translateEvents();
			} catch (err) {
				// Cold-resume retry: if the persisted resume id was rotated/wiped
				// by the CLI, the first iteration fails before any event arrives.
				// Recreate the SDK query without resume and replay the first send.
				if (
					self.resumeId !== undefined &&
					!self.receivedAnyEvent &&
					!self.retriedWithoutResume
				) {
					self.retriedWithoutResume = true;
					self.resumeId = undefined;
					// Fresh input stream so the SDK consumes the replayed msg.
					self.inputStream.close();
					self.inputStream = new InputStream();
					self.sdkQuery = self.makeQuery(self.inputStream.iterate(), undefined);
					if (self.firstSend) self.inputStream.push(self.firstSend);
					yield* self.translateEvents();
					return;
				}
				throw err;
			}
		})();
		return generator[Symbol.asyncIterator]();
	}

	private async *translateEvents(): AsyncGenerator<AgentEvent> {
		const sdkQuery = this.sdkQuery;
		if (!sdkQuery) return;
		let hadText = false;
		for await (const message of sdkQuery) {
			this.receivedAnyEvent = true;
			const translation = translateSdkMessage(message, hadText, this.subagents);
			hadText = translation.hadText;
			yield* translation.events;
		}
	}
}

const TOOL_RESULT_MAX_BYTES = 8192;

function normalizeToolResultContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("");
}

function truncateToolResult(s: string): string {
	if (s.length <= TOOL_RESULT_MAX_BYTES) return s;
	const dropped = s.length - TOOL_RESULT_MAX_BYTES;
	return `${s.slice(0, TOOL_RESULT_MAX_BYTES)}\n\n[truncated ${dropped} chars]`;
}

/** Static effortLevels label/desc text, reused by mapClaudeModels for per-model effort entries. */
const EFFORT_TEXT: Record<string, { label: string; desc: string }> = {
	low: { label: "Low", desc: "minimal thinking, quick turnaround" },
	medium: { label: "Medium", desc: "some thinking, pretty balanced" },
	high: { label: "High", desc: "solid reasoning, this is the default" },
	xhigh: { label: "X-High", desc: "goes deeper, Opus only" },
	max: { label: "Max", desc: "everything Claude has, Opus only" },
};

/**
 * Pure mapper from the SDK's Query.supportedModels() ModelInfo[] shape to the
 * provider-agnostic ProviderModelInfo[]. No isDefault — the SDK has no
 * default-model marker.
 */
export function mapClaudeModels(models: SdkModelInfo[]): ProviderModelInfo[] {
	return models.map((m) => {
		const efforts: ProviderEffortInfo[] | undefined =
			m.supportsEffort && m.supportedEffortLevels?.length
				? m.supportedEffortLevels.map((value) => {
						const text = EFFORT_TEXT[value];
						return {
							value,
							label: text?.label ?? value,
							desc: text?.desc,
						};
					})
				: undefined;
		return {
			value: m.value,
			label: m.displayName || m.value,
			description: m.description,
			efforts,
		};
	});
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(
				() => reject(new Error("Claude supportedModels() timed out")),
				timeoutMs,
			);
		}),
	]);
}

/** Parse Anthropic rate-limit utilization headers from an API response. */
function parseAnthropicHeaders(headers: Headers): ProviderWindowReading[] {
	const readings: ProviderWindowReading[] = [];

	function toUnix(s: string | null): number | null {
		if (!s) return null;
		if (/^\d+$/.test(s.trim())) {
			const seconds = Number(s);
			return Number.isFinite(seconds) ? seconds : null;
		}
		const millis = Date.parse(s);
		return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
	}

	const windows = [
		[
			"anthropic-ratelimit-unified-5h-utilization",
			"anthropic-ratelimit-unified-5h-reset",
			"five_hour",
			"5-HOUR",
		],
		[
			"anthropic-ratelimit-unified-7d-utilization",
			"anthropic-ratelimit-unified-7d-reset",
			"weekly",
			"7-DAY",
		],
		[
			"anthropic-ratelimit-unified-7d_sonnet-utilization",
			"anthropic-ratelimit-unified-7d_sonnet-reset",
			"weekly_sonnet",
			"SONNET",
		],
	] as const;

	for (const [utilHeader, resetHeader, windowId, label] of windows) {
		const h = headers.get(utilHeader);
		if (h === null) continue;
		const raw = parseFloat(h);
		if (!Number.isFinite(raw)) continue;
		readings.push({
			windowId,
			label,
			utilization: raw >= 1 ? raw / 100 : raw,
			remaining: null,
			limit: null,
			resetsAt: toUnix(headers.get(resetHeader)),
		});
	}

	return readings;
}

export class ClaudeProvider implements AgentProvider {
	readonly providerId = "claude";
	readonly label = "Claude";
	// The SDK's streaming-input query is lazy — probes must send a turn first.
	readonly probeRequiresTurn = true;

	readonly models = [
		{ value: "claude-opus-4-8", label: "Opus 4.8" },
		{ value: "claude-opus-4-7", label: "Opus 4.7" },
		{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
		{ value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
	] as const;

	readonly effortLevels = [
		{ value: "low", label: "Low", desc: "minimal thinking, quick turnaround" },
		{
			value: "medium",
			label: "Medium",
			desc: "some thinking, pretty balanced",
		},
		{
			value: "high",
			label: "High",
			desc: "solid reasoning, this is the default",
		},
		{ value: "xhigh", label: "X-High", desc: "goes deeper, Opus only" },
		{
			value: "max",
			label: "Max",
			desc: "everything Claude has, Opus only",
		},
	] as const;

	readonly permissionModes = [
		{
			value: "default",
			label: "Ask for approval",
			desc: "asks before doing anything",
		},
		{
			value: "acceptEdits",
			label: "Auto-approve edits",
			desc: "edits go through automatically, everything else still asks",
		},
		{
			value: "bypassPermissions",
			label: "Auto-approve all",
			desc: "everything goes through, no interruptions",
		},
	] as const;

	// Anthropic retired the Sonnet-only weekly limit — no weekly_sonnet window.
	readonly usageWindows = [
		{ windowId: "five_hour", label: "5-HOUR", windowSecs: 5 * 3600 },
		{ windowId: "weekly", label: "7-DAY", windowSecs: 7 * 86400 },
	] as const;

	async check(): Promise<{ available: boolean; reason?: string }> {
		const exe = resolveClaudeExecutable();
		if (exe === undefined) {
			return { available: false, reason: "Claude Code CLI not found" };
		}
		return { available: true };
	}

	/**
	 * Live-fetch the model catalog via a throwaway SDK query — no real prompt
	 * is ever sent; the stream stays open until abort() and canUseTool denies
	 * everything as a defensive backstop. Falls back to the static `models`
	 * array on failure (handled by callers).
	 */
	async listModels(): Promise<ProviderModelInfo[]> {
		const exe = resolveClaudeExecutable();
		const ac = new AbortController();
		// biome-ignore lint/suspicious/noExplicitAny: SDK canUseTool type changed between versions
		const denyAllCanUseTool: any = async () => ({
			behavior: "deny",
			message: "catalog probe",
		});
		const q = query({
			prompt: (async function* (): AsyncGenerator<SdkUserMessage> {
				// Never yields — the probe never sends a real user turn.
				await new Promise<never>(() => {});
			})(),
			options: {
				cwd: process.cwd(),
				abortController: ac,
				persistSession: false,
				settingSources: [],
				maxTurns: 1,
				...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
				canUseTool: denyAllCanUseTool,
			},
		});
		try {
			return mapClaudeModels(await withTimeout(q.supportedModels(), 10_000));
		} finally {
			ac.abort();
		}
	}

	readonly proxyConfig = {
		envVar: "ANTHROPIC_BASE_URL",
		windowIds: ["five_hour", "weekly", "weekly_sonnet"],
		parseHeaders: parseAnthropicHeaders,
	};

	query(params: AgentQueryParams): AgentSession {
		const abortController = new AbortController();

		if (params.signal) {
			if (params.signal.aborted) {
				abortController.abort();
			} else {
				params.signal.addEventListener("abort", () => abortController.abort(), {
					once: true,
				});
			}
		}

		const makeQuery = (
			input: AsyncIterable<SdkUserMessage>,
			resumeId: string | undefined,
		): SdkQuery =>
			query({
				prompt: input as unknown as Parameters<typeof query>[0]["prompt"],
				options: {
					cwd: params.cwd,
					...(params.additionalDirectories?.length
						? { additionalDirectories: params.additionalDirectories }
						: {}),
					abortController,
					...(params.model ? { model: params.model } : {}),
					permissionMode: effectiveSdkPermissionMode(
						params.permissionMode,
						params.policyEnforced ?? false,
					),
					effort: (params.effort ?? "medium") as SdkEffortLevel,
					...(params.maxTurns !== undefined
						? { maxTurns: params.maxTurns }
						: {}),
					...(params.executable
						? { pathToClaudeCodeExecutable: params.executable }
						: {}),
					allowDangerouslySkipPermissions:
						params.permissionMode === "bypassPermissions" &&
						!params.policyEnforced,
					...(params.beforeToolUse && !params.policyEnforced
						? {
								hooks: {
									PreToolUse: [
										{
											timeout: 86_460,
											hooks: [
												async (
													input: unknown,
													toolUseID: string | undefined,
													hook: { signal: AbortSignal },
												) => {
													const preTool = input as {
														tool_name?: string;
														tool_input?: unknown;
													};
													const result = await params.beforeToolUse?.(
														preTool.tool_name ?? "Tool",
														preTool.tool_input,
														{ toolUseID, signal: hook.signal },
													);
													return result === "aborted"
														? {
																continue: false,
																stopReason:
																	"Aborted while sleeping on usage limit",
															}
														: { continue: true };
												},
											],
										},
									],
								},
							}
						: {}),
					settingSources: params.settingSources ?? ["user", "project", "local"],
					...(resumeId !== undefined ? { resume: resumeId } : {}),
					...(params.persistSession === false ? { persistSession: false } : {}),
					// biome-ignore lint/suspicious/noExplicitAny: SDK canUseTool type changed between versions
					canUseTool: params.canUseTool as any,
				},
			});

		return new ClaudeAgentSession(
			makeQuery,
			abortController,
			params.sessionId,
			params.policyEnforced ?? false,
		);
	}
}
