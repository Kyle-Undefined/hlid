import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolveCodexExecutable } from "../lib/codexPath";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	McpServerStatus,
	SendOptions,
	SlashCommand,
} from "./agentProvider";

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
		const params: Record<string, unknown> = {
			threadId: this.threadId,
			input: [{ type: "text", text: message, text_elements: [] }],
			...(this.params.cwd ? { cwd: this.params.cwd } : {}),
			...(this.params.model ? { model: this.params.model } : {}),
			...(this.params.effort ? { effort: this.params.effort } : {}),
			...(this.params.permissionMode
				? { approvalPolicy: approvalPolicy(this.params.permissionMode) }
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
					cwds: [this.params.cwd],
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
		const executable = this.params.executable ?? resolveCodexExecutable();
		if (!executable) throw new Error("Codex CLI not found");

		this.proc = spawn(executable, ["app-server", "--listen", "stdio://"], {
			cwd: this.params.cwd,
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

		const threadParams: Record<string, unknown> = {
			cwd: this.params.cwd,
			ephemeral: this.params.persistSession === false,
			...(this.params.model ? { model: this.params.model } : {}),
			...(this.params.permissionMode
				? { approvalPolicy: approvalPolicy(this.params.permissionMode) }
				: {}),
		};
		const result = asObj(
			this.params.sessionId
				? await this.request("thread/resume", {
						threadId: this.params.sessionId,
						...threadParams,
					})
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
	): unknown {
		if (method === "item/permissions/requestApproval") {
			return { scope: "session", permissions: params.permissions ?? {} };
		}
		return { decision: "accept" };
	}

	private deniedServerRequestResult(method: string): unknown {
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

	readonly models = [
		{ value: "gpt-5.5", label: "GPT-5.5" },
		{ value: "gpt-5.4", label: "GPT-5.4" },
		{ value: "gpt-5.3-codex", label: "GPT-5.3 Codex (legacy)" },
	] as const;

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

	query(params: AgentQueryParams): AgentSession {
		return new CodexAgentSession(params);
	}
}
