import { dirname } from "node:path";
import { resolveCodexExecutable } from "../lib/codexPath";
import { toLogical } from "../lib/paths";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	McpServerStatus,
	ProviderEffortInfo,
	ProviderModelInfo,
	SendOptions,
	SlashCommand,
} from "./agentProvider";
import { acquireCodexAppServer, type CodexAppServer } from "./codexAppServer";
import type {
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

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			(async () => {
				await conn.ready;
				const modelListParams: ModelListParams = {
					includeHidden: opts?.includeHidden ?? false,
				};
				return conn.request("model/list", modelListParams);
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error("Codex model/list timed out"));
				}, opts?.timeoutMs ?? 10_000);
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
	return {
		type: "usage",
		inputTokens: input,
		outputTokens: output,
		contextWindow,
		cacheReadTokens:
			Number(usage.cacheReadTokens ?? usage.cache_read_input_tokens) ||
			Number(usage.cachedInputTokens) ||
			undefined,
		cacheCreationTokens:
			Number(usage.cacheCreationTokens ?? usage.cache_creation_input_tokens) ||
			undefined,
		model: typeof obj.model === "string" ? obj.model : undefined,
	};
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
	private approvedHtmlPlanItemId: string | null = null;
	private htmlPlanReady = false;
	private nativePlanText = "";
	private lastUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
	};

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
			this.conn.detachThread(this.threadId);
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
		if (this.canceled) return;
		conn.attachThread(thread.id, {
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
		});
		this.events.push({ type: "session_start", sessionId: thread.id });

		// Seed usage windows immediately; rolling account/rateLimits/updated
		// notifications keep them fresh during turns.
		void conn
			.request("account/rateLimits/read", undefined)
			.then((res) => this.emitRateLimits(asObj(res).rateLimits))
			.catch(() => {});
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
		for (const [win, fallbackId] of [
			[snapshot.primary, "five_hour"],
			[snapshot.secondary, "weekly"],
		] as const) {
			const w = asObj(win);
			if (typeof w.usedPercent !== "number") continue;
			const mins =
				typeof w.windowDurationMins === "number" ? w.windowDurationMins : null;
			const windowId =
				mins == null ? fallbackId : mins <= 24 * 60 ? "five_hour" : "weekly";
			const rawReset = typeof w.resetsAt === "number" ? w.resetsAt : null;
			// Observed epoch seconds; normalize defensively if it ever turns ms.
			const resetsAt =
				rawReset != null && rawReset > 1e12
					? Math.round(rawReset / 1000)
					: rawReset;
			this.events.push({
				type: "rate_limit",
				status: "ok",
				rateLimitType: windowId,
				utilization: w.usedPercent / 100,
				resetsAt,
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
		this.events.push({
			type: "tool_start",
			toolId: itemId,
			name: toolName,
			input,
		});
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
		this.events.push({
			type: "tool_result",
			toolId: String(item.id ?? type),
			content: JSON.stringify(item),
		});
	}

	private recordUsage(usage: AgentEvent | null): void {
		if (usage?.type !== "usage") return;
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
			cost: 0,
			turns: 1,
			durationMs: 0,
			stopReason: typeof turn.status === "string" ? turn.status : undefined,
			usage: { ...this.lastUsage },
		});
		if (!this.endAfterTurn) return;
		if (this.conn && this.threadId) this.conn.detachThread(this.threadId);
		this.events.close();
	}

	private handleNotification(method: string, params: unknown): void {
		const obj = asObj(params);
		switch (method) {
			case "thread/started":
				this.handleThreadStarted(obj);
				break;
			case "turn/started":
				this.handleTurnStarted(obj);
				break;
			case "item/agentMessage/delta":
				this.handleAgentMessageDelta(obj);
				break;
			case "item/commandExecution/outputDelta":
				this.handleCommandOutputDelta(obj);
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
				this.handleTokenUsageUpdated(params);
				break;
			case "mcpServer/startupStatus/updated":
				this.handleMcpStartupStatus(obj);
				break;
			case "turn/completed":
				void this.handleTurnCompleted(obj, params);
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
