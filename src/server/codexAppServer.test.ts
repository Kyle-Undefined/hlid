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
	waitForCodexAppServerTerminations,
} from "./codexAppServer";
import {
	getCodexRealtimeBackendStatus,
	markCodexRealtimeBackendAccepted,
} from "./codexRealtimeStatus";

type FakeProc = InstanceType<typeof EventEmitter> & {
	pid?: number;
	stdin: { write: ReturnType<typeof vi.fn> };
	stdout: InstanceType<typeof EventEmitter>;
	stderr: InstanceType<typeof EventEmitter>;
	kill: ReturnType<typeof vi.fn>;
	unref?: ReturnType<typeof vi.fn>;
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

function serverRequest(
	proc: FakeProc,
	id: number,
	threadId: string | undefined,
	method = "item/commandExecution/requestApproval",
	params: Record<string, unknown> = {},
): void {
	proc.stdout.emit(
		"data",
		Buffer.from(
			`${JSON.stringify({
				id,
				method,
				params: { ...(threadId ? { threadId } : {}), ...params },
			})}\n`,
		),
	);
}

function serverNotification(
	proc: FakeProc,
	method: string,
	params: unknown,
): void {
	proc.stdout.emit(
		"data",
		Buffer.from(`${JSON.stringify({ method, params })}\n`),
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
		server.detachThread("thread-1", handler);

		await vi.advanceTimersByTimeAsync(5);
		expect(server.alive).toBe(true);
		await vi.advanceTimersByTimeAsync(45);
		expect(server.alive).toBe(false);
		expect(fake.proc.kill).toHaveBeenCalledOnce();
	});

	it("reaps a prewarmed metadata server when it stays idle", async () => {
		vi.stubEnv("HLID_CODEX_APP_SERVER_IDLE_MS", "50");
		vi.stubEnv("HLID_CODEX_APP_SERVER_METADATA_IDLE_MS", "5");
		const fake = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(fake.proc as never);

		await expect(prewarmCodexAppServer("/usr/bin/codex")).resolves.toBe(true);

		await vi.advanceTimersByTimeAsync(5);
		expect(fake.proc.kill).toHaveBeenCalledOnce();
		expect(listCodexAppServers()).toEqual([]);
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
					"",
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

	it("summarizes tool failures without retaining commands or output", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { proc } = await create();

		proc.stderr.emit(
			"data",
			Buffer.from(
				[
					"2026-07-17T05:17:06Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /home/kyle/private.ts:",
					"const secret = 'do not retain this';",
					"return secret;",
					"",
				].join("\n"),
			),
		);
		await vi.advanceTimersByTimeAsync(100);

		const messages = warn.mock.calls.map((call) => call.join(" "));
		expect(messages).toContain(
			"[codex app-server] tool failure: apply_patch verification failed (details omitted)",
		);
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"[codex app-server] omitted unstructured stderr burst (2 lines,",
				),
			]),
		);
		expect(messages.join("\n")).not.toContain("private.ts");
		expect(messages.join("\n")).not.toContain("do not retain this");
		warn.mockRestore();
	});

	it("explains recoverable model cache failures without exposing paths", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { proc } = await create();

		proc.stderr.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					level: "ERROR",
					target: "codex_models_manager::cache",
					fields: {
						message:
							"failed to load models cache: permission denied at C:\\Users\\private\\models_cache.json",
					},
				})}\n`,
			),
		);

		expect(warn).toHaveBeenCalledWith(
			"[codex app-server]",
			"codex_models_manager::cache: model catalog cache could not be read; Codex will refresh it",
		);
		expect(warn.mock.calls.flat().join(" ")).not.toContain("private");
		warn.mockRestore();
	});

	it("rate-limits remote app catalog failures across app servers", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const first = await create(4_000_000);
		const second = await create(4_000_000);
		const diagnostic = (target: string, message: string) =>
			`${JSON.stringify({
				level: "WARN",
				target,
				fields: { message },
			})}\n`;

		first.proc.stderr.emit(
			"data",
			Buffer.from(
				diagnostic(
					"codex_core_plugins::remote::remote_installed_plugin_sync",
					"remote installed plugin bundle sync failed",
				),
			),
		);
		second.proc.stderr.emit(
			"data",
			Buffer.from(
				diagnostic(
					"codex_core_plugins::manager",
					"failed to refresh remote installed plugins cache",
				),
			),
		);

		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(
			"[codex app-server]",
			"Codex app catalog refresh is degraded; provider sessions remain available",
		);

		await vi.advanceTimersByTimeAsync(60 * 60_000);
		second.proc.stderr.emit(
			"data",
			Buffer.from(
				diagnostic(
					"codex_core_plugins::remote::remote_installed_plugin_sync",
					"remote installed plugin bundle sync failed",
				),
			),
		);
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it("buffers stderr lines split across process chunks", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { proc } = await create();

		proc.stderr.emit("data", Buffer.from("stream discon"));
		proc.stderr.emit(
			"data",
			Buffer.from("nected - retrying sampling request\n"),
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

	it("normalizes encoded WSL service output into actionable startup recovery", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const wslFailure = makeFakeProc();
		wslFailure.proc.stdin.write = vi.fn();
		vi.mocked(spawn).mockReturnValue(wslFailure.proc as never);
		const failedServer = new CodexAppServer("C:\\Hlid\\codex-wrapper.cmd");
		live.add(failedServer);
		const failedReady = failedServer.ready.catch((error: unknown) => error);

		wslFailure.proc.stdout.emit(
			"data",
			Buffer.from(
				`\0${[..."Error code: Wsl/Service/E_UNEXPECTED"].join("\0")}\0\r\0\n\0`,
			),
		);
		wslFailure.proc.emit("exit", 255);
		const classified = await failedReady;

		expect(classified).toEqual(
			expect.objectContaining({
				name: "CodexWslStartupError",
				message: expect.stringContaining(
					"Save any work running in WSL, restart WSL, then try again",
				),
			}),
		);
		expect((classified as Error).name).toBe("CodexWslStartupError");
		expect((classified as Error).cause).toEqual(
			expect.objectContaining({
				message: "Codex app-server exited (code 255)",
				exitCode: 255,
			}),
		);

		const genericFailure = makeFakeProc();
		genericFailure.proc.stdin.write = vi.fn();
		vi.mocked(spawn).mockReturnValue(genericFailure.proc as never);
		const genericServer = new CodexAppServer("C:\\Hlid\\codex-wrapper.cmd");
		live.add(genericServer);
		const genericReady = genericServer.ready.catch((error: unknown) => error);
		genericFailure.proc.stdout.emit(
			"data",
			Buffer.from("Catastrophic failure\n"),
		);
		genericFailure.proc.emit("exit", 255);
		expect(((await genericReady) as Error).name).not.toBe(
			"CodexWslStartupError",
		);
		warn.mockRestore();
	});

	it("uses WSL recovery guidance when initialize hangs after an encoded service failure", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fake = makeFakeProc();
		fake.proc.stdin.write = vi.fn();
		vi.mocked(spawn).mockReturnValue(fake.proc as never);
		const server = new CodexAppServer("C:\\Hlid\\codex-wrapper.cmd");
		live.add(server);
		const ready = server.ready.catch((error: unknown) => error);
		fake.proc.stdout.emit(
			"data",
			Buffer.from(
				`\0${[..."Error code: Wsl/Service/E_UNEXPECTED"].join("\0")}\0\r\0\n\0`,
			),
		);

		await vi.advanceTimersByTimeAsync(15_000);
		const failure = await ready;
		expect((failure as Error).name).toBe("CodexWslStartupError");
		expect(failure).toEqual(
			expect.objectContaining({
				message: expect.stringContaining("Your Raven chat is still intact"),
			}),
		);
		expect(fake.proc.kill).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it("targets the exact Windows wrapper tree for termination", async () => {
		const app = makeFakeProc();
		app.proc.pid = 321;
		const terminator = makeFakeProc();
		terminator.proc.unref = vi.fn();
		vi.mocked(spawn)
			.mockReturnValueOnce(app.proc as never)
			.mockReturnValueOnce(terminator.proc as never);
		const server = new CodexAppServer(
			"C:\\Hlid\\codex-wrapper.cmd",
			50,
			undefined,
			5,
			"win32",
		);
		live.add(server);
		await server.ready;

		server.kill();
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			"taskkill.exe",
			["/PID", "321", "/T", "/F"],
			expect.objectContaining({ stdio: "ignore", windowsHide: true }),
		);
		expect(app.proc.kill).not.toHaveBeenCalled();
		server.kill();
		expect(spawn).toHaveBeenCalledTimes(2);

		terminator.proc.emit("exit", 0);
		await waitForCodexAppServerTerminations();
		expect(app.proc.kill).not.toHaveBeenCalled();
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

	it("isolates provider profiles that share the same Codex executable", async () => {
		vi.stubEnv("HLID_CODEX_APP_SERVER_IDLE_MS", "1000");
		const nativeFake = makeFakeProc();
		const routedFake = makeFakeProc();
		vi.mocked(spawn)
			.mockReturnValueOnce(nativeFake.proc as never)
			.mockReturnValueOnce(routedFake.proc as never);

		const native = acquireCodexAppServer("/usr/bin/codex");
		const routed = acquireCodexAppServer({
			executable: "/usr/bin/codex",
			registryKey: "cliproxy:http://127.0.0.1:8317",
			args: ["-c", 'model_provider="hlid_cliproxy"'],
			env: { HLID_CLIPROXY_API_KEY: "secret" },
		});
		await Promise.all([native.ready, routed.ready]);

		expect(routed).not.toBe(native);
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			"/usr/bin/codex",
			[
				"-c",
				'model_provider="hlid_cliproxy"',
				"app-server",
				"--listen",
				"stdio://",
			],
			expect.objectContaining({
				env: expect.objectContaining({ HLID_CLIPROXY_API_KEY: "secret" }),
			}),
		);
		expect(listCodexAppServers()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ executable: "/usr/bin/codex" }),
				expect.objectContaining({
					executable: "/usr/bin/codex",
					profile: "cliproxy:http://127.0.0.1:8317",
				}),
			]),
		);
	});

	it("does not reuse an unflagged prewarm for realtime conversation", async () => {
		vi.stubEnv("HLID_CODEX_APP_SERVER_IDLE_MS", "1000");
		const unflaggedFake = makeFakeProc();
		const realtimeFake = makeFakeProc();
		vi.mocked(spawn)
			.mockReturnValueOnce(unflaggedFake.proc as never)
			.mockReturnValueOnce(realtimeFake.proc as never);

		await expect(prewarmCodexAppServer("/usr/bin/codex")).resolves.toBe(true);
		const unflagged = acquireCodexAppServer("/usr/bin/codex");
		const realtime = acquireCodexAppServer({
			executable: "/usr/bin/codex",
			args: ["--enable", "realtime_conversation"],
		});
		await realtime.ready;

		expect(realtime).not.toBe(unflagged);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			"/usr/bin/codex",
			[
				"--enable",
				"realtime_conversation",
				"app-server",
				"--listen",
				"stdio://",
			],
			expect.any(Object),
		);
		expect(listCodexAppServers()).toHaveLength(2);
	});

	it("clears observed realtime backend readiness when app servers restart", () => {
		markCodexRealtimeBackendAccepted(123);
		expect(getCodexRealtimeBackendStatus()).toEqual({
			available: true,
			observedAt: 123,
		});

		__resetCodexAppServersForTesting();

		expect(getCodexRealtimeBackendStatus()).toEqual({});
	});

	it("reuses an alive server for equivalent launch configurations", async () => {
		vi.stubEnv("HLID_CODEX_APP_SERVER_IDLE_MS", "1000");
		const fake = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(fake.proc as never);

		await expect(
			prewarmCodexAppServer({
				executable: "/usr/bin/codex",
				registryKey: "cliproxy:profile-fingerprint",
				args: ["--enable", "realtime_conversation"],
				env: { HLID_CLIPROXY_API_KEY: "secret" },
			}),
		).resolves.toBe(true);
		const first = acquireCodexAppServer({
			executable: "/usr/bin/codex",
			registryKey: "cliproxy:profile-fingerprint",
			args: ["--enable", "realtime_conversation"],
			env: { HLID_CLIPROXY_API_KEY: "secret" },
		});
		const second = acquireCodexAppServer({
			executable: "/usr/bin/codex",
			registryKey: "cliproxy:profile-fingerprint",
			args: ["--enable", "realtime_conversation"],
			env: { HLID_CLIPROXY_API_KEY: "secret" },
		});
		await first.ready;

		expect(second).toBe(first);
		expect(spawn).toHaveBeenCalledOnce();
		expect(listCodexAppServers()).toHaveLength(1);
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

	it("keeps chat threads alive when optional metadata times out", async () => {
		const { server, proc } = await create();
		const handler: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: vi.fn(),
		};
		server.attachThread("thread-1", handler);

		const request = server
			.requestOptional("mcpServerStatus/list", {}, 20)
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(20);

		expect(await request).toEqual(
			expect.objectContaining({
				message: expect.stringMatching(/mcpServerStatus\/list timed out/i),
			}),
		);
		expect(server.alive).toBe(true);
		expect(proc.kill).not.toHaveBeenCalled();
		expect(handler.onExit).not.toHaveBeenCalled();
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
		server.detachThread("thread-1", handler);
		await vi.advanceTimersByTimeAsync(25);
		server.attachThread("thread-1", handler);
		await vi.advanceTimersByTimeAsync(100);
		expect(server.alive).toBe(true);
		expect(proc.kill).not.toHaveBeenCalled();

		server.detachThread("thread-1", handler);
		await vi.advanceTimersByTimeAsync(50);
		expect(server.alive).toBe(false);
		expect(proc.kill).toHaveBeenCalledOnce();
	});

	it("does not let a stale owner detach a replacement handler", async () => {
		const { server, proc } = await create();
		const staleOwner: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: vi.fn(),
		};
		const replacementOwner: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: vi.fn(),
		};
		server.attachThread("thread-1", staleOwner);
		server.attachThread("thread-1", replacementOwner);

		server.detachThread("thread-1", staleOwner);
		expect(server.threadCount).toBe(1);
		serverNotification(proc, "thread/status/updated", {
			threadId: "thread-1",
		});
		expect(staleOwner.onNotification).not.toHaveBeenCalled();
		expect(replacementOwner.onNotification).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(50);
		expect(server.alive).toBe(true);

		server.detachThread("thread-1", replacementOwner);
		await vi.advanceTimersByTimeAsync(50);
		expect(server.alive).toBe(false);
	});

	it("fans out threadless notifications once per owning handler", async () => {
		const { server, proc } = await create();
		const primaryOwner: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: vi.fn(),
		};
		const secondaryOwner: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: vi.fn(),
		};
		server.attachThread("parent-thread", primaryOwner);
		for (let index = 0; index < 25; index++) {
			server.attachThread(`child-thread-${index}`, primaryOwner);
		}
		server.attachThread("other-owner-thread", secondaryOwner);

		const params = { rateLimits: { primary: { usedPercent: 34 } } };
		serverNotification(proc, "account/rateLimits/updated", params);

		expect(primaryOwner.onNotification).toHaveBeenCalledOnce();
		expect(primaryOwner.onNotification).toHaveBeenCalledWith(
			"account/rateLimits/updated",
			params,
		);
		expect(secondaryOwner.onNotification).toHaveBeenCalledOnce();
		expect(secondaryOwner.onNotification).toHaveBeenCalledWith(
			"account/rateLimits/updated",
			params,
		);
	});

	it("notifies each owning handler once when the app-server exits", async () => {
		const { server } = await create();
		const primaryOwner: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: vi.fn(),
		};
		const secondaryOwner: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: vi.fn(),
		};
		server.attachThread("parent-thread", primaryOwner);
		for (let index = 0; index < 25; index++) {
			server.attachThread(`child-thread-${index}`, primaryOwner);
		}
		server.attachThread("other-owner-thread", secondaryOwner);

		const error = new Error("transport closed");
		server.kill(error);

		expect(primaryOwner.onExit).toHaveBeenCalledOnce();
		expect(primaryOwner.onExit).toHaveBeenCalledWith(error);
		expect(secondaryOwner.onExit).toHaveBeenCalledOnce();
		expect(secondaryOwner.onExit).toHaveBeenCalledWith(error);
	});

	it("coalesces concurrent account rate-limit reads", async () => {
		const { server, proc, writes } = await create();

		const first = server.readAccountRateLimits();
		const second = server.readAccountRateLimits();
		expect(second).toBe(first);
		const requests = writes
			.map((line) => JSON.parse(line) as { id?: number; method?: string })
			.filter((message) => message.method === "account/rateLimits/read");
		expect(requests).toHaveLength(1);

		respond(proc, requests[0]?.id ?? 0, {
			rateLimits: { primary: { usedPercent: 27 } },
		});
		await expect(first).resolves.toEqual({
			status: "current",
			snapshot: { primary: { usedPercent: 27 } },
		});
		await expect(second).resolves.toEqual({
			status: "current",
			snapshot: { primary: { usedPercent: 27 } },
		});
	});

	it("keeps chat threads alive when an account rate-limit read times out", async () => {
		const { server, proc, writes } = await create();
		const handler: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: vi.fn(),
		};
		server.attachThread("thread-1", handler);

		const read = server
			.readAccountRateLimits()
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(15_000);

		expect(await read).toEqual(
			expect.objectContaining({
				message: expect.stringMatching(/account\/rateLimits\/read timed out/i),
			}),
		);
		expect(server.alive).toBe(true);
		expect(proc.kill).not.toHaveBeenCalled();
		expect(handler.onExit).not.toHaveBeenCalled();

		const retry = server.readAccountRateLimits();
		const retryRequest = writes
			.map((line) => JSON.parse(line) as { id?: number; method?: string })
			.filter((message) => message.method === "account/rateLimits/read")
			.at(-1);
		respond(proc, retryRequest?.id ?? 0, {
			rateLimits: { primary: { usedPercent: 27 } },
		});
		await expect(retry).resolves.toEqual({
			status: "current",
			snapshot: { primary: { usedPercent: 27 } },
		});
	});

	it("rejects an older read after a native rate-limit update", async () => {
		const { server, proc, writes } = await create();

		const read = server.readAccountRateLimits();
		const request = writes
			.map((line) => JSON.parse(line) as { id?: number; method?: string })
			.filter((message) => message.method === "account/rateLimits/read")
			.at(-1);
		serverNotification(proc, "account/rateLimits/updated", {
			rateLimits: { primary: { usedPercent: 34 } },
		});
		respond(proc, request?.id ?? 0, {
			rateLimits: { primary: { usedPercent: 27 } },
		});

		await expect(read).resolves.toEqual({ status: "superseded" });
	});

	it("accepts a lower read started after a native rate-limit update", async () => {
		const { server, proc, writes } = await create();
		serverNotification(proc, "account/rateLimits/updated", {
			rateLimits: { primary: { usedPercent: 34 } },
		});

		const read = server.readAccountRateLimits();
		const request = writes
			.map((line) => JSON.parse(line) as { id?: number; method?: string })
			.filter((message) => message.method === "account/rateLimits/read")
			.at(-1);
		respond(proc, request?.id ?? 0, {
			rateLimits: { primary: { usedPercent: 27 } },
		});

		await expect(read).resolves.toEqual({
			status: "current",
			snapshot: { primary: { usedPercent: 27 } },
		});
	});

	it("does not coalesce a post-update read onto an older request", async () => {
		const { server, proc, writes } = await create();
		const older = server.readAccountRateLimits();
		const olderRequest = writes
			.map((line) => JSON.parse(line) as { id?: number; method?: string })
			.filter((message) => message.method === "account/rateLimits/read")
			.at(-1);

		serverNotification(proc, "account/rateLimits/updated", {
			rateLimits: { primary: { usedPercent: 34 } },
		});
		const newer = server.readAccountRateLimits();
		const requests = writes
			.map((line) => JSON.parse(line) as { id?: number; method?: string })
			.filter((message) => message.method === "account/rateLimits/read");
		expect(requests).toHaveLength(2);
		const newerRequest = requests.at(-1);

		respond(proc, olderRequest?.id ?? 0, {
			rateLimits: { primary: { usedPercent: 27 } },
		});
		await expect(older).resolves.toEqual({ status: "superseded" });
		const coalesced = server.readAccountRateLimits();
		expect(coalesced).toBe(newer);
		expect(
			writes
				.map((line) => JSON.parse(line) as { method?: string })
				.filter((message) => message.method === "account/rateLimits/read"),
		).toHaveLength(2);

		respond(proc, newerRequest?.id ?? 0, {
			rateLimits: { primary: { usedPercent: 27 } },
		});
		const current = {
			status: "current",
			snapshot: { primary: { usedPercent: 27 } },
		};
		await expect(newer).resolves.toEqual(current);
		await expect(coalesced).resolves.toEqual(current);
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

		server.detachThread("thread-1", handler);
		await vi.advanceTimersByTimeAsync(100);
		expect(server.alive).toBe(true);

		resolveApproval?.({ decision: "accept" });
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(50);
		expect(server.alive).toBe(false);
		expect(proc.kill).toHaveBeenCalledOnce();
	});

	it("answers currentTime/read centrally with whole Unix seconds", async () => {
		vi.setSystemTime(new Date("2026-08-09T12:34:56.789Z"));
		const { server, proc, writes } = await create();
		const handler: ThreadHandler = {
			onNotification: vi.fn(),
			onRequest: vi.fn(async () => ({})),
			onExit: vi.fn(),
		};
		server.attachThread("thread-1", handler);

		serverRequest(proc, 98, undefined, "currentTime/read");

		expect(handler.onRequest).not.toHaveBeenCalled();
		expect(
			writes
				.map((line) => JSON.parse(line) as { id?: number; result?: unknown })
				.find((message) => message.id === 98),
		).toEqual({
			id: 98,
			result: { currentTimeAt: 1_786_278_896 },
		});
	});

	it("aborts a resolved native request and suppresses its late reply", async () => {
		const { server, proc, writes } = await create();
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
		const context = vi.mocked(handler.onRequest).mock.calls[0]?.[2];
		expect(context).toMatchObject({ requestId: 99 });
		expect(context?.signal.aborted).toBe(false);

		serverNotification(proc, "serverRequest/resolved", {
			threadId: "thread-1",
			requestId: 99,
		});
		expect(context?.signal.aborted).toBe(true);

		resolveApproval?.({ decision: "accept" });
		await Promise.resolve();
		await Promise.resolve();

		expect(
			writes
				.map((line) => JSON.parse(line) as { id?: number })
				.filter((message) => message.id === 99),
		).toEqual([]);
	});

	it("drops a server-request response that settles after the transport dies", async () => {
		const { server, proc, writes } = await create();
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

		server.kill(new Error("thread closed"));
		resolveApproval?.({ decision: "accept" });
		await Promise.resolve();
		await Promise.resolve();

		expect(
			writes
				.map((line) => JSON.parse(line) as { id?: number })
				.filter((message) => message.id === 99),
		).toEqual([]);
		expect(proc.kill).toHaveBeenCalledOnce();
	});
});
