/**
 * PtyBridge — spawns a Node.js subprocess (pty-worker.cjs) that owns node-pty.
 *
 * node-pty's native addon does not work correctly under Bun: onData callbacks
 * fire only for the first chunk then onExit fires prematurely — even for
 * long-lived interactive processes. Running node-pty inside a separate Node.js
 * process (pty-worker.cjs) and communicating over framed binary pipes solves this.
 *
 * Wire protocol  ──  Bun → worker stdin:
 *   First message: JSON config line terminated with '\n' (executable, args, cols, rows, cwd, env)
 *   [0x01][4-byte len BE][bytes]              — write bytes to PTY stdin
 *   [0x02][2-byte cols BE][2-byte rows BE]    — resize PTY window
 *   [0x03]                                    — kill PTY
 *
 * Wire protocol  ──  worker stdout → Bun:
 *   [0x01][4-byte len BE][bytes]              — PTY output data
 *   [0x02][4-byte exit code BE]               — PTY process exited
 *
 * PTY inherits process.env minus CLAUDECODE / CLAUDE_CODE_* vars (which would
 * cause a child claude to detect nesting and exit immediately) so
 * ANTHROPIC_BASE_URL (set by the hlid proxy) is forwarded and costs are tracked.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PtyBridgeOptions {
	/** DB claude_session_id — passed as --resume to continue prior conversation. */
	claudeSessionId?: string;
	/** Working directory for the CLI session. */
	cwd: string;
	/** Initial terminal column count. */
	cols: number;
	/** Initial terminal row count. */
	rows: number;
	/** Resolved path to the claude executable. */
	executable: string;
	/** Override the path to pty-worker.cjs (default: module-level WORKER_PATH). */
	workerPath?: string;
	/** Working directory for the node subprocess (e.g. the extracted pty-rt dir). */
	workerCwd?: string;
}

/**
 * Minimal interface for the worker subprocess handle.
 * Kept narrow so tests can mock it without needing Bun globals.
 */
export interface WorkerHandle {
	stdin: {
		write(data: Buffer | Uint8Array | string): void;
		flush(): void;
	};
	stdout: ReadableStream<Uint8Array>;
	kill(): void;
}

const __filename = fileURLToPath(import.meta.url);
const WORKER_PATH = join(__filename, "..", "pty-worker.cjs");

/**
 * Internal spawner extracted for testability — tests replace this with a mock
 * so no Bun globals are needed in the Node.js vitest environment.
 *
 * Only responsible for launching the subprocess; config is written by PtyBridge.spawn.
 */
export const _impl = {
	spawnWorker(workerPath: string, workerCwd?: string): WorkerHandle {
		// biome-ignore lint/suspicious/noExplicitAny: Bun not typed in test environment
		const proc = (globalThis as any).Bun.spawn(["node", workerPath], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
			cwd: workerCwd,
		});
		return proc as WorkerHandle;
	},
};

export class PtyBridge {
	private worker: WorkerHandle;
	private outBuf = Buffer.alloc(0);
	private dataCallbacks: ((data: Buffer) => void)[] = [];
	private exitCallbacks: ((code: number) => void)[] = [];

	private constructor(worker: WorkerHandle) {
		this.worker = worker;
		this.pumpStdout();
	}

	/** Spawn a new PTY worker running the Claude CLI. */
	static spawn(opts: PtyBridgeOptions): PtyBridge {
		const args: string[] = [];
		if (opts.claudeSessionId) {
			args.push("--resume", opts.claudeSessionId);
		}
		// Note: --cwd is not a valid claude CLI flag; working dir is set via the
		// JSON config `cwd` field which pty-worker passes to node-pty's spawn options.

		// Strip CLAUDECODE / CLAUDE_CODE_* env vars so the child claude process
		// doesn't detect it's running inside an existing Claude Code session and exit.
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v === undefined) continue;
			if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
			env[k] = v;
		}

		const configJson = JSON.stringify({
			executable: opts.executable,
			args,
			cols: opts.cols,
			rows: opts.rows,
			cwd: opts.cwd,
			env,
		});

		const resolvedWorkerPath = opts.workerPath ?? WORKER_PATH;
		const worker = _impl.spawnWorker(resolvedWorkerPath, opts.workerCwd);
		// Send config as JSON line; worker reads until '\n' then switches to binary framing.
		worker.stdin.write(Buffer.from(`${configJson}\n`, "utf8"));
		worker.stdin.flush();

		return new PtyBridge(worker);
	}

	private pumpStdout(): void {
		const reader = this.worker.stdout.getReader();
		const pump = async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				this.handleOutput(Buffer.from(value));
			}
		};
		pump().catch(() => {});
	}

	private handleOutput(chunk: Buffer): void {
		this.outBuf = Buffer.concat([this.outBuf, chunk]);
		while (this.outBuf.length > 0) {
			const type = this.outBuf[0];
			if (type === 0x01) {
				// Data frame
				if (this.outBuf.length < 5) break;
				const len = this.outBuf.readUInt32BE(1);
				if (this.outBuf.length < 5 + len) break;
				const data = Buffer.from(this.outBuf.subarray(5, 5 + len));
				for (const cb of this.dataCallbacks) cb(data);
				this.outBuf = this.outBuf.subarray(5 + len);
			} else if (type === 0x02) {
				// Exit frame
				if (this.outBuf.length < 5) break;
				const code = this.outBuf.readUInt32BE(1);
				for (const cb of this.exitCallbacks) cb(code);
				this.outBuf = this.outBuf.subarray(5);
			} else {
				// Unknown — skip byte to re-sync
				this.outBuf = this.outBuf.subarray(1);
			}
		}
	}

	/** Write data to the PTY's stdin (keystrokes / paste). */
	write(data: Uint8Array | string): void {
		const bytes =
			typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
		const header = Buffer.allocUnsafe(5);
		header[0] = 0x01;
		header.writeUInt32BE(bytes.length, 1);
		this.worker.stdin.write(Buffer.concat([header, bytes]));
		this.worker.stdin.flush();
	}

	/** Resize the PTY. Call when the browser terminal container changes size. */
	resize(cols: number, rows: number): void {
		const frame = Buffer.allocUnsafe(5);
		frame[0] = 0x02;
		frame.writeUInt16BE(cols, 1);
		frame.writeUInt16BE(rows, 3);
		this.worker.stdin.write(frame);
		this.worker.stdin.flush();
	}

	/**
	 * Subscribe to raw PTY output (ANSI bytes).
	 * Multiple onData callbacks can be registered; each receives all output.
	 */
	onData(cb: (data: Buffer) => void): void {
		this.dataCallbacks.push(cb);
	}

	/** Subscribe to PTY process exit. */
	onExit(cb: (exitCode: number) => void): void {
		this.exitCallbacks.push(cb);
	}

	/** Kill the underlying PTY process. */
	kill(): void {
		this.worker.stdin.write(Buffer.from([0x03]));
		this.worker.stdin.flush();
	}
}
