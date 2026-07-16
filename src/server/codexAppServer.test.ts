import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import {
	__resetCodexAppServersForTesting,
	acquireCodexAppServer,
	CodexAppServer,
	listCodexAppServers,
	prewarmCodexAppServer,
	type ThreadHandler,
} from "./codexAppServer";

type FakeProc = InstanceType<typeof EventEmitter> & {
	stdin: { write: ReturnType<typeof vi.fn> };
	stdout: InstanceType<typeof EventEmitter>;
	stderr: InstanceType<typeof EventEmitter>;
	kill: ReturnType<typeof vi.fn>;
};

function makeFakeProc(): { proc: FakeProc; writes: string[] } {
	const stdout = new EventEmitter();
	const proc = new EventEmitter() as FakeProc;
	const writes: string[] = [];
	proc.stdin = {
		write: vi.fn((line: string) => {
			writes.push(line);
			const message = JSON.parse(line) as { id?: number; method?: string };
			if (message.method !== "initialize") return;
			queueMicrotask(() => {
				stdout.emit(
					"data",
					Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`),
				);
			});
		}),
	};
	proc.stdout = stdout;
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn();
	return { proc, writes };
}

function respond(proc: FakeProc, id: number, result: unknown): void {
	proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ id, result })}\n`));
}

function serverRequest(proc: FakeProc, id: number, threadId: string): void {
	proc.stdout.emit(
		"data",
		Buffer.from(
			`${JSON.stringify({
				id,
				method: "item/commandExecution/requestApproval",
				params: { threadId },
			})}\n`,
		),
	);
}

describe("CodexAppServer idle lifecycle", () => {
	const live = new Set<CodexAppServer>();

	beforeEach(() => {
		__resetCodexAppServersForTesting();
		vi.useFakeTimers();
		vi.mocked(spawn).mockReset();
	});

	afterEach(() => {
		__resetCodexAppServersForTesting();
		for (const server of live) {
			if (server.alive) server.kill();
		}
		live.clear();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	async function create(idleTimeoutMs = 50): Promise<{
		server: CodexAppServer;
		proc: FakeProc;
		writes: string[];
	}> {
		const fake = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(fake.proc as never);
		const server = new CodexAppServer("/usr/bin/codex", idleTimeoutMs);
		live.add(server);
		await server.ready;
		return { server, ...fake };
	}

	it("reaps an initialized server after the idle grace period", async () => {
		const { server, proc } = await create();

		await vi.advanceTimersByTimeAsync(49);
		expect(server.alive).toBe(true);
		expect(proc.kill).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(server.alive).toBe(false);
		expect(proc.kill).toHaveBeenCalledOnce();
	});

	it("uses the short grace for metadata-only app servers", async () => {
		const fake = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(fake.proc as never);
		const server = new CodexAppServer("/usr/bin/codex", 50, undefined, 5);
		live.add(server);
		await server.ready;

		await vi.advanceTimersByTimeAsync(5);
		expect(server.alive).toBe(false);
		expect(fake.proc.kill).toHaveBeenCalledOnce();
	});

	it("promotes to the longer grace after a chat thread attaches", async () => {
		const fake = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(fake.proc as never);
		const server = new CodexAppServer("/usr/bin/codex", 50, undefined, 5);
		live.add(server);
		await server.ready;
		const handler: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: vi.fn(),
		};
		server.attachThread("thread-1", handler);
		server.detachThread("thread-1");

		await vi.advanceTimersByTimeAsync(5);
		expect(server.alive).toBe(true);
		await vi.advanceTimersByTimeAsync(45);
		expect(server.alive).toBe(false);
		expect(fake.proc.kill).toHaveBeenCalledOnce();
	});

	it("keeps a prewarmed server alive for the Hlid process lifetime", async () => {
		vi.stubEnv("HLID_CODEX_APP_SERVER_IDLE_MS", "50");
		vi.stubEnv("HLID_CODEX_APP_SERVER_METADATA_IDLE_MS", "5");
		const fake = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(fake.proc as never);

		await expect(prewarmCodexAppServer("/usr/bin/codex")).resolves.toBe(true);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(fake.proc.kill).not.toHaveBeenCalled();
		expect(listCodexAppServers()).toEqual([
			{ executable: "/usr/bin/codex", alive: true, threads: 0 },
		]);
	});

	it("drops repetitive optional PowerShell and MCP capability warnings", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { proc } = await create();

		proc.stderr.emit(
			"data",
			Buffer.from(
				[
					"Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell",
					"Failed to list resources for MCP server 'optional': Mcp error: -32601: Method not found: resources/list",
					"stream disconnected - retrying sampling request",
				].join("\n"),
			),
		);

		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(
			"[codex app-server]",
			"stream disconnected - retrying sampling request",
		);
		warn.mockRestore();
	});

	it("bounds how long startup waits while initialization continues", async () => {
		vi.stubEnv("HLID_CODEX_APP_SERVER_IDLE_MS", "1000");
		const fake = makeFakeProc();
		fake.proc.stdin.write = vi.fn();
		vi.mocked(spawn).mockReturnValue(fake.proc as never);

		const warm = prewarmCodexAppServer("/usr/bin/codex", 25);
		await vi.advanceTimersByTimeAsync(25);

		await expect(warm).resolves.toBe(false);
		const [server] = listCodexAppServers();
		expect(server).toEqual({
			executable: "/usr/bin/codex",
			alive: true,
			threads: 0,
		});
		expect(fake.proc.kill).not.toHaveBeenCalled();

		const initialize = JSON.parse(
			String(vi.mocked(fake.proc.stdin.write).mock.calls[0]?.[0]),
		) as { id: number };
		respond(fake.proc, initialize.id, {});
		await expect(acquireCodexAppServer("/usr/bin/codex").ready).resolves.toBe(
			undefined,
		);
	});

	it("removes an idle server from the registry and respawns on demand", async () => {
		vi.stubEnv("HLID_CODEX_APP_SERVER_IDLE_MS", "50");
		const firstFake = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(firstFake.proc as never);
		const first = acquireCodexAppServer("/usr/bin/codex");
		await first.ready;
		expect(listCodexAppServers()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(50);
		expect(first.alive).toBe(false);
		expect(listCodexAppServers()).toEqual([]);

		const replacementFake = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(replacementFake.proc as never);
		const replacement = acquireCodexAppServer("/usr/bin/codex");
		await replacement.ready;
		expect(replacement).not.toBe(first);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(listCodexAppServers()).toEqual([
			{ executable: "/usr/bin/codex", alive: true, threads: 0 },
		]);
	});

	it("does not deregister a replacement acquired by an exit handler", async () => {
		vi.stubEnv("HLID_CODEX_APP_SERVER_IDLE_MS", "1000");
		const firstFake = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(firstFake.proc as never);
		const first = acquireCodexAppServer("/usr/bin/codex");
		await first.ready;

		const replacementFake = makeFakeProc();
		let replacement: CodexAppServer | undefined;
		first.attachThread("thread-1", {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: () => {
				vi.mocked(spawn).mockReturnValue(replacementFake.proc as never);
				replacement = acquireCodexAppServer("/usr/bin/codex");
			},
		});
		firstFake.proc.emit("exit", 1);
		await replacement?.ready;

		expect(replacement).toBeDefined();
		expect(replacement).not.toBe(first);
		expect(listCodexAppServers()).toEqual([
			{ executable: "/usr/bin/codex", alive: true, threads: 0 },
		]);
	});

	it("does not reap while a client RPC is pending", async () => {
		const { server, proc, writes } = await create();
		const request = server.request("model/list", {}, 1_000);
		const message = JSON.parse(writes.at(-1) ?? "{}") as { id: number };

		await vi.advanceTimersByTimeAsync(100);
		expect(server.alive).toBe(true);
		expect(proc.kill).not.toHaveBeenCalled();

		respond(proc, message.id, { data: [] });
		await expect(request).resolves.toEqual({ data: [] });
		await vi.advanceTimersByTimeAsync(50);
		expect(server.alive).toBe(false);
		expect(proc.kill).toHaveBeenCalledOnce();
	});

	it("cancels stale reap timers when a thread reattaches", async () => {
		const { server, proc } = await create();
		const handler: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: vi.fn(),
		};
		server.attachThread("thread-1", handler);

		await vi.advanceTimersByTimeAsync(100);
		expect(server.alive).toBe(true);
		server.detachThread("thread-1");
		await vi.advanceTimersByTimeAsync(25);
		server.attachThread("thread-1", handler);
		await vi.advanceTimersByTimeAsync(100);
		expect(server.alive).toBe(true);
		expect(proc.kill).not.toHaveBeenCalled();

		server.detachThread("thread-1");
		await vi.advanceTimersByTimeAsync(50);
		expect(server.alive).toBe(false);
		expect(proc.kill).toHaveBeenCalledOnce();
	});

	it("waits for a server-initiated request to settle after detach", async () => {
		const { server, proc } = await create();
		let resolveApproval: ((value: unknown) => void) | undefined;
		const approval = new Promise((resolve) => {
			resolveApproval = resolve;
		});
		const handler: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(() => approval),
			onExit: vi.fn(),
		};
		server.attachThread("thread-1", handler);
		serverRequest(proc, 99, "thread-1");
		await Promise.resolve();
		expect(handler.onRequest).toHaveBeenCalledOnce();

		server.detachThread("thread-1");
		await vi.advanceTimersByTimeAsync(100);
		expect(server.alive).toBe(true);

		resolveApproval?.({ decision: "accept" });
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(50);
		expect(server.alive).toBe(false);
		expect(proc.kill).toHaveBeenCalledOnce();
	});
});
