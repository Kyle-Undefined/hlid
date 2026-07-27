import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type {
	SDKControlGetUsageResponse,
	SDKMessage,
	EffortLevel as SdkEffortLevel,
	ModelInfo as SdkModelInfo,
	PermissionMode as SdkPermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import {
	createSdkMcpServer,
	forkSession as forkClaudeSession,
	getSessionMessages as getSdkSessionMessages,
	query,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeExecutable } from "../lib/claudePath";
import { parseWslUnc, toHostRuntimePath } from "../lib/paths";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	CanUseTool,
	ForkSessionParams,
	ForkSessionResult,
	McpServerStatus,
	ProviderAccountInfo,
	ProviderContextUsage,
	ProviderEffortInfo,
	ProviderModelInfo,
	ProviderSavedWorkflow,
	ProviderSkillInfo,
	ProviderWindowReading,
	ProviderWorkflowCatalog,
	ProviderWorkflowDeleteInput,
	ProviderWorkflowSaveInput,
	ProviderWorkflowSourceInput,
	SendOptions,
	SlashCommand,
	SubagentSnapshot,
} from "./agentProvider";
import { toAgentToolCallResult } from "./agentToolResult";
import { createClaudeHistorySessionStore } from "./claudeHistorySessionStore";
import {
	deleteClaudeWorkflow,
	listClaudeWorkflows,
	readClaudeWorkflowSource,
	resolveWslClaudeConfigDir,
	saveClaudeWorkflow,
} from "./claudeWorkflows";
import {
	executeHlidAgentToolRich,
	HLID_AGENT_NAMESPACE,
	HLID_AGENT_NAMESPACE_DESCRIPTION,
	HLID_AGENT_TOOL_SPECS,
	hlidAgentSchemas,
} from "./hlidAgentTools";
import {
	executeObsidianAgentTool,
	OBSIDIAN_AGENT_NAMESPACE,
	OBSIDIAN_AGENT_NAMESPACE_DESCRIPTION,
	OBSIDIAN_AGENT_TOOL_SPECS,
	obsidianAgentSchemas,
} from "./obsidianAgentTools";

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

function createHlidSdkServer(params: AgentQueryParams) {
	return createSdkMcpServer({
		name: HLID_AGENT_NAMESPACE,
		version: "1",
		instructions: HLID_AGENT_NAMESPACE_DESCRIPTION,
		tools: HLID_AGENT_TOOL_SPECS.map((spec) =>
			tool(
				spec.name,
				spec.description,
				// biome-ignore lint/suspicious/noExplicitAny: the SDK accepts each Zod shape, while map() widens them to a union.
				hlidAgentSchemas[spec.name].shape as any,
				(input) =>
					toAgentToolCallResult(() =>
						executeHlidAgentToolRich(spec.name, input, {
							providerId: params.providerId ?? "claude",
							model: params.model,
							effort: params.effort,
							permissionMode: params.permissionMode,
							policyEnforced: params.policyEnforced,
							runtimeCwd: params.cwd,
							sessionId: params.hostSessionId,
							vaultName: params.vaultName,
							agentMode: params.agentMode,
						}),
					),
				{
					annotations: {
						readOnlyHint: spec.readOnly,
						destructiveHint: false,
						idempotentHint: spec.readOnly,
					},
					searchHint: spec.searchHint,
					alwaysLoad: !spec.deferLoading,
				},
			),
		),
	});
}

function createObsidianSdkServer(
	forceRunCommandApproval?: CanUseTool,
	signal?: AbortSignal,
) {
	return createSdkMcpServer({
		name: OBSIDIAN_AGENT_NAMESPACE,
		version: "1",
		instructions: OBSIDIAN_AGENT_NAMESPACE_DESCRIPTION,
		tools: OBSIDIAN_AGENT_TOOL_SPECS.map((spec) =>
			tool(
				spec.name,
				spec.description,
				// biome-ignore lint/suspicious/noExplicitAny: the SDK accepts the Zod shape for each discriminated tool, while map() widens it to their union.
				obsidianAgentSchemas[spec.name].shape as any,
				(input) =>
					toAgentToolCallResult(async () => {
						if (spec.name === "run_command" && forceRunCommandApproval) {
							const decision = await forceRunCommandApproval(
								`mcp__${OBSIDIAN_AGENT_NAMESPACE}__run_command`,
								input,
								{
									toolUseID: `hlid-obsidian-run-command-${crypto.randomUUID()}`,
									signal: signal ?? new AbortController().signal,
									title: "Obsidian run command",
								},
							);
							if (decision.behavior === "deny") {
								throw new Error(
									decision.message ?? "The Obsidian command was not approved.",
								);
							}
						}
						return executeObsidianAgentTool(spec.name, input);
					}),
				{
					annotations: {
						readOnlyHint: spec.readOnly,
						destructiveHint: false,
						idempotentHint: spec.readOnly,
					},
					searchHint: spec.searchHint,
					alwaysLoad: !spec.deferLoading,
				},
			),
		),
	});
}

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

type ClaudeMessageWait =
	| { kind: "message"; result: IteratorResult<SDKMessage> }
	| { kind: "timeout" };

async function waitForClaudeMessage(
	promise: Promise<IteratorResult<SDKMessage>>,
	timeoutMs?: number,
): Promise<ClaudeMessageWait> {
	if (timeoutMs === undefined) {
		return { kind: "message", result: await promise };
	}
	if (timeoutMs <= 0) return { kind: "timeout" };
	return new Promise<ClaudeMessageWait>((resolve, reject) => {
		const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
		promise.then(
			(result) => {
				clearTimeout(timer);
				resolve({ kind: "message", result });
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

type ClaudeTokenBuckets = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
};

const EMPTY_CLAUDE_USAGE: ClaudeTokenBuckets = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
};

// Claude can return the root result while an Agent task continues in the
// background. Keep the Hlid query open long enough to collect that owned
// child's final assistant usage, but never let a missing task notification
// hold the session open forever.
const CLAUDE_BACKGROUND_SETTLE_TIMEOUT_MS = 10 * 60_000;
const CLAUDE_BACKGROUND_USAGE_DRAIN_MS = 250;
const CLAUDE_WORKFLOW_CONTINUATION_GRACE_MS = 60_000;
const CLAUDE_WORKFLOW_PROGRESS_REFRESH_MS = 1_000;
const CLAUDE_WORKFLOW_PROGRESS_READ_TIMEOUT_MS = 1_500;
const CLAUDE_WORKFLOW_PROGRESS_MAX_BYTES = 8 * 1024 * 1024;

function claudeUsageBuckets(
	usage:
		| {
				input_tokens?: number;
				output_tokens?: number;
				cache_read_input_tokens?: number | null;
				cache_creation_input_tokens?: number | null;
		  }
		| null
		| undefined,
): ClaudeTokenBuckets | null {
	if (!usage) return null;
	return {
		inputTokens: usage.input_tokens ?? 0,
		outputTokens: usage.output_tokens ?? 0,
		cacheReadTokens: usage.cache_read_input_tokens ?? 0,
		cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
	};
}

function addClaudeUsage(
	a: ClaudeTokenBuckets,
	b: ClaudeTokenBuckets,
): ClaudeTokenBuckets {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
		cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
	};
}

function claudeUsageEquals(
	a: ClaudeTokenBuckets,
	b: ClaudeTokenBuckets,
): boolean {
	return (
		a.inputTokens === b.inputTokens &&
		a.outputTokens === b.outputTokens &&
		a.cacheReadTokens === b.cacheReadTokens &&
		a.cacheCreationTokens === b.cacheCreationTokens
	);
}

/**
 * Claude's result.usage has historically covered the root API calls but not
 * child Agent calls. The SDK does stream those child assistant messages with a
 * parent_tool_use_id, so retain the latest usage snapshot for each API message
 * id and add children only when the root stream exactly fingerprints the result.
 * Newer SDKs that already return the combined total are detected and left alone.
 */
class ClaudeTurnUsageAccumulator {
	private calls = new Map<
		string,
		{ usage: ClaudeTokenBuckets; child: boolean }
	>();
	private ambiguousIds = new Set<string>();

	record(message: Extract<SDKMessage, { type: "assistant" }>): void {
		const messageId = message.message.id;
		const usage = claudeUsageBuckets(message.message.usage);
		if (typeof messageId !== "string" || !messageId || !usage) return;
		if (this.ambiguousIds.has(messageId)) return;
		const child = message.parent_tool_use_id != null;
		const previous = this.calls.get(messageId);
		// A single API response can be delivered more than once as its content
		// grows. Keep the latest snapshot, but never reclassify an id across root
		// and child ownership.
		if (previous && previous.child !== child) {
			this.calls.delete(messageId);
			this.ambiguousIds.add(messageId);
			return;
		}
		this.calls.set(messageId, { usage, child });
	}

	reconcileMany(
		results: ReadonlyArray<Extract<SDKMessage, { type: "result" }>>,
	): ClaudeTokenBuckets | null {
		let reported: ClaudeTokenBuckets | null = null;
		for (const result of results) {
			const current = claudeUsageBuckets(result.usage);
			if (!current) continue;
			reported = reported ? addClaudeUsage(reported, current) : current;
		}
		if (!reported) return null;
		let root = { ...EMPTY_CLAUDE_USAGE };
		let children = { ...EMPTY_CLAUDE_USAGE };
		for (const call of this.calls.values()) {
			if (call.child) children = addClaudeUsage(children, call.usage);
			else root = addClaudeUsage(root, call.usage);
		}
		const combined = addClaudeUsage(root, children);
		if (claudeUsageEquals(reported, combined)) return reported;
		if (claudeUsageEquals(reported, root)) return combined;
		return reported;
	}

	reset(): void {
		this.calls.clear();
		this.ambiguousIds.clear();
	}
}

type ClaudeTaskMessage = Extract<SDKMessage, { type: "system" }> &
	Record<string, unknown>;

type ClaudeSubagentMetadata = Pick<
	SubagentSnapshot,
	| "name"
	| "model"
	| "kind"
	| "activityType"
	| "workflowRunId"
	| "workflowScriptPath"
	| "workflowTranscriptDir"
	| "workflowSessionUrl"
> & {
	parentToolUseId?: string;
	workflowStatePath?: string;
	workflowJournalPath?: string;
};

type ClaudeWorkflowProgressReader = (
	runtimeCwd: string,
	providerPath: string,
) => Promise<unknown>;

type ClaudeWorkflowAgentProgress = {
	agentId: string;
	label?: string;
	phaseTitle?: string;
	model?: string;
	effort?: string;
	attempt?: number;
	state?: string;
	startedAt?: number;
	queuedAt?: number;
	lastProgressAt?: number;
	durationMs?: number;
	tokens?: number;
	toolCalls?: number;
	lastToolName?: string;
	lastToolSummary?: string;
	promptPreview?: string;
	resultPreview?: string;
};

type ClaudeWorkflowAgentProgressRecord = ClaudeWorkflowAgentProgress & {
	type: "workflow_agent";
};

const CLAUDE_WORKFLOW_STRING_FIELDS = [
	"label",
	"phaseTitle",
	"model",
	"effort",
	"state",
	"lastToolName",
	"lastToolSummary",
	"promptPreview",
	"resultPreview",
] as const satisfies ReadonlyArray<keyof ClaudeWorkflowAgentProgress>;

const CLAUDE_WORKFLOW_NUMBER_FIELDS = [
	"attempt",
	"startedAt",
	"queuedAt",
	"lastProgressAt",
	"durationMs",
	"tokens",
	"toolCalls",
] as const satisfies ReadonlyArray<keyof ClaudeWorkflowAgentProgress>;

const CLAUDE_WORKFLOW_JOURNAL_STATES: Readonly<Record<string, string>> = {
	completed: "done",
	error: "error",
	failed: "error",
	killed: "stopped",
	result: "done",
	skipped: "skipped",
	stopped: "stopped",
};

function recordValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function firstStringField(
	record: Record<string, unknown>,
	...keys: ReadonlyArray<string>
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function copyClaudeWorkflowProgressFields<
	T extends ClaudeWorkflowAgentProgress,
>(base: T, source: Record<string, unknown>): T {
	const progress = { ...base };
	const writable = progress as unknown as Record<string, unknown>;
	for (const key of CLAUDE_WORKFLOW_STRING_FIELDS) {
		const value = source[key];
		if (typeof value === "string") writable[key] = value;
	}
	for (const key of CLAUDE_WORKFLOW_NUMBER_FIELDS) {
		const value = source[key];
		if (typeof value === "number") writable[key] = value;
	}
	return progress;
}

function withoutUndefined<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, field]) => field !== undefined),
	) as T;
}

function parseJsonValue(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start < 0 || end <= start) return null;
		try {
			return JSON.parse(text.slice(start, end + 1));
		} catch {
			return null;
		}
	}
}

function workflowOutputRecord(
	content: unknown,
): Record<string, unknown> | null {
	let value = content;
	if (Array.isArray(value)) {
		let text = "";
		for (const block of value) {
			const record = recordValue(block);
			if (record?.type === "text" && typeof record.text === "string") {
				text += record.text;
			}
		}
		value = text;
	}
	if (typeof value === "string") value = parseJsonValue(value.trim());
	return recordValue(value);
}

function journalEntryState(
	eventType: string,
	entry: Record<string, unknown>,
	currentState: string | undefined,
): string | undefined {
	return (
		CLAUDE_WORKFLOW_JOURNAL_STATES[eventType] ??
		firstStringField(entry, "state") ??
		currentState
	);
}

function acceptsJournalAttempt(
	agents: Map<string, ClaudeWorkflowAgentProgressRecord>,
	agentIdByKey: Map<string, string>,
	key: string,
	eventType: string,
	agentId: string,
): boolean {
	if (!key) return true;
	const currentAgentId = agentIdByKey.get(key);
	if (eventType === "started") {
		if (currentAgentId && currentAgentId !== agentId) {
			agents.delete(currentAgentId);
		}
		agentIdByKey.set(key, agentId);
		return true;
	}
	return !currentAgentId || currentAgentId === agentId;
}

function claudeWorkflowStatePath(
	scriptPath: string | undefined,
	runId: string | undefined,
): string | undefined {
	if (!scriptPath || !runId || !/^[A-Za-z0-9._-]+$/.test(runId)) {
		return undefined;
	}
	const pathApi =
		scriptPath.includes("\\") && !scriptPath.includes("/") ? win32 : posix;
	const scriptsDir = pathApi.dirname(scriptPath);
	if (pathApi.basename(scriptsDir).toLowerCase() !== "scripts")
		return undefined;
	return pathApi.join(pathApi.dirname(scriptsDir), `${runId}.json`);
}

function claudeWorkflowJournalPath(
	scriptPath: string | undefined,
	runId: string | undefined,
): string | undefined {
	const statePath = claudeWorkflowStatePath(scriptPath, runId);
	if (!statePath || !runId) return undefined;
	const pathApi =
		statePath.includes("\\") && !statePath.includes("/") ? win32 : posix;
	const workflowsDir = pathApi.dirname(statePath);
	return pathApi.join(
		pathApi.dirname(workflowsDir),
		"subagents",
		"workflows",
		runId,
		"journal.jsonl",
	);
}

function parseClaudeWorkflowJournal(text: string): unknown {
	const agents = new Map<string, ClaudeWorkflowAgentProgressRecord>();
	const agentIdByKey = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const entry = recordValue(parseJsonValue(line));
		if (!entry) {
			// Claude appends this file while the workflow is live. Ignore a
			// partially-written final line and pick it up on the next refresh.
			continue;
		}
		const agentId = firstStringField(entry, "agentId")?.trim() ?? "";
		if (!agentId) continue;
		const key = firstStringField(entry, "key")?.trim() ?? "";
		const eventType = firstStringField(entry, "type")?.toLowerCase() ?? "";
		if (!acceptsJournalAttempt(agents, agentIdByKey, key, eventType, agentId)) {
			// A resumed workflow can append a new attempt for the same logical
			// call before a late line from the stopped attempt arrives.
			continue;
		}
		const current = agents.get(agentId) ?? {
			type: "workflow_agent",
			agentId,
			label: `Workflow agent ${agents.size + 1}`,
			state: "running",
		};
		const progress = copyClaudeWorkflowProgressFields(current, entry);
		progress.state = journalEntryState(eventType, entry, current.state);
		agents.set(agentId, progress);
	}
	return { workflowProgress: [...agents.values()] };
}

async function readClaudeWorkflowProgress(
	runtimeCwd: string,
	providerPath: string,
): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		CLAUDE_WORKFLOW_PROGRESS_READ_TIMEOUT_MS,
	);
	try {
		const text = await readFile(toHostRuntimePath(runtimeCwd, providerPath), {
			encoding: "utf8",
			signal: controller.signal,
		});
		if (Buffer.byteLength(text, "utf8") > CLAUDE_WORKFLOW_PROGRESS_MAX_BYTES) {
			return null;
		}
		const pathApi =
			providerPath.includes("\\") && !providerPath.includes("/")
				? win32
				: posix;
		if (pathApi.basename(providerPath).toLowerCase() === "journal.jsonl") {
			return parseClaudeWorkflowJournal(text);
		}
		return JSON.parse(text);
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

function parseClaudeWorkflowAgents(
	value: unknown,
	expectedTaskId?: string,
): ClaudeWorkflowAgentProgress[] {
	if (typeof value === "string") value = parseJsonValue(value);
	const record = recordValue(value);
	if (!record) return [];
	const ownerTaskId = firstStringField(record, "taskId", "task_id");
	if (expectedTaskId && ownerTaskId && ownerTaskId !== expectedTaskId)
		return [];
	const progress = record.workflowProgress;
	if (!Array.isArray(progress)) return [];
	const agents: ClaudeWorkflowAgentProgress[] = [];
	for (const entry of progress) {
		const item = recordValue(entry);
		if (item?.type !== "workflow_agent") continue;
		const agentId = firstStringField(item, "agentId");
		if (!agentId) continue;
		agents.push(copyClaudeWorkflowProgressFields({ agentId }, item));
	}
	return agents;
}

function parseClaudeWorkflowOutput(
	content: unknown,
): ClaudeSubagentMetadata | null {
	const output = workflowOutputRecord(content);
	if (!output) return null;
	const taskType = firstStringField(output, "taskType", "task_type");
	const workflowName = firstStringField(
		output,
		"workflowName",
		"workflow_name",
	);
	const runId = firstStringField(output, "runId", "run_id");
	const scriptPath = firstStringField(output, "scriptPath", "script_path");
	const transcriptDir = firstStringField(
		output,
		"transcriptDir",
		"transcript_dir",
	);
	const sessionUrl = firstStringField(output, "sessionUrl", "session_url");
	const statePath = claudeWorkflowStatePath(scriptPath, runId);
	const journalPath = claudeWorkflowJournalPath(scriptPath, runId);
	if (
		taskType !== "local_workflow" &&
		taskType !== "remote_agent" &&
		!workflowName &&
		!runId &&
		!scriptPath &&
		!transcriptDir &&
		!sessionUrl
	) {
		return null;
	}
	return withoutUndefined({
		kind: "workflow",
		activityType: taskType,
		name: workflowName,
		workflowRunId: runId,
		workflowScriptPath: scriptPath,
		workflowTranscriptDir: transcriptDir,
		workflowSessionUrl: sessionUrl,
		workflowStatePath: statePath,
		workflowJournalPath: journalPath,
	} satisfies ClaudeSubagentMetadata);
}

function snapshotMetadata(
	metadata: ClaudeSubagentMetadata | undefined,
): Omit<
	ClaudeSubagentMetadata,
	"parentToolUseId" | "workflowStatePath" | "workflowJournalPath"
> {
	if (!metadata) return {};
	const {
		parentToolUseId: _parentToolUseId,
		workflowStatePath: _workflowStatePath,
		workflowJournalPath: _workflowJournalPath,
		...snapshot
	} = metadata;
	return snapshot;
}

function workflowAgentStatus(
	state: string | undefined,
): SubagentSnapshot["status"] {
	switch (state) {
		case "queued":
		case "pending":
			return "pending";
		case "done":
		case "completed":
			return "completed";
		case "error":
		case "failed":
			return "failed";
		case "skipped":
		case "stopped":
		case "killed":
			return "interrupted";
		default:
			return "running";
	}
}

function nonEmptyString(value: string | undefined): string | undefined {
	return value || undefined;
}

function workflowStatusIsTerminal(status: SubagentSnapshot["status"]): boolean {
	return (
		status === "completed" || status === "failed" || status === "interrupted"
	);
}

function workflowProgressStartedAtMs(
	progress: ClaudeWorkflowAgentProgress,
	current: SubagentSnapshot | undefined,
): number {
	return (
		progress.startedAt ??
		progress.queuedAt ??
		progress.lastProgressAt ??
		current?.startedAtMs ??
		Date.now()
	);
}

function workflowProgressEndedAtMs(
	status: SubagentSnapshot["status"],
	progress: ClaudeWorkflowAgentProgress,
	current: SubagentSnapshot | undefined,
	startedAtMs: number,
): number | undefined {
	if (!workflowStatusIsTerminal(status)) return undefined;
	if (progress.lastProgressAt !== undefined) return progress.lastProgressAt;
	if (progress.durationMs !== undefined) {
		return startedAtMs + progress.durationMs;
	}
	return current?.endedAtMs ?? Date.now();
}

function workflowProgressStatusStep(
	status: SubagentSnapshot["status"],
): string {
	switch (status) {
		case "pending":
			return "Queued";
		case "completed":
			return "Completed";
		case "failed":
			return "Failed";
		case "interrupted":
			return "Interrupted";
		default:
			return "Working";
	}
}

function workflowProgressCurrentStep(
	status: SubagentSnapshot["status"],
	progress: ClaudeWorkflowAgentProgress,
	current: SubagentSnapshot | undefined,
	phase: string | undefined,
): string {
	if (progress.lastToolSummary) return progress.lastToolSummary;
	if (progress.lastToolName) return `Using ${progress.lastToolName}`;
	const statusStep = workflowProgressStatusStep(status);
	if (workflowStatusIsTerminal(status)) return statusStep;
	return current?.currentStep ?? (phase ? `${phase} phase` : statusStep);
}

function workflowProgressUsage(
	progress: ClaudeWorkflowAgentProgress,
	current: SubagentSnapshot | undefined,
): SubagentSnapshot["usage"] {
	const usage = withoutUndefined({
		totalTokens: progress.tokens ?? current?.usage?.totalTokens,
		toolUses: progress.toolCalls ?? current?.usage?.toolUses,
		durationMs: progress.durationMs ?? current?.usage?.durationMs,
	});
	return Object.keys(usage).length > 0 ? usage : undefined;
}

function claudeUserMessageText(
	message: Extract<SDKMessage, { type: "user" }>,
): string {
	const content = (message as { message?: { content?: unknown } }).message
		?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (
				typeof block === "object" &&
				block !== null &&
				typeof (block as { text?: unknown }).text === "string"
			) {
				return String((block as { text: string }).text);
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

class ClaudeSubagentTracker {
	private snapshots = new Map<string, SubagentSnapshot>();
	private toolIds = new Map<string, string>();
	private toolMetadata = new Map<string, ClaudeSubagentMetadata>();
	private workflowChildSnapshots = new Map<string, SubagentSnapshot>();
	private workflowChildToolIds = new Map<string, string>();
	private workflowContinuationCandidates = new Set<string>();
	private stoppedWorkflowTaskIds = new Set<string>();
	private rootToolIds = new Set<string>();
	private queryWorkflowTaskIds = new Set<string>();
	private unsettledTaskIds = new Set<string>();
	private abandonedTaskIds = new Set<string>();
	private queryOwnedParentIds = new Set<string>();
	private ignoredParentIds = new Set<string>();
	private startedTaskVersion = 0;

	/** Capture fields exposed on Claude's Agent/Workflow tool before task_started. */
	recordTool(
		toolId: string,
		input: unknown,
		toolName?: string,
		parentToolUseId?: string | null,
	): SubagentSnapshot | undefined {
		const toolInput =
			typeof input === "object" && input !== null
				? (input as Record<string, unknown>)
				: {};
		const previous = this.toolMetadata.get(toolId);
		const rootTool = !parentToolUseId;
		const metadata: ClaudeSubagentMetadata = {
			...snapshotMetadata(previous),
			...(previous?.workflowStatePath
				? { workflowStatePath: previous.workflowStatePath }
				: {}),
			...(previous?.workflowJournalPath
				? { workflowJournalPath: previous.workflowJournalPath }
				: {}),
			...(parentToolUseId ? { parentToolUseId } : {}),
			...(toolName === "Workflow"
				? { kind: "workflow" as const, activityType: "local_workflow" }
				: {}),
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
		if (rootTool) this.rootToolIds.add(toolId);
		if (
			rootTool &&
			(toolName === "Agent" || toolName === "Task" || toolName === "Workflow")
		) {
			this.queryOwnedParentIds.add(toolId);
		}

		for (const [taskId, mappedToolId] of this.toolIds) {
			if (mappedToolId !== toolId) continue;
			const current = this.snapshots.get(taskId);
			if (!current) return undefined;
			const publicMetadata = snapshotMetadata(metadata);
			let subagent: SubagentSnapshot = { ...current, ...publicMetadata };
			if (rootTool && current.kind !== "workflow") {
				const { parentActivityId: _parentActivityId, ...rootSubagent } =
					subagent;
				subagent = rootSubagent;
			}
			this.snapshots.set(taskId, subagent);
			return subagent;
		}
		return undefined;
	}

	/** Capture native Workflow output fields such as runId and transcriptDir. */
	recordToolResult(toolId: string, content: unknown): AgentEvent[] {
		const previous = this.toolMetadata.get(toolId);
		if (previous?.kind !== "workflow") return [];
		const parsed = parseClaudeWorkflowOutput(content);
		if (!parsed) return [];
		const metadata: ClaudeSubagentMetadata = {
			...previous,
			...parsed,
		};
		this.toolMetadata.set(toolId, metadata);
		for (const [taskId, mappedToolId] of this.toolIds) {
			if (mappedToolId !== toolId) continue;
			return this.updateTask(taskId, (current) => ({
				...current,
				...snapshotMetadata(metadata),
			}));
		}
		return [];
	}

	hasUnsettledTasks(): boolean {
		return this.unsettledTaskIds.size > 0;
	}

	hasOwnedTaskCandidates(): boolean {
		return this.queryOwnedParentIds.size > 0;
	}

	hasWorkflowTasks(): boolean {
		return this.queryWorkflowTaskIds.size > 0;
	}

	hasActiveWorkflowTasks(): boolean {
		for (const taskId of this.queryWorkflowTaskIds) {
			const status = this.snapshots.get(taskId)?.status;
			if (
				!this.stoppedWorkflowTaskIds.has(taskId) &&
				(status === "pending" || status === "running" || status === "paused")
			) {
				return true;
			}
		}
		return false;
	}

	hasWorkflowContinuationPotential(): boolean {
		for (const taskId of this.queryWorkflowTaskIds) {
			if (!this.stoppedWorkflowTaskIds.has(taskId)) return true;
		}
		return false;
	}

	taskVersion(): number {
		return this.startedTaskVersion;
	}

	hasWorkflowContinuationCandidate(): boolean {
		return this.workflowContinuationCandidates.size > 0;
	}

	observeWorkflowNotification(
		message: Extract<SDKMessage, { type: "user" }>,
	): boolean {
		if ((message as { shouldQuery?: boolean }).shouldQuery === false) {
			return false;
		}
		const text = claudeUserMessageText(message);
		if (!text.includes("<task-notification>")) return false;
		let observed = false;
		for (const match of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) {
			const taskId = match[1]?.trim();
			if (
				!taskId ||
				this.snapshots.get(taskId)?.kind !== "workflow" ||
				this.stoppedWorkflowTaskIds.has(taskId)
			) {
				continue;
			}
			this.workflowContinuationCandidates.delete(taskId);
			observed = true;
		}
		return observed;
	}

	consumeWorkflowContinuationCandidate(): boolean {
		if (this.workflowContinuationCandidates.size === 0) return false;
		this.workflowContinuationCandidates.clear();
		return true;
	}

	private workflowProgressSnapshot(
		parentTaskId: string,
		progress: ClaudeWorkflowAgentProgress,
		current?: SubagentSnapshot,
	): SubagentSnapshot {
		const status = workflowAgentStatus(progress.state);
		const phase = nonEmptyString(progress.phaseTitle ?? current?.phase);
		const startedAtMs = workflowProgressStartedAtMs(progress, current);
		const endedAtMs = workflowProgressEndedAtMs(
			status,
			progress,
			current,
			startedAtMs,
		);
		const attempt = progress.attempt ?? current?.attempt;
		return withoutUndefined({
			provider: "claude",
			agentId: progress.agentId,
			kind: "agent",
			parentActivityId: parentTaskId,
			activityType: "workflow_agent",
			name: nonEmptyString(progress.label ?? current?.name),
			label: "Workflow agent",
			phase,
			description: phase ? `${phase} phase` : undefined,
			model: nonEmptyString(progress.model ?? current?.model),
			effort: nonEmptyString(progress.effort ?? current?.effort),
			attempt,
			prompt: nonEmptyString(progress.promptPreview ?? current?.prompt),
			status,
			currentStep: workflowProgressCurrentStep(
				status,
				progress,
				current,
				phase,
			),
			lastTool: nonEmptyString(progress.lastToolName ?? current?.lastTool),
			resultPreview: nonEmptyString(
				progress.resultPreview ?? current?.resultPreview,
			),
			startedAtMs,
			endedAtMs,
			usage: workflowProgressUsage(progress, current),
		} satisfies SubagentSnapshot);
	}

	private reconcileWorkflowProgress(
		parentTaskId: string,
		progress: ReadonlyArray<ClaudeWorkflowAgentProgress>,
	): AgentEvent[] {
		const events: AgentEvent[] = [];
		for (const agent of progress) {
			const key = `${parentTaskId}\0${agent.agentId}`;
			const toolId =
				this.workflowChildToolIds.get(key) ??
				`claude-workflow-agent:${parentTaskId}:${agent.agentId}`;
			const current = this.workflowChildSnapshots.get(key);
			let subagent = this.workflowProgressSnapshot(
				parentTaskId,
				agent,
				current,
			);
			if (
				this.stoppedWorkflowTaskIds.has(parentTaskId) &&
				subagent.status !== "completed" &&
				subagent.status !== "failed" &&
				subagent.status !== "interrupted"
			) {
				subagent = {
					...subagent,
					status: "interrupted",
					currentStep: "Workflow stopped",
					endedAtMs: this.snapshots.get(parentTaskId)?.endedAtMs ?? Date.now(),
				};
			}
			this.workflowChildSnapshots.set(key, subagent);
			this.workflowChildToolIds.set(key, toolId);
			if (!current) {
				events.push({
					type: "tool_start",
					toolId,
					name: "Subagent",
					input: subagent.prompt ? { prompt: subagent.prompt } : {},
					subagent,
				});
				continue;
			}
			if (JSON.stringify(current) !== JSON.stringify(subagent)) {
				events.push({ type: "tool_update", toolId, subagent });
			}
		}
		return events;
	}

	async refreshWorkflowProgress(
		runtimeCwd: string,
		reader: ClaudeWorkflowProgressReader,
		message?: ClaudeTaskMessage,
	): Promise<AgentEvent[]> {
		if (this.queryWorkflowTaskIds.size === 0) return [];
		const hintedTaskId =
			typeof message?.task_id === "string" &&
			this.snapshots.get(message.task_id)?.kind === "workflow"
				? message.task_id
				: undefined;
		const taskIds = hintedTaskId
			? [hintedTaskId]
			: [...this.queryWorkflowTaskIds];
		const events: AgentEvent[] = [];
		for (const taskId of taskIds) {
			const toolId = this.toolIds.get(taskId);
			const metadata = toolId ? this.toolMetadata.get(toolId) : undefined;
			const outputPath =
				hintedTaskId === taskId &&
				typeof message?.output_file === "string" &&
				message.output_file
					? message.output_file
					: undefined;
			const paths = [
				outputPath,
				metadata?.workflowStatePath,
				metadata?.workflowJournalPath,
			].filter(
				(path, index, values): path is string =>
					Boolean(path) && values.indexOf(path) === index,
			);
			for (const providerPath of paths) {
				let value: unknown;
				try {
					value = await reader(runtimeCwd, providerPath);
				} catch {
					continue;
				}
				const progress = parseClaudeWorkflowAgents(value, taskId);
				if (progress.length === 0) continue;
				events.push(...this.reconcileWorkflowProgress(taskId, progress));
				break;
			}
		}
		return events;
	}

	private workflowTaskIdForTool(toolId: string): string | undefined {
		for (const [taskId, mappedToolId] of this.toolIds) {
			if (mappedToolId !== toolId) continue;
			if (this.snapshots.get(taskId)?.kind === "workflow") return taskId;
		}
		return undefined;
	}

	/**
	 * Prefer an explicit provider tool-parent edge. When Claude does not expose
	 * one, correlate only when exactly one workflow exists in this query and
	 * the child was not observed as a root-level Agent/Task tool. Ambiguous
	 * children stay flat instead of being attached to the wrong workflow.
	 */
	private workflowParentFor(
		originatingToolId: string,
		metadata: ClaudeSubagentMetadata | undefined,
	): string | undefined {
		if (metadata?.parentToolUseId) {
			const exact = this.workflowTaskIdForTool(metadata.parentToolUseId);
			if (exact) return exact;
		}
		if (this.rootToolIds.has(originatingToolId)) return undefined;
		if (this.queryWorkflowTaskIds.size !== 1) return undefined;
		return this.queryWorkflowTaskIds.values().next().value;
	}

	trackChildParent(parentToolUseId: string | null | undefined): void {
		if (!parentToolUseId || this.ignoredParentIds.has(parentToolUseId)) return;
		this.queryOwnedParentIds.add(parentToolUseId);
	}

	shouldIgnoreChildUsage(parentToolUseId: string | null | undefined): boolean {
		return Boolean(
			parentToolUseId && this.ignoredParentIds.has(parentToolUseId),
		);
	}

	/**
	 * Seal child ownership at a query boundary. Any straggling assistant event
	 * for one of these tool ids belongs to the completed query and must not be
	 * recorded by the following Hlid query.
	 */
	finishQuery(): void {
		for (const parentId of this.queryOwnedParentIds) {
			this.ignoredParentIds.add(parentId);
		}
		for (const taskId of this.queryWorkflowTaskIds) {
			this.stoppedWorkflowTaskIds.delete(taskId);
		}
		this.queryOwnedParentIds.clear();
		this.queryWorkflowTaskIds.clear();
		this.workflowContinuationCandidates.clear();
		this.rootToolIds.clear();
	}

	/** Mark still-running owned tasks interrupted and quarantine their late use. */
	abandonUnsettledTasks(): AgentEvent[] {
		const events: AgentEvent[] = [];
		for (const taskId of this.unsettledTaskIds) {
			this.abandonedTaskIds.add(taskId);
			this.ignoredParentIds.add(taskId);
			const resolved = this.resolveTask(taskId);
			if (!resolved) continue;
			const { current, toolId } = resolved;
			this.ignoredParentIds.add(toolId);
			const subagent: SubagentSnapshot = {
				...current,
				status: "interrupted",
				currentStep: "Background subagent usage collection timed out",
				endedAtMs: Date.now(),
			};
			this.snapshots.set(taskId, subagent);
			events.push({ type: "tool_update", toolId, subagent });
		}
		this.unsettledTaskIds.clear();
		this.finishQuery();
		return events;
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

	private interruptWorkflowChildren(
		parentTaskId: string,
		endedAtMs: number,
	): AgentEvent[] {
		const events: AgentEvent[] = [];
		for (const [key, current] of this.workflowChildSnapshots) {
			if (
				current.parentActivityId !== parentTaskId ||
				current.status === "completed" ||
				current.status === "failed" ||
				current.status === "interrupted"
			) {
				continue;
			}
			const toolId = this.workflowChildToolIds.get(key);
			if (!toolId) continue;
			const subagent: SubagentSnapshot = {
				...current,
				status: "interrupted",
				currentStep: "Workflow stopped",
				endedAtMs,
			};
			this.workflowChildSnapshots.set(key, subagent);
			events.push({ type: "tool_update", toolId, subagent });
		}
		return events;
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
		if (this.abandonedTaskIds.has(message.task_id)) return [];
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
		const originatingToolId =
			typeof message.tool_use_id === "string" && message.tool_use_id
				? message.tool_use_id
				: `claude-task-${taskId}`;
		const metadata = this.toolMetadata.get(originatingToolId);
		const taskType =
			typeof message.task_type === "string" ? message.task_type : undefined;
		const isWorkflow =
			taskType === "local_workflow" ||
			taskType === "remote_agent" ||
			metadata?.kind === "workflow";
		const isSubagent =
			taskType === "subagent" || typeof message.subagent_type === "string";
		if (message.skip_transcript === true) {
			if (typeof message.tool_use_id === "string") {
				this.queryOwnedParentIds.delete(message.tool_use_id);
			}
			return [];
		}
		if (
			!taskId ||
			(!isSubagent && !isWorkflow) ||
			this.abandonedTaskIds.has(taskId)
		) {
			return [];
		}
		if (isWorkflow) this.queryWorkflowTaskIds.add(taskId);
		const prompt =
			typeof message.prompt === "string" ? message.prompt : undefined;
		const description =
			typeof message.description === "string" ? message.description : undefined;
		const workflowName =
			typeof message.workflow_name === "string"
				? message.workflow_name
				: undefined;
		const parentActivityId = isWorkflow
			? undefined
			: this.workflowParentFor(originatingToolId, metadata);
		const subagent: SubagentSnapshot = {
			provider: "claude",
			agentId: taskId,
			taskId,
			...snapshotMetadata(metadata),
			kind: isWorkflow ? "workflow" : "agent",
			...(taskType ? { activityType: taskType } : {}),
			...(parentActivityId ? { parentActivityId } : {}),
			...(workflowName ? { name: workflowName } : {}),
			...(isWorkflow
				? {
						label:
							taskType === "remote_agent"
								? "Remote workflow"
								: "Claude workflow",
					}
				: typeof message.subagent_type === "string"
					? { label: message.subagent_type }
					: {}),
			...(prompt ? { prompt } : {}),
			...(description ? { description, currentStep: description } : {}),
			status: "running",
			startedAtMs: Date.now(),
		};
		this.snapshots.set(taskId, subagent);
		this.toolIds.set(taskId, originatingToolId);
		this.unsettledTaskIds.add(taskId);
		this.queryOwnedParentIds.add(originatingToolId);
		this.startedTaskVersion++;
		if (typeof message.tool_use_id === "string" && message.tool_use_id) {
			return [{ type: "tool_update", toolId: originatingToolId, subagent }];
		}
		return [
			{
				type: "tool_start",
				toolId: originatingToolId,
				name: isWorkflow ? "Workflow" : "Subagent",
				input: isWorkflow
					? workflowName
						? { name: workflowName }
						: {}
					: prompt
						? { prompt }
						: {},
				subagent,
			},
		];
	}

	private handleProgress(message: ClaudeTaskMessage): AgentEvent[] {
		const taskId = String(message.task_id ?? "");
		if (this.abandonedTaskIds.has(taskId)) return [];
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
		if (this.abandonedTaskIds.has(taskId)) return [];
		const patch = (message.patch ?? {}) as Record<string, unknown>;
		const rawStatus = String(patch.status ?? "");
		const status: SubagentSnapshot["status"] =
			rawStatus === "completed"
				? "completed"
				: rawStatus === "failed"
					? "failed"
					: rawStatus === "killed"
						? "interrupted"
						: rawStatus === "paused"
							? "paused"
							: rawStatus === "pending"
								? "pending"
								: "running";
		const current = this.snapshots.get(taskId);
		const workflow = current?.kind === "workflow";
		const stopped = workflow && rawStatus === "killed";
		const terminal =
			status === "completed" || status === "failed" || status === "interrupted";
		const endedAtMs =
			typeof patch.end_time === "number" ? patch.end_time : Date.now();
		if (terminal) {
			this.unsettledTaskIds.delete(taskId);
			if (stopped) {
				this.stoppedWorkflowTaskIds.add(taskId);
			} else if (workflow) {
				this.workflowContinuationCandidates.add(taskId);
			}
		}
		const events = this.updateTask(taskId, (current) => ({
			...current,
			status,
			...(stopped ? { workflowStopConfirmed: true } : {}),
			...(typeof patch.description === "string"
				? { description: patch.description, currentStep: patch.description }
				: {}),
			...(typeof patch.error === "string" ? { currentStep: patch.error } : {}),
			...(terminal ? { endedAtMs } : {}),
		}));
		if (stopped) {
			events.push(...this.interruptWorkflowChildren(taskId, endedAtMs));
		}
		return events;
	}

	private handleNotification(message: ClaudeTaskMessage): AgentEvent[] {
		const taskId = String(message.task_id ?? "");
		if (this.abandonedTaskIds.has(taskId)) return [];
		const workflow = this.snapshots.get(taskId)?.kind === "workflow";
		const rawStatus = String(message.status ?? "");
		const stopped = workflow && rawStatus === "stopped";
		if (stopped) {
			this.stoppedWorkflowTaskIds.add(taskId);
		} else if (workflow) {
			this.workflowContinuationCandidates.add(taskId);
		}
		const status: SubagentSnapshot["status"] =
			rawStatus === "completed"
				? "completed"
				: rawStatus === "stopped"
					? "interrupted"
					: "failed";
		const { usage, summary } = this.extractUsageSummary(message);
		this.unsettledTaskIds.delete(taskId);
		const endedAtMs = Date.now();
		const events = this.updateTask(taskId, (current) => ({
			...current,
			status,
			...(stopped ? { workflowStopConfirmed: true } : {}),
			...(summary
				? { currentStep: summary }
				: stopped
					? { currentStep: "Workflow stopped" }
					: {}),
			endedAtMs,
			usage: this.mergeUsage(current.usage, usage),
		}));
		if (stopped) {
			events.push(...this.interruptWorkflowChildren(taskId, endedAtMs));
		}
		return events;
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
	if (message.subtype === "commands_changed") {
		return {
			events: [{ type: "commands_changed", commands: message.commands }],
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
	tracker: ClaudeSubagentTracker,
): EventTranslation {
	const content = (message as { message?: { content?: unknown } }).message
		?.content;
	if (!Array.isArray(content)) return { events: [], hadText };
	const toolResultBlocks = content.filter(
		(block): block is Record<string, unknown> =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "tool_result",
	);
	const structuredToolResult =
		toolResultBlocks.length === 1
			? (message as { tool_use_result?: unknown }).tool_use_result
			: undefined;
	const events = content.flatMap((block: Record<string, unknown>) => {
		if (block.type !== "tool_result") return [];
		const text = normalizeToolResultContent(block.content);
		return [
			...tracker.recordToolResult(
				String(block.tool_use_id ?? ""),
				structuredToolResult ?? block.content,
			),
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
	normalizeModel: (model: string) => string,
): EventTranslation {
	// Always first: session.ts uses this to stamp the current turn's row with
	// the native transcript id of the SDK message contributing right now, so
	// forkSession's upToMessageId can branch precisely at a displayed turn.
	const events: AgentEvent[] = [
		{ type: "assistant_message_id", id: message.uuid },
	];
	const usage = message.message.usage;
	if (usage) {
		events.push({
			type: "usage",
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
			cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
			model: normalizeModel(message.message.model),
		});
	}
	let nextHadText = hadText;
	for (const block of message.message.content) {
		if (block.type === "text") {
			nextHadText = true;
			events.push({ type: "text_delta", text: block.text });
		} else if (block.type === "tool_use") {
			const subagent =
				tracker.recordTool(
					block.id,
					block.input,
					block.name,
					message.parent_tool_use_id,
				) ?? tracker.snapshotForTool(block.id);
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
	includeEstimatedCost: boolean,
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
		...(includeEstimatedCost ? { estimatedCost: message.total_cost_usd } : {}),
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

/**
 * A resumed streaming-input query can emit the previous idle boundary before
 * it consumes the newly queued user message. That boundary is distinguishable
 * from a real turn result: it is a successful, empty, zero-turn, zero-usage
 * result with no stop or terminal reason. Treating it as the new Hlid turn's
 * completion detaches Raven while Claude continues processing the prompt.
 */
function isEmptyClaudeIdleBoundary(
	message: Extract<SDKMessage, { type: "result" }>,
): boolean {
	if (
		message.subtype !== "success" ||
		message.num_turns !== 0 ||
		message.result ||
		message.stop_reason != null ||
		message.terminal_reason != null ||
		message.total_cost_usd !== 0 ||
		(message.permission_denials?.length ?? 0) > 0
	) {
		return false;
	}
	const usage = message.usage;
	if (!usage) return false;
	return (
		usage.input_tokens === 0 &&
		usage.output_tokens === 0 &&
		(usage.cache_read_input_tokens ?? 0) === 0 &&
		(usage.cache_creation_input_tokens ?? 0) === 0
	);
}

function translateSdkMessage(
	message: SDKMessage,
	hadText: boolean,
	tracker: ClaudeSubagentTracker,
	includeEstimatedCost: boolean,
	normalizeModel: (model: string) => string,
): EventTranslation {
	switch (message.type) {
		case "system":
			return translateSystemMessage(message, hadText, tracker);
		case "user":
			return translateUserMessage(message, hadText, tracker);
		case "assistant":
			return translateAssistantMessage(
				message,
				hadText,
				tracker,
				normalizeModel,
			);
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
			return translateResultMessage(message, hadText, includeEstimatedCost);
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
	private turnUsage = new ClaudeTurnUsageAccumulator();

	constructor(
		makeQuery: (
			input: AsyncIterable<SdkUserMessage>,
			resumeId: string | undefined,
		) => SdkQuery,
		abortController: AbortController,
		resumeId: string | undefined,
		private readonly hostParams: AgentQueryParams,
		private readonly runtimeCwd: string,
		private readonly workflowProgressReader: ClaudeWorkflowProgressReader,
		private readonly policyEnforced: boolean,
		private readonly includeEstimatedCost: boolean,
		private readonly requestModel: (model: string) => string,
		private readonly normalizeModel: (model: string) => string,
		private readonly exposeUsageWindows: boolean,
		private readonly exposeAccountInfo: boolean,
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

	async stopTask(taskId: string): Promise<void> {
		if (!this.sdkQuery) {
			throw new Error("Claude session is not active");
		}
		await this.sdkQuery.stopTask(taskId);
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

	async steer(message: string): Promise<void> {
		// In streaming-input mode Claude's immediate-priority user message is
		// folded into the active run instead of waiting for the next turn.
		this.ensureSdkQuery();
		this.inputStream.push(buildSdkUserMessage(message, "now"));
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
		if (!this.exposeUsageWindows) return [];
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
		this.hostParams.model = model;
		if (!this.sdkQuery) return;
		await this.sdkQuery.setModel(model ? this.requestModel(model) : model);
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
		this.hostParams.permissionMode = mode as AgentQueryParams["permissionMode"];
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
		if (!this.exposeAccountInfo) return null;
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

	private completeResult(
		messages: ReadonlyArray<Extract<SDKMessage, { type: "result" }>>,
		done: Extract<AgentEvent, { type: "done" }>,
	): Extract<AgentEvent, { type: "done" }> {
		const reconciled = this.turnUsage.reconcileMany(messages);
		this.turnUsage.reset();
		this.subagents.finishQuery();
		const modelUsage = Object.assign(
			{},
			...messages.map((message) => message.modelUsage ?? {}),
		) as NonNullable<Extract<AgentEvent, { type: "done" }>["modelUsage"]>;
		const completed: Extract<AgentEvent, { type: "done" }> = {
			...done,
			...(Object.keys(modelUsage).length > 0 ? { modelUsage } : {}),
			turns: messages.reduce((total, message) => total + message.num_turns, 0),
			durationMs: messages.reduce(
				(total, message) => total + (message.duration_ms ?? 0),
				0,
			),
			...(this.includeEstimatedCost
				? {
						estimatedCost: messages.reduce(
							(total, message) => total + message.total_cost_usd,
							0,
						),
					}
				: {}),
		};
		if (!reconciled) return completed;
		return {
			...completed,
			usage: {
				inputTokens: reconciled.inputTokens,
				outputTokens: reconciled.outputTokens,
				cacheReadTokens: reconciled.cacheReadTokens,
				cacheCreationTokens: reconciled.cacheCreationTokens,
			},
		};
	}

	private async *translateEvents(): AsyncGenerator<AgentEvent> {
		const sdkQuery = this.sdkQuery;
		if (!sdkQuery) return;
		let hadText = false;
		const messages = sdkQuery[Symbol.asyncIterator]();
		let nextMessage: Promise<IteratorResult<SDKMessage>> | null = null;
		type PendingClaudeResult = {
			results: Array<Extract<SDKMessage, { type: "result" }>>;
			done: Extract<AgentEvent, { type: "done" }>;
			deadlineMs: number;
			awaitTaskVersion: number | null;
			usageDrainDeadlineMs: number | null;
			workflowContinuationStarted: boolean;
			workflowContinuationExpected: boolean;
			workflowContinuationDeadlineMs: number | null;
		};
		let pendingResult: PendingClaudeResult | null = null;
		let workflowProgressRefreshAtMs: number | null = null;

		try {
			while (true) {
				nextMessage ??= messages.next();
				const pendingResultDeadlineMs = pendingResult
					? Math.min(
							pendingResult.deadlineMs,
							pendingResult.usageDrainDeadlineMs ?? Number.POSITIVE_INFINITY,
							pendingResult.workflowContinuationDeadlineMs ??
								Number.POSITIVE_INFINITY,
						)
					: Number.POSITIVE_INFINITY;
				const nextWakeAtMs = Math.min(
					pendingResultDeadlineMs,
					workflowProgressRefreshAtMs ?? Number.POSITIVE_INFINITY,
				);
				const waited = await waitForClaudeMessage(
					nextMessage,
					Number.isFinite(nextWakeAtMs) ? nextWakeAtMs - Date.now() : undefined,
				);
				if (waited.kind === "timeout") {
					if (
						workflowProgressRefreshAtMs !== null &&
						Date.now() >= workflowProgressRefreshAtMs
					) {
						yield* await this.subagents.refreshWorkflowProgress(
							this.runtimeCwd,
							this.workflowProgressReader,
						);
						workflowProgressRefreshAtMs =
							this.subagents.hasActiveWorkflowTasks()
								? Date.now() + CLAUDE_WORKFLOW_PROGRESS_REFRESH_MS
								: null;
					}
					if (
						!pendingResult ||
						Date.now() <
							Math.min(
								pendingResult.deadlineMs,
								pendingResult.usageDrainDeadlineMs ?? Number.POSITIVE_INFINITY,
								pendingResult.workflowContinuationDeadlineMs ??
									Number.POSITIVE_INFINITY,
							)
					) {
						continue;
					}
					const usageDrainComplete =
						pendingResult.usageDrainDeadlineMs != null &&
						Date.now() >= pendingResult.usageDrainDeadlineMs &&
						!this.subagents.hasUnsettledTasks();
					if (!usageDrainComplete) {
						yield* this.subagents.abandonUnsettledTasks();
					}
					yield this.completeResult(pendingResult.results, pendingResult.done);
					hadText = false;
					pendingResult = null;
					workflowProgressRefreshAtMs = null;
					continue;
				}
				const next = waited.result;
				nextMessage = null;
				if (next.done) {
					if (pendingResult) {
						yield* this.subagents.abandonUnsettledTasks();
						yield this.completeResult(
							pendingResult.results,
							pendingResult.done,
						);
					}
					return;
				}
				const message = next.value;
				this.receivedAnyEvent = true;
				if (message.type === "result" && isEmptyClaudeIdleBoundary(message)) {
					// This belongs to the resumed stream's idle state, not the
					// non-empty user message Hlid has just queued. Keep draining
					// until Claude emits the actual response boundary.
					continue;
				}
				const workflowContinuationStarted =
					(message.type === "user" &&
						this.subagents.observeWorkflowNotification(message)) ||
					(message.type === "assistant" &&
						message.parent_tool_use_id == null &&
						pendingResult !== null &&
						!this.subagents.hasUnsettledTasks() &&
						(this.subagents.consumeWorkflowContinuationCandidate() ||
							pendingResult.workflowContinuationExpected));
				if (pendingResult && workflowContinuationStarted) {
					pendingResult.workflowContinuationStarted = true;
					pendingResult.usageDrainDeadlineMs = null;
					pendingResult.workflowContinuationDeadlineMs = null;
					// The notification starts a new native Claude turn inside the
					// same visible Hlid turn. Reset only result-text fallback state.
					hadText = false;
				}
				if (message.type === "assistant") {
					const parentToolUseId = message.parent_tool_use_id;
					if (this.subagents.shouldIgnoreChildUsage(parentToolUseId)) continue;
					this.subagents.trackChildParent(parentToolUseId);
					this.turnUsage.record(message);
				}
				const translation = translateSdkMessage(
					message,
					hadText,
					this.subagents,
					this.includeEstimatedCost,
					this.normalizeModel,
				);
				hadText = translation.hadText;
				if (message.type !== "result") {
					yield* translation.events;
					const shouldRefreshWorkflow =
						message.type === "user" ||
						message.type === "tool_progress" ||
						(message.type === "system" &&
							[
								"task_started",
								"task_progress",
								"task_updated",
								"task_notification",
							].includes(String((message as { subtype?: unknown }).subtype)));
					if (shouldRefreshWorkflow) {
						yield* await this.subagents.refreshWorkflowProgress(
							this.runtimeCwd,
							this.workflowProgressReader,
							message as ClaudeTaskMessage,
						);
					}
					workflowProgressRefreshAtMs = this.subagents.hasActiveWorkflowTasks()
						? Date.now() + CLAUDE_WORKFLOW_PROGRESS_REFRESH_MS
						: null;
					if (pendingResult) {
						if (this.subagents.hasWorkflowTasks()) {
							pendingResult.workflowContinuationExpected =
								this.subagents.hasWorkflowContinuationPotential();
						}
						const backgroundSettled =
							!this.subagents.hasUnsettledTasks() &&
							(pendingResult.awaitTaskVersion == null ||
								this.subagents.taskVersion() > pendingResult.awaitTaskVersion ||
								!this.subagents.hasOwnedTaskCandidates());
						if (backgroundSettled) {
							if (pendingResult.workflowContinuationStarted) {
								pendingResult.usageDrainDeadlineMs = null;
								pendingResult.workflowContinuationDeadlineMs = null;
							} else if (pendingResult.workflowContinuationExpected) {
								// Claude's native workflow completion can spend several
								// seconds thinking before its first assistant event. Keep
								// the visible Hlid turn open for that continuation even
								// when the SDK omits the synthetic task-notification user
								// message that would otherwise mark it immediately.
								pendingResult.usageDrainDeadlineMs = null;
								pendingResult.workflowContinuationDeadlineMs ??=
									Date.now() + CLAUDE_WORKFLOW_CONTINUATION_GRACE_MS;
							} else {
								pendingResult.usageDrainDeadlineMs ??=
									Date.now() +
									(this.subagents.hasWorkflowContinuationCandidate()
										? CLAUDE_WORKFLOW_CONTINUATION_GRACE_MS
										: CLAUDE_BACKGROUND_USAGE_DRAIN_MS);
							}
						} else {
							pendingResult.usageDrainDeadlineMs = null;
							pendingResult.workflowContinuationDeadlineMs = null;
						}
					}
					continue;
				}
				const continuingPending: PendingClaudeResult | null =
					pendingResult &&
					(pendingResult.workflowContinuationStarted ||
						(pendingResult.workflowContinuationExpected &&
							!this.subagents.hasUnsettledTasks()))
						? pendingResult
						: null;
				if (pendingResult && !continuingPending) {
					// A second root result cannot legitimately arrive before Hlid closes the
					// previous query. Fail closed: quarantine any old child and complete its
					// accounting before accepting the new boundary.
					yield* this.subagents.abandonUnsettledTasks();
					yield this.completeResult(pendingResult.results, pendingResult.done);
					pendingResult = null;
					workflowProgressRefreshAtMs = null;
				}
				const done = translation.events.find(
					(event): event is Extract<AgentEvent, { type: "done" }> =>
						event.type === "done",
				);
				for (const event of translation.events) {
					if (event.type !== "done") yield event;
				}
				if (!done) continue;
				const results: Array<Extract<SDKMessage, { type: "result" }>> =
					continuingPending
						? [...continuingPending.results, message]
						: [message];
				const hasUnsettledTasks = this.subagents.hasUnsettledTasks();
				const backgroundRequested =
					message.terminal_reason === "background_requested" &&
					this.subagents.hasOwnedTaskCandidates();
				if (hasUnsettledTasks || backgroundRequested) {
					pendingResult = {
						results,
						done,
						deadlineMs: Date.now() + CLAUDE_BACKGROUND_SETTLE_TIMEOUT_MS,
						awaitTaskVersion:
							backgroundRequested && !hasUnsettledTasks
								? this.subagents.taskVersion()
								: null,
						usageDrainDeadlineMs: null,
						workflowContinuationStarted: false,
						workflowContinuationExpected:
							this.subagents.hasWorkflowContinuationPotential(),
						workflowContinuationDeadlineMs: null,
					};
					if (this.subagents.hasActiveWorkflowTasks()) {
						workflowProgressRefreshAtMs ??=
							Date.now() + CLAUDE_WORKFLOW_PROGRESS_REFRESH_MS;
					}
					continue;
				}
				if (continuingPending) pendingResult = null;
				yield this.completeResult(results, done);
				hadText = false;
				workflowProgressRefreshAtMs = null;
			}
		} catch (error) {
			if (!pendingResult) throw error;
			yield* this.subagents.abandonUnsettledTasks();
			yield this.completeResult(pendingResult.results, pendingResult.done);
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

export type ClaudeProviderOptions = {
	providerId?: string;
	label?: string;
	models?: ReadonlyArray<{ value: string; label: string }>;
	effortLevels?: AgentProvider["effortLevels"];
	usageWindows?: AgentProvider["usageWindows"];
	sdkEnv?: Record<string, string | undefined>;
	includeSdkEstimatedCost?: boolean;
	requestModel?: (model: string, effort: string | undefined) => string;
	normalizeModel?: (model: string) => string;
	passSdkEffort?: boolean;
	exposeUsageWindows?: boolean;
	exposeAccountInfo?: boolean;
	proxyConfig?: AgentProvider["proxyConfig"] | null;
	/** Test seam for provider-owned native Workflow state files. */
	workflowProgressReader?: ClaudeWorkflowProgressReader;
};

const CLAUDE_MODELS = [
	{ value: "claude-opus-4-8", label: "Opus 4.8" },
	{ value: "claude-opus-4-7", label: "Opus 4.7" },
	{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
	{ value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

const CLAUDE_EFFORT_LEVELS = [
	{ value: "low", label: "Low", desc: "minimal thinking, quick turnaround" },
	{ value: "medium", label: "Medium", desc: "some thinking, pretty balanced" },
	{
		value: "high",
		label: "High",
		desc: "solid reasoning, this is the default",
	},
	{ value: "xhigh", label: "X-High", desc: "goes deeper, Opus only" },
	{ value: "max", label: "Max", desc: "everything Claude has, Opus only" },
] as const;

const CLAUDE_USAGE_WINDOWS = [
	{ windowId: "five_hour", label: "5-HOUR", windowSecs: 5 * 3600 },
	{ windowId: "weekly", label: "7-DAY", windowSecs: 7 * 86400 },
] as const;

const CLAUDE_PROXY_CONFIG = {
	envVar: "ANTHROPIC_BASE_URL",
	windowIds: ["five_hour", "weekly", "weekly_sonnet"],
	parseHeaders: parseAnthropicHeaders,
};

function isLoopbackHttpUrl(value: string | undefined): boolean {
	if (!value) return false;
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return (
			hostname === "127.0.0.1" ||
			hostname === "localhost" ||
			hostname === "[::1]"
		);
	} catch {
		return false;
	}
}

/**
 * Direct WSL Claude sessions cannot reach a proxy bound to the Windows host's
 * loopback interface. Hlid's transparent Anthropic usage proxy is published
 * through ANTHROPIC_BASE_URL, so remove only that unreachable loopback value
 * for direct WSL launches. Routed providers supply an explicit SDK environment
 * and keep their WSL-local CLIProxy endpoint.
 */
function claudeSdkEnv(
	cwd: string,
	explicit: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> | undefined {
	if (explicit) return explicit;
	if (!parseWslUnc(cwd) || !isLoopbackHttpUrl(process.env.ANTHROPIC_BASE_URL)) {
		return undefined;
	}
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.ANTHROPIC_BASE_URL;
	return env;
}

// Serializes CLAUDE_CONFIG_DIR mutation windows across concurrent
// forkSession() calls so two overlapping forks (e.g. different WSL distros)
// can't clobber each other's override. Does NOT protect against a
// concurrent live query() spawn reading process.env mid-window — the
// mutation is scoped as tightly as possible (immediately around the single
// forkClaudeSession() call, restored in a finally) to minimize that gap.
let claudeConfigDirQueue: Promise<unknown> = Promise.resolve();

async function withClaudeConfigDirOverride<T>(
	dir: string | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	if (!dir) return fn();
	const run = async () => {
		const previous = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = dir;
		try {
			return await fn();
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previous;
		}
	};
	const result = claudeConfigDirQueue.then(run, run);
	claudeConfigDirQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/** Extracts plain text from an Anthropic message's content blocks (or a bare string). */
function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const { type, text } = block as { type?: unknown; text?: unknown };
			return type === "text" && typeof text === "string" ? text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

/**
 * Best-effort read-back of a freshly forked session's transcript, via the
 * SDK's own getSessionMessages() — forkSession() only writes the native
 * Claude transcript file, never hlid's own `messages` table (what Raven
 * actually renders), so without this a forked session's transcript stays
 * blank until a live turn or a manual history reload backfills it. Must be
 * called from inside the same withClaudeConfigDirOverride window as the
 * forkSession() call, for the same WSL-root reasons. Never throws: a failed
 * read just leaves the row message-less rather than failing the fork.
 */
async function hydrateForkedMessages(
	nativeSessionId: string,
	params: ForkSessionParams,
): Promise<NonNullable<ForkSessionResult["messages"]>> {
	try {
		const sdkMessages = await getSdkSessionMessages(nativeSessionId, {
			...(params.historyResumeMode === "session-store"
				? { sessionStore: createClaudeHistorySessionStore() }
				: {}),
		});
		return sdkMessages
			.filter(
				(m): m is typeof m & { type: "user" | "assistant" } =>
					m.type === "user" || m.type === "assistant",
			)
			.map((m) => ({
				role: m.type,
				text: extractMessageText(
					(m.message as { content?: unknown } | undefined)?.content,
				),
				uuid: m.uuid,
			}))
			.filter((m) => m.text.length > 0);
	} catch {
		return [];
	}
}

export class ClaudeProvider implements AgentProvider {
	readonly providerId: string;
	readonly label: string;
	readonly forkCapability = {
		kind: "exact",
		cutoff: "message",
		wholeSession: true,
		throughMessage: true,
	} as const;
	// The SDK's streaming-input query is lazy — probes must send a turn first.
	readonly probeRequiresTurn = true;

	readonly models: ReadonlyArray<{ value: string; label: string }>;
	readonly effortLevels: AgentProvider["effortLevels"];

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
	readonly usageWindows?: AgentProvider["usageWindows"];
	readonly proxyConfig: NonNullable<AgentProvider["proxyConfig"]>;
	private readonly sdkEnv?: Record<string, string | undefined>;
	private readonly includeSdkEstimatedCost: boolean;
	private readonly requestModel: (
		model: string,
		effort: string | undefined,
	) => string;
	private readonly normalizeModel: (model: string) => string;
	private readonly passSdkEffort: boolean;
	private readonly exposeUsageWindows: boolean;
	private readonly exposeAccountInfo: boolean;
	private readonly workflowProgressReader: ClaudeWorkflowProgressReader;

	constructor(options: ClaudeProviderOptions = {}) {
		this.providerId = options.providerId ?? "claude";
		this.label = options.label ?? "Claude";
		this.models = options.models ?? CLAUDE_MODELS;
		this.effortLevels = options.effortLevels ?? CLAUDE_EFFORT_LEVELS;
		this.usageWindows = options.usageWindows ?? CLAUDE_USAGE_WINDOWS;
		this.sdkEnv = options.sdkEnv;
		this.includeSdkEstimatedCost = options.includeSdkEstimatedCost ?? true;
		this.requestModel = options.requestModel ?? ((model) => model);
		this.normalizeModel = options.normalizeModel ?? ((model) => model);
		this.passSdkEffort = options.passSdkEffort ?? true;
		this.exposeUsageWindows = options.exposeUsageWindows ?? true;
		this.exposeAccountInfo = options.exposeAccountInfo ?? true;
		this.workflowProgressReader =
			options.workflowProgressReader ?? readClaudeWorkflowProgress;
		this.proxyConfig = (
			options.proxyConfig === undefined
				? CLAUDE_PROXY_CONFIG
				: options.proxyConfig
		) as NonNullable<AgentProvider["proxyConfig"]>;
	}

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
				...(this.sdkEnv ? { env: this.sdkEnv } : {}),
			},
		});
		try {
			return mapClaudeModels(await withTimeout(q.supportedModels(), 10_000));
		} finally {
			ac.abort();
		}
	}

	// fallow-ignore-next-line unused-class-member -- Invoked through AgentProvider.listSkills by the provider skill catalog.
	async listSkills(context: {
		cwd: string;
		executable?: string;
	}): Promise<ProviderSkillInfo[]> {
		const executable = context.executable ?? resolveClaudeExecutable();
		const sdkEnv = claudeSdkEnv(context.cwd, this.sdkEnv);
		const ac = new AbortController();
		// biome-ignore lint/suspicious/noExplicitAny: SDK canUseTool type changed between versions
		const denyAllCanUseTool: any = async () => ({
			behavior: "deny",
			message: "skill catalog probe",
		});
		const q = query({
			prompt: (async function* (): AsyncGenerator<SdkUserMessage> {
				await new Promise<never>(() => {});
			})(),
			options: {
				cwd: context.cwd,
				abortController: ac,
				persistSession: false,
				settingSources: ["user", "project", "local"],
				maxTurns: 1,
				...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
				canUseTool: denyAllCanUseTool,
				...(sdkEnv ? { env: sdkEnv } : {}),
			},
		});
		try {
			const commands = await withTimeout(q.supportedCommands(), 10_000);
			return commands.map((command) => ({
				name: command.name,
				description: command.description,
			}));
		} finally {
			ac.abort();
		}
	}

	async listWorkflows(context: {
		cwd: string;
	}): Promise<ProviderWorkflowCatalog> {
		return listClaudeWorkflows(context.cwd, this.sdkEnv?.CLAUDE_CONFIG_DIR);
	}

	async saveWorkflow(
		input: ProviderWorkflowSaveInput,
	): Promise<ProviderSavedWorkflow> {
		return saveClaudeWorkflow(input, this.sdkEnv?.CLAUDE_CONFIG_DIR);
	}

	async deleteWorkflow(input: ProviderWorkflowDeleteInput): Promise<void> {
		await deleteClaudeWorkflow(input, this.sdkEnv?.CLAUDE_CONFIG_DIR);
	}

	async readWorkflowSource(
		input: ProviderWorkflowSourceInput,
	): Promise<string> {
		return readClaudeWorkflowSource(input, this.sdkEnv?.CLAUDE_CONFIG_DIR);
	}

	query(params: AgentQueryParams): AgentSession {
		const abortController = new AbortController();
		const sdkEnv = claudeSdkEnv(params.cwd, this.sdkEnv);

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
					mcpServers: {
						[HLID_AGENT_NAMESPACE]: createHlidSdkServer(params),
						[OBSIDIAN_AGENT_NAMESPACE]: createObsidianSdkServer(
							params.permissionMode === "bypassPermissions" &&
								!params.policyEnforced
								? params.canUseTool
								: undefined,
							abortController.signal,
						),
					},
					...(params.additionalDirectories?.length
						? { additionalDirectories: params.additionalDirectories }
						: {}),
					abortController,
					...(params.model
						? { model: this.requestModel(params.model, params.effort) }
						: {}),
					permissionMode: effectiveSdkPermissionMode(
						params.permissionMode,
						params.policyEnforced ?? false,
					),
					...(this.passSdkEffort
						? { effort: (params.effort ?? "medium") as SdkEffortLevel }
						: {}),
					...(sdkEnv ? { env: sdkEnv } : {}),
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
					...(params.historyResumeMode === "session-store"
						? { sessionStore: createClaudeHistorySessionStore() }
						: {}),
					...(params.persistSession === false ? { persistSession: false } : {}),
					// biome-ignore lint/suspicious/noExplicitAny: SDK canUseTool type changed between versions
					canUseTool: params.canUseTool as any,
				},
			});

		return new ClaudeAgentSession(
			makeQuery,
			abortController,
			params.sessionId,
			params,
			params.cwd,
			this.workflowProgressReader,
			params.policyEnforced ?? false,
			this.includeSdkEstimatedCost,
			(model) => this.requestModel(model, params.effort),
			this.normalizeModel,
			this.exposeUsageWindows,
			this.exposeAccountInfo,
		);
	}

	// fallow-ignore-next-line unused-class-member -- Invoked through the optional AgentProvider.forkSession capability in dbRoutes.
	async forkSession(params: ForkSessionParams): Promise<ForkSessionResult> {
		// `dir` is deliberately omitted from the SDK call: hlid's stored
		// agent_cwd doesn't reliably match the exact literal path form the CLI
		// indexed the project under, so scoping the lookup to it just fails for
		// sessions that exist. Session ids are UUIDs, so an unscoped lookup
		// across every project directory is safe.
		//
		// That's not enough on its own for WSL-hosted projects though: Claude
		// Code's own process for those runs inside WSL and writes
		// ~/.claude/projects under WSL's home, not hlid's (Windows)
		// os.homedir() — no `dir` value fixes a wrong root, only
		// CLAUDE_CONFIG_DIR does. Resolve and apply that override for the
		// duration of this call when the project cwd is a WSL path.
		const wslConfigDir = await resolveWslClaudeConfigDir(params.cwd);
		return withClaudeConfigDirOverride(wslConfigDir, async () => {
			if (params.cutoff && params.cutoff.kind !== "message") {
				throw new Error("Claude exact forks require a native message cutoff");
			}
			const result = await forkClaudeSession(params.sessionId, {
				title: params.title,
				upToMessageId: params.cutoff?.id,
				...(params.historyResumeMode === "session-store"
					? { sessionStore: createClaudeHistorySessionStore() }
					: {}),
			});
			const messages = await hydrateForkedMessages(result.sessionId, params);
			return { sessionId: result.sessionId, messages };
		});
	}
}
