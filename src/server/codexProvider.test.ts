import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../lib/codexPath", () => ({ resolveCodexExecutable: vi.fn() }));

import { spawn } from "node:child_process";
import { resolveCodexExecutable } from "../lib/codexPath";
import type {
	AgentEvent,
	AgentQueryParams,
	AgentSession,
} from "./agentProvider";
import {
	__resetCodexAppServersForTesting,
	acquireCodexAppServer,
} from "./codexAppServer";
import type { SandboxPolicy } from "./codexProtocol";
import {
	CodexProvider,
	codexChildStep,
	codexLaunchConfig,
	codexReasoningText,
	codexSandboxPolicy,
	codexSubagentStatus,
	fetchCodexModels,
	mapCodexModels,
	sandboxMode,
} from "./codexProvider";

// ── fetchCodexModels test helpers ──────────────────────────────────────────

/** Live-verified codex-cli 0.142.4 `model/list` RPC response shape. */
const MODEL_LIST_FIXTURE = {
	data: [
		{
			id: "gpt-5.5",
			model: "gpt-5.5",
			displayName: "GPT-5.5",
			description:
				"Frontier model for complex coding, research, and real-world work.",
			hidden: false,
			supportedReasoningEfforts: [
				{
					reasoningEffort: "low",
					description: "Fast responses with lighter reasoning",
				},
				{
					reasoningEffort: "medium",
					description: "Balances speed and reasoning depth for everyday tasks",
				},
				{
					reasoningEffort: "high",
					description: "Greater reasoning depth for complex problems",
				},
				{
					reasoningEffort: "xhigh",
					description: "Extra high reasoning depth for complex problems",
				},
			],
			defaultReasoningEffort: "medium",
		},
	],
};

type FakeProc = InstanceType<typeof EventEmitter> & {
	stdin: { write: ReturnType<typeof vi.fn> };
	stdout: InstanceType<typeof EventEmitter>;
	stderr: InstanceType<typeof EventEmitter>;
	kill: ReturnType<typeof vi.fn>;
};

/**
 * Fake app-server process. `write` synchronously schedules a microtask that
 * replies on stdout for "initialize" and "model/list" requests, driving the
 * handshake without needing to poll — `modelListResult` is what the
 * model/list RPC resolves with (defaults to the live-verified fixture).
 * Pass `silent: true` to never respond (for timeout tests).
 */
function makeFakeProc(
	opts: { modelListResult?: unknown; silent?: boolean } = {},
): { proc: FakeProc; writes: string[] } {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const proc = new EventEmitter() as FakeProc;
	const writes: string[] = [];
	proc.stdin = {
		write: vi.fn((data: string) => {
			writes.push(data);
			if (opts.silent) return;
			const msg = JSON.parse(data) as { id?: number; method?: string };
			queueMicrotask(() => {
				if (msg.method === "initialize") {
					stdout.emit(
						"data",
						Buffer.from(`${JSON.stringify({ id: msg.id, result: {} })}\n`),
					);
				} else if (msg.method === "model/list") {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: opts.modelListResult ?? MODEL_LIST_FIXTURE,
							})}\n`,
						),
					);
				}
			});
		}),
	};
	proc.stdout = stdout;
	proc.stderr = stderr;
	proc.kill = vi.fn();
	return { proc, writes };
}

function writeMethods(writes: string[]): (string | undefined)[] {
	return writes.map((w) => (JSON.parse(w) as { method?: string }).method);
}

describe("codexReasoningText", () => {
	it("extracts text from reasoning summary arrays", () => {
		expect(
			codexReasoningText({
				type: "reasoning",
				summary: [{ type: "summary_text", text: "Checked the config." }],
			}),
		).toBe("Checked the config.");
	});

	it("falls back across common Codex reasoning fields", () => {
		expect(codexReasoningText({ reasoning: { text: "Planning edits." } })).toBe(
			"Planning edits.",
		);
		expect(codexReasoningText({ content: "Reviewing output." })).toBe(
			"Reviewing output.",
		);
	});

	it("returns empty text when Codex does not expose reasoning", () => {
		expect(codexReasoningText({ encrypted_content: "opaque" })).toBe("");
	});
});

describe("CodexProvider capability declarations", () => {
	it("exposes codex model options for UI selectors", () => {
		const p = new CodexProvider();
		const models = p.models ?? [];
		expect(models.length).toBeGreaterThan(0);
		expect(models.map((m) => m.value)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"gpt-5.5",
			"gpt-5.4",
		]);
		for (const m of models) {
			expect(typeof m.value).toBe("string");
			expect(typeof m.label).toBe("string");
		}
	});
});

describe("codexLaunchConfig", () => {
	it("uses the provided executable and passes the cwd through as rpcCwd", () => {
		const cfg = codexLaunchConfig({
			cwd: "/home/kyle/development/repos/hlid",
			executable: "/home/kyle/.bun/bin/codex",
		});

		expect(cfg).toEqual({
			executable: "/home/kyle/.bun/bin/codex",
			rpcCwd: "/home/kyle/development/repos/hlid",
		});
	});

	it("translates a WSL UNC cwd to the POSIX rpcCwd", () => {
		const cfg = codexLaunchConfig({
			cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\x",
			executable: "/home/kyle/.bun/bin/codex",
		});

		// parseWslUnc/toLogical only rewrite WSL UNC paths on win32 — on
		// Linux/macOS CI this cwd passes through unchanged.
		// Match the guarding style used in src/lib/paths.test.ts.
		if (process.platform === "win32") {
			expect(cfg.rpcCwd).toBe("/home/kyle/x");
		} else {
			expect(cfg.rpcCwd).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\x");
		}
	});

	it("keeps a plain Windows or POSIX cwd unchanged", () => {
		const cfg = codexLaunchConfig({
			cwd: "C:\\Users\\kyle\\project",
			executable: "codex.exe",
		});
		expect(cfg.rpcCwd).toBe("C:\\Users\\kyle\\project");

		const posixCfg = codexLaunchConfig({
			cwd: "/home/kyle/project",
			executable: "/home/kyle/.bun/bin/codex",
		});
		expect(posixCfg.rpcCwd).toBe("/home/kyle/project");
	});
});

describe("sandboxMode", () => {
	it("maps bypassPermissions to danger-full-access", () => {
		expect(sandboxMode("bypassPermissions")).toBe("danger-full-access");
	});

	it("maps plan to read-only", () => {
		expect(sandboxMode("plan")).toBe("read-only");
	});

	it("maps default and acceptEdits to workspace-write", () => {
		expect(sandboxMode("default")).toBe("workspace-write");
		expect(sandboxMode("acceptEdits")).toBe("workspace-write");
	});

	it("maps undefined to workspace-write", () => {
		expect(sandboxMode(undefined)).toBe("workspace-write");
	});
});

describe("codexSandboxPolicy", () => {
	it("maps bypassPermissions to dangerFullAccess", () => {
		expect(codexSandboxPolicy("bypassPermissions", ["/extra"])).toEqual({
			type: "dangerFullAccess",
		});
	});

	it("maps plan to readOnly with network disabled", () => {
		expect(codexSandboxPolicy("plan", ["/extra"])).toEqual({
			type: "readOnly",
			networkAccess: false,
		});
	});

	it("makes only the HTML plan directory an explicit writable root", () => {
		expect(
			codexSandboxPolicy(
				"plan",
				["/unrelated"],
				"/vault/.hlid/plans/plan-session.html",
			),
		).toEqual({
			type: "workspaceWrite",
			writableRoots: ["/vault/.hlid/plans"],
			networkAccess: false,
			excludeTmpdirEnvVar: true,
			excludeSlashTmp: true,
		});
	});

	it("maps default/acceptEdits to workspaceWrite, passing through writableRoots", () => {
		expect(codexSandboxPolicy("default", ["/vault", "/agent"])).toEqual({
			type: "workspaceWrite",
			writableRoots: ["/vault", "/agent"],
			networkAccess: false,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		});
		expect(codexSandboxPolicy("acceptEdits", [])).toEqual({
			type: "workspaceWrite",
			writableRoots: [],
			networkAccess: false,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		});
	});

	it("returns values assignable to the vendored codex-cli SandboxPolicy type", () => {
		// Compile-time check: if codex-cli's generated SandboxPolicy shape ever
		// drifts (see src/server/codexProtocol/v2/SandboxPolicy.ts), `satisfies`
		// below fails to typecheck rather than silently going stale.
		expect(
			codexSandboxPolicy("bypassPermissions", []) satisfies SandboxPolicy,
		).toEqual({ type: "dangerFullAccess" });
		expect(codexSandboxPolicy("plan", []) satisfies SandboxPolicy).toEqual({
			type: "readOnly",
			networkAccess: false,
		});
		expect(
			codexSandboxPolicy("default", ["/vault"]) satisfies SandboxPolicy,
		).toEqual({
			type: "workspaceWrite",
			writableRoots: ["/vault"],
			networkAccess: false,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		});
	});
});

describe("mapCodexModels", () => {
	it("maps the live-verified fixture: label, description, efforts with isDefault on medium", () => {
		const models = mapCodexModels(MODEL_LIST_FIXTURE);
		expect(models).toEqual([
			{
				value: "gpt-5.5",
				label: "GPT-5.5",
				description:
					"Frontier model for complex coding, research, and real-world work.",
				isDefault: undefined,
				hidden: undefined,
				efforts: [
					{
						value: "low",
						label: "Low",
						desc: "Fast responses with lighter reasoning",
						isDefault: false,
					},
					{
						value: "medium",
						label: "Medium",
						desc: "Balances speed and reasoning depth for everyday tasks",
						isDefault: true,
					},
					{
						value: "high",
						label: "High",
						desc: "Greater reasoning depth for complex problems",
						isDefault: false,
					},
					{
						value: "xhigh",
						label: "Xhigh",
						desc: "Extra high reasoning depth for complex problems",
						isDefault: false,
					},
				],
			},
		]);
	});

	it("preserves the hidden flag on entries (filtering happens in fetchCodexModels, not here)", () => {
		const models = mapCodexModels({
			data: [{ id: "secret-model", model: "secret-model", hidden: true }],
		});
		expect(models).toEqual([
			{
				value: "secret-model",
				label: "secret-model",
				description: undefined,
				isDefault: undefined,
				hidden: true,
				efforts: undefined,
			},
		]);
	});

	it("skips entries with no model/id string", () => {
		const models = mapCodexModels({
			data: [{ displayName: "No id here" }, { id: 42 }, { model: null }],
		});
		expect(models).toEqual([]);
	});

	it("tolerates missing supportedReasoningEfforts", () => {
		const models = mapCodexModels({
			data: [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4" }],
		});
		expect(models).toEqual([
			{
				value: "gpt-5.4",
				label: "GPT-5.4",
				description: undefined,
				isDefault: undefined,
				hidden: undefined,
				efforts: undefined,
			},
		]);
	});

	it("returns [] for garbage input", () => {
		expect(mapCodexModels(null)).toEqual([]);
		expect(mapCodexModels(undefined)).toEqual([]);
		expect(mapCodexModels("garbage")).toEqual([]);
		expect(mapCodexModels(42)).toEqual([]);
		expect(mapCodexModels({})).toEqual([]);
		expect(mapCodexModels({ data: "not an array" })).toEqual([]);
	});
});

describe("fetchCodexModels", () => {
	// The app-server connection registry is module-level state shared across
	// sessions by design — reset it so each test's fake proc is the one the
	// lazily-acquired connection binds to.
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("performs initialize -> initialized -> model/list handshake and maps the result", async () => {
		const { proc, writes } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const models = await fetchCodexModels();

		expect(writeMethods(writes)).toEqual([
			"initialize",
			"initialized",
			"model/list",
		]);
		expect(models).toEqual(mapCodexModels(MODEL_LIST_FIXTURE));
		// The shared app-server stays alive for reuse — never killed per call.
		expect(proc.kill).not.toHaveBeenCalled();
	});

	it("leaves Codex hooks enabled for the catalog-only app server", async () => {
		const { proc } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		await fetchCodexModels();

		expect(spawn).toHaveBeenCalledWith(
			"/usr/bin/codex",
			["app-server", "--listen", "stdio://"],
			expect.any(Object),
		);
	});

	it("passes includeHidden through to the model/list RPC params", async () => {
		const { proc, writes } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		await fetchCodexModels({ includeHidden: true });

		const modelListWrite = writes.find(
			(w) => (JSON.parse(w) as { method?: string }).method === "model/list",
		);
		expect(
			(
				JSON.parse(modelListWrite ?? "{}") as {
					params?: { includeHidden?: boolean };
				}
			).params?.includeHidden,
		).toBe(true);
	});

	it("defaults includeHidden to false in the model/list RPC params", async () => {
		const { proc, writes } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		await fetchCodexModels();

		const modelListWrite = writes.find(
			(w) => (JSON.parse(w) as { method?: string }).method === "model/list",
		);
		expect(
			(
				JSON.parse(modelListWrite ?? "{}") as {
					params?: { includeHidden?: boolean };
				}
			).params?.includeHidden,
		).toBe(false);
	});

	it("filters out hidden:true entries by default", async () => {
		const { proc } = makeFakeProc({
			modelListResult: {
				data: [
					{ id: "visible", model: "visible", hidden: false },
					{ id: "secret", model: "secret", hidden: true },
				],
			},
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const models = await fetchCodexModels();
		expect(models.map((m) => m.value)).toEqual(["visible"]);
	});

	it("keeps hidden entries when includeHidden is true", async () => {
		const { proc } = makeFakeProc({
			modelListResult: {
				data: [
					{ id: "visible", model: "visible", hidden: false },
					{ id: "secret", model: "secret", hidden: true },
				],
			},
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const models = await fetchCodexModels({ includeHidden: true });
		expect(models.map((m) => m.value).sort()).toEqual(["secret", "visible"]);
	});

	it("kills an unresponsive shared app-server so the next call can respawn", async () => {
		const spawnCount = vi.mocked(spawn).mock.calls.length;
		const { proc } = makeFakeProc({ silent: true });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		await expect(fetchCodexModels({ timeoutMs: 20 })).rejects.toThrow(
			/timed out/i,
		);
		expect(proc.kill).toHaveBeenCalledOnce();

		const replacement = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(replacement.proc as never);
		await expect(fetchCodexModels()).resolves.toEqual(
			mapCodexModels(MODEL_LIST_FIXTURE),
		);
		expect(spawn).toHaveBeenCalledTimes(spawnCount + 2);
	});

	it("rejects when the process emits an error event", async () => {
		const { proc } = makeFakeProc({ silent: true });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const promise = fetchCodexModels({ timeoutMs: 5000 });
		proc.emit("error", new Error("spawn failed"));
		await expect(promise).rejects.toThrow("spawn failed");
	});

	it("rejects when the process exits unexpectedly", async () => {
		const { proc } = makeFakeProc({ silent: true });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const promise = fetchCodexModels({ timeoutMs: 5000 });
		proc.emit("exit", 1);
		await expect(promise).rejects.toThrow(/exited/i);
	});
});

describe("Codex app-server request recovery", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("evicts an alive process that stops answering a session RPC", async () => {
		const { proc } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		const conn = acquireCodexAppServer("/usr/bin/codex");
		await conn.ready;

		await expect(conn.request("thread/start", {}, 20)).rejects.toThrow(
			/thread\/start timed out/i,
		);
		expect(conn.alive).toBe(false);
		expect(proc.kill).toHaveBeenCalledOnce();

		const replacement = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(replacement.proc as never);
		const next = acquireCodexAppServer("/usr/bin/codex");
		expect(next).not.toBe(conn);
		await expect(next.ready).resolves.toBeUndefined();
	});
});

describe("CodexProvider.listModels", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("delegates to fetchCodexModels", async () => {
		const { proc } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const provider = new CodexProvider();
		const models = await provider.listModels?.();
		expect(models).toEqual(mapCodexModels(MODEL_LIST_FIXTURE));
	});
});

// ── CodexAgentSession mid-session model/permission switching ──────────────────

/**
 * Fake app-server process that drives a full initialize → thread/start →
 * turn/start handshake (unlike makeFakeProc above, which only answers
 * initialize/model-list for the one-off fetchCodexModels probe). Every
 * `turn/start` call gets a fresh turn id so CodexAgentSession.send() can be
 * called repeatedly.
 */
function makeFakeSessionProc(
	opts: {
		rateLimits?: unknown;
		/** Result for `mcpServerStatus/list`; ignored when `mcpStatusError` set. */
		mcpStatusResult?: unknown;
		/** Reply to `mcpServerStatus/list` with a JSON-RPC error. */
		mcpStatusError?: boolean;
	} = {},
): {
	proc: FakeProc;
	writes: string[];
} {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const proc = new EventEmitter() as FakeProc;
	const writes: string[] = [];
	let turnCounter = 0;
	proc.stdin = {
		write: vi.fn((data: string) => {
			writes.push(data);
			const msg = JSON.parse(data) as { id?: number; method?: string };
			queueMicrotask(() => {
				if (msg.method === "initialize") {
					stdout.emit(
						"data",
						Buffer.from(`${JSON.stringify({ id: msg.id, result: {} })}\n`),
					);
				} else if (
					msg.method === "thread/start" ||
					msg.method === "thread/resume"
				) {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: { thread: { id: "thread-1" } },
							})}\n`,
						),
					);
				} else if (msg.method === "turn/start") {
					turnCounter++;
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: { turn: { id: `turn-${turnCounter}` } },
							})}\n`,
						),
					);
				} else if (msg.method === "mcpServerStatus/list") {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify(
								opts.mcpStatusError
									? { id: msg.id, error: { message: "unsupported" } }
									: { id: msg.id, result: opts.mcpStatusResult ?? {} },
							)}\n`,
						),
					);
				} else if (
					msg.method === "account/rateLimits/read" &&
					"rateLimits" in opts
				) {
					stdout.emit(
						"data",
						Buffer.from(
							`${JSON.stringify({
								id: msg.id,
								result: { rateLimits: opts.rateLimits },
							})}\n`,
						),
					);
				}
			});
		}),
	};
	proc.stdout = stdout;
	proc.stderr = stderr;
	proc.kill = vi.fn();
	return { proc, writes };
}

/** Extract every `turn/start` call's params from the recorded writes. */
function turnStartParams(writes: string[]): Array<Record<string, unknown>> {
	return writes
		.map((w) => JSON.parse(w) as { method?: string; params?: unknown })
		.filter((m) => m.method === "turn/start")
		.map((m) => m.params as Record<string, unknown>);
}

function emitSessionNotification(
	proc: FakeProc,
	method: string,
	params: Record<string, unknown>,
): void {
	proc.stdout.emit(
		"data",
		Buffer.from(`${JSON.stringify({ method, params })}\n`),
	);
}

async function nextSessionEvent(
	iterator: AsyncIterator<AgentEvent>,
): Promise<AgentEvent> {
	const result = await iterator.next();
	if (result.done) throw new Error("Codex session event stream ended early");
	return result.value;
}

function baseCodexParams(
	overrides: Partial<AgentQueryParams> = {},
): AgentQueryParams {
	return {
		cwd: "/tmp/codex-test",
		canUseTool: vi.fn().mockResolvedValue({ behavior: "allow" }),
		model: "gpt-5.4",
		permissionMode: "default",
		...overrides,
	};
}

describe("CodexAgentSession — usage windows", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("reads and maps both rolling Codex windows", async () => {
		const { proc } = makeFakeSessionProc({
			rateLimits: {
				primary: {
					usedPercent: 25,
					windowDurationMins: 300,
					resetsAt: 1_800_000_000,
				},
				secondary: {
					usedPercent: 15,
					windowDurationMins: 10_080,
					resetsAt: 1_800_600_000,
				},
			},
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		expect(await session.usageWindows?.()).toEqual([
			{
				windowId: "five_hour",
				label: "5-HOUR",
				utilization: 0.25,
				resetsAt: 1_800_000_000,
				remaining: null,
				limit: null,
			},
			{
				windowId: "weekly",
				label: "7-DAY",
				utilization: 0.15,
				resetsAt: 1_800_600_000,
				remaining: null,
				limit: null,
			},
		]);
		session.cancel();
	});

	it("uses the reported duration when Codex returns only a weekly primary", async () => {
		const { proc } = makeFakeSessionProc({
			rateLimits: {
				primary: {
					usedPercent: 15,
					windowDurationMins: 10_080,
					resetsAt: 1_800_600_000_000,
				},
				secondary: null,
			},
		});
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		expect(await session.usageWindows?.()).toEqual([
			{
				windowId: "weekly",
				label: "7-DAY",
				utilization: 0.15,
				resetsAt: 1_800_600_000,
				remaining: null,
				limit: null,
			},
		]);
		session.cancel();
	});
});

describe("CodexAgentSession — setModel", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("changes the model carried by the next turn/start call", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const provider = new CodexProvider();
		const session = provider.query(baseCodexParams());

		await session.send("hello");
		await session.setModel?.("gpt-5.5");
		await session.send("hello again");

		const turns = turnStartParams(writes);
		expect(turns).toHaveLength(2);
		expect(turns[0].model).toBe("gpt-5.4");
		expect(turns[1].model).toBe("gpt-5.5");
	});

	it("omits `model` from the next turn/start call when reset to undefined", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const provider = new CodexProvider();
		const session = provider.query(baseCodexParams());

		await session.send("hello");
		await session.setModel?.(undefined);
		await session.send("hello again");

		const turns = turnStartParams(writes);
		expect(turns[0].model).toBe("gpt-5.4");
		expect(turns[1].model).toBeUndefined();
	});
});

describe("CodexAgentSession — setPermissionMode", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("changes approvalPolicy and sandboxPolicy on the next turn/start call", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const provider = new CodexProvider();
		const session = provider.query(baseCodexParams());

		await session.send("hello");
		await session.setPermissionMode?.("bypassPermissions");
		await session.send("hello again");

		const turns = turnStartParams(writes);
		expect(turns[0].approvalPolicy).toBe("on-request");
		expect(turns[0].sandboxPolicy).toEqual(codexSandboxPolicy("default", []));
		expect(turns[1].approvalPolicy).toBe("never");
		expect(turns[1].sandboxPolicy).toEqual(
			codexSandboxPolicy("bypassPermissions", []),
		);
		expect(turns[0].collaborationMode).toMatchObject({ mode: "default" });
		expect(turns[1].collaborationMode).toMatchObject({ mode: "default" });
	});

	it("switches Codex collaboration mode into and out of plan mode", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(baseCodexParams());

		await session.setPermissionMode?.("plan");
		await session.send("plan this");
		await session.setPermissionMode?.("default");
		await session.send("implement this");

		const turns = turnStartParams(writes);
		expect(turns[0].collaborationMode).toEqual({
			mode: "plan",
			settings: {
				model: "gpt-5.4",
				reasoning_effort: null,
				developer_instructions: null,
			},
		});
		expect(turns[1].collaborationMode).toMatchObject({ mode: "default" });
	});
});

describe("CodexAgentSession — notifications", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	it("maps inbound notification families and deduplicates streamed content", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");

		expect(await nextSessionEvent(events)).toEqual({
			type: "session_start",
			sessionId: "thread-1",
		});

		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "item/agentMessage/delta", {
			threadId: "thread-1",
			itemId: "message-1",
			delta: "Streamed response",
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "message-1",
				type: "agentMessage",
				text: "Streamed response",
			},
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "message-2",
				type: "agentMessage",
				text: "Fallback response",
			},
		});
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: { id: "reason-1", type: "reasoning", summary: "Checked state" },
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: { id: "reason-1", type: "reasoning", summary: "Checked state" },
		});
		emitSessionNotification(proc, "item/commandExecution/outputDelta", {
			threadId: "thread-1",
			deltaBase64: Buffer.from("command output").toString("base64"),
		});
		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 42 },
			},
		});
		emitSessionNotification(proc, "mcpServer/startupStatus/updated", {
			servers: [{ name: "filesystem" }, { status: "ignored-without-name" }],
		});
		emitSessionNotification(proc, "thread/tokenUsage/updated", {
			threadId: "thread-1",
			usage: {
				inputTokens: 12,
				outputTokens: 7,
				cacheReadTokens: 3,
				modelContextWindow: 128_000,
			},
		});
		session.closeInput?.();
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});

		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "Streamed response",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "Fallback response",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "tool_start",
			toolId: "reason-1",
			name: "Reasoning",
			input: {},
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "tool_result",
			toolId: "reason-1",
			content: "Checked state",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "local_command_output",
			content: "command output",
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "rate_limit",
			status: "ok",
			rateLimitType: "five_hour",
			utilization: 0.25,
			resetsAt: 42,
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "mcp_status",
			servers: [{ name: "filesystem", status: "pending" }],
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "usage",
			inputTokens: 9,
			outputTokens: 7,
			contextWindow: 128_000,
			cacheReadTokens: 3,
			cacheCreationTokens: undefined,
			model: undefined,
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "done",
			estimatedCost: 0.00012825,
			turns: 1,
			durationMs: 0,
			stopReason: "completed",
			usage: {
				inputTokens: 9,
				outputTokens: 7,
				cacheReadTokens: 3,
				cacheCreationTokens: 0,
			},
		});
		expect(await events.next()).toEqual({ value: undefined, done: true });
	});

	it("keeps a spawn card live through child-thread activity and completion", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("delegate this");
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "session_start",
			sessionId: "thread-1",
		});

		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			startedAtMs: 1000,
			item: {
				id: "spawn-1",
				type: "collabAgentToolCall",
				tool: "spawnAgent",
				prompt: "Inspect auth",
				model: "gpt-5.4",
				reasoningEffort: "medium",
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_start",
			toolId: "spawn-1",
			name: "spawn_agent",
			subagent: {
				agentId: "spawn-1",
				prompt: "Inspect auth",
				status: "pending",
				startedAtMs: 1000,
			},
		});

		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "spawn-1",
				type: "collabAgentToolCall",
				tool: "spawnAgent",
				receiverThreadIds: ["child-1"],
				agentsStates: { "child-1": { status: "running", message: null } },
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_update",
			toolId: "spawn-1",
			subagent: { agentId: "child-1", status: "running" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_result",
			toolId: "spawn-1",
		});

		emitSessionNotification(proc, "item/started", {
			threadId: "child-1",
			item: {
				id: "command-1",
				type: "commandExecution",
				command: "rg auth src",
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_update",
			toolId: "spawn-1",
			subagent: { status: "running", currentStep: "Running rg auth src" },
		});

		emitSessionNotification(proc, "turn/completed", {
			threadId: "child-1",
			completedAtMs: 7000,
			turn: { id: "child-turn", status: "completed" },
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			type: "tool_update",
			toolId: "spawn-1",
			subagent: { status: "completed", endedAtMs: 7000 },
		});
	});

	it("keeps collab wait bookkeeping out of the generic tool timeline", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("delegate this");
		await nextSessionEvent(events); // session_start

		const waitItem = {
			id: "wait-1",
			type: "collabAgentToolCall",
			tool: "wait",
			receiverThreadIds: [],
			agentsStates: {},
		};
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: waitItem,
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: { ...waitItem, status: "completed" },
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: { id: "reply-1", type: "agentMessage", text: "Finished" },
		});

		expect(await nextSessionEvent(events)).toEqual({
			type: "text_delta",
			text: "Finished",
		});
	});

	it("attributes rateLimitReachedType to the most-utilized window", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");
		await nextSessionEvent(events); // session_start

		// five_hour most utilized → it gets the rejection; weekly stays ok.
		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				rateLimitReachedType: "rate_limit_reached",
				primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 42 },
				secondary: {
					usedPercent: 30,
					windowDurationMins: 10_080,
					resetsAt: 99,
				},
			},
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "rate_limit",
			status: "rejected",
			rateLimitType: "five_hour",
			utilization: 1,
			resetsAt: 42,
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "rate_limit",
			status: "ok",
			rateLimitType: "weekly",
			utilization: 0.3,
			resetsAt: 99,
		});

		// weekly most utilized → rejection lands there, not on five_hour.
		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				rateLimitReachedType: "workspace_owner_usage_limit_reached",
				primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 42 },
				secondary: {
					usedPercent: 100,
					windowDurationMins: 10_080,
					resetsAt: 99,
				},
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			rateLimitType: "five_hour",
			status: "ok",
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			rateLimitType: "weekly",
			status: "rejected",
		});
		session.cancel();
	});

	it("keeps credits-depleted snapshots ok and emits despite missing usedPercent", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");
		await nextSessionEvent(events); // session_start

		// Credits don't reset with the window — no rejection.
		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				rateLimitReachedType: "workspace_owner_credits_depleted",
				primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 42 },
			},
		});
		expect(await nextSessionEvent(events)).toMatchObject({
			rateLimitType: "five_hour",
			status: "ok",
		});

		// Hard limit with no usedPercent reading still surfaces the rejection.
		emitSessionNotification(proc, "account/rateLimits/updated", {
			rateLimits: {
				rateLimitReachedType: "rate_limit_reached",
				primary: { windowDurationMins: 300, resetsAt: 42 },
			},
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "rate_limit",
			status: "rejected",
			rateLimitType: "five_hour",
			resetsAt: 42,
		});
		session.cancel();
	});

	it("uses Codex item tool metadata instead of the generic item type", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(baseCodexParams());
		const events = session[Symbol.asyncIterator]();
		await session.send("hello");
		await nextSessionEvent(events);
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "mcp-1",
				type: "mcpToolCall",
				tool: "update_plan",
				arguments: { plan: [{ step: "Research", status: "in_progress" }] },
			},
		});

		expect(await nextSessionEvent(events)).toEqual({
			type: "tool_start",
			toolId: "mcp-1",
			name: "update_plan",
			input: { plan: [{ step: "Research", status: "in_progress" }] },
		});
		session.cancel();
	});

	it("keeps inherited hooks enabled under internal policy enforcement", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const session = new CodexProvider().query(
			baseCodexParams({ policyEnforced: true }),
		);
		await session.send("hello");

		expect(spawn).toHaveBeenCalledWith(
			"/usr/bin/codex",
			["app-server", "--listen", "stdio://"],
			expect.any(Object),
		);
		session.cancel();
	});

	it("routes request_user_input through the shared question UI and maps answers", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "allow",
			updatedInput: {
				answers: { "Choose a database": "SQLite" },
			},
		});
		const session = new CodexProvider().query(baseCodexParams({ canUseTool }));
		await session.send("ask me");

		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 78,
					method: "item/tool/requestUserInput",
					params: {
						threadId: "thread-1",
						turnId: "turn-1",
						itemId: "ask-1",
						questions: [
							{
								id: "database",
								header: "Database",
								question: "Choose a database",
								options: [
									{ label: "SQLite", description: "Local" },
									{ label: "Postgres", description: "Server" },
								],
							},
						],
					},
				})}\n`,
			),
		);

		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"AskUserQuestion",
				expect.objectContaining({ itemId: "ask-1" }),
				expect.objectContaining({
					toolUseID: "ask-1",
					displayName: "request_user_input",
				}),
			);
			const response = writes
				.map((line) => JSON.parse(line))
				.find((message) => message.id === 78);
			expect(response?.result).toEqual({
				answers: { database: { answers: ["SQLite"] } },
			});
		});
		session.cancel();
	});

	it("auto-approves app-server requests while a bypassPermissions session is planning", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn();
		const session = new CodexProvider().query(
			baseCodexParams({
				permissionMode: "plan",
				implementationPermissionMode: "bypassPermissions",
				canUseTool,
			}),
		);
		await session.send("run it");
		expect(turnStartParams(writes)[0]).toMatchObject({
			approvalPolicy: "never",
			sandboxPolicy: { type: "readOnly", networkAccess: false },
		});
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 77,
					method: "item/commandExecution/requestApproval",
					params: { threadId: "thread-1", itemId: "command-1" },
				})}\n`,
			),
		);
		await vi.waitFor(() => {
			const response = writes
				.map((line) => JSON.parse(line))
				.find((message) => message.id === 77);
			expect(response?.result).toEqual({ decision: "accept" });
		});
		expect(canUseTool).not.toHaveBeenCalled();
		session.cancel();
	});

	it("uses approval boundaries as the auto-sleep fallback when Umbod is disabled", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
		const session = new CodexProvider().query(
			baseCodexParams({
				permissionMode: "bypassPermissions",
				usageGateEnforced: true,
				canUseTool,
			}),
		);
		await session.send("run it");
		expect(turnStartParams(writes)[0]).toMatchObject({
			approvalPolicy: "on-request",
			sandboxPolicy: { type: "dangerFullAccess" },
		});

		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 79,
					method: "item/commandExecution/requestApproval",
					params: { threadId: "thread-1", itemId: "command-sleep" },
				})}\n`,
			),
		);
		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"item/commandExecution/requestApproval",
				expect.objectContaining({ itemId: "command-sleep" }),
				expect.objectContaining({ toolUseID: "command-sleep" }),
			);
		});
		session.cancel();
	});

	it("leaves bypass approval policy intact when embedded Umbod owns PreToolUse", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const session = new CodexProvider().query(
			baseCodexParams({
				permissionMode: "bypassPermissions",
				policyEnforced: true,
				usageGateEnforced: true,
			}),
		);

		await session.send("run it");

		expect(turnStartParams(writes)[0]).toMatchObject({
			approvalPolicy: "never",
			sandboxPolicy: { type: "dangerFullAccess" },
		});
		session.cancel();
	});

	it("presents an HTML-enabled plan even when no file approval was requested", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "deny",
			message: "Plan was cancelled by the user.",
		});
		const session = new CodexProvider().query(
			baseCodexParams({
				permissionMode: "plan",
				implementationPermissionMode: "bypassPermissions",
				planHtmlPath: "/vault/.hlid/plans/plan-session.html",
				canUseTool,
			}),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("make a plan");
		expect(turnStartParams(writes)[0].collaborationMode).toMatchObject({
			mode: "default",
		});
		expect(turnStartParams(writes)[0].sandboxPolicy).toEqual(
			codexSandboxPolicy("plan", [], "/vault/.hlid/plans/plan-session.html"),
		);
		await nextSessionEvent(events);
		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});
		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"ExitPlanMode",
				{ plan: "HTML plan ready for review." },
				expect.objectContaining({ toolUseID: "codex-plan-turn-1" }),
			);
		});
		expect(await nextSessionEvent(events)).toMatchObject({ type: "done" });
		session.cancel();
	});

	it("presents the native Codex plan when HTML plans are disabled", async () => {
		const { proc } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({
			behavior: "deny",
			message: "Plan was cancelled by the user.",
		});
		const session = new CodexProvider().query(
			baseCodexParams({ permissionMode: "plan", canUseTool }),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("make a plan");
		await nextSessionEvent(events);
		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-native" },
		});
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: {
				id: "plan-1",
				type: "plan",
				text: "## Native plan\n\n1. Implement it.",
			},
		});
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-native", status: "completed" },
		});

		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"ExitPlanMode",
				{ plan: "## Native plan\n\n1. Implement it." },
				expect.objectContaining({
					toolUseID: "codex-plan-turn-native",
				}),
			);
		});
		expect(await nextSessionEvent(events)).toMatchObject({ type: "done" });
		session.cancel();
	});

	it("starts implementation outside read-only mode after plan approval", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
		const session = new CodexProvider().query(
			baseCodexParams({ permissionMode: "plan", canUseTool }),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("make a plan");
		await nextSessionEvent(events);

		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "change-1",
				type: "fileChange",
				changes: [{ path: "/vault/.hlid/plans/plan-session.html" }],
			},
		});
		await nextSessionEvent(events);
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 99,
					method: "item/fileChange/requestApproval",
					params: {
						threadId: "thread-1",
						itemId: "change-1",
						reason: "write plan",
					},
				})}\n`,
			),
		);
		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"Write",
				{ file_path: "/vault/.hlid/plans/plan-session.html" },
				expect.objectContaining({ toolUseID: "change-1" }),
			);
			expect(writes.some((line) => JSON.parse(line).id === 99)).toBe(true);
		});

		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: { id: "change-1", type: "fileChange" },
		});
		await nextSessionEvent(events);
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});
		await vi.waitFor(() => {
			expect(canUseTool).toHaveBeenCalledWith(
				"ExitPlanMode",
				{ plan: "HTML plan ready for review." },
				expect.objectContaining({ toolUseID: "codex-plan-turn-1" }),
			);
		});
		await vi.waitFor(() => expect(turnStartParams(writes)).toHaveLength(2));
		const implementationTurn = turnStartParams(writes)[1];
		expect(implementationTurn).toMatchObject({
			approvalPolicy: "on-request",
			collaborationMode: { mode: "default" },
			sandboxPolicy: codexSandboxPolicy("default", []),
		});
		expect(implementationTurn.input).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("approved the plan"),
			}),
		]);
		session.cancel();
	});

	it("starts another plan turn with revision feedback", async () => {
		const { proc, writes } = makeFakeSessionProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		const canUseTool = vi.fn(async (name: string) =>
			name === "ExitPlanMode"
				? {
						behavior: "deny" as const,
						message:
							"User requested changes to the plan:\n\nAdd a validation step.",
					}
				: { behavior: "allow" as const },
		);
		const session = new CodexProvider().query(
			baseCodexParams({ permissionMode: "plan", canUseTool }),
		);
		const events = session[Symbol.asyncIterator]();
		await session.send("make a plan");
		await nextSessionEvent(events);
		emitSessionNotification(proc, "turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-1" },
		});
		emitSessionNotification(proc, "item/started", {
			threadId: "thread-1",
			item: {
				id: "change-1",
				type: "fileChange",
				changes: [{ path: "/vault/.hlid/plans/plan-session.html" }],
			},
		});
		await nextSessionEvent(events);
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: 100,
					method: "item/fileChange/requestApproval",
					params: { threadId: "thread-1", itemId: "change-1" },
				})}\n`,
			),
		);
		await vi.waitFor(() =>
			expect(canUseTool).toHaveBeenCalledWith(
				"Write",
				expect.anything(),
				expect.anything(),
			),
		);
		emitSessionNotification(proc, "item/completed", {
			threadId: "thread-1",
			item: { id: "change-1", type: "fileChange" },
		});
		await nextSessionEvent(events);
		emitSessionNotification(proc, "turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});

		await vi.waitFor(() => expect(turnStartParams(writes)).toHaveLength(2));
		const revisionTurn = turnStartParams(writes)[1];
		expect(revisionTurn.input).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("Add a validation step."),
			}),
		]);
		session.cancel();
	});
});

describe("codexSubagentStatus", () => {
	it("maps each known collab status onto the snapshot status", () => {
		expect(codexSubagentStatus("pendingInit")).toBe("pending");
		expect(codexSubagentStatus("running")).toBe("running");
		expect(codexSubagentStatus("completed")).toBe("completed");
		expect(codexSubagentStatus("errored")).toBe("failed");
		expect(codexSubagentStatus("notFound")).toBe("failed");
		expect(codexSubagentStatus("interrupted")).toBe("interrupted");
	});

	it("treats shutdown as completed only when the agent already completed", () => {
		expect(codexSubagentStatus("shutdown", "completed")).toBe("completed");
		expect(codexSubagentStatus("shutdown", "running")).toBe("interrupted");
		expect(codexSubagentStatus("shutdown")).toBe("interrupted");
	});

	it("keeps the previous status for unknown or missing values", () => {
		expect(codexSubagentStatus(null, "pending")).toBe("pending");
		expect(codexSubagentStatus(undefined, "failed")).toBe("failed");
		expect(codexSubagentStatus(null)).toBe("running");
		expect(codexSubagentStatus(undefined)).toBe("running");
	});
});

describe("codexChildStep", () => {
	it("summarizes command executions with the truncated command line", () => {
		expect(
			codexChildStep({ type: "commandExecution", command: "rg auth src" }),
		).toBe("Running rg auth src");
		const long = "x".repeat(200);
		expect(codexChildStep({ type: "commandExecution", command: long })).toBe(
			`Running ${"x".repeat(120)}`,
		);
		expect(codexChildStep({ type: "commandExecution" })).toBe(
			"Running command",
		);
	});

	it("maps the known activity item types to fixed labels", () => {
		expect(codexChildStep({ type: "fileChange" })).toBe(
			"Applying file changes",
		);
		expect(codexChildStep({ type: "mcpToolCall", tool: "search" })).toBe(
			"Calling search",
		);
		expect(codexChildStep({ type: "mcpToolCall", server: "linear" })).toBe(
			"Calling linear",
		);
		expect(codexChildStep({ type: "mcpToolCall" })).toBe("Calling MCP tool");
		expect(codexChildStep({ type: "webSearch" })).toBe("Searching the web");
		expect(codexChildStep({ type: "reasoning" })).toBe("Reasoning");
	});

	it("falls back to a humanized camelCase type", () => {
		expect(codexChildStep({ type: "customToolThing" })).toBe(
			"Working on custom tool thing",
		);
		expect(codexChildStep({})).toBe("Working on activity");
	});
});

describe("CodexAgentSession — mcpServerStatus", () => {
	beforeEach(() => {
		__resetCodexAppServersForTesting();
	});

	function sessionWith(
		opts: Parameters<typeof makeFakeSessionProc>[0],
	): AgentSession {
		const { proc } = makeFakeSessionProc(opts);
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");
		return new CodexProvider().query(baseCodexParams());
	}

	it("maps app-server statuses onto the UI status vocabulary", async () => {
		const session = sessionWith({
			mcpStatusResult: {
				data: [
					{ name: "linear", status: "notLoggedIn" },
					{ name: "sentry", status: "failed" },
					{ name: "grafana", status: "disabled" },
					{ name: "chrome", status: "pending" },
					{ name: "github", status: "running" },
					{ serverName: "playwright", authStatus: "notLoggedIn" },
					{ status: "running" }, // nameless — dropped
					{ name: "bare" }, // no status — defaults to pending
				],
			},
		});
		expect(await session.mcpServerStatus?.()).toEqual([
			{ name: "linear", status: "needs-auth" },
			{ name: "sentry", status: "failed" },
			{ name: "grafana", status: "disabled" },
			{ name: "chrome", status: "pending" },
			{ name: "github", status: "connected" },
			{ name: "playwright", status: "needs-auth" },
			{ name: "bare", status: "pending" },
		]);
		session.cancel();
	});

	it("reads the legacy `servers` array when `data` is absent", async () => {
		const session = sessionWith({
			mcpStatusResult: {
				servers: [{ name: "linear", status: "running" }],
			},
		});
		expect(await session.mcpServerStatus?.()).toEqual([
			{ name: "linear", status: "connected" },
		]);
		session.cancel();
	});

	it("returns an empty list when the shape is unrecognized", async () => {
		const session = sessionWith({ mcpStatusResult: { nope: true } });
		expect(await session.mcpServerStatus?.()).toEqual([]);
		session.cancel();
	});

	it("returns an empty list when the RPC errors", async () => {
		const session = sessionWith({ mcpStatusError: true });
		expect(await session.mcpServerStatus?.()).toEqual([]);
		session.cancel();
	});
});
