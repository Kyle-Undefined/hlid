/**
 * PtyBridge unit tests.
 *
 * PtyBridge spawns a pty-worker.cjs Node.js subprocess (instead of calling
 * node-pty directly) because node-pty is unreliable under Bun. Tests mock
 * `_impl.spawnWorker` so no Bun globals are needed in the Node.js vitest
 * environment.
 *
 * Covers:
 *  - Config JSON assembly (executable, args, cwd, env, cols, rows)
 *  - Stdin frame construction for write / resize / kill
 *  - Stdout frame parsing for onData / onExit callbacks
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _impl, PtyBridge, type WorkerHandle } from "./ptyBridge";

// ── worker mock factory ───────────────────────────────────────────────────────

interface WorkerMock {
	worker: WorkerHandle;
	/** All raw bytes written to stdin, in order. */
	stdinWrites: Buffer[];
	/** Concatenation of all stdin writes. */
	getStdinBytes(): Buffer;
	/**
	 * Parse the config JSON from the first stdin write (the '\n'-terminated line
	 * that PtyBridge.spawn sends before any binary frames).
	 */
	getConfig(): Record<string, unknown>;
	/** Emit a data frame from the worker (type 0x01). */
	pushData(data: Buffer): void;
	/** Emit an exit frame from the worker (type 0x02). */
	pushExit(code: number): void;
	/** Close the stdout stream (simulates worker process end). */
	close(): void;
}

function makeWorkerMock(): WorkerMock {
	const stdinWrites: Buffer[] = [];
	let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;

	const worker: WorkerHandle = {
		stdin: {
			write(data: Buffer | Uint8Array | string) {
				stdinWrites.push(
					Buffer.isBuffer(data)
						? Buffer.from(data)
						: typeof data === "string"
							? Buffer.from(data, "utf8")
							: Buffer.from(data as Uint8Array),
				);
			},
			flush() {},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				ctrl = controller;
			},
		}),
		kill: vi.fn(),
	};

	const getStdinBytes = () => Buffer.concat(stdinWrites);

	return {
		worker,
		stdinWrites,
		getStdinBytes,
		getConfig() {
			const all = getStdinBytes();
			const nl = all.indexOf(0x0a); // '\n'
			if (nl === -1)
				throw new Error("No newline in stdin — config JSON not written");
			return JSON.parse(all.subarray(0, nl).toString("utf8"));
		},
		pushData(data: Buffer) {
			const frame = Buffer.allocUnsafe(5 + data.length);
			frame[0] = 0x01;
			frame.writeUInt32BE(data.length, 1);
			data.copy(frame, 5);
			ctrl?.enqueue(new Uint8Array(frame));
		},
		pushExit(code: number) {
			const frame = Buffer.allocUnsafe(5);
			frame[0] = 0x02;
			frame.writeUInt32BE(code, 1);
			ctrl?.enqueue(new Uint8Array(frame));
		},
		close() {
			ctrl?.close();
		},
	};
}

/** Flush async microtasks so pumpStdout can process queued chunks. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOpts(
	overrides: Partial<Parameters<typeof PtyBridge.spawn>[0]> = {},
) {
	return {
		cwd: "/tmp/test",
		cols: 80,
		rows: 24,
		executable: "/usr/bin/claude",
		...overrides,
	};
}

// ── Config assembly ───────────────────────────────────────────────────────────

describe("PtyBridge.spawn — config assembly", () => {
	let mock: WorkerMock;
	const originalSpawn = _impl.spawnWorker.bind(_impl);

	beforeEach(() => {
		mock = makeWorkerMock();
		_impl.spawnWorker = vi.fn(() => mock.worker);
	});

	afterEach(() => {
		_impl.spawnWorker = originalSpawn;
		vi.clearAllMocks();
		mock.close();
	});

	it("uses the provided executable path", () => {
		PtyBridge.spawn(makeOpts({ executable: "/usr/bin/claude" }));
		expect(mock.getConfig().executable).toBe("/usr/bin/claude");
	});

	it("uses a custom executable path", () => {
		PtyBridge.spawn(makeOpts({ executable: "/custom/path/claude" }));
		expect(mock.getConfig().executable).toBe("/custom/path/claude");
	});

	it("spawns with no extra args when no claudeSessionId", () => {
		PtyBridge.spawn(makeOpts({ cwd: "/home/user/project" }));
		const { args } = mock.getConfig() as { args: string[] };
		expect(args).not.toContain("--cwd");
		expect(args).not.toContain("/home/user/project");
		expect(args).not.toContain("--resume");
	});

	it("spawns with --resume when claudeSessionId is provided", () => {
		PtyBridge.spawn(makeOpts({ claudeSessionId: "abc-123" }));
		const { args } = mock.getConfig() as { args: string[] };
		expect(args).toContain("--resume");
		expect(args).toContain("abc-123");
	});

	it("uses opts.args as-is when provided, ignoring claudeSessionId", () => {
		PtyBridge.spawn(makeOpts({ args: ["-d", "Ubuntu", "--", "bash", "-l"] }));
		const { args } = mock.getConfig() as { args: string[] };
		expect(args).toEqual(["-d", "Ubuntu", "--", "bash", "-l"]);
	});

	it("never includes --cwd in args regardless of claudeSessionId (regression guard)", () => {
		PtyBridge.spawn(
			makeOpts({ cwd: "/home/user/project", claudeSessionId: "abc-123" }),
		);
		const { args } = mock.getConfig() as { args: string[] };
		expect(args).not.toContain("--cwd");
	});

	it("passes cwd field in config (node-pty sets the working dir)", () => {
		PtyBridge.spawn(makeOpts({ cwd: "/home/user/project" }));
		expect(mock.getConfig().cwd).toBe("/home/user/project");
	});

	it("passes correct cols and rows in config", () => {
		PtyBridge.spawn(makeOpts({ cols: 120, rows: 40 }));
		const config = mock.getConfig();
		expect(config.cols).toBe(120);
		expect(config.rows).toBe(40);
	});

	it("strips CLAUDE_CODE_* env vars (prevents nested session detection)", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "test-session";
		process.env.CLAUDECODE = "1";
		PtyBridge.spawn(makeOpts());
		const env = mock.getConfig().env as Record<string, string>;
		expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
		expect(env.CLAUDECODE).toBeUndefined();
		delete process.env.CLAUDE_CODE_SESSION_ID;
		delete process.env.CLAUDECODE;
	});

	it("includes ANTHROPIC_BASE_URL so proxy billing is forwarded", () => {
		process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999";
		PtyBridge.spawn(makeOpts());
		const env = mock.getConfig().env as Record<string, string>;
		expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9999");
		delete process.env.ANTHROPIC_BASE_URL;
	});
});

describe("PtyBridge worker process", () => {
	it("hides the Node worker console window on Windows desktop builds", () => {
		const spawnWorker = vi.fn(() => ({ marker: true }));
		vi.stubGlobal("Bun", { spawn: spawnWorker });
		try {
			_impl.spawnWorker("C:\\app\\pty-worker.cjs", "C:\\app");
			expect(spawnWorker).toHaveBeenCalledWith(
				["node", "C:\\app\\pty-worker.cjs"],
				expect.objectContaining({ windowsHide: true }),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

// ── Stdin frame construction ──────────────────────────────────────────────────

describe("PtyBridge — write / resize / kill frames", () => {
	let mock: WorkerMock;
	let bridge: PtyBridge;
	const originalSpawn = _impl.spawnWorker.bind(_impl);

	beforeEach(() => {
		mock = makeWorkerMock();
		_impl.spawnWorker = () => mock.worker;
		bridge = PtyBridge.spawn(makeOpts());
		// Drop the config JSON write so frame assertions start clean
		mock.stdinWrites.length = 0;
	});

	afterEach(() => {
		_impl.spawnWorker = originalSpawn;
		mock.close();
	});

	it("write() sends type=0x01 frame with correct payload (string)", () => {
		bridge.write("hi");
		const bytes = mock.getStdinBytes();
		expect(bytes[0]).toBe(0x01);
		const len = bytes.readUInt32BE(1);
		expect(len).toBe(2);
		expect(bytes.subarray(5, 5 + len).toString("utf8")).toBe("hi");
	});

	it("write() with Uint8Array encodes payload correctly", () => {
		bridge.write(new TextEncoder().encode("hello"));
		const bytes = mock.getStdinBytes();
		expect(bytes[0]).toBe(0x01);
		const len = bytes.readUInt32BE(1);
		expect(len).toBe(5);
		expect(bytes.subarray(5, 5 + len).toString("utf8")).toBe("hello");
	});

	it("resize() sends type=0x02 frame with cols (BE uint16) and rows (BE uint16)", () => {
		bridge.resize(100, 30);
		const bytes = mock.getStdinBytes();
		expect(bytes[0]).toBe(0x02);
		expect(bytes.readUInt16BE(1)).toBe(100);
		expect(bytes.readUInt16BE(3)).toBe(30);
	});

	it("kill() sends single type=0x03 byte", () => {
		bridge.kill();
		const bytes = mock.getStdinBytes();
		expect(bytes[0]).toBe(0x03);
		expect(bytes.length).toBe(1);
	});
});

// ── Stdout frame parsing / callbacks ─────────────────────────────────────────

describe("PtyBridge — onData / onExit callbacks", () => {
	let mock: WorkerMock;
	const originalSpawn = _impl.spawnWorker.bind(_impl);

	beforeEach(() => {
		mock = makeWorkerMock();
		_impl.spawnWorker = () => mock.worker;
	});

	afterEach(() => {
		_impl.spawnWorker = originalSpawn;
		mock.close();
	});

	it("onData() fires with a Buffer when worker emits a data frame", async () => {
		const bridge = PtyBridge.spawn(makeOpts());
		const cb = vi.fn();
		bridge.onData(cb);

		mock.pushData(Buffer.from("hello terminal"));
		await tick();

		expect(cb).toHaveBeenCalledOnce();
		expect(cb.mock.calls[0][0]).toBeInstanceOf(Buffer);
		expect(cb.mock.calls[0][0].toString("utf8")).toBe("hello terminal");
	});

	it("onExit() fires with the exit code when worker emits an exit frame", async () => {
		const bridge = PtyBridge.spawn(makeOpts());
		const cb = vi.fn();
		bridge.onExit(cb);

		mock.pushExit(42);
		await tick();

		expect(cb).toHaveBeenCalledWith(42);
	});

	it("onExit() fires with code 0 for clean exits", async () => {
		const bridge = PtyBridge.spawn(makeOpts());
		const cb = vi.fn();
		bridge.onExit(cb);

		mock.pushExit(0);
		await tick();

		expect(cb).toHaveBeenCalledWith(0);
	});

	it("onData() handles multiple sequential chunks correctly", async () => {
		const bridge = PtyBridge.spawn(makeOpts());
		const received: string[] = [];
		bridge.onData((d) => received.push(d.toString("utf8")));

		mock.pushData(Buffer.from("chunk1"));
		mock.pushData(Buffer.from("chunk2"));
		await tick();

		expect(received).toContain("chunk1");
		expect(received).toContain("chunk2");
	});

	it("multiple onData subscribers all receive output", async () => {
		const bridge = PtyBridge.spawn(makeOpts());
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		bridge.onData(cb1);
		bridge.onData(cb2);

		mock.pushData(Buffer.from("broadcast"));
		await tick();

		expect(cb1).toHaveBeenCalledOnce();
		expect(cb2).toHaveBeenCalledOnce();
	});
});
