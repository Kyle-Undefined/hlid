import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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
import type {
	CommandExecutionRequestApprovalResponse,
	FileChangeRequestApprovalResponse,
	SandboxMode as GeneratedSandboxMode,
	GrantedPermissionProfile,
	Model,
	ModelListParams,
	ModelListResponse,
	PermissionsRequestApprovalResponse,
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

type JsonRpcMessage = {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string };
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
): CodexSandboxPolicy {
	const sandbox = sandboxMode(mode);
	if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
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
	args: string[];
	spawnCwd?: string;
	rpcCwd: string;
};

export function codexLaunchConfig(params: {
	cwd: string;
	executable?: string;
}): CodexLaunchConfig {
	const rpcCwd = toLogical(params.cwd);
	// rpcCwd differs from params.cwd exactly when params.cwd is a WSL UNC path
	// (toLogical only rewrites those). In that case the executable is a
	// generated .cmd wrapper that shells out via `wsl.exe --cd`, and cmd.exe
	// refuses a UNC cwd, printing noise to stderr. The wrapper already sets
	// the real Linux cwd itself, so we omit spawnCwd there.
	const isWslUncCwd = rpcCwd !== params.cwd;

	const executable = params.executable ?? resolveCodexExecutable();
	if (!executable) throw new Error("Codex CLI not found");
	return {
		executable,
		args: ["app-server", "--listen", "stdio://"],
		...(isWslUncCwd ? {} : { spawnCwd: params.cwd }),
		rpcCwd,
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
 * One-off `model/list` RPC over a throwaway codex-cli `app-server` process.
 * Spawns the executable, performs the initialize/initialized handshake, sends
 * `model/list`, then kills the process. Used by CodexProvider.listModels() to
 * live-fetch the model catalog; falls back to the static `models` array on
 * failure (handled by callers).
 */
export async function fetchCodexModels(opts?: {
	includeHidden?: boolean;
	timeoutMs?: number;
}): Promise<ProviderModelInfo[]> {
	const launch = codexLaunchConfig({ cwd: process.cwd() });
	const proc = spawn(launch.executable, launch.args, {
		...(launch.spawnCwd ? { cwd: launch.spawnCwd } : {}),
		stdio: "pipe",
	});

	let lineBuffer = "";
	let nextId = 1;
	const pending = new Map<
		number | string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();

	function write(message: JsonRpcMessage): void {
		proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	function request(method: string, params: unknown): Promise<unknown> {
		const id = nextId++;
		write({ id, method, params });
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
		});
	}

	function notify(method: string, params: unknown): void {
		write({ method, params });
	}

	function handleLine(line: string): void {
		if (!line) return;
		let msg: JsonRpcMessage;
		try {
			msg = JSON.parse(line) as JsonRpcMessage;
		} catch {
			return;
		}
		if (msg.id === undefined || msg.method) return;
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		if (msg.error) p.reject(new Error(msg.error.message ?? "Codex error"));
		else p.resolve(msg.result);
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await new Promise<unknown>((resolve, reject) => {
			proc.on("error", (err) => reject(err));
			proc.on("exit", (code) => {
				reject(new Error(`Codex app-server exited (code ${code ?? "null"})`));
			});
			proc.stdout.on("data", (chunk: Buffer) => {
				lineBuffer += chunk.toString("utf8");
				while (true) {
					const idx = lineBuffer.indexOf("\n");
					if (idx === -1) break;
					const line = lineBuffer.slice(0, idx).trim();
					lineBuffer = lineBuffer.slice(idx + 1);
					handleLine(line);
				}
			});

			timer = setTimeout(() => {
				reject(new Error("Codex model/list timed out"));
			}, opts?.timeoutMs ?? 10_000);

			(async () => {
				await request("initialize", {
					clientInfo: { name: "hlid", title: "Hlid", version: "0.0.0" },
					capabilities: { experimentalApi: true },
				});
				notify("initialized", {});
				const modelListParams: ModelListParams = {
					includeHidden: opts?.includeHidden ?? false,
				};
				const modelList = await request("model/list", modelListParams);
				resolve(modelList);
			})().catch(reject);
		});

		const models = mapCodexModels(result);
		return opts?.includeHidden
			? models
			: models.filter((m) => m.hidden !== true);
	} finally {
		if (timer) clearTimeout(timer);
		proc.kill();
	}
}

function maybeUsage(value: unknown): AgentEvent | null {
	const obj = asObj(value);
	const tokenUsage = asObj(obj.usage ?? obj.tokenUsage ?? obj.tokens);
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
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<
		number | string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private events = new AsyncQueue<AgentEvent>();
	private ready: Promise<void> | null = null;
	private threadId: string | null = null;
	private activeTurnId: string | null = null;
	private canceled = false;
	private lineBuffer = "";
	private streamedAgentMessageIds = new Set<string>();
	private emittedReasoningIds = new Set<string>();
	private sawUnidentifiedAgentMessageDelta = false;
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
		for (const pending of this.pending.values()) {
			pending.reject(new Error("Codex session cancelled"));
		}
		this.pending.clear();
		this.proc?.kill();
		this.proc = null;
	}

	closeInput(): void {
		this.proc?.stdin.end();
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
		const params: TurnStartParams = {
			threadId: this.threadId,
			input: [{ type: "text", text: message, text_elements: [] }],
			...(cwd ? { cwd } : {}),
			...(this.params.model ? { model: this.params.model } : {}),
			...(this.params.effort ? { effort: this.params.effort } : {}),
			...(this.params.permissionMode
				? {
						approvalPolicy: approvalPolicy(this.params.permissionMode),
						sandboxPolicy: codexSandboxPolicy(
							this.params.permissionMode,
							this.params.additionalDirectories ?? [],
						),
					}
				: {}),
		};
		const result = asObj(await this.request("turn/start", params));
		const turn = asObj(result.turn);
		if (typeof turn.id === "string") this.activeTurnId = turn.id;
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

		this.proc = spawn(launch.executable, launch.args, {
			...(launch.spawnCwd ? { cwd: launch.spawnCwd } : {}),
			stdio: "pipe",
		});
		this.proc.on("error", (err) => {
			this.events.push({
				type: "local_command_output",
				content: `Codex app-server error: ${err.message}`,
			});
			this.failProcess(err);
		});
		this.proc.stdout.on("data", (chunk) => this.onStdout(chunk));
		this.proc.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			if (text.trim())
				this.events.push({ type: "local_command_output", content: text });
		});
		this.proc.on("exit", () => {
			if (!this.canceled) {
				this.failProcess(new Error("Codex app-server exited"));
			}
		});
		if (this.params.signal) {
			if (this.params.signal.aborted) this.cancel();
			else
				this.params.signal.addEventListener("abort", () => this.cancel(), {
					once: true,
				});
		}

		await this.request("initialize", {
			clientInfo: {
				name: "hlid",
				title: "Hlid",
				version: "0.0.0",
			},
			capabilities: { experimentalApi: true },
		});
		this.notify("initialized", {});

		const threadParams: ThreadStartParams = {
			cwd: launch.rpcCwd,
			ephemeral: this.params.persistSession === false,
			...(this.params.model ? { model: this.params.model } : {}),
			...(this.params.permissionMode
				? {
						approvalPolicy: approvalPolicy(this.params.permissionMode),
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
		this.events.push({ type: "session_start", sessionId: thread.id });
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		this.write({ id, method, params });
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
	}

	private notify(method: string, params: unknown): void {
		this.write({ method, params });
	}

	private write(message: JsonRpcMessage): void {
		if (!this.proc) throw new Error("Codex app-server is not running");
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private failProcess(err: Error): void {
		this.events.close();
		for (const pending of this.pending.values()) {
			pending.reject(err);
		}
		this.pending.clear();
		this.proc = null;
	}

	private onStdout(chunk: Buffer): void {
		this.lineBuffer += chunk.toString("utf8");
		while (true) {
			const idx = this.lineBuffer.indexOf("\n");
			if (idx === -1) break;
			const line = this.lineBuffer.slice(0, idx).trim();
			this.lineBuffer = this.lineBuffer.slice(idx + 1);
			if (!line) continue;
			try {
				this.handleMessage(JSON.parse(line) as JsonRpcMessage);
			} catch {
				this.events.push({ type: "local_command_output", content: line });
			}
		}
	}

	private handleMessage(msg: JsonRpcMessage): void {
		if (msg.id !== undefined && !msg.method) {
			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			if (msg.error)
				pending.reject(new Error(msg.error.message ?? "Codex error"));
			else pending.resolve(msg.result);
			return;
		}
		if (msg.id !== undefined && msg.method) {
			void this.handleServerRequest(msg);
			return;
		}
		if (msg.method) this.handleNotification(msg.method, msg.params);
	}

	private async handleServerRequest(msg: JsonRpcMessage): Promise<void> {
		if (msg.id === undefined || !msg.method) return;
		const params = asObj(msg.params);
		if (typeof this.params.canUseTool !== "function") {
			this.write({
				id: msg.id,
				result: this.deniedServerRequestResult(msg.method),
			});
			return;
		}
		try {
			const itemId = String(params.itemId ?? params.approvalId ?? msg.id);
			const decision = await this.params.canUseTool(msg.method, params, {
				toolUseID: itemId,
				signal: this.params.signal ?? new AbortController().signal,
				title: "Codex wants approval",
				displayName: msg.method,
				description:
					typeof params.reason === "string" ? params.reason : undefined,
			});
			const allowed = decision.behavior === "allow";
			const result = allowed
				? this.allowedServerRequestResult(msg.method, params)
				: this.deniedServerRequestResult(msg.method);
			this.write({ id: msg.id, result });
		} catch (err) {
			this.write({
				id: msg.id,
				error: { message: err instanceof Error ? err.message : String(err) },
			});
		}
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

	private handleNotification(method: string, params: unknown): void {
		const obj = asObj(params);
		if (method === "thread/started") {
			const id = asObj(obj.thread).id;
			if (typeof id === "string") {
				this.threadId = id;
				this.events.push({ type: "session_start", sessionId: id });
			}
			return;
		}
		if (method === "turn/started") {
			const id = asObj(obj.turn).id;
			if (typeof id === "string") this.activeTurnId = id;
			this.streamedAgentMessageIds.clear();
			this.emittedReasoningIds.clear();
			this.sawUnidentifiedAgentMessageDelta = false;
			return;
		}
		if (method === "item/agentMessage/delta") {
			const text = textFromUnknown(obj.delta ?? obj.text ?? obj.content);
			if (text) {
				const itemId = String(obj.itemId ?? obj.id ?? "");
				if (itemId) this.streamedAgentMessageIds.add(itemId);
				else this.sawUnidentifiedAgentMessageDelta = true;
				this.events.push({ type: "text_delta", text });
			}
			return;
		}
		if (method === "item/commandExecution/outputDelta") {
			const encoded = obj.deltaBase64;
			if (typeof encoded === "string") {
				this.events.push({
					type: "local_command_output",
					content: Buffer.from(encoded, "base64").toString("utf8"),
				});
			}
			return;
		}
		if (method === "item/started") {
			const item = asObj(obj.item);
			const type = String(item.type ?? "tool");
			if (type === "agentMessage" || type === "userMessage") return;
			if (type === "reasoning") {
				const text = codexReasoningText(item);
				const id = String(
					item.id ?? `reasoning-${this.activeTurnId ?? "turn"}`,
				);
				if (text && !this.emittedReasoningIds.has(id)) {
					this.emittedReasoningIds.add(id);
					this.events.push({
						type: "tool_start",
						toolId: id,
						name: "Reasoning",
						input: {},
					});
					this.events.push({
						type: "tool_result",
						toolId: id,
						content: text,
					});
				}
				return;
			}
			this.events.push({
				type: "tool_start",
				toolId: String(item.id ?? type),
				name: type,
				input: item,
			});
			return;
		}
		if (method === "item/completed") {
			const item = asObj(obj.item);
			const type = String(item.type ?? "");
			if (type === "agentMessage") {
				const itemId = String(item.id ?? "");
				const alreadyStreamed = itemId
					? this.streamedAgentMessageIds.has(itemId)
					: this.sawUnidentifiedAgentMessageDelta;
				if (!alreadyStreamed) {
					const text = textFromUnknown(item.text ?? item.content);
					if (text) this.events.push({ type: "text_delta", text });
				}
				return;
			}
			if (type === "userMessage" || type === "reasoning") {
				if (type === "reasoning") {
					const text = codexReasoningText(item);
					const id = String(
						item.id ?? `reasoning-${this.activeTurnId ?? "turn"}`,
					);
					if (text && !this.emittedReasoningIds.has(id)) {
						this.emittedReasoningIds.add(id);
						this.events.push({
							type: "tool_start",
							toolId: id,
							name: "Reasoning",
							input: {},
						});
						this.events.push({
							type: "tool_result",
							toolId: id,
							content: text,
						});
					}
				}
				return;
			}
			if (type) {
				this.events.push({
					type: "tool_result",
					toolId: String(item.id ?? type),
					content: JSON.stringify(item),
				});
			}
			return;
		}
		if (method === "thread/tokenUsage/updated") {
			const usage = maybeUsage(params);
			if (usage?.type === "usage") {
				this.lastUsage = {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens ?? 0,
					cacheCreationTokens: usage.cacheCreationTokens ?? 0,
				};
				this.events.push(usage);
			}
			return;
		}
		if (method === "mcpServer/startupStatus/updated") {
			const servers = Array.isArray(obj.servers) ? obj.servers : [];
			this.events.push({
				type: "mcp_status",
				servers: servers.flatMap((server) => {
					const s = asObj(server);
					const name = String(s.name ?? "");
					if (!name) return [];
					return [{ name, status: "pending" as const }];
				}),
			});
			return;
		}
		if (method === "turn/completed") {
			const turn = asObj(obj.turn);
			const usage = maybeUsage(turn) ?? maybeUsage(params);
			if (usage?.type === "usage") {
				this.lastUsage = {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens ?? 0,
					cacheCreationTokens: usage.cacheCreationTokens ?? 0,
				};
			}
			this.activeTurnId = null;
			this.streamedAgentMessageIds.clear();
			this.emittedReasoningIds.clear();
			this.sawUnidentifiedAgentMessageDelta = false;
			this.events.push({
				type: "done",
				cost: 0,
				turns: 1,
				durationMs: 0,
				stopReason: typeof turn.status === "string" ? turn.status : undefined,
				usage: {
					inputTokens: this.lastUsage.inputTokens,
					outputTokens: this.lastUsage.outputTokens,
					cacheReadTokens: this.lastUsage.cacheReadTokens,
					cacheCreationTokens: this.lastUsage.cacheCreationTokens,
				},
			});
		}
	}
}

export class CodexProvider implements AgentProvider {
	readonly providerId = "codex";
	readonly label = "Codex";

	/** Offline fallback for listModels() — used when the live `model/list` RPC fails. */
	readonly models = [
		{ value: "gpt-5.5", label: "GPT-5.5" },
		{ value: "gpt-5.4", label: "GPT-5.4" },
		{ value: "gpt-5.3-codex", label: "GPT-5.3 Codex (legacy)" },
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
