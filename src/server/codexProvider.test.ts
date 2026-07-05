import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../lib/codexPath", () => ({ resolveCodexExecutable: vi.fn() }));

import { spawn } from "node:child_process";
import { resolveCodexExecutable } from "../lib/codexPath";
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
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.3-codex",
		]);
		for (const m of models) {
			expect(typeof m.value).toBe("string");
			expect(typeof m.label).toBe("string");
		}
	});
});

describe("codexLaunchConfig", () => {
	it("uses the provided executable and app-server arguments", () => {
		const cfg = codexLaunchConfig({
			cwd: "/home/kyle/development/repos/hlid",
			executable: "/home/kyle/.bun/bin/codex",
		});

		expect(cfg).toEqual({
			executable: "/home/kyle/.bun/bin/codex",
			args: ["app-server", "--listen", "stdio://"],
			spawnCwd: "/home/kyle/development/repos/hlid",
			rpcCwd: "/home/kyle/development/repos/hlid",
		});
	});

	it("omits spawnCwd for a WSL UNC cwd, translating rpcCwd to the POSIX path", () => {
		const cfg = codexLaunchConfig({
			cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\x",
			executable: "/home/kyle/.bun/bin/codex",
		});

		// parseWslUnc/toLogical only rewrite WSL UNC paths on win32 — on
		// Linux/macOS CI this cwd passes through unchanged, so spawnCwd stays.
		// Match the guarding style used in src/lib/paths.test.ts.
		if (process.platform === "win32") {
			expect(cfg).toEqual({
				executable: "/home/kyle/.bun/bin/codex",
				args: ["app-server", "--listen", "stdio://"],
				rpcCwd: "/home/kyle/x",
			});
			expect(cfg).not.toHaveProperty("spawnCwd");
		} else {
			expect(cfg.rpcCwd).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\x");
			expect(cfg.spawnCwd).toBe(
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\x",
			);
		}
	});

	it("keeps spawnCwd for a plain Windows or POSIX cwd", () => {
		const cfg = codexLaunchConfig({
			cwd: "C:\\Users\\kyle\\project",
			executable: "codex.exe",
		});

		expect(cfg.spawnCwd).toBe("C:\\Users\\kyle\\project");
		expect(cfg.rpcCwd).toBe("C:\\Users\\kyle\\project");

		const posixCfg = codexLaunchConfig({
			cwd: "/home/kyle/project",
			executable: "/home/kyle/.bun/bin/codex",
		});
		expect(posixCfg.spawnCwd).toBe("/home/kyle/project");
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
		expect(proc.kill).toHaveBeenCalled();
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

	it("rejects and kills the process on timeout", async () => {
		const { proc } = makeFakeProc({ silent: true });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		await expect(fetchCodexModels({ timeoutMs: 20 })).rejects.toThrow(
			/timed out/i,
		);
		expect(proc.kill).toHaveBeenCalled();
	});

	it("rejects when the process emits an error event", async () => {
		const { proc } = makeFakeProc({ silent: true });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const promise = fetchCodexModels({ timeoutMs: 5000 });
		proc.emit("error", new Error("spawn failed"));
		await expect(promise).rejects.toThrow("spawn failed");
		expect(proc.kill).toHaveBeenCalled();
	});

	it("rejects when the process exits unexpectedly", async () => {
		const { proc } = makeFakeProc({ silent: true });
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const promise = fetchCodexModels({ timeoutMs: 5000 });
		proc.emit("exit", 1);
		await expect(promise).rejects.toThrow(/exited/i);
		expect(proc.kill).toHaveBeenCalled();
	});
});

describe("CodexProvider.listModels", () => {
	it("delegates to fetchCodexModels", async () => {
		const { proc } = makeFakeProc();
		vi.mocked(spawn).mockReturnValue(proc as never);
		vi.mocked(resolveCodexExecutable).mockReturnValue("/usr/bin/codex");

		const provider = new CodexProvider();
		const models = await provider.listModels?.();
		expect(models).toEqual(mapCodexModels(MODEL_LIST_FIXTURE));
	});
});
