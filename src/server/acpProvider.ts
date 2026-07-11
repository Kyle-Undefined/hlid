import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
	type Client,
	ClientSideConnection,
	type ContentBlock,
	type InitializeResponse,
	ndJsonStream,
	PROTOCOL_VERSION,
	type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	McpServerStatus,
	SlashCommand,
} from "./agentProvider";

export type AcpProviderOptions = {
	id: string;
	label: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
};

type QueueResult<T> = IteratorResult<T>;

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

function eventFromUpdate(update: SessionUpdate): AgentEvent | null {
	switch (update.sessionUpdate) {
		case "agent_message_chunk": {
			const text = textFromContent(update.content);
			return text == null ? null : { type: "text_delta", text };
		}
		case "agent_thought_chunk": {
			const text = textFromContent(update.content);
			return text == null ? null : { type: "summary", text };
		}
		case "tool_call":
			return {
				type: "tool_start",
				toolId: update.toolCallId,
				name: update.title,
				input: update.rawInput ?? null,
			};
		case "tool_call_update":
			if (update.status !== "completed" && update.status !== "failed")
				return null;
			return {
				type: "tool_result",
				toolId: update.toolCallId,
				content:
					typeof update.rawOutput === "string"
						? update.rawOutput
						: JSON.stringify(update.rawOutput ?? update.content ?? ""),
				isError: update.status === "failed",
			};
		case "plan":
			return { type: "summary", text: JSON.stringify(update.entries) };
		case "plan_update":
			return { type: "summary", text: JSON.stringify(update.plan) };
		case "usage_update":
			return null;
		default:
			return null;
	}
}

class AcpSession implements AgentSession {
	private readonly events = new AsyncEventQueue<AgentEvent>();
	private process: ChildProcessWithoutNullStreams | null = null;
	private connection: ClientSideConnection | null = null;
	private sessionId: string | null = null;
	private initPromise: Promise<void> | null = null;
	private cancelled = false;
	private turns = 0;
	private commands: SlashCommand[] = [];
	private closeAfterTurn = false;
	private canDeleteSession = false;
	private canCloseSession = false;

	constructor(
		private readonly options: AcpProviderOptions,
		private readonly params: AgentQueryParams,
	) {
		params.signal?.addEventListener("abort", () => this.cancel(), {
			once: true,
		});
	}

	private initialize(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = this.doInitialize();
		return this.initPromise;
	}

	private async doInitialize(): Promise<void> {
		if (this.cancelled) return;
		const child = spawn(this.options.command, this.options.args ?? [], {
			cwd: this.params.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.process = child;
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-8_000);
		});
		child.once("error", (error) => this.events.end(error));
		child.once("exit", (code) => {
			if (!this.cancelled && code !== 0) {
				this.events.end(
					new Error(stderr.trim() || `ACP agent exited with code ${code}`),
				);
			}
		});

		const client: Client = {
			requestPermission: async ({ toolCall, options }) => {
				const decision = await this.params.canUseTool(
					toolCall.title ?? "ACP tool",
					toolCall.rawInput ?? null,
					{
						toolUseID: toolCall.toolCallId,
						signal: this.params.signal ?? new AbortController().signal,
						title: toolCall.title ?? undefined,
					},
				);
				const allowed = decision.behavior === "allow";
				const option = options.find((item) =>
					allowed
						? item.kind.startsWith("allow")
						: item.kind.startsWith("reject"),
				);
				return option
					? { outcome: { outcome: "selected", optionId: option.optionId } }
					: { outcome: { outcome: "cancelled" } };
			},
			sessionUpdate: ({ update }) => {
				if (update.sessionUpdate === "available_commands_update") {
					this.commands = update.availableCommands.map((command) => ({
						name: command.name,
						description: command.description ?? "",
						argumentHint: command.input?.hint ?? "",
					}));
				}
				const event = eventFromUpdate(update);
				if (event) this.events.push(event);
			},
		};
		const stream = ndJsonStream(
			Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
		);
		const connection = new ClientSideConnection(() => client, stream);
		this.connection = connection;
		const initialized = await connection.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
			clientInfo: { name: "Hlid", version: "1" },
		});
		this.canDeleteSession = Boolean(
			initialized.agentCapabilities?.sessionCapabilities?.delete,
		);
		this.canCloseSession = Boolean(
			initialized.agentCapabilities?.sessionCapabilities?.close,
		);
		if (this.cancelled) return;
		if (this.params.sessionId && initialized.agentCapabilities?.loadSession) {
			await connection.loadSession({
				sessionId: this.params.sessionId,
				cwd: this.params.cwd,
				additionalDirectories: this.params.additionalDirectories,
				mcpServers: [],
			});
			this.sessionId = this.params.sessionId;
		} else {
			const created = await connection.newSession({
				cwd: this.params.cwd,
				additionalDirectories: this.params.additionalDirectories,
				mcpServers: [],
			});
			this.sessionId = created.sessionId;
		}
		this.events.push({ type: "session_start", sessionId: this.sessionId });
	}

	async send(message: string): Promise<void> {
		await this.initialize();
		if (this.cancelled || !this.connection || !this.sessionId) return;
		void this.runPrompt(message).catch((error) => this.events.end(error));
	}

	private async runPrompt(message: string): Promise<void> {
		if (!this.connection || !this.sessionId) return;
		const started = Date.now();
		const response = await this.connection.prompt({
			sessionId: this.sessionId,
			prompt: [{ type: "text", text: message }],
		});
		this.turns += 1;
		if (response.usage) {
			this.events.push({
				type: "usage",
				inputTokens: response.usage.inputTokens,
				outputTokens: response.usage.outputTokens,
				cacheReadTokens: response.usage.cachedReadTokens ?? undefined,
				cacheCreationTokens: response.usage.cachedWriteTokens ?? undefined,
			});
		}
		this.events.push({
			type: "done",
			turns: this.turns,
			durationMs: Date.now() - started,
			stopReason: response.stopReason,
		});
		if (this.closeAfterTurn) await this.finishOneShot();
	}

	cancel(): void {
		if (this.cancelled) return;
		this.cancelled = true;
		if (this.connection && this.sessionId) {
			void this.connection.cancel({ sessionId: this.sessionId });
		}
		this.process?.kill();
		this.events.end();
	}

	closeInput(): void {
		this.closeAfterTurn = true;
	}

	private async finishOneShot(): Promise<void> {
		if (this.connection && this.sessionId) {
			if (this.params.persistSession === false && this.canDeleteSession) {
				await this.connection
					.deleteSession({ sessionId: this.sessionId })
					.catch(() => {});
			} else if (this.canCloseSession) {
				await this.connection
					.closeSession({ sessionId: this.sessionId })
					.catch(() => {});
			}
		}
		this.process?.kill();
		this.events.end();
	}

	async mcpServerStatus(): Promise<McpServerStatus[]> {
		return [];
	}

	async supportedCommands(): Promise<SlashCommand[]> {
		return this.commands;
	}

	[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
		return { next: () => this.events.next() };
	}
}

export class AcpProvider implements AgentProvider {
	readonly providerId: string;
	readonly label: string;
	readonly permissionModes = [
		{ value: "default", label: "Ask" },
		{ value: "bypassPermissions", label: "Allow all" },
	] as const;

	constructor(readonly options: AcpProviderOptions) {
		this.providerId = options.id;
		this.label = options.label;
	}

	async check(): Promise<{ available: boolean; reason?: string }> {
		const resolved = Bun.which(this.options.command);
		return resolved
			? { available: true }
			: {
					available: false,
					reason: `${this.options.command} is not installed`,
				};
	}

	query(params: AgentQueryParams): AgentSession {
		return new AcpSession(this.options, params);
	}
}

export async function inspectAcpAgent(
	options: AcpProviderOptions,
	methodId?: string,
): Promise<InitializeResponse> {
	const child = spawn(options.command, options.args ?? [], {
		env: { ...process.env, ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
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
	try {
		const initialized = await connection.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
			clientInfo: { name: "Hlid", version: "1" },
		});
		if (methodId) await connection.authenticate({ methodId });
		return initialized;
	} finally {
		child.kill();
	}
}
