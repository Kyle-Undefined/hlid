import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
		const { events, session } = await run(
			"report-mode",
			params("allow", { permissionMode: "plan" }),
		);
		expect(events).toContainEqual({ type: "text_delta", text: "plan" });
		session.cancel();
	});

	it("hands an HTML plan through approval and continues in implementation mode", async () => {
		const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
		const { events, session } = await run(
			"html-plan",
			params("allow", {
				permissionMode: "plan",
				implementationPermissionMode: "bypassPermissions",
				canUseTool,
			}),
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"Write",
			{ file_path: "/vault/.hlid/plans/plan-fake.html" },
			expect.objectContaining({ toolUseID: "tool-1" }),
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"ExitPlanMode",
			{ plan: "HTML plan ready for review." },
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
			toolId: "acp-plan",
			name: "UpdatePlan",
			input: { plan },
		});
		expect(events).toContainEqual({
			type: "tool_result",
			toolId: "acp-plan",
			content: JSON.stringify(plan),
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

	it("closes transport on cancel()", async () => {
		const { session } = await run();
		session.cancel();
		expect(await session[Symbol.asyncIterator]().next()).toEqual({
			done: true,
			value: undefined,
		});
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
	});
});
