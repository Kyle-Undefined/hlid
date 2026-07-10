/**
 * Shared codex-cli `app-server` connections.
 *
 * Previously every CodexAgentSession (and every model/list fetch) spawned its
 * own `codex app-server` child process — on Windows that popped a visible
 * console window per chat, per home/raven page visit, and per catalog refresh.
 *
 * The app-server protocol is explicitly multi-thread: every notification and
 * server-initiated approval request carries a `threadId`, and thread/start +
 * turn/start both accept a per-thread `cwd`. So hlid keeps ONE app-server
 * process per executable (native codex gets a single global instance; each
 * WSL agent's generated .cmd wrapper is its own executable and therefore its
 * own instance) and multiplexes all sessions over it as threads.
 *
 * Lifecycle: lazily spawned on first acquire, kept alive for the life of the
 * hlid process, respawned on the next acquire if it died. closeAll() is wired
 * into the server's SIGINT/SIGTERM handlers.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

type JsonRpcMessage = {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string };
};

/** Per-thread callbacks a session registers to receive its routed traffic. */
export type ThreadHandler = {
	onNotification(method: string, params: unknown): void;
	/**
	 * Server-initiated request (approval) scoped to this thread. The returned
	 * value is written back as the JSON-RPC result; a throw becomes an error
	 * response.
	 */
	onRequest(method: string, params: unknown): Promise<unknown>;
	/** The shared app-server process exited or errored. */
	onExit(err: Error): void;
};

function asObj(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

export class CodexAppServer {
	private proc: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private pending = new Map<
		number | string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private threads = new Map<string, ThreadHandler>();
	private lineBuffer = "";
	private dead = false;
	/** Resolves after the initialize/initialized handshake completes. */
	readonly ready: Promise<void>;

	constructor(readonly executable: string) {
		// No cwd: the wrapper .cmd sets its own WSL cwd via `wsl --cd`, and for
		// native codex every thread passes an explicit cwd at thread/start and
		// turn/start, so the process cwd is irrelevant. windowsHide passes
		// CREATE_NO_WINDOW so the .cmd/console child never shows a window.
		this.proc = spawn(executable, ["app-server", "--listen", "stdio://"], {
			stdio: "pipe",
			windowsHide: true,
		});
		this.proc.on("error", (err) => this.fail(err));
		this.proc.on("exit", (code) => {
			this.fail(new Error(`Codex app-server exited (code ${code ?? "null"})`));
		});
		this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
		this.proc.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").trim();
			if (text) console.warn("[codex app-server]", text);
		});

		this.ready = (async () => {
			await this.request("initialize", {
				clientInfo: { name: "hlid", title: "Hlid", version: "0.0.0" },
				capabilities: { experimentalApi: true },
			});
			this.notify("initialized", {});
		})();
		// Callers that never await .ready (or that race a fail()) must not
		// trigger an unhandled-rejection crash.
		this.ready.catch(() => {});
	}

	get alive(): boolean {
		return !this.dead;
	}

	/** Number of sessions currently attached as threads. */
	get threadCount(): number {
		return this.threads.size;
	}

	request(method: string, params: unknown): Promise<unknown> {
		if (this.dead)
			return Promise.reject(new Error("Codex app-server is not running"));
		const id = this.nextId++;
		this.write({ id, method, params });
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
	}

	notify(method: string, params: unknown): void {
		if (this.dead) return;
		this.write({ method, params });
	}

	attachThread(threadId: string, handler: ThreadHandler): void {
		this.threads.set(threadId, handler);
	}

	detachThread(threadId: string): void {
		this.threads.delete(threadId);
	}

	kill(): void {
		this.fail(new Error("Codex app-server closed"));
		this.proc.kill();
	}

	private fail(err: Error): void {
		if (this.dead) return;
		this.dead = true;
		for (const pending of this.pending.values()) pending.reject(err);
		this.pending.clear();
		const handlers = [...this.threads.values()];
		this.threads.clear();
		for (const handler of handlers) handler.onExit(err);
	}

	private write(message: JsonRpcMessage): void {
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private onStdout(chunk: Buffer): void {
		this.lineBuffer += chunk.toString("utf8");
		while (true) {
			const idx = this.lineBuffer.indexOf("\n");
			if (idx === -1) break;
			const line = this.lineBuffer.slice(0, idx).trim();
			this.lineBuffer = this.lineBuffer.slice(idx + 1);
			if (!line) continue;
			let msg: JsonRpcMessage;
			try {
				msg = JSON.parse(line) as JsonRpcMessage;
			} catch {
				console.warn("[codex app-server] non-JSON output:", line);
				continue;
			}
			this.handleMessage(msg);
		}
	}

	/** threadId carried by notifications/requests; thread/started nests it. */
	private threadIdOf(params: unknown): string | undefined {
		const obj = asObj(params);
		if (typeof obj.threadId === "string") return obj.threadId;
		const nested = asObj(obj.thread).id;
		return typeof nested === "string" ? nested : undefined;
	}

	private handleMessage(msg: JsonRpcMessage): void {
		// Response to one of our requests.
		if (msg.id !== undefined && !msg.method) {
			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			if (msg.error)
				pending.reject(new Error(msg.error.message ?? "Codex error"));
			else pending.resolve(msg.result);
			return;
		}
		// Server-initiated request (approvals) — route to the owning thread.
		if (msg.id !== undefined && msg.method) {
			const id = msg.id;
			const handler = this.threads.get(this.threadIdOf(msg.params) ?? "");
			if (!handler) {
				// No session owns this thread (cancelled mid-approval) — refuse.
				this.write({ id, error: { message: "no session for thread" } });
				return;
			}
			void handler
				.onRequest(msg.method, msg.params)
				.then((result) => this.write({ id, result }))
				.catch((err: unknown) => {
					this.write({
						id,
						error: {
							message: err instanceof Error ? err.message : String(err),
						},
					});
				});
			return;
		}
		// Notification — route by threadId; thread-less notifications (e.g.
		// account/mcp status updates) fan out to every attached session.
		if (msg.method) {
			const threadId = this.threadIdOf(msg.params);
			if (threadId) {
				this.threads.get(threadId)?.onNotification(msg.method, msg.params);
			} else {
				for (const handler of this.threads.values()) {
					handler.onNotification(msg.method, msg.params);
				}
			}
		}
	}
}

const servers = new Map<string, CodexAppServer>();

/**
 * Get the shared app-server for `executable`, spawning (or respawning after a
 * crash) as needed. Await `.ready` before issuing RPCs.
 */
export function acquireCodexAppServer(executable: string): CodexAppServer {
	const existing = servers.get(executable);
	if (existing?.alive) return existing;
	const server = new CodexAppServer(executable);
	servers.set(executable, server);
	return server;
}

/** Kill every shared app-server. Wired into server shutdown. */
export function closeAllCodexAppServers(): void {
	for (const server of servers.values()) server.kill();
	servers.clear();
}

/**
 * Snapshot of the shared app-server registry for diagnostics
 * (GET /codex/app-servers).
 */
export function listCodexAppServers(): Array<{
	executable: string;
	alive: boolean;
	threads: number;
}> {
	return [...servers.values()].map((server) => ({
		executable: server.executable,
		alive: server.alive,
		threads: server.threadCount,
	}));
}

export function __resetCodexAppServersForTesting(): void {
	closeAllCodexAppServers();
}
