import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
	root: `/tmp/hlid-umbod-reload-${Date.now()}`,
	servers: [] as Array<{
		stop: ReturnType<typeof vi.fn>;
		port: number;
		fetch: (request: Request) => Promise<Response>;
	}>,
}));

vi.mock("#/lib/paths", () => ({
	APP_DIR: testState.root,
	expandTilde: (path: string) => path,
}));
vi.mock("#/server/config", () => ({
	loadConfig: () => ({
		umbod: { enabled: true, manifest_path: "umbod.toml" },
	}),
}));
vi.mock("@umbod/core", () => ({
	loadManifest: vi.fn(async () => ({
		server: { host: "127.0.0.1", port: 9090 },
	})),
	createUmbod: vi.fn(({ manifest }) => ({
		manifest,
		close: vi.fn(),
		fetch: vi.fn(),
		authorize: vi.fn(),
	})),
	findAdapterById: vi.fn(),
}));

Object.assign(globalThis, {
	Bun: {
		serve: vi.fn(
			(options: { fetch: (request: Request) => Promise<Response> }) => {
				const server = { stop: vi.fn(), port: 9090, fetch: options.fetch };
				testState.servers.push(server);
				return server;
			},
		),
	},
});

import { createUmbod, findAdapterById, loadManifest } from "@umbod/core";
import {
	authorizeHlidTool,
	bootstrapUmbod,
	closeUmbod,
	registerUmbodApprovalSession,
	saveUmbodManifest,
	umbodCalls,
	umbodHookArtifacts,
} from "./umbod";

const manifest = (decision: "allow" | "approve") => `[env]
name = "hlid"
version = "1.0.0"
timeout = 300

[policy]
default_unknown = "${decision}"
approval_method = "cli"

[rules]
`;

describe("saveUmbodManifest", () => {
	afterEach(() => closeUmbod());

	it("reloads policy without rebinding the embedded server", async () => {
		mkdirSync(testState.root, { recursive: true });
		writeFileSync(join(testState.root, "umbod.toml"), manifest("allow"));
		await bootstrapUmbod();
		const original = testState.servers.at(-1);

		await saveUmbodManifest(manifest("approve"));

		expect(original?.stop).not.toHaveBeenCalled();
		expect(testState.servers).toHaveLength(1);
		expect(createUmbod).toHaveBeenCalledTimes(2);
	});

	it("searches audited commands without requiring accent marks", async () => {
		mkdirSync(testState.root, { recursive: true });
		writeFileSync(join(testState.root, "umbod.toml"), manifest("allow"));
		await bootstrapUmbod();
		const engine = vi.mocked(createUmbod).mock.results.at(-1)?.value as {
			fetch: ReturnType<typeof vi.fn>;
		};
		engine.fetch.mockImplementation((request: Request) => {
			const url = new URL(request.url);
			expect(url.searchParams.has("search")).toBe(false);
			return Promise.resolve(
				Response.json({
					entries: [
						{ id: 2, command: "open Grímr notes" },
						{ id: 1, command: "open other notes" },
					],
					page: 1,
					pageSize: 200,
					total: 2,
					totalPages: 1,
				}),
			);
		});

		await expect(
			umbodCalls(
				new URLSearchParams({
					view: "calls",
					search: "Grimr",
					page: "1",
					pageSize: "25",
				}),
			),
		).resolves.toMatchObject({
			entries: [{ id: 2, command: "open Grímr notes" }],
			total: 1,
			totalPages: 1,
		});
	});

	it("routes hook approvals to the owning session and reuses the decision", async () => {
		mkdirSync(testState.root, { recursive: true });
		writeFileSync(join(testState.root, "umbod.toml"), manifest("approve"));
		const handler = vi.fn().mockResolvedValue("allow");
		registerUmbodApprovalSession("provider-session", handler);
		await bootstrapUmbod();
		const options = vi
			.mocked(createUmbod)
			.mock.calls.at(-1)?.[0] as unknown as {
			approvalPrompt: (
				call: Record<string, unknown>,
				reason: string,
			) => Promise<string>;
		};
		const call = {
			agent: "codex",
			tool: "Bash",
			command: "git status",
			inputs: { command: "git status" },
			workingDirectory: testState.root,
			timestamp: new Date().toISOString(),
			sessionId: "provider-session",
			toolUseId: "tool-1",
		};

		await expect(options.approvalPrompt(call, "matched rule")).resolves.toBe(
			"allow",
		);
		expect(handler).toHaveBeenCalledWith(call, "matched rule");
		await expect(
			authorizeHlidTool({
				agent: "codex",
				tool: "Bash",
				input: call.inputs,
				cwd: testState.root,
				sessionId: "db-session",
				toolUseId: "provider-rewritten-id",
				bypassApproval: false,
				prompt: vi.fn(),
			}),
		).resolves.toMatchObject({
			decision: "allow",
			policyDecision: "approve",
		});
	});

	it.each([
		"claude",
		"codex",
	] as const)("routes normalized %s PreToolUse through the owning session's usage gate", async (agent) => {
		mkdirSync(testState.root, { recursive: true });
		writeFileSync(join(testState.root, "umbod.toml"), manifest("allow"));
		const providerSessionId = `${agent}-thread`;
		const beforeToolUse = vi.fn().mockResolvedValue("aborted");
		const unregister = registerUmbodApprovalSession(
			providerSessionId,
			vi.fn().mockResolvedValue("allow"),
			beforeToolUse,
		);
		vi.mocked(findAdapterById).mockReturnValue({
			id: agent,
			hookEvent: "PreToolUse",
			normalizePayload: (payload: Record<string, unknown>) => ({
				agent,
				tool: String(payload.tool_name),
				command: "git status",
				inputs: payload,
				timestamp: new Date().toISOString(),
				sessionId: String(payload.session_id),
				toolUseId: String(payload.tool_use_id),
			}),
		} as never);
		await bootstrapUmbod();

		const response = await testState.servers.at(-1)?.fetch(
			new Request("http://127.0.0.1:9090/api/hooks", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-umbod-agent": agent,
				},
				body: JSON.stringify({
					session_id: providerSessionId,
					tool_use_id: "tool-1",
					tool_name: "exec_command",
					tool_input: { cmd: "git status" },
				}),
			}),
		);

		expect(beforeToolUse).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: providerSessionId,
				toolUseId: "tool-1",
			}),
		);
		await expect(response?.json()).resolves.toMatchObject({
			permissionDecision: "deny",
			hookSpecificOutput: { hookEventName: "PreToolUse" },
		});
		const engine = vi.mocked(createUmbod).mock.results.at(-1)?.value as {
			fetch: ReturnType<typeof vi.fn>;
		};
		expect(engine.fetch).not.toHaveBeenCalled();
		unregister();
	});

	it.each([
		"claude",
		"codex",
	] as const)("continues normalized %s PreToolUse into Umbod after the usage gate", async (agent) => {
		mkdirSync(testState.root, { recursive: true });
		writeFileSync(join(testState.root, "umbod.toml"), manifest("allow"));
		const providerSessionId = `${agent}-continue-thread`;
		const unregister = registerUmbodApprovalSession(
			providerSessionId,
			vi.fn().mockResolvedValue("allow"),
			vi.fn().mockResolvedValue("proceeded"),
		);
		vi.mocked(findAdapterById).mockReturnValue({
			id: agent,
			hookEvent: "PreToolUse",
			normalizePayload: () => ({
				agent,
				tool: "bash",
				command: "git status",
				inputs: {},
				timestamp: new Date().toISOString(),
				sessionId: providerSessionId,
				toolUseId: "tool-continue",
			}),
		} as never);
		await bootstrapUmbod();

		await testState.servers.at(-1)?.fetch(
			new Request("http://127.0.0.1:9090/api/hooks", {
				method: "POST",
				headers: { "x-umbod-agent": agent },
				body: "{}",
			}),
		);

		const engine = vi.mocked(createUmbod).mock.results.at(-1)?.value as {
			fetch: ReturnType<typeof vi.fn>;
		};
		expect(engine.fetch).toHaveBeenCalledOnce();
		unregister();
	});

	it("fails normalized PreToolUse closed when the usage gate errors", async () => {
		mkdirSync(testState.root, { recursive: true });
		writeFileSync(join(testState.root, "umbod.toml"), manifest("allow"));
		const unregister = registerUmbodApprovalSession(
			"codex-error-thread",
			vi.fn().mockResolvedValue("allow"),
			vi.fn().mockRejectedValue(new Error("gate failed")),
		);
		vi.mocked(findAdapterById).mockReturnValue({
			id: "codex",
			hookEvent: "PreToolUse",
			normalizePayload: () => ({
				agent: "codex",
				tool: "bash",
				command: "git status",
				inputs: {},
				timestamp: new Date().toISOString(),
				sessionId: "codex-error-thread",
				toolUseId: "tool-error",
			}),
		} as never);
		await bootstrapUmbod();

		const response = await testState.servers.at(-1)?.fetch(
			new Request("http://127.0.0.1:9090/api/hooks", {
				method: "POST",
				headers: { "x-umbod-agent": "codex" },
				body: "{}",
			}),
		);

		await expect(response?.json()).resolves.toMatchObject({
			permissionDecision: "deny",
			permissionDecisionReason: "Auto-sleep check failed before tool use",
		});
		unregister();
	});
});

describe("umbodHookArtifacts", () => {
	afterEach(() => closeUmbod());

	it("never passes a zero timeout to any agent adapter", async () => {
		vi.mocked(loadManifest).mockResolvedValueOnce({
			server: { host: "127.0.0.1", port: 9090 },
			env: { timeout: 0 },
		} as never);
		const install = vi.fn((options: { timeoutSeconds: number }) => {
			void options;
			return {
				assets: [],
				config: { fileName: "settings.json", contents: {} },
			};
		});
		vi.mocked(findAdapterById).mockImplementation(
			(agent) => ({ id: agent, displayName: agent, install }) as never,
		);
		await bootstrapUmbod();

		await umbodHookArtifacts(["claude", "codex", "cursor", "gemini"], "wsl");

		expect(install).toHaveBeenCalledTimes(4);
		for (const [options] of install.mock.calls) {
			expect(options.timeoutSeconds).toBe(86_400);
		}
	});
});

afterEach(() => {
	if (testState.servers.length > 2) testState.servers.splice(0, 2);
});

process.on("exit", () =>
	rmSync(testState.root, { recursive: true, force: true }),
);
