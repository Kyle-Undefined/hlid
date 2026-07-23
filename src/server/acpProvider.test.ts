import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const getObsidianCliStatus = vi.hoisted(() =>
	vi.fn().mockResolvedValue({ installed: false }),
);
vi.mock("./obsidianCli", async (importOriginal) => ({
	...(await importOriginal<typeof import("./obsidianCli")>()),
	getObsidianCliStatus,
}));

import { AcpProvider, inspectAcpAgent } from "./acpProvider";
import type { AgentEvent, AgentQueryParams } from "./agentProvider";

const fixture = resolve("src/server/fixtures/fake-acp-agent.mjs");

function makeProvider(): AcpProvider {
	return new AcpProvider({
		id: "acp:fake",
		label: "Fake ACP",
		command: "bun",
		args: [fixture],
	});
}

function params(
	decision: "allow" | "deny" = "allow",
	overrides: Partial<AgentQueryParams> = {},
): AgentQueryParams {
	return {
		cwd: process.cwd(),
		canUseTool: vi.fn(async () => ({ behavior: decision })),
		...overrides,
	};
}

async function run(
	message = "test",
	query = params(),
): Promise<{
	events: AgentEvent[];
	session: ReturnType<AcpProvider["query"]>;
}> {
	const session = makeProvider().query(query);
	await session.send(message);
	const events: AgentEvent[] = [];
	for await (const event of session) {
		events.push(event);
		if (event.type === "done") break;
	}
	return { events, session };
}

describe("AcpProvider — interface compliance", () => {
	it("implements AgentProvider interface (query returns AgentSession)", () => {
		const session = makeProvider().query(params());
		expect(session.send).toBeTypeOf("function");
		session.cancel();
	});

	it("AgentSession is async iterable over AgentEvent", async () => {
		const { events, session } = await run();
		expect(events.some((event) => event.type === "text_delta")).toBe(true);
		session.cancel();
	});

	it("AgentSession.cancel() stops iteration", async () => {
		const session = makeProvider().query(params());
		session.cancel();
		expect(await session[Symbol.asyncIterator]().next()).toEqual({
			done: true,
			value: undefined,
		});
	});
});

describe("AcpProvider — plan mode", () => {
	it("selects an ACP agent's advertised plan session mode", async () => {
		const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
		const { events, session } = await run(
			"report-mode",
			params("allow", { permissionMode: "plan", canUseTool }),
		);
		expect(events).toContainEqual({ type: "text_delta", text: "plan" });
		expect(canUseTool).toHaveBeenCalledWith(
			"ExitPlanMode",
			{ plan: "plan" },
			expect.any(Object),
		);
		session.cancel();
	});

	it("hands an HTML plan through approval and continues in implementation mode", async () => {
		const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
		const { events, session } = await run(
			"html-plan",
			params("allow", {
				permissionMode: "plan",
				implementationPermissionMode: "bypassPermissions",
				planHtmlPath: "/vault/.hlid/plans/plan-fake.html",
				canUseTool,
			}),
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"Write",
			{
				path: "/vault/.hlid/plans/plan-fake.html",
				file_path: "/vault/.hlid/plans/plan-fake.html",
			},
			expect.objectContaining({ toolUseID: "tool-1" }),
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"ExitPlanMode",
			{ plan: "HTML plan ready for review." },
			expect.objectContaining({ title: "Fake ACP completed its plan" }),
		);
		expect(events).toContainEqual({ type: "text_delta", text: "implemented" });
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "done",
				turns: 2,
				usage: expect.objectContaining({ inputTokens: 4, outputTokens: 3 }),
			}),
		);
		session.cancel();
	});

	it("switches an already-running ACP session into its native plan mode", async () => {
		const session = makeProvider().query(params());
		await session.send("report-mode");
		for await (const event of session) {
			if (event.type === "done") break;
		}
		await session.setPermissionMode?.("plan");
		await session.send("report-mode");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events).toContainEqual({ type: "text_delta", text: "plan" });
		session.cancel();
	});

	it("hands a native ACP plan through the shared plan approval without HTML", async () => {
		const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
		const { events, session } = await run(
			"plan-update",
			params("allow", { permissionMode: "plan", canUseTool }),
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"ExitPlanMode",
			{ plan: "- [ ] Research" },
			expect.objectContaining({ title: "Fake ACP completed its plan" }),
		);
		expect(events).toContainEqual({ type: "text_delta", text: "implemented" });
		session.cancel();
	});
});

describe("AcpProvider — permission modes", () => {
	it("selects an allow option without prompting Hlid in bypassPermissions", async () => {
		const canUseTool = vi.fn();
		const { events, session } = await run(
			"test",
			params("deny", { permissionMode: "bypassPermissions", canUseTool }),
		);
		expect(canUseTool).not.toHaveBeenCalled();
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				toolId: "tool-1",
				content: "allowed",
			}),
		);
		session.cancel();
	});

	it("still requests exact Obsidian command approval in bypassPermissions", async () => {
		const canUseTool = vi.fn(async () => ({
			behavior: "deny" as const,
			message: "Command needs approval",
		}));
		const { events, session } = await run(
			"obsidian-command",
			params("allow", { permissionMode: "bypassPermissions", canUseTool }),
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"Obsidian run command",
			{ id: "app:toggle-left-sidebar" },
			expect.objectContaining({ toolUseID: "tool-1" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				toolId: "tool-1",
				content: "permission_denied",
			}),
		);
		session.cancel();
	});

	it("applies a mid-session switch to bypassPermissions", async () => {
		const canUseTool = vi.fn();
		const session = makeProvider().query(params("deny", { canUseTool }));
		await session.setPermissionMode?.("bypassPermissions");
		await session.send("test");
		for await (const event of session) {
			if (event.type === "done") break;
		}
		expect(canUseTool).not.toHaveBeenCalled();
		session.cancel();
	});
});

describe("AcpProvider — event mapping", () => {
	it("yields session_start with ACP session id on connect", async () => {
		const { events, session } = await run();
		expect(events[0]).toEqual({
			type: "session_start",
			sessionId: "fake-session",
		});
		session.cancel();
	});

	it("yields text_delta for each streamed text chunk", async () => {
		const { events, session } = await run();
		expect(events.filter((event) => event.type === "text_delta")).toEqual([
			{ type: "text_delta", text: "hello " },
			{ type: "text_delta", text: "world" },
		]);
		session.cancel();
	});

	it("yields tool_start when ACP server requests a tool invocation", async () => {
		const { events, session } = await run();
		expect(events).toContainEqual({
			type: "tool_start",
			toolId: "tool-1",
			name: "Write file",
			input: { path: "a.txt" },
		});
		session.cancel();
	});

	it("maps native ACP plans onto the shared tool-use timeline", async () => {
		const { events, session } = await run("plan-update");
		const plan = [
			{ content: "Research", priority: "high", status: "in_progress" },
		];
		expect(events).toContainEqual({
			type: "tool_start",
			toolId: "acp-plan-1",
			name: "UpdatePlan",
			input: { plan },
		});
		expect(events).toContainEqual({
			type: "tool_result",
			toolId: "acp-plan-1",
			content: "- [ ] Research",
		});
		session.cancel();
	});

	it("shows unstable plan updates and removals as distinct timeline events", async () => {
		const { events, session } = await run("plan-remove");
		expect(events).toContainEqual({
			type: "tool_result",
			toolId: "acp-plan-1",
			content: "# Draft",
		});
		expect(events).toContainEqual({
			type: "tool_result",
			toolId: "acp-plan-2",
			content: "Plan removed",
		});
		session.cancel();
	});

	it("maps ACP context usage and USD cost updates", async () => {
		const { events, session } = await run("usage-update");
		expect(events).toContainEqual({
			type: "usage",
			inputTokens: 0,
			outputTokens: 0,
			contextTokens: 1234,
			contextWindow: 8192,
		});
		expect(events).toContainEqual(
			expect.objectContaining({ type: "done", cost: 0.25 }),
		);
		session.cancel();
	});

	it("renders structured ACP diff output from a completed initial tool call", async () => {
		const { events, session } = await run("structured-tool");
		expect(events).toContainEqual({
			type: "tool_start",
			toolId: "structured-1",
			name: "Edit a file",
			input: { path: "a.txt" },
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				toolId: "structured-1",
				content: expect.stringContaining("File: a.txt"),
			}),
		);
		session.cancel();
	});

	it("prefers compact structured Obsidian output over verbose ACP raw output", async () => {
		const { events, session } = await run("obsidian-long-result");
		expect(events).toContainEqual({
			type: "tool_start",
			toolId: "obsidian-long-1",
			name: "hlid_obsidian.append_note",
			input: {
				target: "path",
				path: "Projects/Hlid.md",
				content: "x".repeat(2_000),
			},
		});
		expect(events).toContainEqual({
			type: "tool_result",
			toolId: "obsidian-long-1",
			content: '{"path":"Projects/Hlid.md"}',
			isError: false,
		});
		session.cancel();
	});

	it("yields usage event with token counts from ACP usage report", async () => {
		const { events, session } = await run();
		expect(events).toContainEqual({
			type: "usage",
			inputTokens: 4,
			outputTokens: 3,
			cacheReadTokens: 1,
			cacheCreationTokens: undefined,
		});
		session.cancel();
	});

	it("yields done with turns and durationMs on run completion", async () => {
		const { events, session } = await run();
		const done = events.find((event) => event.type === "done");
		expect(done).toMatchObject({ type: "done", turns: 1 });
		expect(
			done && done.type === "done" ? done.durationMs : -1,
		).toBeGreaterThanOrEqual(0);
		session.cancel();
	});

	it("yields done.stopReason reflecting ACP end_turn or max_turns", async () => {
		const { events, session } = await run("max");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "done",
				stopReason: "max_turn_requests",
			}),
		);
		session.cancel();
	});
});

describe("AcpProvider — canUseTool", () => {
	it("calls canUseTool for each tool_use request from ACP server", async () => {
		const query = params();
		const { session } = await run("test", query);
		expect(query.canUseTool).toHaveBeenCalledOnce();
		session.cancel();
	});

	it("allow decision forwards tool call to ACP server", async () => {
		const { events, session } = await run("test", params("allow"));
		expect(events).toContainEqual({
			type: "tool_result",
			toolId: "tool-1",
			content: "allowed",
			isError: false,
		});
		session.cancel();
	});

	it("deny decision sends permission_denied response to ACP server", async () => {
		const { events, session } = await run("test", params("deny"));
		expect(events).toContainEqual({
			type: "tool_result",
			toolId: "tool-1",
			content: "permission_denied",
			isError: true,
		});
		session.cancel();
	});

	it("allow decision does NOT mutate input", async () => {
		const query = params();
		query.canUseTool = vi.fn(async () => ({
			behavior: "allow" as const,
			updatedInput: { changed: true },
		}));
		const { events, session } = await run("test", query);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "tool_start", input: { path: "a.txt" } }),
		);
		session.cancel();
	});

	it("uses stable ACP tool kinds for policy and approval names", async () => {
		const query = params();
		const { session } = await run("read-permission", query);
		expect(query.canUseTool).toHaveBeenCalledWith(
			"Read",
			{ path: "a.txt" },
			expect.objectContaining({ title: "Read file" }),
		);
		session.cancel();
	});

	it("normalizes every ACP tool kind before policy evaluation", async () => {
		const query = params();
		const { session } = await run("tool-kind-matrix", query);
		expect(
			vi
				.mocked(query.canUseTool)
				.mock.calls.map(([toolName, input]) => [toolName, input]),
		).toEqual([
			["Read", { kind: "read" }],
			["Write", { kind: "edit" }],
			["Write", { kind: "delete" }],
			["Write", { kind: "move" }],
			["Grep", { kind: "search" }],
			["Bash", { kind: "execute" }],
			["Reasoning", { kind: "think" }],
			["WebFetch", { kind: "fetch" }],
			["Planning mode", { kind: "switch_mode" }],
			["Custom action", { kind: "other" }],
		]);
		session.cancel();
	});
});

describe("AcpProvider — elicitation", () => {
	it("routes ACP forms through the shared AskUserQuestion flow", async () => {
		const canUseTool = vi.fn(async () => ({
			behavior: "allow" as const,
			updatedInput: {
				answers: {
					Environment: "production",
					Replicas: "3",
				},
			},
		}));
		const { events, session } = await run(
			"elicit",
			params("allow", { canUseTool }),
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"AskUserQuestion",
			{
				questions: [
					{
						question: "Environment",
						options: ["staging", "production"],
						multiSelect: false,
					},
					{
						question: "Replicas",
						options: [],
						multiSelect: false,
						freeText: true,
						inputType: "number",
					},
				],
			},
			expect.objectContaining({
				title: "Choose deployment settings",
				displayName: "elicitation/create",
			}),
		);
		expect(events).toContainEqual({
			type: "text_delta",
			text: JSON.stringify({
				action: "accept",
				content: { environment: "production", replicas: 3 },
			}),
		});
		session.cancel();
	});
});

describe("AcpProvider — session lifecycle", () => {
	it("connects to ACP server via stdio transport by default", async () => {
		const { events, session } = await run();
		expect(events[0]?.type).toBe("session_start");
		session.cancel();
	});

	it("does not accept speculative HTTP/WebSocket endpoint configuration", () => {
		expect(makeProvider().options).not.toHaveProperty("endpoint");
	});

	it("persistSession:false creates ephemeral run", async () => {
		const { events, session } = await run(
			"test",
			params("allow", { persistSession: false }),
		);
		expect(events.some((event) => event.type === "done")).toBe(true);
		session.cancel();
	});

	it("sessionId passed as ACP resume token for multi-turn sessions", async () => {
		const { events, session } = await run(
			"test",
			params("allow", { sessionId: "resumed-session" }),
		);
		expect(events[0]).toEqual({
			type: "session_start",
			sessionId: "resumed-session",
		});
		session.cancel();
	});

	it("does not charge a resumed session's cumulative cost to its first new query", async () => {
		const { events, session } = await run(
			"usage-update",
			params("allow", { sessionId: "resumed-session" }),
		);
		const done = events.find((event) => event.type === "done");
		expect(done).not.toHaveProperty("cost");
		session.cancel();
	});

	it("reports turns per Hlid query instead of cumulative session turns", async () => {
		const session = makeProvider().query(params());
		for (let query = 0; query < 2; query++) {
			await session.send("test");
			for await (const event of session) {
				if (event.type === "done") {
					expect(event.turns).toBe(1);
					break;
				}
			}
		}
		session.cancel();
	});

	it("closes transport on cancel()", async () => {
		const { session } = await run();
		session.cancel();
		expect(await session[Symbol.asyncIterator]().next()).toEqual({
			done: true,
			value: undefined,
		});
	});

	it("interrupts the current turn without closing the ACP session", async () => {
		const session = makeProvider().query(params());
		await session.send("slow");
		await new Promise((resolve) => setTimeout(resolve, 30));
		await session.interrupt?.();
		for await (const event of session) {
			if (event.type === "done") {
				expect(event.stopReason).toBe("cancelled");
				break;
			}
		}
		await session.send("report-mode");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events).toContainEqual({ type: "text_delta", text: "code" });
		session.cancel();
	});

	it("applies ACP model and thought-level configuration initially and live", async () => {
		const session = makeProvider().query(
			params("allow", { model: "fake-smart", effort: "high" }),
		);
		await session.send("report-config");
		const initial: AgentEvent[] = [];
		for await (const event of session) {
			initial.push(event);
			if (event.type === "done") break;
		}
		expect(initial).toContainEqual({
			type: "text_delta",
			text: "fake-smart/high",
		});
		await session.setModel?.("fake-fast");
		await session.setEffort?.("low");
		await session.send("report-config");
		const updated: AgentEvent[] = [];
		for await (const event of session) {
			updated.push(event);
			if (event.type === "done") break;
		}
		expect(updated).toContainEqual({
			type: "text_delta",
			text: "fake-fast/low",
		});
		session.cancel();
	});

	it("translates persisted model ids for a routed ACP harness", async () => {
		const provider = new AcpProvider({
			id: "acp:routed",
			label: "Routed ACP",
			command: "bun",
			args: [fixture],
			requestModel: (model) => `proxy/${model}`,
		});
		const session = provider.query(
			params("allow", { model: "fake-smart", effort: "high" }),
		);
		await session.send("report-config");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events).toContainEqual({
			type: "text_delta",
			text: "proxy/fake-smart/high",
		});
		session.cancel();
	});
});

describe("AcpProvider — MCP status", () => {
	it("mcpServerStatus() returns empty array when ACP server has no MCP info", async () => {
		const session = makeProvider().query(params());
		expect(await session.mcpServerStatus?.()).toEqual([]);
		session.cancel();
	});

	it("mcpServerStatus() always returns the provider-neutral status shape", async () => {
		const session = makeProvider().query(params());
		const statuses = await session.mcpServerStatus?.();
		expect(statuses?.every((status) => typeof status.name === "string")).toBe(
			true,
		);
		session.cancel();
	});

	it("passes project MCP declarations to ACP and exposes honest configured status", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hlid-acp-mcp-"));
		try {
			writeFileSync(
				join(cwd, ".mcp.json"),
				JSON.stringify({
					mcpServers: {
						local: { command: "bun", args: ["server.ts"], env: { TOKEN: "x" } },
						remote: { type: "http", url: "https://example.com/mcp" },
					},
				}),
			);
			const session = makeProvider().query(params("allow", { cwd }));
			expect(await session.mcpServerStatus?.()).toEqual([
				{ name: "local", status: "pending", scope: "project" },
				{ name: "remote", status: "pending", scope: "project" },
			]);
			await session.send("report-mcp");
			const events: AgentEvent[] = [];
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") break;
			}
			expect(events).toContainEqual({ type: "text_delta", text: "3" });
			session.cancel();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("adds Hlid's curated Obsidian MCP server when the CLI is installed", async () => {
		getObsidianCliStatus.mockResolvedValueOnce({ installed: true });
		const { events, session } = await run("report-mcp");
		expect(events).toContainEqual({ type: "text_delta", text: "2" });
		expect(await session.mcpServerStatus?.()).toContainEqual({
			name: "hlid",
			status: "pending",
			scope: "provider",
		});
		expect(await session.mcpServerStatus?.()).toContainEqual({
			name: "hlid_obsidian",
			status: "pending",
			scope: "provider",
		});
		session.cancel();
	});

	it("always adds the lean Hlid capability even without Obsidian", async () => {
		const { events, session } = await run(
			"report-mcp",
			params("allow", { hostSessionId: "host-session-1" }),
		);
		expect(events).toContainEqual({ type: "text_delta", text: "1" });
		expect(await session.mcpServerStatus?.()).toContainEqual({
			name: "hlid",
			status: "pending",
			scope: "provider",
		});
		session.cancel();
	});
});

describe("AcpProvider — model catalog", () => {
	it("surfaces ACP model and thought-level config options", async () => {
		const models = await makeProvider().listModels();
		expect(models).toEqual([
			expect.objectContaining({
				value: "fake-fast",
				label: "Fake Fast",
				isDefault: true,
				efforts: expect.arrayContaining([
					expect.objectContaining({ value: "high", label: "High" }),
				]),
			}),
			expect.objectContaining({ value: "fake-smart", label: "Fake Smart" }),
		]);
	});
});

describe("AcpProvider — error handling", () => {
	it("propagates ACP transport errors from send", async () => {
		const session = makeProvider().query(params());
		await session.send("transport-error");
		const iterator = session[Symbol.asyncIterator]();
		await expect(
			(async () => {
				while (!(await iterator.next()).done) {}
			})(),
		).rejects.toThrow();
		session.cancel();
	});

	it("respects AbortSignal and cancels in-flight request", async () => {
		const controller = new AbortController();
		const session = makeProvider().query(
			params("allow", { signal: controller.signal }),
		);
		const pending = session.send("slow");
		await new Promise((resolve) => setTimeout(resolve, 30));
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(await session[Symbol.asyncIterator]().next()).toEqual({
			done: true,
			value: undefined,
		});
	});

	it("inspects advertised authentication methods", async () => {
		const initialized = await inspectAcpAgent(makeProvider().options);
		expect(initialized.authMethods).toContainEqual({
			id: "fake-login",
			name: "Fake login",
		});
		expect(initialized.agentInfo?.version).toBe("1.0.0");
	});
});
