import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
	type Client,
	ClientSideConnection,
	type ContentBlock,
	CreateElicitationRequest,
	type CreateElicitationResponse,
	ElicitationPropertySchema,
	type InitializeResponse,
	type McpCapabilities,
	type McpServer,
	MultiSelectItems,
	ndJsonStream,
	type PermissionOption,
	PROTOCOL_VERSION,
	RequestError,
	type SessionConfigOption,
	type SessionModeState,
	type SessionUpdate,
	type ToolCallContent,
	type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { AcpExecutionTarget } from "../lib/acpExecutionTarget";
import {
	type AcpModelVisibilityFilter,
	acpModelVisible,
} from "../lib/acpModelFilter";
import { describeHlidToolLoading } from "../lib/hlidContext";
import { legacyProjectMcpAdapter } from "../lib/mcpConfig";
import { declaredPathKey } from "../lib/paths";
import { replacementUnifiedDiff } from "../lib/unifiedDiff";
import { discoverAcpProviderCapabilities } from "./acpCapabilityDiscovery";
import {
	type AcpExecutionAdapter,
	type AcpExecutionAdapterFactory,
	type AcpStartedProcess,
	createAcpExecutionAdapter,
} from "./acpExecutionAdapter";
import {
	acpSelectValues,
	findAcpSessionConfigOption as configOption,
} from "./acpSessionConfig";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	ForkSessionParams,
	ForkSessionResult,
	McpServerStatus,
	ProviderEffortInfo,
	ProviderForkCapability,
	ProviderModelInfo,
	ProviderPromptContent,
	ProviderSessionConfigSnapshot,
	SendOptions,
	SlashCommand,
	ToolProgressSnapshot,
} from "./agentProvider";
import { HLID_AGENT_NAMESPACE, HLID_AGENT_TOOL_SPECS } from "./hlidAgentTools";
import { hlidMcpProcessCommand } from "./hlidMcpServer";
import { isHtmlPlanPath } from "./htmlPlanPath";
import {
	OBSIDIAN_AGENT_NAMESPACE,
	OBSIDIAN_AGENT_TOOL_SPECS,
} from "./obsidianAgentTools";
import { getObsidianCliStatus } from "./obsidianCli";
import { isObsidianRunCommandRequest } from "./obsidianCommandApproval";
import { obsidianMcpProcessCommand } from "./obsidianMcpServer";
import { providerElicitationQuestions } from "./providerElicitation";
import { createSlowOperationObserver } from "./requestDiagnostics";

export type AcpLifecycleTimeouts = {
	preparationMs: number;
	spawnMs: number;
	initializeMs: number;
	sessionMs: number;
	configMs: number;
	modeMs: number;
	authenticationMs: number;
	forkMs: number;
	inspectionMs: number;
	interruptGraceMs: number;
	terminateGraceMs: number;
};

const DEFAULT_ACP_TIMEOUTS: AcpLifecycleTimeouts = {
	preparationMs: 10_000,
	spawnMs: 5_000,
	initializeMs: 10_000,
	sessionMs: 10_000,
	configMs: 10_000,
	modeMs: 10_000,
	authenticationMs: 120_000,
	forkMs: 15_000,
	inspectionMs: 9_000,
	interruptGraceMs: 1_500,
	terminateGraceMs: 750,
};
const MAX_ACP_FORK_CAPABILITY_WORKSPACES = 64;
const ACP_FORK_CAPABILITY_TTL_MS = 60_000;
const MAX_ACP_MODEL_EFFORT_PROBES = 32;
const MAX_ACP_MODEL_EFFORT_PROBE_MS = 750;
const observeAcpStartup = createSlowOperationObserver({
	scope: "acp startup",
	thresholdMs: 500,
});

function acpTimeouts(options: AcpProviderOptions): AcpLifecycleTimeouts {
	return { ...DEFAULT_ACP_TIMEOUTS, ...options.timeouts };
}

class AcpPhaseError extends Error {
	constructor(
		readonly phase: string,
		detail: string,
		options?: ErrorOptions,
	) {
		super(`ACP ${phase} ${detail}`, options);
		this.name = "AcpPhaseError";
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function appendAcpStderr(error: unknown, stderr: string): Error {
	const message = errorText(error);
	const detail = stderr.trim();
	if (!detail || message.includes("ACP stderr:")) {
		return error instanceof Error ? error : new Error(message);
	}
	return new Error(`${message}\nACP stderr: ${detail}`, {
		cause: error,
	});
}

function causedByRequestError(error: unknown): boolean {
	let current = error;
	const seen = new Set<unknown>();
	while (current instanceof Error && !seen.has(current)) {
		if (current instanceof RequestError) return true;
		seen.add(current);
		current = current.cause;
	}
	return false;
}

async function runAcpPhase<T>(options: {
	phase: string;
	timeoutMs: number;
	signal?: AbortSignal;
	run: () => T | Promise<T>;
}): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new AcpPhaseError(
						options.phase,
						`timed out after ${options.timeoutMs}ms`,
					),
				),
			options.timeoutMs,
		);
	});
	const cancelled = options.signal
		? new Promise<never>((_, reject) => {
				onAbort = () =>
					reject(
						new AcpPhaseError(
							options.phase,
							`cancelled: ${errorText(options.signal?.reason ?? "cancelled")}`,
						),
					);
				if (options.signal?.aborted) onAbort();
				else options.signal?.addEventListener("abort", onAbort, { once: true });
			})
		: null;
	try {
		const operation = Promise.resolve().then(options.run);
		return await Promise.race(
			cancelled ? [operation, timeout, cancelled] : [operation, timeout],
		);
	} catch (error) {
		if (error instanceof AcpPhaseError) throw error;
		throw new AcpPhaseError(options.phase, `failed: ${errorText(error)}`, {
			cause: error,
		});
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort) options.signal?.removeEventListener("abort", onAbort);
	}
}

function waitForPromptSettlement(
	prompt: ActiveAcpPrompt,
	timeoutMs: number,
): Promise<boolean> {
	if (prompt.settled) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		void prompt.promise.then(
			() => finish(true),
			() => finish(true),
		);
	});
}

async function startAcpProcess(options: {
	provider: AcpProviderOptions;
	cwd: string;
	env: Record<string, string>;
	signal?: AbortSignal;
}): Promise<AcpStartedProcess> {
	const timeouts = acpTimeouts(options.provider);
	const effectiveEnv = { ...process.env, ...options.env };
	try {
		return await runAcpPhase({
			phase: "process spawn",
			timeoutMs: timeouts.preparationMs + timeouts.spawnMs,
			signal: options.signal,
			run: () =>
				acpAdapter(options.provider).start({
					command: options.provider.command,
					args: options.provider.args ?? [],
					hostCwd: options.cwd,
					env: effectiveEnv,
					forwardedEnvNames: Object.keys(options.env),
					signal: options.signal,
					preparationTimeoutMs: timeouts.preparationMs,
					spawnTimeoutMs: timeouts.spawnMs,
				}),
		});
	} catch (error) {
		if (error instanceof AcpPhaseError) throw error;
		throw new AcpPhaseError("process spawn", `failed: ${errorText(error)}`, {
			cause: error,
		});
	}
}

export type AcpProcessEnvironment = Readonly<{
	environment: Record<string, string>;
	release: () => void | Promise<void>;
}>;

export type AcpProcessEnvironmentResolver = (input: {
	environment: Readonly<Record<string, string>>;
	signal?: AbortSignal;
}) => AcpProcessEnvironment | Promise<AcpProcessEnvironment>;

export type AcpProviderOptions = {
	id: string;
	label: string;
	command: string;
	args?: string[];
	target?: AcpExecutionTarget;
	/** Injectable target adapter factory. Primarily used by lifecycle tests. */
	executionAdapter?: AcpExecutionAdapterFactory;
	env?:
		| Record<string, string>
		| (() => Record<string, string> | Promise<Record<string, string>>);
	/** Resolve secrets/capabilities for one exact child spawn, with its cleanup. */
	processEnvironment?: AcpProcessEnvironmentResolver;
	/** Translate Hlid's persisted model id into the ACP agent's config value. */
	requestModel?: (model: string) => string;
	/** Hlid-owned visibility enforced after the ACP agent advertises models. */
	modelFilter?: AcpModelVisibilityFilter;
	/** Workspace used for provider-owned metadata sessions. */
	discoveryCwd?: string;
	/** Opaque runtime/config identity used to isolate persisted provider metadata. */
	metadataCacheIdentity?: string;
	/** Provider-neutral lifecycle budgets. Primarily injectable for tests. */
	timeouts?: Partial<AcpLifecycleTimeouts>;
	/** Last registry-owned availability result, used before the first live check. */
	initialAvailability?: { available: boolean; reason?: string };
};

function acpAdapter(options: AcpProviderOptions): AcpExecutionAdapter {
	return (options.executionAdapter ?? createAcpExecutionAdapter)(
		options.target,
	);
}

async function resolveAcpEnv(
	env: AcpProviderOptions["env"],
): Promise<Record<string, string>> {
	return typeof env === "function" ? await env() : (env ?? {});
}

function onceProcessEnvironmentRelease(
	release: () => void | Promise<void>,
): () => Promise<void> {
	let pending: Promise<void> | null = null;
	return () => {
		pending ??= Promise.resolve().then(release);
		return pending;
	};
}

async function resolveAcpProcessEnvironment(
	options: AcpProviderOptions,
	environment: Record<string, string>,
	signal?: AbortSignal,
): Promise<{
	environment: Record<string, string>;
	release: () => Promise<void>;
}> {
	const resolved = options.processEnvironment
		? await options.processEnvironment({
				environment: { ...environment },
				signal,
			})
		: { environment, release: () => {} };
	return {
		environment: { ...resolved.environment },
		release: onceProcessEnvironmentRelease(resolved.release),
	};
}

async function acquireAcpProcessEnvironment(options: {
	provider: AcpProviderOptions;
	environment: Record<string, string>;
	phase: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<{
	environment: Record<string, string>;
	release: () => Promise<void>;
}> {
	const acquiring = resolveAcpProcessEnvironment(
		options.provider,
		options.environment,
		options.signal,
	);
	try {
		return await runAcpPhase({
			phase: options.phase,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
			run: () => acquiring,
		});
	} catch (error) {
		void acquiring.then(({ release }) => release()).catch(() => {});
		throw error;
	}
}

type QueueResult<T> = IteratorResult<T>;

type AcpUsageTotals = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	reported: boolean;
};

class AsyncEventQueue<T> {
	private values: T[] = [];
	private waiters: Array<{
		resolve: (value: QueueResult<T>) => void;
		reject: (error: unknown) => void;
	}> = [];
	private ended = false;
	private error: unknown;

	push(value: T): void {
		if (this.ended) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ value, done: false });
		else this.values.push(value);
	}

	end(error?: unknown): void {
		if (this.ended) return;
		this.ended = true;
		this.error = error;
		for (const waiter of this.waiters.splice(0)) {
			if (error) waiter.reject(error);
			else waiter.resolve({ value: undefined as T, done: true });
		}
	}

	async next(): Promise<QueueResult<T>> {
		const value = this.values.shift();
		if (value !== undefined) return { value, done: false };
		if (this.ended) {
			if (this.error) throw this.error;
			return { value: undefined as T, done: true };
		}
		return new Promise((resolve, reject) =>
			this.waiters.push({ resolve, reject }),
		);
	}
}

function textFromContent(content: ContentBlock): string | null {
	return content.type === "text" ? content.text : null;
}

function json(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function toolContentText(
	content: ToolCallContent[] | null | undefined,
): string {
	if (!content?.length) return "";
	return content
		.map((item) => {
			if (item.type === "content") {
				return textFromContent(item.content) ?? json(item.content);
			}
			if (item.type === "diff") {
				return [
					`File: ${item.path}`,
					...(item.oldText != null ? ["--- before", item.oldText] : []),
					"+++ after",
					item.newText,
				].join("\n");
			}
			return `Terminal: ${item.terminalId}`;
		})
		.filter(Boolean)
		.join("\n\n");
}

function toolResultText(update: ToolCallUpdate): string {
	const content = toolContentText(update.content);
	if (content) return content;
	if (typeof update.rawOutput === "string") return update.rawOutput;
	if (update.rawOutput != null) return json(update.rawOutput);
	return "";
}

const ACP_TOOL_PROGRESS_CHARS = 16_000;
const ACP_PERMISSION_DESCRIPTION_CHARS = 2_000;
const ACP_TOOL_PROGRESS_THROTTLE_MS = 100;

function boundedText(
	value: string,
	limit: number,
): {
	text: string;
	truncated: boolean;
} {
	return value.length <= limit
		? { text: value, truncated: false }
		: { text: `${value.slice(0, limit - 1)}…`, truncated: true };
}

function toolProgressSnapshot(
	update: ToolCallUpdate,
): ToolProgressSnapshot | null {
	const content = toolResultText(update);
	const bounded = content
		? boundedText(content, ACP_TOOL_PROGRESS_CHARS)
		: null;
	const title = update.title?.trim() || undefined;
	const locations = update.locations?.slice(0, 50).flatMap((location) =>
		location.path.trim()
			? [
					{
						path: location.path,
						...(location.line != null ? { line: location.line } : {}),
					},
				]
			: [],
	);
	if (
		!title &&
		!bounded &&
		!locations?.length &&
		update.status !== "in_progress"
	) {
		return null;
	}
	return {
		status: update.status === "pending" ? "pending" : "in_progress",
		...(title ? { title } : {}),
		...(bounded
			? {
					content: bounded.text,
					...(bounded.truncated ? { contentTruncated: true } : {}),
				}
			: {}),
		...(locations?.length ? { locations } : {}),
	};
}

function acpPermissionDescription(
	toolCall: ToolCallUpdate,
): string | undefined {
	const textContent = (toolCall.content ?? []).flatMap((item) => {
		if (item.type !== "content") return [];
		const text = textFromContent(item.content);
		return text ? [text] : [];
	});
	const content =
		textContent.length > 0
			? textContent.join("\n\n")
			: toolContentText(toolCall.content);
	return content
		? boundedText(content, ACP_PERMISSION_DESCRIPTION_CHARS).text
		: undefined;
}

function acpDiffChanges(content: ToolCallContent[] | null | undefined) {
	return (content ?? []).slice(0, 20).flatMap((item) => {
		if (item.type !== "diff") return [];
		const bounded = boundedText(
			replacementUnifiedDiff(item.path, item.oldText ?? "", item.newText),
			ACP_TOOL_PROGRESS_CHARS,
		);
		return [
			{
				path: item.path,
				kind: "update",
				diff: bounded.text,
				...(bounded.truncated ? { truncated: true } : {}),
			},
		];
	});
}

function acpApprovalInput(toolCall: ToolCallUpdate): unknown {
	const input = acpToolInput(toolCall);
	const base =
		input && typeof input === "object" && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: { raw_input: input };
	const changes = acpDiffChanges(toolCall.content);
	const content = acpPermissionDescription(toolCall);
	const terminalIds = (toolCall.content ?? []).flatMap((item) =>
		item.type === "terminal" ? [item.terminalId] : [],
	);
	return {
		...base,
		...(changes.length > 0 && base.changes === undefined ? { changes } : {}),
		...(content && base.content === undefined ? { content } : {}),
		...(terminalIds.length > 0 ? { terminal_ids: terminalIds } : {}),
	};
}

function permissionOptionForDecision(
	options: PermissionOption[],
	decision:
		| { behavior: "allow"; saveScope?: "session" | "local" }
		| {
				behavior: "deny";
		  },
): PermissionOption | undefined {
	// Never widen an unscoped Hlid decision into provider-persistent state.
	const kinds =
		decision.behavior === "deny"
			? (["reject_once"] as const)
			: decision.saveScope === "local"
				? (["allow_always", "allow_once"] as const)
				: (["allow_once"] as const);
	return kinds.flatMap((kind) =>
		options.filter((item) => item.kind === kind),
	)[0];
}

function mergeToolCallUpdate(
	previous: ToolCallUpdate | undefined,
	update: ToolCallUpdate,
): ToolCallUpdate {
	const merged = { ...previous, ...update };
	// ACP 1.3 defines an explicit null name as "leave the existing name unchanged".
	if (update.name === null) {
		if (previous?.name != null) merged.name = previous.name;
		else delete merged.name;
	}
	return merged;
}

function planEntriesText(
	entries: Array<{ content: string; status: string }>,
): string {
	return entries
		.map(
			(entry) =>
				`${entry.status === "completed" ? "- [x]" : "- [ ]"} ${entry.content}`,
		)
		.join("\n");
}

function planUpdateText(
	update: Extract<SessionUpdate, { sessionUpdate: "plan_update" }>,
): string {
	if (update.plan.type === "markdown") return update.plan.content;
	if (update.plan.type === "file") return `Plan document: ${update.plan.uri}`;
	return planEntriesText(update.plan.entries);
}

function eventsFromUpdate(
	update: SessionUpdate,
	planEventId?: string,
	toolCalls?: Map<string, ToolCallUpdate>,
	startedToolCalls?: Set<string>,
	terminalToolCalls?: Set<string>,
): AgentEvent[] {
	switch (update.sessionUpdate) {
		case "agent_message_chunk": {
			const text = textFromContent(update.content);
			return text == null ? [] : [{ type: "text_delta", text }];
		}
		case "agent_thought_chunk": {
			// AcpSession groups these into a prompt-scoped Reasoning lifecycle before
			// generic update mapping so they never masquerade as turn recaps.
			return [];
		}
		case "tool_call":
		case "tool_call_update": {
			const toolCall = mergeToolCallUpdate(
				toolCalls?.get(update.toolCallId),
				update,
			);
			toolCalls?.set(update.toolCallId, toolCall);
			if (terminalToolCalls?.has(update.toolCallId)) return [];
			const events: AgentEvent[] = [];
			if (!startedToolCalls?.has(update.toolCallId)) {
				startedToolCalls?.add(update.toolCallId);
				events.push({
					type: "tool_start",
					toolId: update.toolCallId,
					name: acpToolName(toolCall),
					input: acpToolInput(toolCall),
				});
			}
			if (toolCall.status === "completed" || toolCall.status === "failed") {
				terminalToolCalls?.add(update.toolCallId);
				events.push({
					type: "tool_result",
					toolId: update.toolCallId,
					content: toolResultText(toolCall),
					isError: toolCall.status === "failed",
				});
				return events;
			}
			if (update.sessionUpdate === "tool_call_update") {
				const progress = toolProgressSnapshot(toolCall);
				if (progress) {
					events.push({
						type: "tool_progress",
						toolId: update.toolCallId,
						progress,
					});
				}
			}
			return events;
		}
		case "plan": {
			const toolId = planEventId ?? "acp-plan";
			return [
				{
					type: "tool_start",
					toolId,
					name: "UpdatePlan",
					input: { plan: update.entries },
				},
				{
					type: "tool_result",
					toolId,
					content: planEntriesText(update.entries),
				},
			];
		}
		case "plan_update": {
			const toolId = planEventId ?? `acp-plan-${update.plan.planId}`;
			return [
				{ type: "tool_start", toolId, name: "UpdatePlan", input: update.plan },
				{ type: "tool_result", toolId, content: planUpdateText(update) },
			];
		}
		case "plan_removed": {
			const toolId = planEventId ?? `acp-plan-${update.planId}-removed`;
			return [
				{
					type: "tool_start",
					toolId,
					name: "UpdatePlan",
					input: { planId: update.planId, removed: true },
				},
				{ type: "tool_result", toolId, content: "Plan removed" },
			];
		}
		case "usage_update":
			return [
				{
					type: "usage",
					inputTokens: 0,
					outputTokens: 0,
					contextTokens: update.used,
					contextWindow: update.size,
				},
			];
		default:
			return [];
	}
}

function planModeId(modes: SessionModeState | null | undefined): string | null {
	if (!modes) return null;
	const exact = modes.availableModes.find((mode) =>
		[mode.id, mode.name].some((value) => value.toLowerCase() === "plan"),
	);
	if (exact) return exact.id;
	const architectural = modes.availableModes.find((mode) =>
		[mode.id, mode.name].some((value) => /architect|planning/i.test(value)),
	);
	return architectural?.id ?? null;
}

function filePathFromToolInput(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	for (const key of ["file_path", "filePath", "path"]) {
		if (typeof input[key] === "string") return input[key];
	}
	return null;
}

function filePathFromToolCall(toolCall: ToolCallUpdate): string | null {
	return (
		toolCall.locations?.find((location) => location.path.trim())?.path ??
		filePathFromToolInput(toolCall.rawInput) ??
		null
	);
}

function acpToolName(toolCall: ToolCallUpdate): string {
	if (toolCall.name?.trim()) return toolCall.name;
	switch (toolCall.kind) {
		case "read":
			return "Read";
		case "edit":
		case "delete":
		case "move":
			return "Write";
		case "search":
			return "Grep";
		case "execute":
			return "Bash";
		case "think":
			return "Reasoning";
		case "fetch":
			return "WebFetch";
		case "switch_mode":
			return "SwitchMode";
		default:
			return toolCall.title ?? "ACP tool";
	}
}

function acpToolInput(toolCall: ToolCallUpdate): unknown {
	const raw = toolCall.rawInput;
	const locations =
		toolCall.locations?.map((location) => ({ ...location })) ?? [];
	const filePath = filePathFromToolCall(toolCall);
	const kind = toolCall.kind ? { acp_kind: toolCall.kind } : {};
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return {
			...(raw as Record<string, unknown>),
			...kind,
			...(filePath ? { file_path: filePath } : {}),
			...(locations.length > 0 ? { locations } : {}),
		};
	}
	if (!filePath && locations.length === 0 && !toolCall.kind) return raw ?? null;
	return {
		...(raw != null ? { raw_input: raw } : {}),
		...kind,
		...(filePath ? { file_path: filePath } : {}),
		...(locations.length > 0 ? { locations } : {}),
	};
}

function headers(value: unknown): Array<{ name: string; value: string }> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return Object.entries(value).flatMap(([name, header]) =>
		typeof header === "string" ? [{ name, value: header }] : [],
	);
}

async function configuredMcpServers(cwd: string): Promise<{
	servers: McpServer[];
	statuses: McpServerStatus[];
}> {
	try {
		const entries = (await legacyProjectMcpAdapter.readAsync(cwd)).servers;
		const servers: McpServer[] = [];
		const statuses: McpServerStatus[] = [];
		for (const entry of entries) {
			if (entry.disabled) {
				statuses.push({
					name: entry.name,
					status: "disabled",
					scope: "project",
				});
				continue;
			}
			const config =
				entry.config &&
				typeof entry.config === "object" &&
				!Array.isArray(entry.config)
					? (entry.config as Record<string, unknown>)
					: {};
			if (typeof config.command === "string") {
				servers.push({
					name: entry.name,
					command: config.command,
					args: Array.isArray(config.args)
						? config.args.filter(
								(arg): arg is string => typeof arg === "string",
							)
						: [],
					env:
						config.env &&
						typeof config.env === "object" &&
						!Array.isArray(config.env)
							? Object.entries(config.env).flatMap(([name, value]) =>
									typeof value === "string" ? [{ name, value }] : [],
								)
							: [],
				});
				statuses.push({
					name: entry.name,
					status: "pending",
					scope: "project",
				});
				continue;
			}
			if (typeof config.url === "string") {
				servers.push({
					type: config.type === "sse" ? "sse" : "http",
					name: entry.name,
					url: config.url,
					headers: headers(config.headers),
				});
				statuses.push({
					name: entry.name,
					status: "pending",
					scope: "project",
				});
				continue;
			}
			statuses.push({
				name: entry.name,
				status: "failed",
				scope: "project",
				error: "Unsupported MCP configuration",
			});
		}
		return { servers, statuses };
	} catch (error) {
		return {
			servers: [],
			statuses: [
				{
					name: ".mcp.json",
					status: "failed",
					scope: "project",
					error: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
}

function mcpTransport(server: McpServer): "stdio" | "http" | "sse" | "acp" {
	return "type" in server ? server.type : "stdio";
}

function supportsMcpTransport(
	server: McpServer,
	capabilities: McpCapabilities | undefined,
): boolean {
	switch (mcpTransport(server)) {
		case "stdio":
			return true;
		case "http":
			return capabilities?.http === true;
		case "sse":
			return capabilities?.sse === true;
		case "acp":
			return capabilities?.acp === true;
	}
}

type InternalMcpNamespace =
	| typeof HLID_AGENT_NAMESPACE
	| typeof OBSIDIAN_AGENT_NAMESPACE;

const INTERNAL_MCP_TOOL_OWNERS = new Map<string, InternalMcpNamespace>();

function registerInternalMcpToolOwners(
	namespace: InternalMcpNamespace,
	tools: ReadonlyArray<{ name: string }>,
): void {
	for (const tool of tools) {
		for (const name of [
			`${namespace}_${tool.name}`,
			`${namespace}.${tool.name}`,
			`mcp__${namespace}__${tool.name}`,
		]) {
			INTERNAL_MCP_TOOL_OWNERS.set(name, namespace);
		}
	}
}

registerInternalMcpToolOwners(HLID_AGENT_NAMESPACE, HLID_AGENT_TOOL_SPECS);
registerInternalMcpToolOwners(
	OBSIDIAN_AGENT_NAMESPACE,
	OBSIDIAN_AGENT_TOOL_SPECS,
);

function selectOptions(option: SessionConfigOption): ProviderModelInfo[] {
	return acpSelectValues(option).values.map((item) => ({
		value: item.value,
		label: item.name,
		description: item.description ?? undefined,
		isDefault: option.type === "select" && item.value === option.currentValue,
	}));
}

function modeConfigOption(
	options: SessionConfigOption[],
): SessionConfigOption | undefined {
	return configOption(options, "mode", /(?:^|[^a-z])mode(?:[^a-z]|$)/i);
}

function planConfigValue(option: SessionConfigOption): string | null {
	if (option.type !== "select") return null;
	const values = selectOptions(option);
	const exact = values.find((entry) =>
		[entry.value, entry.label].some((value) => value.toLowerCase() === "plan"),
	);
	if (exact) return exact.value;
	return (
		values.find((entry) =>
			[entry.value, entry.label].some((value) =>
				/architect|planning/i.test(value),
			),
		)?.value ?? null
	);
}

function implementationConfigValue(
	option: SessionConfigOption,
	planValue: string,
): string | null {
	if (option.type !== "select") return null;
	return implementationValue(
		selectOptions(option)
			.filter((entry) => entry.value !== planValue)
			.map((entry) => ({ id: entry.value, name: entry.label })),
	);
}

function implementationValue(
	options: Array<{ id: string; name: string }>,
): string | null {
	if (options.length === 1) return options[0]?.id ?? null;
	const exact = options.find((option) =>
		[option.id, option.name].some((value) =>
			/^(?:code|coding|implement|implementation|build|execute|execution)$/i.test(
				value.trim(),
			),
		),
	);
	if (exact) return exact.id;
	return (
		options.find((option) =>
			[option.id, option.name].some((value) =>
				/(?:^|[^a-z])(?:code|implement|build|execute)(?:[^a-z]|$)/i.test(value),
			),
		)?.id ?? null
	);
}

function sessionConfigSnapshot(
	options: SessionConfigOption[],
	modes: SessionModeState | null,
	modelFilter?: AcpModelVisibilityFilter,
): ProviderSessionConfigSnapshot {
	const model = configOption(options, "model", /model/i);
	const thought = configOption(
		options,
		"thought_level",
		/thought|reason|effort/i,
	);
	const advertisedActiveModel =
		model?.type === "select" ? model.currentValue : undefined;
	const activeModel = acpModelVisible(advertisedActiveModel, modelFilter)
		? advertisedActiveModel
		: undefined;
	const effortLevels = thought ? effortLevelsForOptions(options) : undefined;
	const models = model
		? selectOptions(model)
				.filter((entry) => acpModelVisible(entry.value, modelFilter))
				.map((entry) => ({
					...entry,
					...(entry.value === activeModel && effortLevels?.length
						? { efforts: effortLevels }
						: {}),
				}))
		: undefined;
	const stableMode = modeConfigOption(options);
	const availableModes = stableMode
		? selectOptions(stableMode).map((mode) => ({
				value: mode.value,
				label: mode.label,
				...(mode.description ? { desc: mode.description } : {}),
				...(mode.isDefault !== undefined ? { isDefault: mode.isDefault } : {}),
			}))
		: modes
			? modes.availableModes.map((mode) => ({
					value: mode.id,
					label: mode.name,
					...(mode.description ? { desc: mode.description } : {}),
					isDefault: mode.id === modes.currentModeId,
				}))
			: undefined;
	const planValue = stableMode
		? planConfigValue(stableMode)
		: planModeId(modes);
	return {
		...(models ? { models } : {}),
		...(activeModel !== undefined ? { activeModel } : {}),
		...(effortLevels ? { effortLevels } : {}),
		...(thought?.type === "select"
			? { activeEffort: thought.currentValue }
			: {}),
		...(availableModes ? { modes: availableModes } : {}),
		...(stableMode?.type === "select"
			? { activeMode: stableMode.currentValue }
			: modes
				? { activeMode: modes.currentModeId }
				: {}),
		...(planValue ? { planModeValue: planValue } : {}),
	};
}

type ElicitationField = {
	key: string;
	question: string;
	type: "string" | "number" | "integer" | "boolean" | "array";
	values: Map<string, string>;
	freeText: boolean;
	placeholder?: string;
};

function elicitationFields(
	request: CreateElicitationRequest,
): ElicitationField[] {
	if (!CreateElicitationRequest.isForm(request)) return [];
	const properties = request.requestedSchema.properties ?? {};
	return Object.entries(properties).flatMap(([key, property]) => {
		const values = new Map<string, string>();
		let type: ElicitationField["type"];
		if (ElicitationPropertySchema.isString(property)) {
			type = "string";
			for (const value of property.enum ?? []) values.set(value, value);
			for (const item of property.oneOf ?? [])
				values.set(item.title, item.const);
		} else if (ElicitationPropertySchema.isArray(property)) {
			type = "array";
			if (MultiSelectItems.isString(property.items)) {
				for (const value of property.items.enum) values.set(value, value);
			} else if (MultiSelectItems.isTitled(property.items)) {
				for (const item of property.items.anyOf)
					values.set(item.title, item.const);
			}
		} else if (ElicitationPropertySchema.isBoolean(property)) {
			type = "boolean";
			values.set("Yes", "true");
			values.set("No", "false");
		} else if (ElicitationPropertySchema.isNumber(property)) {
			type = "number";
		} else if (ElicitationPropertySchema.isInteger(property)) {
			type = "integer";
		} else {
			return [];
		}
		return [
			{
				key,
				question: property.title?.trim() || key,
				type,
				values,
				freeText: values.size === 0,
				placeholder: property.description ?? undefined,
			},
		];
	});
}

function elicitationContent(
	fields: ElicitationField[],
	answers: Record<string, unknown>,
): Record<string, string | number | boolean | string[]> {
	const content: Record<string, string | number | boolean | string[]> = {};
	for (const field of fields) {
		const answer = answers[field.question];
		const raw = typeof answer === "string" ? answer : "";
		const [selectionText, note = ""] = raw.split("\n\nNotes:", 2);
		const selections = selectionText ? selectionText.split(", ") : [];
		const mapped = selections.map(
			(selection) => field.values.get(selection) ?? selection,
		);
		const freeValue = note.trim() || mapped.find((value) => value) || "";
		if (field.type === "array") content[field.key] = mapped.filter(Boolean);
		else if (field.type === "boolean")
			content[field.key] = freeValue === "true";
		else if (field.type === "number" || field.type === "integer") {
			const number = Number(freeValue);
			if (Number.isFinite(number)) content[field.key] = number;
		} else content[field.key] = freeValue;
	}
	return content;
}

type ActiveAcpPrompt = {
	promise: Promise<void>;
	startedAt: number;
	settled: boolean;
	controlsLocked: boolean;
	suppressError: boolean;
};

type AcpRuntimeIdentity = {
	generation: number;
	connection: ClientSideConnection;
	sessionId: string;
};

class AcpRuntimeSupersededError extends Error {
	constructor() {
		super("ACP runtime changed while applying session configuration");
		this.name = "AcpRuntimeSupersededError";
	}
}

type AcpMetadataInspection = {
	initialized: InitializeResponse;
	configOptions: SessionConfigOption[];
	modes: SessionModeState | null;
};

type ManagedAcpInspection<T> = {
	controller: AbortController;
	promise: Promise<T>;
};

class AcpSession implements AgentSession {
	private readonly events = new AsyncEventQueue<AgentEvent>();
	private readonly timeouts: AcpLifecycleTimeouts;
	private readonly mcpConfigPromise: Promise<{
		servers: McpServer[];
		statuses: McpServerStatus[];
	}>;
	private runtimeAbortController = new AbortController();
	private readonly expectedProcessExits =
		new WeakSet<ChildProcessWithoutNullStreams>();
	private process: ChildProcessWithoutNullStreams | null = null;
	private stderr: () => string = () => "";
	private connection: ClientSideConnection | null = null;
	private sessionId: string | null = null;
	private runtimeGeneration = 0;
	private runtimeRetirement: Promise<void> | null = null;
	private modelVisibilityFault: Error | null = null;
	private initPromise: Promise<void> | null = null;
	private cleanupPromise: Promise<void> | null = null;
	private cleanupProcess: AcpStartedProcess | null = null;
	private ownedProcess: AcpStartedProcess | null = null;
	private ownedProcessEnvironmentRelease: (() => Promise<void>) | null = null;
	private activePrompt: ActiveAcpPrompt | null = null;
	private cancelled = false;
	private turns = 0;
	private commands: SlashCommand[] = [];
	private closeAfterTurn = false;
	private canDeleteSession = false;
	private canCloseSession = false;
	private canLoadSession = false;
	private canResumeSession = false;
	private acceptsImagePrompts = false;
	private acceptsEmbeddedContext = false;
	private allowInterruptedResumeFallback = false;
	private loadingSessionReplay = false;
	private modes: SessionModeState | null = null;
	private configOptions: SessionConfigOption[] = [];
	private liveControlTail: Promise<void> = Promise.resolve();
	private liveControlsPending = 0;
	private modelControlActive = false;
	private modelControlExpectedValue: string | undefined;
	private initialConfigValues = new Map<string, string>();
	private configNotificationsReady = false;
	private lastConfigSnapshot = "";
	private implementationModeId: string | null = null;
	private implementationConfigModeValue: string | null = null;
	private readonly toolCalls = new Map<string, ToolCallUpdate>();
	private readonly startedToolCalls = new Set<string>();
	private readonly terminalToolCalls = new Set<string>();
	private readonly toolProgressFingerprints = new Map<string, string>();
	private readonly pendingToolProgress = new Map<
		string,
		Extract<AgentEvent, { type: "tool_progress" }>
	>();
	private readonly toolProgressTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private readonly toolProgressEmittedAt = new Map<string, number>();
	private approvedHtmlPlanToolIds = new Set<string>();
	private htmlPlanReady = false;
	private nativePlanText = "";
	private lastAgentMessageId: string | null = null;
	private thoughtPromptSeq = 0;
	private thoughtToolSeq = 0;
	private anonymousThoughtKey: string | null = null;
	private readonly thoughtGroups = new Map<
		string,
		{ toolId: string; text: string }
	>();
	private planEventSeq = 0;
	private elicitationSeq = 0;
	private latestCostUsd: number | null = null;
	private turnStartCostUsd: number | null = null;
	private costBaselineKnown = true;
	private mcpServers: McpServer[] = [];
	private mcpStatuses: McpServerStatus[] = [];

	constructor(
		private readonly options: AcpProviderOptions,
		private readonly params: AgentQueryParams,
		private readonly beforePromptDispatch?: (
			signal: AbortSignal,
		) => Promise<() => void>,
	) {
		this.timeouts = acpTimeouts(options);
		this.mcpConfigPromise = configuredMcpServers(params.cwd).then((mcp) => {
			this.mcpServers = mcp.servers;
			this.mcpStatuses = mcp.statuses;
			return mcp;
		});
		if (params.signal?.aborted) this.cancel();
		else {
			params.signal?.addEventListener("abort", () => this.cancel(), {
				once: true,
			});
		}
	}

	private runtimeSignal(): AbortSignal {
		return this.params.signal
			? AbortSignal.any([
					this.params.signal,
					this.runtimeAbortController.signal,
				])
			: this.runtimeAbortController.signal;
	}

	private flushToolProgress(toolId: string): void {
		const timer = this.toolProgressTimers.get(toolId);
		if (timer) clearTimeout(timer);
		this.toolProgressTimers.delete(toolId);
		const event = this.pendingToolProgress.get(toolId);
		this.pendingToolProgress.delete(toolId);
		if (!event) return;
		this.toolProgressEmittedAt.set(toolId, Date.now());
		this.events.push(event);
	}

	private queueToolProgress(
		event: Extract<AgentEvent, { type: "tool_progress" }>,
	): void {
		if (this.terminalToolCalls.has(event.toolId)) return;
		const fingerprint = JSON.stringify(event.progress);
		if (this.toolProgressFingerprints.get(event.toolId) === fingerprint) return;
		this.toolProgressFingerprints.set(event.toolId, fingerprint);
		const now = Date.now();
		const emittedAt = this.toolProgressEmittedAt.get(event.toolId);
		const elapsed = emittedAt === undefined ? Infinity : now - emittedAt;
		if (elapsed >= ACP_TOOL_PROGRESS_THROTTLE_MS) {
			this.pendingToolProgress.delete(event.toolId);
			const timer = this.toolProgressTimers.get(event.toolId);
			if (timer) clearTimeout(timer);
			this.toolProgressTimers.delete(event.toolId);
			this.toolProgressEmittedAt.set(event.toolId, now);
			this.events.push(event);
			return;
		}
		this.pendingToolProgress.set(event.toolId, event);
		if (this.toolProgressTimers.has(event.toolId)) return;
		this.toolProgressTimers.set(
			event.toolId,
			setTimeout(
				() => this.flushToolProgress(event.toolId),
				ACP_TOOL_PROGRESS_THROTTLE_MS - elapsed,
			),
		);
	}

	private pushMappedEvent(event: AgentEvent): void {
		if (event.type === "tool_progress") {
			this.queueToolProgress(event);
			return;
		}
		if (event.type === "tool_result") {
			this.flushToolProgress(event.toolId);
			this.toolProgressFingerprints.delete(event.toolId);
			this.toolProgressEmittedAt.delete(event.toolId);
		}
		this.events.push(event);
	}

	private clearToolProgress(): void {
		for (const timer of this.toolProgressTimers.values()) clearTimeout(timer);
		this.toolProgressTimers.clear();
		this.pendingToolProgress.clear();
		this.toolProgressFingerprints.clear();
		this.toolProgressEmittedAt.clear();
	}

	private resetObservableMcpStatuses(publish = false): void {
		let changed = false;
		this.mcpStatuses = this.mcpStatuses.map((status) => {
			if (status.status !== "connected" && status.status !== "unknown") {
				return status;
			}
			changed = true;
			return { ...status, status: "pending" };
		});
		if (changed && publish) {
			this.events.push({ type: "mcp_status", servers: this.mcpStatuses });
		}
	}

	private markMcpSetupComplete(): void {
		this.mcpStatuses = this.mcpStatuses.map((status) =>
			status.status === "pending" ? { ...status, status: "unknown" } : status,
		);
	}

	private observeInternalMcpToolName(toolName: string): void {
		const namespace = INTERNAL_MCP_TOOL_OWNERS.get(toolName);
		if (!namespace) return;
		let changed = false;
		this.mcpStatuses = this.mcpStatuses.map((status) => {
			if (
				status.name !== namespace ||
				status.scope !== "provider" ||
				(status.status !== "pending" && status.status !== "unknown")
			) {
				return status;
			}
			changed = true;
			return { ...status, status: "connected" };
		});
		if (changed) {
			this.events.push({ type: "mcp_status", servers: this.mcpStatuses });
		}
	}

	private beginThoughtPrompt(): void {
		this.thoughtGroups.clear();
		this.thoughtPromptSeq += 1;
		this.anonymousThoughtKey = `prompt:${this.thoughtPromptSeq}:anonymous`;
	}

	private handleThoughtChunk(
		update: Extract<SessionUpdate, { sessionUpdate: "agent_thought_chunk" }>,
	): void {
		const text = textFromContent(update.content);
		if (!text || !this.anonymousThoughtKey) return;
		const groupKey = update.messageId
			? `prompt:${this.thoughtPromptSeq}:message:${update.messageId}`
			: this.anonymousThoughtKey;
		const existing = this.thoughtGroups.get(groupKey);
		if (existing) {
			existing.text += text;
			return;
		}
		const toolId = `acp-reasoning-${this.thoughtPromptSeq}-${++this.thoughtToolSeq}`;
		this.thoughtGroups.set(groupKey, { toolId, text });
		this.events.push({
			type: "tool_start",
			toolId,
			name: "Reasoning",
			input: {},
		});
	}

	private flushThoughts(isError = false): void {
		for (const thought of this.thoughtGroups.values()) {
			this.pushMappedEvent({
				type: "tool_result",
				toolId: thought.toolId,
				content: thought.text,
				...(isError ? { isError: true } : {}),
			});
		}
		this.thoughtGroups.clear();
		this.anonymousThoughtKey = null;
	}

	private clearThoughts(): void {
		this.thoughtGroups.clear();
		this.anonymousThoughtKey = null;
	}

	private negotiatedMcpServers(
		capabilities: McpCapabilities | undefined,
	): McpServer[] {
		const unsupported = new Map<string, ReturnType<typeof mcpTransport>>();
		const supported = this.mcpServers.filter((server) => {
			if (supportsMcpTransport(server, capabilities)) return true;
			unsupported.set(server.name, mcpTransport(server));
			return false;
		});
		if (unsupported.size > 0) {
			this.mcpStatuses = this.mcpStatuses.map((status) => {
				const transport = unsupported.get(status.name);
				if (!transport || status.status !== "pending") return status;
				return {
					...status,
					status: "failed",
					error: `ACP agent does not advertise ${transport.toUpperCase()} MCP transport support`,
				};
			});
		}
		return supported;
	}

	private async handleElicitation(
		request: CreateElicitationRequest,
	): Promise<CreateElicitationResponse> {
		if (!CreateElicitationRequest.isForm(request)) return { action: "decline" };
		const fields = elicitationFields(request);
		if (fields.length === 0) return { action: "decline" };
		const questions = providerElicitationQuestions(fields);
		const toolUseID =
			("toolCallId" in request && request.toolCallId) ||
			`acp-elicitation-${this.sessionId ?? "request"}-${++this.elicitationSeq}`;
		const signal = this.runtimeSignal();
		const decision = await this.params.canUseTool(
			"AskUserQuestion",
			{ questions },
			{
				toolUseID,
				signal,
				title: request.message,
				displayName: "elicitation/create",
			},
		);
		if (signal.aborted) throw signal.reason;
		if (decision.behavior !== "allow") return { action: "decline" };
		const updated =
			decision.updatedInput && typeof decision.updatedInput === "object"
				? (decision.updatedInput as Record<string, unknown>)
				: {};
		const answers =
			updated.answers && typeof updated.answers === "object"
				? (updated.answers as Record<string, unknown>)
				: {};
		return { action: "accept", content: elicitationContent(fields, answers) };
	}

	private runPhase<T>(
		phase: string,
		timeoutMs: number,
		run: () => T | Promise<T>,
	): Promise<T> {
		return runAcpPhase({
			phase,
			timeoutMs,
			signal: this.runtimeAbortController.signal,
			run,
		}).catch((error) => {
			throw appendAcpStderr(error, this.stderr());
		});
	}

	private async applyConfigOption(
		option: SessionConfigOption,
		value: string,
		phase: string,
		timeoutMs = this.timeouts.configMs,
		expectedActiveModel?: string,
	): Promise<void> {
		if (option.type !== "select" || !this.connection || !this.sessionId) return;
		const currentModel = configOption(this.configOptions, "model", /model/i);
		const preservedActiveModel =
			expectedActiveModel ??
			(currentModel?.type === "select" && currentModel.id !== option.id
				? currentModel.currentValue
				: undefined);
		const identity: AcpRuntimeIdentity = {
			generation: this.runtimeGeneration,
			connection: this.connection,
			sessionId: this.sessionId,
		};
		const response = await this.runPhase(phase, timeoutMs, () =>
			identity.connection.setSessionConfigOption({
				sessionId: identity.sessionId,
				configId: option.id,
				value,
			}),
		);
		if (!this.runtimeIdentityIsCurrent(identity)) {
			throw new AcpRuntimeSupersededError();
		}
		if (!response) {
			const error = new Error(
				"ACP agent returned no session configuration snapshot",
			);
			void this.beginRuntimeRetirement(
				error,
				identity.generation,
				Boolean(this.options.modelFilter),
			).catch(() => {});
			throw error;
		}
		try {
			this.adoptConfigOptions(response.configOptions, preservedActiveModel);
		} catch (error) {
			void this.beginRuntimeRetirement(
				error,
				identity.generation,
				Boolean(this.options.modelFilter),
			).catch(() => {});
			throw error;
		}
	}

	private runtimeIdentityIsCurrent(identity: AcpRuntimeIdentity): boolean {
		return (
			identity.generation === this.runtimeGeneration &&
			identity.connection === this.connection &&
			identity.sessionId === this.sessionId
		);
	}

	private activeModelVisible(option: SessionConfigOption): boolean {
		return (
			option.type === "select" &&
			selectOptions(option).some(
				(entry) =>
					entry.value === option.currentValue &&
					acpModelVisible(entry.value, this.options.modelFilter),
			)
		);
	}

	private assertActiveModelVisible(
		options = this.configOptions,
		expectedActiveModel?: string,
	): void {
		if (!this.options.modelFilter && expectedActiveModel === undefined) return;
		const model = configOption(options, "model", /model/i);
		if (!model || model.type !== "select") {
			throw new Error(
				expectedActiveModel === undefined
					? "ACP agent does not advertise a selectable model required by Hlid's ACP model visibility"
					: "ACP agent did not return a selectable model after Hlid requested a model change",
			);
		}
		if (this.options.modelFilter && !this.activeModelVisible(model)) {
			throw new Error(
				`ACP agent activated model ${JSON.stringify(model.currentValue)} excluded by Hlid's ACP model visibility`,
			);
		}
		if (
			expectedActiveModel !== undefined &&
			model.currentValue !== expectedActiveModel
		) {
			throw new Error(
				`ACP agent activated model ${JSON.stringify(model.currentValue)} after Hlid requested ${JSON.stringify(expectedActiveModel)}`,
			);
		}
	}

	private requestedModelValue(): string | undefined {
		const requested = this.params.model;
		return requested && this.options.requestModel
			? this.options.requestModel(requested)
			: requested;
	}

	private adoptConfigOptions(
		options: SessionConfigOption[],
		expectedActiveModel?: string,
	): void {
		this.assertActiveModelVisible(options, expectedActiveModel);
		this.configOptions = options;
		this.publishSessionConfig();
	}

	private adoptConfigNotification(
		options: SessionConfigOption[],
		observedGeneration: number,
	): boolean {
		if (
			observedGeneration !== this.runtimeGeneration ||
			this.modelVisibilityFault
		) {
			return false;
		}
		try {
			this.adoptConfigOptions(
				options,
				this.modelControlActive
					? this.modelControlExpectedValue
					: this.requestedModelValue(),
			);
			return true;
		} catch (error) {
			void this.beginRuntimeRetirement(error, observedGeneration, true).catch(
				(retirementError) => {
					if (!this.cancelled) {
						console.error(
							"[acp] model visibility fault retirement failed:",
							retirementError,
						);
					}
				},
			);
			return false;
		}
	}

	private async enforceProviderDefaultModelVisibility(): Promise<void> {
		const modelFilter = this.options.modelFilter;
		if (!modelFilter) return;
		const model = configOption(this.configOptions, "model", /model/i);
		if (!model || model.type !== "select") {
			throw new Error(
				"ACP agent does not advertise a selectable model required by Hlid's ACP model visibility",
			);
		}
		if (this.activeModelVisible(model)) return;

		const visibleModels = selectOptions(model).filter((entry) =>
			acpModelVisible(entry.value, modelFilter),
		);
		const fallback =
			visibleModels.find((entry) => entry.value === this.params.model) ??
			visibleModels[0];
		if (!fallback) {
			throw new Error(
				"ACP agent does not advertise any model allowed by Hlid's ACP model visibility",
			);
		}
		await this.applyConfigOption(
			model,
			fallback.value,
			"model visibility enforcement",
			this.timeouts.configMs,
			fallback.value,
		);
		this.assertActiveModelVisible();
	}

	private publishSessionConfig(): void {
		if (
			!this.configNotificationsReady ||
			this.modelVisibilityFault ||
			this.runtimeRetirement ||
			!this.params.onSessionConfigChange
		)
			return;
		const snapshot = sessionConfigSnapshot(
			this.configOptions,
			this.modes,
			this.options.modelFilter,
		);
		const serialized = JSON.stringify(snapshot);
		if (serialized === this.lastConfigSnapshot) return;
		this.lastConfigSnapshot = serialized;
		try {
			this.params.onSessionConfigChange(snapshot);
		} catch (error) {
			console.error("[acp] live session configuration callback failed:", error);
		}
	}

	private adoptCreatedSession(created: {
		sessionId: string;
		modes?: SessionModeState | null;
		configOptions?: SessionConfigOption[] | null;
	}): {
		modes: SessionModeState | null | undefined;
		configOptions: SessionConfigOption[] | null | undefined;
	} {
		this.sessionId = created.sessionId;
		this.latestCostUsd = null;
		this.turnStartCostUsd = null;
		this.costBaselineKnown = true;
		return { modes: created.modes, configOptions: created.configOptions };
	}

	private resetAfterRuntimeStop(
		previousSessionId: string | null,
		canReconnect: boolean,
		publishMcpStatus = false,
	): void {
		this.resetObservableMcpStatuses(publishMcpStatus);
		if (canReconnect && previousSessionId) {
			this.params.sessionId = previousSessionId;
			this.allowInterruptedResumeFallback = true;
		} else {
			this.params.sessionId = undefined;
			this.allowInterruptedResumeFallback = false;
		}
		this.clearRuntimeState();
		this.runtimeAbortController = new AbortController();
		this.stderr = () => "";
	}

	private async retireRuntimeAfterControlFailure(
		error: unknown,
	): Promise<void> {
		const previousSessionId = this.sessionId;
		const canReconnect = this.canResumeSession || this.canLoadSession;
		const active =
			this.activePrompt && !this.activePrompt.settled
				? this.activePrompt
				: null;
		if (active) active.suppressError = true;
		this.runtimeAbortController.abort(error);
		await this.stopOwnedProcess(true);
		if (active) {
			await waitForPromptSettlement(active, this.timeouts.terminateGraceMs);
			if (this.activePrompt === active) this.activePrompt = null;
		}
		this.resetAfterRuntimeStop(
			previousSessionId,
			canReconnect,
			Boolean(active),
		);
		if (active) {
			this.events.push({
				type: "done",
				turns: 0,
				durationMs: Date.now() - active.startedAt,
				stopReason: "cancelled",
			});
		}
	}

	private beginRuntimeRetirement(
		error: unknown,
		observedGeneration: number,
		modelVisibilityFault = false,
	): Promise<void> {
		if (this.runtimeRetirement) return this.runtimeRetirement;
		if (observedGeneration !== this.runtimeGeneration) {
			return Promise.resolve();
		}
		if (modelVisibilityFault && !this.modelVisibilityFault) {
			this.modelVisibilityFault =
				error instanceof Error ? error : new Error(errorText(error));
		}

		// Invalidate callbacks and config responses synchronously. Process cleanup is
		// asynchronous, but no late message may repopulate this runtime meanwhile.
		this.flushThoughts(true);
		this.runtimeGeneration += 1;
		const pending = this.retireRuntimeAfterControlFailure(error).finally(() => {
			if (this.runtimeRetirement === pending) this.runtimeRetirement = null;
		});
		this.runtimeRetirement = pending;
		return pending;
	}

	private assertPromptAdmission(): void {
		if (this.modelVisibilityFault) throw this.modelVisibilityFault;
		if (this.runtimeRetirement) {
			throw new Error(
				"ACP runtime is retiring after a session control failure",
			);
		}
		if (this.liveControlsPending > 0) {
			throw new Error("ACP session configuration is still in progress");
		}
	}

	private assertControlAdmission(): void {
		if (this.modelVisibilityFault) throw this.modelVisibilityFault;
		if (this.runtimeRetirement) {
			throw new Error(
				"ACP runtime is retiring after a session control failure",
			);
		}
		if (
			this.activePrompt &&
			!this.activePrompt.settled &&
			this.activePrompt.controlsLocked
		) {
			throw new Error(
				"ACP session controls are unavailable during an active prompt",
			);
		}
	}

	private runLiveControl(run: () => Promise<void>): Promise<void> {
		this.assertControlAdmission();
		const generation = this.runtimeGeneration;
		this.liveControlsPending += 1;
		const execute = this.liveControlTail.then(async () => {
			this.assertControlAdmission();
			if (generation !== this.runtimeGeneration) {
				throw new AcpRuntimeSupersededError();
			}
			try {
				await run();
			} catch (error) {
				if (error instanceof AcpRuntimeSupersededError) throw error;
				await this.beginRuntimeRetirement(error, generation);
				throw error;
			}
		});
		this.liveControlTail = execute.catch(() => {});
		return execute.finally(() => {
			this.liveControlsPending -= 1;
		});
	}

	private async setConfigValue(
		category: "model" | "thought_level",
		value: string | undefined,
		resetToInitial = false,
		ignoreUnsupportedValue = false,
	): Promise<void> {
		if (!this.connection || !this.sessionId) return;
		if (value === undefined && !resetToInitial) return;
		const option = configOption(
			this.configOptions,
			category,
			category === "model" ? /model/i : /thought|reason|effort/i,
		);
		if (!option || option.type !== "select") {
			if (category === "model") {
				throw new Error(
					"ACP agent does not advertise selectable model control",
				);
			}
			if (value !== undefined && !ignoreUnsupportedValue) {
				throw new Error(
					"ACP agent does not advertise selectable thought-level control",
				);
			}
			return;
		}
		const resolvedValue = value ?? this.initialConfigValues.get(option.id);
		if (resolvedValue === undefined) {
			if (category === "model") {
				throw new Error("ACP session has no initial model to restore");
			}
			return;
		}
		if (
			category === "thought_level" &&
			!selectOptions(option).some(
				(candidate) => candidate.value === resolvedValue,
			)
		) {
			if (ignoreUnsupportedValue) return;
			throw new Error(
				`ACP agent does not advertise thought level ${JSON.stringify(resolvedValue)} for the active model`,
			);
		}
		const activeModelOption = configOption(
			this.configOptions,
			"model",
			/model/i,
		);
		const expectedActiveModel =
			category === "model"
				? resolvedValue
				: activeModelOption?.type === "select"
					? activeModelOption.currentValue
					: undefined;
		await this.applyConfigOption(
			option,
			resolvedValue,
			`${category === "model" ? "model" : "thought-level"} configuration`,
			this.timeouts.configMs,
			expectedActiveModel,
		);
	}

	private async syncPermissionMode(mode: string): Promise<void> {
		if (!this.connection || !this.sessionId) return;
		const stableMode = modeConfigOption(this.configOptions);
		const stablePlanValue = stableMode ? planConfigValue(stableMode) : null;
		if (stableMode?.type === "select" && stablePlanValue) {
			if (mode === "plan") {
				if (stableMode.currentValue !== stablePlanValue) {
					this.implementationConfigModeValue = stableMode.currentValue;
					await this.applyConfigOption(
						stableMode,
						stablePlanValue,
						"session mode configuration",
						this.timeouts.modeMs,
					);
				}
				return;
			}
			if (
				stableMode.currentValue === stablePlanValue &&
				this.implementationConfigModeValue
			) {
				await this.applyConfigOption(
					stableMode,
					this.implementationConfigModeValue,
					"session mode configuration",
					this.timeouts.modeMs,
				);
			}
			return;
		}
		if (!this.modes) return;
		const planningModeId = planModeId(this.modes);
		if (mode === "plan") {
			if (!planningModeId) return;
			if (this.modes.currentModeId !== planningModeId) {
				this.implementationModeId = this.modes.currentModeId;
				await this.runPhase(
					"legacy session mode configuration",
					this.timeouts.modeMs,
					() =>
						this.connection?.setSessionMode({
							sessionId: this.sessionId ?? "",
							modeId: planningModeId,
						}),
				);
				this.modes = { ...this.modes, currentModeId: planningModeId };
				this.publishSessionConfig();
			}
			return;
		}
		if (
			planningModeId &&
			this.modes.currentModeId === planningModeId &&
			this.implementationModeId
		) {
			await this.runPhase(
				"legacy session mode configuration",
				this.timeouts.modeMs,
				() =>
					this.connection?.setSessionMode({
						sessionId: this.sessionId ?? "",
						modeId: this.implementationModeId ?? "",
					}),
			);
			this.modes = { ...this.modes, currentModeId: this.implementationModeId };
			this.publishSessionConfig();
		}
	}

	private initialize(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		const pending = this.doInitialize();
		this.initPromise = pending;
		void pending.catch(() => {
			if (this.initPromise === pending) this.initPromise = null;
		});
		return pending;
	}

	private async stopOwnedProcess(immediate = false): Promise<void> {
		if (this.cleanupPromise) {
			if (immediate && this.cleanupProcess) {
				this.cleanupProcess.initiateTermination();
			}
			return this.cleanupPromise;
		}
		const owned = this.ownedProcess;
		const child = owned?.child;
		const releaseEnvironment = this.ownedProcessEnvironmentRelease;
		this.ownedProcessEnvironmentRelease = null;
		if (!owned || !child) {
			await releaseEnvironment?.();
			return;
		}
		this.expectedProcessExits.add(child);
		this.process = null;
		this.ownedProcess = null;
		this.connection = null;
		this.cleanupProcess = owned;
		const pending = Promise.allSettled([
			releaseEnvironment?.(),
			owned.terminate(this.timeouts.terminateGraceMs, immediate),
		])
			.then(() => undefined)
			.finally(() => {
				if (this.cleanupPromise === pending) {
					this.cleanupPromise = null;
					this.cleanupProcess = null;
				}
			});
		this.cleanupPromise = pending;
		return pending;
	}

	private clearRuntimeState(): void {
		this.resetObservableMcpStatuses();
		this.runtimeGeneration += 1;
		this.connection = null;
		this.process = null;
		this.ownedProcess = null;
		this.ownedProcessEnvironmentRelease = null;
		this.sessionId = null;
		this.initPromise = null;
		this.canDeleteSession = false;
		this.canCloseSession = false;
		this.canLoadSession = false;
		this.canResumeSession = false;
		this.acceptsImagePrompts = false;
		this.acceptsEmbeddedContext = false;
		this.loadingSessionReplay = false;
		this.modes = null;
		this.configOptions = [];
		this.modelVisibilityFault = null;
		this.initialConfigValues.clear();
		this.configNotificationsReady = false;
		this.lastConfigSnapshot = "";
		this.implementationModeId = null;
		this.implementationConfigModeValue = null;
		this.toolCalls.clear();
		this.startedToolCalls.clear();
		this.terminalToolCalls.clear();
		this.clearToolProgress();
		this.clearThoughts();
		this.lastAgentMessageId = null;
	}

	private async doInitialize(): Promise<void> {
		if (this.cancelled) {
			throw new AcpPhaseError("startup", "cancelled");
		}
		this.stderr = () => "";
		try {
			await this.initializeRuntime();
		} catch (error) {
			const stderr = this.stderr();
			await this.stopOwnedProcess(true);
			this.clearRuntimeState();
			this.stderr = () => "";
			throw appendAcpStderr(error, stderr);
		}
	}

	private async initializeRuntime(): Promise<void> {
		const runtimeGeneration = ++this.runtimeGeneration;
		const adapter = acpAdapter(this.options);
		const providerCwd = adapter.providerPath(this.params.cwd, this.params.cwd);
		const [providerEnv, obsidianStatus] = await observeAcpStartup(
			`preparation:${this.options.id}:${adapter.key}`,
			`${this.options.label} ${adapter.key} startup preparation`,
			() =>
				this.runPhase(
					"startup preparation",
					this.timeouts.preparationMs,
					async () => {
						const [env, obsidian] = await Promise.all([
							resolveAcpEnv(this.options.env),
							getObsidianCliStatus(),
							this.mcpConfigPromise,
						]);
						return [env, obsidian] as const;
					},
				),
		);
		if (
			!this.mcpServers.some((server) => server.name === HLID_AGENT_NAMESPACE)
		) {
			this.mcpServers.unshift(
				adapter.adaptMcpServer(
					{
						name: HLID_AGENT_NAMESPACE,
						...hlidMcpProcessCommand({
							providerId: this.params.providerId ?? this.options.id,
							model: this.params.model,
							effort: this.params.effort,
							permissionMode: this.params.permissionMode,
							policyEnforced: this.params.policyEnforced,
							codexRealtimeEnabled: this.params.codexRealtimeEnabled,
							runtimeCwd: this.params.cwd,
							sessionId: this.params.hostSessionId,
							vaultName: this.params.vaultName,
							agentMode: this.params.agentMode,
						}),
					},
					this.params.cwd,
				),
			);
			this.mcpStatuses.unshift({
				name: HLID_AGENT_NAMESPACE,
				status: "pending",
				scope: "provider",
			});
		}
		if (
			obsidianStatus.installed &&
			!this.mcpServers.some(
				(server) => server.name === OBSIDIAN_AGENT_NAMESPACE,
			)
		) {
			this.mcpServers.unshift(
				adapter.adaptMcpServer(
					{
						name: OBSIDIAN_AGENT_NAMESPACE,
						...obsidianMcpProcessCommand(),
					},
					this.params.cwd,
				),
			);
			this.mcpStatuses.unshift({
				name: OBSIDIAN_AGENT_NAMESPACE,
				status: "pending",
				scope: "provider",
			});
		}
		this.resetObservableMcpStatuses();
		const processEnvironment = await acquireAcpProcessEnvironment({
			provider: this.options,
			environment: providerEnv,
			phase: "process environment preparation",
			timeoutMs: this.timeouts.preparationMs,
			signal: this.runtimeSignal(),
		});
		let started: AcpStartedProcess;
		try {
			started = await observeAcpStartup(
				`spawn:${this.options.id}:${adapter.key}`,
				`${this.options.label} ${adapter.key} executable resolution and process spawn`,
				() =>
					startAcpProcess({
						provider: this.options,
						cwd: this.params.cwd,
						env: processEnvironment.environment,
						signal: this.runtimeAbortController.signal,
					}),
			);
		} catch (error) {
			await processEnvironment.release();
			throw error;
		}
		const { child } = started;
		this.ownedProcess = started;
		this.ownedProcessEnvironmentRelease = processEnvironment.release;
		this.process = child;
		this.stderr = started.stderr;
		const releaseProcessEnvironment = () => {
			void processEnvironment.release().catch(() => {});
		};
		child.once("error", releaseProcessEnvironment);
		child.once("exit", releaseProcessEnvironment);
		child.once("error", (error) => {
			if (
				this.process === child &&
				!this.cancelled &&
				!this.expectedProcessExits.has(child)
			) {
				this.flushThoughts(true);
				this.resetObservableMcpStatuses(true);
				this.events.end(appendAcpStderr(error, this.stderr()));
			}
		});
		child.once("exit", (code) => {
			if (
				this.process === child &&
				!this.cancelled &&
				!this.expectedProcessExits.has(child) &&
				code !== 0
			) {
				this.flushThoughts(true);
				this.resetObservableMcpStatuses(true);
				this.events.end(
					appendAcpStderr(
						new Error(`ACP agent exited with code ${code}`),
						this.stderr(),
					),
				);
			}
		});
		if (child.exitCode !== null || child.signalCode !== null) {
			releaseProcessEnvironment();
		}

		const client: Client = {
			requestPermission: async ({ toolCall, options }) => {
				const filePath = filePathFromToolCall(toolCall);
				const toolName = acpToolName(toolCall);
				const toolInput = acpApprovalInput(toolCall);
				const requiresObsidianCommandApproval = isObsidianRunCommandRequest(
					toolName,
					toolInput,
				);
				const signal = this.runtimeSignal();
				const decision =
					this.params.permissionMode === "bypassPermissions" &&
					!this.params.policyEnforced &&
					!requiresObsidianCommandApproval
						? { behavior: "allow" as const }
						: await this.params.canUseTool(toolName, toolInput, {
								toolUseID: toolCall.toolCallId,
								signal,
								title: toolCall.title ?? undefined,
								description: acpPermissionDescription(toolCall),
								allowOnce: options.some(
									(option) => option.kind === "allow_once",
								),
								allowSession: options.some(
									(option) => option.kind === "allow_once",
								),
								allowAlways: options.some(
									(option) => option.kind === "allow_always",
								),
							});
				if (signal.aborted) return { outcome: { outcome: "cancelled" } };
				const allowed = decision.behavior === "allow";
				if (
					allowed &&
					this.params.permissionMode === "plan" &&
					(toolCall.kind === "edit" || toolName === "Write") &&
					filePath &&
					isHtmlPlanPath(filePath, this.params.planHtmlPath)
				) {
					this.approvedHtmlPlanToolIds.add(toolCall.toolCallId);
				}
				const option = permissionOptionForDecision(
					options,
					decision.behavior === "allow"
						? { behavior: "allow", saveScope: decision.saveScope }
						: { behavior: "deny" },
				);
				return option
					? { outcome: { outcome: "selected", optionId: option.optionId } }
					: { outcome: { outcome: "cancelled" } };
			},
			unstable_createElicitation: async (request) => {
				try {
					return await this.handleElicitation(request);
				} catch (error) {
					console.error("[acp] elicitation failed:", error);
					throw error;
				}
			},
			sessionUpdate: ({ sessionId: updateSessionId, update }) => {
				if (
					this.cancelled ||
					runtimeGeneration !== this.runtimeGeneration ||
					this.modelVisibilityFault ||
					(this.sessionId !== null && updateSessionId !== this.sessionId)
				) {
					return;
				}
				if (update.sessionUpdate === "config_option_update") {
					this.adoptConfigNotification(update.configOptions, runtimeGeneration);
					return;
				}
				if (this.loadingSessionReplay) {
					if (update.sessionUpdate === "available_commands_update") {
						this.commands = update.availableCommands.map((command) => ({
							name: command.name,
							description: command.description ?? "",
							argumentHint: command.input?.hint ?? "",
						}));
					}
					if (
						update.sessionUpdate === "usage_update" &&
						update.cost?.currency.toUpperCase() === "USD"
					) {
						this.latestCostUsd = update.cost.amount;
					}
					return;
				}
				if (update.sessionUpdate === "agent_thought_chunk") {
					this.handleThoughtChunk(update);
					return;
				}
				if (update.sessionUpdate === "agent_message_chunk") {
					if (
						update.messageId &&
						this.lastAgentMessageId &&
						update.messageId !== this.lastAgentMessageId
					) {
						this.events.push({ type: "assistant_message_boundary" });
					}
					if (update.messageId) this.lastAgentMessageId = update.messageId;
				}
				if (update.sessionUpdate === "available_commands_update") {
					this.commands = update.availableCommands.map((command) => ({
						name: command.name,
						description: command.description ?? "",
						argumentHint: command.input?.hint ?? "",
					}));
					this.events.push({
						type: "commands_changed",
						commands: this.commands,
					});
				}
				if (update.sessionUpdate === "current_mode_update" && this.modes) {
					this.modes = { ...this.modes, currentModeId: update.currentModeId };
					this.publishSessionConfig();
				}
				if (update.sessionUpdate === "plan") {
					this.nativePlanText = planEntriesText(update.entries);
				}
				if (update.sessionUpdate === "plan_update") {
					this.nativePlanText = planUpdateText(update);
				}
				if (update.sessionUpdate === "plan_removed") {
					this.nativePlanText = "";
				}
				if (
					update.sessionUpdate === "usage_update" &&
					update.cost?.currency.toUpperCase() === "USD"
				) {
					this.latestCostUsd = update.cost.amount;
				}
				const planEventId =
					update.sessionUpdate === "plan" ||
					update.sessionUpdate === "plan_update" ||
					update.sessionUpdate === "plan_removed"
						? `acp-plan-${++this.planEventSeq}`
						: undefined;
				const events = eventsFromUpdate(
					update,
					planEventId,
					this.toolCalls,
					this.startedToolCalls,
					this.terminalToolCalls,
				);
				if (
					(update.sessionUpdate === "tool_call" ||
						update.sessionUpdate === "tool_call_update") &&
					this.approvedHtmlPlanToolIds.has(update.toolCallId)
				) {
					const toolCall = this.toolCalls.get(update.toolCallId);
					if (toolCall?.status === "completed") this.htmlPlanReady = true;
					if (toolCall?.status === "failed") {
						this.approvedHtmlPlanToolIds.delete(update.toolCallId);
					}
				}
				for (const event of events) this.pushMappedEvent(event);
				if (
					update.sessionUpdate === "tool_call" ||
					update.sessionUpdate === "tool_call_update"
				) {
					const toolCall = this.toolCalls.get(update.toolCallId);
					if (toolCall) {
						this.observeInternalMcpToolName(acpToolName(toolCall));
					}
				}
			},
		};
		const stream = ndJsonStream(
			Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
		);
		const connection = new ClientSideConnection(() => client, stream);
		this.connection = connection;
		const initialized = await this.runPhase(
			"initialize",
			this.timeouts.initializeMs,
			() =>
				connection.initialize({
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: { plan: {}, elicitation: { form: {} } },
					clientInfo: { name: "Hlid", version: "1" },
				}),
		);
		const sessionCapabilities =
			initialized.agentCapabilities?.sessionCapabilities;
		const additionalDirectoryParams =
			sessionCapabilities?.additionalDirectories &&
			this.params.additionalDirectories !== undefined
				? {
						additionalDirectories: this.params.additionalDirectories
							.filter((path) => adapter.pathAccessible(this.params.cwd, path))
							.map((path) => adapter.providerPath(this.params.cwd, path)),
					}
				: {};
		const sessionMcpServers = this.negotiatedMcpServers(
			initialized.agentCapabilities?.mcpCapabilities,
		);
		this.canLoadSession = Boolean(initialized.agentCapabilities?.loadSession);
		this.canResumeSession = Boolean(sessionCapabilities?.resume);
		this.acceptsImagePrompts =
			initialized.agentCapabilities?.promptCapabilities?.image === true;
		this.acceptsEmbeddedContext =
			initialized.agentCapabilities?.promptCapabilities?.embeddedContext ===
			true;
		this.canDeleteSession = Boolean(sessionCapabilities?.delete);
		this.canCloseSession = Boolean(sessionCapabilities?.close);
		if (this.cancelled) return;
		let modes: SessionModeState | null | undefined;
		let configOptions: SessionConfigOption[] | null | undefined;
		if (
			this.params.sessionId &&
			(this.canResumeSession || this.canLoadSession)
		) {
			// A usage_update cost is session-cumulative. Until the resumed agent
			// supplies an idle baseline, its first in-turn update cannot be separated
			// from historical spend and must not be charged to the new Hlid query.
			this.costBaselineKnown = false;
			try {
				if (this.canResumeSession) {
					const resumed = await this.runPhase(
						"session resume",
						this.timeouts.sessionMs,
						() =>
							connection.resumeSession({
								sessionId: this.params.sessionId ?? "",
								cwd: providerCwd,
								...additionalDirectoryParams,
								mcpServers: sessionMcpServers,
							}),
					);
					modes = resumed.modes;
					configOptions = resumed.configOptions;
				} else {
					this.loadingSessionReplay = true;
					try {
						const loaded = await this.runPhase(
							"session load",
							this.timeouts.sessionMs,
							() =>
								connection.loadSession({
									sessionId: this.params.sessionId ?? "",
									cwd: providerCwd,
									...additionalDirectoryParams,
									mcpServers: sessionMcpServers,
								}),
						);
						modes = loaded.modes;
						configOptions = loaded.configOptions;
					} finally {
						this.loadingSessionReplay = false;
					}
				}
				this.sessionId = this.params.sessionId;
				this.allowInterruptedResumeFallback = false;
			} catch (error) {
				if (!this.allowInterruptedResumeFallback) throw error;
				this.allowInterruptedResumeFallback = false;
				this.params.sessionId = undefined;
				const created = await this.runPhase(
					"replacement session creation",
					this.timeouts.sessionMs,
					() =>
						connection.newSession({
							cwd: providerCwd,
							...additionalDirectoryParams,
							mcpServers: sessionMcpServers,
						}),
				);
				({ modes, configOptions } = this.adoptCreatedSession(created));
			}
		} else {
			const created = await this.runPhase(
				"session creation",
				this.timeouts.sessionMs,
				() =>
					connection.newSession({
						cwd: providerCwd,
						...additionalDirectoryParams,
						mcpServers: sessionMcpServers,
					}),
			);
			({ modes, configOptions } = this.adoptCreatedSession(created));
		}
		if (!this.sessionId) {
			throw new Error("ACP session initialization returned no session id");
		}
		this.markMcpSetupComplete();
		this.modes = modes ?? null;
		this.configOptions = configOptions ?? [];
		await this.enforceProviderDefaultModelVisibility();
		this.initialConfigValues.clear();
		for (const option of this.configOptions) {
			if (option.type === "select") {
				this.initialConfigValues.set(option.id, option.currentValue);
			}
		}
		const stableMode = modeConfigOption(this.configOptions);
		const stablePlanValue = stableMode ? planConfigValue(stableMode) : null;
		if (
			stableMode?.type === "select" &&
			stablePlanValue &&
			stableMode.currentValue === stablePlanValue
		) {
			this.implementationConfigModeValue = implementationConfigValue(
				stableMode,
				stablePlanValue,
			);
		}
		const planningModeId = planModeId(this.modes);
		if (planningModeId && this.modes?.currentModeId === planningModeId) {
			this.implementationModeId = implementationValue(
				this.modes.availableModes.filter((mode) => mode.id !== planningModeId),
			);
		}
		const requestedModel = this.params.model || undefined;
		await this.setConfigValue(
			"model",
			requestedModel && this.options.requestModel
				? this.options.requestModel(requestedModel)
				: requestedModel,
		);
		// Model selection can replace the effort menu. A carried selection from a
		// different provider, workspace, or model is not provider authority: omit it
		// when the refreshed ACP options do not advertise the exact value.
		const requestedEffort = this.params.effort;
		await this.setConfigValue("thought_level", this.params.effort, false, true);
		const authoritativeThought = configOption(
			this.configOptions,
			"thought_level",
			/thought|reason|effort/i,
		);
		if (requestedEffort !== undefined) {
			this.params.effort =
				authoritativeThought?.type === "select"
					? authoritativeThought.currentValue
					: undefined;
		}
		await this.syncPermissionMode(this.params.permissionMode ?? "default");
		this.configNotificationsReady = true;
		this.publishSessionConfig();
		this.events.push({ type: "session_start", sessionId: this.sessionId });
	}

	async send(message: string, opts?: SendOptions): Promise<void> {
		this.assertPromptAdmission();
		const releaseForeground =
			(await this.beforePromptDispatch?.(this.runtimeSignal())) ?? (() => {});
		let promptOwnsForeground = false;
		try {
			this.assertPromptAdmission();
			await this.initialize();
			this.assertPromptAdmission();
			if (this.cancelled || !this.connection || !this.sessionId) return;
			if (this.activePrompt && !this.activePrompt.settled) {
				throw new Error("ACP session already has an active prompt");
			}
			const active: ActiveAcpPrompt = {
				promise: Promise.resolve(),
				startedAt: Date.now(),
				settled: false,
				controlsLocked: true,
				suppressError: false,
			};
			this.activePrompt = active;
			let receiptSettled: () => void = () => {};
			const receiptComplete = new Promise<void>((resolve) => {
				receiptSettled = resolve;
			});
			const acceptedContent = this.acceptedStructuredContent(
				opts?.structuredContent ?? [],
			);
			active.promise = (async () => {
				try {
					await opts?.onStructuredContentAccepted?.(acceptedContent);
				} catch (error) {
					console.error(
						"[acp] structured prompt receipt callback failed:",
						error,
					);
				} finally {
					receiptSettled();
				}
				this.assertPromptAdmission();
				if (this.cancelled || !this.connection || !this.sessionId) return;
				await this.runPrompt(message, acceptedContent);
			})();
			promptOwnsForeground = true;
			void active.promise
				.then(
					() => {
						active.settled = true;
					},
					(error) => {
						active.settled = true;
						if (!active.suppressError && !this.cancelled) {
							this.flushThoughts(true);
							this.resetObservableMcpStatuses(true);
							this.events.end(appendAcpStderr(error, this.stderr()));
						}
					},
				)
				.finally(() => {
					releaseForeground();
					if (this.activePrompt === active) this.activePrompt = null;
				});
			await receiptComplete;
		} finally {
			if (!promptOwnsForeground) releaseForeground();
		}
	}

	private acceptedStructuredContent(
		structuredContent: readonly ProviderPromptContent[],
	): ProviderPromptContent[] {
		const accepted: ProviderPromptContent[] = [];
		for (const block of structuredContent) {
			if (block.type === "image") {
				if (!this.acceptsImagePrompts) continue;
				accepted.push({
					type: "image",
					data: block.data,
					mimeType: block.mimeType,
					...(block.uri ? { uri: block.uri } : {}),
				});
				continue;
			}
			if (!this.acceptsEmbeddedContext) continue;
			if (block.text !== undefined) {
				accepted.push({
					type: "resource",
					uri: block.uri,
					...(block.mimeType ? { mimeType: block.mimeType } : {}),
					text: block.text,
				});
			} else if (block.blob !== undefined) {
				accepted.push({
					type: "resource",
					uri: block.uri,
					...(block.mimeType ? { mimeType: block.mimeType } : {}),
					blob: block.blob,
				});
			}
		}
		return accepted;
	}

	private promptBlocks(
		message: string,
		structuredContent: readonly ProviderPromptContent[],
	): ContentBlock[] {
		const prompt: ContentBlock[] = [{ type: "text", text: message }];
		for (const block of structuredContent) {
			if (block.type === "image") {
				prompt.push({
					type: "image",
					data: block.data,
					mimeType: block.mimeType,
					...(block.uri ? { uri: block.uri } : {}),
				});
				continue;
			}
			if (block.text !== undefined) {
				prompt.push({
					type: "resource",
					resource: {
						uri: block.uri,
						text: block.text,
						...(block.mimeType ? { mimeType: block.mimeType } : {}),
					},
				});
			} else if (block.blob !== undefined) {
				prompt.push({
					type: "resource",
					resource: {
						uri: block.uri,
						blob: block.blob,
						...(block.mimeType ? { mimeType: block.mimeType } : {}),
					},
				});
			}
		}
		return prompt;
	}

	private async runPrompt(
		message: string,
		structuredContent: readonly ProviderPromptContent[] = [],
		costStartUsd: number | null = this.latestCostUsd,
		queryTurnStart = this.turns,
		queryStartedMs = Date.now(),
		queryUsage: AcpUsageTotals = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			reported: false,
		},
	): Promise<void> {
		if (!this.connection || !this.sessionId) return;
		// Dependent config mutations are allowed to replace the option catalog, but
		// they must not silently replace the model Hlid shows as selected.
		this.assertActiveModelVisible(
			this.configOptions,
			this.requestedModelValue(),
		);
		const identity: AcpRuntimeIdentity = {
			generation: this.runtimeGeneration,
			connection: this.connection,
			sessionId: this.sessionId,
		};
		this.approvedHtmlPlanToolIds.clear();
		this.htmlPlanReady = false;
		this.nativePlanText = "";
		this.lastAgentMessageId = null;
		this.toolCalls.clear();
		this.startedToolCalls.clear();
		this.terminalToolCalls.clear();
		this.clearToolProgress();
		this.beginThoughtPrompt();
		this.turnStartCostUsd = costStartUsd;
		let response: Awaited<ReturnType<ClientSideConnection["prompt"]>>;
		try {
			response = await identity.connection.prompt({
				sessionId: identity.sessionId,
				prompt: this.promptBlocks(message, structuredContent),
			});
		} catch (error) {
			if (this.runtimeIdentityIsCurrent(identity)) this.flushThoughts(true);
			throw error;
		}
		if (!this.runtimeIdentityIsCurrent(identity)) {
			throw this.modelVisibilityFault ?? new AcpRuntimeSupersededError();
		}
		this.flushThoughts(response.stopReason === "cancelled");
		this.turns += 1;
		if (response.usage) {
			queryUsage.inputTokens += response.usage.inputTokens;
			queryUsage.outputTokens += response.usage.outputTokens;
			queryUsage.cacheReadTokens += response.usage.cachedReadTokens ?? 0;
			queryUsage.cacheCreationTokens += response.usage.cachedWriteTokens ?? 0;
			queryUsage.reported = true;
			this.events.push({
				type: "usage",
				inputTokens: response.usage.inputTokens,
				outputTokens: response.usage.outputTokens,
				cacheReadTokens: response.usage.cachedReadTokens ?? undefined,
				cacheCreationTokens: response.usage.cachedWriteTokens ?? undefined,
			});
		}
		const confirmedPlan = this.nativePlanText.trim()
			? this.nativePlanText
			: this.htmlPlanReady
				? "HTML plan ready for review."
				: null;
		if (
			this.params.permissionMode === "plan" &&
			response.stopReason === "end_turn" &&
			confirmedPlan
		) {
			const plan = confirmedPlan;
			const signal = this.runtimeSignal();
			const decision = await this.params.canUseTool(
				"ExitPlanMode",
				{ plan },
				{
					toolUseID: `acp-plan-${this.sessionId}-${this.turns}`,
					signal,
					title: `${this.options.label} completed its plan`,
				},
			);
			if (signal.aborted) throw signal.reason;
			if (
				decision.behavior === "deny" &&
				decision.message?.startsWith("User requested changes to the plan:")
			) {
				const revisionInstruction = this.htmlPlanReady
					? "Replace the HTML plan document specified earlier and present it for approval again."
					: "Revise the native plan and present it for approval again.";
				await this.runPrompt(
					`${decision.message}\n\n${revisionInstruction}`,
					[],
					costStartUsd,
					queryTurnStart,
					queryStartedMs,
					queryUsage,
				);
				return;
			}
			if (decision.behavior === "allow") {
				this.params.permissionMode =
					this.params.implementationPermissionMode ?? "default";
				await this.syncPermissionMode(this.params.permissionMode);
				await this.runPrompt(
					"The user approved the plan. Implement it now, including its validation steps. Do not create another plan unless implementation reveals a material blocker that requires user input.",
					[],
					costStartUsd,
					queryTurnStart,
					queryStartedMs,
					queryUsage,
				);
				return;
			}
		}
		if (this.activePrompt) this.activePrompt.controlsLocked = false;
		this.events.push({
			type: "done",
			...(this.latestCostUsd != null &&
			(this.turnStartCostUsd != null || this.costBaselineKnown)
				? {
						cost: Math.max(
							0,
							this.latestCostUsd - (this.turnStartCostUsd ?? 0),
						),
					}
				: {}),
			turns: this.turns - queryTurnStart,
			durationMs: Date.now() - queryStartedMs,
			stopReason: response.stopReason,
			...(queryUsage.reported
				? {
						usage: {
							inputTokens: queryUsage.inputTokens,
							outputTokens: queryUsage.outputTokens,
							cacheReadTokens: queryUsage.cacheReadTokens,
							cacheCreationTokens: queryUsage.cacheCreationTokens,
						},
					}
				: {}),
		});
		if (this.latestCostUsd != null) this.costBaselineKnown = true;
		if (this.closeAfterTurn) await this.finishOneShot();
	}

	cancel(): void {
		void this.cancelAndWait();
	}

	async cancelAndWait(): Promise<void> {
		const initializing = this.initPromise;
		if (!this.cancelled) {
			const publishMcpStatus = Boolean(
				this.activePrompt &&
					!this.activePrompt.settled &&
					this.activePrompt.controlsLocked,
			);
			this.flushThoughts(true);
			this.resetObservableMcpStatuses(publishMcpStatus);
			this.cancelled = true;
			this.clearToolProgress();
			this.runtimeAbortController.abort(new Error("ACP session cancelled"));
			if (this.connection && this.sessionId) {
				void this.connection
					.cancel({ sessionId: this.sessionId })
					.catch(() => {});
			}
			this.events.end();
		}
		await this.stopOwnedProcess(true);
		await initializing?.catch(() => {});
		// Initialization can publish its child immediately before observing abort.
		await this.stopOwnedProcess(true);
	}

	async interrupt(): Promise<void> {
		const active = this.activePrompt;
		if (
			this.cancelled ||
			!this.connection ||
			!this.sessionId ||
			!active ||
			active.settled
		) {
			return;
		}
		try {
			await this.runPhase(
				"session cancellation",
				this.timeouts.interruptGraceMs,
				() => this.connection?.cancel({ sessionId: this.sessionId ?? "" }),
			);
		} catch {
			// A blocked notification write is equivalent to an ignored cancellation.
		}
		if (await waitForPromptSettlement(active, this.timeouts.interruptGraceMs)) {
			return;
		}

		active.suppressError = true;
		const previousSessionId = this.sessionId;
		const canReconnect = this.canResumeSession || this.canLoadSession;
		this.runtimeAbortController.abort(
			new Error("ACP agent did not settle session cancellation"),
		);
		await this.stopOwnedProcess(true);
		await waitForPromptSettlement(active, this.timeouts.terminateGraceMs);
		this.flushThoughts(true);
		this.resetAfterRuntimeStop(previousSessionId, canReconnect, true);
		if (this.activePrompt === active) this.activePrompt = null;
		this.events.push({
			type: "done",
			turns: 0,
			durationMs: Date.now() - active.startedAt,
			stopReason: "cancelled",
		});
	}

	closeInput(): void {
		this.closeAfterTurn = true;
	}

	private async finishOneShot(): Promise<void> {
		if (this.connection && this.sessionId) {
			if (this.params.persistSession === false && this.canDeleteSession) {
				await this.runPhase("session deletion", this.timeouts.sessionMs, () =>
					this.connection?.deleteSession({ sessionId: this.sessionId ?? "" }),
				).catch(() => {});
			} else if (this.canCloseSession) {
				await this.runPhase("session close", this.timeouts.sessionMs, () =>
					this.connection?.closeSession({ sessionId: this.sessionId ?? "" }),
				).catch(() => {});
			}
		}
		await this.stopOwnedProcess();
		this.resetObservableMcpStatuses();
		this.events.end();
	}

	async mcpServerStatus(): Promise<McpServerStatus[]> {
		await this.runPhase(
			"project MCP configuration",
			this.timeouts.preparationMs,
			() => this.mcpConfigPromise,
		);
		return this.mcpStatuses;
	}

	async supportedCommands(): Promise<SlashCommand[]> {
		return this.commands;
	}

	sessionConfig(): ProviderSessionConfigSnapshot | null {
		return this.configNotificationsReady &&
			!this.modelVisibilityFault &&
			!this.runtimeRetirement
			? sessionConfigSnapshot(
					this.configOptions,
					this.modes,
					this.options.modelFilter,
				)
			: null;
	}

	async setPermissionMode(mode: string): Promise<void> {
		if (
			mode === "default" ||
			mode === "acceptEdits" ||
			mode === "bypassPermissions" ||
			mode === "plan"
		) {
			this.assertControlAdmission();
			if (!this.connection || !this.sessionId) {
				this.params.permissionMode = mode;
				return;
			}
			await this.runLiveControl(async () => {
				await this.syncPermissionMode(mode);
				this.params.permissionMode = mode;
			});
		}
	}

	async setModel(model?: string): Promise<void> {
		if (!acpModelVisible(model, this.options.modelFilter)) {
			throw new Error(
				`Model ${JSON.stringify(model)} is excluded by Hlid's ACP model visibility`,
			);
		}
		this.assertControlAdmission();
		if (!this.connection || !this.sessionId) {
			this.params.model = model;
			return;
		}
		await this.runLiveControl(async () => {
			const requested =
				model && this.options.requestModel
					? this.options.requestModel(model)
					: model;
			const option = configOption(this.configOptions, "model", /model/i);
			this.modelControlActive = true;
			this.modelControlExpectedValue =
				requested ??
				(option?.type === "select"
					? this.initialConfigValues.get(option.id)
					: undefined);
			try {
				await this.setConfigValue("model", requested, true);
			} finally {
				this.modelControlActive = false;
				this.modelControlExpectedValue = undefined;
			}
			this.params.model = model;
		});
	}

	async setEffort(effort: string): Promise<void> {
		this.assertControlAdmission();
		if (!this.connection || !this.sessionId) {
			this.params.effort = effort;
			return;
		}
		const option = configOption(
			this.configOptions,
			"thought_level",
			/thought|reason|effort/i,
		);
		if (option?.type !== "select") {
			throw new Error(
				"ACP agent does not advertise selectable thought-level control",
			);
		}
		if (
			!selectOptions(option).some((candidate) => candidate.value === effort)
		) {
			throw new Error(
				`ACP agent does not advertise thought level ${JSON.stringify(effort)} for the active model`,
			);
		}
		await this.runLiveControl(async () => {
			await this.setConfigValue("thought_level", effort);
			this.params.effort = effort;
		});
	}

	private async applyAdvertisedSessionMode(mode: string): Promise<void> {
		if (!this.connection || !this.sessionId) {
			throw new Error("ACP session mode control requires a live session");
		}
		const stableMode = modeConfigOption(this.configOptions);
		if (stableMode?.type === "select") {
			if (!selectOptions(stableMode).some((option) => option.value === mode)) {
				throw new Error(`ACP agent does not advertise session mode ${mode}`);
			}
			if (stableMode.currentValue !== mode) {
				await this.applyConfigOption(
					stableMode,
					mode,
					"session mode configuration",
					this.timeouts.modeMs,
				);
			}
			return;
		}
		const modes = this.modes;
		if (!modes) {
			throw new Error("ACP agent does not advertise session modes");
		}
		if (!modes.availableModes.some((candidate) => candidate.id === mode)) {
			throw new Error(`ACP agent does not advertise session mode ${mode}`);
		}
		if (modes.currentModeId === mode) return;
		await this.runPhase(
			"legacy session mode configuration",
			this.timeouts.modeMs,
			() =>
				this.connection?.setSessionMode({
					sessionId: this.sessionId ?? "",
					modeId: mode,
				}),
		);
		this.modes = { ...modes, currentModeId: mode };
		this.publishSessionConfig();
	}

	async setSessionMode(mode: string): Promise<void> {
		await this.runLiveControl(async () => {
			const stableMode = modeConfigOption(this.configOptions);
			let nextImplementationConfigModeValue: string | undefined;
			let nextImplementationModeId: string | undefined;
			if (stableMode?.type === "select") {
				const planValue = planConfigValue(stableMode);
				if (
					planValue &&
					mode === planValue &&
					stableMode.currentValue !== planValue
				) {
					nextImplementationConfigModeValue = stableMode.currentValue;
				} else if (!planValue || mode !== planValue) {
					nextImplementationConfigModeValue = mode;
				}
			} else if (this.modes) {
				const planningModeId = planModeId(this.modes);
				if (
					planningModeId &&
					mode === planningModeId &&
					this.modes.currentModeId !== planningModeId
				) {
					nextImplementationModeId = this.modes.currentModeId;
				} else if (!planningModeId || mode !== planningModeId) {
					nextImplementationModeId = mode;
				}
			}
			await this.applyAdvertisedSessionMode(mode);
			if (nextImplementationConfigModeValue !== undefined) {
				this.implementationConfigModeValue = nextImplementationConfigModeValue;
			}
			if (nextImplementationModeId !== undefined) {
				this.implementationModeId = nextImplementationModeId;
			}
		});
	}

	async restoreSessionMode(): Promise<void> {
		await this.runLiveControl(async () => {
			const stableMode = modeConfigOption(this.configOptions);
			if (stableMode?.type === "select") {
				const planValue = planConfigValue(stableMode);
				if (!planValue) {
					throw new Error("ACP agent does not advertise a planning mode");
				}
				if (stableMode.currentValue !== planValue) return;
				const target = this.implementationConfigModeValue;
				if (
					!target ||
					target === planValue ||
					!selectOptions(stableMode).some((option) => option.value === target)
				) {
					throw new Error(
						"ACP session has no previous non-Plan mode to restore",
					);
				}
				await this.applyAdvertisedSessionMode(target);
				return;
			}
			if (!this.modes) {
				throw new Error("ACP agent does not advertise session modes");
			}
			const planningModeId = planModeId(this.modes);
			if (!planningModeId) {
				throw new Error("ACP agent does not advertise a planning mode");
			}
			if (this.modes.currentModeId !== planningModeId) return;
			const target = this.implementationModeId;
			if (
				!target ||
				target === planningModeId ||
				!this.modes.availableModes.some((mode) => mode.id === target)
			) {
				throw new Error("ACP session has no previous non-Plan mode to restore");
			}
			await this.applyAdvertisedSessionMode(target);
		});
	}

	setPlanHtmlPath(path: string | undefined): void {
		this.params.planHtmlPath = path;
	}

	[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
		return { next: () => this.events.next() };
	}
}

export class AcpProvider implements AgentProvider {
	readonly providerId: string;
	readonly label: string;
	readonly metadataCacheIdentity?: string;
	readonly sessionContinuityIdentity?: string;
	readonly modelCatalogScope = "workspace" as const;
	// fallow-ignore-next-line unused-class-member -- Read through AgentProvider during explicit catalog refresh.
	readonly liveModelDiscoveryValidatesAvailability = true;
	readonly permissionModes = [
		{
			value: "default",
			label: "Review requested approvals",
			desc: "Hlid asks when the ACP agent sends an approval request",
		},
		{
			value: "bypassPermissions",
			label: "Allow requested approvals",
			desc: "automatically accepts approval requests sent by the ACP agent",
		},
	] as const;
	private forkCapabilityCache = new Map<
		string,
		{ value: ProviderForkCapability | undefined; expiresAt: number }
	>();
	private forkCapabilityProbes = new Map<
		string,
		Promise<ProviderForkCapability | undefined>
	>();
	private metadataInspections = new Map<
		string,
		ManagedAcpInspection<AcpMetadataInspection>
	>();
	private modelCatalogInspections = new Map<
		string,
		ManagedAcpInspection<ProviderModelInfo[]>
	>();
	/** Exact workspaces with a prompt admitted ahead of background discovery. */
	private foregroundPrompts = new Map<string, number>();
	private availabilityValidationGeneration = 0;
	private retiredError: Error | null = null;
	private retirementPromise: Promise<void> | null = null;
	private availabilitySnapshot:
		| { available: boolean; reason?: string }
		| undefined;

	constructor(readonly options: AcpProviderOptions) {
		this.providerId = options.id;
		this.label = options.label;
		this.metadataCacheIdentity = options.metadataCacheIdentity;
		this.sessionContinuityIdentity = options.metadataCacheIdentity
			? createHash("sha256").update(options.metadataCacheIdentity).digest("hex")
			: undefined;
		this.availabilitySnapshot = options.initialAvailability;
	}

	private assertRuntimeActive(): void {
		if (this.retiredError) throw this.retiredError;
	}

	/** Permanently fail closed and drain every provider-owned background inspection. */
	retireRuntime(reason?: string): Promise<void> {
		if (this.retirementPromise) return this.retirementPromise;
		const error = new Error(
			reason?.trim() || `${this.label} runtime is updating; try again shortly.`,
		);
		error.name = "AcpProviderRetiredError";
		// This assignment must remain synchronous: callers remove/replace the provider
		// immediately after invoking this method, and no stale reference may admit work
		// during the asynchronous process-cleanup window.
		this.retiredError = error;
		this.availabilityValidationGeneration += 1;
		this.availabilitySnapshot = { available: false, reason: error.message };

		const pending = new Set<Promise<unknown>>();
		for (const inspection of this.modelCatalogInspections.values()) {
			inspection.controller.abort(error);
			pending.add(inspection.promise);
		}
		for (const inspection of this.metadataInspections.values()) {
			inspection.controller.abort(error);
			pending.add(inspection.promise);
		}
		for (const probe of this.forkCapabilityProbes.values()) pending.add(probe);
		this.retirementPromise = Promise.allSettled(pending).then(() => undefined);
		return this.retirementPromise;
	}

	async hlidToolLoading() {
		const obsidianStatus = await getObsidianCliStatus();
		const hlidTools = describeHlidToolLoading(HLID_AGENT_TOOL_SPECS, false);
		const obsidianTools = obsidianStatus.installed
			? describeHlidToolLoading(OBSIDIAN_AGENT_TOOL_SPECS, false)
			: [];
		return [
			{
				namespace: "hlid" as const,
				total: hlidTools.length,
				deferred: 0,
				tools: hlidTools,
			},
			{
				namespace: "hlid_obsidian" as const,
				total: obsidianTools.length,
				deferred: 0,
				tools: obsidianTools,
			},
		];
	}

	async check(): Promise<{ available: boolean; reason?: string }> {
		this.assertRuntimeActive();
		const availabilityGeneration = ++this.availabilityValidationGeneration;
		try {
			const resolved = await runAcpPhase({
				phase: "availability check",
				timeoutMs: acpTimeouts(this.options).preparationMs,
				run: async () => {
					const providerEnv = await resolveAcpEnv(this.options.env);
					const hostCwd = this.options.discoveryCwd ?? process.cwd();
					return acpAdapter(this.options).resolveExecutable(
						this.options.command,
						{
							hostCwd,
							env: { ...process.env, ...providerEnv },
							forwardedEnvNames: Object.keys(providerEnv),
							timeoutMs: acpTimeouts(this.options).preparationMs,
						},
					);
				},
			});
			const result = resolved
				? { available: true }
				: {
						available: false,
						reason: `${this.options.command} is not installed`,
					};
			if (availabilityGeneration === this.availabilityValidationGeneration) {
				this.availabilitySnapshot = result;
			}
			return result;
		} catch (error) {
			const result = { available: false, reason: errorText(error) };
			if (availabilityGeneration === this.availabilityValidationGeneration) {
				this.availabilitySnapshot = result;
			}
			return result;
		}
	}

	cachedAvailability(): { available: boolean; reason?: string } | undefined {
		return this.availabilitySnapshot;
	}

	updateAvailabilitySnapshot(snapshot: {
		available: boolean;
		reason?: string;
	}): void {
		if (this.retiredError) return;
		this.availabilityValidationGeneration += 1;
		this.availabilitySnapshot = snapshot;
	}

	private inspectMetadata(
		cwd = this.options.discoveryCwd ?? process.cwd(),
	): Promise<AcpMetadataInspection> {
		this.assertRuntimeActive();
		const key = declaredPathKey(cwd);
		this.assertBackgroundInspectionAdmission(key, cwd, "metadata");
		const existing = this.metadataInspections.get(key);
		if (existing) return existing.promise;
		const controller = new AbortController();
		const pending = inspectAcpMetadata(
			this.options,
			cwd,
			controller.signal,
		).finally(() => {
			if (this.metadataInspections.get(key)?.promise === pending) {
				this.metadataInspections.delete(key);
			}
		});
		this.metadataInspections.set(key, { controller, promise: pending });
		return pending;
	}

	private inspectModelCatalog(
		cwd = this.options.discoveryCwd ?? process.cwd(),
	): Promise<ProviderModelInfo[]> {
		this.assertRuntimeActive();
		const key = declaredPathKey(cwd);
		this.assertBackgroundInspectionAdmission(key, cwd, "model catalog");
		const existing = this.modelCatalogInspections.get(key);
		if (existing) return existing.promise;
		const controller = new AbortController();
		const availabilityGeneration = ++this.availabilityValidationGeneration;
		const pending = inspectAcpModelCatalog(this.options, cwd, controller.signal)
			.then(
				(models) => {
					if (
						availabilityGeneration === this.availabilityValidationGeneration
					) {
						this.availabilitySnapshot = { available: true };
					}
					return models;
				},
				(error) => {
					if (
						availabilityGeneration === this.availabilityValidationGeneration
					) {
						this.availabilitySnapshot = {
							available: false,
							reason: errorText(error),
						};
					}
					throw error;
				},
			)
			.finally(() => {
				if (this.modelCatalogInspections.get(key)?.promise === pending) {
					this.modelCatalogInspections.delete(key);
				}
			});
		this.modelCatalogInspections.set(key, { controller, promise: pending });
		return pending;
	}

	private assertBackgroundInspectionAdmission(
		key: string,
		cwd: string,
		kind: string,
	): void {
		if ((this.foregroundPrompts.get(key) ?? 0) === 0) return;
		throw new AcpPhaseError(
			`${kind} inspection`,
			`deferred while a live session owns ${JSON.stringify(cwd)}`,
		);
	}

	private async acquireForegroundPrompt(
		cwd: string,
		signal: AbortSignal,
	): Promise<() => void> {
		this.assertRuntimeActive();
		const key = declaredPathKey(cwd);
		this.foregroundPrompts.set(key, (this.foregroundPrompts.get(key) ?? 0) + 1);
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			const remaining = (this.foregroundPrompts.get(key) ?? 1) - 1;
			if (remaining > 0) this.foregroundPrompts.set(key, remaining);
			else this.foregroundPrompts.delete(key);
		};
		try {
			const adapter = acpAdapter(this.options);
			await observeAcpStartup(
				`admission:${this.options.id}:${adapter.key}`,
				`${this.options.label} ${adapter.key} foreground admission`,
				() => this.preemptBackgroundInspections(cwd, signal),
			);
			return release;
		} catch (error) {
			release();
			throw error;
		}
	}

	private async preemptBackgroundInspections(
		cwd: string,
		signal: AbortSignal,
	): Promise<void> {
		const key = declaredPathKey(cwd);
		const modelCatalog = this.modelCatalogInspections.get(key);
		const metadata = this.metadataInspections.get(key);
		const managed: ManagedAcpInspection<unknown>[] = [];
		if (modelCatalog) managed.push(modelCatalog);
		if (metadata) managed.push(metadata);
		if (managed.length === 0) return;

		// A deliberately cancelled catalog refresh is not evidence that the agent is
		// unavailable. Supersede its availability write before aborting the process.
		if (modelCatalog) this.availabilityValidationGeneration += 1;
		const reason = new AcpPhaseError(
			"background inspection",
			`preempted by a live session for ${JSON.stringify(cwd)}`,
		);
		for (const inspection of managed) inspection.controller.abort(reason);

		const pending = new Set<Promise<unknown>>(
			managed.map((inspection) => inspection.promise),
		);
		const forkProbe = this.forkCapabilityProbes.get(key);
		if (forkProbe) pending.add(forkProbe);
		const timeouts = acpTimeouts(this.options);
		await runAcpPhase({
			phase: "background inspection cleanup",
			timeoutMs: Math.max(1, timeouts.inspectionMs + timeouts.terminateGraceMs),
			signal,
			run: async () => {
				await Promise.allSettled(pending);
			},
		});
	}

	private rememberForkCapability(
		cwd: string,
		value: ProviderForkCapability | undefined,
	): void {
		const key = declaredPathKey(cwd);
		if (
			!this.forkCapabilityCache.has(key) &&
			this.forkCapabilityCache.size >= MAX_ACP_FORK_CAPABILITY_WORKSPACES
		) {
			const oldest = this.forkCapabilityCache.keys().next().value;
			if (oldest !== undefined) this.forkCapabilityCache.delete(oldest);
		}
		this.forkCapabilityCache.set(key, {
			value,
			expiresAt: Date.now() + ACP_FORK_CAPABILITY_TTL_MS,
		});
	}

	async listModels(context?: { cwd: string }): Promise<ProviderModelInfo[]> {
		return this.inspectModelCatalog(context?.cwd);
	}

	// fallow-ignore-next-line unused-class-member -- Invoked through AgentProvider by explicit capability discovery.
	async discoverCapabilities(context: { cwd: string }) {
		const { initialized, configOptions, modes } = await this.inspectMetadata(
			context.cwd,
		);
		return discoverAcpProviderCapabilities({
			providerId: this.providerId,
			cwd: context.cwd,
			initialized,
			configOptions,
			modes,
		});
	}

	// fallow-ignore-next-line unused-class-member -- Invoked through AgentProvider by explicit provider refresh.
	async resolveForkCapability(context?: {
		cwd: string;
	}): Promise<ProviderForkCapability | undefined> {
		this.assertRuntimeActive();
		const cwd = context?.cwd ?? this.options.discoveryCwd ?? process.cwd();
		const key = declaredPathKey(cwd);
		const cached = this.forkCapabilityCache.get(key);
		if (cached?.expiresAt && cached.expiresAt > Date.now()) {
			return cached.value;
		}
		if (cached) this.forkCapabilityCache.delete(key);
		const existingProbe = this.forkCapabilityProbes.get(key);
		if (existingProbe) return existingProbe;
		const pending = (async () => {
			const { initialized } = await this.inspectMetadata(cwd);
			const value = initialized.agentCapabilities?.sessionCapabilities?.fork
				? ({
						kind: "exact",
						wholeSession: true,
						throughMessage: false,
					} satisfies ProviderForkCapability)
				: undefined;
			this.rememberForkCapability(cwd, value);
			return value;
		})().finally(() => {
			if (this.forkCapabilityProbes.get(key) === pending) {
				this.forkCapabilityProbes.delete(key);
			}
		});
		this.forkCapabilityProbes.set(key, pending);
		return pending;
	}

	// fallow-ignore-next-line unused-class-member -- Called through AgentProvider by dbRoutes after capability negotiation.
	async forkSession(params: ForkSessionParams): Promise<ForkSessionResult> {
		this.assertRuntimeActive();
		if (params.cutoff) {
			throw new Error("ACP session/fork only supports whole-session forks");
		}
		const timeouts = acpTimeouts(this.options);
		const deadline = createInspectionDeadline(
			timeouts.inspectionMs + timeouts.forkMs,
			"session fork inspection",
		);
		let inspection: AcpInspectionConnection | null = null;
		const hostCwd = params.cwd ?? this.options.discoveryCwd ?? process.cwd();
		const providerCwd = acpAdapter(this.options).providerPath(hostCwd, hostCwd);
		try {
			inspection = await createInspectionConnection(
				this.options,
				hostCwd,
				deadline.signal,
			);
			const { connection } = inspection;
			const initialized = await initializeInspection(
				inspection,
				timeouts.initializeMs,
			);
			if (!initialized.agentCapabilities?.sessionCapabilities?.fork) {
				this.rememberForkCapability(hostCwd, undefined);
				throw new Error("The ACP agent did not advertise session/fork support");
			}
			const result = await runInspectionPhase(
				inspection,
				"session fork",
				timeouts.forkMs,
				() =>
					connection.unstable_forkSession({
						sessionId: params.sessionId,
						cwd: providerCwd,
						mcpServers: [],
					}),
			);
			this.rememberForkCapability(hostCwd, {
				kind: "exact",
				wholeSession: true,
				throughMessage: false,
			});
			return { sessionId: result.sessionId };
		} finally {
			if (inspection) await inspection.cleanup(deadline.signal.aborted);
			deadline.clear();
		}
	}

	query(params: AgentQueryParams): AgentSession {
		this.assertRuntimeActive();
		if (!acpModelVisible(params.model, this.options.modelFilter)) {
			throw new Error(
				`Model ${JSON.stringify(params.model)} is excluded by Hlid's ACP model visibility`,
			);
		}
		return new AcpSession(this.options, params, (signal) =>
			this.acquireForegroundPrompt(params.cwd, signal),
		);
	}
}

async function createInspectionConnection(
	options: AcpProviderOptions,
	cwd = options.discoveryCwd ?? process.cwd(),
	signal?: AbortSignal,
): Promise<{
	child: ChildProcessWithoutNullStreams;
	connection: ClientSideConnection;
	stderr: () => string;
	signal?: AbortSignal;
	cleanup: (immediate?: boolean) => Promise<void>;
}> {
	const timeouts = acpTimeouts(options);
	const providerEnv = await runAcpPhase({
		phase: "inspection preparation",
		timeoutMs: timeouts.preparationMs,
		signal,
		run: () => resolveAcpEnv(options.env),
	});
	const processEnvironment = await acquireAcpProcessEnvironment({
		provider: options,
		environment: providerEnv,
		phase: "inspection process environment preparation",
		timeoutMs: timeouts.preparationMs,
		signal,
	});
	let started: AcpStartedProcess;
	try {
		started = await startAcpProcess({
			provider: options,
			cwd,
			env: processEnvironment.environment,
			signal,
		});
	} catch (error) {
		await processEnvironment.release();
		throw error;
	}
	const { child } = started;
	const releaseProcessEnvironment = () => {
		void processEnvironment.release().catch(() => {});
	};
	child.once("error", releaseProcessEnvironment);
	child.once("exit", releaseProcessEnvironment);
	if (child.exitCode !== null || child.signalCode !== null) {
		releaseProcessEnvironment();
	}
	try {
		const stream = ndJsonStream(
			Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
		);
		const connection = new ClientSideConnection(
			() => ({
				requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
				sessionUpdate: () => {},
			}),
			stream,
		);
		let cleanupPromise: Promise<void> | null = null;
		return {
			child,
			connection,
			stderr: started.stderr,
			signal,
			cleanup: (immediate = signal?.aborted ?? false) => {
				cleanupPromise ??= Promise.allSettled([
					processEnvironment.release(),
					started.terminate(timeouts.terminateGraceMs, immediate),
				]).then(() => undefined);
				return cleanupPromise;
			},
		};
	} catch (error) {
		await Promise.allSettled([
			processEnvironment.release(),
			started.terminate(timeouts.terminateGraceMs, true),
		]);
		throw appendAcpStderr(error, started.stderr());
	}
}

type AcpInspectionConnection = Awaited<
	ReturnType<typeof createInspectionConnection>
>;

function runInspectionPhase<T>(
	inspection: AcpInspectionConnection,
	phase: string,
	timeoutMs: number,
	run: () => T | Promise<T>,
): Promise<T> {
	return runAcpPhase({
		phase,
		timeoutMs,
		signal: inspection.signal,
		run,
	}).catch((error) => {
		throw appendAcpStderr(error, inspection.stderr());
	});
}

function initializeInspection(
	inspection: AcpInspectionConnection,
	timeoutMs: number,
): Promise<InitializeResponse> {
	return runInspectionPhase(inspection, "initialize", timeoutMs, () =>
		inspection.connection.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
			clientInfo: { name: "Hlid", version: "1" },
		}),
	);
}

async function releaseInspectionSession(input: {
	inspection: AcpInspectionConnection;
	initialized: InitializeResponse | null;
	sessionId: string;
	timeoutMs: number;
	phase: string;
}): Promise<void> {
	const sessionCapabilities =
		input.initialized?.agentCapabilities?.sessionCapabilities;
	if (sessionCapabilities?.delete) {
		await runInspectionPhase(
			input.inspection,
			`${input.phase} deletion`,
			input.timeoutMs,
			() =>
				input.inspection.connection.deleteSession({
					sessionId: input.sessionId,
				}),
		).catch(() => {});
	} else if (sessionCapabilities?.close) {
		await runInspectionPhase(
			input.inspection,
			`${input.phase} close`,
			input.timeoutMs,
			() =>
				input.inspection.connection.closeSession({
					sessionId: input.sessionId,
				}),
		).catch(() => {});
	}
}

function createInspectionDeadline(
	timeoutMs: number,
	phase: string,
	externalSignal?: AbortSignal,
): {
	signal: AbortSignal;
	clear: () => void;
} {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(
			new AcpPhaseError(phase, `timed out after ${timeoutMs}ms`),
		);
	}, timeoutMs);
	timer.unref?.();
	const onAbort = () => {
		controller.abort(
			externalSignal?.reason ??
				new AcpPhaseError(phase, "cancelled by the caller"),
		);
	};
	if (externalSignal?.aborted) onAbort();
	else externalSignal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		clear: () => {
			clearTimeout(timer);
			externalSignal?.removeEventListener("abort", onAbort);
		},
	};
}

function withoutModelEfforts(model: ProviderModelInfo): ProviderModelInfo {
	const { efforts: _efforts, ...original } = model;
	return original;
}

function effortLevelsForOptions(
	options: SessionConfigOption[],
): ProviderEffortInfo[] {
	const thought = configOption(
		options,
		"thought_level",
		/thought|reason|effort/i,
	);
	if (thought?.type !== "select") return [];
	return selectOptions(thought).map((effort) => ({
		value: effort.value,
		label: effort.label,
		...(effort.description ? { desc: effort.description } : {}),
		...(effort.isDefault !== undefined ? { isDefault: effort.isDefault } : {}),
	}));
}

async function inspectModelEfforts(input: {
	inspection: AcpInspectionConnection;
	sessionId: string;
	initialOptions: SessionConfigOption[];
	initialModes: SessionModeState | null;
	modelFilter?: AcpModelVisibilityFilter;
	timeouts: AcpLifecycleTimeouts;
	inspectionStartedAt: number;
}): Promise<{ models: ProviderModelInfo[]; forceCleanup: boolean }> {
	const initialSnapshot = sessionConfigSnapshot(
		input.initialOptions,
		input.initialModes,
		input.modelFilter,
	);
	const originalModels = initialSnapshot.models ?? [];
	const modelOption = configOption(input.initialOptions, "model", /model/i);
	if (modelOption?.type !== "select" || originalModels.length === 0) {
		return { models: originalModels, forceCleanup: false };
	}

	const seenModels = new Set<string>();
	const candidates = originalModels
		.filter((model) => {
			if (model.value === initialSnapshot.activeModel) return false;
			if (seenModels.has(model.value)) return false;
			seenModels.add(model.value);
			return true;
		})
		.slice(0, MAX_ACP_MODEL_EFFORT_PROBES);
	const observedEfforts = new Map<string, ProviderEffortInfo[]>();
	for (const [index, model] of candidates.entries()) {
		if (input.inspection.signal?.aborted) break;
		const remainingInspectionMs = Math.max(
			1,
			input.timeouts.inspectionMs -
				(Date.now() - input.inspectionStartedAt) -
				input.timeouts.terminateGraceMs,
		);
		const remainingModels = candidates.length - index;
		const timeoutMs = Math.max(
			1,
			Math.min(
				input.timeouts.configMs,
				MAX_ACP_MODEL_EFFORT_PROBE_MS,
				Math.floor(remainingInspectionMs / Math.max(1, remainingModels)),
			),
		);
		try {
			const response = await runInspectionPhase(
				input.inspection,
				`model effort inspection for ${JSON.stringify(model.value)}`,
				timeoutMs,
				() =>
					input.inspection.connection.setSessionConfigOption({
						sessionId: input.sessionId,
						configId: modelOption.id,
						value: model.value,
					}),
			);
			if (!response) {
				return { models: originalModels, forceCleanup: true };
			}
			const activeModel = configOption(
				response.configOptions,
				"model",
				/model/i,
			);
			if (
				activeModel?.type !== "select" ||
				activeModel.currentValue !== model.value
			) {
				continue;
			}
			const efforts = effortLevelsForOptions(response.configOptions).map(
				(effort) => {
					if (model.value === initialSnapshot.activeModel) return effort;
					const { isDefault: _isDefault, ...advertised } = effort;
					return advertised;
				},
			);
			observedEfforts.set(model.value, efforts);
		} catch (error) {
			if (causedByRequestError(error)) continue;
			// A rejected request leaves this row unknown; a timeout can also leave a
			// late mutation in flight. Only a completed JSON-RPC rejection is safe to
			// continue past; otherwise retire the throwaway process immediately and
			// retain only the original, already-authoritative metadata.
			return { models: originalModels, forceCleanup: true };
		}
	}
	if (input.inspection.signal?.aborted) {
		return { models: originalModels, forceCleanup: true };
	}

	return {
		models: originalModels.map((model) => {
			const efforts = observedEfforts.get(model.value);
			if (efforts === undefined) return model;
			const original = withoutModelEfforts(model);
			return efforts.length ? { ...original, efforts } : original;
		}),
		forceCleanup: false,
	};
}

async function inspectAcpModelCatalog(
	options: AcpProviderOptions,
	cwd = options.discoveryCwd ?? process.cwd(),
	signal?: AbortSignal,
): Promise<ProviderModelInfo[]> {
	const inspectionStartedAt = Date.now();
	const providerCwd = acpAdapter(options).providerPath(cwd, cwd);
	const timeouts = acpTimeouts(options);
	const deadline = createInspectionDeadline(
		timeouts.inspectionMs,
		"model catalog inspection",
		signal,
	);
	let inspection: AcpInspectionConnection | null = null;
	let initialized: InitializeResponse | null = null;
	let createdSessionId: string | null = null;
	let forceCleanup = false;
	try {
		inspection = await createInspectionConnection(
			options,
			cwd,
			deadline.signal,
		);
		initialized = await initializeInspection(inspection, timeouts.initializeMs);
		const created = await runInspectionPhase(
			inspection,
			"session creation",
			timeouts.sessionMs,
			() =>
				inspection?.connection.newSession({
					cwd: providerCwd,
					mcpServers: [],
				}),
		);
		if (!created) throw new Error("ACP agent returned no metadata session");
		createdSessionId = created.sessionId;
		const result = await inspectModelEfforts({
			inspection,
			sessionId: createdSessionId,
			initialOptions: created.configOptions ?? [],
			initialModes: created.modes ?? null,
			modelFilter: options.modelFilter,
			timeouts,
			inspectionStartedAt,
		});
		forceCleanup = result.forceCleanup;
		return result.models;
	} finally {
		if (
			inspection &&
			createdSessionId &&
			!forceCleanup &&
			!deadline.signal.aborted
		) {
			await releaseInspectionSession({
				inspection,
				initialized,
				sessionId: createdSessionId,
				timeoutMs: timeouts.sessionMs,
				phase: "model catalog session",
			});
		}
		if (inspection) {
			await inspection.cleanup(forceCleanup || deadline.signal.aborted);
		}
		deadline.clear();
	}
}

async function inspectAcpMetadata(
	options: AcpProviderOptions,
	cwd = options.discoveryCwd ?? process.cwd(),
	signal?: AbortSignal,
): Promise<AcpMetadataInspection> {
	const providerCwd = acpAdapter(options).providerPath(cwd, cwd);
	const timeouts = acpTimeouts(options);
	const deadline = createInspectionDeadline(
		timeouts.inspectionMs,
		"metadata inspection",
		signal,
	);
	let inspection: AcpInspectionConnection | null = null;
	let initialized: InitializeResponse | null = null;
	let createdSessionId: string | null = null;
	try {
		inspection = await createInspectionConnection(
			options,
			cwd,
			deadline.signal,
		);
		const { connection } = inspection;
		initialized = await initializeInspection(inspection, timeouts.initializeMs);
		const created = await runInspectionPhase(
			inspection,
			"session creation",
			timeouts.sessionMs,
			() =>
				connection.newSession({
					cwd: providerCwd,
					mcpServers: [],
				}),
		);
		createdSessionId = created.sessionId;
		return {
			initialized,
			configOptions: created.configOptions ?? [],
			modes: created.modes ?? null,
		};
	} finally {
		if (inspection && createdSessionId && !deadline.signal.aborted) {
			await releaseInspectionSession({
				inspection,
				initialized,
				sessionId: createdSessionId,
				timeoutMs: timeouts.sessionMs,
				phase: "metadata session",
			});
		}
		if (inspection) await inspection.cleanup(deadline.signal.aborted);
		deadline.clear();
	}
}

export async function inspectAcpAgent(
	options: AcpProviderOptions,
	methodId?: string,
	signal?: AbortSignal,
): Promise<InitializeResponse> {
	const timeouts = acpTimeouts(options);
	const deadline = createInspectionDeadline(
		methodId
			? timeouts.preparationMs +
					timeouts.spawnMs +
					timeouts.initializeMs +
					timeouts.authenticationMs
			: timeouts.inspectionMs,
		methodId ? "authenticated inspection" : "agent inspection",
		signal,
	);
	let inspection: AcpInspectionConnection | null = null;
	try {
		inspection = await createInspectionConnection(
			options,
			options.discoveryCwd ?? process.cwd(),
			deadline.signal,
		);
		const { connection } = inspection;
		const initialized = await initializeInspection(
			inspection,
			timeouts.initializeMs,
		);
		if (methodId) {
			await runInspectionPhase(
				inspection,
				"authentication",
				timeouts.authenticationMs,
				() => connection.authenticate({ methodId }),
			);
		}
		return initialized;
	} finally {
		if (inspection) await inspection.cleanup(deadline.signal.aborted);
		deadline.clear();
	}
}

export type AcpProviderNativeSession = {
	sessionId: string;
	title?: string | null;
	updatedAt?: string | null;
};

export type AcpProviderNativeSessionPage = {
	sessions: AcpProviderNativeSession[];
	/** True only when this connection also advertises load or resume support. */
	canImportSessions: boolean;
	nextCursor?: string;
};

export class AcpSessionListUnsupportedError extends Error {
	constructor() {
		super("The ACP agent does not advertise session/list support");
		this.name = "AcpSessionListUnsupportedError";
	}
}

export class AcpSessionImportUnsupportedError extends Error {
	constructor() {
		super("The ACP agent can list sessions but cannot load or resume them");
		this.name = "AcpSessionImportUnsupportedError";
	}
}

const MAX_ACP_SESSION_PAGE_SIZE = 100;
const MAX_ACP_SESSION_SCAN_PAGES = 25;
const MAX_ACP_SESSION_ID_CHARS = 512;
const MAX_ACP_SESSION_TITLE_CHARS = 1_000;
const MAX_ACP_SESSION_CURSOR_CHARS = 2_048;
const MAX_ACP_SESSION_PATH_CHARS = 4_096;
const MAX_ACP_SESSION_TIMESTAMP_CHARS = 128;

function providerSessionString(
	value: unknown,
	label: string,
	limit: number,
	allowEmpty = false,
): string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		value.length > limit
	) {
		throw new Error(`ACP session/list returned an invalid ${label}`);
	}
	return value;
}

/** @internal Exported for syntax-sensitive workspace filtering tests. */
export function workspacePathIdentity(value: string): string {
	// These are provider paths, so their syntax determines case sensitivity.
	// A WSL provider's POSIX path remains case-sensitive on a Windows host.
	const windowsSyntax =
		/^[a-z]:(?:[\\/]|$)/i.test(value) ||
		value.startsWith("\\\\") ||
		value.startsWith("//");
	const normalized = windowsSyntax
		? value.replaceAll("\\", "/").replace(/\/+$/, "") || "/"
		: value.replace(/\/+$/, "") || "/";
	return windowsSyntax ? normalized.toLowerCase() : normalized;
}

async function readAcpProviderSessionPage(
	inspection: AcpInspectionConnection,
	cwd: string,
	timeouts: AcpLifecycleTimeouts,
	canImportSessions: boolean,
	cursor?: string,
): Promise<AcpProviderNativeSessionPage> {
	providerSessionString(cwd, "workspace path", MAX_ACP_SESSION_PATH_CHARS);
	if (cursor !== undefined) {
		providerSessionString(
			cursor,
			"pagination cursor",
			MAX_ACP_SESSION_CURSOR_CHARS,
		);
	}
	const page = await runInspectionPhase(
		inspection,
		"provider session listing",
		timeouts.sessionMs,
		() =>
			inspection.connection.listSessions({
				cwd,
				...(cursor !== undefined ? { cursor } : {}),
			}),
	);
	if (page.sessions.length > MAX_ACP_SESSION_PAGE_SIZE) {
		throw new Error("ACP session/list returned an oversized session page");
	}
	const workspace = workspacePathIdentity(cwd);
	const seen = new Set<string>();
	const sessions: AcpProviderNativeSession[] = [];
	for (const item of page.sessions) {
		const sessionId = providerSessionString(
			item.sessionId,
			"session id",
			MAX_ACP_SESSION_ID_CHARS,
		);
		const itemCwd = providerSessionString(
			item.cwd,
			"session workspace path",
			MAX_ACP_SESSION_PATH_CHARS,
		);
		// The request is scoped to one workspace. Never surface metadata for a
		// provider response that falls outside that exact workspace selection.
		if (workspacePathIdentity(itemCwd) !== workspace || seen.has(sessionId)) {
			continue;
		}
		seen.add(sessionId);
		let title: string | null | undefined;
		if (item.title !== undefined && item.title !== null) {
			title = providerSessionString(
				item.title,
				"session title",
				MAX_ACP_SESSION_TITLE_CHARS,
				true,
			);
		} else {
			title = item.title;
		}
		let updatedAt: string | null | undefined;
		if (item.updatedAt !== undefined && item.updatedAt !== null) {
			updatedAt = providerSessionString(
				item.updatedAt,
				"session timestamp",
				MAX_ACP_SESSION_TIMESTAMP_CHARS,
			);
			if (Number.isNaN(Date.parse(updatedAt))) {
				throw new Error(
					"ACP session/list returned an invalid session timestamp",
				);
			}
		} else {
			updatedAt = item.updatedAt;
		}
		sessions.push({ sessionId, title, updatedAt });
	}
	let nextCursor: string | undefined;
	if (page.nextCursor !== undefined && page.nextCursor !== null) {
		nextCursor = providerSessionString(
			page.nextCursor,
			"pagination cursor",
			MAX_ACP_SESSION_CURSOR_CHARS,
		);
	}
	return {
		sessions,
		canImportSessions,
		...(nextCursor ? { nextCursor } : {}),
	};
}

function canImportAcpProviderSessions(
	initialized: InitializeResponse,
): boolean {
	return Boolean(
		initialized.agentCapabilities?.loadSession ||
			initialized.agentCapabilities?.sessionCapabilities?.resume,
	);
}

async function initializeAcpSessionCatalogInspection(
	inspection: AcpInspectionConnection,
	initializeTimeoutMs: number,
): Promise<InitializeResponse> {
	const initialized = await initializeInspection(
		inspection,
		initializeTimeoutMs,
	);
	if (!initialized.agentCapabilities?.sessionCapabilities?.list) {
		throw new AcpSessionListUnsupportedError();
	}
	return initialized;
}

/**
 * Read one provider-owned session metadata page for exactly one workspace.
 * This does not load, resume, fork, import, or inspect any session transcript.
 */
export async function listAcpProviderSessions(
	options: AcpProviderOptions,
	cwd: string,
	cursor?: string,
): Promise<AcpProviderNativeSessionPage> {
	providerSessionString(cwd, "workspace path", MAX_ACP_SESSION_PATH_CHARS);
	if (cursor !== undefined) {
		providerSessionString(
			cursor,
			"pagination cursor",
			MAX_ACP_SESSION_CURSOR_CHARS,
		);
	}
	const timeouts = acpTimeouts(options);
	const providerCwd = acpAdapter(options).providerPath(cwd, cwd);
	const deadline = createInspectionDeadline(
		timeouts.inspectionMs + timeouts.sessionMs,
		"provider session listing",
	);
	let inspection: AcpInspectionConnection | null = null;
	try {
		inspection = await createInspectionConnection(
			options,
			cwd,
			deadline.signal,
		);
		const initialized = await initializeAcpSessionCatalogInspection(
			inspection,
			timeouts.initializeMs,
		);
		return await readAcpProviderSessionPage(
			inspection,
			providerCwd,
			timeouts,
			canImportAcpProviderSessions(initialized),
			cursor,
		);
	} finally {
		if (inspection) await inspection.cleanup(deadline.signal.aborted);
		deadline.clear();
	}
}

/**
 * Revalidate one exact provider-owned session against a bounded catalog scan.
 * All pages share one initialized inspection process and no transcript is loaded.
 */
export async function findAcpProviderSession(
	options: AcpProviderOptions,
	cwd: string,
	providerSessionId: string,
): Promise<AcpProviderNativeSession | undefined> {
	providerSessionString(cwd, "workspace path", MAX_ACP_SESSION_PATH_CHARS);
	providerSessionString(
		providerSessionId,
		"session id",
		MAX_ACP_SESSION_ID_CHARS,
	);
	const timeouts = acpTimeouts(options);
	const providerCwd = acpAdapter(options).providerPath(cwd, cwd);
	const deadline = createInspectionDeadline(
		timeouts.inspectionMs + timeouts.sessionMs,
		"provider session validation",
	);
	let inspection: AcpInspectionConnection | null = null;
	try {
		inspection = await createInspectionConnection(
			options,
			cwd,
			deadline.signal,
		);
		const initialized = await initializeAcpSessionCatalogInspection(
			inspection,
			timeouts.initializeMs,
		);
		if (!canImportAcpProviderSessions(initialized)) {
			throw new AcpSessionImportUnsupportedError();
		}
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		for (
			let pageIndex = 0;
			pageIndex < MAX_ACP_SESSION_SCAN_PAGES;
			pageIndex += 1
		) {
			const page = await readAcpProviderSessionPage(
				inspection,
				providerCwd,
				timeouts,
				true,
				cursor,
			);
			const match = page.sessions.find(
				(session) => session.sessionId === providerSessionId,
			);
			if (match) return match;
			if (!page.nextCursor) return undefined;
			if (seenCursors.has(page.nextCursor)) {
				throw new Error("ACP session/list returned a repeated cursor");
			}
			seenCursors.add(page.nextCursor);
			cursor = page.nextCursor;
		}
		throw new Error(
			`ACP session/list exceeded the ${MAX_ACP_SESSION_SCAN_PAGES}-page validation limit`,
		);
	} finally {
		if (inspection) await inspection.cleanup(deadline.signal.aborted);
		deadline.clear();
	}
}
