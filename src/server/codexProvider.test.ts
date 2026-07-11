import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../lib/codexPath", () => ({ resolveCodexExecutable: vi.fn() }));

import { spawn } from "node:child_process";
import { resolveCodexExecutable } from "../lib/codexPath";
import type { AgentEvent, AgentQueryParams } from "./agentProvider";
import { __resetCodexAppServersForTesting } from "./codexAppServer";
import type { SandboxPolicy } from "./codexProtocol";
import {
	CodexProvider,
	codexLaunchConfig,
	codexReasoningText,
	codexSandboxPolicy,
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

	it("rejects on timeout without killing the shared app-server", async () => {
		const { proc } = makeFakeProc({ silent: true });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		await expect(fetchCodexModels({ timeoutMs: 20 })).rejects.toThrow(
			/timed out/i,
		);
		expect(proc.kill).not.toHaveBeenCalled();
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
function makeFakeSessionProc(): { proc: FakeProc; writes: string[] } {
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
			inputTokens: 12,
			outputTokens: 7,
			contextWindow: 128_000,
			cacheReadTokens: 3,
			cacheCreationTokens: undefined,
			model: undefined,
		});
		expect(await nextSessionEvent(events)).toEqual({
			type: "done",
			cost: 0,
			turns: 1,
			durationMs: 0,
			stopReason: "completed",
			usage: {
				inputTokens: 12,
				outputTokens: 7,
				cacheReadTokens: 3,
				cacheCreationTokens: 0,
			},
		});
		expect(await events.next()).toEqual({ value: undefined, done: true });
	});
});
