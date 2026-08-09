/**
 * Shared codex-cli `app-server` connections.
 *
 * Previously every CodexAgentSession (and every model/list fetch) spawned its
 * own `codex app-server` child process — on Windows that popped a visible
 * console window per chat, per home/raven page visit, and per catalog refresh.
 *
 * The app-server protocol is explicitly multi-thread: every notification and
 * server-initiated approval request carries a `threadId`, and thread/start +
 * turn/start both accept a per-thread `cwd`. So Hlid keeps one app-server per
 * process identity: executable, global launch args, and non-secret registry
 * profile. Sessions with the same identity are multiplexed over it as threads.
 *
 * Lifecycle: lazily spawned on first acquire, retained while RPCs or threads
 * are active, and reaped after an idle grace period. It respawns on the next
 * acquire after an idle shutdown or crash. closeAll() is also wired into the
 * server's SIGINT/SIGTERM handlers.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type {
	CurrentTimeReadResponse,
	ServerRequestResolvedNotification,
} from "./codexProtocol";
import { resetCodexRealtimeBackendStatus } from "./codexRealtimeStatus";

export type CodexAppServerLaunch = {
	executable: string;
	/**
	 * Distinguishes app servers that share an executable but use different
	 * providers or environment-backed identities. Keep credentials themselves
	 * out of this value; use a stable non-secret fingerprint instead.
	 */
	registryKey?: string;
	/**
	 * Global Codex arguments placed before the app-server subcommand. Their
	 * exact order is part of the shared app-server identity.
	 */
	args?: string[];
	/**
	 * Environment overrides for this process. Callers must represent any
	 * identity-affecting values in `registryKey` so secrets do not enter map keys.
	 */
	env?: Record<string, string>;
};

type CodexAppServerStartupFailure = "wsl-service-unexpected";

const CODEX_WSL_STARTUP_RECOVERY_MESSAGE =
	"WSL could not start Codex. Save any work running in WSL, restart WSL, then try again. Your Raven chat is still intact.";

/**
 * Process exits keep the existing user-facing message while carrying enough
 * bounded structure for callers to distinguish a confirmed transient launcher
 * failure from an ordinary Codex exit. Raw child output is never retained.
 */
class CodexAppServerExitError extends Error {
	constructor(
		readonly exitCode: number | null,
		readonly startupFailure: CodexAppServerStartupFailure | undefined,
		readonly initialized: boolean,
	) {
		super(`Codex app-server exited (code ${exitCode ?? "null"})`);
		this.name = "CodexAppServerExitError";
	}
}

class CodexWslStartupError extends Error {
	constructor(cause: Error) {
		super(CODEX_WSL_STARTUP_RECOVERY_MESSAGE, { cause });
		this.name = "CodexWslStartupError";
	}
}

type CodexAppServerTerminationLaunch = {
	executable: string;
	args: string[];
};

function codexAppServerTerminationLaunch(
	pid: number | undefined,
	platform: NodeJS.Platform = process.platform,
): CodexAppServerTerminationLaunch | null {
	if (platform !== "win32" || !pid || pid <= 0) return null;
	return {
		executable: "taskkill.exe",
		args: ["/PID", String(pid), "/T", "/F"],
	};
}

function normalizeLaunch(
	launch: string | CodexAppServerLaunch,
): CodexAppServerLaunch {
	return typeof launch === "string" ? { executable: launch } : launch;
}

function launchRegistryKey(launch: CodexAppServerLaunch): string {
	// Every launch arg precedes `app-server` and can change process-global
	// behavior (for example `--enable realtime_conversation`). Preserve exact
	// ordering because repeated `-c` overrides can be order-sensitive. Env values
	// are deliberately excluded; registryKey carries their non-secret identity.
	return JSON.stringify([
		launch.executable,
		launch.registryKey ?? null,
		launch.args ?? [],
	]);
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
const REMOTE_PLUGIN_SYNC_WARNING_COOLDOWN_MS = 60 * 60_000;
const APP_CATALOG_DEGRADED_WARNING =
	"Codex app catalog refresh is degraded; provider sessions remain available";
const pendingCodexAppServerTerminations = new Set<Promise<void>>();
let lastRemotePluginSyncWarningAt = Number.NEGATIVE_INFINITY;
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

export type CodexRateLimitsRead =
	| { status: "current"; snapshot: unknown }
	| { status: "superseded" };

export type ServerRequestContext = {
	/** Native JSON-RPC request ID used by `serverRequest/resolved`. */
	requestId: number | string;
	/** Aborted when Codex reports that this request no longer needs a reply. */
	signal: AbortSignal;
};

/** Per-thread callbacks a session registers to receive its routed traffic. */
export type ThreadHandler = {
	onNotification(method: string, params: unknown): void;
	/**
	 * Server-initiated request (approval) scoped to this thread. The returned
	 * value is written back as the JSON-RPC result; a throw becomes an error
	 * response.
	 */
	onRequest(
		method: string,
		params: unknown,
		context: ServerRequestContext,
	): Promise<unknown>;
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
			if (
				target.includes("codex_core_plugins::") &&
				(/remote installed plugin bundle sync failed/i.test(raw) ||
					/failed to refresh remote installed plugins cache/i.test(raw))
			) {
				return APP_CATALOG_DEGRADED_WARNING;
			}
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
	private initialized = false;
	private startupFailure: CodexAppServerStartupFailure | undefined;
	private termination: Promise<void> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private activeServerRequests = 0;
	private activeServerRequestControllers = new Map<
		number | string,
		AbortController
	>();
	private accountRateLimitsRevision = 0;
	private accountRateLimitsRead: {
		revision: number;
		promise: Promise<CodexRateLimitsRead>;
	} | null = null;
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
		private readonly hostPlatform: NodeJS.Platform = process.platform,
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
		this.proc.on("error", (err) => this.fail(this.withStartupFailure(err)));
		this.proc.on("exit", (code) => {
			// The Windows launcher normally terminates diagnostics with a newline,
			// but preserve the classification if the final stdout/stderr chunk is
			// partial when the child exits.
			this.observeStartupDiagnostic(this.lineBuffer);
			this.observeStartupDiagnostic(this.stderrBuffer);
			this.fail(
				this.withStartupFailure(
					new CodexAppServerExitError(
						code,
						this.startupFailure,
						this.initialized,
					),
				),
			);
		});
		this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
		this.proc.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
		this.proc.stderr.on("end", () => this.flushPartialStderr());

		this.ready = (async () => {
			await this.request("initialize", {
				clientInfo: { name: "hlid", title: "Hlid", version: "0.0.0" },
				capabilities: {
					experimentalApi: true,
					extensions: { "openai/form": {} },
				},
			});
			this.initialized = true;
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
		return this.sendRequest(method, params, timeoutMs, true);
	}

	/**
	 * Issue optional metadata work without letting its timeout tear down active
	 * chat threads on the shared transport. A late response is safely ignored.
	 */
	requestOptional(
		method: string,
		params: unknown,
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<unknown> {
		return this.sendRequest(method, params, timeoutMs, false);
	}

	/**
	 * Read the account-wide rate-limit snapshot through one shared ownership
	 * boundary. Concurrent sessions reuse the same RPC, and a native update that
	 * arrives while the read is in flight supersedes that older response.
	 */
	readAccountRateLimits(): Promise<CodexRateLimitsRead> {
		const startingRevision = this.accountRateLimitsRevision;
		if (this.accountRateLimitsRead?.revision === startingRevision) {
			return this.accountRateLimitsRead.promise;
		}
		const pending = this.requestOptional(
			"account/rateLimits/read",
			undefined,
		).then(
			(response): CodexRateLimitsRead =>
				this.accountRateLimitsRevision === startingRevision
					? { status: "current", snapshot: asObj(response).rateLimits }
					: { status: "superseded" },
		);
		this.accountRateLimitsRead = {
			revision: startingRevision,
			promise: pending,
		};
		const clearPending = () => {
			if (this.accountRateLimitsRead?.promise === pending) {
				this.accountRateLimitsRead = null;
			}
		};
		void pending.then(clearPending, clearPending);
		return pending;
	}

	private sendRequest(
		method: string,
		params: unknown,
		timeoutMs: number,
		terminateOnTimeout: boolean,
	): Promise<unknown> {
		if (this.dead)
			return Promise.reject(new Error("Codex app-server is not running"));
		this.cancelIdleReap();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const rawError = new Error(
					`Codex app-server ${method} timed out after ${timeoutMs}ms`,
				);
				const error =
					method === "initialize"
						? this.withStartupFailure(rawError)
						: rawError;
				if (terminateOnTimeout) {
					// A live process that no longer answers a required RPC is not
					// reusable. Respawn instead of attaching to a poisoned singleton.
					void this.terminate(error);
					return;
				}
				// Optional metadata can fail independently of conversation traffic.
				// Reject only this call so a plugin or MCP inventory stall cannot
				// disconnect every attached chat thread.
				if (!this.pending.delete(id)) return;
				reject(error);
				this.scheduleIdleReap();
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

	detachThread(threadId: string, expectedHandler: ThreadHandler): void {
		if (this.threads.get(threadId) !== expectedHandler) return;
		this.threads.delete(threadId);
		this.scheduleIdleReap();
	}

	/** Refresh the idle grace period when an existing shared server is acquired. */
	// fallow-ignore-next-line unused-class-member -- Called by the module-level shared-server registry in acquireCodexAppServer.
	touch(): void {
		this.scheduleIdleReap();
	}

	kill(error = new Error("Codex app-server closed")): void {
		void this.terminate(error);
	}

	private terminate(error: Error): Promise<void> {
		if (this.termination) return this.termination;
		if (this.dead) return Promise.resolve();
		this.fail(error);
		const termination = codexAppServerTerminationLaunch(
			this.proc.pid,
			this.hostPlatform,
		);
		if (!termination) {
			this.proc.kill();
			this.termination = Promise.resolve();
			return this.termination;
		}
		const pending = new Promise<void>((resolve) => {
			try {
				const terminator = spawn(termination.executable, termination.args, {
					stdio: "ignore",
					windowsHide: true,
				});
				let settled = false;
				let fallback: ReturnType<typeof setTimeout> | undefined;
				const finish = (successful: boolean) => {
					if (settled) return;
					settled = true;
					if (fallback !== undefined) clearTimeout(fallback);
					if (!successful) this.proc.kill();
					resolve();
				};
				terminator.once("error", () => finish(false));
				terminator.once("exit", (code) => finish(code === 0));
				fallback = setTimeout(() => {
					terminator.kill();
					finish(false);
				}, 2_000);
				fallback.unref?.();
				terminator.unref();
			} catch {
				this.proc.kill();
				resolve();
			}
		});
		this.termination = pending;
		pendingCodexAppServerTerminations.add(pending);
		void pending.then(() => pendingCodexAppServerTerminations.delete(pending));
		return pending;
	}

	private withStartupFailure(error: Error): Error {
		this.observeStartupDiagnostic(this.lineBuffer);
		this.observeStartupDiagnostic(this.stderrBuffer);
		if (
			this.initialized ||
			this.startupFailure !== "wsl-service-unexpected" ||
			error instanceof CodexWslStartupError
		) {
			return error;
		}
		return new CodexWslStartupError(error);
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
		for (const controller of this.activeServerRequestControllers.values()) {
			controller.abort(err);
		}
		this.activeServerRequestControllers.clear();
		const handlers = new Set(this.threads.values());
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
			void this.terminate(new Error("Codex app-server idle timeout"));
		}, idleDelay);
		this.idleTimer = timer;
		// An idle helper must never keep the Hlid server process alive.
		timer.unref?.();
	}

	private write(message: JsonRpcMessage): void {
		// A server-initiated request can settle after its owning thread has already
		// closed the transport. Dropping that stale response is required: writing to
		// a killed child's stdin emits EPIPE as an unhandled stream error in Node.
		if (this.dead) return;
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
		this.observeStartupDiagnostic(line);
		const summary = summarizeCodexStderr(line);
		if (summary === null) return;
		if (summary === undefined) {
			if (line.trim()) this.recordOmittedStderr(line);
			return;
		}
		if (summary === APP_CATALOG_DEGRADED_WARNING) {
			const now = Date.now();
			if (
				now - lastRemotePluginSyncWarningAt <
				REMOTE_PLUGIN_SYNC_WARNING_COOLDOWN_MS
			) {
				return;
			}
			lastRemotePluginSyncWarningAt = now;
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
				this.observeStartupDiagnostic(line);
				console.warn("[codex app-server] non-JSON output:", line);
				continue;
			}
			this.handleMessage(msg);
		}
	}

	private observeStartupDiagnostic(line: string): void {
		const hasWslServiceFailure = line
			.replaceAll("\0", "")
			.split(/\r?\n/)
			.some((part) =>
				/^\uFEFF?Error code:\s*Wsl\/Service\/E_UNEXPECTED$/i.test(part.trim()),
			);
		if (!this.initialized && hasWslServiceFailure) {
			this.startupFailure = "wsl-service-unexpected";
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
			if (method === "currentTime/read") {
				const result = {
					currentTimeAt: Math.floor(Date.now() / 1_000),
				} satisfies CurrentTimeReadResponse;
				this.write({ id, result });
				this.scheduleIdleReap();
				return;
			}
			const handler = this.threads.get(this.threadIdOf(msg.params) ?? "");
			if (!handler) {
				// No session owns this thread (cancelled mid-approval) — refuse.
				this.write({ id, error: { message: "no session for thread" } });
				this.scheduleIdleReap();
				return;
			}
			const controller = new AbortController();
			this.activeServerRequestControllers.set(id, controller);
			this.activeServerRequests++;
			this.cancelIdleReap();
			void Promise.resolve()
				.then(() =>
					handler.onRequest(method, msg.params, {
						requestId: id,
						signal: controller.signal,
					}),
				)
				.then((result) => {
					if (!controller.signal.aborted) this.write({ id, result });
				})
				.catch((err: unknown) => {
					if (controller.signal.aborted) return;
					this.write({
						id,
						error: {
							message: err instanceof Error ? err.message : String(err),
						},
					});
				})
				.finally(() => {
					if (this.activeServerRequestControllers.get(id) === controller) {
						this.activeServerRequestControllers.delete(id);
					}
					this.activeServerRequests--;
					this.scheduleIdleReap();
				});
			return;
		}
		// Notification — route by threadId; thread-less notifications (e.g.
		// account/mcp status updates) fan out once per attached session owner.
		if (msg.method) {
			if (msg.method === "serverRequest/resolved") {
				const notification = msg.params as ServerRequestResolvedNotification;
				this.activeServerRequestControllers
					.get(notification.requestId)
					?.abort(new Error("Codex resolved the server request"));
			}
			if (msg.method === "account/rateLimits/updated") {
				this.accountRateLimitsRevision++;
			}
			const threadId = this.threadIdOf(msg.params);
			if (threadId) {
				this.threads.get(threadId)?.onNotification(msg.method, msg.params);
			} else {
				for (const handler of new Set(this.threads.values())) {
					handler.onNotification(msg.method, msg.params);
				}
			}
		}
	}
}

const servers = new Map<string, CodexAppServer>();

/**
 * Get the shared app-server for this exact process identity, spawning (or
 * respawning after a crash) as needed. Await `.ready` before issuing RPCs.
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
	launchValue: string | CodexAppServerLaunch,
	waitTimeoutMs?: number,
): Promise<boolean> {
	const server = acquireCodexAppServer(launchValue);
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
	resetCodexRealtimeBackendStatus();
}

/** Wait for exact Windows wrapper-tree cleanup started by shared or owned servers. */
export async function waitForCodexAppServerTerminations(): Promise<void> {
	while (pendingCodexAppServerTerminations.size > 0) {
		await Promise.all([...pendingCodexAppServerTerminations]);
	}
}

/**
 * Restart provider metadata without interrupting attached conversations.
 * Extension mutations use this after idle SessionManagers have detached.
 */
export function closeIdleCodexAppServers(): number {
	let closed = 0;
	for (const [key, server] of servers) {
		if (server.threadCount > 0) continue;
		server.kill(new Error("Codex app-server reloading provider extensions"));
		servers.delete(key);
		closed++;
	}
	return closed;
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
	pendingCodexAppServerTerminations.clear();
	lastRemotePluginSyncWarningAt = Number.NEGATIVE_INFINITY;
}
