import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveCodexExecutable } from "../lib/codexPath";
import {
	type CanonicalTokenUsage,
	canonicalizeCodexUsage,
	estimateCodexCost,
} from "../lib/codexPricing";
import { APP_DIR, toLogical } from "../lib/paths";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	McpServerStatus,
	ProviderEffortInfo,
	ProviderModelInfo,
	ProviderWindowReading,
	SendOptions,
	SlashCommand,
	SubagentSnapshot,
} from "./agentProvider";
import {
	acquireCodexAppServer,
	CodexAppServer,
	type ThreadHandler,
} from "./codexAppServer";
import type {
	CollabAgentState,
	CollabAgentStatus,
	CollabAgentTool,
	CommandExecutionRequestApprovalResponse,
	DynamicToolCallResponse,
	DynamicToolSpec,
	FileChangeRequestApprovalResponse,
	SandboxMode as GeneratedSandboxMode,
	GrantedPermissionProfile,
	McpServerElicitationRequestResponse,
	Model,
	ModelListParams,
	ModelListResponse,
	PermissionsRequestApprovalResponse,
	RateLimitSnapshot,
	ReasoningEffortOption,
	SandboxPolicy,
	SubAgentActivityKind,
	ThreadResumeParams,
	ThreadStartParams,
	TurnStartParams,
} from "./codexProtocol";
import { bumpDataRevision } from "./dataRevision";

/**
 * Union of the RESPONSE shapes hlid can send back for the server-initiated
 * approval requests it handles (item/permissions/requestApproval,
 * item/commandExecution/requestApproval, item/fileChange/requestApproval,
 * and the legacy execCommandApproval/applyPatchApproval methods, which share
 * the command/file-change response shape).
 */
type ApprovalRequestResult =
	| PermissionsRequestApprovalResponse
	| CommandExecutionRequestApprovalResponse
	| FileChangeRequestApprovalResponse;

type CodexCollaborationMode = {
	mode: "plan" | "default";
	settings: {
		model: string;
		reasoning_effort: string | null;
		developer_instructions: null;
	};
};

type TurnStartParamsWithCollaboration = TurnStartParams & {
	collaborationMode: CodexCollaborationMode;
};

class AsyncQueue<T> {
	private values: T[] = [];
	private waiters: Array<(value: IteratorResult<T>) => void> = [];
	private closed = false;

	push(value: T): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value, done: false });
		else this.values.push(value);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		while (this.waiters.length > 0) {
			this.waiters.shift()?.({ value: undefined as T, done: true });
		}
	}

	next(): Promise<IteratorResult<T>> {
		const value = this.values.shift();
		if (value) return Promise.resolve({ value, done: false });
		if (this.closed) {
			return Promise.resolve({ value: undefined as T, done: true });
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}
}

function asObj(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function skillsFromListResponse(value: unknown): Record<string, unknown>[] {
	const result = asObj(value);
	if (Array.isArray(result.skills)) return result.skills.map(asObj);
	if (!Array.isArray(result.data)) return [];
	return result.data.flatMap((entry) => {
		const skills = asObj(entry).skills;
		return Array.isArray(skills) ? skills.map(asObj) : [];
	});
}

const WINDOWS_COMPUTER_USE_NAMESPACE = "hlid";
const WINDOWS_COMPUTER_USE_TOOL = "windows_computer_use";
const DEFAULT_WINDOWS_COMPUTER_USE_MODEL = "gpt-5.4";
const DEFAULT_WINDOWS_COMPUTER_USE_EFFORT = "medium";

export function windowsComputerUseModel(
	override: string | undefined = process.env.HLID_WINDOWS_COMPUTER_USE_MODEL,
): string {
	return override?.trim() || DEFAULT_WINDOWS_COMPUTER_USE_MODEL;
}

export type WindowsComputerUseResolution = {
	model: string;
	effort: string;
	/** User-visible explanation when native validation changed or could not verify a choice. */
	notice?: string;
};

/**
 * Resolve Forge preferences against the active session and the Windows-native
 * Codex catalog. This stays pure so fallback behavior is deterministic and
 * testable without launching a desktop worker.
 */
export function resolveWindowsComputerUseSettings(options: {
	configured?: { model?: string; effort?: string };
	sessionModel?: string | null;
	sessionEffort?: string | null;
	nativeModels: ProviderModelInfo[];
	catalogError?: string;
}): WindowsComputerUseResolution {
	const warnings: string[] = [];
	const configuredModel = options.configured?.model?.trim() || "inherit";
	const sessionModel = options.sessionModel?.trim() || "";
	const requestedModel =
		configuredModel === "inherit" ? sessionModel : configuredModel;
	const modelSource = configuredModel === "inherit" ? "Session" : "Configured";
	const fallbackModel =
		options.nativeModels.find(
			(model) => model.value === windowsComputerUseModel(),
		)?.value ??
		options.nativeModels.find((model) => model.isDefault)?.value ??
		options.nativeModels[0]?.value ??
		windowsComputerUseModel();

	let model = requestedModel || fallbackModel;
	if (options.nativeModels.length > 0) {
		if (!requestedModel) {
			model = fallbackModel;
			warnings.push(
				`Session model was not reported; using Windows-native ${model}.`,
			);
		} else if (
			!options.nativeModels.some(
				(candidate) => candidate.value === requestedModel,
			)
		) {
			model = fallbackModel;
			warnings.push(
				`${modelSource} model ${requestedModel} is unavailable in Windows-native Codex; using ${model}.`,
			);
		}
	} else if (options.catalogError) {
		warnings.push(
			`Windows-native model validation was unavailable; using ${model}.`,
		);
	} else {
		warnings.push(
			`Windows-native model catalog returned no models; using ${model}.`,
		);
	}

	const configuredEffort =
		options.configured?.effort?.trim() || DEFAULT_WINDOWS_COMPUTER_USE_EFFORT;
	const requestedEffort =
		configuredEffort === "inherit"
			? options.sessionEffort?.trim() || DEFAULT_WINDOWS_COMPUTER_USE_EFFORT
			: configuredEffort;
	const selectedModel = options.nativeModels.find(
		(candidate) => candidate.value === model,
	);
	const supportedEfforts = selectedModel?.efforts ?? [];
	let effort = requestedEffort;
	if (
		supportedEfforts.length > 0 &&
		!supportedEfforts.some((candidate) => candidate.value === requestedEffort)
	) {
		effort =
			supportedEfforts.find(
				(candidate) => candidate.value === DEFAULT_WINDOWS_COMPUTER_USE_EFFORT,
			)?.value ??
			supportedEfforts.find((candidate) => candidate.isDefault)?.value ??
			supportedEfforts[0]?.value ??
			DEFAULT_WINDOWS_COMPUTER_USE_EFFORT;
		warnings.push(
			`Effort ${requestedEffort} is unsupported by ${model}; using ${effort}.`,
		);
	}

	return {
		model,
		effort,
		...(warnings.length > 0 ? { notice: warnings.join(" ") } : {}),
	};
}

function windowsComputerUseWorkspace(): string {
	return (
		process.env.HLID_WINDOWS_COMPUTER_USE_CWD ??
		resolve(APP_DIR, "windows-computer-use")
	);
}

export function windowsComputerUseHostAvailable(
	platform = process.platform,
	executable = resolveCodexExecutable(),
): boolean {
	return platform === "win32" && Boolean(executable);
}

type WindowsComputerUseCapability = {
	label: string;
	available: boolean;
	reason?: string;
};

export type CodexHostCapabilities = {
	windowsComputerUse: WindowsComputerUseCapability;
};

async function probeWindowsComputerUseCapability(): Promise<WindowsComputerUseCapability> {
	const label = "Windows Computer Use";
	if (process.platform !== "win32") {
		return {
			label,
			available: false,
			reason: "Hlid is not running on Windows",
		};
	}
	const executable = resolveCodexExecutable();
	if (!executable) {
		return { label, available: false, reason: "Native Codex CLI not found" };
	}
	try {
		const cwd = windowsComputerUseWorkspace();
		mkdirSync(cwd, { recursive: true });
		const conn = acquireCodexAppServer(executable);
		await conn.ready;
		const response = await conn.request("skills/list", { cwds: [cwd] });
		const loaded = skillsFromListResponse(response).some(
			(skill) =>
				String(skill.name ?? "").toLowerCase() === "computer-use:computer-use",
		);
		return {
			label,
			available: loaded,
			...(loaded
				? {}
				: { reason: "Computer Use plugin is not installed or enabled" }),
		};
	} catch (error) {
		throw error instanceof Error ? error : new Error("Capability check failed");
	}
}

const HOST_CAPABILITY_TTL_MS = 60_000;
const HOST_CAPABILITY_FAILURE_TTL_MS = 15_000;
const HOST_CAPABILITY_TIMEOUT_MS = 5_000;
let hostCapabilitySnapshot: WindowsComputerUseCapability | null = null;
let hostCapabilityRefreshedAt = 0;
let hostCapabilityFailedAt = 0;
let hostCapabilityInflight: Promise<WindowsComputerUseCapability> | null = null;

function fallbackWindowsComputerUseCapability(
	error?: unknown,
): WindowsComputerUseCapability {
	const label = "Windows Computer Use";
	if (process.platform !== "win32") {
		return {
			label,
			available: false,
			reason: "Hlid is not running on Windows",
		};
	}
	if (!resolveCodexExecutable()) {
		return { label, available: false, reason: "Native Codex CLI not found" };
	}
	return {
		label,
		available: false,
		reason:
			error instanceof Error
				? error.message
				: "Capability status is refreshing",
	};
}

function capabilityChanged(
	previous: WindowsComputerUseCapability | null,
	next: WindowsComputerUseCapability,
): boolean {
	return (
		previous?.available !== next.available ||
		previous?.label !== next.label ||
		previous?.reason !== next.reason
	);
}

async function boundedWindowsComputerUseProbe(): Promise<WindowsComputerUseCapability> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		probeWindowsComputerUseCapability(),
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Capability check timed out")),
				HOST_CAPABILITY_TIMEOUT_MS,
			);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

async function refreshWindowsComputerUseCapability(
	force = false,
): Promise<WindowsComputerUseCapability> {
	const now = Date.now();
	if (
		!force &&
		hostCapabilitySnapshot &&
		now - hostCapabilityRefreshedAt < HOST_CAPABILITY_TTL_MS
	) {
		return hostCapabilitySnapshot;
	}
	if (
		!force &&
		!hostCapabilitySnapshot &&
		hostCapabilityFailedAt > 0 &&
		now - hostCapabilityFailedAt < HOST_CAPABILITY_FAILURE_TTL_MS
	) {
		return fallbackWindowsComputerUseCapability();
	}
	if (hostCapabilityInflight) return hostCapabilityInflight;

	const refresh = boundedWindowsComputerUseProbe()
		.then((capability) => {
			const previous = hostCapabilitySnapshot;
			hostCapabilitySnapshot = capability;
			hostCapabilityRefreshedAt = Date.now();
			hostCapabilityFailedAt = 0;
			if (capabilityChanged(previous, capability)) {
				bumpDataRevision("providers");
			}
			return capability;
		})
		.catch((error) => {
			hostCapabilityFailedAt = Date.now();
			return (
				hostCapabilitySnapshot ?? fallbackWindowsComputerUseCapability(error)
			);
		})
		.finally(() => {
			hostCapabilityInflight = null;
		});
	hostCapabilityInflight = refresh;
	return refresh;
}

function cachedWindowsComputerUseCapability(): WindowsComputerUseCapability {
	const capability =
		hostCapabilitySnapshot ?? fallbackWindowsComputerUseCapability();
	if (
		!hostCapabilitySnapshot ||
		Date.now() - hostCapabilityRefreshedAt >= HOST_CAPABILITY_TTL_MS
	) {
		void refreshWindowsComputerUseCapability().catch(() => {});
	}
	return capability;
}

/** Force a bounded live refresh for an explicit provider-catalog refresh. */
export async function refreshCodexHostCapabilities(): Promise<CodexHostCapabilities> {
	return {
		windowsComputerUse: await refreshWindowsComputerUseCapability(true),
	};
}

// fallow-ignore-next-line unused-export -- Test-only reset for module-level cache isolation.
export function __resetCodexHostCapabilitiesForTesting(): void {
	hostCapabilitySnapshot = null;
	hostCapabilityRefreshedAt = 0;
	hostCapabilityFailedAt = 0;
	hostCapabilityInflight = null;
}

function windowsComputerUseTools(): DynamicToolSpec[] {
	return [
		{
			type: "namespace",
			name: WINDOWS_COMPUTER_USE_NAMESPACE,
			description: "Hlid host capabilities",
			tools: [
				{
					type: "function",
					name: WINDOWS_COMPUTER_USE_TOOL,
					description:
						"Delegate a Windows desktop task to a Windows-native Codex thread with Computer Use. Use this when the task requires interacting with installed Windows applications or the desktop.",
					inputSchema: {
						type: "object",
						properties: {
							task: {
								type: "string",
								description:
									"A precise description of the Windows desktop task to complete.",
							},
							context: {
								type: "string",
								description:
									"Optional context or success criteria for the delegated task.",
							},
						},
						required: ["task"],
						additionalProperties: false,
					},
				},
			],
		},
	];
}

function findNestedString(
	value: unknown,
	keys: ReadonlySet<string>,
	depth = 0,
): string | undefined {
	if (depth > 6 || !value || typeof value !== "object") return undefined;
	for (const [key, nested] of Object.entries(value)) {
		if (keys.has(key.toLowerCase()) && typeof nested === "string" && nested)
			return nested;
	}
	for (const nested of Object.values(value)) {
		const found = findNestedString(nested, keys, depth + 1);
		if (found) return found;
	}
	return undefined;
}

export function computerUseApprovalDetails(rawParams: unknown): {
	appId?: string;
	displayName: string;
	riskLevel?: string;
} {
	const params = asObj(rawParams);
	const meta = asObj(params._meta);
	const toolParams = asObj(meta.tool_params);
	const displayedApp = Array.isArray(meta.tool_params_display)
		? meta.tool_params_display
				.map(asObj)
				.find((entry) => String(entry.name ?? "").toLowerCase() === "app")
		: undefined;
	const appId =
		(typeof toolParams.app === "string" && toolParams.app
			? toolParams.app
			: undefined) ??
		findNestedString(
			params,
			new Set(["appid", "app_id", "applicationid", "application_id"]),
		);
	const displayName =
		(typeof displayedApp?.value === "string" && displayedApp.value
			? displayedApp.value
			: undefined) ??
		findNestedString(
			params,
			new Set([
				"displayname",
				"display_name",
				"appname",
				"app_name",
				"applicationname",
				"application_name",
			]),
		);
	const riskLevel = findNestedString(
		params,
		new Set(["risklevel", "risk_level", "risk"]),
	);
	return {
		...(appId ? { appId } : {}),
		displayName: displayName ?? appId ?? "a Windows app",
		...(riskLevel ? { riskLevel } : {}),
	};
}

function textFromUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((v) => {
				const obj = asObj(v);
				return typeof obj.text === "string" ? obj.text : "";
			})
			.join("");
	}
	const obj = asObj(value);
	return typeof obj.text === "string" ? obj.text : "";
}

function filePathFromItem(value: unknown): string | null {
	const obj = asObj(value);
	for (const key of ["file_path", "filePath", "path"]) {
		if (typeof obj[key] === "string") return obj[key];
	}
	for (const collection of [obj.changes, obj.files]) {
		if (!Array.isArray(collection)) continue;
		for (const entry of collection) {
			const path = filePathFromItem(entry);
			if (path) return path;
		}
	}
	return null;
}

function isHtmlPlanPath(path: string): boolean {
	return /(?:^|[\\/])\.hlid[\\/]plans[\\/]plan-[^\\/]+\.html$/i.test(path);
}

export function codexSubagentStatus(
	value: CollabAgentStatus | null | undefined,
	previous?: SubagentSnapshot["status"],
): SubagentSnapshot["status"] {
	switch (String(value ?? "")) {
		case "pendingInit":
			return "pending";
		case "running":
			return "running";
		case "completed":
			return "completed";
		case "errored":
		case "notFound":
			return "failed";
		case "interrupted":
			return "interrupted";
		case "shutdown":
			return previous === "completed" ? "completed" : "interrupted";
		default:
			return previous ?? "running";
	}
}

export function codexChildStep(item: Record<string, unknown>): string {
	const type = String(item.type ?? "activity");
	if (type === "commandExecution") {
		const command = typeof item.command === "string" ? item.command : "command";
		return `Running ${command.slice(0, 120)}`;
	}
	if (type === "fileChange") return "Applying file changes";
	if (type === "mcpToolCall") {
		return `Calling ${String(item.tool ?? item.server ?? "MCP tool")}`;
	}
	if (type === "webSearch") return "Searching the web";
	if (type === "reasoning") return "Reasoning";
	return `Working on ${type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`;
}

function shortStep(value: unknown): string | undefined {
	const text = textFromUnknown(value).replace(/\s+/g, " ").trim();
	return text ? text.slice(0, 240) : undefined;
}

export function codexReasoningText(item: unknown): string {
	const obj = asObj(item);
	const candidates = [
		obj.summary,
		obj.text,
		obj.content,
		obj.reasoning,
		obj.message,
	];
	for (const candidate of candidates) {
		const text = textFromUnknown(candidate).trim();
		if (text) return text;
	}
	return "";
}

function approvalPolicy(
	mode: AgentQueryParams["permissionMode"],
): "on-request" | "never" {
	return mode === "bypassPermissions" ? "never" : "on-request";
}

function effectiveApprovalPolicy(
	params: AgentQueryParams,
): "on-request" | "never" {
	return params.usageGateEnforced && !params.policyEnforced
		? "on-request"
		: approvalPolicy(effectivePermissionMode(params));
}

function autoApprovesPermissions(params: AgentQueryParams): boolean {
	return (
		params.permissionMode === "bypassPermissions" ||
		(params.permissionMode === "plan" &&
			params.implementationPermissionMode === "bypassPermissions")
	);
}

function effectivePermissionMode(
	params: AgentQueryParams,
): AgentQueryParams["permissionMode"] {
	return params.permissionMode === "plan" &&
		params.implementationPermissionMode === "bypassPermissions"
		? "bypassPermissions"
		: params.permissionMode;
}

/** Alias of the vendored generated SandboxMode — kept as a named export for API stability. */
export type CodexSandboxMode = GeneratedSandboxMode;

export function sandboxMode(
	mode: AgentQueryParams["permissionMode"],
): CodexSandboxMode {
	if (mode === "bypassPermissions") return "danger-full-access";
	if (mode === "plan") return "read-only";
	return "workspace-write";
}

/**
 * Alias of the vendored generated SandboxPolicy union (adds an
 * `externalSandbox` variant hlid never constructs, from codex-cli's
 * managed-network sandbox feature — codexSandboxPolicy() below only ever
 * returns one of the other three variants). Kept as a named export for API
 * stability.
 */
export type CodexSandboxPolicy = SandboxPolicy;

export function codexSandboxPolicy(
	mode: AgentQueryParams["permissionMode"],
	writableRoots: string[],
	planHtmlPath?: string,
): CodexSandboxPolicy {
	const sandbox = sandboxMode(mode);
	if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
	if (sandbox === "read-only" && planHtmlPath) {
		return {
			type: "workspaceWrite",
			writableRoots: [dirname(planHtmlPath)],
			networkAccess: false,
			excludeTmpdirEnvVar: true,
			excludeSlashTmp: true,
		};
	}
	if (sandbox === "read-only")
		return { type: "readOnly", networkAccess: false };
	return {
		type: "workspaceWrite",
		writableRoots,
		networkAccess: false,
		excludeTmpdirEnvVar: false,
		excludeSlashTmp: false,
	};
}

export type CodexLaunchConfig = {
	executable: string;
	rpcCwd: string;
};

export function codexLaunchConfig(params: {
	cwd: string;
	executable?: string;
}): CodexLaunchConfig {
	// The shared app-server process is spawned without a cwd (see
	// codexAppServer.ts) — the session's working directory travels as rpcCwd
	// in thread/start and turn/start instead. toLogical rewrites WSL UNC
	// paths to the POSIX path the in-WSL codex expects.
	const executable = params.executable ?? resolveCodexExecutable();
	if (!executable) throw new Error("Codex CLI not found");
	return {
		executable,
		rpcCwd: toLogical(params.cwd),
	};
}

/** Title-cases a raw effort value like "xhigh" -> "Xhigh" for display fallback. */
function titleCase(value: string): string {
	if (!value) return value;
	return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * Pure mapper from codex-cli's `model/list` RPC response shape to the
 * provider-agnostic ProviderModelInfo[]. Tolerant of missing/malformed
 * fields — entries without a usable model/id are skipped.
 */
export function mapCodexModels(raw: unknown): ProviderModelInfo[] {
	// Compile-time shape hint only — `raw` is still untrusted at runtime, so
	// every field access below keeps its typeof/Array.isArray guard.
	const parsed = asObj(raw) as Partial<ModelListResponse>;
	const data: unknown[] = Array.isArray(parsed.data) ? parsed.data : [];
	return data.flatMap((entry): ProviderModelInfo[] => {
		const item = asObj(entry) as Partial<Model>;
		const value =
			typeof item.model === "string"
				? item.model
				: typeof item.id === "string"
					? item.id
					: undefined;
		if (!value) return [];
		const label =
			typeof item.displayName === "string" ? item.displayName : value;
		const description =
			typeof item.description === "string" ? item.description : undefined;
		const hidden = item.hidden === true ? true : undefined;
		const defaultEffort =
			typeof item.defaultReasoningEffort === "string"
				? item.defaultReasoningEffort
				: undefined;
		const rawEfforts: unknown[] | undefined = Array.isArray(
			item.supportedReasoningEfforts,
		)
			? item.supportedReasoningEfforts
			: undefined;
		const efforts: ProviderEffortInfo[] | undefined = rawEfforts?.flatMap(
			(e): ProviderEffortInfo[] => {
				const eObj = asObj(e) as Partial<ReasoningEffortOption>;
				const effortValue =
					typeof eObj.reasoningEffort === "string"
						? eObj.reasoningEffort
						: undefined;
				if (!effortValue) return [];
				return [
					{
						value: effortValue,
						label: titleCase(effortValue),
						desc:
							typeof eObj.description === "string"
								? eObj.description
								: undefined,
						isDefault:
							defaultEffort !== undefined
								? effortValue === defaultEffort
								: undefined,
					},
				];
			},
		);
		return [
			{
				value,
				label,
				description,
				isDefault: undefined,
				hidden,
				efforts,
			},
		];
	});
}

/**
 * `model/list` RPC over the shared codex app-server connection (see
 * codexAppServer.ts — no per-call process spawn). Used by
 * CodexProvider.listModels() to live-fetch the model catalog; falls back to
 * the static `models` array on failure (handled by callers).
 */
export async function fetchCodexModels(opts?: {
	includeHidden?: boolean;
	timeoutMs?: number;
	executable?: string;
	cwd?: string;
}): Promise<ProviderModelInfo[]> {
	const launch = codexLaunchConfig({
		cwd: opts?.cwd ?? process.cwd(),
		executable: opts?.executable,
	});
	const conn = acquireCodexAppServer(launch.executable);
	const timeoutMs = opts?.timeoutMs ?? 10_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			(async () => {
				await conn.ready;
				const modelListParams: ModelListParams = {
					includeHidden: opts?.includeHidden ?? false,
				};
				return conn.request("model/list", modelListParams, timeoutMs);
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					const error = new Error(
						`Codex model catalog timed out after ${timeoutMs}ms`,
					);
					conn.kill(error);
					reject(error);
				}, timeoutMs);
			}),
		]);
		const models = mapCodexModels(result);
		return opts?.includeHidden
			? models
			: models.filter((m) => m.hidden !== true);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function maybeUsage(value: unknown): AgentEvent | null {
	const obj = asObj(value);
	const tokenUsage = asObj(obj.usage ?? obj.tokenUsage ?? obj.tokens);
	// ThreadTokenUsage carries the serving model's real context window.
	const contextWindow = Number(tokenUsage.modelContextWindow) || undefined;
	const usage = asObj(tokenUsage.last ?? tokenUsage.total ?? tokenUsage);
	const input =
		Number(usage.inputTokens ?? usage.input_tokens ?? usage.input) || 0;
	const output =
		Number(usage.outputTokens ?? usage.output_tokens ?? usage.output) || 0;
	if (input === 0 && output === 0) return null;
	const canonical = canonicalizeCodexUsage({
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens:
			Number(usage.cacheReadTokens ?? usage.cache_read_input_tokens) ||
			Number(usage.cachedInputTokens) ||
			undefined,
		cacheCreationTokens:
			Number(usage.cacheCreationTokens ?? usage.cache_creation_input_tokens) ||
			Number(usage.cacheWriteTokens ?? usage.cache_write_tokens) ||
			undefined,
	});
	return {
		type: "usage",
		inputTokens: canonical.inputTokens,
		outputTokens: canonical.outputTokens,
		contextWindow,
		cacheReadTokens: canonical.cacheReadTokens || undefined,
		cacheCreationTokens: canonical.cacheCreationTokens || undefined,
		model: typeof obj.model === "string" ? obj.model : undefined,
	};
}

function emptyCodexUsage(): CanonicalTokenUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
	};
}

type CodexWindowReading = Pick<
	ProviderWindowReading,
	"windowId" | "label" | "utilization" | "resetsAt"
>;

function mapCodexRateLimitWindows(
	raw: unknown,
	includeMissingUtilization = false,
): CodexWindowReading[] {
	const snapshot = asObj(raw) as Partial<RateLimitSnapshot>;
	return (
		[
			[snapshot.primary, "five_hour"],
			[snapshot.secondary, "weekly"],
		] as const
	).flatMap(([window, fallbackId]) => {
		const value = asObj(window);
		const usedPercent =
			typeof value.usedPercent === "number" ? value.usedPercent : null;
		if (usedPercent == null && !includeMissingUtilization) return [];
		const duration =
			typeof value.windowDurationMins === "number"
				? value.windowDurationMins
				: null;
		const windowId =
			duration == null
				? fallbackId
				: duration <= 24 * 60
					? "five_hour"
					: "weekly";
		const rawReset = typeof value.resetsAt === "number" ? value.resetsAt : null;
		return [
			{
				windowId,
				label: windowId === "five_hour" ? "5-HOUR" : "7-DAY",
				utilization: usedPercent == null ? null : usedPercent / 100,
				resetsAt:
					rawReset != null && rawReset > 1e12
						? Math.round(rawReset / 1000)
						: rawReset,
			},
		];
	});
}

class CodexAgentSession implements AgentSession {
	private conn: CodexAppServer | null = null;
	private events = new AsyncQueue<AgentEvent>();
	private ready: Promise<void> | null = null;
	private threadId: string | null = null;
	private activeTurnId: string | null = null;
	private canceled = false;
	private endAfterTurn = false;
	private streamedAgentMessageIds = new Set<string>();
	private emittedReasoningIds = new Set<string>();
	private sawUnidentifiedAgentMessageDelta = false;
	private startedItems = new Map<string, Record<string, unknown>>();
	private attachedThreadIds = new Set<string>();
	private subagentByThread = new Map<string, string>();
	private subagentSnapshots = new Map<string, SubagentSnapshot>();
	private pendingSubagentToolIds = new Set<string>();
	private threadHandler: ThreadHandler | null = null;
	private approvedHtmlPlanItemId: string | null = null;
	private htmlPlanReady = false;
	private nativePlanText = "";
	private lastUsage = emptyCodexUsage();
	private queryUsage = emptyCodexUsage();
	private queryTurns = 0;
	private queryWebSearchItemIds = new Set<string>();
	private childLastUsage = new Map<string, CanonicalTokenUsage>();
	private resolvedModel: string | null = null;
	private elicitationSequence = 0;
	/** Dedicated transport owned by a one-shot Windows Computer Use worker. */
	private ownedConnection: CodexAppServer | null = null;

	private launch: CodexLaunchConfig | null = null;

	constructor(
		private params: AgentQueryParams,
		private readonly delegatedWindowsComputerUse = false,
		private readonly delegatedWindowsComputerUseTask?: string,
	) {}

	private canUseWindowsComputerUse(): boolean {
		return (
			!this.delegatedWindowsComputerUse && windowsComputerUseHostAvailable()
		);
	}

	cancel(): void {
		this.canceled = true;
		this.events.close();
		// Normal sessions share an app-server and must only detach. Delegated
		// Computer Use workers own a fresh app-server so every task reloads the
		// desktop app's current plugin path, Node REPL, and native approval pipe.
		if (this.conn && this.threadId) {
			if (this.activeTurnId) {
				void this.conn
					.request("turn/interrupt", {
						threadId: this.threadId,
						turnId: this.activeTurnId,
					})
					.catch(() => {});
			}
		}
		this.detachAllThreads();
		this.ownedConnection?.kill(new Error("Windows Computer Use worker closed"));
		this.ownedConnection = null;
		this.conn = null;
	}

	closeInput(): void {
		// One-shot callers (recap) use this as "no more sends coming". With a
		// shared app-server there is no per-session stdin to EOF — instead the
		// event stream is closed once the in-flight turn completes (see the
		// turn/completed handler), which ends the caller's for-await loop.
		this.endAfterTurn = true;
		if (this.activeTurnId === null) {
			this.detachAllThreads();
			this.conn = null;
			this.events.close();
		}
	}

	async interrupt(): Promise<void> {
		await this.ensureReady();
		if (!this.threadId || !this.activeTurnId) return;
		await this.request("turn/interrupt", {
			threadId: this.threadId,
			turnId: this.activeTurnId,
		});
	}

	async send(message: string, _opts?: SendOptions): Promise<void> {
		await this.ensureReady();
		if (!this.threadId) throw new Error("Codex thread did not start");
		const cwd = this.launch?.rpcCwd ?? this.params.cwd;
		const params: TurnStartParamsWithCollaboration = {
			threadId: this.threadId,
			input: [{ type: "text", text: message, text_elements: [] }],
			collaborationMode: {
				// Native Codex Plan Mode forbids every write at the instruction layer,
				// even when the sandbox grants the HTML plan directory. HTML plans use
				// Hlið-managed planning while plain Markdown plans stay native.
				mode:
					this.params.permissionMode === "plan" && !this.params.planHtmlPath
						? "plan"
						: "default",
				settings: {
					model: this.params.model ?? "",
					reasoning_effort: this.params.effort ?? null,
					developer_instructions: null,
				},
			},
			...(cwd ? { cwd } : {}),
			...(this.params.model ? { model: this.params.model } : {}),
			...(this.params.effort ? { effort: this.params.effort } : {}),
			...(this.params.permissionMode
				? {
						approvalPolicy: effectiveApprovalPolicy(this.params),
						sandboxPolicy: codexSandboxPolicy(
							this.params.permissionMode,
							this.params.additionalDirectories ?? [],
							this.params.planHtmlPath,
						),
					}
				: {}),
		};
		const result = asObj(await this.request("turn/start", params));
		const turn = asObj(result.turn);
		if (typeof turn.id === "string") this.activeTurnId = turn.id;
	}

	/**
	 * Mid-session model switch. Codex has no dedicated RPC for this — instead
	 * we mutate the params send() reads on every turn/start call (see above:
	 * `...(this.params.model ? { model: this.params.model } : {})`), so the
	 * NEXT turn picks up the new model. Nothing to notify codex-cli of until
	 * then; there's no live "change model now" control message in the
	 * app-server protocol.
	 */
	async setModel(model?: string): Promise<void> {
		this.params = { ...this.params, model };
		this.resolvedModel = model ?? null;
	}

	/**
	 * Mid-session effort switch. Same mutate-params-read-per-turn pattern as
	 * setModel above — send() reads `this.params.effort` fresh on every
	 * turn/start call, so this takes effect starting the next turn.
	 */
	async setEffort(effort: string): Promise<void> {
		this.params = { ...this.params, effort };
	}

	async setWindowsComputerUse(settings: {
		model: string;
		effort: string;
	}): Promise<void> {
		this.params = { ...this.params, windowsComputerUse: settings };
	}

	/**
	 * Mid-session permission-mode switch. Like setModel, this only mutates
	 * the params send() reads per turn — approvalPolicy and sandboxPolicy are
	 * both recomputed from `this.params.permissionMode` on every turn/start
	 * call (see send() above). The thread-level `sandbox` field passed at
	 * thread/start (in start(), below) was derived from the ORIGINAL
	 * permission mode and is never re-sent, but turn/start's `sandboxPolicy`
	 * is a full policy object that codex-cli honours per-turn and takes
	 * precedence over the thread-level default — so this mutation is
	 * effective starting with the next turn without needing to touch the
	 * thread.
	 */
	async setPermissionMode(mode: string): Promise<void> {
		const permissionMode = mode as AgentQueryParams["permissionMode"];
		this.params = {
			...this.params,
			permissionMode,
			...(permissionMode === "plan" && this.params.permissionMode !== "plan"
				? { implementationPermissionMode: this.params.permissionMode }
				: {}),
		};
	}

	setPlanHtmlPath(path: string | undefined): void {
		this.params = { ...this.params, planHtmlPath: path };
	}

	/**
	 * Read provider metadata without starting a Codex thread. Skills and MCP
	 * inventory are app-server-level RPCs; creating an ephemeral thread here
	 * needlessly starts another copy of every configured MCP server.
	 */
	private async metadataConnection(): Promise<{
		conn: CodexAppServer;
		launch: CodexLaunchConfig;
	}> {
		const launch =
			this.launch ??
			codexLaunchConfig({
				cwd: this.params.cwd,
				executable: this.params.executable,
			});
		const conn = this.conn ?? acquireCodexAppServer(launch.executable);
		await conn.ready;
		return { conn, launch };
	}

	async supportedCommands(): Promise<SlashCommand[]> {
		// Keep the command available whenever this is a native Windows host. The
		// desktop app can update its plugin/runtime while Hlid stays open, so a
		// capability snapshot is advisory and must not hide the recovery path.
		const computerUseAvailable = this.canUseWindowsComputerUse();
		const hlidCommands: SlashCommand[] = [
			{
				name: "review",
				description: "Review the working tree",
				argumentHint: "[instructions]",
				action: "review",
			},
			...(computerUseAvailable
				? [
						{
							name: "computer-use",
							description:
								"Run a task in a Windows-native Codex Computer Use thread",
							argumentHint: "<Windows desktop task>",
							action: "computer-use" as const,
						},
					]
				: []),
		];
		try {
			const { conn, launch } = await this.metadataConnection();
			const result = asObj(
				await conn.request("skills/list", {
					cwds: [launch.rpcCwd],
				}),
			);
			const skills = skillsFromListResponse(result);
			const commands: SlashCommand[] = skills.flatMap((skill) => {
				const name = String(skill.name ?? "");
				if (!name) return [];
				return [
					{
						name,
						description:
							typeof skill.description === "string" ? skill.description : "",
						argumentHint: "",
					},
				];
			});
			commands.push(...hlidCommands);
			return commands;
		} catch {
			return hlidCommands;
		}
	}

	async executeCommand(
		action: "review" | "computer-use",
		args?: string,
	): Promise<void> {
		await this.ensureReady();
		if (!this.threadId) throw new Error("Codex thread did not start");
		if (action === "computer-use") {
			const task = args?.trim();
			if (!task)
				throw new Error("/computer-use requires a Windows desktop task");
			if (!this.canUseWindowsComputerUse()) {
				throw new Error(
					"Windows Computer Use is unavailable: Hlid must be running on Windows with a native Codex CLI installed",
				);
			}
			const toolId = `hlid-windows-computer-use-${Date.now()}`;
			this.events.push({
				type: "tool_start",
				toolId,
				name: `${WINDOWS_COMPUTER_USE_NAMESPACE}.${WINDOWS_COMPUTER_USE_TOOL}`,
				input: { task },
			});
			void this.runWindowsComputerUse(task, undefined, toolId)
				.then(({ text, threadId }) => {
					const result = `Windows Computer Use thread ${threadId}\n\n${text || "Task completed without a text summary."}`;
					this.events.push({ type: "tool_result", toolId, content: result });
					this.events.push({ type: "text_delta", text: result });
					this.events.push({
						type: "done",
						turns: 1,
						durationMs: 0,
						stopReason: "end_turn",
					});
				})
				.catch((error) => {
					const message =
						error instanceof Error ? error.message : String(error);
					this.events.push({
						type: "tool_result",
						toolId,
						content: message,
						isError: true,
					});
					this.events.push({ type: "local_command_output", content: message });
					this.events.push({
						type: "done",
						turns: 1,
						durationMs: 0,
						stopReason: "error",
					});
				});
			return;
		}
		if (action !== "review") throw new Error(`Unsupported command: ${action}`);
		const target = args?.trim()
			? { type: "custom", instructions: args.trim() }
			: { type: "uncommittedChanges" };
		const result = asObj(
			await this.request("review/start", {
				threadId: this.threadId,
				target,
				delivery: "inline",
			}),
		);
		const turn = asObj(result.turn);
		if (typeof turn.id === "string") this.activeTurnId = turn.id;
	}

	async mcpServerStatus(): Promise<McpServerStatus[]> {
		try {
			const { conn } = await this.metadataConnection();
			const result = asObj(await conn.request("mcpServerStatus/list", {}));
			const servers = Array.isArray(result.data)
				? result.data
				: Array.isArray(result.servers)
					? result.servers
					: [];
			return servers.flatMap((server) => {
				const obj = asObj(server);
				const name = String(obj.name ?? obj.serverName ?? "");
				if (!name) return [];
				const raw = String(obj.status ?? obj.authStatus ?? "pending");
				const status: McpServerStatus["status"] =
					raw === "notLoggedIn"
						? "needs-auth"
						: raw === "failed" || raw === "disabled"
							? raw
							: raw === "pending"
								? "pending"
								: "connected";
				return [{ name, status }];
			});
		} catch {
			return [];
		}
	}

	async usageWindows(): Promise<ProviderWindowReading[]> {
		await this.ensureReady();
		const response = asObj(
			await this.request("account/rateLimits/read", undefined),
		);
		return mapCodexRateLimitWindows(response.rateLimits).map((reading) => ({
			...reading,
			remaining: null,
			limit: null,
		}));
	}

	[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
		return {
			next: () => this.events.next(),
			return: async () =>
				({ value: undefined, done: true }) as IteratorResult<AgentEvent>,
		};
	}

	private async ensureReady(): Promise<void> {
		if (!this.ready) this.ready = this.start();
		return this.ready;
	}

	private async start(): Promise<void> {
		const launch = codexLaunchConfig({
			cwd: this.params.cwd,
			executable: this.params.executable,
		});
		this.launch = launch;
		const conn = this.delegatedWindowsComputerUse
			? new CodexAppServer(launch.executable)
			: acquireCodexAppServer(launch.executable);
		if (this.delegatedWindowsComputerUse) this.ownedConnection = conn;
		this.conn = conn;
		if (this.params.signal) {
			if (this.params.signal.aborted) this.cancel();
			else
				this.params.signal.addEventListener("abort", () => this.cancel(), {
					once: true,
				});
		}
		await conn.ready;
		// The one-shot delegated worker validates the current plugin/runtime on a
		// fresh transport. Do not bind tool availability to a long-lived snapshot.
		const computerUseAvailable = this.canUseWindowsComputerUse();

		const threadParams: ThreadStartParams = {
			cwd: launch.rpcCwd,
			ephemeral: this.params.persistSession === false,
			// The Windows Computer Use host only emits per-app approval
			// elicitations for user-owned threads. Without this source marker it
			// treats the standalone app-server worker as an internal/background
			// thread and performs app actions without asking its client.
			...(this.delegatedWindowsComputerUse ? { threadSource: "user" } : {}),
			...(this.params.model ? { model: this.params.model } : {}),
			...(this.params.permissionMode
				? {
						approvalPolicy: effectiveApprovalPolicy(this.params),
						sandbox: sandboxMode(this.params.permissionMode),
					}
				: {}),
			...(computerUseAvailable
				? { dynamicTools: windowsComputerUseTools() }
				: {}),
		};
		const result = asObj(
			this.params.sessionId
				? await this.request("thread/resume", {
						threadId: this.params.sessionId,
						...threadParams,
						// NOTE: `ephemeral` is a ThreadStartParams-only field —
						// ThreadResumeParams (vendored in ./codexProtocol) has no
						// such field, so this is likely a no-op/ignored on resume.
						// Pre-existing behavior; typed here, not changed.
					} satisfies ThreadResumeParams & { ephemeral?: boolean | null })
				: await this.request("thread/start", threadParams),
		);
		const thread = asObj(result.thread);
		if (typeof thread.id !== "string") {
			throw new Error("Codex thread start did not return a thread id");
		}
		this.threadId = thread.id;
		this.resolvedModel =
			typeof thread.model === "string"
				? thread.model
				: (this.params.model ?? null);
		if (this.canceled) return;
		this.threadHandler = {
			onNotification: (method, params) =>
				this.handleNotification(method, params),
			onRequest: (method, params) => this.handleServerRequest(method, params),
			onExit: (err) => {
				if (this.canceled) return;
				this.handleAppServerExit(err);
			},
		};
		this.attachThread(thread.id);
		this.events.push({ type: "session_start", sessionId: thread.id });

		// Seed usage windows immediately; rolling account/rateLimits/updated
		// notifications keep them fresh during turns.
		void conn
			.request("account/rateLimits/read", undefined)
			.then((res) => this.emitRateLimits(asObj(res).rateLimits))
			.catch(() => {});
	}

	private handleAppServerExit(error: Error): void {
		const resumeThreadId = this.threadId ?? this.params.sessionId;
		const interruptedTurn = this.activeTurnId !== null;
		if (resumeThreadId) {
			this.params = { ...this.params, sessionId: resumeThreadId };
		}
		// CodexAppServer has already dropped its routed handlers. Reset this
		// session's local transport state so an idle failure transparently
		// reacquires a process and resumes the same thread on the next send.
		this.conn = null;
		this.ownedConnection = null;
		this.ready = null;
		this.threadId = null;
		this.activeTurnId = null;
		this.threadHandler = null;
		this.attachedThreadIds.clear();

		// Retrying a partially executed turn can duplicate side effects. Surface
		// the transport failure immediately; SessionManager tears down this
		// AgentSession, while the user's next turn creates a clean resumable one.
		if (interruptedTurn) {
			this.events.push({
				type: "transport_error",
				message: `Codex app-server disconnected during the active turn: ${error.message}`,
			});
		}
	}

	private attachThread(threadId: string): void {
		if (
			!this.conn ||
			!this.threadHandler ||
			this.attachedThreadIds.has(threadId)
		) {
			return;
		}
		this.conn.attachThread(threadId, this.threadHandler);
		this.attachedThreadIds.add(threadId);
	}

	private detachAllThreads(): void {
		if (this.conn) {
			for (const threadId of this.attachedThreadIds) {
				this.conn.detachThread(threadId);
			}
		}
		this.attachedThreadIds.clear();
	}

	private async resetNodeRepl(): Promise<void> {
		if (!this.threadId || !this.launch) return;
		const conn = this.ownedConnection?.alive
			? this.ownedConnection
			: this.conn?.alive
				? this.conn
				: acquireCodexAppServer(this.launch.executable);
		await conn.ready;
		await conn.request("mcpServer/tool/call", {
			threadId: this.threadId,
			server: "node_repl",
			tool: "js_reset",
			arguments: {},
		});
	}

	/**
	 * Map a codex RateLimitSnapshot (primary/secondary RateLimitWindow) onto
	 * hlid rate_limit events. Window identity comes from windowDurationMins —
	 * codex reports a rolling ~5h primary and ~7d secondary; ≤24h maps to
	 * five_hour, longer to weekly (matching CodexProvider.usageWindows).
	 */
	private emitRateLimits(raw: unknown): void {
		// Inbound payload — cast for shape hints, keep runtime guards.
		const snapshot = asObj(raw) as Partial<RateLimitSnapshot>;
		const reached = snapshot.rateLimitReachedType;
		// Credits-depleted variants don't reset with the window, so sleeping on
		// them is pointless — they stay "ok". The usage/rate-limit variants are
		// hard limits that lift at the window reset.
		const hardLimited =
			reached === "rate_limit_reached" ||
			reached === "workspace_owner_usage_limit_reached" ||
			reached === "workspace_member_usage_limit_reached";
		// A window with no reading is normally skipped, but a hard limit must
		// still surface so downstream sleep logic sees the rejection.
		const windows = mapCodexRateLimitWindows(raw, hardLimited);
		// rateLimitReachedType is snapshot-level and doesn't name the window that
		// tripped; attribute the rejection to the most-utilized reported window
		// (five_hour on ties or when no readings exist) so an exhausted weekly
		// doesn't masquerade as a five_hour limit.
		let rejectedId: string | null = null;
		if (hardLimited && windows.length > 0) {
			rejectedId = windows.reduce((best, w) =>
				(w.utilization ?? -1) > (best.utilization ?? -1) ? w : best,
			).windowId;
		}
		for (const w of windows) {
			this.events.push({
				type: "rate_limit",
				status: w.windowId === rejectedId ? "rejected" : "ok",
				rateLimitType: w.windowId,
				...(w.utilization != null ? { utilization: w.utilization } : {}),
				resetsAt: w.resetsAt,
			});
		}
	}

	private request(method: string, params: unknown): Promise<unknown> {
		if (!this.conn) throw new Error("Codex app-server is not running");
		return this.conn.request(method, params);
	}

	private async runWindowsComputerUse(
		task: string,
		context: string | undefined,
		toolId: string,
	): Promise<{ text: string; threadId: string }> {
		const executable = resolveCodexExecutable();
		if (!windowsComputerUseHostAvailable(process.platform, executable)) {
			throw new Error(
				"Windows Computer Use requires the Windows Hlid host and a native Codex CLI",
			);
		}
		const cwd = windowsComputerUseWorkspace();
		mkdirSync(cwd, { recursive: true });
		let nativeModels: ProviderModelInfo[] = [];
		let catalogError: string | undefined;
		try {
			nativeModels = await fetchCodexModels({ executable, cwd });
		} catch (error) {
			catalogError = error instanceof Error ? error.message : String(error);
		}
		const resolved = resolveWindowsComputerUseSettings({
			configured: this.params.windowsComputerUse,
			sessionModel: this.resolvedModel ?? this.params.model,
			sessionEffort: this.params.effort,
			nativeModels,
			catalogError,
		});
		const startedAtMs = Date.now();
		let snapshot: SubagentSnapshot = {
			provider: "codex",
			agentId: toolId,
			label: "Windows Computer Use",
			prompt: task,
			model: resolved.model,
			effort: resolved.effort,
			status: "running",
			currentStep:
				resolved.notice ??
				`Starting Windows-native Codex · ${resolved.model} · ${resolved.effort}`,
			startedAtMs,
		};
		this.emitSubagentUpdate(toolId, snapshot);
		const child = new CodexAgentSession(
			{
				...this.params,
				cwd,
				sessionId: undefined,
				executable,
				model: resolved.model,
				effort: resolved.effort,
				permissionMode: "default",
				implementationPermissionMode: undefined,
				planHtmlPath: undefined,
				additionalDirectories: undefined,
				// Hlid owns this one-shot worker and returns its result to the caller.
				// Use a fresh native app-server for each task so a desktop update cannot
				// leave this worker on an obsolete plugin path or native approval pipe.
				persistSession: false,
			},
			true,
			task,
		);
		let text = "";
		let threadId = "";
		let completed = false;
		try {
			const prompt = [
				"You are a Windows-native Codex Computer Use worker delegated by Hlid.",
				"Complete the desktop task below using the installed computer-use:computer-use capability.",
				"Use Windows applications only as needed, honor every approval response, and do not delegate back to hlid.windows_computer_use.",
				context ? `Context and success criteria:\n${context}` : "",
				`Task:\n${task}`,
				"When finished, briefly report what you did and whether the task succeeded.",
			]
				.filter(Boolean)
				.join("\n\n");
			await child.send(prompt);
			child.closeInput();
			for await (const event of child) {
				if (event.type === "session_start") {
					threadId = event.sessionId;
					snapshot = {
						...snapshot,
						agentId: threadId,
						currentStep: "Working in the Windows desktop",
					};
					this.emitSubagentUpdate(toolId, snapshot);
				} else if (event.type === "text_delta") {
					text += event.text;
				} else if (event.type === "local_command_output") {
					text += `${text ? "\n" : ""}${event.content}`;
				} else if (event.type === "tool_start") {
					snapshot = {
						...snapshot,
						lastTool: event.name,
						currentStep: `Using ${event.name}`,
					};
					this.emitSubagentUpdate(toolId, snapshot);
				} else if (event.type === "done") {
					completed = event.stopReason !== "error";
				}
			}
			if (!threadId)
				throw new Error("Windows Codex did not return a thread id");
			if (!completed)
				throw new Error(text || "Windows Computer Use did not complete");
			if (!text.trim())
				throw new Error(
					"Windows Computer Use completed without producing a response",
				);
			snapshot = {
				...snapshot,
				status: "completed",
				currentStep: resolved.notice
					? `Completed · ${resolved.notice}`
					: "Completed",
				endedAtMs: Date.now(),
			};
			this.emitSubagentUpdate(toolId, snapshot);
			return {
				text: resolved.notice
					? `Configuration note: ${resolved.notice}\n\n${text.trim()}`
					: text.trim(),
				threadId,
			};
		} catch (error) {
			snapshot = {
				...snapshot,
				status: this.canceled ? "interrupted" : "failed",
				currentStep:
					error instanceof Error
						? error.message
						: "Windows Computer Use failed",
				endedAtMs: Date.now(),
			};
			this.emitSubagentUpdate(toolId, snapshot);
			throw error;
		} finally {
			// Computer Use opens a per-thread Node kernel. Ephemeral history alone
			// does not tear that process down, so reset the owned MCP session and
			// terminate its dedicated app-server after every one-shot worker.
			await child.resetNodeRepl().catch(() => {});
			child.cancel();
		}
	}

	private async handleDynamicToolCall(
		params: Record<string, unknown>,
	): Promise<DynamicToolCallResponse> {
		if (
			params.namespace !== WINDOWS_COMPUTER_USE_NAMESPACE ||
			params.tool !== WINDOWS_COMPUTER_USE_TOOL
		) {
			return {
				success: false,
				contentItems: [
					{
						type: "inputText",
						text: `Unknown Hlid dynamic tool: ${String(params.namespace)}.${String(params.tool)}`,
					},
				],
			};
		}
		const args = asObj(params.arguments);
		const task = typeof args.task === "string" ? args.task.trim() : "";
		const context =
			typeof args.context === "string" ? args.context.trim() : undefined;
		if (!task) {
			return {
				success: false,
				contentItems: [
					{ type: "inputText", text: "A non-empty task is required." },
				],
			};
		}
		const toolId = String(
			params.callId ?? `windows-computer-use-${Date.now()}`,
		);
		try {
			const result = await this.runWindowsComputerUse(task, context, toolId);
			return {
				success: true,
				contentItems: [
					{
						type: "inputText",
						text: `Windows Computer Use thread ${result.threadId}\n\n${result.text || "Task completed without a text summary."}`,
					},
				],
			};
		} catch (error) {
			return {
				success: false,
				contentItems: [
					{
						type: "inputText",
						text: error instanceof Error ? error.message : String(error),
					},
				],
			};
		}
	}

	private async handleMcpElicitation(
		params: Record<string, unknown>,
	): Promise<McpServerElicitationRequestResponse> {
		if (params.mode === "url") {
			return { action: "cancel", content: null, _meta: null };
		}
		const serialized = JSON.stringify(params).toLowerCase();
		if (
			!this.delegatedWindowsComputerUse &&
			!String(params.serverName ?? "")
				.toLowerCase()
				.includes("computer-use") &&
			!serialized.includes("computeruse") &&
			!serialized.includes("computer-use") &&
			!serialized.includes("computer_use")
		) {
			// Hlid does not yet render arbitrary MCP form fields. Never turn an
			// unrelated elicitation into a blanket approval with empty content.
			return { action: "cancel", content: null, _meta: null };
		}
		if (typeof this.params.canUseTool !== "function") {
			return { action: "decline", content: null, _meta: null };
		}
		const details = computerUseApprovalDetails(params);
		const serverName = String(params.serverName ?? "MCP server");
		const appKey = details.appId ?? details.displayName;
		const task = this.delegatedWindowsComputerUseTask;
		const decision = await this.params.canUseTool(
			`hlid.windows_computer_use:${appKey}`,
			{
				...(task ? { task } : {}),
				appId: details.appId,
				appName: details.displayName,
				riskLevel: details.riskLevel,
				serverName,
				message: params.message,
			},
			{
				toolUseID: `codex-elicitation-${String(params.threadId ?? "thread")}-${++this.elicitationSequence}`,
				signal: this.params.signal ?? new AbortController().signal,
				title: `Allow Codex to use ${details.displayName}?`,
				displayName: `Windows Computer Use · ${details.displayName}`,
				description: [
					task ? `Desktop task: ${task}` : undefined,
					typeof params.message === "string" ? params.message : undefined,
				]
					.filter(Boolean)
					.join("\n\n"),
			},
		);
		if (decision.behavior !== "allow") {
			return { action: "decline", content: null, _meta: null };
		}
		return {
			action: "accept",
			content: null,
			_meta:
				decision.saveScope === "local"
					? { persist: "always" }
					: decision.saveScope === "session"
						? { persist: "session" }
						: null,
		};
	}

	private async handleServerRequest(
		method: string,
		rawParams: unknown,
	): Promise<unknown> {
		const params = asObj(rawParams);
		if (method === "item/tool/requestUserInput") {
			return this.handleRequestUserInput(params);
		}
		if (method === "item/tool/call") {
			return this.handleDynamicToolCall(params);
		}
		if (method === "mcpServer/elicitation/request") {
			// Computer Use app access must always flow through Hlid, even when the
			// surrounding Codex session uses bypassPermissions.
			return this.handleMcpElicitation(params);
		}
		if (
			!this.params.policyEnforced &&
			!this.params.usageGateEnforced &&
			autoApprovesPermissions(this.params)
		) {
			return this.allowedServerRequestResult(method, params);
		}
		if (typeof this.params.canUseTool !== "function") {
			return this.deniedServerRequestResult(method);
		}
		const itemId = String(params.itemId ?? params.approvalId ?? "approval");
		const startedItem = this.startedItems.get(itemId);
		const filePath =
			method === "item/fileChange/requestApproval" ||
			method === "applyPatchApproval"
				? (filePathFromItem(startedItem) ?? filePathFromItem(params))
				: null;
		const toolName = filePath ? "Write" : method;
		const toolInput = filePath ? { file_path: filePath } : params;
		const decision = await this.params.canUseTool(toolName, toolInput, {
			toolUseID: itemId,
			signal: this.params.signal ?? new AbortController().signal,
			title: "Codex wants approval",
			displayName: method,
			description:
				typeof params.reason === "string" ? params.reason : undefined,
		});
		const allowed = decision.behavior === "allow";
		if (
			allowed &&
			this.params.permissionMode === "plan" &&
			filePath &&
			isHtmlPlanPath(filePath)
		) {
			this.approvedHtmlPlanItemId = itemId;
		}
		return allowed
			? this.allowedServerRequestResult(method, params)
			: this.deniedServerRequestResult(method);
	}

	private async handleRequestUserInput(
		params: Record<string, unknown>,
	): Promise<{ answers: Record<string, { answers: string[] }> }> {
		if (typeof this.params.canUseTool !== "function") return { answers: {} };
		const itemId = String(params.itemId ?? "request-user-input");
		const decision = await this.params.canUseTool("AskUserQuestion", params, {
			toolUseID: itemId,
			signal: this.params.signal ?? new AbortController().signal,
			title: "Codex needs your input",
			displayName: "request_user_input",
		});
		if (decision.behavior !== "allow") return { answers: {} };

		const updatedAnswers = asObj(asObj(decision.updatedInput).answers);
		const answers: Record<string, { answers: string[] }> = {};
		for (const rawQuestion of Array.isArray(params.questions)
			? params.questions
			: []) {
			const question = asObj(rawQuestion);
			const id = typeof question.id === "string" ? question.id : "";
			const text =
				typeof question.question === "string" ? question.question : "";
			if (!id || !text) continue;
			const value = updatedAnswers[text];
			answers[id] = {
				answers: Array.isArray(value)
					? value.filter((item): item is string => typeof item === "string")
					: typeof value === "string" && value
						? [value]
						: [],
			};
		}
		return { answers };
	}

	private allowedServerRequestResult(
		method: string,
		params: Record<string, unknown>,
	): ApprovalRequestResult {
		if (method === "item/permissions/requestApproval") {
			// `params.permissions` arrives via the tolerant asObj() parse above
			// (inbound, not compile-time checked) — cast, don't re-derive.
			const permissions =
				(params.permissions as GrantedPermissionProfile | undefined) ?? {};
			return { scope: "session", permissions };
		}
		return { decision: "accept" };
	}

	private deniedServerRequestResult(method: string): ApprovalRequestResult {
		if (method === "item/permissions/requestApproval") {
			return { scope: "turn", permissions: {} };
		}
		return { decision: "decline" };
	}

	private resetTurnTracking(): void {
		this.streamedAgentMessageIds.clear();
		this.emittedReasoningIds.clear();
		this.sawUnidentifiedAgentMessageDelta = false;
		this.startedItems.clear();
		this.approvedHtmlPlanItemId = null;
		this.htmlPlanReady = false;
		this.nativePlanText = "";
	}

	private addQueryUsage(usage: CanonicalTokenUsage): void {
		this.queryUsage.inputTokens += usage.inputTokens;
		this.queryUsage.outputTokens += usage.outputTokens;
		this.queryUsage.cacheReadTokens += usage.cacheReadTokens;
		this.queryUsage.cacheCreationTokens += usage.cacheCreationTokens;
	}

	private resetQueryAccounting(): void {
		this.queryUsage = emptyCodexUsage();
		this.queryTurns = 0;
		this.queryWebSearchItemIds.clear();
		this.childLastUsage.clear();
	}

	private recordHostedToolItem(item: Record<string, unknown>): void {
		if (item.type !== "webSearch") return;
		const itemId = typeof item.id === "string" ? item.id : "";
		if (itemId) this.queryWebSearchItemIds.add(itemId);
	}

	private handleThreadStarted(obj: Record<string, unknown>): void {
		const id = asObj(obj.thread).id;
		if (typeof id !== "string") return;
		this.threadId = id;
		this.events.push({ type: "session_start", sessionId: id });
	}

	private handleTurnStarted(obj: Record<string, unknown>): void {
		const id = asObj(obj.turn).id;
		if (typeof id === "string") this.activeTurnId = id;
		this.resetTurnTracking();
		this.lastUsage = emptyCodexUsage();
	}

	private handleAgentMessageDelta(obj: Record<string, unknown>): void {
		const text = textFromUnknown(obj.delta ?? obj.text ?? obj.content);
		if (!text) return;
		const itemId = String(obj.itemId ?? obj.id ?? "");
		if (itemId) this.streamedAgentMessageIds.add(itemId);
		else this.sawUnidentifiedAgentMessageDelta = true;
		this.events.push({ type: "text_delta", text });
	}

	private handleCommandOutputDelta(obj: Record<string, unknown>): void {
		const encoded = obj.deltaBase64;
		if (typeof encoded !== "string") return;
		this.events.push({
			type: "local_command_output",
			content: Buffer.from(encoded, "base64").toString("utf8"),
		});
	}

	private emitReasoning(item: Record<string, unknown>): void {
		const text = codexReasoningText(item);
		const id = String(item.id ?? `reasoning-${this.activeTurnId ?? "turn"}`);
		if (!text || this.emittedReasoningIds.has(id)) return;
		this.emittedReasoningIds.add(id);
		this.events.push({
			type: "tool_start",
			toolId: id,
			name: "Reasoning",
			input: {},
		});
		this.events.push({ type: "tool_result", toolId: id, content: text });
	}

	private handleItemStarted(obj: Record<string, unknown>): void {
		const item = asObj(obj.item);
		this.recordHostedToolItem(item);
		const type = String(item.type ?? "tool");
		const itemId = String(item.id ?? type);
		const notificationThreadId = String(obj.threadId ?? this.threadId ?? "");
		if (notificationThreadId && notificationThreadId !== this.threadId) {
			this.updateSubagentFromChild(notificationThreadId, {
				currentStep: codexChildStep(item),
				status: "running",
			});
			return;
		}
		if (type === "subAgentActivity") {
			this.handleSubagentActivity(item);
			return;
		}
		this.startedItems.set(itemId, item);
		if (type === "agentMessage" || type === "userMessage") return;
		if (type === "reasoning") {
			this.emitReasoning(item);
			return;
		}
		const toolName = String(
			item.tool ?? item.toolName ?? item.name ?? item.command ?? type,
		);
		const input =
			item.arguments ?? item.input ?? item.rawInput ?? item.params ?? item;
		const collabTool = item.tool as CollabAgentTool | undefined;
		if (type === "collabAgentToolCall" && collabTool === "wait") {
			// `wait` is orchestration bookkeeping for already-visible subagent cards,
			// not a user-facing tool. The app-server often sends it with no receiver
			// IDs or state, which previously leaked a permanently empty generic tool
			// row into Raven.
			this.mergeCollabAgentStates(item);
			return;
		}
		if (type === "collabAgentToolCall" && collabTool === "spawnAgent") {
			const prompt = typeof item.prompt === "string" ? item.prompt : undefined;
			const subagent: SubagentSnapshot = {
				provider: "codex",
				agentId: itemId,
				...(prompt ? { prompt, currentStep: "Starting subagent" } : {}),
				...(typeof item.model === "string" ? { model: item.model } : {}),
				...(typeof item.reasoningEffort === "string"
					? { effort: item.reasoningEffort }
					: {}),
				status: "pending",
				startedAtMs:
					typeof obj.startedAtMs === "number" ? obj.startedAtMs : Date.now(),
			};
			this.subagentSnapshots.set(itemId, subagent);
			this.pendingSubagentToolIds.add(itemId);
			this.events.push({
				type: "tool_start",
				toolId: itemId,
				name: "spawn_agent",
				input: prompt ? { prompt } : input,
				subagent,
			});
			return;
		}
		this.events.push({
			type: "tool_start",
			toolId: itemId,
			name: toolName,
			input,
		});
	}

	private emitSubagentUpdate(toolId: string, subagent: SubagentSnapshot): void {
		this.subagentSnapshots.set(toolId, subagent);
		this.events.push({ type: "tool_update", toolId, subagent });
	}

	private updateSubagentFromChild(
		threadId: string,
		patch: Partial<SubagentSnapshot>,
	): void {
		const toolId = this.subagentByThread.get(threadId);
		if (!toolId) return;
		const current = this.subagentSnapshots.get(toolId);
		if (!current) return;
		this.emitSubagentUpdate(toolId, {
			...current,
			...patch,
			agentId: threadId,
		});
	}

	private handleSubagentActivity(item: Record<string, unknown>): void {
		const threadId = String(item.agentThreadId ?? "");
		if (!threadId) return;
		const activityId = String(item.id ?? "");
		const kind = item.kind as SubAgentActivityKind | undefined;
		const agentPath =
			typeof item.agentPath === "string" ? item.agentPath : undefined;
		const agentName = agentPath?.split("/").filter(Boolean).at(-1);
		const currentStep =
			kind === "interacted"
				? "Communicating with the parent agent"
				: kind === "interrupted"
					? "Subagent interrupted"
					: "Subagent started";
		const status: SubagentSnapshot["status"] =
			kind === "interrupted" ? "interrupted" : "running";

		// Current Codex collaboration calls can surface only a subAgentActivity
		// item: there is no preceding collabAgentToolCall/spawnAgent item to create
		// the card. The activity id is the original spawn call id, so treat it as
		// the originating tool when no snapshot exists yet.
		const toolId =
			this.subagentByThread.get(threadId) ||
			(activityId && this.subagentSnapshots.has(activityId)
				? activityId
				: this.pendingSubagentToolIds.values().next().value);
		if (toolId) {
			this.pendingSubagentToolIds.delete(toolId);
			this.subagentByThread.set(threadId, toolId);
			this.attachThread(threadId);
			this.updateSubagentFromChild(threadId, {
				...(agentName ? { name: agentName } : {}),
				...(agentPath ? { label: agentPath } : {}),
				status,
				currentStep,
				...(kind === "interrupted" ? { endedAtMs: Date.now() } : {}),
			});
			return;
		}
		if (!activityId) return;

		const now = Date.now();
		const subagent: SubagentSnapshot = {
			provider: "codex",
			agentId: threadId,
			...(agentName ? { name: agentName } : {}),
			...(agentPath ? { label: agentPath } : {}),
			...(this.resolvedModel || this.params.model
				? { model: this.resolvedModel ?? this.params.model }
				: {}),
			...(this.params.effort ? { effort: this.params.effort } : {}),
			status,
			currentStep,
			startedAtMs:
				typeof item.occurredAtMs === "number" ? item.occurredAtMs : now,
			...(kind === "interrupted" ? { endedAtMs: now } : {}),
		};
		this.subagentByThread.set(threadId, activityId);
		this.subagentSnapshots.set(activityId, subagent);
		this.attachThread(threadId);
		this.events.push({
			type: "tool_start",
			toolId: activityId,
			name: "spawn_agent",
			input: agentPath ? { agentPath } : {},
			subagent,
		});
	}

	private mergeCollabAgentStates(item: Record<string, unknown>): void {
		const receiverThreadIds = Array.isArray(item.receiverThreadIds)
			? item.receiverThreadIds.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0,
				)
			: [];
		const agentsStates = asObj(item.agentsStates) as Record<
			string,
			Partial<CollabAgentState>
		>;
		const sourceToolId = String(item.id ?? "");
		const sourceSnapshot = this.subagentSnapshots.get(sourceToolId);
		const collabTool = item.tool as CollabAgentTool | undefined;
		if (collabTool === "spawnAgent") {
			this.pendingSubagentToolIds.delete(sourceToolId);
		}
		for (const threadId of receiverThreadIds) {
			if (sourceSnapshot && collabTool === "spawnAgent") {
				this.subagentByThread.set(threadId, sourceToolId);
				this.attachThread(threadId);
			}
			const spawnToolId = this.subagentByThread.get(threadId);
			if (!spawnToolId) continue;
			const current = this.subagentSnapshots.get(spawnToolId);
			if (!current) continue;
			const state = agentsStates[threadId] ?? {};
			const status = codexSubagentStatus(state.status, current.status);
			const terminal =
				status === "completed" ||
				status === "failed" ||
				status === "interrupted";
			const message =
				typeof state.message === "string" ? state.message : undefined;
			this.emitSubagentUpdate(spawnToolId, {
				...current,
				agentId: threadId,
				status,
				...(message ? { currentStep: message.slice(0, 240) } : {}),
				...(terminal ? { endedAtMs: Date.now() } : {}),
			});
		}
	}

	private handleCompletedAgentMessage(item: Record<string, unknown>): void {
		const itemId = String(item.id ?? "");
		const alreadyStreamed = itemId
			? this.streamedAgentMessageIds.has(itemId)
			: this.sawUnidentifiedAgentMessageDelta;
		if (alreadyStreamed) return;
		const text = textFromUnknown(item.text ?? item.content);
		if (text) this.events.push({ type: "text_delta", text });
	}

	private handleItemCompleted(obj: Record<string, unknown>): void {
		const item = asObj(obj.item);
		this.recordHostedToolItem(item);
		const type = String(item.type ?? "");
		const itemId = String(item.id ?? type);
		const notificationThreadId = String(obj.threadId ?? this.threadId ?? "");
		if (notificationThreadId && notificationThreadId !== this.threadId) {
			if (type === "agentMessage") {
				const currentStep = shortStep(item.text ?? item.content);
				if (currentStep) {
					this.updateSubagentFromChild(notificationThreadId, { currentStep });
				}
			}
			return;
		}
		if (type === "subAgentActivity") {
			this.handleSubagentActivity(item);
			return;
		}
		if (itemId === this.approvedHtmlPlanItemId) this.htmlPlanReady = true;
		if (type === "agentMessage") {
			this.handleCompletedAgentMessage(item);
			return;
		}
		if (type === "reasoning") {
			this.emitReasoning(item);
			return;
		}
		if (type === "plan") {
			this.nativePlanText = textFromUnknown(item.text);
			return;
		}
		if (type === "userMessage" || !type) return;
		if (type === "collabAgentToolCall") {
			this.mergeCollabAgentStates(item);
			if (item.tool === "wait") return;
		}
		this.events.push({
			type: "tool_result",
			toolId: String(item.id ?? type),
			content: JSON.stringify(item),
		});
	}

	private recordUsage(usage: AgentEvent | null): void {
		if (usage?.type !== "usage") return;
		if (usage.model) this.resolvedModel = usage.model;
		this.lastUsage = {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens ?? 0,
			cacheCreationTokens: usage.cacheCreationTokens ?? 0,
		};
	}

	private handleTokenUsageUpdated(params: unknown): void {
		const usage = maybeUsage(params);
		if (usage?.type !== "usage") return;
		this.recordUsage(usage);
		this.events.push(usage);
	}

	private handleChildTokenUsageUpdated(
		threadId: string,
		params: unknown,
	): void {
		const usage = maybeUsage(params);
		if (usage?.type !== "usage") return;
		this.childLastUsage.set(threadId, {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens ?? 0,
			cacheCreationTokens: usage.cacheCreationTokens ?? 0,
		});
	}

	private handleMcpStartupStatus(obj: Record<string, unknown>): void {
		const servers = Array.isArray(obj.servers) ? obj.servers : [];
		this.events.push({
			type: "mcp_status",
			servers: servers.flatMap((server) => {
				const name = String(asObj(server).name ?? "");
				return name ? [{ name, status: "pending" as const }] : [];
			}),
		});
	}

	private async handleTurnCompleted(
		obj: Record<string, unknown>,
		params: unknown,
	): Promise<void> {
		const turn = asObj(obj.turn);
		this.recordUsage(maybeUsage(turn) ?? maybeUsage(params));
		this.addQueryUsage(this.lastUsage);
		this.queryTurns += 1;
		this.activeTurnId = null;
		if (this.params.permissionMode === "plan") {
			const plan =
				this.nativePlanText ||
				(this.htmlPlanReady || this.params.planHtmlPath
					? "HTML plan ready for review."
					: "Codex completed its plan.");
			const planDecision = await this.params.canUseTool(
				"ExitPlanMode",
				{ plan },
				{
					toolUseID: `codex-plan-${String(turn.id ?? "turn")}`,
					signal: this.params.signal ?? new AbortController().signal,
					title: "Codex completed its plan",
				},
			);
			if (
				planDecision.behavior === "deny" &&
				planDecision.message?.startsWith("User requested changes to the plan:")
			) {
				this.resetTurnTracking();
				await this.send(
					`${planDecision.message}\n\nRevise the plan accordingly. If an HTML plan path was specified earlier, replace that document with the revised plan and present it for approval again.`,
				);
				return;
			}
			if (planDecision.behavior === "allow") {
				this.params = {
					...this.params,
					permissionMode: this.params.implementationPermissionMode ?? "default",
				};
				this.resetTurnTracking();
				await this.send(
					"The user approved the plan. Implement it now, including the validation described in the plan. Do not create another plan unless implementation reveals a material blocker that requires user input.",
				);
				return;
			}
		}
		const queryUsage = { ...this.queryUsage };
		const queryTurns = this.queryTurns;
		const webSearchCalls = this.queryWebSearchItemIds.size;
		this.resetTurnTracking();
		this.events.push({
			type: "done",
			estimatedCost: estimateCodexCost(
				this.resolvedModel ?? this.params.model,
				queryUsage,
				{ webSearchCalls },
			),
			turns: queryTurns,
			durationMs: 0,
			stopReason: typeof turn.status === "string" ? turn.status : undefined,
			usage: queryUsage,
		});
		this.resetQueryAccounting();
		if (!this.endAfterTurn) return;
		this.detachAllThreads();
		this.conn = null;
		this.events.close();
	}

	private handleChildTurnCompleted(obj: Record<string, unknown>): void {
		const threadId = String(obj.threadId ?? "");
		if (!threadId || threadId === this.threadId) return;
		const turn = asObj(obj.turn);
		const reportedUsage = maybeUsage(turn) ?? maybeUsage(obj);
		const usage =
			reportedUsage?.type === "usage"
				? {
						inputTokens: reportedUsage.inputTokens,
						outputTokens: reportedUsage.outputTokens,
						cacheReadTokens: reportedUsage.cacheReadTokens ?? 0,
						cacheCreationTokens: reportedUsage.cacheCreationTokens ?? 0,
					}
				: this.childLastUsage.get(threadId);
		if (usage) {
			this.addQueryUsage(usage);
		}
		this.queryTurns += 1;
		this.childLastUsage.delete(threadId);
		const rawStatus = String(turn.status ?? "completed");
		const status: SubagentSnapshot["status"] =
			rawStatus === "failed" || rawStatus === "errored"
				? "failed"
				: rawStatus === "interrupted" || rawStatus === "cancelled"
					? "interrupted"
					: "completed";
		this.updateSubagentFromChild(threadId, {
			status,
			endedAtMs:
				typeof obj.completedAtMs === "number" ? obj.completedAtMs : Date.now(),
		});
	}

	private handleNotification(method: string, params: unknown): void {
		const obj = asObj(params);
		const notificationThreadId = String(
			obj.threadId ?? asObj(obj.thread).id ?? "",
		);
		const childNotification =
			notificationThreadId.length > 0 && notificationThreadId !== this.threadId;
		switch (method) {
			case "thread/started":
				if (!childNotification) this.handleThreadStarted(obj);
				break;
			case "turn/started":
				if (!childNotification) this.handleTurnStarted(obj);
				break;
			case "item/agentMessage/delta":
				if (!childNotification) this.handleAgentMessageDelta(obj);
				break;
			case "item/commandExecution/outputDelta":
				if (!childNotification) this.handleCommandOutputDelta(obj);
				break;
			case "item/started":
				this.handleItemStarted(obj);
				break;
			case "item/completed":
				this.handleItemCompleted(obj);
				break;
			case "account/rateLimits/updated":
				this.emitRateLimits(obj.rateLimits);
				break;
			case "thread/tokenUsage/updated":
				if (childNotification) {
					this.handleChildTokenUsageUpdated(notificationThreadId, params);
				} else this.handleTokenUsageUpdated(params);
				break;
			case "mcpServer/startupStatus/updated":
				this.handleMcpStartupStatus(obj);
				break;
			case "turn/completed":
				if (childNotification) this.handleChildTurnCompleted(obj);
				else void this.handleTurnCompleted(obj, params);
				break;
		}
	}
}

export class CodexProvider implements AgentProvider {
	readonly providerId = "codex";
	readonly label = "Codex";

	/** Offline fallback for listModels() — used when the live `model/list` RPC fails. */
	readonly models = [
		{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
		{ value: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
		{ value: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
		{ value: "gpt-5.5", label: "GPT-5.5" },
		{ value: "gpt-5.4", label: "GPT-5.4" },
	] as const;

	/** Offline fallback for listModels() effort info — used when the live `model/list` RPC fails. */
	readonly effortLevels = [
		{ value: "low", label: "Low", desc: "quick and light" },
		{ value: "medium", label: "Medium", desc: "balanced default" },
		{ value: "high", label: "High", desc: "deeper reasoning" },
		{ value: "xhigh", label: "X-High", desc: "deepest Codex reasoning" },
	] as const;

	readonly permissionModes = [
		{
			value: "default",
			label: "Ask for approval",
			desc: "asks before actions",
		},
		{
			value: "acceptEdits",
			label: "Auto-approve edits",
			desc: "edits can pass",
		},
		{
			value: "bypassPermissions",
			label: "Auto-approve all",
			desc: "no prompts",
		},
	] as const;

	readonly usageWindows = [
		{ windowId: "five_hour", label: "5-HOUR", windowSecs: 5 * 3600 },
		{ windowId: "weekly", label: "7-DAY", windowSecs: 7 * 86400 },
	] as const;

	async check(): Promise<{ available: boolean; reason?: string }> {
		const exe = resolveCodexExecutable();
		if (!exe) return { available: false, reason: "Codex CLI not found" };
		return { available: true };
	}

	async hostCapabilities(): Promise<
		Record<string, { label: string; available: boolean; reason?: string }>
	> {
		return { windowsComputerUse: cachedWindowsComputerUseCapability() };
	}

	async listModels(): Promise<ProviderModelInfo[]> {
		return fetchCodexModels();
	}

	query(params: AgentQueryParams): AgentSession {
		return new CodexAgentSession(params);
	}
}
