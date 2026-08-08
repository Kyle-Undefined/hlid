import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type {
	SDKControlGetUsageResponse,
	SDKMessage,
	SDKMessageOrigin,
	EffortLevel as SdkEffortLevel,
	McpServerConfig as SdkMcpServerConfig,
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
import {
	buildHlidToolLoadingSummary,
	describeHlidToolLoading,
} from "../lib/hlidContext";
import {
	parseWslUnc,
	toHostRuntimePath,
	toProviderRuntimePath,
} from "../lib/paths";
import { readProjectMcpFile } from "../lib/projectMcp";
import type {
	AgentEvent,
	AgentInputOrigin,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	CanUseTool,
	ForkSessionParams,
	ForkSessionResult,
	McpServerStatus,
	ProviderAccountInfo,
	ProviderBackgroundActivity,
	ProviderBackgroundActivityControl,
	ProviderContextUsage,
	ProviderEffortInfo,
	ProviderFileRewindResult,
	ProviderMcpPermissionModeOverride,
	ProviderMcpPermissionModeOverrideResult,
	ProviderMcpServerApplyResult,
	ProviderMcpServerDefinition,
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
	TaskActivity,
} from "./agentProvider";
import { toAgentToolCallResult } from "./agentToolResult";
import { ClaudeBackgroundActivityTracker } from "./claudeBackgroundActivities";
import { discoverClaudeProviderCapabilities } from "./claudeCapabilityDiscovery";
import { createClaudeHistorySessionStore } from "./claudeHistorySessionStore";
import { createClaudeHostInteractionHandlers } from "./claudeHostInteractions";
import {
	type PreparedClaudeMcpServers,
	prepareClaudeMcpServers,
} from "./claudeMcpConfig";
import { buildHlidClaudeSettings } from "./claudeSettings";
import { getClaudeWarmupSnapshot } from "./claudeWarmup";
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
import {
	claudeTaskActivityResult,
	claudeTaskActivityStart,
} from "./taskActivity";

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

const CLAUDE_SDK_EFFORT_LEVELS = new Set<string>([
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function claudeSdkEffortLevel(effort: string): SdkEffortLevel {
	if (!CLAUDE_SDK_EFFORT_LEVELS.has(effort)) {
		throw new Error(`Unknown Claude effort level: ${effort}`);
	}
	return effort as SdkEffortLevel;
}

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
							codexRealtimeEnabled: params.codexRealtimeEnabled,
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

// Minimal SDKUserMessage shape used by Hlid's streaming input. The origin
// remains typed to the SDK's public union, while its source is translated only
// at this Claude-specific boundary.
type SdkUserMessage = {
	type: "user";
	message: { role: "user"; content: Array<{ type: "text"; text: string }> };
	parent_tool_use_id: null;
	priority?: "now" | "next" | "later";
	origin: SDKMessageOrigin;
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

function toSdkMessageOrigin(
	inputOrigin: AgentInputOrigin | undefined,
): SDKMessageOrigin {
	switch (inputOrigin) {
		case "human":
			return { kind: "human" };
		case "scheduled-task":
			return { kind: "task-notification", subkind: "scheduled-trigger" };
		case "coordinator":
			return { kind: "coordinator" };
		case "background-notification":
			return { kind: "task-notification" };
		case "auto-continuation":
			return { kind: "auto-continuation" };
		default:
			return { kind: "unclassified" };
	}
}

function buildSdkUserMessage(
	text: string,
	priority: "now" | "next" | "later",
	inputOrigin: AgentInputOrigin | undefined,
): SdkUserMessage {
	return {
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
		parent_tool_use_id: null,
		priority,
		origin: toSdkMessageOrigin(inputOrigin),
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
const CLAUDE_HISTORY_WARNING_ID_MAX_CHARS = 1_024;
const CLAUDE_HISTORY_WARNING_ERROR_CLASSIFY_MAX_CHARS = 2_000;
const CLAUDE_PERMISSION_ID_MAX_CHARS = 1_024;
const CLAUDE_PERMISSION_NAME_MAX_CHARS = 512;
const CLAUDE_PERMISSION_REASON_TYPE_MAX_CHARS = 256;
const CLAUDE_PERMISSION_REASON_MAX_CHARS = 2_000;
const CLAUDE_PERMISSION_MESSAGE_MAX_CHARS = 4_000;
const CLAUDE_PERMISSION_STATE_LIMIT = 2_048;

type ClaudePermissionAdvisory = {
	agentId?: string;
	reasonType?: string;
	reason?: string;
	message?: string;
};

type ClaudeKnownPermissionTool = {
	/** Bounded name used only for display and durable evidence. */
	toolName: string;
	/** Exact safe name required before synthesizing a missing result. */
	synthesisToolName?: string;
	/** A frameless result cannot later be retracted, so it settles permanently. */
	settledWithoutFrame: boolean;
	/** Active provider-result frames that currently settle this tool. */
	settledFrameCount: number;
};

function boundedClaudePermissionText(
	value: unknown,
	maxChars: number,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const safe = value.replace(/\p{Cc}/gu, " ").trim();
	return safe ? safe.slice(0, maxChars) : undefined;
}

function exactClaudePermissionId(value: unknown): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > CLAUDE_PERMISSION_ID_MAX_CHARS ||
		/\p{Cc}/u.test(value)
	) {
		return undefined;
	}
	return value;
}

function exactClaudePermissionToolName(value: unknown): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > CLAUDE_PERMISSION_NAME_MAX_CHARS ||
		/\p{Cc}/u.test(value)
	) {
		return undefined;
	}
	return value;
}

function claudePermissionKey(
	providerSessionId: string,
	toolId: string,
): string {
	return JSON.stringify([providerSessionId, toolId]);
}

function claudePermissionFrameKey(
	providerSessionId: string,
	providerUuid: string,
): string {
	return JSON.stringify([providerSessionId, providerUuid]);
}

function claudeSessionStateEventKey(
	providerSessionId: string,
	providerUuid: string,
): string {
	return JSON.stringify([providerSessionId, providerUuid]);
}

function retainBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > CLAUDE_PERMISSION_STATE_LIMIT) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

function retainBoundedSetEntry<T>(set: Set<T>, value: T): void {
	set.delete(value);
	set.add(value);
	while (set.size > CLAUDE_PERMISSION_STATE_LIMIT) {
		const oldest = set.values().next().value;
		if (oldest === undefined) break;
		set.delete(oldest);
	}
}

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

type ClaudeProviderFrame = {
	providerSessionId: string;
	providerUuid: string;
};

type ClaudeToolResultTrackerState = {
	metadata: ClaudeSubagentMetadata | undefined;
	taskActivityTool: { name: string; input: unknown } | undefined;
	taskIds: Set<string>;
	snapshots: Map<string, SubagentSnapshot>;
	workflowChildren: Map<
		string,
		{
			snapshot: SubagentSnapshot;
			toolId: string | undefined;
			providerFrame: ClaudeProviderFrame | undefined;
		}
	>;
};

type ClaudeToolResultFrameContribution = {
	order: number;
	retracted: boolean;
	toolIds: string[];
	states: Map<string, ClaudeToolResultTrackerState>;
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
	private retractedParentIds = new Set<string>();
	private startedTaskVersion = 0;
	private taskActivityTools = new Map<
		string,
		{ name: string; input: unknown }
	>();
	private suppressedToolIds = new Set<string>();
	private toolProviderFrames = new Map<
		string,
		{ providerSessionId: string; providerUuid: string }
	>();
	private toolResultFrameOrder = 0;
	private toolResultBaseStates = new Map<
		string,
		ClaudeToolResultTrackerState
	>();
	private toolResultFrameContributions = new Map<
		string,
		ClaudeToolResultFrameContribution
	>();

	private resultFrameKey(
		providerSessionId: string,
		providerUuid: string,
	): string {
		return `${providerSessionId}\0${providerUuid}`;
	}

	captureToolResultFrame(
		providerSessionId: string,
		providerUuid: string,
		toolIds: readonly string[],
	): void {
		const key = this.resultFrameKey(providerSessionId, providerUuid);
		if (this.toolResultFrameContributions.has(key)) return;
		const uniqueToolIds = [...new Set(toolIds.filter(Boolean))];
		for (const toolId of uniqueToolIds) {
			if (!this.toolResultBaseStates.has(toolId)) {
				this.toolResultBaseStates.set(
					toolId,
					this.captureToolResultState(toolId),
				);
			}
		}
		this.toolResultFrameContributions.set(key, {
			order: this.toolResultFrameOrder++,
			retracted: false,
			toolIds: uniqueToolIds,
			states: new Map(),
		});
	}

	finalizeToolResultFrame(
		providerSessionId: string,
		providerUuid: string,
	): void {
		const contribution = this.toolResultFrameContributions.get(
			this.resultFrameKey(providerSessionId, providerUuid),
		);
		if (!contribution || contribution.retracted) return;
		for (const toolId of contribution.toolIds) {
			contribution.states.set(toolId, this.captureToolResultState(toolId));
		}
	}

	private captureToolResultState(toolId: string): ClaudeToolResultTrackerState {
		const taskIds = new Set<string>();
		const snapshots = new Map<string, SubagentSnapshot>();
		for (const [taskId, mappedToolId] of this.toolIds) {
			if (mappedToolId !== toolId) continue;
			taskIds.add(taskId);
			const snapshot = this.snapshots.get(taskId);
			if (snapshot) snapshots.set(taskId, snapshot);
		}
		const workflowChildren = new Map<
			string,
			{
				snapshot: SubagentSnapshot;
				toolId: string | undefined;
				providerFrame: ClaudeProviderFrame | undefined;
			}
		>();
		for (const [childKey, snapshot] of this.workflowChildSnapshots) {
			if (
				!snapshot.parentActivityId ||
				!taskIds.has(snapshot.parentActivityId)
			) {
				continue;
			}
			const childToolId = this.workflowChildToolIds.get(childKey);
			workflowChildren.set(childKey, {
				snapshot,
				toolId: childToolId,
				providerFrame: childToolId
					? this.toolProviderFrames.get(childToolId)
					: undefined,
			});
		}
		return {
			metadata: this.toolMetadata.get(toolId),
			taskActivityTool: this.taskActivityTools.get(toolId),
			snapshots,
			workflowChildren,
			taskIds,
		};
	}

	retractToolResultFrame(
		providerSessionId: string,
		providerUuid: string,
	): void {
		const key = this.resultFrameKey(providerSessionId, providerUuid);
		const contribution = this.toolResultFrameContributions.get(key);
		if (!contribution || contribution.retracted) return;
		contribution.retracted = true;
		for (const toolId of contribution.toolIds) {
			const surviving = [...this.toolResultFrameContributions.values()]
				.filter(
					(candidate) => !candidate.retracted && candidate.states.has(toolId),
				)
				.sort((left, right) => right.order - left.order)[0];
			const state =
				surviving?.states.get(toolId) ?? this.toolResultBaseStates.get(toolId);
			if (state) this.restoreToolResultState(toolId, state);
		}
	}

	private restoreToolResultState(
		toolId: string,
		state: ClaudeToolResultTrackerState,
	): void {
		if (state.metadata) this.toolMetadata.set(toolId, state.metadata);
		else this.toolMetadata.delete(toolId);
		if (state.taskActivityTool) {
			this.taskActivityTools.set(toolId, state.taskActivityTool);
		} else {
			this.taskActivityTools.delete(toolId);
		}
		const taskIds = new Set(state.taskIds);
		const base = this.toolResultBaseStates.get(toolId);
		for (const taskId of base?.taskIds ?? []) taskIds.add(taskId);
		for (const candidate of this.toolResultFrameContributions.values()) {
			const candidateState = candidate.states.get(toolId);
			for (const taskId of candidateState?.taskIds ?? []) taskIds.add(taskId);
		}
		for (const taskId of taskIds) {
			const snapshot = state.snapshots.get(taskId);
			if (snapshot && this.toolIds.get(taskId) === toolId) {
				this.snapshots.set(taskId, snapshot);
			} else if (this.toolIds.get(taskId) === toolId) {
				this.snapshots.delete(taskId);
			}
		}
		const childKeys = new Set(state.workflowChildren.keys());
		for (const childKey of base?.workflowChildren.keys() ?? []) {
			childKeys.add(childKey);
		}
		for (const candidate of this.toolResultFrameContributions.values()) {
			const candidateState = candidate.states.get(toolId);
			for (const childKey of candidateState?.workflowChildren.keys() ?? []) {
				childKeys.add(childKey);
			}
		}
		for (const childKey of childKeys) {
			const child = state.workflowChildren.get(childKey);
			const existingToolId = this.workflowChildToolIds.get(childKey);
			if (!child) {
				if (existingToolId) {
					this.suppressedToolIds.add(existingToolId);
					this.ignoredParentIds.add(existingToolId);
					this.retractedParentIds.add(existingToolId);
					this.toolProviderFrames.delete(existingToolId);
				}
				this.workflowChildSnapshots.delete(childKey);
				this.workflowChildToolIds.delete(childKey);
				continue;
			}
			this.workflowChildSnapshots.set(childKey, child.snapshot);
			if (!child.toolId) continue;
			this.acceptTool(child.toolId);
			this.workflowChildToolIds.set(childKey, child.toolId);
			if (child.providerFrame) {
				this.linkToolProviderFrame(child.toolId, child.providerFrame);
			}
		}
	}

	acceptTool(toolId: string): void {
		this.suppressedToolIds.delete(toolId);
		this.ignoredParentIds.delete(toolId);
		this.retractedParentIds.delete(toolId);
	}

	linkToolProviderFrame(
		toolId: string,
		providerFrame: { providerSessionId: string; providerUuid: string },
	): void {
		if (this.suppressedToolIds.has(toolId)) return;
		this.toolProviderFrames.set(toolId, providerFrame);
	}

	private providerFrameForTool(
		toolId: string,
	): { providerSessionId: string; providerUuid: string } | undefined {
		return this.toolProviderFrames.get(toolId);
	}

	suppressTool(toolId: string, accountLateUsage = true): void {
		this.suppressedToolIds.add(toolId);
		if (accountLateUsage) this.retractedParentIds.add(toolId);
		else this.retractedParentIds.delete(toolId);
		this.toolProviderFrames.delete(toolId);
		this.taskActivityTools.delete(toolId);
		this.toolMetadata.delete(toolId);
		this.rootToolIds.delete(toolId);
		this.queryOwnedParentIds.delete(toolId);
		this.ignoredParentIds.add(toolId);
		for (const [taskId, mappedToolId] of [...this.toolIds]) {
			if (mappedToolId !== toolId) continue;
			for (const [key, child] of [...this.workflowChildSnapshots]) {
				if (child.parentActivityId !== taskId) continue;
				const childToolId = this.workflowChildToolIds.get(key);
				if (childToolId) {
					this.suppressedToolIds.add(childToolId);
					if (accountLateUsage) this.retractedParentIds.add(childToolId);
					else this.retractedParentIds.delete(childToolId);
					this.toolProviderFrames.delete(childToolId);
				}
				this.workflowChildSnapshots.delete(key);
				this.workflowChildToolIds.delete(key);
			}
			this.toolIds.delete(taskId);
			this.snapshots.delete(taskId);
			this.unsettledTaskIds.delete(taskId);
			this.queryWorkflowTaskIds.delete(taskId);
			this.workflowContinuationCandidates.delete(taskId);
			this.ignoredParentIds.add(taskId);
			if (accountLateUsage) this.retractedParentIds.add(taskId);
			else this.retractedParentIds.delete(taskId);
		}
	}

	shouldAccountIgnoredChildUsage(
		parentToolUseId: string | null | undefined,
	): boolean {
		return Boolean(
			parentToolUseId && this.retractedParentIds.has(parentToolUseId),
		);
	}

	recordTaskActivityTool(
		toolId: string,
		name: string,
		input: unknown,
	): TaskActivity | undefined {
		if (this.suppressedToolIds.has(toolId)) return undefined;
		const activity = claudeTaskActivityStart(name, input);
		if (activity) this.taskActivityTools.set(toolId, { name, input });
		return activity;
	}

	recordTaskActivityResult(toolId: string, result: unknown): AgentEvent[] {
		if (this.suppressedToolIds.has(toolId)) return [];
		const tool = this.taskActivityTools.get(toolId);
		if (!tool) return [];
		this.taskActivityTools.delete(toolId);
		const taskActivity = claudeTaskActivityResult(
			tool.name,
			tool.input,
			result,
		);
		return taskActivity
			? [{ type: "tool_activity_update", toolId, taskActivity }]
			: [];
	}

	/** Capture fields exposed on Claude's Agent/Workflow tool before task_started. */
	recordTool(
		toolId: string,
		input: unknown,
		toolName?: string,
		parentToolUseId?: string | null,
	): SubagentSnapshot | undefined {
		if (this.suppressedToolIds.has(toolId)) return undefined;
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
		if (this.suppressedToolIds.has(toolId)) return [];
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
		triggerFrame?: { providerSessionId: string; providerUuid: string },
	): AgentEvent[] {
		const events: AgentEvent[] = [];
		const parentToolId = this.toolIds.get(parentTaskId);
		const parentFrame = parentToolId
			? this.providerFrameForTool(parentToolId)
			: undefined;
		const providerFrame = triggerFrame ?? parentFrame;
		const providerLineageFrames: Array<{
			providerSessionId: string;
			providerUuid: string;
		}> = [];
		for (const frame of [triggerFrame, parentFrame]) {
			if (!frame) continue;
			if (
				providerLineageFrames.some(
					(existing) =>
						existing.providerSessionId === frame.providerSessionId &&
						existing.providerUuid === frame.providerUuid,
				)
			) {
				continue;
			}
			providerLineageFrames.push(frame);
		}
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
				this.acceptTool(toolId);
				if (providerFrame) this.linkToolProviderFrame(toolId, providerFrame);
				events.push({
					type: "tool_start",
					toolId,
					name: "Subagent",
					input: subagent.prompt ? { prompt: subagent.prompt } : {},
					subagent,
					...(providerFrame ? { providerFrame } : {}),
					...(providerLineageFrames.length > 1
						? { providerLineageFrames }
						: {}),
				});
				continue;
			}
			if (JSON.stringify(current) !== JSON.stringify(subagent)) {
				events.push({
					type: "tool_update",
					toolId,
					subagent,
					...(providerFrame ? { providerFrame } : {}),
				});
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
		const triggerFrame =
			message &&
			(message as { type?: unknown }).type === "user" &&
			typeof (message as { session_id?: unknown }).session_id === "string" &&
			typeof (message as { uuid?: unknown }).uuid === "string"
				? {
						providerSessionId: String(
							(message as { session_id: string }).session_id,
						),
						providerUuid: String((message as { uuid: string }).uuid),
					}
				: undefined;
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
				events.push(
					...this.reconcileWorkflowProgress(taskId, progress, triggerFrame),
				);
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
			const providerFrame = this.providerFrameForTool(toolId);
			events.push({
				type: "tool_update",
				toolId,
				subagent,
				...(providerFrame ? { providerFrame } : {}),
			});
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
		const providerFrame = this.providerFrameForTool(toolId);
		return [
			{
				type: "tool_update",
				toolId,
				subagent,
				...(providerFrame ? { providerFrame } : {}),
			},
		];
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
			const providerFrame = this.providerFrameForTool(toolId);
			events.push({
				type: "tool_update",
				toolId,
				subagent,
				...(providerFrame ? { providerFrame } : {}),
			});
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
		const providerFrame = this.providerFrameForTool(toolId);
		return [
			{
				type: "tool_update",
				toolId,
				subagent,
				...(providerFrame ? { providerFrame } : {}),
			},
		];
	}

	private handleStarted(message: ClaudeTaskMessage): AgentEvent[] {
		const taskId = String(message.task_id ?? "");
		const originatingToolId =
			typeof message.tool_use_id === "string" && message.tool_use_id
				? message.tool_use_id
				: `claude-task-${taskId}`;
		if (this.suppressedToolIds.has(originatingToolId)) return [];
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
			const providerFrame = this.providerFrameForTool(originatingToolId);
			return [
				{
					type: "tool_update",
					toolId: originatingToolId,
					subagent,
					...(providerFrame ? { providerFrame } : {}),
				},
			];
		}
		const providerFrame = this.providerFrameForTool(originatingToolId);
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
				...(providerFrame ? { providerFrame } : {}),
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

function boundedClaudeHistoryField(
	value: unknown,
	maxChars: number,
): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxChars
	) {
		return undefined;
	}
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || (code >= 127 && code <= 159)) return undefined;
	}
	return value;
}

function exactClaudeHistoryEventId(value: unknown): string | undefined {
	const id = boundedClaudeHistoryField(
		value,
		CLAUDE_HISTORY_WARNING_ID_MAX_CHARS,
	);
	return id &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
		? id
		: undefined;
}

function classifyClaudeHistoryWarning(
	value: unknown,
): Extract<AgentEvent, { type: "provider_history_warning" }>["reason"] {
	if (typeof value !== "string" || value.length === 0) return "unknown";
	return /tim(?:e|ed)[ -]?out/i.test(
		value.slice(0, CLAUDE_HISTORY_WARNING_ERROR_CLASSIFY_MAX_CHARS),
	)
		? "timeout"
		: "append_rejected";
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
	if ((message as { subtype: string }).subtype === "mirror_error") {
		const mirror = message as unknown as {
			error?: unknown;
			key?: unknown;
			uuid?: unknown;
			session_id?: unknown;
		};
		const rawKey =
			typeof mirror.key === "object" && mirror.key !== null
				? (mirror.key as Record<string, unknown>)
				: null;
		const providerSessionId =
			boundedClaudeHistoryField(
				mirror.session_id,
				CLAUDE_HISTORY_WARNING_ID_MAX_CHARS,
			) ??
			boundedClaudeHistoryField(
				rawKey?.sessionId,
				CLAUDE_HISTORY_WARNING_ID_MAX_CHARS,
			);
		const providerEventId = exactClaudeHistoryEventId(mirror.uuid);
		const scope =
			typeof rawKey?.subpath === "string" && rawKey.subpath.length > 0
				? "subagent"
				: "main";
		return {
			events: [
				{
					type: "provider_history_warning",
					code: "history_mirror_failed",
					reason: classifyClaudeHistoryWarning(mirror.error),
					...(providerSessionId ? { providerSessionId } : {}),
					...(providerEventId ? { providerEventId } : {}),
					scope,
				},
			],
			hadText,
		};
	}
	if (message.subtype === "model_refusal_fallback") {
		const retractedIds = [
			...new Set(
				(message.retracted_message_uuids ?? []).filter(
					(id): id is string => typeof id === "string" && id.length > 0,
				),
			),
		];
		return {
			events: [
				...(retractedIds.length > 0
					? [
							{
								type: "provider_message_retraction" as const,
								ids: retractedIds,
								providerSessionId: message.session_id,
								source: "model_refusal_fallback" as const,
							},
						]
					: []),
				{
					type: "provider_refusal",
					providerSessionId: message.session_id,
					outcome: "fallback",
					originalModel: message.original_model,
					fallbackModel: message.fallback_model,
					direction: message.direction,
					scope: message.scope ?? "session",
					requestId: message.request_id,
					refusedUserMessageUuid: message.refused_user_message_uuid,
					category: message.api_refusal_category,
					explanation: message.api_refusal_explanation,
					content: message.content,
				},
			],
			hadText,
		};
	}
	if (message.subtype === "model_refusal_no_fallback") {
		return {
			events: [
				{
					type: "provider_refusal",
					providerSessionId: message.session_id,
					outcome: "no_fallback",
					originalModel: message.original_model,
					requestId: message.request_id,
					refusedUserMessageUuid: message.refused_user_message_uuid,
					category: message.api_refusal_category,
					explanation: message.api_refusal_explanation,
					content: message.content,
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
	const origin = recordValue((message as { origin?: unknown }).origin);
	const hasInternalSenderTask =
		typeof origin?.senderTaskId === "string" &&
		origin.senderTaskId.trim().length > 0;
	const isProviderPeerMessage =
		origin !== null &&
		((origin.kind === "peer" && !hasInternalSenderTask) ||
			(origin.kind === "task-notification" &&
				origin.subkind === "peer-send-message"));
	const peerEvent: AgentEvent[] = isProviderPeerMessage
		? [
				{
					type: "provider_peer_message",
					...(typeof origin.body === "string" ? { body: origin.body } : {}),
					...(typeof origin.from === "string"
						? { fromAddress: origin.from }
						: {}),
					...(typeof origin.name === "string"
						? { claimedName: origin.name }
						: {}),
					...(typeof origin.fromSession === "string"
						? { fromSession: origin.fromSession }
						: {}),
					...(typeof origin.verifiedPeerPid === "number" &&
					Number.isSafeInteger(origin.verifiedPeerPid) &&
					origin.verifiedPeerPid > 0
						? { verifiedPeerPid: origin.verifiedPeerPid }
						: {}),
				},
			]
		: [];
	const content = (message as { message?: { content?: unknown } }).message
		?.content;
	if (!Array.isArray(content)) return { events: peerEvent, hadText };
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
	const checkpointId = (message as { uuid?: unknown }).uuid;
	const checkpointSessionId = (message as { session_id?: unknown }).session_id;
	const isRootUserMessage =
		(message as { parent_tool_use_id?: unknown }).parent_tool_use_id == null;
	const isSteeringMessage =
		(message as { priority?: unknown }).priority === "now";
	const isHumanMessage = origin?.kind === "human";
	const checkpointEvents: AgentEvent[] =
		typeof checkpointId === "string" &&
		checkpointId &&
		typeof checkpointSessionId === "string" &&
		checkpointSessionId &&
		isRootUserMessage &&
		!isSteeringMessage &&
		isHumanMessage &&
		toolResultBlocks.length === 0
			? [
					{
						type: "file_checkpoint",
						id: checkpointId,
						providerSessionId: checkpointSessionId,
					},
				]
			: [];
	const events: AgentEvent[] = [...peerEvent, ...checkpointEvents];
	const providerFrame =
		typeof checkpointId === "string" &&
		checkpointId.length > 0 &&
		typeof checkpointSessionId === "string" &&
		checkpointSessionId.length > 0
			? {
					providerUuid: checkpointId,
					providerSessionId: checkpointSessionId,
				}
			: undefined;
	if (toolResultBlocks.length > 0) {
		const frameId = (message as { uuid?: unknown }).uuid;
		const frameSessionId = (message as { session_id?: unknown }).session_id;
		if (
			typeof frameId === "string" &&
			frameId.length > 0 &&
			typeof frameSessionId === "string" &&
			frameSessionId.length > 0
		) {
			events.push({
				type: "provider_message_frame",
				id: frameId,
				providerSessionId: frameSessionId,
				kind: "tool_result",
				toolResultIds: toolResultBlocks
					.map((block) => String(block.tool_use_id ?? ""))
					.filter(Boolean),
			});
		}
	}
	events.push(
		...content.flatMap((block: Record<string, unknown>) => {
			if (block.type !== "tool_result") return [];
			const text = normalizeToolResultContent(block.content);
			const toolId = String(block.tool_use_id ?? "");
			const result = structuredToolResult ?? block.content;
			const activityEvents = tracker
				.recordTaskActivityResult(toolId, result)
				.map((event) => (providerFrame ? { ...event, providerFrame } : event));
			const subagentEvents = tracker
				.recordToolResult(toolId, result)
				.map((event) => (providerFrame ? { ...event, providerFrame } : event));
			return [
				...activityEvents,
				...subagentEvents,
				{
					type: "tool_result" as const,
					toolId,
					content: truncateToolResult(text),
					...(providerFrame ? { providerFrame } : {}),
					...(block.is_error === true ? { isError: true } : {}),
				},
			];
		}),
	);
	return { events, hadText };
}

/**
 * Stable frame-local prose used to rebuild an aggregated Hlid row after any
 * non-tail provider frame is retracted. Inter-frame spacing is derived later;
 * spacing after a tool within this same frame remains part of its contribution.
 */
function assistantFrameText(
	message: Extract<SDKMessage, { type: "assistant" }>,
): string {
	let text = "";
	let previousWasTool = false;
	for (const block of message.message.content) {
		if (block.type === "tool_use") {
			previousWasTool = true;
			continue;
		}
		if (block.type !== "text") continue;
		const contribution =
			previousWasTool && block.text && !block.text.startsWith("\n")
				? `\n\n${block.text}`
				: block.text;
		text += contribution;
		previousWasTool = false;
	}
	return text;
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
	const supersededIds = [
		...new Set(
			(message.supersedes ?? []).filter(
				(id) => id.length > 0 && id !== message.uuid,
			),
		),
	];
	const toolStartIds = message.message.content.flatMap((block) =>
		block.type === "tool_use" ? [block.id] : [],
	);
	const textBlockCount = message.message.content.filter(
		(block) => block.type === "text",
	).length;
	const hasFrameIdentity =
		typeof message.uuid === "string" &&
		message.uuid.length > 0 &&
		typeof message.session_id === "string" &&
		message.session_id.length > 0;
	const providerFrame = hasFrameIdentity
		? {
				providerUuid: message.uuid,
				providerSessionId: message.session_id,
			}
		: undefined;
	const events: AgentEvent[] = [
		...(supersededIds.length > 0
			? [
					{
						type: "provider_message_retraction" as const,
						ids: supersededIds,
						providerSessionId: message.session_id,
						source: "assistant_supersedes" as const,
					},
				]
			: []),
		...(hasFrameIdentity
			? [
					{
						type: "provider_message_frame" as const,
						id: message.uuid,
						providerSessionId: message.session_id,
						kind: "assistant" as const,
						text: assistantFrameText(message),
						...(textBlockCount > 1 ? { textBlockCount } : {}),
						...(toolStartIds.length > 0 ? { toolStartIds } : {}),
					},
				]
			: []),
		{
			type: "assistant_message_id",
			id: message.uuid,
			...(hasFrameIdentity ? { providerSessionId: message.session_id } : {}),
		},
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
			events.push({
				type: "text_delta",
				text: block.text,
				...(providerFrame ? { providerFrame } : {}),
			});
		} else if (block.type === "tool_use") {
			if (providerFrame) {
				tracker.linkToolProviderFrame(block.id, providerFrame);
			}
			const taskActivity = tracker.recordTaskActivityTool(
				block.id,
				block.name,
				block.input,
			);
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
				...(taskActivity ? { taskActivity } : {}),
				...(providerFrame ? { providerFrame } : {}),
			});
		}
	}
	if (message.error && message.parent_tool_use_id == null) {
		const providerMessage = message.message.content
			.flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
			.filter(Boolean)
			.join("\n");
		events.push({
			type: "transport_error",
			message:
				providerMessage ||
				`Claude provider returned ${message.error.replaceAll("_", " ")}.`,
		});
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
	// Claude 2.1.225+ reports org_spend_cap_reached internally, but the
	// 0.3.226 SDK stream aliases it to org_level_disabled_until. Claude treats
	// both as monthly spend or usage caps; org_level_disabled is the distinct
	// generic organization disable reason.
	const overageDisabledReason: string | undefined = info.overageDisabledReason;
	const spendControlRejected =
		info.status === "rejected" &&
		(info.rateLimitType === undefined || info.rateLimitType === "overage") &&
		(overageDisabledReason === "org_spend_cap_reached" ||
			overageDisabledReason === "org_level_disabled_until");
	const events: AgentEvent[] = [];
	if (!spendControlRejected) {
		events.push({
			type: "rate_limit",
			status: info.status,
			rateLimitType: info.rateLimitType,
			utilization,
			resetsAt: rateLimitResetTime(info.resetsAt),
		});
	}
	if (spendControlRejected) {
		events.push({
			type: "rate_limit",
			status: info.status,
			rateLimitType: "spend_control",
			resetsAt: rateLimitResetTime(info.overageResetsAt ?? info.resetsAt),
		});
	}
	return {
		events,
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
	_hadText: boolean,
	includeEstimatedCost: boolean,
): EventTranslation {
	const events: AgentEvent[] = [];
	if (message.subtype === "success" && message.result) {
		const hasFrameIdentity = Boolean(message.uuid && message.session_id);
		events.push({
			type: "result_text_fallback",
			text: message.result,
			...(hasFrameIdentity
				? {
						providerUuid: message.uuid,
						providerSessionId: message.session_id,
					}
				: {}),
		});
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
		case "conversation_reset":
			return {
				events: [
					{
						type: "provider_context_reset",
						sessionId: message.new_conversation_id,
					},
				],
				hadText,
			};
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
		mcpServers: Record<string, SdkMcpServerConfig>,
		disabledMcpjsonServers: string[],
	) => SdkQuery;
	private resumeId: string | undefined;
	private inputStream: InputStream = new InputStream();
	private sdkQuery: SdkQuery | null = null;
	private cachedIter: AsyncIterator<AgentEvent> | null = null;
	// The SDK's supportedCommands() snapshot is captured at Query initialization.
	// Retain later full replacements so probes after route navigation do not
	// resurrect skills that reloadSkills() removed (or omit skills it added).
	private latestSkillCommands: SlashCommand[] | null = null;
	private firstSend: SdkUserMessage | null = null;
	private receivedAnyEvent = false;
	private retriedWithoutResume = false;
	private pendingSteerContinuation = false;
	private hasEmittedAssistantTextMessage = false;
	private readonly retractedProviderFrames = new Map<string, Set<string>>();
	private readonly activeAssistantTextFrames = new Map<string, Set<string>>();
	private readonly providerFrameToolIds = new Map<
		string,
		Map<string, string[]>
	>();
	private readonly permissionAdvisories = new Map<
		string,
		ClaudePermissionAdvisory
	>();
	private readonly knownPermissionTools = new Map<
		string,
		ClaudeKnownPermissionTool
	>();
	private readonly permissionToolResultFrames = new Map<string, Set<string>>();
	private permissionToolResultFrameLinkCount = 0;
	private readonly reportedPermissionDenials = new Set<string>();
	private readonly seenSessionStateEvents = new Set<string>();
	private currentNativeSessionId: string | undefined;
	private lifecycleNativeSessionId: string | undefined;
	private lifecycleNativeSessionGeneration = 0;
	private subagents = new ClaudeSubagentTracker();
	private backgroundActivities: ClaudeBackgroundActivityTracker;
	private turnUsage = new ClaudeTurnUsageAccumulator();
	// The streaming Claude SDK query survives across Raven turns and reports
	// total_cost_usd cumulatively for that query object. Keep the raw boundary
	// here so every Hlid `done` event exposes only the newly incurred cost.
	private lastProviderEstimatedCost = 0;
	private configuredMcpServers: PreparedClaudeMcpServers;
	private lastMcpApplyErrors: Record<string, string>;
	private readonly mcpPermissionModeOverrides = new Map<
		string,
		ProviderMcpPermissionModeOverride
	>();
	readonly setEffort?: (effort: string) => Promise<void>;

	constructor(
		makeQuery: (
			input: AsyncIterable<SdkUserMessage>,
			resumeId: string | undefined,
			mcpServers: Record<string, SdkMcpServerConfig>,
			disabledMcpjsonServers: string[],
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
		enableLiveEffort: boolean,
		private readonly exposeUsageWindows: boolean,
		private readonly exposeAccountInfo: boolean,
		private readonly hostMcpServers: Record<string, SdkMcpServerConfig>,
		initialMcpServers: PreparedClaudeMcpServers,
		private readonly reservedMcpServerNames: ReadonlySet<string>,
	) {
		this.makeQuery = makeQuery;
		this.abortController = abortController;
		this.resumeId = resumeId;
		if (enableLiveEffort) {
			this.setEffort = (effort) => this.applyEffort(effort);
		}
		this.backgroundActivities = new ClaudeBackgroundActivityTracker(
			hostParams.providerId ?? "claude",
			runtimeCwd,
		);
		this.configuredMcpServers = initialMcpServers;
		this.lastMcpApplyErrors = { ...initialMcpServers.errors };
	}

	private dynamicMcpServers(
		configured = this.configuredMcpServers,
	): Record<string, SdkMcpServerConfig> {
		return {
			...configured.dynamicServers,
			...this.hostMcpServers,
		};
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
		this.backgroundActivities.stop(taskId);
	}

	async listBackgroundActivities(): Promise<ProviderBackgroundActivity[]> {
		return this.backgroundActivities.list();
	}

	async controlBackgroundActivity(
		request: ProviderBackgroundActivityControl,
	): Promise<void> {
		if (!this.sdkQuery) throw new Error("Claude session is not active");
		if (request.action === "background") {
			const backgrounded = await this.sdkQuery.backgroundTasks();
			if (!backgrounded) {
				throw new Error("Claude has no matching foreground task to background");
			}
			this.backgroundActivities.markBackgrounded();
			return;
		}
		if (request.action === "stop") {
			const activity = this.backgroundActivities
				.list()
				.find((candidate) => candidate.activityId === request.activityId);
			if (!activity?.capabilities.stop) {
				throw new Error("That Claude background task is no longer running");
			}
			await this.sdkQuery.stopTask(request.activityId);
			this.backgroundActivities.stop(request.activityId);
			return;
		}
		throw new Error(
			`Claude does not support ${request.action} for background tasks`,
		);
	}

	async send(message: string, opts?: SendOptions): Promise<void> {
		const sdkMsg = buildSdkUserMessage(
			message,
			opts?.priority ?? "next",
			opts?.inputOrigin,
		);
		// Capture the first send so we can replay it if cold-resume retry kicks in.
		if (this.firstSend === null) this.firstSend = sdkMsg;
		// Lazily open the SDK query on first send so an empty session that's
		// never sent doesn't spawn the CLI.
		this.ensureSdkQuery();
		this.inputStream.push(sdkMsg);
	}

	async steer(message: string, opts?: SendOptions): Promise<void> {
		// In streaming-input mode Claude's immediate-priority user message is
		// folded into the active run instead of waiting for the next turn. Claude
		// still emits the interrupted run's result boundary before it starts the
		// steered continuation, so translateEvents must keep that boundary open.
		this.ensureSdkQuery();
		this.inputStream.push(
			buildSdkUserMessage(message, "now", opts?.inputOrigin),
		);
		this.pendingSteerContinuation = true;
	}

	async mcpServerStatus(): Promise<McpServerStatus[]> {
		if (!this.sdkQuery) return [];
		const providerStatuses =
			(await this.sdkQuery.mcpServerStatus()) as McpServerStatus[];
		const managed = new Set(this.configuredMcpServers.managedNames);
		const providerByName = new Map<string, McpServerStatus>();
		for (const status of providerStatuses) {
			if (!managed.has(status.name)) continue;
			const current = providerByName.get(status.name);
			// Claude may report both the disabled file-backed entry and Hlid's live
			// dynamic entry under one name. Prefer the actionable dynamic status.
			if (
				!current ||
				(current.status === "disabled" && status.status !== "disabled")
			) {
				providerByName.set(status.name, status);
			}
		}
		const nativeStatuses = providerStatuses.filter(
			(status) => !managed.has(status.name),
		);
		const disabled = new Set(this.configuredMcpServers.disabledNames);
		const projectStatuses = this.configuredMcpServers.managedNames.map(
			(name) => {
				const error = this.lastMcpApplyErrors[name];
				if (error) {
					return { name, status: "failed" as const, scope: "project", error };
				}
				if (disabled.has(name)) {
					return { name, status: "disabled" as const, scope: "project" };
				}
				const status = providerByName.get(name);
				return status
					? { ...status, scope: "project" }
					: { name, status: "pending" as const, scope: "project" };
			},
		);
		return [...nativeStatuses, ...projectStatuses].map((status) => {
			const permissionModeOverride = this.mcpPermissionModeOverrides.get(
				status.name,
			);
			return permissionModeOverride
				? { ...status, permissionModeOverride }
				: status;
		});
	}

	async reconnectMcpServer(serverName: string): Promise<void> {
		if (!this.sdkQuery) {
			throw new Error("Claude session is not active");
		}
		await this.sdkQuery.reconnectMcpServer(serverName);
	}

	async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
		if (!this.sdkQuery) {
			throw new Error("Claude session is not active");
		}
		await this.sdkQuery.toggleMcpServer(serverName, enabled);
	}

	get mcpPermissionModeOverrideAvailable(): boolean {
		return Boolean(
			this.sdkQuery &&
				!this.policyEnforced &&
				this.hostParams.permissionMode === "bypassPermissions",
		);
	}

	async setMcpPermissionModeOverride(
		serverName: string,
		mode: ProviderMcpPermissionModeOverride | null,
	): Promise<ProviderMcpPermissionModeOverrideResult> {
		if (!this.sdkQuery) {
			throw new Error("Claude session is not active");
		}
		if (this.policyEnforced) {
			throw new Error(
				"Hlid policy enforcement owns MCP approvals for this session.",
			);
		}
		if (this.hostParams.permissionMode !== "bypassPermissions") {
			throw new Error(
				"Claude MCP permission overrides require Auto-approve all for the live session.",
			);
		}
		const result = await this.sdkQuery.setMcpPermissionModeOverride(
			serverName,
			mode,
		);
		if (mode === null) this.mcpPermissionModeOverrides.delete(serverName);
		else this.mcpPermissionModeOverrides.set(serverName, mode);
		return result;
	}

	async setMcpServers(
		servers: ProviderMcpServerDefinition[],
	): Promise<ProviderMcpServerApplyResult | null> {
		const prepared = prepareClaudeMcpServers(
			servers,
			this.reservedMcpServerNames,
		);
		if (!this.sdkQuery) {
			this.configuredMcpServers = prepared;
			this.lastMcpApplyErrors = { ...prepared.errors };
			return null;
		}
		const result = await this.sdkQuery.setMcpServers(
			this.dynamicMcpServers(prepared),
		);
		this.configuredMcpServers = prepared;
		this.lastMcpApplyErrors = { ...prepared.errors, ...result.errors };
		return {
			added: result.added,
			removed: result.removed,
			errors: { ...this.lastMcpApplyErrors },
		};
	}

	async reloadSkills(): Promise<SlashCommand[] | null> {
		if (!this.sdkQuery) return null;
		const result = await this.sdkQuery.reloadSkills();
		const skills = result.skills as SlashCommand[];
		this.latestSkillCommands = skills;
		return skills;
	}

	async rewindFiles(
		userMessageId: string,
		options?: { dryRun?: boolean },
	): Promise<ProviderFileRewindResult> {
		if (!this.sdkQuery) {
			throw new Error("Claude session is not active");
		}
		return this.sdkQuery.rewindFiles(userMessageId, options);
	}

	async supportedCommands(): Promise<SlashCommand[]> {
		if (!this.sdkQuery) return [];
		if (this.latestSkillCommands !== null) return this.latestSkillCommands;
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

	private async applyEffort(effort: string): Promise<void> {
		const effortLevel = claudeSdkEffortLevel(effort);
		if (this.sdkQuery) {
			await this.sdkQuery.applyFlagSettings({ effortLevel });
		}
		this.hostParams.effort = effort;
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
		this.sdkQuery = this.createSdkQuery(this.resumeId);
	}

	private createSdkQuery(resumeId: string | undefined): SdkQuery {
		this.backgroundActivities.reset();
		return this.makeQuery(
			this.inputStream.iterate(),
			resumeId,
			this.dynamicMcpServers(),
			this.configuredMcpServers.managedNames,
		);
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
					self.sdkQuery = self.createSdkQuery(undefined);
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
		this.hasEmittedAssistantTextMessage = false;
		this.activeAssistantTextFrames.clear();
		const reconciled = this.turnUsage.reconcileMany(messages);
		this.turnUsage.reset();
		this.subagents.finishQuery();
		this.knownPermissionTools.clear();
		this.permissionToolResultFrames.clear();
		this.permissionToolResultFrameLinkCount = 0;
		this.permissionAdvisories.clear();
		const modelUsage = Object.assign(
			{},
			...messages.map((message) => message.modelUsage ?? {}),
		) as NonNullable<Extract<AgentEvent, { type: "done" }>["modelUsage"]>;
		const reportedEstimatedCost = messages.at(-1)?.total_cost_usd;
		let incrementalEstimatedCost: number | undefined;
		if (
			this.includeEstimatedCost &&
			typeof reportedEstimatedCost === "number" &&
			Number.isFinite(reportedEstimatedCost)
		) {
			incrementalEstimatedCost = Math.max(
				0,
				reportedEstimatedCost >= this.lastProviderEstimatedCost
					? reportedEstimatedCost - this.lastProviderEstimatedCost
					: reportedEstimatedCost,
			);
			this.lastProviderEstimatedCost = reportedEstimatedCost;
		}
		const completed: Extract<AgentEvent, { type: "done" }> = {
			...done,
			...(Object.keys(modelUsage).length > 0 ? { modelUsage } : {}),
			turns: messages.reduce((total, message) => total + message.num_turns, 0),
			durationMs: messages.reduce(
				(total, message) => total + (message.duration_ms ?? 0),
				0,
			),
			...(incrementalEstimatedCost !== undefined
				? { estimatedCost: incrementalEstimatedCost }
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

	private rememberProviderRetractions(
		providerSessionId: string,
		providerUuids: readonly string[],
	): void {
		if (!providerSessionId || providerUuids.length === 0) return;
		let tombstones = this.retractedProviderFrames.get(providerSessionId);
		if (!tombstones) {
			tombstones = new Set();
			this.retractedProviderFrames.set(providerSessionId, tombstones);
		}
		const activeText = this.activeAssistantTextFrames.get(providerSessionId);
		for (const providerUuid of providerUuids) {
			if (!providerUuid) continue;
			tombstones.add(providerUuid);
			this.backgroundActivities.retractProviderFrame(
				providerSessionId,
				providerUuid,
			);
			activeText?.delete(providerUuid);
			const toolIds = this.providerFrameToolIds
				.get(providerSessionId)
				?.get(providerUuid);
			for (const toolId of toolIds ?? []) {
				this.subagents.suppressTool(toolId);
				this.knownPermissionTools.delete(
					claudePermissionKey(providerSessionId, toolId),
				);
			}
			this.providerFrameToolIds.get(providerSessionId)?.delete(providerUuid);
			this.subagents.retractToolResultFrame(providerSessionId, providerUuid);
			const permissionResultFrameKey = claudePermissionFrameKey(
				providerSessionId,
				providerUuid,
			);
			const settledToolKeys = this.permissionToolResultFrames.get(
				permissionResultFrameKey,
			);
			for (const key of settledToolKeys ?? []) {
				const known = this.knownPermissionTools.get(key);
				if (!known) continue;
				known.settledFrameCount = Math.max(0, known.settledFrameCount - 1);
			}
			this.permissionToolResultFrameLinkCount = Math.max(
				0,
				this.permissionToolResultFrameLinkCount - (settledToolKeys?.size ?? 0),
			);
			this.permissionToolResultFrames.delete(permissionResultFrameKey);
		}
		if (activeText?.size === 0) {
			this.activeAssistantTextFrames.delete(providerSessionId);
		}
		this.hasEmittedAssistantTextMessage =
			this.activeAssistantTextFrames.size > 0;
	}

	private isProviderFrameRetracted(
		providerSessionId: string,
		providerUuid: string,
	): boolean {
		return (
			this.retractedProviderFrames.get(providerSessionId)?.has(providerUuid) ===
			true
		);
	}

	private rememberAssistantTextFrame(
		providerSessionId: string,
		providerUuid: string,
	): void {
		let frames = this.activeAssistantTextFrames.get(providerSessionId);
		if (!frames) {
			frames = new Set();
			this.activeAssistantTextFrames.set(providerSessionId, frames);
		}
		frames.add(providerUuid);
	}

	private rememberAssistantToolFrame(
		providerSessionId: string,
		providerUuid: string,
		toolIds: string[],
	): void {
		if (toolIds.length === 0) return;
		let frames = this.providerFrameToolIds.get(providerSessionId);
		if (!frames) {
			frames = new Map();
			this.providerFrameToolIds.set(providerSessionId, frames);
		}
		frames.set(providerUuid, toolIds);
	}

	private rememberPermissionAdvisory(
		message: Extract<SDKMessage, { type: "system" }>,
	): void {
		const raw = message as unknown as Record<string, unknown>;
		const providerSessionId = exactClaudePermissionId(raw.session_id);
		const toolId = exactClaudePermissionId(raw.tool_use_id);
		if (!providerSessionId || !toolId) return;
		const agentId = exactClaudePermissionId(raw.agent_id);
		const reasonType = boundedClaudePermissionText(
			raw.decision_reason_type,
			CLAUDE_PERMISSION_REASON_TYPE_MAX_CHARS,
		);
		const reason = boundedClaudePermissionText(
			raw.decision_reason,
			CLAUDE_PERMISSION_REASON_MAX_CHARS,
		);
		const providerMessage = boundedClaudePermissionText(
			raw.message,
			CLAUDE_PERMISSION_MESSAGE_MAX_CHARS,
		);
		retainBoundedMapEntry(
			this.permissionAdvisories,
			claudePermissionKey(providerSessionId, toolId),
			{
				...(agentId ? { agentId } : {}),
				...(reasonType ? { reasonType } : {}),
				...(reason ? { reason } : {}),
				...(providerMessage ? { message: providerMessage } : {}),
			},
		);
	}

	private observePermissionToolEvents(
		events: readonly AgentEvent[],
		fallbackProviderSessionId?: string,
	): void {
		for (const event of events) {
			if (event.type === "tool_start") {
				const providerSessionId =
					event.providerFrame?.providerSessionId ?? fallbackProviderSessionId;
				if (!providerSessionId) continue;
				const toolName = boundedClaudePermissionText(
					event.name,
					CLAUDE_PERMISSION_NAME_MAX_CHARS,
				);
				if (!toolName) continue;
				const key = claudePermissionKey(providerSessionId, event.toolId);
				const previous = this.knownPermissionTools.get(key);
				retainBoundedMapEntry(this.knownPermissionTools, key, {
					toolName,
					...(exactClaudePermissionToolName(event.name)
						? { synthesisToolName: event.name }
						: {}),
					settledWithoutFrame: previous?.settledWithoutFrame ?? false,
					settledFrameCount: previous?.settledFrameCount ?? 0,
				});
			} else if (event.type === "tool_result") {
				const providerSessionId =
					event.providerFrame?.providerSessionId ?? fallbackProviderSessionId;
				if (!providerSessionId) continue;
				const key = claudePermissionKey(providerSessionId, event.toolId);
				const known = this.knownPermissionTools.get(key);
				if (!known) continue;
				if (!event.providerFrame) {
					known.settledWithoutFrame = true;
					continue;
				}
				const frameKey = claudePermissionFrameKey(
					event.providerFrame.providerSessionId,
					event.providerFrame.providerUuid,
				);
				let toolKeys = this.permissionToolResultFrames.get(frameKey);
				if (toolKeys?.has(key)) continue;
				if (
					this.permissionToolResultFrameLinkCount >=
					CLAUDE_PERMISSION_STATE_LIMIT
				) {
					// Dropping correlation must never make a real result look unresolved.
					known.settledWithoutFrame = true;
					continue;
				}
				if (!toolKeys) {
					toolKeys = new Set();
					this.permissionToolResultFrames.set(frameKey, toolKeys);
				}
				if (toolKeys.has(key)) continue;
				toolKeys.add(key);
				this.permissionToolResultFrameLinkCount += 1;
				known.settledFrameCount += 1;
			}
		}
	}

	private reconcilePermissionDenials(
		message: Extract<SDKMessage, { type: "result" }>,
	): AgentEvent[] {
		const providerSessionId = exactClaudePermissionId(message.session_id);
		if (!providerSessionId) return [];
		const events: AgentEvent[] = [];
		const seen = new Set<string>();
		const permissionDenials = message.permission_denials ?? [];
		for (
			let index = 0;
			index < Math.min(permissionDenials.length, CLAUDE_PERMISSION_STATE_LIMIT);
			index++
		) {
			const denial = permissionDenials[index];
			if (!denial) continue;
			const toolId = exactClaudePermissionId(denial.tool_use_id);
			if (!toolId) continue;
			const key = claudePermissionKey(providerSessionId, toolId);
			if (seen.has(key) || this.reportedPermissionDenials.has(key)) continue;
			seen.add(key);
			const known = this.knownPermissionTools.get(key);
			const advisory = this.permissionAdvisories.get(key);
			const toolName =
				boundedClaudePermissionText(
					denial.tool_name,
					CLAUDE_PERMISSION_NAME_MAX_CHARS,
				) ?? known?.toolName;
			if (!toolName) continue;
			const providerMessage =
				advisory?.message ?? `${toolName} was blocked by Claude.`;
			events.push({
				type: "provider_permission_denied",
				providerSessionId,
				toolId,
				toolName,
				...(advisory?.agentId ? { agentId: advisory.agentId } : {}),
				...(advisory?.reasonType ? { reasonType: advisory.reasonType } : {}),
				...(advisory?.reason ? { reason: advisory.reason } : {}),
				message: providerMessage,
			});
			const exactDeniedToolName = exactClaudePermissionToolName(
				denial.tool_name,
			);
			if (
				known?.synthesisToolName !== undefined &&
				exactDeniedToolName === known.synthesisToolName &&
				!known.settledWithoutFrame &&
				known.settledFrameCount === 0
			) {
				events.push({
					type: "tool_result",
					toolId,
					content: providerMessage,
					isError: true,
					providerSessionId,
				});
				known.settledWithoutFrame = true;
			}
			retainBoundedSetEntry(this.reportedPermissionDenials, key);
			this.permissionAdvisories.delete(key);
		}
		// A system/permission_denied frame is advisory only. Once the matching
		// result boundary arrives, discard every unconfirmed advisory for that
		// native session instead of leaking it into a later turn.
		for (const key of this.permissionAdvisories.keys()) {
			try {
				const [session] = JSON.parse(key) as [string, string];
				if (session === providerSessionId)
					this.permissionAdvisories.delete(key);
			} catch {
				this.permissionAdvisories.delete(key);
			}
		}
		return events;
	}

	private setLifecycleNativeSessionId(providerSessionId: string): void {
		if (this.lifecycleNativeSessionId === providerSessionId) return;
		this.lifecycleNativeSessionId = providerSessionId;
		this.lifecycleNativeSessionGeneration++;
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
			providerSessionId: string | null;
			providerSessionGeneration: number | null;
			deadlineMs: number;
			awaitTaskVersion: number | null;
			usageDrainDeadlineMs: number | null;
			steerContinuationExpected: boolean;
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
				const rawProviderSessionId = exactClaudePermissionId(
					(message as { session_id?: unknown }).session_id,
				);
				const sessionStateChanged =
					message.type === "system" &&
					(message as { subtype?: unknown }).subtype ===
						"session_state_changed";
				const sessionInit =
					message.type === "system" &&
					(message as { subtype?: unknown }).subtype === "init";
				if (rawProviderSessionId && !sessionStateChanged) {
					if (this.currentNativeSessionId === undefined || sessionInit) {
						this.currentNativeSessionId = rawProviderSessionId;
					}
					if (
						sessionInit ||
						(this.lifecycleNativeSessionId === undefined &&
							message.type === "result")
					) {
						this.setLifecycleNativeSessionId(rawProviderSessionId);
					}
				}
				if (sessionStateChanged) {
					const state = (message as { state?: unknown }).state;
					const providerUuid = exactClaudePermissionId(
						(message as { uuid?: unknown }).uuid,
					);
					if (
						rawProviderSessionId &&
						providerUuid &&
						(state === "idle" ||
							state === "running" ||
							state === "requires_action")
					) {
						const eventKey = claudeSessionStateEventKey(
							rawProviderSessionId,
							providerUuid,
						);
						const duplicate = this.seenSessionStateEvents.has(eventKey);
						if (!duplicate) {
							retainBoundedSetEntry(this.seenSessionStateEvents, eventKey);
						}
						if (
							!duplicate &&
							state === "idle" &&
							pendingResult !== null &&
							pendingResult.providerSessionId === rawProviderSessionId &&
							pendingResult.providerSessionGeneration ===
								this.lifecycleNativeSessionGeneration &&
							this.lifecycleNativeSessionId === rawProviderSessionId &&
							pendingResult.steerContinuationExpected &&
							pendingResult.awaitTaskVersion === null &&
							pendingResult.usageDrainDeadlineMs === null &&
							!pendingResult.workflowContinuationStarted &&
							!pendingResult.workflowContinuationExpected &&
							pendingResult.workflowContinuationDeadlineMs === null &&
							!this.subagents.hasUnsettledTasks() &&
							!this.subagents.hasActiveWorkflowTasks() &&
							!this.subagents.hasWorkflowContinuationPotential() &&
							!this.subagents.hasWorkflowContinuationCandidate()
						) {
							yield this.completeResult(
								pendingResult.results,
								pendingResult.done,
							);
							hadText = false;
							pendingResult = null;
							workflowProgressRefreshAtMs = null;
						}
					}
					// Native session state is supporting lifecycle evidence only. It is
					// never translated, persisted, or allowed to open/close Hlid state.
					continue;
				}
				if (
					message.type === "system" &&
					(message as { subtype?: unknown }).subtype === "permission_denied"
				) {
					this.rememberPermissionAdvisory(message);
				}
				if (message.type === "conversation_reset") {
					this.resumeId = message.new_conversation_id;
					this.currentNativeSessionId = message.new_conversation_id;
					this.setLifecycleNativeSessionId(message.new_conversation_id);
				}
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
				let suppressProviderFrame = false;
				let retractionChangedText = false;
				let tracksProviderText = false;
				let acceptedToolResultFrame: ClaudeProviderFrame | null = null;
				if (message.type === "assistant") {
					const supersededIds = (message.supersedes ?? []).filter(
						(id) => id && id !== message.uuid,
					);
					if (supersededIds.length > 0) {
						this.rememberProviderRetractions(message.session_id, supersededIds);
						retractionChangedText = true;
					}
					const parentToolUseId = message.parent_tool_use_id;
					if (this.subagents.shouldIgnoreChildUsage(parentToolUseId)) {
						const accountLateUsage =
							this.subagents.shouldAccountIgnoredChildUsage(parentToolUseId);
						if (accountLateUsage) this.turnUsage.record(message);
						for (const block of message.message.content) {
							if (block.type === "tool_use") {
								this.subagents.suppressTool(block.id, accountLateUsage);
							}
						}
						const ignoredSupersededIds = [...new Set(supersededIds)];
						if (ignoredSupersededIds.length > 0) {
							yield {
								type: "provider_message_retraction",
								ids: ignoredSupersededIds,
								providerSessionId: message.session_id,
								source: "assistant_supersedes",
							};
						}
						continue;
					}
					if (message.session_id && message.uuid) {
						tracksProviderText = true;
						suppressProviderFrame = this.isProviderFrameRetracted(
							message.session_id,
							message.uuid,
						);
						if (!suppressProviderFrame && assistantFrameText(message)) {
							this.rememberAssistantTextFrame(message.session_id, message.uuid);
						}
						if (!suppressProviderFrame) {
							const toolIds = message.message.content.flatMap((block) =>
								block.type === "tool_use" ? [block.id] : [],
							);
							for (const toolId of toolIds) this.subagents.acceptTool(toolId);
							this.rememberAssistantToolFrame(
								message.session_id,
								message.uuid,
								toolIds,
							);
						} else {
							for (const block of message.message.content) {
								if (block.type === "tool_use") {
									this.subagents.suppressTool(block.id);
								}
							}
						}
					}
				} else if (
					message.type === "system" &&
					message.subtype === "model_refusal_fallback"
				) {
					this.rememberProviderRetractions(
						message.session_id,
						message.retracted_message_uuids ?? [],
					);
					retractionChangedText = true;
				} else if (message.type === "user") {
					const content = (message as { message?: { content?: unknown } })
						.message?.content;
					const hasToolResult =
						Array.isArray(content) &&
						content.some(
							(block) =>
								typeof block === "object" &&
								block !== null &&
								(block as { type?: unknown }).type === "tool_result",
						);
					if (
						hasToolResult &&
						typeof message.session_id === "string" &&
						typeof message.uuid === "string"
					) {
						suppressProviderFrame = this.isProviderFrameRetracted(
							message.session_id,
							message.uuid,
						);
						if (!suppressProviderFrame) {
							const toolIds = content.flatMap((block) =>
								typeof block === "object" &&
								block !== null &&
								(block as { type?: unknown }).type === "tool_result" &&
								typeof (block as { tool_use_id?: unknown }).tool_use_id ===
									"string"
									? [String((block as { tool_use_id: string }).tool_use_id)]
									: [],
							);
							this.subagents.captureToolResultFrame(
								message.session_id,
								message.uuid,
								toolIds,
							);
							acceptedToolResultFrame = {
								providerSessionId: message.session_id,
								providerUuid: message.uuid,
							};
						}
					}
				}
				if (message.type === "assistant") {
					const parentToolUseId = message.parent_tool_use_id;
					this.subagents.trackChildParent(parentToolUseId);
					this.turnUsage.record(message);
				}
				if (!suppressProviderFrame) this.backgroundActivities.observe(message);
				if (suppressProviderFrame && message.type === "user") continue;
				const translation = translateSdkMessage(
					message,
					hadText,
					this.subagents,
					this.includeEstimatedCost,
					this.normalizeModel,
				);
				if (suppressProviderFrame) {
					translation.events = translation.events.filter(
						(event) =>
							event.type === "provider_message_retraction" ||
							event.type === "usage",
					);
					translation.hadText = hadText;
				}
				if (message.type === "assistant") {
					const firstTextIndex = translation.events.findIndex(
						(event) => event.type === "text_delta",
					);
					if (firstTextIndex >= 0) {
						if (this.hasEmittedAssistantTextMessage) {
							translation.events.splice(firstTextIndex, 0, {
								type: "assistant_message_boundary",
								...(typeof message.uuid === "string" &&
								typeof message.session_id === "string"
									? {
											providerFrame: {
												providerUuid: message.uuid,
												providerSessionId: message.session_id,
											},
										}
									: {}),
							});
						}
						this.hasEmittedAssistantTextMessage = true;
					}
				}
				if (message.type === "result") {
					const denied = this.reconcilePermissionDenials(message);
					const doneIndex = translation.events.findIndex(
						(event) => event.type === "done",
					);
					translation.events.splice(
						doneIndex < 0 ? translation.events.length : doneIndex,
						0,
						...denied,
					);
				}
				this.observePermissionToolEvents(
					translation.events,
					rawProviderSessionId ?? this.currentNativeSessionId,
				);
				for (const event of translation.events) {
					if (event.type === "commands_changed") {
						this.latestSkillCommands = event.commands;
					}
				}
				hadText =
					tracksProviderText || retractionChangedText
						? this.activeAssistantTextFrames.size > 0
						: translation.hadText;
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
					if (!suppressProviderFrame && shouldRefreshWorkflow) {
						yield* await this.subagents.refreshWorkflowProgress(
							this.runtimeCwd,
							this.workflowProgressReader,
							message as ClaudeTaskMessage,
						);
					}
					if (acceptedToolResultFrame) {
						this.subagents.finalizeToolResultFrame(
							acceptedToolResultFrame.providerSessionId,
							acceptedToolResultFrame.providerUuid,
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
					(pendingResult.steerContinuationExpected ||
						pendingResult.workflowContinuationStarted ||
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
				const steerContinuationExpected =
					this.pendingSteerContinuation && message.subtype === "success";
				this.pendingSteerContinuation = false;
				const hasUnsettledTasks = this.subagents.hasUnsettledTasks();
				const backgroundRequested =
					message.terminal_reason === "background_requested" &&
					this.subagents.hasOwnedTaskCandidates();
				if (
					steerContinuationExpected ||
					hasUnsettledTasks ||
					backgroundRequested
				) {
					pendingResult = {
						results,
						done,
						providerSessionId: rawProviderSessionId ?? null,
						providerSessionGeneration:
							rawProviderSessionId &&
							this.lifecycleNativeSessionId === rawProviderSessionId
								? this.lifecycleNativeSessionGeneration
								: null,
						deadlineMs: steerContinuationExpected
							? Number.POSITIVE_INFINITY
							: Date.now() + CLAUDE_BACKGROUND_SETTLE_TIMEOUT_MS,
						awaitTaskVersion:
							backgroundRequested && !hasUnsettledTasks
								? this.subagents.taskVersion()
								: null,
						usageDrainDeadlineMs: null,
						steerContinuationExpected,
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

function claudeLiveQueryEnv(
	base: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
	return {
		...(base ?? process.env),
		CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
	};
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
	readonly capabilities = {
		workflowCatalog: true,
		backgroundActivities: {
			maturity: "experimental",
			operations: ["background", "list", "stop"],
		},
	} as const;
	hlidToolLoading() {
		const hlidTools = describeHlidToolLoading(HLID_AGENT_TOOL_SPECS, true);
		const obsidianTools = describeHlidToolLoading(
			OBSIDIAN_AGENT_TOOL_SPECS,
			true,
		);
		return [
			buildHlidToolLoadingSummary("hlid", hlidTools),
			buildHlidToolLoadingSummary("hlid_obsidian", obsidianTools),
		];
	}
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

	async discoverCapabilities(context: { cwd: string }) {
		return discoverClaudeProviderCapabilities({
			providerId: this.providerId,
			cwd: toProviderRuntimePath(context.cwd, context.cwd),
			snapshot: getClaudeWarmupSnapshot(context.cwd),
		});
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
				settings: buildHlidClaudeSettings(),
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
				settings: buildHlidClaudeSettings(),
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
		const sdkEnv = claudeLiveQueryEnv(claudeSdkEnv(params.cwd, this.sdkEnv));
		const hostInteractions = createClaudeHostInteractionHandlers(params);
		const reservedMcpServerNames = new Set([
			HLID_AGENT_NAMESPACE,
			OBSIDIAN_AGENT_NAMESPACE,
		]);
		const configuredMcpServers = (() => {
			try {
				return prepareClaudeMcpServers(
					readProjectMcpFile(params.cwd).servers,
					reservedMcpServerNames,
				);
			} catch (error) {
				console.error(
					`[claude] Failed to read MCP configuration for ${params.cwd}:`,
					error,
				);
				return prepareClaudeMcpServers([], reservedMcpServerNames);
			}
		})();
		const hostMcpServers: Record<string, SdkMcpServerConfig> = {
			[HLID_AGENT_NAMESPACE]: createHlidSdkServer(params),
			[OBSIDIAN_AGENT_NAMESPACE]: createObsidianSdkServer(
				params.permissionMode === "bypassPermissions" && !params.policyEnforced
					? params.canUseTool
					: undefined,
				abortController.signal,
			),
		};

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
			mcpServers: Record<string, SdkMcpServerConfig>,
			disabledMcpjsonServers: string[],
		): SdkQuery =>
			query({
				prompt: input as unknown as Parameters<typeof query>[0]["prompt"],
				options: {
					cwd: params.cwd,
					mcpServers,
					settings: buildHlidClaudeSettings(
						disabledMcpjsonServers,
						params.onProviderInitiatedTurn
							? params.claudeCrossSessionInbound
							: "refuse",
					),
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
						? { effort: claudeSdkEffortLevel(params.effort ?? "medium") }
						: {}),
					env: sdkEnv,
					...(params.maxTurns !== undefined
						? { maxTurns: params.maxTurns }
						: {}),
					...(params.executable
						? { pathToClaudeCodeExecutable: params.executable }
						: {}),
					allowDangerouslySkipPermissions:
						params.permissionMode === "bypassPermissions" &&
						!params.policyEnforced,
					...hostInteractions,
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
						: {
								enableFileCheckpointing: true,
								extraArgs: { "replay-user-messages": null },
							}),
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
			this.passSdkEffort,
			this.exposeUsageWindows,
			this.exposeAccountInfo,
			hostMcpServers,
			configuredMcpServers,
			reservedMcpServerNames,
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
