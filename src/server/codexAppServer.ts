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
 * Lifecycle: lazily spawned on first acquire, retained while RPCs or threads
 * are active, and reaped after an idle grace period. It respawns on the next
 * acquire after an idle shutdown or crash. closeAll() is also wired into the
 * server's SIGINT/SIGTERM handlers.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export type CodexAppServerLaunch = {
	executable: string;
	/** Distinguishes app servers that share an executable but use different providers. */
	registryKey?: string;
	/** Global Codex arguments placed before the app-server subcommand. */
	args?: string[];
	env?: Record<string, string>;
};

function normalizeLaunch(
	launch: string | CodexAppServerLaunch,
): CodexAppServerLaunch {
	return typeof launch === "string" ? { executable: launch } : launch;
}

function launchRegistryKey(launch: CodexAppServerLaunch): string {
	return `${launch.executable}\0${launch.registryKey ?? "native"}`;
}

type JsonRpcMessage = {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string };
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_METADATA_IDLE_TIMEOUT_MS = 10_000;
const CODEX_STDERR_BURST_MS = 100;
const MAX_CODEX_STDERR_BUFFER_CHARS = 64 * 1024;
const MAX_CODEX_DIAGNOSTIC_CHARS = 500;
// biome-ignore lint/complexity/useRegexLiterals: constructor avoids a literal control character rejected by noControlCharactersInRegex
const ANSI_ESCAPE = new RegExp("\\x1b\\[[0-9;]*m", "g");

function configuredIdleTimeoutMs(): number {
	const raw = process.env.HLID_CODEX_APP_SERVER_IDLE_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_TIMEOUT_MS;
	const parsed = Number(raw);
	// Zero intentionally means "reap on the next event-loop turn". Invalid or
	// negative values fall back to the safe production default.
	return Number.isFinite(parsed) && parsed >= 0
		? parsed
		: DEFAULT_IDLE_TIMEOUT_MS;
}

function configuredMetadataIdleTimeoutMs(): number {
	const raw = process.env.HLID_CODEX_APP_SERVER_METADATA_IDLE_MS;
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_METADATA_IDLE_TIMEOUT_MS;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0
		? parsed
		: DEFAULT_METADATA_IDLE_TIMEOUT_MS;
}

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
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

function isBenignCodexStderr(line: string): boolean {
	return (
		line.includes("Shell snapshot not supported yet for PowerShell") ||
		(/Failed to list (?:resources|resource templates) for MCP server/.test(
			line,
		) &&
			line.includes("-32601") &&
			line.includes("Method not found"))
	);
}

function compactDiagnosticText(value: string): string {
	const firstLine = value.replace(ANSI_ESCAPE, "").split(/\r?\n/, 1)[0].trim();
	return firstLine
		.replace(/[A-Za-z]:\\[^|"\n]+/g, "<path>")
		.replace(/\/(?:home|Users|mnt\/c\/Users)\/[^\s|"']+/g, "<path>")
		.replace(/https?:\/\/\S+/g, "<url>")
		.slice(0, MAX_CODEX_DIAGNOSTIC_CHARS);
}

function summarizeToolFailure(value: string): string {
	if (/apply_patch verification failed/i.test(value)) {
		return "tool failure: apply_patch verification failed (details omitted)";
	}
	if (/exec_command failed for/i.test(value)) {
		return "tool failure: exec_command failed (command and output omitted)";
	}
	if (/write_stdin failed: Unknown process id/i.test(value)) {
		return "tool failure: write_stdin targeted a process that had already exited";
	}
	const windowsError = value.match(
		/windows sandbox[\s\S]*?Windows error (\d+)/i,
	);
	if (windowsError) {
		return `tool failure: Windows sandbox process launch failed (error ${windowsError[1]})`;
	}
	const exitCode = value.match(/Exit code:\s*(-?\d+)/i);
	if (exitCode) {
		return `tool failure: command exited with code ${exitCode[1]} (output omitted)`;
	}
	return "tool/runtime failure (details omitted)";
}

/**
 * Return null for known benign diagnostics, a safe summary for useful
 * diagnostics, and undefined for unstructured continuation output.
 */
function summarizeCodexStderr(line: string): string | null | undefined {
	const clean = line.replace(ANSI_ESCAPE, "").trim();
	if (!clean || isBenignCodexStderr(clean)) return null;

	if (clean.startsWith("{")) {
		try {
			const parsed = JSON.parse(clean) as {
				level?: unknown;
				target?: unknown;
				fields?: { message?: unknown; error?: unknown };
			};
			const level =
				typeof parsed.level === "string" ? parsed.level.toUpperCase() : "WARN";
			const target =
				typeof parsed.target === "string" ? parsed.target : "codex runtime";
			const raw =
				typeof parsed.fields?.message === "string"
					? parsed.fields.message
					: typeof parsed.fields?.error === "string"
						? parsed.fields.error
						: "";
			if (/models_manager::cache$/.test(target)) {
				if (/failed to load models cache/i.test(raw)) {
					return `${target}: model catalog cache could not be read; Codex will refresh it`;
				}
				if (/failed to write models cache/i.test(raw)) {
					return `${target}: model catalog cache could not be saved; the current catalog remains available`;
				}
			}
			if (
				level === "ERROR" ||
				target.includes("::tools::") ||
				target.endsWith("::exec")
			) {
				return `${target}: ${summarizeToolFailure(raw)}`;
			}
			const summary = compactDiagnosticText(raw);
			return summary ? `${target}: ${summary}` : `${target}: ${level}`;
		} catch {
			return undefined;
		}
	}

	if (/^\d{4}-\d{2}-\d{2}T\S+\s+(?:ERROR|WARN)\s+/i.test(clean)) {
		return summarizeToolFailure(clean);
	}
	if (/stream disconnected|failed to load recommended plugins/i.test(clean)) {
		return compactDiagnosticText(clean);
	}
	return undefined;
}

export class CodexAppServer {
	private proc: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private pending = new Map<number | string, PendingRequest>();
	private threads = new Map<string, ThreadHandler>();
	private lineBuffer = "";
	private stderrBuffer = "";
	private omittedStderrLines = 0;
	private omittedStderrChars = 0;
	private stderrOmissionTimer: ReturnType<typeof setTimeout> | undefined;
	private dead = false;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private activeServerRequests = 0;
	private readonly idleTimeoutMs: number;
	private readonly metadataIdleTimeoutMs: number;
	private useLongIdleGrace = false;
	/** Resolves after the initialize/initialized handshake completes. */
	readonly ready: Promise<void>;

	constructor(
		launchValue: string | CodexAppServerLaunch,
		idleTimeoutMs = configuredIdleTimeoutMs(),
		private readonly onClosed?: (server: CodexAppServer) => void,
		metadataIdleTimeoutMs = Math.min(
			idleTimeoutMs,
			configuredMetadataIdleTimeoutMs(),
		),
	) {
		const launch = normalizeLaunch(launchValue);
		this.executable = launch.executable;
		this.registryKey = launch.registryKey;
		this.idleTimeoutMs = Math.max(0, idleTimeoutMs);
		this.metadataIdleTimeoutMs = Math.max(0, metadataIdleTimeoutMs);
		// No cwd: the wrapper .cmd sets its own WSL cwd via `wsl --cd`, and for
		// native codex every thread passes an explicit cwd at thread/start and
		// turn/start, so the process cwd is irrelevant. windowsHide passes
		// CREATE_NO_WINDOW so the .cmd/console child never shows a window.
		this.proc = spawn(
			launch.executable,
			[...(launch.args ?? []), "app-server", "--listen", "stdio://"],
			{
				stdio: "pipe",
				windowsHide: true,
				...(launch.env ? { env: { ...process.env, ...launch.env } } : {}),
			},
		);
		this.proc.on("error", (err) => this.fail(err));
		this.proc.on("exit", (code) => {
			this.fail(new Error(`Codex app-server exited (code ${code ?? "null"})`));
		});
		this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
		this.proc.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
		this.proc.stderr.on("end", () => this.flushPartialStderr());

		this.ready = (async () => {
			await this.request("initialize", {
				clientInfo: { name: "hlid", title: "Hlid", version: "0.0.0" },
				capabilities: {
					experimentalApi: true,
					mcpServerOpenaiFormElicitation: true,
				},
			});
			this.notify("initialized", {});
		})();
		// Callers that never await .ready (or that race a fail()) must not
		// trigger an unhandled-rejection crash.
		this.ready.catch(() => {});
	}

	readonly executable: string;
	readonly registryKey?: string;

	get alive(): boolean {
		return !this.dead;
	}

	/** Number of sessions currently attached as threads. */
	get threadCount(): number {
		return this.threads.size;
	}

	request(
		method: string,
		params: unknown,
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<unknown> {
		if (this.dead)
			return Promise.reject(new Error("Codex app-server is not running"));
		this.cancelIdleReap();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const error = new Error(
					`Codex app-server ${method} timed out after ${timeoutMs}ms`,
				);
				// A live process that no longer answers RPCs is not reusable. Mark the
				// shared connection dead and terminate it so the next acquire respawns
				// a clean app-server instead of attaching to a poisoned singleton.
				this.terminate(error);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (this.dead) return;
		this.write({ method, params });
	}

	attachThread(threadId: string, handler: ThreadHandler): void {
		this.cancelIdleReap();
		this.useLongIdleGrace = true;
		this.threads.set(threadId, handler);
	}

	detachThread(threadId: string): void {
		this.threads.delete(threadId);
		this.scheduleIdleReap();
	}

	/** Refresh the idle grace period when an existing shared server is acquired. */
	// fallow-ignore-next-line unused-class-member -- Called by the module-level shared-server registry in acquireCodexAppServer.
	touch(): void {
		this.scheduleIdleReap();
	}

	kill(error = new Error("Codex app-server closed")): void {
		this.terminate(error);
	}

	private terminate(error: Error): void {
		this.fail(error);
		this.proc.kill();
	}

	private fail(err: Error): void {
		if (this.dead) return;
		this.dead = true;
		this.cancelIdleReap();
		this.flushPartialStderr();
		this.flushOmittedStderr();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(err);
		}
		this.pending.clear();
		const handlers = [...this.threads.values()];
		this.threads.clear();
		try {
			for (const handler of handlers) handler.onExit(err);
		} finally {
			this.onClosed?.(this);
		}
	}

	private cancelIdleReap(): void {
		if (this.idleTimer === undefined) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private scheduleIdleReap(): void {
		this.cancelIdleReap();
		if (
			this.dead ||
			this.pending.size > 0 ||
			this.threads.size > 0 ||
			this.activeServerRequests > 0
		) {
			return;
		}
		// Metadata-only calls such as model/list can launch a large helper process
		// while rendering a picker. Reap those aggressively; a server that actually
		// owned a chat thread keeps the longer grace period to avoid turn-to-turn
		// respawn churn.
		const idleDelay = this.useLongIdleGrace
			? this.idleTimeoutMs
			: this.metadataIdleTimeoutMs;
		const timer = setTimeout(() => {
			// Timer identity plus a fresh idle check makes a detach/reattach or
			// request race harmless even if the old callback was already queued.
			if (this.idleTimer !== timer) return;
			this.idleTimer = undefined;
			if (
				this.dead ||
				this.pending.size > 0 ||
				this.threads.size > 0 ||
				this.activeServerRequests > 0
			) {
				return;
			}
			this.terminate(new Error("Codex app-server idle timeout"));
		}, idleDelay);
		this.idleTimer = timer;
		// An idle helper must never keep the Hlid server process alive.
		timer.unref?.();
	}

	private write(message: JsonRpcMessage): void {
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private onStderr(chunk: Buffer): void {
		this.stderrBuffer += chunk.toString("utf8");
		while (true) {
			const index = this.stderrBuffer.indexOf("\n");
			if (index === -1) break;
			const line = this.stderrBuffer.slice(0, index).replace(/\r$/, "");
			this.stderrBuffer = this.stderrBuffer.slice(index + 1);
			this.handleStderrLine(line);
		}
		if (this.stderrBuffer.length > MAX_CODEX_STDERR_BUFFER_CHARS) {
			this.recordOmittedStderr(this.stderrBuffer);
			this.stderrBuffer = "";
		}
	}

	private flushPartialStderr(): void {
		if (!this.stderrBuffer) return;
		const line = this.stderrBuffer;
		this.stderrBuffer = "";
		this.handleStderrLine(line);
	}

	private handleStderrLine(line: string): void {
		const summary = summarizeCodexStderr(line);
		if (summary === null) return;
		if (summary === undefined) {
			if (line.trim()) this.recordOmittedStderr(line);
			return;
		}
		console.warn("[codex app-server]", summary);
	}

	private recordOmittedStderr(line: string): void {
		this.omittedStderrLines++;
		this.omittedStderrChars += line.length;
		if (this.stderrOmissionTimer !== undefined) return;
		this.stderrOmissionTimer = setTimeout(
			() => this.flushOmittedStderr(),
			CODEX_STDERR_BURST_MS,
		);
		this.stderrOmissionTimer.unref?.();
	}

	private flushOmittedStderr(): void {
		if (this.stderrOmissionTimer !== undefined) {
			clearTimeout(this.stderrOmissionTimer);
			this.stderrOmissionTimer = undefined;
		}
		if (this.omittedStderrLines === 0) return;
		console.warn(
			"[codex app-server]",
			`omitted unstructured stderr burst (${this.omittedStderrLines} lines, ${this.omittedStderrChars} chars)`,
		);
		this.omittedStderrLines = 0;
		this.omittedStderrChars = 0;
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
			clearTimeout(pending.timer);
			if (msg.error)
				pending.reject(new Error(msg.error.message ?? "Codex error"));
			else pending.resolve(msg.result);
			this.scheduleIdleReap();
			return;
		}
		// Server-initiated request (approvals) — route to the owning thread.
		if (msg.id !== undefined && msg.method) {
			const id = msg.id;
			const method = msg.method;
			const handler = this.threads.get(this.threadIdOf(msg.params) ?? "");
			if (!handler) {
				// No session owns this thread (cancelled mid-approval) — refuse.
				this.write({ id, error: { message: "no session for thread" } });
				this.scheduleIdleReap();
				return;
			}
			this.activeServerRequests++;
			this.cancelIdleReap();
			void Promise.resolve()
				.then(() => handler.onRequest(method, msg.params))
				.then((result) => this.write({ id, result }))
				.catch((err: unknown) => {
					this.write({
						id,
						error: {
							message: err instanceof Error ? err.message : String(err),
						},
					});
				})
				.finally(() => {
					this.activeServerRequests--;
					this.scheduleIdleReap();
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
export function acquireCodexAppServer(
	launchValue: string | CodexAppServerLaunch,
): CodexAppServer {
	const launch = normalizeLaunch(launchValue);
	const key = launchRegistryKey(launch);
	const existing = servers.get(key);
	if (existing?.alive) {
		existing.touch();
		return existing;
	}
	const server = new CodexAppServer(launch, undefined, (closed) => {
		// A thread's onExit callback can synchronously acquire a replacement.
		// Never let the closing instance delete that newer registry entry.
		if (servers.get(key) === closed) servers.delete(key);
	});
	servers.set(key, server);
	return server;
}

/**
 * Start and initialize Codex without creating a thread. When `waitTimeoutMs`
 * is set, return false after that bounded wait while allowing initialization
 * to continue in the background.
 */
export async function prewarmCodexAppServer(
	executable: string,
	waitTimeoutMs?: number,
): Promise<boolean> {
	const server = acquireCodexAppServer(executable);
	if (waitTimeoutMs === undefined) {
		await server.ready;
		return true;
	}

	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			server.ready.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), Math.max(0, waitTimeoutMs));
				timeout.unref?.();
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
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
	profile?: string;
	alive: boolean;
	threads: number;
}> {
	return [...servers.values()].map((server) => ({
		executable: server.executable,
		...(server.registryKey ? { profile: server.registryKey } : {}),
		alive: server.alive,
		threads: server.threadCount,
	}));
}

export function __resetCodexAppServersForTesting(): void {
	closeAllCodexAppServers();
}
