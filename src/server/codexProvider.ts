import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, resolve, win32 } from "node:path";
import { parse as parseToml } from "smol-toml";
import { resolveCodexExecutable } from "../lib/codexPath";
import {
	type CanonicalTokenUsage,
	canonicalizeCodexUsage,
	estimateCodexCost,
} from "../lib/codexPricing";
import {
	buildHlidToolLoadingSummary,
	describeHlidToolLoading,
	HLID_CREATE_VISUALIZATION_TOOL,
	HLID_WINDOWS_COMPUTER_USE_TOOL,
} from "../lib/hlidContext";
import { APP_DIR, toLogical } from "../lib/paths";
import { runBoundedProcess } from "../lib/process";
import type {
	ProviderAppAuthenticationRequest,
	ProviderAppAuthenticationStart,
	ProviderAppCatalogPage,
	ProviderAppCatalogRequest,
} from "../lib/providerAppTypes";
import { compareProviderBackgroundActivity } from "../lib/providerBackgroundActivity";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	AgentToolDecision,
	ForkSessionParams,
	ForkSessionResult,
	McpServerStatus,
	ProviderApprovalReviewContext,
	ProviderApprovalsReviewer,
	ProviderBackgroundActivity,
	ProviderBackgroundActivityControl,
	ProviderEffortInfo,
	ProviderGoalControl,
	ProviderGoalControlResult,
	ProviderModelInfo,
	ProviderRealtimeActivity,
	ProviderRealtimeEvent,
	ProviderRealtimeStart,
	ProviderRealtimeStartResult,
	ProviderSkillInfo,
	ProviderThreadGoal,
	ProviderWindowReading,
	SendOptions,
	SlashCommand,
	SubagentSnapshot,
} from "./agentProvider";
import { ingestVisualizationHtml } from "./attachments";
import { openInBrowser } from "./browser";
import {
	acquireCodexAppServer,
	CodexAppServer,
	type CodexAppServerLaunch,
	type ServerRequestContext,
	type ThreadHandler,
} from "./codexAppServer";
import { type CodexAppAuthAttempt, mapCodexAppCatalogPage } from "./codexApps";
import {
	discoverCodexProviderCapabilities,
	readCodexPermissionProfiles,
} from "./codexCapabilityDiscovery";
import type {
	AppsInstalledParams,
	AppsInstalledResponse,
	AppsListParams,
	AppsListResponse,
	AppsReadParams,
	AppsReadResponse,
	CollabAgentState,
	CollabAgentStatus,
	CollabAgentTool,
	CommandExecutionRequestApprovalParams,
	CommandExecutionRequestApprovalResponse,
	DynamicToolCallResponse,
	DynamicToolSpec,
	FileChangeRequestApprovalParams,
	FileChangeRequestApprovalResponse,
	SandboxMode as GeneratedSandboxMode,
	GrantedPermissionProfile,
	ListMcpServerStatusParams,
	ListMcpServerStatusResponse,
	McpServerElicitationRequestResponse,
	McpServerOauthLoginParams,
	McpServerOauthLoginResponse,
	McpServerStatusUpdatedNotification,
	Model,
	ModelListParams,
	ModelListResponse,
	ModelReroutedNotification,
	PermissionProfileSummary,
	PermissionsRequestApprovalResponse,
	RateLimitSnapshot,
	RealtimeVoice,
	ReasoningEffortOption,
	SandboxPolicy,
	SubAgentActivityKind,
	ThreadBackgroundTerminalsCleanParams,
	ThreadBackgroundTerminalsListParams,
	ThreadBackgroundTerminalsListResponse,
	ThreadBackgroundTerminalsTerminateParams,
	ThreadBackgroundTerminalsTerminateResponse,
	ThreadCompactStartParams,
	ThreadCompactStartResponse,
	ThreadForkParams,
	ThreadForkResponse,
	ThreadGoalClearedNotification,
	ThreadGoalClearParams,
	ThreadGoalClearResponse,
	ThreadGoalGetParams,
	ThreadGoalGetResponse,
	ThreadGoalSetParams,
	ThreadGoalSetResponse,
	ThreadGoalUpdatedNotification,
	ThreadItemsListParams,
	ThreadItemsListResponse,
	ThreadRealtimeAppendSpeechParams,
	ThreadRealtimeClosedNotification,
	ThreadRealtimeErrorNotification,
	ThreadRealtimeSdpNotification,
	ThreadRealtimeStartedNotification,
	ThreadRealtimeStartParams,
	ThreadRealtimeStopParams,
	ThreadRealtimeTranscriptDeltaNotification,
	ThreadRealtimeTranscriptDoneNotification,
	ThreadResumeParams,
	ThreadResumeResponse,
	ThreadSettingsUpdatedNotification,
	ThreadStartParams,
	ThreadStartResponse,
	TurnStartParams,
	TurnSteerParams,
	UserInput,
} from "./codexProtocol";
import {
	CODEX_REALTIME_ACCOUNT_UNAVAILABLE,
	markCodexRealtimeBackendAccepted,
	markCodexRealtimeBackendError,
} from "./codexRealtimeStatus";
import { bumpDataRevision } from "./dataRevision";
import { resolveProviderExecutableForCwd } from "./executionContext";
import {
	executeHlidAgentToolRich,
	HLID_AGENT_NAMESPACE,
	HLID_AGENT_NAMESPACE_DESCRIPTION,
	HLID_AGENT_TOOL_SPECS,
} from "./hlidAgentTools";
import { isHtmlPlanPath } from "./htmlPlanPath";
import {
	prepareLibrary,
	visualizationStagingJobDirectory,
} from "./libraryStore";
import {
	executeObsidianAgentTool,
	isObsidianAgentToolReadOnly,
	OBSIDIAN_AGENT_NAMESPACE,
	OBSIDIAN_AGENT_NAMESPACE_DESCRIPTION,
	OBSIDIAN_AGENT_TOOL_SPECS,
} from "./obsidianAgentTools";
import {
	parseProviderElicitationFields,
	providerElicitationContent,
	providerElicitationDecisionAnswers,
	providerElicitationQuestions,
	providerElicitationSelectedAnswer,
	providerElicitationWasCancelled,
	safeProviderElicitationUrl,
} from "./providerElicitation";
import { codexPlanActivity } from "./taskActivity";
import {
	createWindowsVisualizeRenderInput,
	extractWindowsVisualizeArtifact,
} from "./windowsVisualizeArtifact";

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

type ProviderRealtimeEventHandler = (event: ProviderRealtimeEvent) => void;

type OwnedSpeechRuntime = {
	mode: Exclude<ProviderRealtimeStart["mode"], "live">;
	conn: CodexAppServer;
	threadId: string | null;
	handler: ThreadHandler | null;
	eventHandler: ProviderRealtimeEventHandler;
	started: boolean;
	cleaned: boolean;
	threadReleased: boolean;
	realtimeStartRequested: boolean;
	stopRequested: boolean;
	startCancelled: Promise<never>;
	cancelStart: (error: Error) => void;
};

const CODEX_REALTIME_STOP_CLOSE_GRACE_MS = 2_000;
const CODEX_SPEECH_RELEASE_TIMEOUT_MS = 2_000;
const CODEX_APP_LIST_INITIAL_TIMEOUT_MS = 4_000;
const CODEX_APP_INVENTORY_REFRESH_TIMEOUT_MS = 15_000;
const CODEX_SPEECH_REGISTRY_VERSION = "hlid-speech-v1";

const CODEX_SPEECH_DEVELOPER_INSTRUCTIONS =
	"This is an isolated speech-only thread. Do not use tools, read or write files, access the network, take actions, or produce ordinary chat responses. For dictation, only transcribe the user's speech through realtime transcript events. For read-aloud, only speak the exact client-supplied text.";

const CODEX_READ_ALOUD_REALTIME_PROMPT =
	"You are a literal speech renderer. Whenever text arrives on the speakable channel, say exactly that text verbatim, once. Do not acknowledge it, summarize it, paraphrase it, add words, omit words, or respond to silence. Never delegate.";

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

function isProviderRealtimeActivity(
	event: AgentEvent,
): event is ProviderRealtimeActivity {
	return (
		event.type === "tool_start" ||
		event.type === "tool_update" ||
		event.type === "tool_activity_update" ||
		event.type === "tool_progress" ||
		event.type === "tool_result" ||
		event.type === "generated_media"
	);
}

function asObj(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function serverRequestSignal(
	requestSignal: AbortSignal,
	sessionSignal: AbortSignal | undefined,
): AbortSignal {
	return sessionSignal
		? AbortSignal.any([sessionSignal, requestSignal])
		: requestSignal;
}

function serverRequestToolUseId(
	params: Record<string, unknown>,
	requestId: ServerRequestContext["requestId"] | undefined,
): string {
	if (typeof params.approvalId === "string" && params.approvalId) {
		return params.approvalId;
	}
	return (
		nativeServerRequestToolUseId(requestId) ??
		String(params.itemId ?? "approval")
	);
}

function nativeServerRequestToolUseId(
	requestId: ServerRequestContext["requestId"] | undefined,
): string | null {
	// JSON-RPC string and numeric ids occupy distinct namespaces. Preserve that
	// distinction so two live native requests can never share one Hlid card.
	if (typeof requestId === "string" && requestId) {
		return `codex-request:string:${requestId}`;
	}
	if (typeof requestId === "number" && Number.isFinite(requestId)) {
		return `codex-request:number:${requestId}`;
	}
	return null;
}

const CODEX_MCP_STATUS_PAGE_SIZE = 100;
const CODEX_MCP_STATUS_MAX_PAGES = 32;

async function readCodexMcpServerStatuses(
	request: (
		params: ListMcpServerStatusParams,
		timeoutMs: number,
	) => Promise<unknown>,
	options: {
		detail: NonNullable<ListMcpServerStatusParams["detail"]>;
		timeoutMs: number;
	},
): Promise<ListMcpServerStatusResponse> {
	const data: ListMcpServerStatusResponse["data"] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	let nextCursor: string | null = null;
	for (let page = 0; page < CODEX_MCP_STATUS_MAX_PAGES; page++) {
		const response = asObj(
			await request(
				{
					limit: CODEX_MCP_STATUS_PAGE_SIZE,
					detail: options.detail,
					...(cursor ? { cursor } : {}),
				},
				options.timeoutMs,
			),
		);
		const pageData = Array.isArray(response.data)
			? response.data
			: page === 0 && Array.isArray(response.servers)
				? response.servers
				: [];
		data.push(...(pageData as ListMcpServerStatusResponse["data"]));
		nextCursor =
			typeof response.nextCursor === "string" && response.nextCursor.trim()
				? response.nextCursor
				: null;
		if (!nextCursor || seenCursors.has(nextCursor)) {
			return { data, nextCursor: null };
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}
	return { data, nextCursor };
}

function isMissingRolloutError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /no rollout found for thread id/i.test(message);
}

function codexActiveTurnMismatch(error: unknown): {
	expectedTurnId: string;
	actualTurnId: string;
} | null {
	const message = error instanceof Error ? error.message : String(error);
	const match = message.match(
		/expected active turn id\s+[`'"]?([0-9a-f-]+)[`'"]?\s+but found\s+[`'"]?([0-9a-f-]+)[`'"]?/i,
	);
	if (!match?.[1] || !match[2]) return null;
	return { expectedTurnId: match[1], actualTurnId: match[2] };
}

function codexTurnAlreadySettled(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /no active turn(?: to interrupt)?|active turn (?:was |is )?(?:already )?(?:complete|completed|settled)|turn .+ (?:was |is )?(?:already )?(?:complete|completed|not active)/i.test(
		message,
	);
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

const WINDOWS_COMPUTER_USE_NAMESPACE = HLID_AGENT_NAMESPACE;
const WINDOWS_COMPUTER_USE_TOOL = HLID_WINDOWS_COMPUTER_USE_TOOL;
const WINDOWS_VISUALIZE_NAMESPACE = HLID_AGENT_NAMESPACE;
const WINDOWS_VISUALIZE_TOOL = HLID_CREATE_VISUALIZATION_TOOL;
const CODEX_ELICITATION_URL_QUESTION =
	"How should Hlid answer this browser-based request?";
const CODEX_ELICITATION_URL_CONTINUE =
	"Continue after completing the browser step";
const CODEX_ELICITATION_URL_DECLINE = "Decline this request";
const DEFAULT_WINDOWS_COMPUTER_USE_MODEL = "gpt-5.4";
const DEFAULT_WINDOWS_COMPUTER_USE_EFFORT = "medium";
const CODEX_CHILD_SETTLE_TIMEOUT_MS = 10 * 60_000;
const WINDOWS_VISUALIZE_RENDER_TIMEOUT_MS = 30_000;
const WINDOWS_VISUALIZE_WORKER_TIMEOUT_MS = 5 * 60_000;
const WINDOWS_VISUALIZE_FAILURE_MESSAGE =
	"Hlid could not create the visualization.";

type WindowsVisualizeSkill = {
	name: "visualize:visualize";
	path: string;
	renderScript: string;
};

type WindowsComputerUseResult = {
	text: string;
	threadId: string;
	usage: CanonicalTokenUsage;
	turns: number;
	durationMs: number;
	estimatedCost?: number | null;
};

class WindowsComputerUseError extends Error {
	constructor(
		message: string,
		readonly completion?: WindowsComputerUseResult,
	) {
		super(message);
		this.name = "WindowsComputerUseError";
	}
}

type WindowsVisualizeResult = WindowsComputerUseResult & {
	attachmentId: string;
	filename: string;
	title: string;
};

class WindowsVisualizeError extends Error {
	constructor(
		message: string,
		readonly completion?: WindowsComputerUseResult,
	) {
		super(message);
		this.name = "WindowsVisualizeError";
	}
}

type DelegatedWindowsWorker =
	| { kind: "computer-use"; task: string }
	| { kind: "visualize"; task: string };

type CodexDoneEvent = Extract<AgentEvent, { type: "done" }>;

function windowsWorkerCompletion(
	completion: CodexDoneEvent,
	text: string,
	threadId: string,
): WindowsComputerUseResult {
	return {
		text,
		threadId,
		usage: {
			inputTokens: completion.usage?.inputTokens ?? 0,
			outputTokens: completion.usage?.outputTokens ?? 0,
			cacheReadTokens: completion.usage?.cacheReadTokens ?? 0,
			cacheCreationTokens: completion.usage?.cacheCreationTokens ?? 0,
		},
		turns: completion.turns,
		durationMs: completion.durationMs,
		estimatedCost: completion.estimatedCost,
	};
}

function windowsWorkerUsage(
	event: Extract<AgentEvent, { type: "usage" }>,
): CanonicalTokenUsage {
	return event.queryUsage
		? { ...event.queryUsage }
		: {
				inputTokens: event.inputTokens,
				outputTokens: event.outputTokens,
				cacheReadTokens: event.cacheReadTokens ?? 0,
				cacheCreationTokens: event.cacheCreationTokens ?? 0,
			};
}

function partialWindowsWorkerCompletion(opts: {
	usage: CanonicalTokenUsage;
	model: string;
	threadId: string;
	startedAtMs: number;
}): WindowsComputerUseResult {
	return {
		text: "",
		threadId: opts.threadId,
		usage: opts.usage,
		turns: 1,
		durationMs: Math.max(0, Date.now() - opts.startedAtMs),
		estimatedCost: estimateCodexCost(opts.model, opts.usage),
	};
}

function updateWindowsWorkerText(
	text: string,
	event: AgentEvent,
): string | null {
	if (event.type === "assistant_message_boundary") {
		if (!text || text.endsWith("\n\n")) return text;
		return text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
	}
	if (event.type === "text_delta") return text + event.text;
	if (event.type !== "text_replace" || !text.endsWith(event.previousText)) {
		return null;
	}
	return text.slice(0, text.length - event.previousText.length) + event.text;
}

function attachedWindowsWorkerSnapshot(
	snapshot: SubagentSnapshot,
	agentId: string,
	currentStep: string,
): SubagentSnapshot {
	return { ...snapshot, agentId, currentStep };
}

function dynamicToolFailure(error: unknown): DynamicToolCallResponse {
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

type PendingCodexDone = {
	turn: Record<string, unknown>;
	timer: ReturnType<typeof setTimeout>;
};

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

function windowsPathApi(path: string): typeof posix | typeof win32 {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.includes("\\") ? win32 : posix;
}

function codexHomeDirectory(): string {
	return process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex");
}

function pathComparisonKey(
	pathApi: typeof posix | typeof win32,
	path: string,
): string {
	const normalized = pathApi.normalize(path);
	if (pathApi !== win32) return normalized;
	const withoutNamespace = normalized.startsWith("\\\\?\\")
		? normalized.slice(4)
		: normalized;
	return withoutNamespace.toLowerCase();
}

function pathRelativeWithin(
	pathApi: typeof posix | typeof win32,
	root: string,
	target: string,
): string | null {
	const relative = pathApi.relative(root, target);
	if (
		!relative ||
		relative === ".." ||
		relative.startsWith(`..${pathApi.sep}`) ||
		pathApi.isAbsolute(relative)
	) {
		return null;
	}
	return relative;
}

async function assertRegularUnlinkedPath(
	pathApi: typeof posix | typeof win32,
	root: string,
	relative: string,
): Promise<void> {
	const rootStat = await lstat(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new Error("Visualize package cache root is not a regular directory");
	}
	const segments = relative.split(/[\\/]+/).filter(Boolean);
	let current = root;
	for (const [index, segment] of segments.entries()) {
		current = pathApi.resolve(current, segment);
		const stat = await lstat(current);
		if (stat.isSymbolicLink()) {
			throw new Error("Visualize package contains a symbolic link");
		}
		const final = index === segments.length - 1;
		if ((final && !stat.isFile()) || (!final && !stat.isDirectory())) {
			throw new Error(
				final
					? "Visualize package entry is not a regular file"
					: "Visualize package entry is not a regular directory",
			);
		}
	}
}

async function trustedWindowsVisualizeSkill(
	candidate: Record<string, unknown>,
): Promise<WindowsVisualizeSkill | null> {
	if (
		String(candidate.name ?? "").trim() !== "visualize:visualize" ||
		candidate.enabled !== true ||
		typeof candidate.path !== "string" ||
		!candidate.path.trim()
	) {
		return null;
	}

	const requestedSkillPath = candidate.path.trim();
	const pathApi = windowsPathApi(requestedSkillPath);
	if (!pathApi.isAbsolute(requestedSkillPath)) return null;
	const cacheRoot = pathApi.resolve(
		codexHomeDirectory(),
		"plugins",
		"cache",
		"openai-bundled",
		"visualize",
	);
	try {
		const configuredCacheStat = await lstat(cacheRoot);
		if (
			configuredCacheStat.isSymbolicLink() ||
			!configuredCacheStat.isDirectory()
		) {
			return null;
		}
		const [canonicalCacheRoot, canonicalSkillPath] = await Promise.all([
			realpath(cacheRoot),
			realpath(requestedSkillPath),
		]);
		if (
			pathComparisonKey(pathApi, canonicalSkillPath) !==
			pathComparisonKey(pathApi, pathApi.resolve(requestedSkillPath))
		) {
			return null;
		}
		const skillRelative = pathRelativeWithin(
			pathApi,
			canonicalCacheRoot,
			canonicalSkillPath,
		);
		if (!skillRelative) return null;
		const skillParts = skillRelative.split(/[\\/]+/);
		const normalizedSkillParts =
			pathApi === win32
				? skillParts.map((part) => part.toLowerCase())
				: skillParts;
		if (
			skillParts.length !== 4 ||
			!/^[a-zA-Z0-9._-]+$/.test(skillParts[0] ?? "") ||
			[".", ".."].includes(skillParts[0] ?? "") ||
			normalizedSkillParts[1] !== "skills" ||
			normalizedSkillParts[2] !== "visualize" ||
			normalizedSkillParts[3] !== (pathApi === win32 ? "skill.md" : "SKILL.md")
		) {
			return null;
		}
		await assertRegularUnlinkedPath(pathApi, canonicalCacheRoot, skillRelative);

		const requestedRenderScript = pathApi.resolve(
			pathApi.dirname(canonicalSkillPath),
			"scripts",
			"render.py",
		);
		const canonicalRenderScript = await realpath(requestedRenderScript);
		if (
			pathComparisonKey(pathApi, canonicalRenderScript) !==
			pathComparisonKey(pathApi, requestedRenderScript)
		) {
			return null;
		}
		const renderRelative = pathRelativeWithin(
			pathApi,
			canonicalCacheRoot,
			canonicalRenderScript,
		);
		if (!renderRelative) return null;
		await assertRegularUnlinkedPath(
			pathApi,
			canonicalCacheRoot,
			renderRelative,
		);
		return {
			name: "visualize:visualize",
			path: canonicalSkillPath,
			renderScript: canonicalRenderScript,
		};
	} catch {
		return null;
	}
}

async function renderWindowsVisualization(
	skill: WindowsVisualizeSkill,
	fragmentPath: string,
	destinationPath: string,
	title: string,
	jobRoot: string,
): Promise<void> {
	const configured = process.env.HLID_WINDOWS_VISUALIZE_PYTHON?.trim();
	const candidates = configured
		? [{ executable: configured, prefix: [] as string[] }]
		: [
				{ executable: "python", prefix: [] as string[] },
				{ executable: "py", prefix: ["-3"] },
				{ executable: "python3", prefix: [] as string[] },
			];
	const failures: string[] = [];
	for (const candidate of candidates) {
		try {
			const result = await runBoundedProcess(
				candidate.executable,
				[
					...candidate.prefix,
					skill.renderScript,
					fragmentPath,
					destinationPath,
					"--title",
					title,
				],
				{
					cwd: jobRoot,
					timeoutMs: WINDOWS_VISUALIZE_RENDER_TIMEOUT_MS,
					timeoutError: "Visualize renderer timed out",
					maxOutputChars: 4_096,
				},
			);
			if (result.code === 0) return;
			failures.push(
				`${candidate.executable} exited ${String(result.code)}${result.output ? `: ${result.output.trim()}` : ""}`,
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "Visualize renderer timed out"
			) {
				throw error;
			}
			failures.push(
				`${candidate.executable}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	throw new Error(`Visualize renderer failed (${failures.join("; ")})`);
}

function cleanupWindowsVisualizeJobRoot(
	jobRoot: string,
	attemptsRemaining = 3,
): void {
	try {
		rmSync(jobRoot, { recursive: true, force: true });
	} catch (error) {
		if (attemptsRemaining > 1) {
			const retry = setTimeout(
				() => cleanupWindowsVisualizeJobRoot(jobRoot, attemptsRemaining - 1),
				500,
			);
			retry.unref();
			return;
		}
		console.warn(
			"[codex] failed to clean Windows Visualize staging:",
			error instanceof Error ? error.message : String(error),
		);
	}
}

function visualizationTitle(filename: string): string {
	return filename
		.replace(/\.html$/i, "")
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function windowsComputerUseHostAvailable(
	platform = process.platform,
	executable = resolveCodexExecutable(),
): executable is string {
	return platform === "win32" && Boolean(executable);
}

type WindowsComputerUseCapability = {
	label: string;
	available: boolean;
	reason?: string;
};

type WindowsVisualizeCapability = {
	label: string;
	available: boolean;
	reason?: string;
};

type WindowsVisualizeProbeResult = {
	capability: WindowsVisualizeCapability;
	skill: WindowsVisualizeSkill | null;
};

export type CodexHostCapabilities = {
	windowsComputerUse: WindowsComputerUseCapability;
	windowsVisualize: WindowsVisualizeCapability;
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
		const loaded = await codexPluginEnabled("computer-use");
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

let windowsVisualizeSkill: WindowsVisualizeSkill | null = null;

async function codexPluginEnabled(
	name: string,
	marketplace?: string,
): Promise<boolean> {
	const codexHome = codexHomeDirectory();
	const config = parseToml(
		await readFile(resolve(codexHome, "config.toml"), "utf8"),
	) as {
		plugins?: Record<string, { enabled?: unknown }>;
	};
	const expectedId = marketplace
		? `${name}@${marketplace}`.toLowerCase()
		: null;
	return Object.entries(config.plugins ?? {}).some(
		([id, plugin]) =>
			(expectedId
				? id.toLowerCase() === expectedId
				: id.split("@", 1)[0]?.toLowerCase() === name) &&
			plugin?.enabled === true,
	);
}

async function probeWindowsVisualizeCapability(): Promise<WindowsVisualizeProbeResult> {
	const label = "Windows Visualize";
	if (process.platform !== "win32") {
		return {
			capability: {
				label,
				available: false,
				reason: "Hlid is not running on Windows",
			},
			skill: null,
		};
	}
	const executable = resolveCodexExecutable();
	if (!executable) {
		return {
			capability: {
				label,
				available: false,
				reason: "Native Codex CLI not found",
			},
			skill: null,
		};
	}

	const configured = await codexPluginEnabled("visualize", "openai-bundled");
	if (!configured) {
		return {
			capability: {
				label,
				available: false,
				reason: "Visualize plugin is not installed or enabled",
			},
			skill: null,
		};
	}

	const workspace = resolve(APP_DIR, "windows-visualize");
	mkdirSync(workspace, { recursive: true });
	const launch = codexLaunchConfig({ cwd: workspace, executable });
	const conn = new CodexAppServer(launch.appServer);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			(async () => {
				await conn.ready;
				return conn.request(
					"skills/list",
					{ cwds: [launch.rpcCwd], forceReload: true },
					HOST_CAPABILITY_TIMEOUT_MS,
				);
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					const error = new Error("Visualize native skills probe timed out");
					conn.kill(error);
					reject(error);
				}, HOST_CAPABILITY_TIMEOUT_MS);
			}),
		]);
		let skill: WindowsVisualizeSkill | null = null;
		for (const candidate of skillsFromListResponse(result)) {
			skill = await trustedWindowsVisualizeSkill(candidate);
			if (skill) break;
		}
		if (!skill) {
			return {
				capability: {
					label,
					available: false,
					reason: "Native Codex did not load the trusted Visualize skill",
				},
				skill: null,
			};
		}
		return { capability: { label, available: true }, skill };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		conn.kill(new Error("Windows Visualize capability probe complete"));
	}
}

const HOST_CAPABILITY_TTL_MS = 60_000;
const HOST_CAPABILITY_FAILURE_TTL_MS = 15_000;
const HOST_CAPABILITY_TIMEOUT_MS = 5_000;
let hostCapabilitySnapshot: WindowsComputerUseCapability | null = null;
let hostCapabilityRefreshedAt = 0;
let hostCapabilityFailedAt = 0;
let hostCapabilityInflight: Promise<WindowsComputerUseCapability> | null = null;
let visualizeCapabilitySnapshot: WindowsVisualizeCapability | null = null;
let visualizeCapabilityRefreshedAt = 0;
let visualizeCapabilityFailedAt = 0;
let visualizeCapabilityFailure: WindowsVisualizeCapability | null = null;
let visualizeCapabilityInflight: Promise<WindowsVisualizeCapability> | null =
	null;
let visualizeCapabilityInflightForced = false;
let visualizeCapabilityGeneration = 0;

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

function fallbackWindowsVisualizeCapability(
	error?: unknown,
): WindowsVisualizeCapability {
	const label = "Windows Visualize";
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

async function boundedWindowsVisualizeProbe(): Promise<WindowsVisualizeProbeResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		probeWindowsVisualizeCapability(),
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Visualize capability check timed out")),
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

async function refreshWindowsVisualizeCapability(
	force = false,
): Promise<WindowsVisualizeCapability> {
	// A direct Windows-side plugin toggle can happen outside Hlid's extension
	// mutation route. An explicit use/new thread must not inherit an older
	// background probe or the normal capability TTL. Concurrent explicit
	// callers share the same fresh probe instead of superseding each other.
	if (force && visualizeCapabilityInflight) {
		if (visualizeCapabilityInflightForced) {
			return visualizeCapabilityInflight;
		}
		visualizeCapabilityGeneration += 1;
		visualizeCapabilityInflight = null;
		visualizeCapabilityInflightForced = false;
	}
	const now = Date.now();
	if (
		!force &&
		visualizeCapabilitySnapshot &&
		now - visualizeCapabilityRefreshedAt < HOST_CAPABILITY_TTL_MS
	) {
		return visualizeCapabilitySnapshot;
	}
	if (
		!force &&
		!visualizeCapabilitySnapshot &&
		visualizeCapabilityFailedAt > 0 &&
		now - visualizeCapabilityFailedAt < HOST_CAPABILITY_FAILURE_TTL_MS
	) {
		return visualizeCapabilityFailure ?? fallbackWindowsVisualizeCapability();
	}
	if (visualizeCapabilityInflight) return visualizeCapabilityInflight;

	const generation = visualizeCapabilityGeneration;
	const refresh = boundedWindowsVisualizeProbe()
		.then((result) => {
			const { capability, skill } = result;
			if (generation !== visualizeCapabilityGeneration) {
				return (
					visualizeCapabilitySnapshot ??
					visualizeCapabilityFailure ??
					fallbackWindowsVisualizeCapability()
				);
			}
			const previous = visualizeCapabilitySnapshot;
			visualizeCapabilitySnapshot = capability;
			visualizeCapabilityRefreshedAt = Date.now();
			visualizeCapabilityFailedAt = 0;
			visualizeCapabilityFailure = null;
			windowsVisualizeSkill = skill;
			if (capabilityChanged(previous, capability)) {
				bumpDataRevision("providers");
			}
			return capability;
		})
		.catch((error) => {
			const failure = fallbackWindowsVisualizeCapability(error);
			if (generation !== visualizeCapabilityGeneration) {
				return (
					visualizeCapabilitySnapshot ??
					visualizeCapabilityFailure ??
					fallbackWindowsVisualizeCapability()
				);
			}
			const previous = visualizeCapabilitySnapshot;
			visualizeCapabilitySnapshot = null;
			visualizeCapabilityFailedAt = Date.now();
			visualizeCapabilityFailure = failure;
			windowsVisualizeSkill = null;
			if (capabilityChanged(previous, failure)) {
				bumpDataRevision("providers");
			}
			return failure;
		})
		.finally(() => {
			if (visualizeCapabilityInflight === refresh) {
				visualizeCapabilityInflight = null;
				visualizeCapabilityInflightForced = false;
			}
		});
	visualizeCapabilityInflight = refresh;
	visualizeCapabilityInflightForced = force;
	return refresh;
}

function cachedWindowsVisualizeCapability(): WindowsVisualizeCapability {
	const capability =
		visualizeCapabilitySnapshot ??
		visualizeCapabilityFailure ??
		fallbackWindowsVisualizeCapability();
	if (
		!visualizeCapabilitySnapshot ||
		Date.now() - visualizeCapabilityRefreshedAt >= HOST_CAPABILITY_TTL_MS
	) {
		void refreshWindowsVisualizeCapability().catch(() => {});
	}
	return capability;
}

/** Force a bounded live refresh for an explicit provider-catalog refresh. */
export async function refreshCodexHostCapabilities(): Promise<CodexHostCapabilities> {
	const [windowsComputerUse, windowsVisualize] = await Promise.all([
		refreshWindowsComputerUseCapability(true),
		refreshWindowsVisualizeCapability(true),
	]);
	return { windowsComputerUse, windowsVisualize };
}

/** Drop cached host-plugin readiness after a provider extension mutation. */
export function invalidateCodexHostCapabilities(): void {
	visualizeCapabilityGeneration += 1;
	hostCapabilitySnapshot = null;
	hostCapabilityRefreshedAt = 0;
	hostCapabilityFailedAt = 0;
	hostCapabilityInflight = null;
	visualizeCapabilitySnapshot = null;
	visualizeCapabilityRefreshedAt = 0;
	visualizeCapabilityFailedAt = 0;
	visualizeCapabilityFailure = null;
	visualizeCapabilityInflight = null;
	visualizeCapabilityInflightForced = false;
	windowsVisualizeSkill = null;
}

// fallow-ignore-next-line unused-export -- Test-only reset for module-level cache isolation.
export function __resetCodexHostCapabilitiesForTesting(): void {
	invalidateCodexHostCapabilities();
}
function hlidHostTools(
	computerUseAvailable: boolean,
	visualizeAvailable: boolean,
): DynamicToolSpec[] {
	return [
		{
			type: "namespace",
			name: HLID_AGENT_NAMESPACE,
			description: HLID_AGENT_NAMESPACE_DESCRIPTION,
			tools: [
				...HLID_AGENT_TOOL_SPECS.map((spec) => ({
					type: "function" as const,
					name: spec.name,
					description: spec.description,
					inputSchema: spec.inputSchema,
					deferLoading: spec.deferLoading,
				})),
				...(computerUseAvailable
					? [
							{
								type: "function" as const,
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
						]
					: []),
				...(visualizeAvailable
					? [
							{
								type: "function" as const,
								name: WINDOWS_VISUALIZE_TOOL,
								description:
									"Create an interactive in-conversation visualization through a fresh Windows-native Codex Visualize worker and attach it inline in Raven. Use this instead of emitting ::codex-inline-vis text directly.",
								inputSchema: {
									type: "object",
									properties: {
										request: {
											type: "string",
											description:
												"What the visualization should help the user see or explore.",
										},
										context: {
											type: "string",
											description:
												"Optional data, constraints, or visual context needed by the worker.",
										},
									},
									required: ["request"],
									additionalProperties: false,
								},
							},
						]
					: []),
			],
		},
	];
}

function obsidianTools(): DynamicToolSpec[] {
	return [
		{
			type: "namespace",
			name: OBSIDIAN_AGENT_NAMESPACE,
			description: OBSIDIAN_AGENT_NAMESPACE_DESCRIPTION,
			tools: OBSIDIAN_AGENT_TOOL_SPECS.map((spec) => ({
				type: "function" as const,
				name: spec.name,
				description: spec.description,
				inputSchema: spec.inputSchema,
				deferLoading: spec.deferLoading,
			})),
		},
	];
}

function hlidDynamicTools(
	computerUseAvailable: boolean,
	visualizeAvailable: boolean,
): DynamicToolSpec[] {
	return [
		...obsidianTools(),
		...hlidHostTools(computerUseAvailable, visualizeAvailable),
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

function isComputerUseElicitation(rawParams: unknown): boolean {
	const params = asObj(rawParams);
	const meta = asObj(params._meta);
	const connectorId = meta.connector_id ?? meta.connectorId;
	if (
		typeof connectorId === "string" &&
		["computer-use", "computer_use", "computeruse"].includes(
			connectorId.toLowerCase(),
		)
	) {
		return true;
	}
	const nested = meta.computerUse ?? meta.computer_use;
	return (
		nested !== null && typeof nested === "object" && !Array.isArray(nested)
	);
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

function commandFromProviderInput(value: unknown, depth = 0): string | null {
	if (depth > 3) return null;
	const obj = asObj(value);
	for (const key of ["command", "cmd"]) {
		const command = obj[key];
		if (typeof command === "string" && command.trim()) return command;
	}
	for (const key of [
		"tool_input",
		"toolInput",
		"arguments",
		"input",
		"params",
		"parameters",
		"request",
		"payload",
	]) {
		const command = commandFromProviderInput(obj[key], depth + 1);
		if (command) return command;
	}
	return null;
}

function commandFromStartedItem(value: unknown): string | null {
	const item = asObj(value);
	if (item.type !== "commandExecution") return null;
	return commandFromProviderInput(item);
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

/**
 * Hlid's policy and bypass paths remain authoritative. Auto-review is only
 * meaningful at Codex's interactive approval boundary, so those paths always
 * retain the explicit user reviewer instead of introducing a second decider.
 */
function effectiveApprovalsReviewer(
	params: AgentQueryParams,
): ProviderApprovalsReviewer {
	if (
		params.policyEnforced ||
		params.usageGateEnforced ||
		params.permissionMode === "plan" ||
		autoApprovesPermissions(params)
	) {
		return "user";
	}
	return params.approvalsReviewer ?? "user";
}

function normalizeApprovalsReviewer(
	value: unknown,
): ProviderApprovalsReviewer | null {
	if (value === "user") return "user";
	if (value === "auto_review" || value === "guardian_subagent") {
		return "auto_review";
	}
	return null;
}

type ApprovalsReviewerRequestContext = {
	selectedReviewer: ProviderApprovalsReviewer;
	sentReviewer: ProviderApprovalsReviewer;
	temporarilyForced: boolean;
	selectionRevision: number;
};

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
	override?: AgentQueryParams["sandboxModeOverride"],
): CodexSandboxPolicy {
	const sandbox = override ?? sandboxMode(mode);
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

function windowsVisualizeSandboxPolicy(jobRoot: string): CodexSandboxPolicy {
	return {
		type: "workspaceWrite",
		writableRoots: [jobRoot],
		networkAccess: false,
		excludeTmpdirEnvVar: true,
		excludeSlashTmp: true,
	};
}

export type CodexLaunchConfig = {
	executable: string;
	rpcCwd: string;
	appServer: CodexAppServerLaunch;
};

export type CodexProviderProfile = Omit<CodexAppServerLaunch, "executable">;

export function codexRealtimeVersion(
	_mode: ProviderRealtimeStart["mode"],
): "v3" {
	// The AVAS WebRTC transport accepts v1/v3, while text output accepts only
	// v2. Dictation therefore runs on v3 audio and consumes only input
	// transcript notifications; the browser deliberately does not play its
	// remote audio track.
	return "v3";
}

export function codexRealtimeOutputModality(): "audio" {
	return "audio";
}

export function codexRealtimeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (
		/unexpected status 404 Not Found/i.test(message) &&
		/backend-api\/codex\/realtime\/calls/i.test(message)
	) {
		return CODEX_REALTIME_ACCOUNT_UNAVAILABLE;
	}
	return message;
}

export function codexLaunchConfig(params: {
	cwd: string;
	executable?: string;
	profile?: CodexProviderProfile;
	enableRealtime?: boolean;
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
		appServer: {
			...params.profile,
			executable,
			args: [
				...(params.enableRealtime ? ["--enable", "realtime_conversation"] : []),
				...(params.profile?.args ?? []),
			],
		},
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
		const isDefault = item.isDefault === true ? true : undefined;
		const inputModalities = Array.isArray(item.inputModalities)
			? item.inputModalities.filter(
					(modality): modality is "text" | "image" | "audio" =>
						modality === "text" || modality === "image" || modality === "audio",
				)
			: undefined;
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
		const defaultServiceTier =
			typeof item.defaultServiceTier === "string"
				? item.defaultServiceTier
				: undefined;
		const serviceTiers = Array.isArray(item.serviceTiers)
			? item.serviceTiers.flatMap((tier) => {
					const tierObject = asObj(tier);
					const tierValue =
						typeof tierObject.id === "string" ? tierObject.id : undefined;
					if (!tierValue) return [];
					return [
						{
							value: tierValue,
							label:
								typeof tierObject.name === "string"
									? tierObject.name
									: tierValue,
							desc:
								typeof tierObject.description === "string"
									? tierObject.description
									: undefined,
							isDefault:
								defaultServiceTier !== undefined
									? tierValue === defaultServiceTier
									: undefined,
						},
					];
				})
			: undefined;
		return [
			{
				value,
				label,
				description,
				isDefault,
				hidden,
				inputModalities,
				efforts,
				serviceTiers,
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
	profile?: CodexProviderProfile;
	enableRealtime?: boolean;
	/** Use a disposable transport when the caller may already occupy the shared one. */
	dedicated?: boolean;
}): Promise<ProviderModelInfo[]> {
	const launch = codexLaunchConfig({
		cwd: opts?.cwd ?? process.cwd(),
		executable: opts?.executable,
		profile: opts?.profile,
		enableRealtime: opts?.enableRealtime,
	});
	const conn = opts?.dedicated
		? new CodexAppServer(launch.appServer)
		: acquireCodexAppServer(launch.appServer);
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
		if (opts?.dedicated) {
			conn.kill(new Error("Dedicated Codex model catalog lookup complete"));
		}
	}
}

function canonicalUsage(value: unknown): CanonicalTokenUsage | null {
	const usage = asObj(value);
	const inputValue = usage.inputTokens ?? usage.input_tokens ?? usage.input;
	const outputValue = usage.outputTokens ?? usage.output_tokens ?? usage.output;
	const cacheReadValue =
		usage.cacheReadTokens ??
		usage.cache_read_input_tokens ??
		usage.cachedInputTokens ??
		usage.cached_input_tokens;
	const cacheCreationValue =
		usage.cacheCreationTokens ??
		usage.cache_creation_input_tokens ??
		usage.cacheWriteInputTokens ??
		usage.cache_write_input_tokens ??
		usage.cacheWriteTokens ??
		usage.cache_write_tokens;
	if (
		![inputValue, outputValue, cacheReadValue, cacheCreationValue].some(
			(item) => typeof item === "number",
		)
	) {
		return null;
	}
	return canonicalizeCodexUsage({
		inputTokens: Number(inputValue) || 0,
		outputTokens: Number(outputValue) || 0,
		cacheReadTokens: Number(cacheReadValue) || undefined,
		cacheCreationTokens: Number(cacheCreationValue) || undefined,
	});
}

function tokenUsageEnvelope(value: unknown): Record<string, unknown> {
	const obj = asObj(value);
	return asObj(obj.usage ?? obj.tokenUsage ?? obj.tokens);
}

function maybeTotalUsage(value: unknown): CanonicalTokenUsage | null {
	const tokenUsage = tokenUsageEnvelope(value);
	return canonicalUsage(
		tokenUsage.total ??
			tokenUsage.totalTokenUsage ??
			tokenUsage.total_token_usage,
	);
}

function maybeLastUsage(value: unknown): CanonicalTokenUsage | null {
	const tokenUsage = tokenUsageEnvelope(value);
	return canonicalUsage(
		tokenUsage.last ?? tokenUsage.lastTokenUsage ?? tokenUsage.last_token_usage,
	);
}

function maybeUsage(value: unknown): AgentEvent | null {
	const obj = asObj(value);
	const tokenUsage = tokenUsageEnvelope(value);
	// ThreadTokenUsage carries the serving model's real context window.
	const contextWindow =
		Number(tokenUsage.modelContextWindow ?? tokenUsage.model_context_window) ||
		undefined;
	const canonical =
		maybeLastUsage(value) ??
		canonicalUsage(
			tokenUsage.total ??
				tokenUsage.totalTokenUsage ??
				tokenUsage.total_token_usage ??
				tokenUsage,
		);
	if (!canonical) return null;
	if (
		canonical.inputTokens === 0 &&
		canonical.outputTokens === 0 &&
		canonical.cacheReadTokens === 0 &&
		canonical.cacheCreationTokens === 0
	) {
		return null;
	}
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
	"windowId" | "label" | "utilization" | "remaining" | "limit" | "resetsAt"
>;

function codexEpochSeconds(raw: unknown): number | null {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
	return raw > 1e12 ? Math.round(raw / 1000) : raw;
}

function codexDecimal(raw: unknown): number | null {
	if (typeof raw !== "string" && typeof raw !== "number") return null;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : null;
}

function mapCodexRateLimitWindows(
	raw: unknown,
	includeMissingUtilization = false,
): CodexWindowReading[] {
	const snapshot = asObj(raw) as Partial<RateLimitSnapshot>;
	const rolling = (
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
				remaining: null,
				limit: null,
				resetsAt: codexEpochSeconds(rawReset),
			},
		];
	});
	const spend = asObj(snapshot.individualLimit);
	if (Object.keys(spend).length === 0) return rolling;
	const remainingPercent =
		typeof spend.remainingPercent === "number" ? spend.remainingPercent : null;
	const limit = codexDecimal(spend.limit);
	const used = codexDecimal(spend.used);
	return [
		...rolling,
		{
			windowId: "spend_control",
			label: "SPEND",
			utilization:
				remainingPercent == null
					? null
					: Math.min(1, Math.max(0, 1 - remainingPercent / 100)),
			remaining:
				limit != null && used != null ? Math.max(0, limit - used) : null,
			limit,
			resetsAt: codexEpochSeconds(spend.resetsAt),
		},
	];
}

const CODEX_BACKGROUND_ACTIVITY_MAX_PAGES = 5;
const CODEX_BACKGROUND_ACTIVITY_PAGE_SIZE = 100;
const CODEX_BACKGROUND_ACTIVITY_MAX_OUTPUT_CHARS = 8_192;
const CODEX_BACKGROUND_ACTIVITY_RETENTION_MS = 15 * 60_000;

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "bigint") {
		const converted = Number(value);
		return Number.isSafeInteger(converted) ? converted : undefined;
	}
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function boundedBackgroundOutput(value: string | null): string | undefined {
	if (!value) return undefined;
	return value.length <= CODEX_BACKGROUND_ACTIVITY_MAX_OUTPUT_CHARS
		? value
		: value.slice(-CODEX_BACKGROUND_ACTIVITY_MAX_OUTPUT_CHARS);
}

function backgroundCommandActivityId(
	item: Record<string, unknown>,
): string | null {
	if (item.type !== "commandExecution" || typeof item.id !== "string") {
		return null;
	}
	return item.id || null;
}

function backgroundCommandLabel(item: Record<string, unknown>): string | null {
	for (const rawAction of Array.isArray(item.commandActions)
		? item.commandActions
		: []) {
		const command = asObj(rawAction).command;
		if (typeof command === "string" && command.trim()) return command;
	}
	return typeof item.command === "string" && item.command.trim()
		? item.command
		: null;
}

class CodexAgentSession implements AgentSession {
	private conn: CodexAppServer | null = null;
	private events = new AsyncQueue<AgentEvent>();
	private ready: Promise<void> | null = null;
	private threadId: string | null = null;
	private activeTurnId: string | null = null;
	private activeTurnIdIsAuthoritative = false;
	private pendingOrphanTurnId: string | null = null;
	private ordinaryQueryActive = false;
	private ordinaryTurnStartPending = false;
	private ownedOrdinaryTurnIds = new Set<string>();
	private suppressedTurnIds = new Set<string>();
	private activeTurnModel: string | null = null;
	private canceled = false;
	private endAfterTurn = false;
	private emittedAgentMessageText = new Map<string, string>();
	private queryAssistantMessageIds = new Set<string>();
	private emittedReasoningIds = new Set<string>();
	private emittedUnidentifiedAgentMessageText = "";
	private startedItems = new Map<string, Record<string, unknown>>();
	private emittedGeneratedMediaIds = new Set<string>();
	private attachedThreadIds = new Set<string>();
	private subagentByThread = new Map<string, string>();
	private subagentSnapshots = new Map<string, SubagentSnapshot>();
	private pendingSubagentToolIds = new Set<string>();
	private queryChildThreadIds = new Set<string>();
	private pendingDone: PendingCodexDone | null = null;
	private threadHandler: ThreadHandler | null = null;
	private approvedHtmlPlanItemId: string | null = null;
	private htmlPlanReady = false;
	private nativePlanText = "";
	private lastUsage = emptyCodexUsage();
	private queryUsage = emptyCodexUsage();
	private queryEstimatedCost = 0;
	private queryUsageIsPriced = true;
	private queryTurns = 0;
	private queryWebSearchItemIds = new Set<string>();
	private childLastUsage = new Map<string, CanonicalTokenUsage>();
	private cumulativeUsageByThread = new Map<string, CanonicalTokenUsage>();
	private cumulativeUsageTurns = new Set<string>();
	private actualModelByTurn = new Map<string, string>();
	private mcpServerStatusesByThread = new Map<
		string,
		Map<string, McpServerStatus>
	>();
	private resolvedModel: string | null = null;
	private lastReportedApprovalsReviewer: ProviderApprovalsReviewer | null =
		null;
	private approvalsReviewerSelectionRevision = 0;
	private lastSentApprovalsReviewerContext: ApprovalsReviewerRequestContext | null =
		null;
	private elicitationSequence = 0;
	private nextSkillInput: WindowsVisualizeSkill | null = null;
	/** Dedicated transport owned by a one-shot Windows-native worker. */
	private ownedConnection: CodexAppServer | null = null;
	private goalChangeHandler: AgentQueryParams["onGoalChange"];
	private realtimeEventHandler: ProviderRealtimeEventHandler | null = null;
	private realtimeCloseWaiter: {
		eventHandler: ProviderRealtimeEventHandler;
		resolve: () => void;
	} | null = null;
	private realtimeMode: ProviderRealtimeStart["mode"] | null = null;
	private liveTurnIsolationActive = false;
	private liveHiddenTurnId: string | null = null;
	private ownedSpeech: OwnedSpeechRuntime | null = null;
	private realtimeTransportOwner: "speech" | "main" | null = null;
	private realtimeSpeechMode: Exclude<
		ProviderRealtimeStart["mode"],
		"live"
	> | null = null;
	private backgroundActivities = new Map<string, ProviderBackgroundActivity>();
	/**
	 * Root-thread commands currently running through structured provider items.
	 * Current Codex Code Mode owns these cells outside unified_exec, so Hlid can
	 * observe them while active but has no client-callable process handle.
	 */
	private backgroundCommandCandidates = new Map<
		string,
		{ item: Record<string, unknown>; startedAtMs: number }
	>();
	private backgroundActivityRead: Promise<ProviderBackgroundActivity[]> | null =
		null;
	/** Successfully validated explicit profile selections keyed by native cwd. */
	private validatedPermissionProfiles = new Set<string>();
	/** Explicit profile most recently sent at a native thread or turn boundary. */
	private expectedActivePermissionProfile: string | null = null;
	/** Terminal fail-closed state after Codex reports a different active profile. */
	private permissionProfileFailure: Error | null = null;

	private launch: CodexLaunchConfig | null = null;

	constructor(
		private params: AgentQueryParams,
		private readonly delegatedWindowsWorker?: DelegatedWindowsWorker,
		private readonly providerProfile?: CodexProviderProfile,
	) {
		this.goalChangeHandler = params.onGoalChange;
	}

	setGoalChangeHandler(handler: AgentQueryParams["onGoalChange"]): void {
		this.goalChangeHandler = handler;
	}

	private canUseWindowsComputerUse(): boolean {
		return !this.delegatedWindowsWorker && windowsComputerUseHostAvailable();
	}

	cancel(): void {
		this.canceled = true;
		this.clearPendingDone();
		this.events.close();
		const ownedSpeech = this.ownedSpeech;
		if (ownedSpeech) {
			this.cleanupOwnedSpeech(
				ownedSpeech,
				new Error(`Codex ${ownedSpeech.mode} cancelled`),
			);
		} else {
			const realtimeCloseWaiter = this.realtimeCloseWaiter;
			this.realtimeCloseWaiter = null;
			realtimeCloseWaiter?.resolve();
		}
		// Normal sessions share an app-server and must only detach. Delegated
		// Windows workers own a fresh app-server so every task reloads the
		// native provider's current plugin paths and runtime state.
		if (this.conn && this.threadId) {
			if (!ownedSpeech && this.realtimeEventHandler) {
				void this.conn
					.request("thread/realtime/stop", { threadId: this.threadId })
					.catch(() => {});
			}
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
		this.ownedConnection?.kill(new Error("Windows worker closed"));
		this.ownedConnection = null;
		this.conn = null;
		this.realtimeEventHandler = null;
		this.realtimeMode = null;
		this.liveTurnIsolationActive = false;
		this.liveHiddenTurnId = null;
		this.ordinaryQueryActive = false;
		this.ordinaryTurnStartPending = false;
		this.ownedOrdinaryTurnIds.clear();
	}

	closeInput(): void {
		// One-shot callers (recap) use this as "no more sends coming". With a
		// shared app-server there is no per-session stdin to EOF — instead the
		// event stream is closed once the in-flight turn completes (see the
		// turn/completed handler), which ends the caller's for-await loop.
		this.endAfterTurn = true;
		if (this.activeTurnId === null && this.pendingDone === null) {
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

	private rememberSuppressedTurn(turnId: string): void {
		if (!turnId) return;
		this.suppressedTurnIds.add(turnId);
		// UUIDv7 turn ids are unique for the lifetime of the process. Keep a small
		// tombstone window so notifications emitted after turn/interrupt resolves
		// cannot be mistaken for a later Hlid query.
		if (this.suppressedTurnIds.size <= 32) return;
		const oldest = this.suppressedTurnIds.values().next().value;
		if (typeof oldest === "string") this.suppressedTurnIds.delete(oldest);
	}

	private notificationTurnId(obj: Record<string, unknown>): string {
		const direct = obj.turnId;
		if (typeof direct === "string") return direct;
		const nested = asObj(obj.turn).id;
		return typeof nested === "string" ? nested : "";
	}

	private inProgressTurnId(thread: Record<string, unknown>): string | null {
		const turns = Array.isArray(thread.turns) ? thread.turns : [];
		for (let index = turns.length - 1; index >= 0; index--) {
			const turn = asObj(turns[index]);
			if (turn.status === "inProgress" && typeof turn.id === "string") {
				return turn.id;
			}
		}
		return null;
	}

	private adoptUnownedNativeTurn(turnId: string): void {
		if (!turnId) return;
		this.activeTurnId = turnId;
		this.activeTurnIdIsAuthoritative = true;
		this.pendingOrphanTurnId = turnId;
	}

	private async interruptSuppressedTurn(turnId: string): Promise<void> {
		if (!this.threadId || !turnId) return;
		let interruptedTurnId = turnId;
		this.rememberSuppressedTurn(interruptedTurnId);
		try {
			await this.request("turn/interrupt", {
				threadId: this.threadId,
				turnId: interruptedTurnId,
			});
		} catch (error) {
			if (codexTurnAlreadySettled(error)) {
				// The resume/read snapshot can race the native turn's completion.
				// Treat that as the same settled outcome as a successful interrupt.
			} else {
				const mismatch = codexActiveTurnMismatch(error);
				if (!mismatch || mismatch.expectedTurnId !== interruptedTurnId) {
					throw error;
				}
				interruptedTurnId = mismatch.actualTurnId;
				this.rememberSuppressedTurn(interruptedTurnId);
				this.activeTurnId = interruptedTurnId;
				this.activeTurnIdIsAuthoritative = true;
				try {
					await this.request("turn/interrupt", {
						threadId: this.threadId,
						turnId: interruptedTurnId,
					});
				} catch (retryError) {
					if (!codexTurnAlreadySettled(retryError)) throw retryError;
				}
			}
		}
		if (
			this.activeTurnId === turnId ||
			this.activeTurnId === interruptedTurnId
		) {
			this.activeTurnId = null;
			this.activeTurnIdIsAuthoritative = false;
		}
		if (
			this.pendingOrphanTurnId === turnId ||
			this.pendingOrphanTurnId === interruptedTurnId
		) {
			this.pendingOrphanTurnId = null;
		}
		if (this.liveHiddenTurnId === interruptedTurnId) {
			this.liveHiddenTurnId = null;
		}
	}

	private async settleUnownedNativeTurn(): Promise<void> {
		const orphanTurnId =
			this.pendingOrphanTurnId ??
			(this.activeTurnId && !this.ownedOrdinaryTurnIds.has(this.activeTurnId)
				? this.activeTurnId
				: null);
		if (!orphanTurnId) return;
		await this.interruptSuppressedTurn(orphanTurnId);
	}

	private async readInProgressNativeTurnId(): Promise<string | null> {
		if (!this.threadId) return null;
		try {
			const result = asObj(
				await this.request("thread/read", {
					threadId: this.threadId,
					includeTurns: true,
				}),
			);
			return this.inProgressTurnId(asObj(result.thread));
		} catch {
			// Live turn notifications are authoritative when thread/read is not
			// available on an older app-server.
			return this.liveHiddenTurnId;
		}
	}

	private async settleLiveNativeTurn(): Promise<void> {
		const discoveredTurnId = await this.readInProgressNativeTurnId();
		const liveTurnId = discoveredTurnId ?? this.liveHiddenTurnId;
		if (!liveTurnId) return;
		this.liveHiddenTurnId = liveTurnId;
		this.adoptUnownedNativeTurn(liveTurnId);
		await this.interruptSuppressedTurn(liveTurnId);
	}

	private async readBackgroundTerminals(): Promise<
		ThreadBackgroundTerminalsListResponse["data"]
	> {
		if (!this.threadId) throw new Error("Codex thread did not start");
		const terminals: ThreadBackgroundTerminalsListResponse["data"] = [];
		let cursor: string | null = null;
		for (let page = 0; page < CODEX_BACKGROUND_ACTIVITY_MAX_PAGES; page++) {
			const params: ThreadBackgroundTerminalsListParams = {
				threadId: this.threadId,
				limit: CODEX_BACKGROUND_ACTIVITY_PAGE_SIZE,
				...(cursor ? { cursor } : {}),
			};
			const response = (await this.requestOptional(
				"thread/backgroundTerminals/list",
				params,
			)) as ThreadBackgroundTerminalsListResponse;
			terminals.push(...response.data);
			cursor = response.nextCursor;
			if (!cursor) break;
		}
		return terminals;
	}

	private async readBackgroundThreadItems(
		wantedIds: ReadonlySet<string>,
	): Promise<Map<string, ThreadItemsListResponse["data"][number]["item"]>> {
		const items = new Map<
			string,
			ThreadItemsListResponse["data"][number]["item"]
		>();
		if (!this.threadId || wantedIds.size === 0) return items;
		let cursor: string | null = null;
		for (let page = 0; page < CODEX_BACKGROUND_ACTIVITY_MAX_PAGES; page++) {
			const params: ThreadItemsListParams = {
				threadId: this.threadId,
				limit: CODEX_BACKGROUND_ACTIVITY_PAGE_SIZE,
				sortDirection: "desc",
				...(cursor ? { cursor } : {}),
			};
			const response = (await this.requestOptional(
				"thread/items/list",
				params,
			)) as ThreadItemsListResponse;
			for (const entry of response.data) {
				if ("id" in entry.item && wantedIds.has(entry.item.id)) {
					items.set(entry.item.id, entry.item);
				}
			}
			if (items.size === wantedIds.size || !response.nextCursor) break;
			cursor = response.nextCursor;
		}
		return items;
	}

	private async observeBackgroundActivities(): Promise<
		ProviderBackgroundActivity[]
	> {
		await this.ensureReady();
		if (!this.threadId) throw new Error("Codex thread did not start");
		const providerSessionId = this.threadId;
		this.projectRunningCommandActivities();
		const terminals = await this.readBackgroundTerminals();
		const wantedIds = new Set(terminals.map((terminal) => terminal.itemId));
		for (const activity of this.backgroundActivities.values()) {
			if (activity.status === "running") wantedIds.add(activity.activityId);
		}
		const items = await this.readBackgroundThreadItems(wantedIds);
		const now = Date.now();
		const next = new Map<string, ProviderBackgroundActivity>();

		for (const terminal of terminals) {
			const previous = this.backgroundActivities.get(terminal.itemId);
			const item = items.get(terminal.itemId);
			const commandItem = item?.type === "commandExecution" ? item : undefined;
			const rssKb = finiteNumber(terminal.rssKb);
			const osPid = finiteNumber(terminal.osPid);
			const cpuPercent = finiteNumber(terminal.cpuPercent);
			const recentOutput = boundedBackgroundOutput(
				commandItem?.aggregatedOutput ?? null,
			);
			next.set(terminal.itemId, {
				providerId: this.params.providerId ?? "codex",
				providerSessionId,
				activityId: terminal.itemId,
				processId: terminal.processId,
				kind: "terminal",
				status: "running",
				command: terminal.command,
				cwd: String(terminal.cwd),
				...(recentOutput ? { recentOutput } : {}),
				...(osPid !== undefined ? { osPid } : {}),
				...(cpuPercent !== undefined ? { cpuPercent } : {}),
				...(rssKb !== undefined ? { rssKb } : {}),
				startedAtMs: previous?.startedAtMs ?? now,
				updatedAtMs: now,
				capabilities: { terminate: true, clean: true },
			});
		}

		for (const previous of this.backgroundActivities.values()) {
			if (next.has(previous.activityId)) continue;
			if (previous.status !== "running") {
				const endedAt = previous.endedAtMs ?? previous.updatedAtMs;
				if (now - endedAt <= CODEX_BACKGROUND_ACTIVITY_RETENTION_MS) {
					next.set(previous.activityId, previous);
				}
				continue;
			}
			const item = items.get(previous.activityId);
			const commandItem = item?.type === "commandExecution" ? item : undefined;
			const status =
				commandItem?.status === "inProgress"
					? "running"
					: commandItem?.status === "completed"
						? "completed"
						: commandItem?.status === "failed" ||
								commandItem?.status === "declined"
							? "failed"
							: "unknown";
			const recentOutput = boundedBackgroundOutput(
				commandItem?.aggregatedOutput ?? null,
			);
			next.set(previous.activityId, {
				...previous,
				status,
				...(recentOutput ? { recentOutput } : {}),
				updatedAtMs: now,
				...(status === "running" ? {} : { endedAtMs: now }),
				capabilities: {},
			});
		}

		this.backgroundActivities = next;
		return [...next.values()].sort(compareProviderBackgroundActivity);
	}

	private recordBackgroundCommandStarted(
		item: Record<string, unknown>,
		params: Record<string, unknown>,
	): void {
		const activityId = backgroundCommandActivityId(item);
		if (!activityId) return;
		this.backgroundCommandCandidates.set(activityId, {
			item,
			startedAtMs: finiteNumber(params.startedAtMs) ?? Date.now(),
		});
	}

	private recordBackgroundCommandCompleted(
		item: Record<string, unknown>,
		params: Record<string, unknown>,
	): void {
		const activityId = backgroundCommandActivityId(item);
		if (!activityId) return;
		this.backgroundCommandCandidates.delete(activityId);
		const previous = this.backgroundActivities.get(activityId);
		if (!previous) return;
		const now = finiteNumber(params.completedAtMs) ?? Date.now();
		const status =
			item.status === "completed"
				? "completed"
				: item.status === "failed" || item.status === "declined"
					? "failed"
					: "unknown";
		const recentOutput = boundedBackgroundOutput(
			typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null,
		);
		this.backgroundActivities.set(activityId, {
			...previous,
			status,
			...(recentOutput ? { recentOutput } : {}),
			updatedAtMs: now,
			endedAtMs: now,
			capabilities: {},
		});
	}

	private projectRunningCommandActivities(): void {
		if (!this.threadId) return;
		const now = Date.now();
		for (const [activityId, candidate] of this.backgroundCommandCandidates) {
			if (this.backgroundActivities.has(activityId)) continue;
			const { item, startedAtMs } = candidate;
			const command = backgroundCommandLabel(item);
			const recentOutput = boundedBackgroundOutput(
				typeof item.aggregatedOutput === "string"
					? item.aggregatedOutput
					: null,
			);
			this.backgroundActivities.set(activityId, {
				providerId: this.params.providerId ?? "codex",
				providerSessionId: this.threadId,
				activityId,
				kind: "shell",
				status: "running",
				...(command ? { command } : {}),
				...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
				...(recentOutput ? { recentOutput } : {}),
				startedAtMs,
				updatedAtMs: now,
				// Code Mode exposes exact cell termination only to its model-facing
				// wait tool. Do not claim a native Hlid control operation here.
				capabilities: {},
			});
		}
	}

	async listBackgroundActivities(): Promise<ProviderBackgroundActivity[]> {
		this.projectRunningCommandActivities();
		if (!this.backgroundActivityRead) {
			const read = this.observeBackgroundActivities()
				.catch(() =>
					[...this.backgroundActivities.values()].sort(
						compareProviderBackgroundActivity,
					),
				)
				.finally(() => {
					if (this.backgroundActivityRead === read) {
						this.backgroundActivityRead = null;
					}
				});
			this.backgroundActivityRead = read;
		}
		const immediate = [...this.backgroundActivities.values()].sort(
			compareProviderBackgroundActivity,
		);
		// Codex can serialize its native terminal inventory behind an active turn.
		// Structured item lifecycle state is already authoritative enough to show
		// read-only Code Mode activity, so never stall that projection on the native
		// probe. Once native data arrives, the next session poll picks up controls.
		if (this.activeTurnId !== null || immediate.length > 0) return immediate;
		return this.backgroundActivityRead;
	}

	async controlBackgroundActivity(
		request: ProviderBackgroundActivityControl,
	): Promise<void> {
		await this.ensureReady();
		if (!this.threadId) throw new Error("Codex thread did not start");
		const activities = await this.listBackgroundActivities();
		const now = Date.now();
		if (request.action === "terminate") {
			const activity = activities.find(
				(candidate) => candidate.activityId === request.activityId,
			);
			if (!activity || activity.status !== "running") {
				throw new Error("That Codex background terminal is no longer running");
			}
			if (!activity.capabilities.terminate || !activity.processId) {
				throw new Error(
					"That Codex background activity is not controllable through Hlid",
				);
			}
			const params: ThreadBackgroundTerminalsTerminateParams = {
				threadId: this.threadId,
				processId: activity.processId,
			};
			const response = (await this.request(
				"thread/backgroundTerminals/terminate",
				params,
			)) as ThreadBackgroundTerminalsTerminateResponse;
			if (!response.terminated) {
				throw new Error("Codex did not terminate that background terminal");
			}
			this.backgroundActivities.set(activity.activityId, {
				...activity,
				status: "stopped",
				updatedAtMs: now,
				endedAtMs: now,
				capabilities: {},
			});
			return;
		}

		const params: ThreadBackgroundTerminalsCleanParams = {
			threadId: this.threadId,
		};
		await this.request("thread/backgroundTerminals/clean", params);
		for (const activity of activities) {
			if (activity.status !== "running") continue;
			this.backgroundActivities.set(activity.activityId, {
				...activity,
				status: "stopped",
				updatedAtMs: now,
				endedAtMs: now,
				capabilities: {},
			});
		}
	}

	async steer(message: string, opts?: SendOptions): Promise<void> {
		await this.ensureReady();
		if (!this.threadId || !this.activeTurnId) {
			throw new Error("Codex has no active turn to steer");
		}
		if ((opts?.audioPaths?.length ?? 0) > 0) {
			await this.assertAudioInputSupported();
		}
		const input: UserInput[] = [
			{ type: "text", text: message, text_elements: [] },
			...(opts?.audioPaths ?? []).map(
				(path): UserInput => ({ type: "localAudio", path }),
			),
		];
		const expectedTurnId = this.activeTurnId;
		try {
			await this.request("turn/steer", {
				threadId: this.threadId,
				expectedTurnId,
				input,
			} satisfies TurnSteerParams);
		} catch (error) {
			const mismatch = codexActiveTurnMismatch(error);
			if (
				!mismatch ||
				mismatch.expectedTurnId !== expectedTurnId ||
				!this.ordinaryQueryActive ||
				this.activeTurnId !== expectedTurnId
			) {
				throw error;
			}
			// turn/start can return a submission id while Codex routes that input to
			// an older native turn. Treat the app-server's mismatch as authoritative
			// and retry this steer once, matching the native clients' recovery.
			this.activeTurnId = mismatch.actualTurnId;
			this.activeTurnIdIsAuthoritative = true;
			this.ownedOrdinaryTurnIds.add(mismatch.actualTurnId);
			await this.request("turn/steer", {
				threadId: this.threadId,
				expectedTurnId: mismatch.actualTurnId,
				input,
			} satisfies TurnSteerParams);
		}
	}

	async send(message: string, opts?: SendOptions): Promise<void> {
		await this.ensureReady();
		if (!this.threadId) throw new Error("Codex thread did not start");
		await this.settleUnownedNativeTurn();
		if ((opts?.audioPaths?.length ?? 0) > 0) {
			await this.assertAudioInputSupported();
		}
		const cwd = this.launch?.rpcCwd ?? this.params.cwd;
		const permissionProfile = await this.permissionProfileForBoundary(cwd);
		const collaborationModel = this.params.model ?? this.resolvedModel;
		const collaborationMode =
			collaborationModel ||
			(this.params.permissionMode === "plan" && !this.params.planHtmlPath)
				? {
						mode:
							this.params.permissionMode === "plan" && !this.params.planHtmlPath
								? ("plan" as const)
								: ("default" as const),
						settings: {
							model: collaborationModel ?? "",
							reasoning_effort: this.params.effort ?? null,
							developer_instructions: null,
						},
					}
				: undefined;
		const selectedSkill = this.nextSkillInput;
		this.nextSkillInput = null;
		const input: UserInput[] = [
			...(selectedSkill
				? [
						{
							type: "skill" as const,
							name: selectedSkill.name,
							path: selectedSkill.path,
						},
					]
				: []),
			{ type: "text", text: message, text_elements: [] },
			...(opts?.audioPaths ?? []).map(
				(path): UserInput => ({ type: "localAudio", path }),
			),
		];
		const approvalsReviewerRequest = this.captureApprovalsReviewerRequest();
		const params: TurnStartParams = {
			threadId: this.threadId,
			input,
			approvalsReviewer: approvalsReviewerRequest.sentReviewer,
			...(this.delegatedWindowsWorker?.kind === "visualize"
				? {}
				: {
						additionalContext: {
							hlid: {
								kind: "application" as const,
								value: HLID_AGENT_NAMESPACE_DESCRIPTION,
							},
							hlid_obsidian: {
								kind: "application" as const,
								value: OBSIDIAN_AGENT_NAMESPACE_DESCRIPTION,
							},
						},
					}),
			// Native Codex Plan Mode forbids every write at the instruction layer,
			// even when the sandbox grants the HTML plan directory. HTML plans use
			// Hlið-managed planning while plain Markdown plans stay native. A thread
			// without a resolved model does not need an explicit default-mode update;
			// sending an empty model makes Codex warn and fall back anyway.
			...(collaborationMode ? { collaborationMode } : {}),
			...(cwd ? { cwd } : {}),
			...(this.delegatedWindowsWorker?.kind === "visualize" && cwd
				? { runtimeWorkspaceRoots: [cwd] }
				: {}),
			...this.commonBoundaryParams(permissionProfile),
			...(this.params.effort ? { effort: this.params.effort } : {}),
			...(this.params.permissionMode && !permissionProfile
				? {
						sandboxPolicy:
							this.delegatedWindowsWorker?.kind === "visualize" && cwd
								? windowsVisualizeSandboxPolicy(cwd)
								: codexSandboxPolicy(
										this.params.permissionMode,
										this.params.additionalDirectories ?? [],
										this.params.planHtmlPath,
										this.params.sandboxModeOverride,
									),
					}
				: {}),
		};
		this.activeTurnModel = this.params.model ?? this.resolvedModel;
		this.ordinaryQueryActive = true;
		this.ordinaryTurnStartPending = true;
		this.lastSentApprovalsReviewerContext = approvalsReviewerRequest;
		this.expectedActivePermissionProfile = permissionProfile ?? null;
		try {
			const result = asObj(await this.request("turn/start", params));
			const turn = asObj(result.turn);
			if (typeof turn.id === "string") {
				// A turn/started notification is native authority and can race ahead of
				// this response. Never replace that actual id with the newer submission
				// id returned by turn/start.
				if (!this.activeTurnIdIsAuthoritative || !this.activeTurnId) {
					this.activeTurnId = turn.id;
					this.activeTurnIdIsAuthoritative = false;
					this.ownedOrdinaryTurnIds.add(turn.id);
				} else if (this.activeTurnId === turn.id) {
					this.ownedOrdinaryTurnIds.add(turn.id);
				}
			}
		} catch (error) {
			if (this.ownedOrdinaryTurnIds.size === 0) {
				this.ordinaryQueryActive = false;
			}
			throw error;
		} finally {
			this.ordinaryTurnStartPending = false;
		}
	}

	private async sendWithSkill(
		message: string,
		skill: WindowsVisualizeSkill,
	): Promise<void> {
		this.nextSkillInput = skill;
		try {
			await this.send(message);
		} finally {
			this.nextSkillInput = null;
		}
	}

	private async assertAudioInputSupported(): Promise<void> {
		const activeModel = this.resolvedModel ?? this.params.model;
		let models: ProviderModelInfo[];
		try {
			const raw = await this.request("model/list", {
				includeHidden: true,
			} satisfies ModelListParams);
			models = mapCodexModels(raw);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Talk to Codex is unavailable because Hlid could not verify audio support in the Codex model catalog: ${detail}`,
			);
		}
		const model = activeModel
			? models.find((candidate) => candidate.value === activeModel)
			: (models.find((candidate) => candidate.isDefault) ?? models[0]);
		if (model?.inputModalities?.includes("audio")) return;
		const label = model?.label ?? activeModel ?? "The active Codex model";
		throw new Error(
			`Talk to Codex is unavailable because ${label} does not support audio input. Use Dictate with Whisper, or choose an audio-capable Codex model if one appears in your Codex model catalog.`,
		);
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
		const implementationPermissionMode =
			this.params.permissionMode === "acceptEdits" ||
			this.params.permissionMode === "bypassPermissions"
				? this.params.permissionMode
				: "default";
		this.params = {
			...this.params,
			permissionMode,
			...(permissionMode === "plan" && this.params.permissionMode !== "plan"
				? { implementationPermissionMode }
				: {}),
		};
		this.lastReportedApprovalsReviewer = null;
	}

	/**
	 * Permission profiles are validated and sent at every native boundary. This
	 * setter lets a plan that is already awaiting Hlid approval use the current
	 * Forge selection for its provider-owned implementation turn.
	 */
	async setPermissionProfile(profile?: string): Promise<void> {
		this.params = {
			...this.params,
			codex: profile ? { permissionProfile: profile } : undefined,
		};
	}

	async setApprovalsReviewer(
		reviewer: ProviderApprovalsReviewer,
	): Promise<void> {
		this.params = { ...this.params, approvalsReviewer: reviewer };
		this.approvalsReviewerSelectionRevision += 1;
		this.lastReportedApprovalsReviewer = null;
	}

	setApprovalReviewContext(context: ProviderApprovalReviewContext): void {
		this.params = { ...this.params, ...context };
		this.lastReportedApprovalsReviewer = null;
	}

	private captureApprovalsReviewerRequest(): ApprovalsReviewerRequestContext {
		const selectedReviewer = this.params.approvalsReviewer ?? "user";
		const sentReviewer = effectiveApprovalsReviewer(this.params);
		return {
			selectedReviewer,
			sentReviewer,
			temporarilyForced: sentReviewer !== selectedReviewer,
			selectionRevision: this.approvalsReviewerSelectionRevision,
		};
	}

	private reportAuthoritativeApprovalsReviewer(
		value: unknown,
		source: "thread_response" | "thread_settings",
		requestContext: ApprovalsReviewerRequestContext | null,
	): void {
		// One-shot Computer Use and Visualize workers inherit the parent session's
		// callback but do not represent its effective reviewer state.
		if (this.delegatedWindowsWorker) return;
		const reviewer = normalizeApprovalsReviewer(value);
		if (!reviewer || !requestContext) return;

		const currentSelectedReviewer = this.params.approvalsReviewer ?? "user";
		const selectionIsCurrent =
			this.approvalsReviewerSelectionRevision ===
				requestContext.selectionRevision &&
			currentSelectedReviewer === requestContext.selectedReviewer;
		const persistPreference =
			!requestContext.temporarilyForced &&
			selectionIsCurrent &&
			reviewer !== requestContext.sentReviewer;
		const effectiveChanged = this.lastReportedApprovalsReviewer !== reviewer;

		if (persistPreference) {
			this.params = { ...this.params, approvalsReviewer: reviewer };
			this.approvalsReviewerSelectionRevision += 1;
		}
		if (!effectiveChanged && !persistPreference) return;

		this.lastReportedApprovalsReviewer = reviewer;
		this.params.onApprovalsReviewerChange?.({
			reviewer,
			source,
			persistPreference,
		});
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
				profile: this.providerProfile,
				enableRealtime: this.params.codexRealtimeEnabled,
			});
		const conn = this.conn ?? acquireCodexAppServer(launch.appServer);
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
				name: "goal",
				description: "Set, inspect, pause, resume, or clear the Codex goal",
				argumentHint: "[objective | pause | resume | clear]",
				action: "goal",
			},
			{
				name: "compact",
				description: "Compact the active Codex conversation",
				argumentHint: "",
				action: "compact",
			},
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
		action: "review" | "computer-use" | "compact",
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
				.then(({ text, threadId, usage, turns, durationMs, estimatedCost }) => {
					const result = `Windows Computer Use thread ${threadId}\n\n${text || "Task completed without a text summary."}`;
					this.events.push({ type: "tool_result", toolId, content: result });
					this.events.push({ type: "text_delta", text: result });
					this.events.push({
						type: "done",
						turns,
						durationMs,
						stopReason: "end_turn",
						usage,
						estimatedCost,
					});
				})
				.catch((error) => {
					const message =
						error instanceof Error ? error.message : String(error);
					const completion =
						error instanceof WindowsComputerUseError
							? error.completion
							: undefined;
					this.events.push({
						type: "tool_result",
						toolId,
						content: message,
						isError: true,
					});
					this.events.push({ type: "local_command_output", content: message });
					this.events.push({
						type: "done",
						turns: completion?.turns ?? 1,
						durationMs: completion?.durationMs ?? 0,
						stopReason: "error",
						...(completion
							? {
									usage: completion.usage,
									estimatedCost: completion.estimatedCost,
								}
							: {}),
					});
				});
			return;
		}
		if (action === "compact") {
			if (args?.trim()) throw new Error("/compact does not accept arguments");
			const params: ThreadCompactStartParams = { threadId: this.threadId };
			(await this.request(
				"thread/compact/start",
				params,
			)) as ThreadCompactStartResponse;
			const content = "Conversation compacted.";
			this.events.push({ type: "local_command_output", content });
			this.events.push({
				type: "done",
				turns: 0,
				durationMs: 0,
				stopReason: "end_turn",
			});
			return;
		}
		if (action !== "review") throw new Error(`Unsupported command: ${action}`);
		const target = args?.trim()
			? { type: "custom", instructions: args.trim() }
			: { type: "uncommittedChanges" };
		await this.settleUnownedNativeTurn();
		this.activeTurnModel = this.params.model ?? this.resolvedModel;
		this.ordinaryQueryActive = true;
		this.ordinaryTurnStartPending = true;
		try {
			const result = asObj(
				await this.request("review/start", {
					threadId: this.threadId,
					target,
					delivery: "inline",
				}),
			);
			const turn = asObj(result.turn);
			if (
				typeof turn.id === "string" &&
				(!this.activeTurnIdIsAuthoritative || !this.activeTurnId)
			) {
				this.activeTurnId = turn.id;
				this.activeTurnIdIsAuthoritative = false;
				this.ownedOrdinaryTurnIds.add(turn.id);
			}
		} catch (error) {
			if (this.ownedOrdinaryTurnIds.size === 0) {
				this.ordinaryQueryActive = false;
			}
			throw error;
		} finally {
			this.ordinaryTurnStartPending = false;
		}
	}

	async controlGoal(
		control: ProviderGoalControl,
	): Promise<ProviderGoalControlResult> {
		try {
			await this.ensureReady();
			const threadId = this.threadId;
			if (!threadId) throw new Error("Codex thread did not start");
			if (control.action === "get") {
				const params: ThreadGoalGetParams = { threadId };
				const result = (await this.request(
					"thread/goal/get",
					params,
				)) as ThreadGoalGetResponse;
				return { providerSessionId: threadId, goal: result.goal };
			}
			if (control.action === "clear") {
				const params: ThreadGoalClearParams = { threadId };
				const result = (await this.request(
					"thread/goal/clear",
					params,
				)) as ThreadGoalClearResponse;
				if (!result.cleared) throw new Error("Codex did not clear the goal");
				return { providerSessionId: threadId, goal: null };
			}
			const params: ThreadGoalSetParams = {
				threadId,
				...(control.action === "set"
					? {
							objective: control.objective.trim(),
							status: "active" as const,
							...(control.tokenBudget !== undefined
								? { tokenBudget: control.tokenBudget }
								: {}),
						}
					: { status: control.action === "pause" ? "paused" : "active" }),
			};
			const result = (await this.request(
				"thread/goal/set",
				params,
			)) as ThreadGoalSetResponse;
			return { providerSessionId: threadId, goal: result.goal };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/method not found|unknown method|-32601/i.test(message)) {
				throw new Error(
					"Goals require a newer Codex CLI. Update the Codex installation used by this session, then reopen it.",
				);
			}
			throw error;
		}
	}

	async startRealtime(
		request: ProviderRealtimeStart,
	): Promise<ProviderRealtimeStartResult> {
		const eventHandler = request.onEvent;
		try {
			if (!this.params.codexRealtimeEnabled) {
				throw new Error(
					"Codex realtime voice is disabled. Enable the Developer Preview in Forge first.",
				);
			}
			if (request.mode !== "live") {
				// Keep this tombstone after terminal cleanup so a late realtime_speak
				// cannot fall through and initialize Raven's ordinary thread.
				this.realtimeTransportOwner = "speech";
				this.realtimeSpeechMode = request.mode;
				return await this.startOwnedSpeech(request);
			}
			await this.ensureReady();
			await this.settleUnownedNativeTurn();
			const threadId = this.threadId;
			if (!threadId) throw new Error("Codex thread did not start");
			this.realtimeEventHandler = eventHandler;
			this.realtimeMode = request.mode;
			if (request.mode === "live") this.liveTurnIsolationActive = true;
			const params = this.realtimeStartParams(request, threadId);
			await this.request("thread/realtime/start", params);
			this.realtimeTransportOwner = "main";
			this.realtimeSpeechMode = null;
			return { providerSessionId: threadId };
		} catch (error) {
			if (this.realtimeEventHandler === eventHandler) {
				this.realtimeEventHandler = null;
				this.realtimeMode = null;
			}
			if (request.mode === "live") this.liveTurnIsolationActive = false;
			const message = codexRealtimeErrorMessage(error);
			markCodexRealtimeBackendError(message);
			if (
				/method not found|unknown method|-32601|realtime_conversation/i.test(
					message,
				)
			) {
				throw new Error(
					"Codex voice requires Codex CLI 0.145.0 or newer with realtime conversation support.",
				);
			}
			throw new Error(message);
		}
	}

	private realtimeStartParams(
		request: ProviderRealtimeStart,
		threadId: string,
	): ThreadRealtimeStartParams {
		return {
			threadId,
			outputModality: codexRealtimeOutputModality(),
			transport: { type: "webrtc", sdp: request.sdp },
			version: codexRealtimeVersion(request.mode),
			voice: request.voice as RealtimeVoice | undefined,
			includeStartupContext: request.mode === "live",
			clientManagedHandoffs: request.mode !== "live",
			// Codex tail flushing creates an ordinary chat delegation rather than a
			// realtime transcript final. Dictation must remain editable composer text.
			flushTranscriptTailOnSessionEnd: false,
			...(request.mode === "dictation"
				? {
						prompt:
							"Transcribe the user's speech faithfully. Do not answer or act on it.",
					}
				: request.mode === "read-aloud"
					? { prompt: CODEX_READ_ALOUD_REALTIME_PROMPT }
					: {}),
		};
	}

	private async startOwnedSpeech(
		request: ProviderRealtimeStart,
	): Promise<ProviderRealtimeStartResult> {
		if (request.mode === "live") {
			throw new Error("Live cannot use the isolated Codex speech thread");
		}
		if (this.ownedSpeech) {
			this.cleanupOwnedSpeech(
				this.ownedSpeech,
				new Error(`Codex ${this.ownedSpeech.mode} replaced by a new session`),
			);
		}
		const launch = codexLaunchConfig({
			cwd: this.params.cwd,
			executable: this.params.executable,
			profile: {
				...this.providerProfile,
				// Speech is reusable across recordings and read-aloud requests, but
				// never shares a process identity with Live or an ordinary conversation.
				registryKey: JSON.stringify([
					CODEX_SPEECH_REGISTRY_VERSION,
					this.providerProfile?.registryKey ?? null,
				]),
				args: [
					...(this.providerProfile?.args ?? []),
					"-c",
					"features.plugins=false",
					"-c",
					"features.apps=false",
					"-c",
					"features.hooks=false",
				],
			},
			enableRealtime: true,
		});
		const conn = acquireCodexAppServer(launch.appServer);
		let cancelStart = (_error: Error): void => {};
		const startCancelled = new Promise<never>((_resolve, reject) => {
			cancelStart = reject;
		});
		// Cleanup can happen after startup has completed, when no stage race still
		// owns this rejection. Keep that terminal signal handled in either case.
		void startCancelled.catch(() => {});
		const runtime: OwnedSpeechRuntime = {
			mode: request.mode,
			conn,
			threadId: null,
			handler: null,
			eventHandler: request.onEvent,
			started: false,
			cleaned: false,
			threadReleased: false,
			realtimeStartRequested: false,
			stopRequested: false,
			startCancelled,
			cancelStart,
		};
		this.ownedSpeech = runtime;
		try {
			await this.waitForOwnedSpeech(runtime, conn.ready);
			const configRead = asObj(
				await this.waitForOwnedSpeech(
					runtime,
					conn.requestOptional("config/read", {
						cwd: launch.rpcCwd,
						includeLayers: false,
					}),
				),
			);
			const effectiveMcpServers = asObj(asObj(configRead.config).mcp_servers);
			const effectiveFeatures = asObj(asObj(configRead.config).features);
			for (const feature of ["plugins", "apps", "hooks"]) {
				if (effectiveFeatures[feature] !== false) {
					throw new Error(
						`Codex ${runtime.mode} isolation failed: feature ${feature} is not confirmed disabled`,
					);
				}
			}
			const disabledMcpServers = Object.fromEntries(
				Object.keys(effectiveMcpServers).map((name) => [
					name,
					{ enabled: false },
				]),
			);
			const threadId = await this.waitForOwnedSpeech(
				runtime,
				conn
					.requestOptional("thread/start", {
						cwd: launch.rpcCwd,
						serviceName: "hlid",
						...(this.params.model ? { model: this.params.model } : {}),
						...(this.params.serviceTier
							? { serviceTier: this.params.serviceTier }
							: {}),
						ephemeral: true,
						approvalPolicy: "never",
						sandbox: "read-only",
						environments: [],
						dynamicTools: [],
						selectedCapabilityRoots: [],
						developerInstructions: CODEX_SPEECH_DEVELOPER_INSTRUCTIONS,
						config: {
							web_search: "disabled",
							agents: { enabled: false },
							features: {
								realtime_conversation: true,
								multi_agent: false,
								multi_agent_v2: false,
								apps: false,
								plugins: false,
								tool_suggest: false,
								unified_exec: false,
								hooks: false,
								goals: false,
								memories: false,
								image_generation: false,
								standalone_web_search: false,
								deferred_executor: false,
								request_permissions_tool: false,
								token_budget: false,
								current_time_reminder: false,
								shell_tool: false,
							},
							orchestrator: {
								skills: { enabled: false },
								mcp: { enabled: false },
							},
							tools: {
								update_plan: { enabled: false },
								experimental_request_user_input: { enabled: false },
							},
							skills: { include_instructions: false },
							notify: [],
							include_apps_instructions: false,
							include_collaboration_mode_instructions: false,
							include_environment_context: false,
							mcp_servers: disabledMcpServers,
						},
					} satisfies ThreadStartParams)
					.then((rawResult) => {
						const startedThreadId = String(
							asObj(asObj(rawResult).thread).id ?? "",
						);
						if (!startedThreadId) {
							throw new Error(
								`Codex ${runtime.mode} thread start did not return a thread id`,
							);
						}
						runtime.threadId = startedThreadId;
						if (runtime.cleaned) this.releaseOwnedSpeechThread(runtime);
						return startedThreadId;
					}),
			);
			runtime.handler = {
				onNotification: (method, params) => {
					if (runtime.cleaned || !method.startsWith("thread/realtime/")) {
						return;
					}
					const handled = this.handleRealtimeNotification(
						method,
						params,
						threadId,
						runtime.eventHandler,
					);
					if (
						handled &&
						(method === "thread/realtime/closed" ||
							method === "thread/realtime/error")
					) {
						if (method === "thread/realtime/closed") {
							runtime.stopRequested = true;
						}
						this.cleanupOwnedSpeech(
							runtime,
							new Error(
								method === "thread/realtime/error"
									? codexRealtimeErrorMessage(asObj(params).message)
									: `Codex ${runtime.mode} closed`,
							),
						);
					}
				},
				onRequest: async () => {
					throw new Error(
						`Codex ${runtime.mode} does not allow server requests`,
					);
				},
				onExit: (error) => {
					if (runtime.cleaned) return;
					if (runtime.started) {
						const message = codexRealtimeErrorMessage(error);
						markCodexRealtimeBackendError(message);
						runtime.eventHandler({ type: "error", message });
					}
					this.cleanupOwnedSpeech(runtime, error);
				},
			};
			conn.attachThread(threadId, runtime.handler);
			this.realtimeEventHandler = runtime.eventHandler;
			this.realtimeMode = request.mode;
			runtime.realtimeStartRequested = true;
			await this.waitForOwnedSpeech(
				runtime,
				conn.requestOptional(
					"thread/realtime/start",
					this.realtimeStartParams(request, threadId),
				),
			);
			if (runtime.cleaned) {
				throw new Error(`Codex ${runtime.mode} process exited while starting`);
			}
			runtime.started = true;
			return { providerSessionId: threadId };
		} catch (error) {
			this.cleanupOwnedSpeech(
				runtime,
				error instanceof Error ? error : new Error(String(error)),
			);
			throw error;
		}
	}

	private waitForOwnedSpeech<T>(
		runtime: OwnedSpeechRuntime,
		operation: Promise<T>,
	): Promise<T> {
		return Promise.race([operation, runtime.startCancelled]);
	}

	private releaseOwnedSpeechThread(runtime: OwnedSpeechRuntime): void {
		const threadId = runtime.threadId;
		if (!threadId || runtime.threadReleased) return;
		runtime.threadReleased = true;
		if (runtime.handler) {
			runtime.conn.detachThread(threadId, runtime.handler);
			runtime.handler = null;
		}
		if (runtime.realtimeStartRequested && !runtime.stopRequested) {
			runtime.stopRequested = true;
			void runtime.conn
				.requestOptional(
					"thread/realtime/stop",
					{ threadId } satisfies ThreadRealtimeStopParams,
					CODEX_SPEECH_RELEASE_TIMEOUT_MS,
				)
				.catch(() => {});
		}
		// Ephemeral speech threads are deliberately not resumed. Unsubscribe is
		// best effort so older app-servers can still share the hardened process.
		void runtime.conn
			.requestOptional(
				"thread/unsubscribe",
				{ threadId },
				CODEX_SPEECH_RELEASE_TIMEOUT_MS,
			)
			.catch(() => {});
	}

	private cleanupOwnedSpeech(runtime: OwnedSpeechRuntime, error: Error): void {
		if (runtime.cleaned) return;
		runtime.cleaned = true;
		runtime.cancelStart(error);
		if (this.ownedSpeech === runtime) this.ownedSpeech = null;
		this.releaseOwnedSpeechThread(runtime);
		const closeWaiter = this.realtimeCloseWaiter;
		if (closeWaiter?.eventHandler === runtime.eventHandler) {
			this.realtimeCloseWaiter = null;
			closeWaiter.resolve();
		}
		if (this.realtimeEventHandler === runtime.eventHandler) {
			this.realtimeEventHandler = null;
			this.realtimeMode = null;
		}
	}

	async appendRealtimeSpeech(text: string): Promise<void> {
		const ownedSpeech = this.ownedSpeech;
		if (ownedSpeech && !ownedSpeech.cleaned) {
			if (ownedSpeech.mode !== "read-aloud") {
				throw new Error("The active Codex speech session is not read-aloud.");
			}
			const threadId = ownedSpeech.threadId;
			if (!threadId) throw new Error("Codex read-aloud thread did not start");
			const params: ThreadRealtimeAppendSpeechParams = { threadId, text };
			await ownedSpeech.conn.request("thread/realtime/appendSpeech", params);
			return;
		}
		if (this.realtimeTransportOwner === "speech") {
			throw new Error(
				`No active Codex ${this.realtimeSpeechMode ?? "speech"} session.`,
			);
		}
		await this.ensureReady();
		const threadId = this.threadId;
		if (!threadId) throw new Error("Codex thread did not start");
		const params: ThreadRealtimeAppendSpeechParams = { threadId, text };
		await this.request("thread/realtime/appendSpeech", params);
	}

	async stopRealtime(): Promise<void> {
		const startingOwnedSpeech = this.ownedSpeech;
		if (
			!this.realtimeEventHandler &&
			!this.realtimeMode &&
			!startingOwnedSpeech &&
			!this.liveTurnIsolationActive
		) {
			return;
		}
		const eventHandler =
			startingOwnedSpeech?.eventHandler ?? this.realtimeEventHandler;
		const ownedSpeech =
			eventHandler && startingOwnedSpeech?.eventHandler === eventHandler
				? startingOwnedSpeech
				: null;
		const stoppingLive = !ownedSpeech && this.liveTurnIsolationActive;
		let resolveClosed = () => {};
		const closed = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});
		const closeWaiter = eventHandler
			? { eventHandler, resolve: resolveClosed }
			: null;
		if (closeWaiter) this.realtimeCloseWaiter = closeWaiter;
		let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (ownedSpeech) {
				if (!ownedSpeech.started) {
					ownedSpeech.cancelStart(
						new Error(`Codex ${ownedSpeech.mode} stopped`),
					);
				}
				const threadId = ownedSpeech.threadId;
				if (!threadId) return;
				const params: ThreadRealtimeStopParams = { threadId };
				ownedSpeech.stopRequested = true;
				try {
					await ownedSpeech.conn.requestOptional(
						"thread/realtime/stop",
						params,
					);
				} catch (error) {
					if (!ownedSpeech.cleaned) throw error;
				}
			} else if (this.realtimeEventHandler || this.realtimeMode) {
				await this.ensureReady();
				const threadId = this.threadId;
				if (!threadId) return;
				const params: ThreadRealtimeStopParams = { threadId };
				await this.request("thread/realtime/stop", params);
			}
			if (closeWaiter) {
				await Promise.race([
					closed,
					new Promise<void>((resolve) => {
						closeGraceTimer = setTimeout(
							resolve,
							CODEX_REALTIME_STOP_CLOSE_GRACE_MS,
						);
					}),
				]);
			}
			if (stoppingLive) await this.settleLiveNativeTurn();
		} finally {
			if (closeGraceTimer !== undefined) clearTimeout(closeGraceTimer);
			if (this.realtimeCloseWaiter === closeWaiter) {
				this.realtimeCloseWaiter = null;
			}
			// Codex can acknowledge the stop RPC before publishing the final
			// transcript and closed notifications. Retain this exact handler for a
			// bounded terminal grace, but never clear a newer realtime session.
			if (this.realtimeEventHandler === eventHandler) {
				this.realtimeEventHandler = null;
				this.realtimeMode = null;
			}
			if (ownedSpeech) {
				this.cleanupOwnedSpeech(
					ownedSpeech,
					new Error(`Codex ${ownedSpeech.mode} stopped`),
				);
			}
			if (stoppingLive) {
				this.liveTurnIsolationActive = false;
				this.liveHiddenTurnId = null;
			}
		}
	}

	async mcpServerStatus(): Promise<McpServerStatus[]> {
		try {
			const { conn } = await this.metadataConnection();
			const result = await readCodexMcpServerStatuses(
				(params, timeoutMs) =>
					conn.requestOptional("mcpServerStatus/list", params, timeoutMs),
				{ detail: "toolsAndAuthOnly", timeoutMs: 5_000 },
			);
			const servers = result.data;
			const mapped = servers.flatMap((server) => {
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
								: raw === "unknown"
									? "pending"
									: "connected";
				return [
					{
						name,
						status,
						...(typeof obj.error === "string" && obj.error
							? { error: obj.error }
							: {}),
					},
				];
			});
			const statuses = this.rootMcpServerStatuses();
			statuses.clear();
			for (const server of mapped) statuses.set(server.name, server);
			return mapped;
		} catch {
			return [];
		}
	}

	private rootMcpServerStatuses(): Map<string, McpServerStatus> {
		const key = this.threadId ?? "";
		let statuses = this.mcpServerStatusesByThread.get(key);
		if (!statuses && key) {
			statuses = this.mcpServerStatusesByThread.get("");
			if (statuses) {
				this.mcpServerStatusesByThread.delete("");
				this.mcpServerStatusesByThread.set(key, statuses);
			}
		}
		if (!statuses) {
			statuses = new Map();
			this.mcpServerStatusesByThread.set(key, statuses);
		}
		return statuses;
	}

	async usageWindows(): Promise<ProviderWindowReading[]> {
		await this.ensureReady();
		if (!this.conn) throw new Error("Codex app-server is not running");
		const observation = await this.conn.readAccountRateLimits();
		return observation.status === "current"
			? mapCodexRateLimitWindows(observation.snapshot)
			: [];
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
			profile: this.providerProfile,
			enableRealtime: this.params.codexRealtimeEnabled,
		});
		this.launch = launch;
		const conn = this.delegatedWindowsWorker
			? new CodexAppServer(launch.appServer)
			: acquireCodexAppServer(launch.appServer);
		if (this.delegatedWindowsWorker) this.ownedConnection = conn;
		this.conn = conn;
		if (this.params.signal) {
			if (this.params.signal.aborted) this.cancel();
			else
				this.params.signal.addEventListener("abort", () => this.cancel(), {
					once: true,
				});
		}
		await conn.ready;
		const permissionProfile = await this.permissionProfileForBoundary(
			launch.rpcCwd,
		);
		// The one-shot delegated worker validates the current plugin/runtime on a
		// fresh transport. Do not bind tool availability to a long-lived snapshot.
		const computerUseAvailable = this.canUseWindowsComputerUse();
		const visualizeAvailable =
			!this.delegatedWindowsWorker && this.params.providerId === "codex"
				? (await refreshWindowsVisualizeCapability(true)).available
				: false;

		const approvalsReviewerRequest = this.captureApprovalsReviewerRequest();
		const threadParams = {
			cwd: launch.rpcCwd,
			approvalsReviewer: approvalsReviewerRequest.sentReviewer,
			...(this.delegatedWindowsWorker?.kind === "visualize"
				? { runtimeWorkspaceRoots: [launch.rpcCwd] }
				: {}),
			ephemeral: this.params.persistSession === false,
			// The Windows Computer Use host only emits per-app approval
			// elicitations for user-owned threads. Without this source marker it
			// treats the standalone app-server worker as an internal/background
			// thread and performs app actions without asking its client.
			...(this.delegatedWindowsWorker?.kind === "computer-use"
				? { threadSource: "user" }
				: {}),
			...this.commonBoundaryParams(permissionProfile),
			...(this.params.permissionMode && !permissionProfile
				? {
						sandbox:
							this.delegatedWindowsWorker?.kind === "visualize"
								? "workspace-write"
								: (this.params.sandboxModeOverride ??
									sandboxMode(this.params.permissionMode)),
					}
				: {}),
			dynamicTools:
				this.delegatedWindowsWorker?.kind === "visualize"
					? []
					: hlidDynamicTools(computerUseAvailable, visualizeAvailable),
		} satisfies ThreadStartParams;
		const threadStartParams = {
			...threadParams,
			serviceName: "hlid",
		} satisfies ThreadStartParams;
		let rawResult: ThreadStartResponse | ThreadResumeResponse;
		let replacedMissingRollout = false;
		this.lastSentApprovalsReviewerContext = approvalsReviewerRequest;
		// Every fresh or resumed thread response is an authority boundary, including
		// transport recovery that reports the same value as the prior connection.
		this.lastReportedApprovalsReviewer = null;
		if (this.params.sessionId) {
			try {
				rawResult = (await this.request("thread/resume", {
					threadId: this.params.sessionId,
					...threadParams,
					// NOTE: `ephemeral` is a ThreadStartParams-only field —
					// ThreadResumeParams (vendored in ./codexProtocol) has no
					// such field, so this is likely a no-op/ignored on resume.
					// Pre-existing behavior; typed here, not changed.
				} satisfies ThreadResumeParams & {
					ephemeral?: boolean | null;
				})) as ThreadResumeResponse;
			} catch (error) {
				if (!isMissingRolloutError(error)) throw error;
				console.warn(
					"[codex] saved provider rollout is unavailable; starting a fresh thread",
				);
				// Hlið's DB transcript remains authoritative. Drop only the stale
				// provider id so future transport recovery cannot retry it again.
				this.params = { ...this.params, sessionId: undefined };
				replacedMissingRollout = true;
				rawResult = (await this.request(
					"thread/start",
					threadStartParams,
				)) as ThreadStartResponse;
			}
		} else {
			rawResult = (await this.request(
				"thread/start",
				threadStartParams,
			)) as ThreadStartResponse;
		}
		if (permissionProfile) {
			this.assertActivePermissionProfile(
				rawResult,
				permissionProfile,
				this.params.sessionId ? "resume" : "start",
			);
		}
		this.expectedActivePermissionProfile = permissionProfile ?? null;
		const result = asObj(rawResult);
		const thread = asObj(result.thread);
		if (typeof thread.id !== "string") {
			throw new Error("Codex thread start did not return a thread id");
		}
		this.threadId = thread.id;
		this.reportAuthoritativeApprovalsReviewer(
			rawResult.approvalsReviewer,
			"thread_response",
			approvalsReviewerRequest,
		);
		if (this.params.sessionId) {
			const resumedActiveTurnId = this.inProgressTurnId(thread);
			if (resumedActiveTurnId) {
				this.adoptUnownedNativeTurn(resumedActiveTurnId);
			}
		}
		this.resolvedModel =
			typeof thread.model === "string" && thread.model.trim()
				? thread.model
				: (this.params.model ?? null);
		if (this.canceled) return;
		this.threadHandler = {
			onNotification: (method, params) =>
				this.handleNotification(method, params),
			onRequest: (method, params, context) =>
				this.handleServerRequest(method, params, context),
			onExit: (err) => {
				if (this.canceled) return;
				this.handleAppServerExit(err);
			},
		};
		this.attachThread(thread.id);
		this.events.push({ type: "session_start", sessionId: thread.id });
		if (replacedMissingRollout) {
			this.events.push({
				type: "local_command_output",
				content:
					"Codex's saved provider history was unavailable. Continued in a fresh provider thread; Hlið's transcript is still preserved.",
			});
		}

		// Seed usage windows immediately; rolling account/rateLimits/updated
		// notifications keep them fresh during turns.
		void conn
			.readAccountRateLimits()
			.then((observation) => {
				if (observation.status === "current") {
					this.emitRateLimits(observation.snapshot);
				}
			})
			.catch(() => {});
	}

	private handleAppServerExit(error: Error): void {
		const resumeThreadId = this.threadId ?? this.params.sessionId;
		const interruptedTurn =
			this.ordinaryQueryActive && this.activeTurnId !== null;
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
		this.activeTurnIdIsAuthoritative = false;
		this.pendingOrphanTurnId = null;
		this.ordinaryQueryActive = false;
		this.ordinaryTurnStartPending = false;
		this.ownedOrdinaryTurnIds.clear();
		this.expectedActivePermissionProfile = null;
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
		if (this.conn && this.threadHandler) {
			for (const threadId of this.attachedThreadIds) {
				this.conn.detachThread(threadId, this.threadHandler);
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
				: acquireCodexAppServer(this.launch.appServer);
		await conn.ready;
		await conn.request("mcpServer/tool/call", {
			threadId: this.threadId,
			server: "node_repl",
			tool: "js_reset",
			arguments: {},
		});
	}

	/**
	 * Map a Codex RateLimitSnapshot onto Hlid rate_limit events. Rolling window
	 * identity comes from windowDurationMins, while an individual workspace
	 * spend control remains its own provider window.
	 */
	private emitRateLimits(raw: unknown): void {
		// Inbound payload — cast for shape hints, keep runtime guards.
		const snapshot = asObj(raw) as Partial<RateLimitSnapshot>;
		const reached = snapshot.rateLimitReachedType;
		const spendControlReached = snapshot.spendControlReached === true;
		// Credits-depleted variants don't reset with the window, so sleeping on
		// them is pointless — they stay "ok". The usage/rate-limit variants are
		// hard limits that lift at the window reset.
		const rollingHardLimited =
			reached === "rate_limit_reached" ||
			reached === "workspace_owner_usage_limit_reached" ||
			reached === "workspace_member_usage_limit_reached";
		// A window with no reading is normally skipped, but a hard limit must
		// still surface so downstream sleep logic sees the rejection.
		const windows = mapCodexRateLimitWindows(raw, rollingHardLimited);
		if (
			spendControlReached &&
			!windows.some((window) => window.windowId === "spend_control")
		) {
			windows.push({
				windowId: "spend_control",
				label: "SPEND",
				utilization: null,
				remaining: null,
				limit: null,
				resetsAt: null,
			});
		}
		// rateLimitReachedType is snapshot-level and doesn't name the window that
		// tripped; attribute the rejection to the most-utilized reported window
		// (five_hour on ties or when no readings exist) so an exhausted weekly
		// doesn't masquerade as a five_hour limit.
		let rejectedId: string | null = null;
		const rollingWindows = windows.filter(
			(window) => window.windowId !== "spend_control",
		);
		if (rollingHardLimited && rollingWindows.length > 0) {
			rejectedId = rollingWindows.reduce((best, w) =>
				(w.utilization ?? -1) > (best.utilization ?? -1) ? w : best,
			).windowId;
		}
		for (const w of windows) {
			const rejected =
				w.windowId === rejectedId ||
				(w.windowId === "spend_control" && spendControlReached);
			this.events.push({
				type: "rate_limit",
				status: rejected ? "rejected" : "ok",
				rateLimitType: w.windowId,
				...(w.utilization != null ? { utilization: w.utilization } : {}),
				resetsAt: w.resetsAt,
			});
		}
	}

	private request(method: string, params: unknown): Promise<unknown> {
		if (this.permissionProfileFailure) throw this.permissionProfileFailure;
		if (!this.conn) throw new Error("Codex app-server is not running");
		return this.conn.request(method, params);
	}

	private requestOptional(method: string, params: unknown): Promise<unknown> {
		if (this.permissionProfileFailure) throw this.permissionProfileFailure;
		if (!this.conn) throw new Error("Codex app-server is not running");
		return this.conn.requestOptional(method, params);
	}

	private commonBoundaryParams(permissionProfile: string | undefined) {
		return {
			...(this.params.model ? { model: this.params.model } : {}),
			...(this.params.serviceTier
				? { serviceTier: this.params.serviceTier }
				: {}),
			...(this.params.permissionMode
				? {
						approvalPolicy:
							this.delegatedWindowsWorker?.kind === "visualize"
								? ("never" as const)
								: effectiveApprovalPolicy(this.params),
						...(permissionProfile ? { permissions: permissionProfile } : {}),
					}
				: {}),
		};
	}

	private configuredPermissionProfile(): string | undefined {
		const selected = this.params.codex?.permissionProfile?.trim();
		if (
			!selected ||
			this.params.providerId !== "codex" ||
			this.delegatedWindowsWorker ||
			this.params.permissionMode === "plan" ||
			this.params.planHtmlPath ||
			this.params.sandboxModeOverride ||
			this.params.persistSession === false
		) {
			return undefined;
		}
		return selected;
	}

	private async permissionProfileForBoundary(
		cwd: string,
	): Promise<string | undefined> {
		const selected = this.configuredPermissionProfile();
		if (!selected) return undefined;
		const validationKey = JSON.stringify([cwd, selected]);
		if (this.validatedPermissionProfiles.has(validationKey)) return selected;
		let profiles: PermissionProfileSummary[];
		try {
			profiles = await readCodexPermissionProfiles({
				cwd,
				request: (method, params) => {
					if (!this.conn) throw new Error("Codex app-server is not running");
					return this.conn.requestOptional(method, params, 5_000);
				},
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Codex permission profile "${selected}" could not be validated for ${cwd}: ${detail}`,
			);
		}
		const profile = profiles.find((candidate) => candidate.id === selected);
		if (!profile) {
			throw new Error(
				`Codex permission profile "${selected}" is not available for ${cwd}. Refresh Forge and select an available profile or use Hlid sandbox policy.`,
			);
		}
		if (!profile.allowed) {
			throw new Error(
				`Codex permission profile "${selected}" is not allowed for ${cwd} by the effective Codex requirements. Select an allowed profile or use Hlid sandbox policy.`,
			);
		}
		this.validatedPermissionProfiles.add(validationKey);
		return selected;
	}

	private assertActivePermissionProfile(
		response: ThreadStartResponse | ThreadResumeResponse,
		expected: string,
		boundary: "start" | "resume",
	): void {
		const active = asObj(response.activePermissionProfile);
		if (active.id === expected) return;
		throw new Error(
			`Codex thread ${boundary} did not activate permission profile "${expected}"; provider reported ${this.describeActivePermissionProfile(active)}.`,
		);
	}

	private describeActivePermissionProfile(value: unknown): string {
		const id = asObj(value).id;
		return typeof id === "string" && id.trim()
			? `"${id}"`
			: "no active profile";
	}

	private observeActivePermissionProfile(threadSettings: unknown): void {
		const settings = asObj(threadSettings);
		const expected = this.expectedActivePermissionProfile;
		// Older app-servers can omit this newer field. Enforce only a profile Hlid
		// explicitly sent at the current native boundary and an authoritative field
		// the provider actually published.
		if (
			!expected ||
			!Object.hasOwn(settings, "activePermissionProfile") ||
			this.permissionProfileFailure
		) {
			return;
		}
		const active = settings.activePermissionProfile;
		if (asObj(active).id === expected) return;

		const error = new Error(
			`Codex thread settings changed away from required permission profile "${expected}"; provider reported ${this.describeActivePermissionProfile(active)}. Hlid stopped this runtime before another turn. Start a new turn to resume with the selected profile, or choose an available profile in Forge.`,
		);
		this.permissionProfileFailure = error;
		this.events.push({ type: "transport_error", message: error.message });
		this.cancel();
	}

	private async resolveWindowsWorkerSettings(
		executable: string,
		cwd: string,
		dedicatedCatalog = false,
	): Promise<WindowsComputerUseResolution> {
		let nativeModels: ProviderModelInfo[] = [];
		let catalogError: string | undefined;
		try {
			nativeModels = await fetchCodexModels({
				executable,
				cwd,
				dedicated: dedicatedCatalog,
			});
		} catch (error) {
			catalogError = error instanceof Error ? error.message : String(error);
		}
		return resolveWindowsComputerUseSettings({
			configured: this.params.windowsComputerUse,
			sessionModel: this.resolvedModel ?? this.params.model,
			sessionEffort: this.params.effort,
			nativeModels,
			catalogError,
		});
	}

	private async runWindowsComputerUse(
		task: string,
		context: string | undefined,
		toolId: string,
	): Promise<WindowsComputerUseResult> {
		const executable = resolveCodexExecutable();
		if (!windowsComputerUseHostAvailable(process.platform, executable)) {
			throw new Error(
				"Windows Computer Use requires the Windows Hlid host and a native Codex CLI",
			);
		}
		const cwd = windowsComputerUseWorkspace();
		mkdirSync(cwd, { recursive: true });
		const resolved = await this.resolveWindowsWorkerSettings(executable, cwd);
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
				approvalsReviewer: "user",
				implementationPermissionMode: undefined,
				planHtmlPath: undefined,
				additionalDirectories: undefined,
				// Hlid owns this one-shot worker and returns its result to the caller.
				// Use a fresh native app-server for each task so a desktop update cannot
				// leave this worker on an obsolete plugin path or native approval pipe.
				persistSession: false,
			},
			{ kind: "computer-use", task },
		);
		let text = "";
		let threadId = "";
		let completion: Extract<AgentEvent, { type: "done" }> | null = null;
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
				const updatedText = updateWindowsWorkerText(text, event);
				if (event.type === "session_start") {
					threadId = event.sessionId;
					snapshot = attachedWindowsWorkerSnapshot(
						snapshot,
						threadId,
						"Working in the Windows desktop",
					);
					this.emitSubagentUpdate(toolId, snapshot);
				} else if (updatedText !== null) {
					text = updatedText;
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
					completion = event;
				}
			}
			if (!threadId)
				throw new Error("Windows Codex did not return a thread id");
			if (!completion || completion.stopReason === "error")
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
			return windowsWorkerCompletion(
				completion,
				resolved.notice
					? `Configuration note: ${resolved.notice}\n\n${text.trim()}`
					: text.trim(),
				threadId,
			);
		} catch (error) {
			const workerCompletion = completion
				? windowsWorkerCompletion(completion, text.trim(), threadId)
				: null;
			const enrichedError = workerCompletion
				? new WindowsComputerUseError(
						error instanceof Error ? error.message : String(error),
						workerCompletion,
					)
				: error;
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
			throw enrichedError;
		} finally {
			// Computer Use opens a per-thread Node kernel. Ephemeral history alone
			// does not tear that process down, so reset the owned MCP session and
			// terminate its dedicated app-server after every one-shot worker.
			await child.resetNodeRepl().catch(() => {});
			child.cancel();
		}
	}

	private async runWindowsVisualize(
		request: string,
		context: string | undefined,
		toolId: string,
	): Promise<WindowsVisualizeResult> {
		const sessionId = this.params.hostSessionId;
		if (this.params.providerId !== "codex") {
			throw new Error(
				"The Windows Visualize bridge is available only to Codex",
			);
		}
		if (!sessionId) {
			throw new Error(
				"Visualizations require an owning Hlid conversation session",
			);
		}
		const executable = resolveCodexExecutable();
		if (!windowsComputerUseHostAvailable(process.platform, executable)) {
			throw new Error(
				"Visualize requires the Windows Hlid host and a native Codex CLI",
			);
		}
		const capability = await refreshWindowsVisualizeCapability(true);
		const skill = windowsVisualizeSkill;
		if (!capability.available || !skill) {
			throw new Error(
				`Windows Visualize is unavailable${capability.reason ? `: ${capability.reason}` : ""}`,
			);
		}

		await prepareLibrary();
		const jobRoot = visualizationStagingJobDirectory(randomUUID());
		mkdirSync(jobRoot, { mode: 0o700 });
		const resolved = await this.resolveWindowsWorkerSettings(
			executable,
			jobRoot,
			true,
		);
		let snapshot: SubagentSnapshot = {
			provider: "codex",
			agentId: toolId,
			label: "Windows Visualize",
			prompt: request,
			model: resolved.model,
			effort: resolved.effort,
			status: "running",
			currentStep:
				resolved.notice ??
				`Starting Windows Visualize · ${resolved.model} · ${resolved.effort}`,
			startedAtMs: Date.now(),
		};
		this.emitSubagentUpdate(toolId, snapshot);
		const child = new CodexAgentSession(
			{
				...this.params,
				cwd: jobRoot,
				hostSessionId: undefined,
				sessionId: undefined,
				executable,
				model: resolved.model,
				effort: resolved.effort,
				permissionMode: "default",
				approvalsReviewer: "user",
				implementationPermissionMode: undefined,
				sandboxModeOverride: undefined,
				policyEnforced: false,
				usageGateEnforced: false,
				beforeToolUse: undefined,
				planHtmlPath: undefined,
				additionalDirectories: undefined,
				vaultName: undefined,
				agentMode: undefined,
				codexRealtimeEnabled: false,
				onGoalChange: undefined,
				canUseTool: async () => ({
					behavior: "deny",
					message:
						"The isolated Visualize worker cannot request permissions outside its job root.",
				}),
				persistSession: false,
			},
			{ kind: "visualize", task: request },
		);
		const workerStartedAtMs = Date.now();
		let text = "";
		let threadId = "";
		let completion: Extract<AgentEvent, { type: "done" }> | null = null;
		let latestUsage: CanonicalTokenUsage | null = null;
		let latestUsageModel = resolved.model;
		let timedOut = false;
		let workerTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			workerTimer = setTimeout(() => {
				timedOut = true;
				child.cancel();
			}, WINDOWS_VISUALIZE_WORKER_TIMEOUT_MS);
			const prompt = [
				"You are a Windows-native Codex Visualize worker delegated by Hlid.",
				"Use the selected visualize:visualize skill to create exactly one in-conversation HTML visualization fragment for the request below.",
				`Your isolated writable root is:\n${jobRoot}`,
				"Write the fragment beneath that root, follow the skill's lowercase filename and 2 MiB contract, and finish with exactly one standalone ::codex-inline-vis directive naming it.",
				"Create the fragment directly with apply_patch. Do not call exec_command, PowerShell, cmd, bash, or another shell in this worker; Hlid will read, validate, and render the fragment after you finish.",
				"Mobile interaction requirement: keep one-finger scrolling available over the dominant visual down to 320px. Never use touch-action: none, viewport-height layouts, or internal vertical scrolling. If a custom pointer surface needs an explicit touch-action, use pan-x pan-y pinch-zoom so browser scrolling still works.",
				"Do not start Project Preview, publish a Relic, edit the user's vault or repository, delegate work, run the bundled renderer, or use window.openai follow-up actions.",
				context ? `Context and source data:\n${context}` : "",
				`Visualization request:\n${request}`,
			]
				.filter(Boolean)
				.join("\n\n");
			await child.sendWithSkill(prompt, skill);
			child.closeInput();
			for await (const event of child) {
				const updatedText = updateWindowsWorkerText(text, event);
				if (updatedText !== null) {
					text = updatedText;
				} else if (event.type === "session_start") {
					threadId = event.sessionId;
					snapshot = attachedWindowsWorkerSnapshot(
						snapshot,
						threadId,
						"Building visualization…",
					);
					this.emitSubagentUpdate(toolId, snapshot);
				} else if (event.type === "tool_start") {
					snapshot = {
						...snapshot,
						lastTool: event.name,
						currentStep: event.name.toLowerCase().includes("apply_patch")
							? "Writing visualization…"
							: "Building visualization…",
					};
					this.emitSubagentUpdate(toolId, snapshot);
				} else if (event.type === "tool_result" && event.isError) {
					const sandboxLaunchFailed =
						/windows sandbox[\s\S]*(?:windows error|error)\s*1312/i.test(
							event.content,
						);
					snapshot = {
						...snapshot,
						currentStep: sandboxLaunchFailed
							? "Windows sandbox launch failed; Visualize is retrying…"
							: "Visualize tool failed; worker is retrying…",
					};
					this.emitSubagentUpdate(toolId, snapshot);
				} else if (event.type === "usage") {
					latestUsage = windowsWorkerUsage(event);
					latestUsageModel = event.model ?? resolved.model;
				} else if (event.type === "transport_error") {
					throw new Error(event.message);
				} else if (event.type === "done") {
					completion = event;
				}
			}
			if (timedOut) {
				throw new Error("Windows Visualize worker timed out");
			}
			if (workerTimer !== undefined) {
				clearTimeout(workerTimer);
				workerTimer = undefined;
			}
			if (!threadId)
				throw new Error("Windows Codex did not return a thread id");
			if (!completion || completion.stopReason !== "completed") {
				throw new Error("Windows Visualize did not complete");
			}
			if (!text.trim()) {
				throw new Error(
					"Windows Visualize completed without an artifact directive",
				);
			}

			// Stop the native worker before Hlid validates and persists its output.
			child.cancel();
			snapshot = {
				...snapshot,
				currentStep: "Validating visualization…",
			};
			this.emitSubagentUpdate(toolId, snapshot);
			const artifact = await extractWindowsVisualizeArtifact({
				text,
				jobRoot,
			});
			const title = visualizationTitle(artifact.filename).slice(0, 80);
			const renderInputPath = await createWindowsVisualizeRenderInput({
				sourcePath: artifact.sourcePath,
				jobRoot,
				validatedSha256: artifact.validatedSha256,
			});
			const renderedPath = resolve(jobRoot, "visualization-rendered.html");
			await renderWindowsVisualization(
				skill,
				renderInputPath,
				renderedPath,
				title,
				jobRoot,
			);
			const ingested = await ingestVisualizationHtml({
				sourcePath: renderedPath,
				sessionId,
				title: "visualization",
				agentCwd: this.params.cwd,
			});
			if (!ingested) {
				throw new Error("Hlid could not persist the rendered visualization");
			}
			snapshot = {
				...snapshot,
				status: "completed",
				currentStep: "Visualization ready",
				endedAtMs: Date.now(),
			};
			this.emitSubagentUpdate(toolId, snapshot);
			return {
				...windowsWorkerCompletion(
					completion,
					"Visualization created and attached in Raven.",
					threadId,
				),
				attachmentId: ingested.id,
				filename: ingested.filename,
				title,
			};
		} catch (error) {
			const failure = timedOut
				? new Error("Windows Visualize worker timed out")
				: error;
			const workerCompletion = completion
				? windowsWorkerCompletion(completion, "", threadId)
				: latestUsage
					? partialWindowsWorkerCompletion({
							usage: latestUsage,
							model: latestUsageModel,
							threadId,
							startedAtMs: workerStartedAtMs,
						})
					: null;
			snapshot = {
				...snapshot,
				status: "failed",
				currentStep: "Visualization failed",
				endedAtMs: Date.now(),
			};
			this.emitSubagentUpdate(toolId, snapshot);
			throw workerCompletion
				? new WindowsVisualizeError(
						failure instanceof Error ? failure.message : String(failure),
						workerCompletion,
					)
				: failure;
		} finally {
			if (workerTimer !== undefined) clearTimeout(workerTimer);
			child.cancel();
			// jobRoot is returned only by Hlid's containment-enforcing library helper.
			cleanupWindowsVisualizeJobRoot(jobRoot);
		}
	}

	private addWindowsWorkerErrorUsage(error: unknown): void {
		const completion =
			error instanceof WindowsComputerUseError ||
			error instanceof WindowsVisualizeError
				? error.completion
				: undefined;
		if (!completion) return;
		this.addQueryUsage(completion.usage, completion.estimatedCost);
		this.queryTurns += completion.turns;
	}

	private async handleDynamicToolCall(
		params: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<DynamicToolCallResponse> {
		if (params.namespace === OBSIDIAN_AGENT_NAMESPACE) {
			try {
				const toolName = String(params.tool ?? "");
				if (
					!isObsidianAgentToolReadOnly(toolName) &&
					(toolName === "run_command" ||
						this.params.permissionMode !== "bypassPermissions" ||
						this.params.policyEnforced)
				) {
					const decision = await this.params.canUseTool(
						`mcp__${OBSIDIAN_AGENT_NAMESPACE}__${toolName}`,
						params.arguments,
						{
							toolUseID: String(params.callId ?? `${toolName}-${Date.now()}`),
							signal,
							title: `Obsidian ${toolName.replaceAll("_", " ")}`,
						},
					);
					if (decision.behavior === "deny") {
						return {
							success: false,
							contentItems: [
								{
									type: "inputText",
									text:
										decision.message ??
										"The Obsidian note change was not approved.",
								},
							],
						};
					}
				}
				return {
					success: true,
					contentItems: [
						{
							type: "inputText",
							text: await executeObsidianAgentTool(toolName, params.arguments),
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
		if (
			params.namespace === HLID_AGENT_NAMESPACE &&
			HLID_AGENT_TOOL_SPECS.some((candidate) => candidate.name === params.tool)
		) {
			const spec = HLID_AGENT_TOOL_SPECS.find(
				(candidate) => candidate.name === params.tool,
			);
			if (!spec) throw new Error(`Unknown Hlid tool: ${params.tool}`);
			try {
				if (
					!spec.readOnly &&
					(this.params.permissionMode !== "bypassPermissions" ||
						this.params.policyEnforced)
				) {
					const decision = await this.params.canUseTool(
						`mcp__${HLID_AGENT_NAMESPACE}__${params.tool}`,
						params.arguments,
						{
							toolUseID: String(params.callId ?? `hlid-tool-${Date.now()}`),
							signal,
							title: spec.approvalTitle,
						},
					);
					if (decision.behavior === "deny") {
						return {
							success: false,
							contentItems: [
								{
									type: "inputText",
									text:
										decision.message ??
										`${spec.approvalTitle ?? "The Hlid action"} was not approved.`,
								},
							],
						};
					}
				}
				const result = await executeHlidAgentToolRich(
					spec.name,
					params.arguments,
					{
						providerId: this.params.providerId ?? "codex",
						model: this.params.model,
						effort: this.params.effort,
						permissionMode: this.params.permissionMode,
						policyEnforced: this.params.policyEnforced,
						codexRealtimeEnabled: this.params.codexRealtimeEnabled,
						runtimeCwd: this.params.cwd,
						sessionId: this.params.hostSessionId,
						vaultName: this.params.vaultName,
						agentMode: this.params.agentMode,
					},
				);
				return {
					success: true,
					contentItems: [
						{
							type: "inputText",
							text: result.text,
						},
						...(result.images ?? []).map((image) => ({
							type: "inputImage" as const,
							imageUrl: `data:${image.mimeType};base64,${image.data}`,
						})),
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
		if (
			params.namespace === WINDOWS_VISUALIZE_NAMESPACE &&
			params.tool === WINDOWS_VISUALIZE_TOOL
		) {
			const args = asObj(params.arguments);
			const request =
				typeof args.request === "string" ? args.request.trim() : "";
			const context =
				typeof args.context === "string" ? args.context.trim() : undefined;
			if (!request) {
				return {
					success: false,
					contentItems: [
						{ type: "inputText", text: "A non-empty request is required." },
					],
				};
			}
			try {
				const toolId = String(
					params.callId ?? `windows-visualize-${Date.now()}`,
				);
				const result = await this.runWindowsVisualize(request, context, toolId);
				this.addQueryUsage(result.usage, result.estimatedCost);
				this.queryTurns += result.turns;
				return {
					success: true,
					contentItems: [
						{
							type: "inputText",
							text: JSON.stringify({
								type: "hlid_visualization",
								attachment_id: result.attachmentId,
								filename: result.filename,
								title: result.title,
							}),
						},
					],
				};
			} catch (error) {
				this.addWindowsWorkerErrorUsage(error);
				console.warn(
					"[codex] Windows Visualize failed:",
					error instanceof Error ? error.message : String(error),
				);
				return dynamicToolFailure(new Error(WINDOWS_VISUALIZE_FAILURE_MESSAGE));
			}
		}
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
			this.addQueryUsage(result.usage, result.estimatedCost);
			this.queryTurns += result.turns;
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
			this.addWindowsWorkerErrorUsage(error);
			return dynamicToolFailure(error);
		}
	}

	private async handleMcpElicitation(
		params: Record<string, unknown>,
		signal: AbortSignal,
		requestId: ServerRequestContext["requestId"],
	): Promise<McpServerElicitationRequestResponse> {
		const isComputerUse =
			this.delegatedWindowsWorker?.kind === "computer-use" ||
			isComputerUseElicitation(params);
		if (isComputerUse) {
			if (typeof this.params.canUseTool !== "function") {
				return { action: "decline", content: null, _meta: null };
			}
			const details = computerUseApprovalDetails(params);
			const serverName = String(params.serverName ?? "MCP server");
			const appKey = details.appId ?? details.displayName;
			const task =
				this.delegatedWindowsWorker?.kind === "computer-use"
					? this.delegatedWindowsWorker.task
					: undefined;
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
					toolUseID:
						nativeServerRequestToolUseId(requestId) ??
						`codex-elicitation-${String(params.threadId ?? "thread")}-${++this.elicitationSequence}`,
					signal,
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

		if (signal.aborted) {
			return { action: "cancel", content: null, _meta: null };
		}
		if (params.mode === "openai/form") {
			return { action: "decline", content: null, _meta: null };
		}
		const serverName =
			typeof params.serverName === "string" ? params.serverName.trim() : "";
		const message =
			typeof params.message === "string" ? params.message.trim() : "";
		if (
			!serverName ||
			!message ||
			typeof this.params.canUseTool !== "function"
		) {
			return { action: "decline", content: null, _meta: null };
		}
		const toolUseID =
			nativeServerRequestToolUseId(requestId) ??
			`codex-elicitation-${String(params.threadId ?? "thread")}-${++this.elicitationSequence}`;
		const ask = (
			questions: ReturnType<typeof providerElicitationQuestions>,
			url?: string,
		) =>
			this.params
				.canUseTool(
					"AskUserQuestion",
					{ questions },
					{
						toolUseID,
						signal,
						title: message,
						displayName: serverName,
						interaction: {
							provider_id: "codex",
							kind: "mcp_elicitation",
							source_name: serverName,
							summary: message,
							...(url ? { url } : {}),
						},
					},
				)
				.catch(() => null);
		const decisionState = (decision: AgentToolDecision | null) => {
			const answers = providerElicitationDecisionAnswers(decision);
			const action =
				signal.aborted || providerElicitationWasCancelled(answers)
					? ("cancel" as const)
					: decision?.behavior !== "allow"
						? ("decline" as const)
						: null;
			return { answers, action };
		};

		if (params.mode === "url") {
			const url = safeProviderElicitationUrl(params.url);
			if (!url) return { action: "decline", content: null, _meta: null };
			const decision = await ask(
				[
					{
						question: CODEX_ELICITATION_URL_QUESTION,
						options: [
							CODEX_ELICITATION_URL_CONTINUE,
							CODEX_ELICITATION_URL_DECLINE,
						],
						multiSelect: false,
					},
				],
				url,
			);
			const state = decisionState(decision);
			if (state.action) {
				return { action: state.action, content: null, _meta: null };
			}
			const answer = providerElicitationSelectedAnswer(
				state.answers?.[CODEX_ELICITATION_URL_QUESTION],
			);
			if (answer === CODEX_ELICITATION_URL_CONTINUE) {
				return { action: "accept", content: null, _meta: null };
			}
			if (answer === CODEX_ELICITATION_URL_DECLINE) {
				return { action: "decline", content: null, _meta: null };
			}
			return { action: "cancel", content: null, _meta: null };
		}

		if (params.mode !== "form") {
			return { action: "decline", content: null, _meta: null };
		}
		const fields = parseProviderElicitationFields(params.requestedSchema);
		if (!fields) return { action: "decline", content: null, _meta: null };
		const decision = await ask(providerElicitationQuestions(fields));
		const state = decisionState(decision);
		if (state.action) {
			return { action: state.action, content: null, _meta: null };
		}
		if (!state.answers) {
			return { action: "cancel", content: null, _meta: null };
		}
		const content = providerElicitationContent(fields, state.answers);
		return content
			? { action: "accept", content, _meta: null }
			: { action: "cancel", content: null, _meta: null };
	}

	private async handleServerRequest(
		method: string,
		rawParams: unknown,
		context: ServerRequestContext,
	): Promise<unknown> {
		const params = asObj(rawParams);
		const signal = serverRequestSignal(context.signal, this.params.signal);
		// Visualize runs as a no-tools, job-root-only worker. Never let generic
		// bypass-permissions handling widen that contract, even if Codex asks for
		// a permission or attempts a dynamic/MCP call that was not advertised.
		if (this.delegatedWindowsWorker?.kind === "visualize") {
			if (method === "item/tool/requestUserInput") return { answers: {} };
			if (method === "item/tool/call") {
				return dynamicToolFailure(
					new Error("Tools are unavailable in the isolated Visualize worker"),
				);
			}
			if (method === "mcpServer/elicitation/request") {
				return { action: "decline", content: null, _meta: null };
			}
			return this.deniedServerRequestResult(method);
		}
		if (!this.ownsServerRequest(params)) {
			if (method === "item/tool/requestUserInput") return { answers: {} };
			if (method === "item/tool/call") {
				return dynamicToolFailure(
					new Error(
						"The Codex turn that requested this tool is no longer active",
					),
				);
			}
			if (method === "mcpServer/elicitation/request") {
				return { action: "decline", content: null, _meta: null };
			}
			return this.deniedServerRequestResult(method);
		}
		if (method === "item/tool/requestUserInput") {
			return this.handleRequestUserInput(params, signal);
		}
		if (method === "item/tool/call") {
			return this.handleDynamicToolCall(params, signal);
		}
		if (method === "mcpServer/elicitation/request") {
			// MCP elicitations are provider-owned blocking input and must always flow
			// through Hlid, even when the surrounding session bypasses tool approvals.
			return this.handleMcpElicitation(params, signal, context.requestId);
		}
		if (
			!this.params.policyEnforced &&
			!this.params.usageGateEnforced &&
			autoApprovesPermissions(this.params)
		) {
			// Bypass mode is a turn-level host decision, not permission to persist
			// a native grant after the session returns to an approval-gated mode.
			return this.allowedServerRequestResult(method, params);
		}
		if (typeof this.params.canUseTool !== "function") {
			return this.deniedServerRequestResult(method);
		}
		const itemId = String(params.itemId ?? params.approvalId ?? "approval");
		const toolUseID = serverRequestToolUseId(params, context.requestId);
		const startedItem = this.startedItems.get(itemId);
		const filePath =
			method === "item/fileChange/requestApproval" ||
			method === "applyPatchApproval"
				? (filePathFromItem(startedItem) ?? filePathFromItem(params))
				: null;
		const command =
			method === "item/commandExecution/requestApproval" ||
			method === "execCommandApproval"
				? (commandFromProviderInput(params) ??
					commandFromStartedItem(startedItem))
				: null;
		const commandParams =
			params as Partial<CommandExecutionRequestApprovalParams>;
		const fileParams = params as Partial<FileChangeRequestApprovalParams>;
		const networkContext = commandParams.networkApprovalContext ?? null;
		const toolName = filePath ? "Write" : command ? "bash" : method;
		const toolInput = filePath
			? {
					file_path: filePath,
					...(typeof fileParams.grantRoot === "string"
						? { grantRoot: fileParams.grantRoot }
						: {}),
				}
			: command
				? {
						command,
						...(commandParams.cwd != null ? { cwd: commandParams.cwd } : {}),
						...(commandParams.commandActions != null
							? { commandActions: commandParams.commandActions }
							: {}),
						...(networkContext != null
							? { networkApprovalContext: networkContext }
							: {}),
						...(commandParams.additionalPermissions != null
							? { additionalPermissions: commandParams.additionalPermissions }
							: {}),
						...(commandParams.proposedExecpolicyAmendment != null
							? {
									proposedExecpolicyAmendment:
										commandParams.proposedExecpolicyAmendment,
								}
							: {}),
						...(commandParams.proposedNetworkPolicyAmendments != null
							? {
									proposedNetworkPolicyAmendments:
										commandParams.proposedNetworkPolicyAmendments,
								}
							: {}),
						...(commandParams.availableDecisions != null
							? { availableDecisions: commandParams.availableDecisions }
							: {}),
					}
				: params;
		const decision = await this.params.canUseTool(toolName, toolInput, {
			toolUseID,
			signal,
			title: networkContext
				? `Allow Codex to access ${networkContext.protocol}://${networkContext.host}?`
				: "Codex wants approval",
			displayName: networkContext ? "Codex network access" : method,
			description:
				typeof params.reason === "string" ? params.reason : undefined,
		});
		if (decision.behavior !== "allow") {
			return this.deniedServerRequestResult(method);
		}
		if (
			this.params.permissionMode === "plan" &&
			filePath &&
			isHtmlPlanPath(filePath, this.params.planHtmlPath)
		) {
			this.approvedHtmlPlanItemId = itemId;
		}
		return this.allowedServerRequestResult(method, params, decision.saveScope);
	}

	private ownsServerRequest(params: Record<string, unknown>): boolean {
		if (this.delegatedWindowsWorker?.kind === "computer-use") return true;
		const requestThreadId =
			typeof params.threadId === "string" ? params.threadId : this.threadId;
		if (requestThreadId && requestThreadId !== this.threadId) {
			return (
				this.queryChildThreadIds.has(requestThreadId) ||
				(this.realtimeMode === "live" &&
					this.liveTurnIsolationActive &&
					this.subagentByThread.has(requestThreadId))
			);
		}
		const requestTurnId =
			typeof params.turnId === "string" ? params.turnId : null;
		if (this.realtimeMode === "live" && this.liveTurnIsolationActive) {
			return !requestTurnId || requestTurnId === this.liveHiddenTurnId;
		}
		if (!this.ordinaryQueryActive) return false;
		return !requestTurnId || this.ownedOrdinaryTurnIds.has(requestTurnId);
	}

	private async handleRequestUserInput(
		params: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ answers: Record<string, { answers: string[] }> }> {
		// Codex 0.147 makes this lifecycle explicit. A non-blocking request may be
		// resolved by the provider without a user response, so never leave Hlid's
		// shared blocking-input card waiting after the native request has moved on.
		if (params.isBlocking === false) return { answers: {} };
		if (typeof this.params.canUseTool !== "function") return { answers: {} };
		const itemId = String(params.itemId ?? "request-user-input");
		const decision = await this.params.canUseTool("AskUserQuestion", params, {
			toolUseID: itemId,
			signal,
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
		saveScope?: "session" | "local",
	): ApprovalRequestResult {
		if (method === "item/permissions/requestApproval") {
			// `params.permissions` arrives via the tolerant asObj() parse above
			// (inbound, not compile-time checked) — cast, don't re-derive.
			const permissions =
				(params.permissions as GrantedPermissionProfile | undefined) ?? {};
			// Codex's native `session` scope persists the grant into later turns.
			// An unsaved Hlid approval is Allow once, so keep it turn-scoped. Both
			// Hlid session and local persistence intentionally grant the current
			// native thread; Hlid owns persistence beyond that thread.
			return {
				scope: saveScope === undefined ? "turn" : "session",
				permissions,
			};
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
		this.emittedAgentMessageText.clear();
		this.emittedReasoningIds.clear();
		this.emittedUnidentifiedAgentMessageText = "";
		this.startedItems.clear();
		this.emittedGeneratedMediaIds.clear();
		this.backgroundCommandCandidates.clear();
		this.approvedHtmlPlanItemId = null;
		this.htmlPlanReady = false;
		this.nativePlanText = "";
	}

	private addQueryUsage(
		usage: CanonicalTokenUsage,
		estimatedCost?: number | null,
		model: string | undefined = this.usageModel(),
	): void {
		this.queryUsage.inputTokens += usage.inputTokens;
		this.queryUsage.outputTokens += usage.outputTokens;
		this.queryUsage.cacheReadTokens += usage.cacheReadTokens;
		this.queryUsage.cacheCreationTokens += usage.cacheCreationTokens;
		const cost =
			estimatedCost === undefined
				? estimateCodexCost(model, usage)
				: estimatedCost;
		if (cost == null) this.queryUsageIsPriced = false;
		else this.queryEstimatedCost += cost;
	}

	private recordCumulativeUsage(
		threadId: string,
		value: unknown,
		model?: string,
	): boolean {
		if (!threadId) return false;
		const total = maybeTotalUsage(value);
		if (!total) return false;
		const previous = this.cumulativeUsageByThread.get(threadId);
		const nondecreasing =
			previous != null &&
			total.inputTokens >= previous.inputTokens &&
			total.outputTokens >= previous.outputTokens &&
			total.cacheReadTokens >= previous.cacheReadTokens &&
			total.cacheCreationTokens >= previous.cacheCreationTokens;
		const fallback = maybeLastUsage(value) ?? total;
		const increment = nondecreasing
			? {
					inputTokens: total.inputTokens - previous.inputTokens,
					outputTokens: total.outputTokens - previous.outputTokens,
					cacheReadTokens: total.cacheReadTokens - previous.cacheReadTokens,
					cacheCreationTokens:
						total.cacheCreationTokens - previous.cacheCreationTokens,
				}
			: fallback;
		this.cumulativeUsageByThread.set(threadId, total);
		this.cumulativeUsageTurns.add(threadId);
		if (
			increment.inputTokens > 0 ||
			increment.outputTokens > 0 ||
			increment.cacheReadTokens > 0 ||
			increment.cacheCreationTokens > 0
		) {
			// Each cumulative snapshot advances by the usage of the model call that
			// produced it. Price the delta independently so several short-context
			// calls do not accidentally trigger the long-context multiplier merely
			// because their query-wide sum crosses the threshold.
			this.addQueryUsage(increment, undefined, model);
		}
		return true;
	}

	private resetQueryAccounting(): void {
		this.clearPendingDone();
		this.activeTurnModel = null;
		this.queryAssistantMessageIds.clear();
		this.queryUsage = emptyCodexUsage();
		this.queryEstimatedCost = 0;
		this.queryUsageIsPriced = true;
		this.queryTurns = 0;
		this.queryWebSearchItemIds.clear();
		this.childLastUsage.clear();
		this.actualModelByTurn.clear();
		this.cumulativeUsageTurns.clear();
		this.queryChildThreadIds.clear();
		this.ordinaryQueryActive = false;
		this.ordinaryTurnStartPending = false;
		this.ownedOrdinaryTurnIds.clear();
	}

	private clearPendingDone(): void {
		if (!this.pendingDone) return;
		clearTimeout(this.pendingDone.timer);
		this.pendingDone = null;
	}

	private ownsOpenQuery(): boolean {
		return (
			(this.ordinaryQueryActive && this.activeTurnId !== null) ||
			this.pendingDone !== null
		);
	}

	private usageModel(): string | undefined {
		return this.activeTurnModel ?? this.resolvedModel ?? this.params.model;
	}

	private ownChildThread(threadId: string): void {
		if (threadId && this.ownsOpenQuery()) {
			this.queryChildThreadIds.add(threadId);
		}
	}

	private hasUnsettledChildren(): boolean {
		return (
			this.pendingSubagentToolIds.size > 0 || this.queryChildThreadIds.size > 0
		);
	}

	private abandonUnsettledChildren(): void {
		for (const threadId of this.queryChildThreadIds) {
			const toolId = this.subagentByThread.get(threadId);
			const current = toolId ? this.subagentSnapshots.get(toolId) : undefined;
			if (toolId && current) {
				this.emitSubagentUpdate(toolId, {
					...current,
					status: "interrupted",
					currentStep: "Usage collection timed out after parent completion",
					endedAtMs: Date.now(),
				});
			}
			if (this.conn && this.threadHandler) {
				this.conn.detachThread(threadId, this.threadHandler);
			}
			this.attachedThreadIds.delete(threadId);
			this.subagentByThread.delete(threadId);
			this.childLastUsage.delete(threadId);
			this.cumulativeUsageTurns.delete(threadId);
		}
		for (const toolId of this.pendingSubagentToolIds) {
			const current = this.subagentSnapshots.get(toolId);
			if (!current) continue;
			this.emitSubagentUpdate(toolId, {
				...current,
				status: "interrupted",
				currentStep:
					"Subagent did not attach before usage collection timed out",
				endedAtMs: Date.now(),
			});
		}
		this.queryChildThreadIds.clear();
		this.pendingSubagentToolIds.clear();
	}

	private finalizeQueryDone(turn: Record<string, unknown>): void {
		const queryUsage = { ...this.queryUsage };
		const queryTurns = this.queryTurns;
		const webSearchCalls = this.queryWebSearchItemIds.size;
		const hostedToolCost = estimateCodexCost(
			this.usageModel(),
			emptyCodexUsage(),
			{ webSearchCalls },
		);
		this.resetTurnTracking();
		this.events.push({
			type: "done",
			estimatedCost:
				this.queryUsageIsPriced && hostedToolCost != null
					? this.queryEstimatedCost + hostedToolCost
					: null,
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

	private maybeFinalizePendingDone(): void {
		if (!this.pendingDone || this.hasUnsettledChildren()) return;
		const { turn } = this.pendingDone;
		this.clearPendingDone();
		this.finalizeQueryDone(turn);
	}

	private deferDoneForChildren(turn: Record<string, unknown>): void {
		this.clearPendingDone();
		const timer = setTimeout(() => {
			const pending = this.pendingDone;
			if (!pending) return;
			this.abandonUnsettledChildren();
			this.clearPendingDone();
			this.finalizeQueryDone(pending.turn);
		}, CODEX_CHILD_SETTLE_TIMEOUT_MS);
		this.pendingDone = { turn, timer };
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
		// A provider-driven continuation is still part of the same Hlid query.
		// Cancel a provisional completion while retaining its accumulated usage.
		this.clearPendingDone();
		const id = asObj(obj.turn).id;
		if (typeof id === "string") {
			this.activeTurnModel = this.params.model ?? this.resolvedModel;
			this.activeTurnId = id;
			this.activeTurnIdIsAuthoritative = true;
			this.ownedOrdinaryTurnIds.add(id);
			this.events.push({ type: "provider_turn_id", id });
		}
		if (this.threadId) this.cumulativeUsageTurns.delete(this.threadId);
		this.resetTurnTracking();
		this.lastUsage = emptyCodexUsage();
	}

	private beginAssistantMessage(itemId: string): void {
		const key = itemId || "__unidentified_agent_message__";
		if (this.queryAssistantMessageIds.has(key)) return;
		if (this.queryAssistantMessageIds.size > 0) {
			this.events.push({ type: "assistant_message_boundary" });
		}
		this.queryAssistantMessageIds.add(key);
	}

	private handleAgentMessageDelta(obj: Record<string, unknown>): void {
		const text = textFromUnknown(obj.delta ?? obj.text ?? obj.content);
		if (!text) return;
		const itemId = String(obj.itemId ?? obj.id ?? "");
		this.beginAssistantMessage(itemId);
		if (itemId) {
			this.emittedAgentMessageText.set(
				itemId,
				(this.emittedAgentMessageText.get(itemId) ?? "") + text,
			);
		} else {
			this.emittedUnidentifiedAgentMessageText += text;
		}
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

	private emitItemActivity(event: AgentEvent): void {
		if (
			this.realtimeMode === "live" &&
			this.realtimeEventHandler &&
			isProviderRealtimeActivity(event)
		) {
			this.realtimeEventHandler({ type: "activity", event });
			return;
		}
		this.events.push(event);
	}

	private emitReasoning(item: Record<string, unknown>): void {
		const text = codexReasoningText(item);
		const id = String(item.id ?? `reasoning-${this.activeTurnId ?? "turn"}`);
		if (!text || this.emittedReasoningIds.has(id)) return;
		this.emittedReasoningIds.add(id);
		this.emitItemActivity({
			type: "tool_start",
			toolId: id,
			name: "Reasoning",
			input: {},
		});
		this.emitItemActivity({
			type: "tool_result",
			toolId: id,
			content: text,
		});
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
		this.recordBackgroundCommandStarted(item, obj);
		this.startedItems.set(itemId, item);
		if (type === "imageGeneration") {
			this.emitItemActivity({
				type: "tool_start",
				toolId: itemId,
				name: "ImageGeneration",
				input: {
					type: "imageGeneration",
					status: String(item.status ?? "in_progress"),
				},
			});
			return;
		}
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
			this.emitItemActivity({
				type: "tool_start",
				toolId: itemId,
				name: "spawn_agent",
				input: prompt ? { prompt } : input,
				subagent,
			});
			return;
		}
		const taskActivity =
			toolName === "update_plan" ? codexPlanActivity(input) : undefined;
		this.emitItemActivity({
			type: "tool_start",
			toolId: itemId,
			name: toolName,
			input,
			...(taskActivity ? { taskActivity } : {}),
		});
	}

	private emitSubagentUpdate(toolId: string, subagent: SubagentSnapshot): void {
		this.subagentSnapshots.set(toolId, subagent);
		this.emitItemActivity({ type: "tool_update", toolId, subagent });
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
		const alreadyMapped = this.subagentByThread.has(threadId);
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
			if (!alreadyMapped) this.ownChildThread(threadId);
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
		this.ownChildThread(threadId);
		this.subagentSnapshots.set(activityId, subagent);
		this.attachThread(threadId);
		this.emitItemActivity({
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
				const alreadyMapped = this.subagentByThread.has(threadId);
				this.subagentByThread.set(threadId, sourceToolId);
				if (!alreadyMapped) this.ownChildThread(threadId);
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
		const text = textFromUnknown(item.text ?? item.content);
		if (!text) return;
		const emittedText = itemId
			? (this.emittedAgentMessageText.get(itemId) ?? "")
			: this.emittedUnidentifiedAgentMessageText;
		if (text === emittedText) return;
		this.beginAssistantMessage(itemId);

		// Completed message content is authoritative in Codex 0.146. AgentEvent
		// text remains append-only for the common dropped-suffix case. If an
		// earlier delta was dropped or corrupted, replace the emitted tail so the
		// completed message wins without duplicating streamed text.
		if (text.startsWith(emittedText)) {
			const suffix = text.slice(emittedText.length);
			if (suffix) this.events.push({ type: "text_delta", text: suffix });
		} else {
			this.events.push({
				type: "text_replace",
				text,
				previousText: emittedText,
			});
		}
		if (itemId) this.emittedAgentMessageText.set(itemId, text);
		else this.emittedUnidentifiedAgentMessageText = text;
	}

	private handleCompletedTurnAgentMessage(turn: Record<string, unknown>): void {
		if (turn.status !== "completed" || !Array.isArray(turn.items)) return;
		for (let index = turn.items.length - 1; index >= 0; index -= 1) {
			const item = asObj(turn.items[index]);
			if (
				item.type === "agentMessage" &&
				(item.phase == null || item.phase === "final_answer")
			) {
				this.handleCompletedAgentMessage(item);
				return;
			}
		}
	}

	private completedItemIsError(item: Record<string, unknown>): boolean {
		if (item.success === false) return true;
		const status =
			typeof item.status === "string" ? item.status.toLowerCase() : "";
		return [
			"failed",
			"error",
			"errored",
			"cancelled",
			"canceled",
			"declined",
		].includes(status);
	}

	private completedToolResultContent(item: Record<string, unknown>): string {
		if (item.type === "dynamicToolCall" && Array.isArray(item.contentItems)) {
			const text = item.contentItems
				.map((contentItem) => asObj(contentItem).text)
				.filter((value): value is string => typeof value === "string");
			if (text.length > 0) return text.join("\n");
			if (
				item.contentItems.some(
					(contentItem) => asObj(contentItem).type === "inputImage",
				)
			) {
				return "[Image result omitted from durable transcript]";
			}
		}
		return JSON.stringify(item);
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
		this.recordBackgroundCommandCompleted(item, obj);
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
		if (type === "imageGeneration") {
			if (!this.startedItems.has(itemId)) {
				this.emitItemActivity({
					type: "tool_start",
					toolId: itemId,
					name: "ImageGeneration",
					input: {
						type: "imageGeneration",
						status: "in_progress",
					},
				});
				this.startedItems.set(itemId, item);
			}
			if (!this.emittedGeneratedMediaIds.has(itemId)) {
				this.emittedGeneratedMediaIds.add(itemId);
				this.emitItemActivity({
					type: "generated_media",
					toolId: itemId,
					kind: "image",
					status: String(item.status ?? "completed"),
					mime: "image/png",
					...(typeof item.result === "string" && item.result
						? { dataBase64: item.result }
						: {}),
					...(typeof item.revisedPrompt === "string" && item.revisedPrompt
						? { prompt: item.revisedPrompt }
						: {}),
					...(typeof item.savedPath === "string" && item.savedPath
						? { providerPath: item.savedPath }
						: {}),
				});
			}
			this.maybeFinalizePendingDone();
			return;
		}
		if (type === "userMessage" || !type) return;
		if (type === "collabAgentToolCall") {
			this.mergeCollabAgentStates(item);
			if (item.tool === "wait") return;
		}
		this.emitItemActivity({
			type: "tool_result",
			toolId: String(item.id ?? type),
			content: this.completedToolResultContent(item),
			...(this.completedItemIsError(item) ? { isError: true } : {}),
		});
		this.maybeFinalizePendingDone();
	}

	private observeUnownedItemLifecycle(
		method: string,
		obj: Record<string, unknown>,
	): void {
		const item = asObj(obj.item);
		if (method === "item/started") {
			this.recordBackgroundCommandStarted(item, obj);
		} else if (method === "item/completed") {
			this.recordBackgroundCommandCompleted(item, obj);
		}
	}

	private recordUsage(usage: AgentEvent | null): void {
		if (usage?.type !== "usage") return;
		if (usage.model) {
			this.resolvedModel = usage.model;
			if (this.ownsOpenQuery()) this.activeTurnModel = usage.model;
		}
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
		const turnId = this.notificationTurnId(asObj(params));
		const model =
			usage.model ?? this.actualModelByTurn.get(turnId) ?? this.usageModel();
		const threadId = this.threadId ?? "";
		if (!this.ownsOpenQuery()) {
			// A resumed thread can publish its current cumulative token snapshot
			// before the next turn starts. Keep that total as the subtraction
			// baseline, but do not attribute the prior turn's last call to a future
			// Hlid query.
			const total = maybeTotalUsage(params);
			if (threadId && total) this.cumulativeUsageByThread.set(threadId, total);
			return;
		}
		const capturedCumulative = this.recordCumulativeUsage(
			threadId,
			params,
			model,
		);
		const queryUsage = capturedCumulative
			? this.queryUsage
			: {
					inputTokens: this.queryUsage.inputTokens + usage.inputTokens,
					outputTokens: this.queryUsage.outputTokens + usage.outputTokens,
					cacheReadTokens:
						this.queryUsage.cacheReadTokens + (usage.cacheReadTokens ?? 0),
					cacheCreationTokens:
						this.queryUsage.cacheCreationTokens +
						(usage.cacheCreationTokens ?? 0),
				};
		this.events.push({
			...usage,
			...(model ? { model } : {}),
			queryUsage: { ...queryUsage },
		});
	}

	private handleChildTokenUsageUpdated(
		threadId: string,
		params: unknown,
	): void {
		if (
			!this.queryChildThreadIds.has(threadId) &&
			!(this.realtimeMode === "live" && this.subagentByThread.has(threadId))
		) {
			return;
		}
		const usage = maybeUsage(params);
		if (usage?.type !== "usage") return;
		const turnId = this.notificationTurnId(asObj(params));
		const model =
			usage.model ?? this.actualModelByTurn.get(turnId) ?? this.usageModel();
		this.childLastUsage.set(threadId, {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens ?? 0,
			cacheCreationTokens: usage.cacheCreationTokens ?? 0,
		});
		this.recordCumulativeUsage(threadId, params, model);
	}

	private handleMcpStartupStatus(raw: unknown): void {
		const notification = raw as McpServerStatusUpdatedNotification;
		if (!notification.name) return;
		// MCP inventory is provider-wide in Hlid. A subagent may have a different
		// startup lifecycle, but its delta must never replace the root inventory.
		if (
			notification.threadId &&
			this.threadId &&
			notification.threadId !== this.threadId
		) {
			return;
		}
		const statuses = this.rootMcpServerStatuses();
		const status: McpServerStatus["status"] =
			notification.status === "ready"
				? "connected"
				: notification.status === "failed"
					? notification.failureReason === "reauthenticationRequired"
						? "needs-auth"
						: "failed"
					: notification.status === "cancelled"
						? "disabled"
						: "pending";
		statuses.set(notification.name, {
			name: notification.name,
			status,
			...(notification.error ? { error: notification.error } : {}),
		});
		this.events.push({
			type: "mcp_status",
			servers: [...statuses.values()].sort((a, b) =>
				a.name.localeCompare(b.name),
			),
		});
	}

	private async handleTurnCompleted(
		obj: Record<string, unknown>,
		params: unknown,
	): Promise<void> {
		const turn = asObj(obj.turn);
		const completedTurnId =
			typeof turn.id === "string" ? turn.id : this.activeTurnId;
		const completedCurrentTurn =
			!completedTurnId || this.activeTurnId === completedTurnId;
		const completedUsage = maybeUsage(turn) ?? maybeUsage(params);
		const completedModel =
			(completedUsage?.type === "usage" ? completedUsage.model : undefined) ??
			(completedTurnId
				? this.actualModelByTurn.get(completedTurnId)
				: undefined) ??
			this.usageModel();
		this.handleCompletedTurnAgentMessage(turn);
		this.recordUsage(completedUsage);
		const threadId = this.threadId ?? String(obj.threadId ?? "");
		const capturedFinalTotal =
			this.recordCumulativeUsage(threadId, turn, completedModel) ||
			this.recordCumulativeUsage(threadId, params, completedModel);
		if (!capturedFinalTotal && !this.cumulativeUsageTurns.has(threadId)) {
			// Older app-server payloads expose only the final call. Preserve that
			// fallback without double-counting modern cumulative snapshots.
			this.addQueryUsage(this.lastUsage, undefined, completedModel);
		}
		if (completedTurnId) this.actualModelByTurn.delete(completedTurnId);
		this.cumulativeUsageTurns.delete(threadId);
		this.queryTurns += 1;
		if (completedTurnId) this.ownedOrdinaryTurnIds.delete(completedTurnId);
		if (completedCurrentTurn) {
			this.activeTurnId = null;
			this.activeTurnIdIsAuthoritative = false;
		}
		this.projectRunningCommandActivities();
		// A provider-driven continuation can start before the prior completion is
		// delivered. Account for that completed turn, but do not finish or clear
		// the newer active turn.
		if (!completedCurrentTurn && this.activeTurnId) return;
		const plan =
			this.nativePlanText.trim() ||
			(this.htmlPlanReady || this.params.planHtmlPath
				? "HTML plan ready for review."
				: null);
		if (this.params.permissionMode === "plan" && plan) {
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
		if (this.hasUnsettledChildren()) {
			this.deferDoneForChildren(turn);
			return;
		}
		this.finalizeQueryDone(turn);
	}

	private handleChildTurnCompleted(obj: Record<string, unknown>): void {
		const threadId = String(obj.threadId ?? "");
		if (!threadId || threadId === this.threadId) return;
		const ordinaryChild = this.queryChildThreadIds.has(threadId);
		const liveChild =
			this.realtimeMode === "live" && this.subagentByThread.has(threadId);
		if (!ordinaryChild && !liveChild) return;
		const turn = asObj(obj.turn);
		if (ordinaryChild) {
			const turnId = typeof turn.id === "string" ? turn.id : "";
			const reportedUsage = maybeUsage(turn) ?? maybeUsage(obj);
			const model =
				(reportedUsage?.type === "usage" ? reportedUsage.model : undefined) ??
				this.actualModelByTurn.get(turnId) ??
				this.usageModel();
			const capturedFinalTotal =
				this.recordCumulativeUsage(threadId, turn, model) ||
				this.recordCumulativeUsage(threadId, obj, model);
			const usage =
				reportedUsage?.type === "usage"
					? {
							inputTokens: reportedUsage.inputTokens,
							outputTokens: reportedUsage.outputTokens,
							cacheReadTokens: reportedUsage.cacheReadTokens ?? 0,
							cacheCreationTokens: reportedUsage.cacheCreationTokens ?? 0,
						}
					: this.childLastUsage.get(threadId);
			if (
				usage &&
				!capturedFinalTotal &&
				!this.cumulativeUsageTurns.has(threadId)
			) {
				this.addQueryUsage(usage, undefined, model);
			}
			if (turnId) this.actualModelByTurn.delete(turnId);
			this.queryTurns += 1;
		}
		this.childLastUsage.delete(threadId);
		this.cumulativeUsageTurns.delete(threadId);
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
		if (ordinaryChild) {
			this.queryChildThreadIds.delete(threadId);
			this.maybeFinalizePendingDone();
		}
	}

	private handleRealtimeNotification(
		method: string,
		params: unknown,
		expectedThreadId: string,
		eventHandler: ProviderRealtimeEventHandler,
	): boolean {
		if (String(asObj(params).threadId ?? "") !== expectedThreadId) return false;
		switch (method) {
			case "thread/realtime/started": {
				const notification = params as ThreadRealtimeStartedNotification;
				eventHandler({
					type: "started",
					...(notification.realtimeSessionId
						? { realtimeSessionId: notification.realtimeSessionId }
						: {}),
				});
				return true;
			}
			case "thread/realtime/sdp": {
				const notification = params as ThreadRealtimeSdpNotification;
				markCodexRealtimeBackendAccepted();
				eventHandler({ type: "sdp", sdp: notification.sdp });
				return true;
			}
			case "thread/realtime/outputAudio/delta": {
				// WebRTC carries the audio and does not currently mirror this notification
				// onto the app-server sideband. Keep it as an optional start signal for
				// transports such as websocket that do emit output-audio deltas.
				eventHandler({ type: "audio_output_started" });
				return true;
			}
			case "thread/realtime/transcript/delta": {
				const notification =
					params as ThreadRealtimeTranscriptDeltaNotification;
				eventHandler({
					type: "transcript_delta",
					role: notification.role,
					delta: notification.delta,
				});
				return true;
			}
			case "thread/realtime/transcript/done": {
				const notification = params as ThreadRealtimeTranscriptDoneNotification;
				eventHandler({
					type: "transcript_done",
					role: notification.role,
					text: notification.text,
				});
				return true;
			}
			case "thread/realtime/error": {
				const notification = params as ThreadRealtimeErrorNotification;
				const message = codexRealtimeErrorMessage(notification.message);
				markCodexRealtimeBackendError(message);
				eventHandler({ type: "error", message });
				return true;
			}
			case "thread/realtime/closed": {
				const notification = params as ThreadRealtimeClosedNotification;
				// Deliver terminal state before cleanup so the transcript owner can commit
				// its final UI state while the exact callback is still authoritative.
				eventHandler({
					type: "closed",
					...(notification.reason ? { reason: notification.reason } : {}),
				});
				const closeWaiter = this.realtimeCloseWaiter;
				if (closeWaiter?.eventHandler === eventHandler) {
					this.realtimeCloseWaiter = null;
					closeWaiter.resolve();
				}
				if (this.realtimeEventHandler === eventHandler) {
					this.realtimeEventHandler = null;
					this.realtimeMode = null;
				}
				return true;
			}
			default:
				return false;
		}
	}

	private handleNotification(method: string, params: unknown): void {
		const obj = asObj(params);
		if (method.startsWith("thread/realtime/")) {
			if (this.ownedSpeech) return;
			const eventHandler =
				this.realtimeEventHandler ?? this.realtimeCloseWaiter?.eventHandler;
			if (eventHandler && this.threadId) {
				this.handleRealtimeNotification(
					method,
					params,
					this.threadId,
					eventHandler,
				);
			}
			return;
		}
		const notificationThreadId = String(
			obj.threadId ?? asObj(obj.thread).id ?? "",
		);
		const childNotification =
			notificationThreadId.length > 0 && notificationThreadId !== this.threadId;
		const parentNotification = !childNotification;
		if (
			childNotification &&
			this.liveTurnIsolationActive &&
			this.realtimeMode !== "live" &&
			!this.queryChildThreadIds.has(notificationThreadId)
		) {
			return;
		}
		const notificationTurnId = this.notificationTurnId(obj);
		if (
			parentNotification &&
			notificationTurnId &&
			this.suppressedTurnIds.has(notificationTurnId)
		) {
			return;
		}
		const isolatingLiveTurn =
			this.realtimeMode === "live" || this.liveTurnIsolationActive;
		if (isolatingLiveTurn && parentNotification) {
			if (method === "turn/started") {
				const id = asObj(obj.turn).id;
				if (typeof id === "string") {
					this.liveHiddenTurnId = id;
					this.activeTurnId = id;
					this.activeTurnIdIsAuthoritative = true;
				}
				return;
			}
			if (method === "turn/completed") {
				const id = asObj(obj.turn).id;
				if (typeof id === "string" && this.liveHiddenTurnId === id) {
					this.liveHiddenTurnId = null;
					if (this.activeTurnId === id) {
						this.activeTurnId = null;
						this.activeTurnIdIsAuthoritative = false;
					}
				}
				return;
			}
			if (method === "thread/tokenUsage/updated") return;
		}
		if (this.realtimeMode === "live") {
			// Live voice receives its user-visible transcript and audio through the
			// realtime channel. Keep the mirrored turn lifecycle and assistant text
			// out of the dormant ordinary AgentEvent queue, but retain item boundaries
			// so their normalized tool activity can use the realtime callback.
			// Parent turn notifications mirror the Live response, but child turn
			// completion is the authoritative terminal signal for a visible subagent
			// card and must still flow through emitItemActivity.
			if (method.startsWith("turn/") && !childNotification) return;
			if (
				method.startsWith("item/") &&
				method !== "item/started" &&
				method !== "item/completed"
			) {
				return;
			}
			const liveItemType = String(asObj(obj.item).type);
			if (
				(method === "item/started" || method === "item/completed") &&
				(liveItemType === "agentMessage" || liveItemType === "userMessage")
			) {
				return;
			}
		}
		if (
			parentNotification &&
			this.realtimeMode !== "live" &&
			method.startsWith("item/") &&
			!this.ordinaryQueryActive
		) {
			this.observeUnownedItemLifecycle(method, obj);
			return;
		}
		if (
			parentNotification &&
			this.realtimeMode !== "live" &&
			method.startsWith("item/") &&
			(!notificationTurnId ||
				!this.ownedOrdinaryTurnIds.has(notificationTurnId))
		) {
			if (notificationTurnId && this.ordinaryTurnStartPending) {
				this.ownedOrdinaryTurnIds.add(notificationTurnId);
				this.activeTurnId = notificationTurnId;
				this.activeTurnIdIsAuthoritative = true;
			} else {
				this.observeUnownedItemLifecycle(method, obj);
				return;
			}
		}
		if (
			parentNotification &&
			method === "thread/tokenUsage/updated" &&
			notificationTurnId &&
			!this.ownedOrdinaryTurnIds.has(notificationTurnId)
		) {
			return;
		}
		switch (method) {
			case "thread/settings/updated": {
				const notification = params as ThreadSettingsUpdatedNotification;
				if (!childNotification && notification.threadId === this.threadId) {
					this.observeActivePermissionProfile(notification.threadSettings);
					if (this.permissionProfileFailure) break;
					this.reportAuthoritativeApprovalsReviewer(
						notification.threadSettings?.approvalsReviewer,
						"thread_settings",
						this.lastSentApprovalsReviewerContext,
					);
				}
				break;
			}
			case "thread/goal/updated": {
				const notification = params as ThreadGoalUpdatedNotification;
				if (!childNotification && notification.goal) {
					this.goalChangeHandler?.(notification.goal as ProviderThreadGoal);
				}
				break;
			}
			case "thread/goal/cleared": {
				const notification = params as ThreadGoalClearedNotification;
				if (!childNotification && notification.threadId === this.threadId) {
					this.goalChangeHandler?.(null);
				}
				break;
			}
			case "thread/started":
				if (!childNotification) this.handleThreadStarted(obj);
				break;
			case "turn/started":
				if (!childNotification) {
					const id = asObj(obj.turn).id;
					if (typeof id !== "string") break;
					if (!this.ordinaryQueryActive) {
						this.adoptUnownedNativeTurn(id);
						break;
					}
					this.handleTurnStarted(obj);
				}
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
			case "model/rerouted": {
				const notification = params as ModelReroutedNotification;
				const ownedReroute = childNotification
					? this.queryChildThreadIds.has(notification.threadId)
					: this.ordinaryQueryActive &&
						(this.ownedOrdinaryTurnIds.has(notification.turnId) ||
							this.ordinaryTurnStartPending ||
							this.activeTurnId === notification.turnId);
				if (ownedReroute && notification.turnId && notification.toModel) {
					this.actualModelByTurn.set(notification.turnId, notification.toModel);
					if (!childNotification) this.activeTurnModel = notification.toModel;
				}
				break;
			}
			case "thread/tokenUsage/updated":
				if (childNotification) {
					this.handleChildTokenUsageUpdated(notificationThreadId, params);
				} else if (this.ordinaryQueryActive)
					this.handleTokenUsageUpdated(params);
				break;
			case "mcpServer/startupStatus/updated":
				this.handleMcpStartupStatus(params);
				break;
			case "turn/completed":
				if (childNotification) this.handleChildTurnCompleted(obj);
				else {
					const id = asObj(obj.turn).id;
					if (typeof id === "string" && this.pendingOrphanTurnId === id) {
						this.pendingOrphanTurnId = null;
						if (this.activeTurnId === id) {
							this.activeTurnId = null;
							this.activeTurnIdIsAuthoritative = false;
						}
						break;
					}
					if (
						!this.ordinaryQueryActive ||
						typeof id !== "string" ||
						!this.ownedOrdinaryTurnIds.has(id)
					) {
						break;
					}
					void this.handleTurnCompleted(obj, params);
				}
				break;
		}
	}
}

export class CodexProvider implements AgentProvider {
	readonly providerId: string;
	readonly label: string;
	// fallow-ignore-next-line unused-class-member -- Read through AgentProvider by the provider catalog.
	readonly capabilities = {
		goalControl: true,
		structuredActivities: ["compact", "review"],
		realtime: true,
		appCatalog: true,
		appAuthentication: true,
		backgroundActivities: {
			maturity: "experimental",
			operations: ["list", "terminate", "clean"],
		},
		generatedMedia: {
			maturity: "stable",
			operations: ["persist", "preview", "download"],
		},
	} as const;
	hlidToolLoading() {
		const computerUseAvailable = windowsComputerUseHostAvailable();
		const visualizeAvailable =
			this.providerId === "codex" &&
			cachedWindowsVisualizeCapability().available;
		const hlidTools = [
			...describeHlidToolLoading(HLID_AGENT_TOOL_SPECS, true),
			...(computerUseAvailable
				? [
						{
							name: HLID_WINDOWS_COMPUTER_USE_TOOL,
							delivery: "loaded" as const,
						},
					]
				: []),
			...(visualizeAvailable
				? [
						{
							name: HLID_CREATE_VISUALIZATION_TOOL,
							delivery: "loaded" as const,
						},
					]
				: []),
		];
		const obsidianTools = describeHlidToolLoading(
			OBSIDIAN_AGENT_TOOL_SPECS,
			true,
		);
		return [
			buildHlidToolLoadingSummary("hlid", hlidTools),
			buildHlidToolLoadingSummary("hlid_obsidian", obsidianTools),
		];
	}
	// fallow-ignore-next-line unused-class-member -- Read through AgentProvider by the provider catalog.
	readonly forkCapability = {
		kind: "exact",
		cutoff: "turn",
		wholeSession: true,
		throughMessage: true,
	} as const;
	protected readonly providerProfile?: CodexProviderProfile;
	private readonly realtimeEnabled: () => boolean;
	private readonly metadataExecutable: () => string | undefined;
	private readonly appAuthAttempts = new Map<string, CodexAppAuthAttempt>();

	constructor(
		options: {
			providerId?: string;
			label?: string;
			profile?: CodexProviderProfile;
			/** Current Hlid preview state for provider-owned metadata operations. */
			realtimeEnabled?: () => boolean;
			/** Current configured executable for provider-owned metadata operations. */
			metadataExecutable?: () => string | undefined;
		} = {},
	) {
		this.providerId = options.providerId ?? "codex";
		this.label = options.label ?? "Codex";
		this.providerProfile = options.profile;
		this.realtimeEnabled = options.realtimeEnabled ?? (() => false);
		this.metadataExecutable =
			options.metadataExecutable ?? (() => resolveCodexExecutable());
	}

	private metadataLaunchConfig(params: {
		cwd: string;
		executable?: string;
	}): CodexLaunchConfig {
		return codexLaunchConfig({
			cwd: params.cwd,
			executable: params.executable ?? this.metadataExecutable(),
			profile: this.providerProfile,
			enableRealtime: this.realtimeEnabled(),
		});
	}

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

	readonly approvalReviewers = [
		{
			value: "user",
			label: "User review",
			desc: "approval requests wait for you",
			isDefault: true,
		},
		{
			value: "auto_review",
			label: "Auto-review",
			desc: "Codex reviews native interactive requests; bypass mode has none",
		},
	] as const;

	readonly usageWindows: ReadonlyArray<{
		windowId: string;
		label: string;
		windowSecs: number;
		optional?: boolean;
	}> = [
		{ windowId: "five_hour", label: "5-HOUR", windowSecs: 5 * 3600 },
		{ windowId: "weekly", label: "7-DAY", windowSecs: 7 * 86400 },
		{
			windowId: "spend_control",
			label: "SPEND",
			windowSecs: 30 * 86400,
			optional: true,
		},
	] as const;

	async check(): Promise<{ available: boolean; reason?: string }> {
		const exe = this.metadataExecutable();
		if (!exe) return { available: false, reason: "Codex CLI not found" };
		return { available: true };
	}

	// fallow-ignore-next-line unused-class-member -- Invoked through AgentProvider.listSkills by the provider skill catalog.
	async listSkills(context: {
		cwd: string;
		executable?: string;
	}): Promise<ProviderSkillInfo[]> {
		const launch = this.metadataLaunchConfig(context);
		const conn = acquireCodexAppServer(launch.appServer);
		await conn.ready;
		const result = await conn.request("skills/list", {
			cwds: [launch.rpcCwd],
		});
		return skillsFromListResponse(result).flatMap((skill) => {
			const name = typeof skill.name === "string" ? skill.name.trim() : "";
			if (!name) return [];
			return [
				{
					name,
					description:
						typeof skill.description === "string" ? skill.description : "",
					...(typeof skill.path === "string" ? { path: skill.path } : {}),
					...(typeof skill.scope === "string" ? { scope: skill.scope } : {}),
					...(typeof skill.enabled === "boolean"
						? { enabled: skill.enabled }
						: {}),
				},
			];
		});
	}

	async hostCapabilities(): Promise<
		Record<string, { label: string; available: boolean; reason?: string }>
	> {
		return {
			windowsComputerUse: cachedWindowsComputerUseCapability(),
			windowsVisualize:
				this.providerId === "codex"
					? cachedWindowsVisualizeCapability()
					: {
							label: "Windows Visualize",
							available: false,
							reason: "The Hlid Visualize bridge is available only to Codex",
						},
		};
	}

	// fallow-ignore-next-line unused-class-member -- Invoked through AgentProvider by provider capability discovery.
	async discoverCapabilities(context: { cwd: string }) {
		const launch = this.metadataLaunchConfig(context);
		const conn = acquireCodexAppServer(launch.appServer);
		await conn.ready;
		return discoverCodexProviderCapabilities({
			providerId: this.providerId,
			cwd: launch.rpcCwd,
			request: (method, params) => conn.requestOptional(method, params, 5_000),
		});
	}

	// fallow-ignore-next-line unused-class-member -- Invoked through the optional AgentProvider.listApps capability in providerAppRoutes.
	async listApps(
		context: ProviderAppCatalogRequest,
	): Promise<ProviderAppCatalogPage> {
		const launch = this.metadataLaunchConfig(context);
		const conn = acquireCodexAppServer(launch.appServer);
		await conn.ready;
		const limit = Math.max(1, Math.min(100, Math.trunc(context.limit ?? 50)));
		const appsParams: AppsListParams = {
			limit,
			...(context.cursor ? { cursor: context.cursor } : {}),
			...(context.refresh ? { forceRefetch: true } : {}),
		};
		const installedParams: AppsInstalledParams = {
			...(context.refresh ? { forceRefresh: true } : {}),
		};
		const appListTimeoutMs = context.refresh
			? CODEX_APP_INVENTORY_REFRESH_TIMEOUT_MS
			: CODEX_APP_LIST_INITIAL_TIMEOUT_MS;
		const settled = await Promise.allSettled([
			conn.requestOptional("app/list", appsParams, appListTimeoutMs),
			conn.requestOptional(
				"app/installed",
				installedParams,
				CODEX_APP_INVENTORY_REFRESH_TIMEOUT_MS,
			),
			readCodexMcpServerStatuses(
				(params, timeoutMs) =>
					conn.requestOptional("mcpServerStatus/list", params, timeoutMs),
				{
					detail: "full",
					timeoutMs: CODEX_APP_INVENTORY_REFRESH_TIMEOUT_MS,
				},
			),
		]);
		const unavailableMethods: string[] = [];
		const result = (index: number, method: string): unknown => {
			const item = settled[index];
			if (item?.status === "fulfilled") return item.value;
			unavailableMethods.push(method);
			return {};
		};
		const appsResponse = result(0, "app/list") as Partial<AppsListResponse>;
		const installedResponse = result(
			1,
			"app/installed",
		) as Partial<AppsInstalledResponse>;
		const mcpResponse = result(
			2,
			"mcpServerStatus/list",
		) as Partial<ListMcpServerStatusResponse>;
		const mapped = mapCodexAppCatalogPage({
			providerId: this.providerId,
			cwd: launch.rpcCwd,
			...(context.sessionId ? { sessionId: context.sessionId } : {}),
			appsResponse,
			installedResponse,
			mcpResponse,
			...(context.cursor ? { cursor: context.cursor } : {}),
			authAttempts: this.appAuthAttempts,
		});
		const hasUsableInventory =
			mapped.usableCount > 0 ||
			mapped.connectors.some((connector) => connector.usable);
		const hasAnyInventory =
			mapped.installedCount > 0 ||
			mapped.apps.length > 0 ||
			mapped.connectors.length > 0;
		const issues = unavailableMethods.map((method) => {
			if (method !== "app/list") {
				return `${method} is unavailable in the active provider runtime.`;
			}
			if (hasUsableInventory) {
				return "Available app discovery could not be checked in the active provider runtime. The provider still reports usable installed apps or connectors.";
			}
			if (hasAnyInventory) {
				return "Available app discovery could not be checked in the active provider runtime. Installed app or connector details were still reported.";
			}
			return "app/list is unavailable in the active provider runtime.";
		});
		const optionalDiscoveryOnly =
			hasUsableInventory &&
			unavailableMethods.length === 1 &&
			unavailableMethods[0] === "app/list";
		const page: ProviderAppCatalogPage = issues.length
			? {
					...mapped,
					status: "partial",
					issues,
					...(optionalDiscoveryOnly ? { issueSeverity: "info" as const } : {}),
				}
			: mapped;
		return settled.every((item) => item.status === "rejected")
			? { ...page, status: "unavailable" }
			: page;
	}

	// fallow-ignore-next-line unused-class-member -- Invoked through the optional AgentProvider.startAppAuthentication capability in providerAppRoutes.
	async startAppAuthentication(
		request: ProviderAppAuthenticationRequest,
	): Promise<ProviderAppAuthenticationStart> {
		const launch = this.metadataLaunchConfig({ cwd: request.cwd });
		const conn = acquireCodexAppServer(launch.appServer);
		await conn.ready;
		const key = `${request.target.kind}:${request.target.id}`;
		try {
			let authorizationUrl: unknown;
			if (request.target.kind === "app") {
				const params: AppsReadParams = {
					appIds: [request.target.id],
				};
				const response = (await conn.requestOptional(
					"app/read",
					params,
					10_000,
				)) as AppsReadResponse;
				authorizationUrl = response.apps.find(
					(app) => app.id === request.target.id,
				)?.installUrl;
			} else {
				const params: McpServerOauthLoginParams = {
					name: request.target.id,
				};
				const response = (await conn.requestOptional(
					"mcpServer/oauth/login",
					params,
					10_000,
				)) as McpServerOauthLoginResponse;
				authorizationUrl = response.authorizationUrl;
			}
			if (typeof authorizationUrl !== "string" || !authorizationUrl.trim()) {
				throw new Error("Provider did not return an authorization URL");
			}
			if (!openInBrowser(authorizationUrl)) {
				throw new Error("Hlid could not open the authorization URL");
			}
			this.appAuthAttempts.set(key, {
				state: "pending",
				startedAt: Date.now(),
			});
			return { opened: true };
		} catch {
			this.appAuthAttempts.set(key, {
				state: "failed",
				startedAt: Date.now(),
				error: "Provider authentication could not be started.",
			});
			throw new Error("Provider authentication could not be started.");
		}
	}

	async listModels(): Promise<ProviderModelInfo[]> {
		return fetchCodexModels({
			executable: this.metadataExecutable(),
			profile: this.providerProfile,
			enableRealtime: this.realtimeEnabled(),
		});
	}

	// fallow-ignore-next-line unused-class-member -- Invoked through AgentProvider.forkSession by dbRoutes.
	async forkSession(params: ForkSessionParams): Promise<ForkSessionResult> {
		if (params.cutoff && params.cutoff.kind !== "turn") {
			throw new Error("Codex exact forks require a native turn cutoff");
		}
		const cwd = params.cwd ?? process.cwd();
		const executable = resolveProviderExecutableForCwd(
			cwd,
			this.metadataExecutable(),
			"codex",
		);
		const launch = this.metadataLaunchConfig({
			cwd,
			executable,
		});
		const conn = acquireCodexAppServer(launch.appServer);
		await conn.ready;
		const forkParams: ThreadForkParams = {
			threadId: params.sessionId,
			...(params.cutoff ? { lastTurnId: params.cutoff.id } : {}),
			...(params.cwd ? { cwd: launch.rpcCwd } : {}),
			// Hlid hydrates its visible transcript from the source session, so avoid
			// returning the potentially large provider turn collection here.
			excludeTurns: true,
			// Preserve an active native goal without letting the new thread start
			// invisible work before Raven has attached to the fork.
			deferGoalContinuation: true,
		};
		const result = (await conn.request(
			"thread/fork",
			forkParams,
		)) as ThreadForkResponse;
		const threadId = asObj(result.thread).id;
		if (typeof threadId !== "string" || !threadId) {
			throw new Error("Codex did not return a forked thread id");
		}
		return { sessionId: threadId };
	}

	query(params: AgentQueryParams): AgentSession {
		return new CodexAgentSession(
			{ ...params, providerId: params.providerId ?? this.providerId },
			undefined,
			this.providerProfile,
		);
	}
}
