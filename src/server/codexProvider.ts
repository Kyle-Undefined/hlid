import { dirname } from "node:path";
import { resolveCodexExecutable } from "../lib/codexPath";
import { canonicalizeCodexUsage, estimateCodexCost } from "../lib/codexPricing";
import { toLogical } from "../lib/paths";
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
	type CodexAppServer,
	type ThreadHandler,
} from "./codexAppServer";
import type {
	CollabAgentState,
	CollabAgentStatus,
	CollabAgentTool,
	CommandExecutionRequestApprovalResponse,
	FileChangeRequestApprovalResponse,
	SandboxMode as GeneratedSandboxMode,
	GrantedPermissionProfile,
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
}): Promise<ProviderModelInfo[]> {
	const launch = codexLaunchConfig({ cwd: process.cwd() });
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
	private threadHandler: ThreadHandler | null = null;
	private approvedHtmlPlanItemId: string | null = null;
	private htmlPlanReady = false;
	private nativePlanText = "";
	private lastUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
	};
	private resolvedModel: string | null = null;

	private launch: CodexLaunchConfig | null = null;

	constructor(private params: AgentQueryParams) {}

	cancel(): void {
		this.canceled = true;
		this.events.close();
		// The app-server is shared — never kill the process. Interrupt any
		// running turn and detach this session's thread from event routing.
		if (this.conn && this.threadId) {
			if (this.activeTurnId) {
				void this.conn
					.request("turn/interrupt", {
						threadId: this.threadId,
						turnId: this.activeTurnId,
					})
					.catch(() => {});
			}
			for (const threadId of this.attachedThreadIds) {
				this.conn.detachThread(threadId);
			}
			this.attachedThreadIds.clear();
		}
		this.conn = null;
	}

	closeInput(): void {
		// One-shot callers (recap) use this as "no more sends coming". With a
		// shared app-server there is no per-session stdin to EOF — instead the
		// event stream is closed once the in-flight turn completes (see the
		// turn/completed handler), which ends the caller's for-await loop.
		this.endAfterTurn = true;
		if (this.activeTurnId === null) this.events.close();
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
						approvalPolicy: approvalPolicy(
							effectivePermissionMode(this.params),
						),
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

	async supportedCommands(): Promise<SlashCommand[]> {
		await this.ensureReady();
		try {
			const result = asObj(
				await this.request("skills/list", {
					cwds: [this.launch?.rpcCwd ?? this.params.cwd],
				}),
			);
			const skills = Array.isArray(result.skills) ? result.skills : [];
			return skills.flatMap((skill) => {
				const obj = asObj(skill);
				const name = String(obj.name ?? "");
				if (!name) return [];
				return [
					{
						name,
						description:
							typeof obj.description === "string" ? obj.description : "",
						argumentHint: "",
					},
				];
			});
		} catch {
			return [];
		}
	}

	async mcpServerStatus(): Promise<McpServerStatus[]> {
		await this.ensureReady();
		try {
			const result = asObj(await this.request("mcpServerStatus/list", {}));
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
		const conn = acquireCodexAppServer(launch.executable);
		this.conn = conn;
		if (this.params.signal) {
			if (this.params.signal.aborted) this.cancel();
			else
				this.params.signal.addEventListener("abort", () => this.cancel(), {
					once: true,
				});
		}
		await conn.ready;

		const threadParams: ThreadStartParams = {
			cwd: launch.rpcCwd,
			ephemeral: this.params.persistSession === false,
			...(this.params.model ? { model: this.params.model } : {}),
			...(this.params.permissionMode
				? {
						approvalPolicy: approvalPolicy(
							effectivePermissionMode(this.params),
						),
						sandbox: sandboxMode(this.params.permissionMode),
					}
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
				this.events.push({
					type: "local_command_output",
					content: `Codex app-server error: ${err.message}`,
				});
				this.events.close();
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

	private async handleServerRequest(
		method: string,
		rawParams: unknown,
	): Promise<unknown> {
		const params = asObj(rawParams);
		if (method === "item/tool/requestUserInput") {
			return this.handleRequestUserInput(params);
		}
		if (!this.params.policyEnforced && autoApprovesPermissions(this.params)) {
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
		const kind = item.kind as SubAgentActivityKind | undefined;
		this.attachThread(threadId);
		this.updateSubagentFromChild(threadId, {
			...(typeof item.agentPath === "string" ? { label: item.agentPath } : {}),
			status: kind === "interrupted" ? "interrupted" : "running",
			currentStep:
				kind === "interacted"
					? "Communicating with the parent agent"
					: kind === "interrupted"
						? "Subagent interrupted"
						: "Subagent started",
			...(kind === "interrupted" ? { endedAtMs: Date.now() } : {}),
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
		this.resetTurnTracking();
		this.events.push({
			type: "done",
			estimatedCost: estimateCodexCost(
				this.resolvedModel ?? this.params.model,
				this.lastUsage,
			),
			turns: 1,
			durationMs: 0,
			stopReason: typeof turn.status === "string" ? turn.status : undefined,
			usage: { ...this.lastUsage },
		});
		if (!this.endAfterTurn) return;
		if (this.conn && this.threadId) this.conn.detachThread(this.threadId);
		this.events.close();
	}

	private handleChildTurnCompleted(obj: Record<string, unknown>): void {
		const threadId = String(obj.threadId ?? "");
		if (!threadId || threadId === this.threadId) return;
		const turn = asObj(obj.turn);
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
				if (!childNotification) this.handleTokenUsageUpdated(params);
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

	async listModels(): Promise<ProviderModelInfo[]> {
		return fetchCodexModels();
	}

	query(params: AgentQueryParams): AgentSession {
		return new CodexAgentSession(params);
	}
}
