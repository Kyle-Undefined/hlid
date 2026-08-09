import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { win32 } from "node:path";
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
	PROTOCOL_VERSION,
	type SessionConfigOption,
	type SessionModeState,
	type SessionUpdate,
	type ToolCallContent,
	type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { describeHlidToolLoading } from "../lib/hlidContext";
import { legacyProjectMcpAdapter } from "../lib/mcpConfig";
import {
	acpCmdShimCommand,
	acpLaunchUsesShell,
	findAcpExecutable,
} from "./acpExecutable";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	ForkSessionParams,
	ForkSessionResult,
	McpServerStatus,
	ProviderForkCapability,
	ProviderModelInfo,
	SlashCommand,
} from "./agentProvider";
import { childIsRunning, waitForChildExit } from "./childProcessLifecycle";
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

function spawnWindowsTaskkill(pid: number) {
	const systemRoot =
		process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
	return spawn(
		win32.join(systemRoot, "System32", "taskkill.exe"),
		["/PID", String(pid), "/T", "/F"],
		{ stdio: "ignore", windowsHide: true },
	);
}

async function terminateWindowsProcessTree(
	pid: number,
	timeoutMs: number,
): Promise<boolean> {
	const killer = spawnWindowsTaskkill(pid);
	let failed = false;
	killer.once("error", () => {
		failed = true;
	});
	if (await waitForChildExit(killer, timeoutMs)) {
		return !failed && killer.exitCode === 0;
	}
	killer.kill();
	return false;
}

function initiateOwnedChildTermination(
	child: ChildProcessWithoutNullStreams,
): void {
	if (!childIsRunning(child)) return;
	child.stdin.end();
	const pid = child.pid;
	if (process.platform === "win32" && pid) {
		const killer = spawnWindowsTaskkill(pid);
		killer.once("error", () => {
			child.kill("SIGKILL");
		});
		killer.once("close", (code) => {
			if (code !== 0 && childIsRunning(child)) child.kill("SIGKILL");
		});
		killer.unref();
		return;
	}
	try {
		if (pid) process.kill(-pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

async function terminateOwnedChild(
	child: ChildProcessWithoutNullStreams,
	graceMs: number,
	immediate = false,
): Promise<void> {
	if (!childIsRunning(child)) return;
	if (immediate) {
		initiateOwnedChildTermination(child);
		if (await waitForChildExit(child, graceMs)) return;
	} else {
		child.stdin.end();
		if (await waitForChildExit(child, Math.min(100, graceMs))) return;
	}
	const pid = child.pid;
	if (process.platform === "win32" && pid) {
		const killedTree = await terminateWindowsProcessTree(pid, graceMs).catch(
			() => false,
		);
		if (killedTree && (await waitForChildExit(child, graceMs))) return;
		child.kill("SIGKILL");
		await waitForChildExit(child, graceMs);
		return;
	}
	try {
		if (pid) process.kill(-pid, "SIGTERM");
		else child.kill("SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	if (await waitForChildExit(child, graceMs)) return;
	try {
		if (pid) process.kill(-pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
	await waitForChildExit(child, graceMs);
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

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.pid !== undefined) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			child.off("spawn", onSpawn);
			child.off("error", onError);
		};
		const onSpawn = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}

type StartedAcpProcess = {
	child: ChildProcessWithoutNullStreams;
	stderr: () => string;
};

async function startAcpProcess(options: {
	provider: AcpProviderOptions;
	cwd: string;
	env: Record<string, string>;
	signal?: AbortSignal;
}): Promise<StartedAcpProcess> {
	const timeouts = acpTimeouts(options.provider);
	const effectiveEnv = { ...process.env, ...options.env };
	const resolvedCommand = await runAcpPhase({
		phase: "executable resolution",
		timeoutMs: timeouts.preparationMs,
		signal: options.signal,
		run: () =>
			findAcpExecutable(options.provider.command, {
				cwd: options.cwd,
				env: effectiveEnv,
			}),
	});
	if (!resolvedCommand) {
		throw new AcpPhaseError(
			"executable resolution",
			`failed: ${options.provider.command} is not installed`,
		);
	}
	const args = options.provider.args ?? [];
	const useShell = acpLaunchUsesShell(resolvedCommand);
	const launchCommand = useShell
		? acpCmdShimCommand(resolvedCommand, args)
		: resolvedCommand;
	const launchArgs = useShell ? [] : args;
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(launchCommand, launchArgs, {
			cwd: options.cwd,
			env: effectiveEnv,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
			shell: useShell,
		});
	} catch (error) {
		throw new AcpPhaseError("process spawn", `failed: ${errorText(error)}`, {
			cause: error,
		});
	}
	let capturedStderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		capturedStderr = `${capturedStderr}${chunk}`.slice(-8_000);
	});
	try {
		await runAcpPhase({
			phase: "process spawn",
			timeoutMs: timeouts.spawnMs,
			signal: options.signal,
			run: () => waitForSpawn(child),
		});
		return { child, stderr: () => capturedStderr };
	} catch (error) {
		await terminateOwnedChild(child, timeouts.terminateGraceMs);
		throw appendAcpStderr(error, capturedStderr);
	}
}

export type AcpProviderOptions = {
	id: string;
	label: string;
	command: string;
	args?: string[];
	env?:
		| Record<string, string>
		| (() => Record<string, string> | Promise<Record<string, string>>);
	/** Translate Hlid's persisted model id into the ACP agent's config value. */
	requestModel?: (model: string) => string;
	/** Workspace used for provider-owned metadata sessions. */
	discoveryCwd?: string;
	/** Provider-neutral lifecycle budgets. Primarily injectable for tests. */
	timeouts?: Partial<AcpLifecycleTimeouts>;
	/** Last registry-owned availability result, used before the first live check. */
	initialAvailability?: { available: boolean; reason?: string };
};

async function resolveAcpEnv(
	env: AcpProviderOptions["env"],
): Promise<Record<string, string>> {
	return typeof env === "function" ? await env() : (env ?? {});
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
): AgentEvent[] {
	switch (update.sessionUpdate) {
		case "agent_message_chunk": {
			const text = textFromContent(update.content);
			return text == null ? [] : [{ type: "text_delta", text }];
		}
		case "agent_thought_chunk": {
			const text = textFromContent(update.content);
			return text == null ? [] : [{ type: "summary", text }];
		}
		case "tool_call": {
			const toolCall = mergeToolCallUpdate(
				toolCalls?.get(update.toolCallId),
				update,
			);
			toolCalls?.set(update.toolCallId, toolCall);
			return [
				{
					type: "tool_start",
					toolId: update.toolCallId,
					name: acpToolName(toolCall),
					input: acpToolInput(toolCall),
				},
				...(toolCall.status === "completed" || toolCall.status === "failed"
					? [
							{
								type: "tool_result" as const,
								toolId: update.toolCallId,
								content: toolResultText(toolCall),
								isError: toolCall.status === "failed",
							},
						]
					: []),
			];
		}
		case "tool_call_update": {
			const toolCall = mergeToolCallUpdate(
				toolCalls?.get(update.toolCallId),
				update,
			);
			toolCalls?.set(update.toolCallId, toolCall);
			if (toolCall.status !== "completed" && toolCall.status !== "failed")
				return [];
			return [
				{
					type: "tool_result",
					toolId: update.toolCallId,
					content: toolResultText(toolCall),
					isError: toolCall.status === "failed",
				},
			];
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

function selectOptions(option: SessionConfigOption): ProviderModelInfo[] {
	if (option.type !== "select") return [];
	return option.options.flatMap((item) =>
		"group" in item
			? item.options.map((nested) => ({
					value: nested.value,
					label: nested.name,
					description: nested.description ?? undefined,
					isDefault: nested.value === option.currentValue,
				}))
			: [
					{
						value: item.value,
						label: item.name,
						description: item.description ?? undefined,
						isDefault: item.value === option.currentValue,
					},
				],
	);
}

function configOption(
	options: SessionConfigOption[],
	category: string,
	namePattern: RegExp,
): SessionConfigOption | undefined {
	return (
		options.find((option) => option.category === category) ??
		options.find((option) => namePattern.test(`${option.id} ${option.name}`))
	);
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
	suppressError: boolean;
};

type AcpMetadataInspection = {
	initialized: InitializeResponse;
	configOptions: SessionConfigOption[];
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
	private initPromise: Promise<void> | null = null;
	private cleanupPromise: Promise<void> | null = null;
	private cleanupChild: ChildProcessWithoutNullStreams | null = null;
	private activePrompt: ActiveAcpPrompt | null = null;
	private cancelled = false;
	private turns = 0;
	private commands: SlashCommand[] = [];
	private closeAfterTurn = false;
	private canDeleteSession = false;
	private canCloseSession = false;
	private canLoadSession = false;
	private canResumeSession = false;
	private allowInterruptedResumeFallback = false;
	private loadingSessionReplay = false;
	private modes: SessionModeState | null = null;
	private configOptions: SessionConfigOption[] = [];
	private initialConfigValues = new Map<string, string>();
	private implementationModeId: string | null = null;
	private implementationConfigModeValue: string | null = null;
	private readonly toolCalls = new Map<string, ToolCallUpdate>();
	private approvedHtmlPlanToolIds = new Set<string>();
	private htmlPlanReady = false;
	private nativePlanText = "";
	private lastAgentMessageId: string | null = null;
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
	): Promise<void> {
		if (option.type !== "select" || !this.connection || !this.sessionId) return;
		const response = await this.runPhase(phase, timeoutMs, () =>
			this.connection?.setSessionConfigOption({
				sessionId: this.sessionId ?? "",
				configId: option.id,
				value,
			}),
		);
		if (response) this.configOptions = response.configOptions;
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
	): void {
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
			this.events.push({
				type: "done",
				turns: 0,
				durationMs: Date.now() - active.startedAt,
				stopReason: "cancelled",
			});
		}
		this.resetAfterRuntimeStop(previousSessionId, canReconnect);
	}

	private async runLiveControl(run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (error) {
			await this.retireRuntimeAfterControlFailure(error);
			throw error;
		}
	}

	private async setConfigValue(
		category: "model" | "thought_level",
		value: string | undefined,
		resetToInitial = false,
	): Promise<void> {
		if (!this.connection || !this.sessionId) return;
		const option = configOption(
			this.configOptions,
			category,
			category === "model" ? /model/i : /thought|reason|effort/i,
		);
		if (!option || option.type !== "select") return;
		if (value === undefined && !resetToInitial) return;
		const resolvedValue = value ?? this.initialConfigValues.get(option.id);
		if (resolvedValue === undefined) return;
		await this.applyConfigOption(
			option,
			resolvedValue,
			`${category === "model" ? "model" : "thought-level"} configuration`,
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
			if (immediate && this.cleanupChild) {
				initiateOwnedChildTermination(this.cleanupChild);
			}
			return this.cleanupPromise;
		}
		const child = this.process;
		if (!child) return;
		this.expectedProcessExits.add(child);
		this.process = null;
		this.connection = null;
		this.cleanupChild = child;
		const pending = terminateOwnedChild(
			child,
			this.timeouts.terminateGraceMs,
			immediate,
		).finally(() => {
			if (this.cleanupPromise === pending) {
				this.cleanupPromise = null;
				this.cleanupChild = null;
			}
		});
		this.cleanupPromise = pending;
		return pending;
	}

	private clearRuntimeState(): void {
		this.connection = null;
		this.process = null;
		this.sessionId = null;
		this.initPromise = null;
		this.canDeleteSession = false;
		this.canCloseSession = false;
		this.canLoadSession = false;
		this.canResumeSession = false;
		this.loadingSessionReplay = false;
		this.modes = null;
		this.configOptions = [];
		this.initialConfigValues.clear();
		this.implementationModeId = null;
		this.implementationConfigModeValue = null;
		this.toolCalls.clear();
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
		const [providerEnv, obsidianStatus] = await this.runPhase(
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
		);
		if (
			!this.mcpServers.some((server) => server.name === HLID_AGENT_NAMESPACE)
		) {
			this.mcpServers.unshift({
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
			});
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
			this.mcpServers.unshift({
				name: OBSIDIAN_AGENT_NAMESPACE,
				...obsidianMcpProcessCommand(),
			});
			this.mcpStatuses.unshift({
				name: OBSIDIAN_AGENT_NAMESPACE,
				status: "pending",
				scope: "provider",
			});
		}
		const started = await startAcpProcess({
			provider: this.options,
			cwd: this.params.cwd,
			env: providerEnv,
			signal: this.runtimeAbortController.signal,
		});
		const { child } = started;
		this.process = child;
		this.stderr = started.stderr;
		child.once("error", (error) => {
			if (
				this.process === child &&
				!this.cancelled &&
				!this.expectedProcessExits.has(child)
			) {
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
				this.events.end(
					appendAcpStderr(
						new Error(`ACP agent exited with code ${code}`),
						this.stderr(),
					),
				);
			}
		});

		const client: Client = {
			requestPermission: async ({ toolCall, options }) => {
				const filePath = filePathFromToolCall(toolCall);
				const toolName = acpToolName(toolCall);
				const toolInput = acpToolInput(toolCall);
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
				const option = options.find((item) =>
					allowed
						? item.kind.startsWith("allow")
						: item.kind.startsWith("reject"),
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
			sessionUpdate: ({ update }) => {
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
				}
				if (update.sessionUpdate === "config_option_update") {
					this.configOptions = update.configOptions;
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
				const events = eventsFromUpdate(update, planEventId, this.toolCalls);
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
				for (const event of events) {
					this.events.push(event);
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
				? { additionalDirectories: this.params.additionalDirectories }
				: {};
		const sessionMcpServers = this.negotiatedMcpServers(
			initialized.agentCapabilities?.mcpCapabilities,
		);
		this.canLoadSession = Boolean(initialized.agentCapabilities?.loadSession);
		this.canResumeSession = Boolean(sessionCapabilities?.resume);
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
								cwd: this.params.cwd,
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
									cwd: this.params.cwd,
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
							cwd: this.params.cwd,
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
						cwd: this.params.cwd,
						...additionalDirectoryParams,
						mcpServers: sessionMcpServers,
					}),
			);
			({ modes, configOptions } = this.adoptCreatedSession(created));
		}
		if (!this.sessionId) {
			throw new Error("ACP session initialization returned no session id");
		}
		this.modes = modes ?? null;
		this.configOptions = configOptions ?? [];
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
		await this.setConfigValue(
			"model",
			this.params.model && this.options.requestModel
				? this.options.requestModel(this.params.model)
				: this.params.model,
		);
		await this.setConfigValue("thought_level", this.params.effort);
		await this.syncPermissionMode(this.params.permissionMode ?? "default");
		this.events.push({ type: "session_start", sessionId: this.sessionId });
	}

	async send(message: string): Promise<void> {
		await this.initialize();
		if (this.cancelled || !this.connection || !this.sessionId) return;
		if (this.activePrompt && !this.activePrompt.settled) {
			throw new Error("ACP session already has an active prompt");
		}
		const active: ActiveAcpPrompt = {
			promise: Promise.resolve(),
			startedAt: Date.now(),
			settled: false,
			suppressError: false,
		};
		active.promise = this.runPrompt(message);
		this.activePrompt = active;
		void active.promise
			.then(
				() => {
					active.settled = true;
				},
				(error) => {
					active.settled = true;
					if (!active.suppressError && !this.cancelled) {
						this.events.end(appendAcpStderr(error, this.stderr()));
					}
				},
			)
			.finally(() => {
				if (this.activePrompt === active) this.activePrompt = null;
			});
	}

	private async runPrompt(
		message: string,
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
		this.approvedHtmlPlanToolIds.clear();
		this.htmlPlanReady = false;
		this.nativePlanText = "";
		this.lastAgentMessageId = null;
		this.toolCalls.clear();
		this.turnStartCostUsd = costStartUsd;
		const response = await this.connection.prompt({
			sessionId: this.sessionId,
			prompt: [{ type: "text", text: message }],
		});
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
					costStartUsd,
					queryTurnStart,
					queryStartedMs,
					queryUsage,
				);
				return;
			}
		}
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
			this.cancelled = true;
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
		this.resetAfterRuntimeStop(previousSessionId, canReconnect);
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

	async setPermissionMode(mode: string): Promise<void> {
		if (
			mode === "default" ||
			mode === "acceptEdits" ||
			mode === "bypassPermissions" ||
			mode === "plan"
		) {
			this.params.permissionMode = mode;
			await this.runLiveControl(() => this.syncPermissionMode(mode));
		}
	}

	async setModel(model?: string): Promise<void> {
		this.params.model = model;
		await this.runLiveControl(() =>
			this.setConfigValue(
				"model",
				model && this.options.requestModel
					? this.options.requestModel(model)
					: model,
				true,
			),
		);
	}

	async setEffort(effort: string): Promise<void> {
		this.params.effort = effort;
		await this.runLiveControl(() =>
			this.setConfigValue("thought_level", effort),
		);
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
	private forkCapabilityCache:
		| { value: ProviderForkCapability | undefined; expiresAt: number }
		| undefined;
	private forkCapabilityProbe: Promise<
		ProviderForkCapability | undefined
	> | null = null;
	private metadataInspection: Promise<AcpMetadataInspection> | null = null;
	private availabilitySnapshot:
		| { available: boolean; reason?: string }
		| undefined;

	constructor(readonly options: AcpProviderOptions) {
		this.providerId = options.id;
		this.label = options.label;
		this.availabilitySnapshot = options.initialAvailability;
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
		try {
			const resolved = await runAcpPhase({
				phase: "availability check",
				timeoutMs: acpTimeouts(this.options).preparationMs,
				run: async () => {
					const providerEnv = await resolveAcpEnv(this.options.env);
					return findAcpExecutable(this.options.command, {
						cwd: this.options.discoveryCwd ?? process.cwd(),
						env: { ...process.env, ...providerEnv },
					});
				},
			});
			const result = resolved
				? { available: true }
				: {
						available: false,
						reason: `${this.options.command} is not installed`,
					};
			this.availabilitySnapshot = result;
			return result;
		} catch (error) {
			const result = { available: false, reason: errorText(error) };
			this.availabilitySnapshot = result;
			return result;
		}
	}

	// fallow-ignore-next-line unused-class-member -- Read through AgentProvider by the process-free provider catalog.
	cachedAvailability(): { available: boolean; reason?: string } | undefined {
		return this.availabilitySnapshot;
	}

	private inspectMetadata(): Promise<AcpMetadataInspection> {
		if (this.metadataInspection) return this.metadataInspection;
		const pending = inspectAcpMetadata(this.options).finally(() => {
			if (this.metadataInspection === pending) this.metadataInspection = null;
		});
		this.metadataInspection = pending;
		return pending;
	}

	async listModels(): Promise<ProviderModelInfo[]> {
		const { configOptions: options } = await this.inspectMetadata();
		const model = configOption(options, "model", /model/i);
		if (!model) return [];
		const thought = configOption(
			options,
			"thought_level",
			/thought|reason|effort/i,
		);
		const efforts = (thought ? selectOptions(thought) : []).map((effort) => ({
			value: effort.value,
			label: effort.label,
			desc: effort.description,
			isDefault: effort.isDefault,
		}));
		return selectOptions(model).map((entry) => ({
			...entry,
			...(efforts.length > 0 ? { efforts } : {}),
		}));
	}

	// fallow-ignore-next-line unused-class-member -- Invoked through AgentProvider by explicit provider refresh.
	async resolveForkCapability(): Promise<ProviderForkCapability | undefined> {
		if (
			this.forkCapabilityCache &&
			this.forkCapabilityCache.expiresAt > Date.now()
		) {
			return this.forkCapabilityCache.value;
		}
		if (this.forkCapabilityProbe) return this.forkCapabilityProbe;
		this.forkCapabilityProbe = (async () => {
			const { initialized } = await this.inspectMetadata();
			const value = initialized.agentCapabilities?.sessionCapabilities?.fork
				? ({
						kind: "exact",
						wholeSession: true,
						throughMessage: false,
					} satisfies ProviderForkCapability)
				: undefined;
			this.forkCapabilityCache = {
				value,
				expiresAt: Date.now() + 60_000,
			};
			return value;
		})().finally(() => {
			this.forkCapabilityProbe = null;
		});
		return this.forkCapabilityProbe;
	}

	// fallow-ignore-next-line unused-class-member -- Called through AgentProvider by dbRoutes after capability negotiation.
	async forkSession(params: ForkSessionParams): Promise<ForkSessionResult> {
		if (params.cutoff) {
			throw new Error("ACP session/fork only supports whole-session forks");
		}
		const timeouts = acpTimeouts(this.options);
		const deadline = createInspectionDeadline(
			timeouts.inspectionMs + timeouts.forkMs,
			"session fork inspection",
		);
		let inspection: AcpInspectionConnection | null = null;
		try {
			inspection = await createInspectionConnection(
				this.options,
				params.cwd ?? this.options.discoveryCwd ?? process.cwd(),
				deadline.signal,
			);
			const { connection } = inspection;
			const initialized = await initializeInspection(
				inspection,
				timeouts.initializeMs,
			);
			if (!initialized.agentCapabilities?.sessionCapabilities?.fork) {
				this.forkCapabilityCache = {
					value: undefined,
					expiresAt: Date.now() + 60_000,
				};
				throw new Error("The ACP agent did not advertise session/fork support");
			}
			const result = await runInspectionPhase(
				inspection,
				"session fork",
				timeouts.forkMs,
				() =>
					connection.unstable_forkSession({
						sessionId: params.sessionId,
						cwd: params.cwd ?? this.options.discoveryCwd ?? process.cwd(),
						mcpServers: [],
					}),
			);
			this.forkCapabilityCache = {
				value: {
					kind: "exact",
					wholeSession: true,
					throughMessage: false,
				},
				expiresAt: Date.now() + 60_000,
			};
			return { sessionId: result.sessionId };
		} finally {
			if (inspection) await inspection.cleanup(deadline.signal.aborted);
			deadline.clear();
		}
	}

	query(params: AgentQueryParams): AgentSession {
		return new AcpSession(this.options, params);
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
	const started = await startAcpProcess({
		provider: options,
		cwd,
		env: providerEnv,
		signal,
	});
	const { child } = started;
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
				cleanupPromise ??= terminateOwnedChild(
					child,
					timeouts.terminateGraceMs,
					immediate,
				);
				return cleanupPromise;
			},
		};
	} catch (error) {
		await terminateOwnedChild(child, timeouts.terminateGraceMs, true);
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

function createInspectionDeadline(
	timeoutMs: number,
	phase: string,
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
	return {
		signal: controller.signal,
		clear: () => clearTimeout(timer),
	};
}

async function inspectAcpMetadata(
	options: AcpProviderOptions,
): Promise<AcpMetadataInspection> {
	const cwd = options.discoveryCwd ?? process.cwd();
	const timeouts = acpTimeouts(options);
	const deadline = createInspectionDeadline(
		timeouts.inspectionMs,
		"metadata inspection",
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
					cwd,
					mcpServers: [],
				}),
		);
		createdSessionId = created.sessionId;
		return {
			initialized,
			configOptions: created.configOptions ?? [],
		};
	} finally {
		if (inspection && createdSessionId && !deadline.signal.aborted) {
			const sessionCapabilities =
				initialized?.agentCapabilities?.sessionCapabilities;
			if (sessionCapabilities?.delete) {
				await runInspectionPhase(
					inspection,
					"metadata session deletion",
					timeouts.sessionMs,
					() =>
						inspection?.connection.deleteSession({
							sessionId: createdSessionId ?? "",
						}),
				).catch(() => {});
			} else if (sessionCapabilities?.close) {
				await runInspectionPhase(
					inspection,
					"metadata session close",
					timeouts.sessionMs,
					() =>
						inspection?.connection.closeSession({
							sessionId: createdSessionId ?? "",
						}),
				).catch(() => {});
			}
		}
		if (inspection) await inspection.cleanup(deadline.signal.aborted);
		deadline.clear();
	}
}

export async function inspectAcpAgent(
	options: AcpProviderOptions,
	methodId?: string,
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
