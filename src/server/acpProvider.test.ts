import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

import {
	acpCmdShimCommand,
	acpLaunchUsesShell,
	assertSafeAcpCmdShimInvocation,
} from "./acpExecutable";
import {
	type AcpExecutionAdapter,
	createAcpExecutionAdapter,
} from "./acpExecutionAdapter";
import {
	AcpProvider,
	type AcpProviderOptions,
	AcpSessionImportUnsupportedError,
	AcpSessionListUnsupportedError,
	findAcpProviderSession,
	inspectAcpAgent,
	listAcpProviderSessions,
} from "./acpProvider";
import type {
	AgentEvent,
	AgentQueryParams,
	ProviderPromptContent,
	SendOptions,
} from "./agentProvider";

const fixture = resolve("src/server/fixtures/fake-acp-agent.mjs");

function makeProvider(
	overrides: Partial<AcpProviderOptions> = {},
): AcpProvider {
	return new AcpProvider({
		id: "acp:fake",
		label: "Fake ACP",
		command: "bun",
		args: [fixture],
		...overrides,
	});
}

const processTestTimeouts = {
	preparationMs: 2_000,
	spawnMs: 2_000,
	initializeMs: 2_000,
	sessionMs: 2_000,
	configMs: 2_000,
	modeMs: 2_000,
	authenticationMs: 2_000,
	forkMs: 2_000,
	inspectionMs: 5_000,
	interruptGraceMs: 75,
	terminateGraceMs: 500,
} as const;

function behaviorProvider(
	behavior: string,
	timeouts: AcpProviderOptions["timeouts"] = processTestTimeouts,
): AcpProvider {
	return makeProvider({
		env: { HLID_FAKE_ACP_BEHAVIOR: behavior },
		timeouts,
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

async function promptBlockReport(
	provider: AcpProvider,
	structuredContent: ProviderPromptContent[],
	onStructuredContentAccepted?: NonNullable<
		SendOptions["onStructuredContentAccepted"]
	>,
): Promise<unknown[]> {
	const session = provider.query(params());
	await session.send("report-prompt-blocks", {
		structuredContent,
		...(onStructuredContentAccepted ? { onStructuredContentAccepted } : {}),
	});
	let response = "";
	for await (const event of session) {
		if (event.type === "text_delta") response += event.text;
		if (event.type === "done") break;
	}
	session.cancel();
	return JSON.parse(response) as unknown[];
}

function reasoningStarts(
	events: AgentEvent[],
): Array<Extract<AgentEvent, { type: "tool_start" }>> {
	return events.filter(
		(event): event is Extract<AgentEvent, { type: "tool_start" }> =>
			event.type === "tool_start" && event.name === "Reasoning",
	);
}

function reasoningResults(
	events: AgentEvent[],
): Array<Extract<AgentEvent, { type: "tool_result" }>> {
	return events.filter(
		(event): event is Extract<AgentEvent, { type: "tool_result" }> =>
			event.type === "tool_result" && event.toolId.startsWith("acp-reasoning-"),
	);
}

describe("AcpProvider — interface compliance", () => {
	it("uses a digest rather than raw runtime configuration for session continuity", () => {
		const provider = new AcpProvider({
			id: "acp:test",
			label: "Test",
			command: process.execPath,
			metadataCacheIdentity: '{"TOKEN":"provider-secret"}',
		});

		expect(provider.sessionContinuityIdentity).toMatch(/^[a-f0-9]{64}$/);
		expect(provider.sessionContinuityIdentity).not.toContain("provider-secret");
	});

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

	it("checks executable availability without a synchronous Bun global", async () => {
		await expect(makeProvider().check()).resolves.toEqual({ available: true });
	});

	it("serves and refreshes a cached availability snapshot", async () => {
		const provider = makeProvider({
			initialAvailability: {
				available: false,
				reason: "registry snapshot",
			},
		});
		expect(provider.cachedAvailability()).toEqual({
			available: false,
			reason: "registry snapshot",
		});
		await expect(provider.check()).resolves.toEqual({ available: true });
		expect(provider.cachedAvailability()).toEqual({ available: true });
	});

	it("runs Windows command shims through a shell after path resolution", () => {
		expect(acpLaunchUsesShell("C:\\tools\\agent.cmd", "win32")).toBe(true);
		expect(acpLaunchUsesShell("C:\\tools\\agent.exe", "win32")).toBe(false);
		expect(acpLaunchUsesShell("/usr/bin/agent.cmd", "linux")).toBe(false);
		expect(() =>
			assertSafeAcpCmdShimInvocation("C:\\tools\\agent.cmd", ["acp"]),
		).not.toThrow();
		expect(() =>
			assertSafeAcpCmdShimInvocation("C:\\tools\\agent.cmd", ["acp%PATH%"]),
		).toThrow("shell metacharacters");
		expect(
			acpCmdShimCommand("C:\\Program Files (x86)\\agent.cmd", [
				"acp",
				"two words",
			]),
		).toBe('"C:\\Program Files (x86)\\agent.cmd" "acp" "two words"');
	});
});

describe("AcpProvider — structured prompts", () => {
	it("sends advertised image and embedded-context blocks without expansion", async () => {
		const accepted = vi.fn();
		const structuredContent: ProviderPromptContent[] = [
			{
				type: "image",
				data: "AQID",
				mimeType: "image/png",
				uri: "hlid://attachment/selected-image",
			},
			{
				type: "resource",
				uri: "hlid://vault-reference/Projects%2FHlid.md",
				mimeType: "text/markdown",
				text: "Only the selected note",
			},
		];
		const blocks = await promptBlockReport(
			behaviorProvider("structured-prompts"),
			structuredContent,
			accepted,
		);

		expect(blocks).toEqual([
			{ type: "text", text: "report-prompt-blocks" },
			{
				type: "image",
				data: "AQID",
				mimeType: "image/png",
				uri: "hlid://attachment/selected-image",
			},
			{
				type: "resource",
				resource: {
					uri: "hlid://vault-reference/Projects%2FHlid.md",
					mimeType: "text/markdown",
					text: "Only the selected note",
				},
			},
		]);
		expect(accepted).toHaveBeenCalledOnce();
		expect(accepted).toHaveBeenCalledWith(structuredContent);
	});

	it("omits structured blocks the ACP agent did not advertise", async () => {
		const accepted = vi.fn();
		const blocks = await promptBlockReport(
			makeProvider(),
			[
				{
					type: "image",
					data: "AQID",
					mimeType: "image/png",
				},
				{
					type: "resource",
					uri: "hlid://workspace-reference/selected.txt",
					text: "selected",
				},
			],
			accepted,
		);

		expect(blocks).toEqual([{ type: "text", text: "report-prompt-blocks" }]);
		expect(accepted).toHaveBeenCalledOnce();
		expect(accepted).toHaveBeenCalledWith([]);
	});

	it("keeps prompt dispatch alive when the receipt callback fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const blocks = await promptBlockReport(
				behaviorProvider("structured-prompts"),
				[
					{
						type: "image",
						data: "AQID",
						mimeType: "image/png",
					},
				],
				async () => {
					throw new Error("receipt database unavailable");
				},
			);

			expect(blocks).toEqual([
				{ type: "text", text: "report-prompt-blocks" },
				{ type: "image", data: "AQID", mimeType: "image/png" },
			]);
			expect(error).toHaveBeenCalledWith(
				"[acp] structured prompt receipt callback failed:",
				expect.objectContaining({ message: "receipt database unavailable" }),
			);
		} finally {
			error.mockRestore();
		}
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
		expect(canUseTool).not.toHaveBeenCalled();
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
			"filesystem.write",
			{
				path: "/vault/.hlid/plans/plan-fake.html",
				acp_kind: "edit",
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

	it("does not hand off an HTML plan until its write completes successfully", async () => {
		for (const message of ["html-plan-missing", "html-plan-failed"]) {
			const canUseTool = vi.fn(async (_toolName: string) => ({
				behavior: "allow" as const,
			}));
			const { events, session } = await run(
				message,
				params("allow", {
					permissionMode: "plan",
					planHtmlPath: "/vault/.hlid/plans/plan-fake.html",
					canUseTool,
				}),
			);
			expect(
				vi
					.mocked(canUseTool)
					.mock.calls.some(([name]) => name === "ExitPlanMode"),
			).toBe(false);
			expect(events).not.toContainEqual({
				type: "text_delta",
				text: "implemented",
			});
			expect(events).toContainEqual(
				expect.objectContaining({ type: "done", stopReason: "end_turn" }),
			);
			session.cancel();
		}
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
		const canUseTool = vi.fn(async (_toolName: string) => ({
			behavior: "allow" as const,
		}));
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

	it("does not hand off a native plan when the ACP turn refuses", async () => {
		const canUseTool = vi.fn(async (_toolName: string) => ({
			behavior: "allow" as const,
		}));
		const { events, session } = await run(
			"plan-refusal",
			params("allow", { permissionMode: "plan", canUseTool }),
		);
		expect(
			vi
				.mocked(canUseTool)
				.mock.calls.some(([name]) => name === "ExitPlanMode"),
		).toBe(false);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "done", stopReason: "refusal" }),
		);
		session.cancel();
	});

	it("prefers stable mode configOptions and can return to implementation mode", async () => {
		const provider = behaviorProvider("stable-mode");
		const session = provider.query(params("deny", { permissionMode: "plan" }));
		await session.send("report-mode");
		const planned: AgentEvent[] = [];
		for await (const event of session) {
			planned.push(event);
			if (event.type === "done") break;
		}
		expect(planned).toContainEqual({ type: "text_delta", text: "plan" });

		await session.setPermissionMode?.("default");
		await session.send("report-mode");
		const implementation: AgentEvent[] = [];
		for await (const event of session) {
			implementation.push(event);
			if (event.type === "done") break;
		}
		expect(implementation).toContainEqual({
			type: "text_delta",
			text: "default",
		});
		session.cancel();
	});

	it("selects an explicit implementation mode when several non-plan modes remain", async () => {
		const provider = behaviorProvider("stable-mode-start-plan");
		const session = provider.query(params("deny", { permissionMode: "plan" }));
		await session.send("report-mode");
		for await (const event of session) {
			if (event.type === "done") break;
		}

		await session.setPermissionMode?.("default");
		await session.send("report-mode");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events).toContainEqual({ type: "text_delta", text: "code" });
		session.cancel();
	});

	it("restores the custom mode that preceded an explicit Plan selection", async () => {
		const session = behaviorProvider("dependent-config").query(params("deny"));
		await session.send("report-mode");
		for await (const event of session) {
			if (event.type === "done") break;
		}

		await session.setModel?.("fake-smart");
		await session.setSessionMode?.("review");
		await session.setSessionMode?.("plan");
		expect(session.sessionConfig?.()?.activeMode).toBe("plan");
		await session.restoreSessionMode?.();
		expect(session.sessionConfig?.()?.activeMode).toBe("review");

		await session.send("report-mode");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events).toContainEqual({ type: "text_delta", text: "review" });
		session.cancel();
	});

	it("restores the legacy mode that preceded an explicit Plan selection", async () => {
		const session = behaviorProvider("").query(params("deny"));
		await session.send("report-mode");
		for await (const event of session) {
			if (event.type === "done") break;
		}

		await session.setSessionMode?.("plan");
		await session.restoreSessionMode?.();
		expect(session.sessionConfig?.()?.activeMode).toBe("code");
		session.cancel();
	});

	it("does not mistake a model selector with planning values for mode config", async () => {
		const provider = behaviorProvider("model-plan-option");
		const session = provider.query(params("deny", { permissionMode: "plan" }));
		await session.send("report-mode");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events).toContainEqual({ type: "text_delta", text: "plan" });
		session.cancel();
	});
});

describe("AcpProvider — permission modes", () => {
	it("describes only approval requests that the ACP agent sends", () => {
		expect(makeProvider().permissionModes).toEqual([
			expect.objectContaining({
				value: "default",
				desc: expect.stringContaining("agent sends"),
			}),
			expect.objectContaining({
				value: "bypassPermissions",
				desc: expect.stringContaining("sent by the ACP agent"),
			}),
		]);
	});

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
			"hlid_obsidian.run_command",
			{ id: "app:toggle-left-sidebar", acp_kind: "execute" },
			expect.objectContaining({
				toolUseID: "tool-1",
				title: "Obsidian run command",
			}),
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

	it("aggregates provider thought chunks into one Reasoning lifecycle", async () => {
		const { events, session } = await run("thought-chunk");
		expect(events.filter((event) => event.type === "summary")).toEqual([]);
		const reasoning = events.filter(
			(event) =>
				(event.type === "tool_start" && event.name === "Reasoning") ||
				(event.type === "tool_result" &&
					event.toolId.startsWith("acp-reasoning-")),
		);
		expect(reasoning).toEqual([
			expect.objectContaining({
				type: "tool_start",
				name: "Reasoning",
			}),
			expect.objectContaining({
				type: "tool_result",
				content: "private provider analysis",
			}),
		]);
		const [reasoningStart, reasoningResult] = reasoning;
		expect(reasoningStart?.type).toBe("tool_start");
		expect(reasoningResult?.type).toBe("tool_result");
		if (
			reasoningStart?.type !== "tool_start" ||
			reasoningResult?.type !== "tool_result"
		) {
			throw new Error("Expected one complete Reasoning tool lifecycle");
		}
		expect(reasoningStart.toolId).toBe(reasoningResult.toolId);
		expect(events.filter((event) => event.type === "text_delta")).toEqual([
			{ type: "text_delta", text: "visible answer" },
		]);
		session.cancel();
	});

	it("keeps Reasoning lifecycles prompt-scoped across a reused session", async () => {
		const session = makeProvider().query(params());
		const toolIds: string[] = [];
		for (let prompt = 0; prompt < 2; prompt += 1) {
			await session.send("thought-chunk");
			const events: AgentEvent[] = [];
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") break;
			}
			const starts = reasoningStarts(events);
			const results = reasoningResults(events);
			expect(starts).toHaveLength(1);
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({
				toolId: starts[0]?.toolId,
				content: "private provider analysis",
			});
			toolIds.push(starts[0]?.toolId ?? "");
		}
		expect(new Set(toolIds).size).toBe(2);
		session.cancel();
	});

	it("emits an assistant boundary when ACP changes messageId", async () => {
		const { events, session } = await run("message-boundaries");
		expect(
			events.filter(
				(event) =>
					event.type === "text_delta" ||
					event.type === "assistant_message_boundary",
			),
		).toEqual([
			{ type: "text_delta", text: "first " },
			{ type: "text_delta", text: "message" },
			{ type: "assistant_message_boundary" },
			{ type: "text_delta", text: "second message" },
		]);
		session.cancel();
	});

	it("yields tool_start when ACP server requests a tool invocation", async () => {
		const { events, session } = await run();
		expect(events).toContainEqual({
			type: "tool_start",
			toolId: "tool-1",
			name: "Write",
			input: { path: "a.txt", acp_kind: "edit", file_path: "a.txt" },
		});
		session.cancel();
	});

	it("accumulates ACP tool patches before rendering the terminal result", async () => {
		const { events, session } = await run("patch-tool");
		expect(events).toContainEqual({
			type: "tool_start",
			toolId: "patch-1",
			name: "custom.patch",
			input: { value: 1, acp_kind: "other" },
		});
		expect(events).toContainEqual({
			type: "tool_result",
			toolId: "patch-1",
			content: "result from earlier patch",
			isError: false,
		});
		session.cancel();
	});

	it("streams bounded deduplicated progress without regressing a settled tool", async () => {
		const { events, session } = await run("tool-progress");
		expect(events.filter((event) => event.type === "tool_progress")).toEqual([
			{
				type: "tool_progress",
				toolId: "progress-1",
				progress: {
					status: "in_progress",
					title: "Run progress tool",
					content: "Starting",
				},
			},
			{
				type: "tool_progress",
				toolId: "progress-1",
				progress: {
					status: "in_progress",
					title: "Run progress tool",
					content: "Halfway",
				},
			},
		]);
		expect(
			events.filter(
				(event) =>
					event.type === "tool_result" && event.toolId === "progress-1",
			),
		).toEqual([
			{
				type: "tool_result",
				toolId: "progress-1",
				content: "Done",
				isError: false,
			},
		]);
		session.cancel();
	});

	it("bounds large ACP progress snapshots before exposing them to Raven", async () => {
		const { events, session } = await run("tool-progress-long");
		const progress = events.find((event) => event.type === "tool_progress");
		expect(progress).toMatchObject({
			type: "tool_progress",
			toolId: "progress-1",
			progress: {
				status: "in_progress",
				contentTruncated: true,
			},
		});
		if (progress?.type === "tool_progress") {
			expect(progress.progress.content).toHaveLength(16_000);
			expect(progress.progress.content?.endsWith("…")).toBe(true);
		}
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
			name: "Write",
			input: { path: "a.txt", acp_kind: "edit", file_path: "a.txt" },
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
				acp_kind: "other",
				file_path: "Projects/Hlid.md",
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
			expect.objectContaining({
				type: "tool_start",
				input: { path: "a.txt", acp_kind: "edit", file_path: "a.txt" },
			}),
		);
		session.cancel();
	});

	it("uses stable ACP tool kinds for policy and approval names", async () => {
		const query = params();
		const { session } = await run("read-permission", query);
		expect(query.canUseTool).toHaveBeenCalledWith(
			"Read",
			{ path: "a.txt", acp_kind: "read", file_path: "a.txt" },
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
			["Read", { kind: "read", acp_kind: "read" }],
			["Write", { kind: "edit", acp_kind: "edit" }],
			["Write", { kind: "delete", acp_kind: "delete" }],
			["Write", { kind: "move", acp_kind: "move" }],
			["Grep", { kind: "search", acp_kind: "search" }],
			["Bash", { kind: "execute", acp_kind: "execute" }],
			["Reasoning", { kind: "think", acp_kind: "think" }],
			["WebFetch", { kind: "fetch", acp_kind: "fetch" }],
			["session.set_mode", { kind: "switch_mode", acp_kind: "switch_mode" }],
			["custom.action", { kind: "other", acp_kind: "other" }],
		]);
		session.cancel();
	});

	it("uses the ACP programmatic name and locations for policy identity", async () => {
		const query = params();
		const { events, session } = await run("locations-tool", query);
		const input = {
			path: "selection-alias",
			acp_kind: "edit",
			file_path: "/vault/selected.md",
			locations: [{ path: "/vault/selected.md", line: 12 }],
		};
		expect(query.canUseTool).toHaveBeenCalledWith(
			"filesystem.edit",
			input,
			expect.objectContaining({ title: "Edit selected file" }),
		);
		expect(events).toContainEqual({
			type: "tool_start",
			toolId: "locations-1",
			name: "filesystem.edit",
			input,
		});
		session.cancel();
	});

	it.each([
		[undefined, "allow-once"],
		["session" as const, "allow-once"],
		["local" as const, "allow-always"],
	])("maps Hlid allow scope %s onto the exact ACP permission option", async (saveScope, selectedOption) => {
		const canUseTool = vi.fn(async () => ({
			behavior: "allow" as const,
			...(saveScope ? { saveScope } : {}),
		}));
		const { events, session } = await run(
			"permission-options",
			params("allow", { canUseTool }),
		);
		expect(events).toContainEqual({
			type: "tool_result",
			toolId: "permission-options-1",
			content: selectedOption,
			isError: false,
		});
		session.cancel();
	});

	it("prefers a one-shot ACP rejection and retains approval context", async () => {
		const canUseTool = vi.fn(async () => ({ behavior: "deny" as const }));
		const { events, session } = await run(
			"permission-options",
			params("deny", { canUseTool }),
		);
		expect(canUseTool).toHaveBeenCalledWith(
			"filesystem.edit",
			expect.objectContaining({
				file_path: "/vault/note.md",
				locations: [{ path: "/vault/note.md", line: 7 }],
				content: expect.stringContaining("Edit the selected note"),
				changes: [
					expect.objectContaining({
						path: "/vault/note.md",
						diff: expect.stringContaining("-before\n+after"),
					}),
				],
			}),
			expect.objectContaining({
				title: "Review proposed edit",
				description: expect.stringContaining("Edit the selected note"),
				allowOnce: true,
				allowSession: true,
				allowAlways: true,
			}),
		);
		expect(events).toContainEqual({
			type: "tool_result",
			toolId: "permission-options-1",
			content: "reject-once",
			isError: false,
		});
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

	it("prefers session/resume over replaying session/load", async () => {
		const session = behaviorProvider("resume-preferred").query(
			params("allow", { sessionId: "resumed-session" }),
		);
		await session.send("report-mode");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events[0]).toEqual({
			type: "session_start",
			sessionId: "resumed-session",
		});
		expect(events).toContainEqual({ type: "text_delta", text: "code" });
		session.cancel();
	});

	it("resumes when the ACP agent advertises resume without load", async () => {
		const session = behaviorProvider("resume-only").query(
			params("allow", { sessionId: "resume-only-session" }),
		);
		await session.send("report-mode");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events[0]).toEqual({
			type: "session_start",
			sessionId: "resume-only-session",
		});
		session.cancel();
	});

	it("suppresses historical replay emitted by session/load", async () => {
		const session = behaviorProvider("load-only-replay").query(
			params("allow", { sessionId: "loaded-session" }),
		);
		await session.send("test");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events[0]).toEqual({
			type: "session_start",
			sessionId: "loaded-session",
		});
		expect(events).not.toContainEqual({
			type: "text_delta",
			text: "historical answer",
		});
		expect(events).not.toContainEqual(
			expect.objectContaining({ toolId: "historical-tool" }),
		);
		expect(reasoningStarts(events)).toEqual([]);
		expect(reasoningResults(events)).toEqual([]);
		expect(events).toContainEqual({ type: "text_delta", text: "hello " });
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

	it("settles active Reasoning before hard session cancellation", async () => {
		const session = makeProvider({ timeouts: processTestTimeouts }).query(
			params(),
		);
		await session.send("thought-ignore-cancel");
		const iterator = session[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({
			type: "session_start",
		});
		const start = (await iterator.next()).value;
		expect(start).toMatchObject({ type: "tool_start", name: "Reasoning" });
		if (!start || start.type !== "tool_start") {
			throw new Error("Expected an active Reasoning lifecycle");
		}

		await session.cancelAndWait?.();
		const tail: AgentEvent[] = [];
		for (;;) {
			const next = await iterator.next();
			if (next.done) break;
			tail.push(next.value);
		}
		expect(reasoningResults(tail)).toEqual([
			expect.objectContaining({
				toolId: start.toolId,
				content: "partial cancelled thought",
				isError: true,
			}),
		]);
		expect(tail).toContainEqual({
			type: "mcp_status",
			servers: expect.arrayContaining([
				{ name: "hlid", status: "pending", scope: "provider" },
			]),
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

	it("rejects session controls while an ACP prompt is active", async () => {
		const session = makeProvider().query(params());
		await session.send("slow");
		const iterator = session[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({
			type: "session_start",
		});

		await expect(session.setModel?.("fake-smart")).rejects.toThrow(
			"session controls are unavailable during an active prompt",
		);
		await expect(session.setEffort?.("high")).rejects.toThrow(
			"session controls are unavailable during an active prompt",
		);
		await session.interrupt?.();
		expect((await iterator.next()).value).toMatchObject({
			type: "done",
			stopReason: "cancelled",
		});
		session.cancel();
	});

	it("does not apply startup phase budgets as a total prompt timeout", async () => {
		const session = behaviorProvider("", {
			...processTestTimeouts,
			interruptGraceMs: 40,
		}).query(params());
		await session.send("ignore-cancel");
		const iterator = session[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({
			type: "session_start",
		});
		const pending = iterator.next();
		const early = await Promise.race([
			pending.then(
				() => "event",
				() => "error",
			),
			new Promise<"waiting">((resolve) =>
				setTimeout(() => resolve("waiting"), 125),
			),
		]);
		expect(early).toBe("waiting");
		await session.interrupt?.();
		let terminal = await pending;
		while (!terminal.done && terminal.value.type !== "done") {
			terminal = await iterator.next();
		}
		if (terminal.done) throw new Error("Expected a cancelled turn result");
		expect(terminal.value).toMatchObject({
			type: "done",
			stopReason: "cancelled",
		});
		session.cancel();
	});

	it("escalates an ignored soft cancel and reopens the resumable session", async () => {
		const session = behaviorProvider("reject-load", processTestTimeouts).query(
			params(),
		);
		await session.send("ignore-cancel");
		const iterator = session[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({
			type: "session_start",
		});
		await session.interrupt?.();
		let terminal = await iterator.next();
		while (!terminal.done && terminal.value.type !== "done") {
			terminal = await iterator.next();
		}
		if (terminal.done) throw new Error("Expected a cancelled turn result");
		expect(terminal.value).toMatchObject({
			type: "done",
			stopReason: "cancelled",
		});

		await session.send("report-mode");
		const resumed: AgentEvent[] = [];
		for await (const event of session) {
			resumed.push(event);
			if (event.type === "done") break;
		}
		expect(resumed).toContainEqual({ type: "text_delta", text: "code" });
		session.cancel();
	});

	it("settles Reasoning and MCP state before replacing an interrupted runtime", async () => {
		const session = behaviorProvider("reject-load", processTestTimeouts).query(
			params(),
		);
		await session.send("use-hlid-mcp");
		for await (const event of session) {
			if (event.type === "done") break;
		}
		expect(await session.mcpServerStatus?.()).toContainEqual({
			name: "hlid",
			status: "connected",
			scope: "provider",
		});

		await session.send("thought-ignore-cancel");
		const iterator = session[Symbol.asyncIterator]();
		const start = (await iterator.next()).value;
		expect(start).toMatchObject({ type: "tool_start", name: "Reasoning" });
		if (!start || start.type !== "tool_start") {
			throw new Error("Expected an active Reasoning lifecycle");
		}

		await session.interrupt?.();
		const interrupted: AgentEvent[] = [];
		for (;;) {
			const next = await iterator.next();
			if (next.done) break;
			interrupted.push(next.value);
			if (next.value.type === "done") break;
		}
		expect(reasoningResults(interrupted)).toEqual([
			expect.objectContaining({
				toolId: start.toolId,
				content: "partial cancelled thought",
				isError: true,
			}),
		]);
		expect(interrupted).toContainEqual({
			type: "mcp_status",
			servers: expect.arrayContaining([
				{ name: "hlid", status: "pending", scope: "provider" },
			]),
		});
		expect(await session.mcpServerStatus?.()).toContainEqual({
			name: "hlid",
			status: "pending",
			scope: "provider",
		});

		await session.send("report-mode");
		const recovered: AgentEvent[] = [];
		for await (const event of session) {
			recovered.push(event);
			if (event.type === "done") break;
		}
		expect(reasoningStarts(recovered)).toEqual([]);
		expect(reasoningResults(recovered)).toEqual([]);
		expect(recovered).toContainEqual({ type: "text_delta", text: "code" });
		expect(await session.mcpServerStatus?.()).toContainEqual({
			name: "hlid",
			status: "unknown",
			scope: "provider",
		});
		session.cancel();
	});

	it("retires a runtime after a live control timeout before the next prompt", async () => {
		const session = behaviorProvider("hang-config", {
			...processTestTimeouts,
			configMs: 100,
		}).query(params());
		await session.send("report-mode");
		for await (const event of session) {
			if (event.type === "done") break;
		}

		await expect(session.setModel?.("fake-smart")).rejects.toThrow(
			/ACP model configuration timed out after 100ms/,
		);
		await session.setModel?.(undefined);
		await session.send("report-mode");
		const recovered: AgentEvent[] = [];
		for await (const event of session) {
			recovered.push(event);
			if (event.type === "done") break;
		}
		expect(recovered).toContainEqual({ type: "text_delta", text: "code" });
		session.cancel();
	});

	it.each([
		["permission request", "test", undefined],
		["elicitation", "elicit", undefined],
		["plan approval", "plan-update", "plan"],
	] as const)("aborts a stale %s wait before recovering the next prompt", async (_label, message, permissionMode) => {
		let observedSignal: AbortSignal | undefined;
		const canUseTool = vi.fn(
			async (
				_toolName: string,
				_input: unknown,
				options: { signal: AbortSignal },
			) => {
				if (!observedSignal) {
					observedSignal = options.signal;
					return new Promise<never>((_resolve, reject) => {
						const abort = () => reject(options.signal.reason);
						if (options.signal.aborted) abort();
						else
							options.signal.addEventListener("abort", abort, { once: true });
					});
				}
				return { behavior: "allow" as const };
			},
		);
		const session = behaviorProvider("", processTestTimeouts).query(
			params("allow", {
				canUseTool,
				...(permissionMode ? { permissionMode } : {}),
			}),
		);
		await session.send(message);
		await vi.waitFor(() => expect(canUseTool).toHaveBeenCalled());
		await session.interrupt?.();
		expect(observedSignal?.aborted).toBe(true);
		for await (const event of session) {
			if (event.type === "done") break;
		}

		await session.setPermissionMode?.("default");
		await session.send("report-mode");
		const recovered: AgentEvent[] = [];
		for await (const event of session) {
			recovered.push(event);
			if (event.type === "done") break;
		}
		expect(recovered).toContainEqual({ type: "text_delta", text: "code" });
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

	it("restores the initially advertised model when live selection is cleared", async () => {
		const session = makeProvider().query(params());
		await session.send("report-config");
		for await (const event of session) {
			if (event.type === "done") break;
		}
		await session.setModel?.("fake-smart");
		await session.setModel?.(undefined);
		await session.send("report-config");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events).toContainEqual({
			type: "text_delta",
			text: "fake-fast/medium",
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

	it("moves supported project MCP declarations out of pending after setup", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hlid-acp-mcp-"));
		try {
			writeFileSync(
				join(cwd, ".mcp.json"),
				JSON.stringify({
					mcpServers: {
						local: { command: "bun", args: ["server.ts"], env: { TOKEN: "x" } },
						remote: { type: "http", url: "https://example.com/mcp" },
						disabled: { command: "bun", args: ["disabled.ts"] },
					},
				}),
			);
			mkdirSync(join(cwd, ".claude"));
			writeFileSync(
				join(cwd, ".claude", "settings.local.json"),
				JSON.stringify({ disabledMcpjsonServers: ["disabled"] }),
			);
			const session = makeProvider().query(params("allow", { cwd }));
			expect(await session.mcpServerStatus?.()).toEqual([
				{ name: "local", status: "pending", scope: "project" },
				{ name: "remote", status: "pending", scope: "project" },
				{ name: "disabled", status: "disabled", scope: "project" },
			]);
			await session.send("report-mcp");
			const events: AgentEvent[] = [];
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") break;
			}
			expect(events).toContainEqual({ type: "text_delta", text: "3" });
			expect(await session.mcpServerStatus?.()).toEqual(
				expect.arrayContaining([
					{ name: "local", status: "unknown", scope: "project" },
					{ name: "remote", status: "unknown", scope: "project" },
					{ name: "disabled", status: "disabled", scope: "project" },
				]),
			);
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
			status: "unknown",
			scope: "provider",
		});
		expect(await session.mcpServerStatus?.()).toContainEqual({
			name: "hlid_obsidian",
			status: "unknown",
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
			status: "unknown",
			scope: "provider",
		});
		session.cancel();
	});

	it("promotes an internal Hlid MCP only after an exact tool start", async () => {
		const { events, session } = await run("use-hlid-mcp");
		expect(events).toContainEqual({
			type: "mcp_status",
			servers: expect.arrayContaining([
				{ name: "hlid", status: "connected", scope: "provider" },
			]),
		});
		expect(await session.mcpServerStatus?.()).toContainEqual({
			name: "hlid",
			status: "connected",
			scope: "provider",
		});
		session.cancel();
	});

	it("keeps other internal MCPs unreported when one is proven connected", async () => {
		getObsidianCliStatus.mockResolvedValueOnce({ installed: true });
		const { events, session } = await run("use-obsidian-mcp");
		expect(events).toContainEqual({
			type: "mcp_status",
			servers: expect.arrayContaining([
				{
					name: "hlid_obsidian",
					status: "connected",
					scope: "provider",
				},
				{ name: "hlid", status: "unknown", scope: "provider" },
			]),
		});
		session.cancel();
	});

	it("promotes an internal MCP when its exact tool name arrives on a later update", async () => {
		getObsidianCliStatus.mockResolvedValueOnce({ installed: true });
		const { events, session } = await run("use-obsidian-mcp-late-name");
		expect(events).toContainEqual({
			type: "mcp_status",
			servers: expect.arrayContaining([
				{
					name: "hlid_obsidian",
					status: "connected",
					scope: "provider",
				},
			]),
		});
		expect(await session.mcpServerStatus?.()).toContainEqual({
			name: "hlid_obsidian",
			status: "connected",
			scope: "provider",
		});
		session.cancel();
	});

	it("promotes an internal MCP from OpenCode's title-only tool update", async () => {
		getObsidianCliStatus.mockResolvedValueOnce({ installed: true });
		const { events, session } = await run("use-obsidian-mcp-title-only");
		expect(events).toContainEqual({
			type: "mcp_status",
			servers: expect.arrayContaining([
				{
					name: "hlid_obsidian",
					status: "connected",
					scope: "provider",
				},
			]),
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "tool_start",
				name: "hlid_obsidian_vault_info",
			}),
		);
		expect(await session.mcpServerStatus?.()).toContainEqual({
			name: "hlid_obsidian",
			status: "connected",
			scope: "provider",
		});
		session.cancel();
	});

	it("does not let a matching title override an unrelated tool name", async () => {
		getObsidianCliStatus.mockResolvedValueOnce({ installed: true });
		const { events, session } = await run("use-similar-mcp-name");
		expect(events.filter((event) => event.type === "mcp_status")).toEqual([]);
		expect(await session.mcpServerStatus?.()).toContainEqual({
			name: "hlid_obsidian",
			status: "unknown",
			scope: "provider",
		});
		session.cancel();
	});

	it("omits unadvertised additional directories and remote MCP transports", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hlid-acp-capabilities-"));
		try {
			writeFileSync(
				join(cwd, ".mcp.json"),
				JSON.stringify({
					mcpServers: {
						local: { command: "bun", args: ["server.ts"] },
						http: { type: "http", url: "https://example.com/mcp" },
						sse: { type: "sse", url: "https://example.com/events" },
					},
				}),
			);
			for (const sessionId of [undefined, "strict-resumed-session"]) {
				const session = behaviorProvider("strict-capabilities").query(
					params("allow", {
						cwd,
						sessionId,
						additionalDirectories: [join(cwd, "extra")],
					}),
				);
				await session.send("report-session-inputs");
				const events: AgentEvent[] = [];
				for await (const event of session) {
					events.push(event);
					if (event.type === "done") break;
				}
				expect(events).toContainEqual({
					type: "text_delta",
					text: JSON.stringify({
						additionalDirectories: [],
						mcpTransports: ["stdio", "stdio"],
					}),
				});
				expect(await session.mcpServerStatus?.()).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "local", status: "unknown" }),
						expect.objectContaining({
							name: "http",
							status: "failed",
							error: expect.stringContaining("HTTP MCP transport"),
						}),
						expect.objectContaining({
							name: "sse",
							status: "failed",
							error: expect.stringContaining("SSE MCP transport"),
						}),
					]),
				);
				session.cancel();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("passes advertised additional directories and remote MCP transports", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hlid-acp-capabilities-"));
		const additionalDirectory = join(cwd, "extra");
		try {
			writeFileSync(
				join(cwd, ".mcp.json"),
				JSON.stringify({
					mcpServers: {
						http: { type: "http", url: "https://example.com/mcp" },
						sse: { type: "sse", url: "https://example.com/events" },
					},
				}),
			);
			const session = makeProvider().query(
				params("allow", {
					cwd,
					additionalDirectories: [additionalDirectory],
				}),
			);
			await session.send("report-session-inputs");
			const events: AgentEvent[] = [];
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") break;
			}
			expect(events).toContainEqual({
				type: "text_delta",
				text: JSON.stringify({
					additionalDirectories: [additionalDirectory],
					mcpTransports: ["stdio", "http", "sse"],
				}),
			});
			expect(await session.mcpServerStatus?.()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "http", status: "unknown" }),
					expect.objectContaining({ name: "sse", status: "unknown" }),
				]),
			);
			session.cancel();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("AcpProvider — model catalog", () => {
	it("uses one target adapter for sessions, inspection, authentication, and forks", async () => {
		const base = createAcpExecutionAdapter({ kind: "host" });
		const terminate = vi.fn();
		const start = vi.fn(async (input: Parameters<typeof base.start>[0]) => {
			const started = await base.start(input);
			return {
				...started,
				terminate: async (...args: Parameters<typeof started.terminate>) => {
					terminate(...args);
					await started.terminate(...args);
				},
			};
		});
		const providerPath = vi.fn((_cwd: string, path: string) =>
			path.endsWith("extra") ? "/provider/extra" : "/provider/repo",
		);
		const adapter: AcpExecutionAdapter = {
			...base,
			target: { kind: "wsl", distro: "Test-Distro" },
			key: "wsl:test-distro",
			providerPath,
			start,
		};
		const executionAdapter = vi.fn(() => adapter);
		const hostCwd = process.cwd();
		const hostExtra = join(hostCwd, "extra");
		const provider = makeProvider({
			target: { kind: "wsl", distro: "Test-Distro" },
			executionAdapter,
			timeouts: processTestTimeouts,
		});

		const session = provider.query(
			params("allow", {
				cwd: hostCwd,
				additionalDirectories: [hostExtra],
			}),
		);
		await session.send("report-session-inputs");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events).toContainEqual({
			type: "text_delta",
			text: JSON.stringify({
				additionalDirectories: ["/provider/extra"],
				mcpTransports: ["stdio"],
			}),
		});
		await session.cancelAndWait?.();

		await expect(
			provider.listModels({ cwd: hostCwd }),
		).resolves.not.toHaveLength(0);
		await expect(inspectAcpAgent(provider.options)).resolves.toEqual(
			expect.objectContaining({
				agentInfo: expect.objectContaining({ version: "1.0.0" }),
			}),
		);
		await expect(
			provider.forkSession({ sessionId: "fake-session", cwd: hostCwd }),
		).resolves.toEqual({ sessionId: expect.any(String) });

		expect(executionAdapter).toHaveBeenCalled();
		expect(start).toHaveBeenCalledTimes(4);
		expect(providerPath).toHaveBeenCalledWith(hostCwd, hostCwd);
		expect(providerPath).toHaveBeenCalledWith(hostCwd, hostExtra);
		expect(terminate).toHaveBeenCalledTimes(4);
	});

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
		expect(models[1]).not.toHaveProperty("efforts");
	});

	it("enforces Hlid model visibility on metadata and live ACP sessions", async () => {
		const provider = makeProvider({
			modelFilter: { mode: "only", models: ["fake-smart"] },
		});

		await expect(provider.listModels()).resolves.toEqual([
			expect.objectContaining({ value: "fake-smart", label: "Fake Smart" }),
		]);
		expect(() =>
			provider.query(params("allow", { model: "fake-fast" })),
		).toThrow("excluded by Hlid's ACP model visibility");

		const onSessionConfigChange = vi.fn();
		const session = provider.query(params("allow", { onSessionConfigChange }));
		await session.send("report-config");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events).toContainEqual({
			type: "text_delta",
			text: "fake-smart/medium",
		});
		expect(session.sessionConfig?.()).toEqual(
			expect.objectContaining({
				models: [expect.objectContaining({ value: "fake-smart" })],
				activeModel: "fake-smart",
			}),
		);
		expect(onSessionConfigChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ activeModel: "fake-smart" }),
		);
		await expect(session.setModel?.("fake-fast")).rejects.toThrow(
			"excluded by Hlid's ACP model visibility",
		);
		session.cancel();
	});

	it("retires an active runtime when a live config update activates an excluded model", async () => {
		const provider = makeProvider({
			env: { HLID_FAKE_ACP_BEHAVIOR: "excluded-model-notification" },
			timeouts: processTestTimeouts,
			modelFilter: { mode: "only", models: ["fake-smart"] },
		});
		const session = provider.query(params());

		await session.send("exclude-model-notification");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events).toContainEqual(
			expect.objectContaining({ type: "done", stopReason: "cancelled" }),
		);
		expect(session.sessionConfig?.()).toBeNull();
		session.cancel();
	});

	it("settles active Reasoning before a model-fault runtime retirement", async () => {
		const provider = makeProvider({
			timeouts: processTestTimeouts,
			modelFilter: { mode: "only", models: ["fake-smart"] },
		});
		const session = provider.query(params());

		await session.send("thought-exclude-model-active");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		const starts = reasoningStarts(events);
		const results = reasoningResults(events);
		expect(starts).toHaveLength(1);
		expect(results).toEqual([
			expect.objectContaining({
				toolId: starts[0]?.toolId,
				content: "partial retired thought",
				isError: true,
			}),
		]);
		expect(events.indexOf(results[0])).toBeLessThan(
			events.findIndex((event) => event.type === "done"),
		);
		expect(events).not.toContainEqual({
			type: "text_delta",
			text: "post-fault-output",
		});
		session.cancel();
	});

	it("latches a model visibility fault during an active prompt and suppresses later output", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hlid-acp-model-fault-"));
		const promptMarker = join(cwd, "prompt.log");
		try {
			const provider = makeProvider({
				env: {
					HLID_FAKE_ACP_BEHAVIOR: "excluded-model-notification-active",
					HLID_FAKE_ACP_PROMPT_MARKER: promptMarker,
				},
				timeouts: processTestTimeouts,
				modelFilter: { mode: "only", models: ["fake-smart"] },
			});
			const session = provider.query(params());

			await session.send("exclude-model-active");
			await expect(session.send("must-not-prompt")).rejects.toThrow(
				/active prompt|visibility|retiring/i,
			);
			const events: AgentEvent[] = [];
			for await (const event of session) {
				events.push(event);
				if (event.type === "done") break;
			}

			expect(events).toContainEqual(
				expect.objectContaining({ type: "done", stopReason: "cancelled" }),
			);
			expect(events).not.toContainEqual({
				type: "text_delta",
				text: "post-fault-output",
			});
			expect(
				readFileSync(promptMarker, "utf8").trim().split("\n"),
			).toHaveLength(1);
			expect(session.sessionConfig?.()).toBeNull();
			session.cancel();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("retires when a config notification omits the model required by visibility", async () => {
		const provider = makeProvider({
			env: { HLID_FAKE_ACP_BEHAVIOR: "missing-model-notification" },
			timeouts: processTestTimeouts,
			modelFilter: { mode: "only", models: ["fake-smart"] },
		});
		const session = provider.query(params());

		await session.send("missing-model-notification");
		const events: AgentEvent[] = [];
		for await (const event of session) {
			events.push(event);
			if (event.type === "done") break;
		}
		expect(events).toContainEqual(
			expect.objectContaining({ type: "done", stopReason: "cancelled" }),
		);
		expect(session.sessionConfig?.()).toBeNull();
		session.cancel();
	});

	it("does not let an in-flight config response clear an excluded-model notification", async () => {
		const provider = makeProvider({
			env: { HLID_FAKE_ACP_BEHAVIOR: "excluded-notification-during-config" },
			timeouts: processTestTimeouts,
			modelFilter: { mode: "only", models: ["fake-fast"] },
		});
		const session = provider.query(params());
		await session.send("report-config");
		for await (const event of session) {
			if (event.type === "done") break;
		}

		await expect(session.setModel?.("fake-fast")).rejects.toThrow();
		expect(session.sessionConfig?.()).toBeNull();

		await session.send("report-config");
		const recovered: AgentEvent[] = [];
		for await (const event of session) {
			recovered.push(event);
			if (event.type === "done") break;
		}
		expect(recovered).toContainEqual({
			type: "text_delta",
			text: "fake-fast/medium",
		});
		expect(session.sessionConfig?.()).toEqual(
			expect.objectContaining({ activeModel: "fake-fast" }),
		);
		session.cancel();
	});

	it("retires the runtime when an allowed model selection activates an excluded model", async () => {
		const provider = makeProvider({
			env: { HLID_FAKE_ACP_BEHAVIOR: "misreport-model-selection" },
			timeouts: processTestTimeouts,
			modelFilter: { mode: "only", models: ["fake-fast"] },
		});
		const session = provider.query(params());

		await session.send("report-config");
		for await (const event of session) {
			if (event.type === "done") break;
		}

		await expect(session.setModel?.("fake-fast")).rejects.toThrow(
			'ACP agent activated model "fake-smart" excluded by Hlid\'s ACP model visibility',
		);
		expect(session.sessionConfig?.()).toBeNull();
		session.cancel();
	});

	it("retires the runtime when a model response omits its active model", async () => {
		const provider = makeProvider({
			env: { HLID_FAKE_ACP_BEHAVIOR: "missing-model-selection" },
			timeouts: processTestTimeouts,
			modelFilter: {
				mode: "only",
				models: ["fake-fast", "fake-smart"],
			},
		});
		const session = provider.query(params());
		await session.send("report-config");
		for await (const event of session) {
			if (event.type === "done") break;
		}

		await expect(session.setModel?.("fake-smart")).rejects.toThrow(
			/did not return a selectable model|does not advertise a selectable model/,
		);
		expect(session.sessionConfig?.()).toBeNull();
		session.cancel();
	});

	it("retires the runtime when a model response activates a different allowed model", async () => {
		const provider = makeProvider({
			env: { HLID_FAKE_ACP_BEHAVIOR: "misreport-allowed-model-selection" },
			timeouts: processTestTimeouts,
			modelFilter: {
				mode: "only",
				models: ["fake-fast", "fake-smart"],
			},
		});
		const session = provider.query(params());
		await session.send("report-config");
		for await (const event of session) {
			if (event.type === "done") break;
		}

		await expect(session.setModel?.("fake-smart")).rejects.toThrow(
			'activated model "fake-fast" after Hlid requested "fake-smart"',
		);
		expect(session.sessionConfig?.()).toBeNull();
		session.cancel();
	});

	it("fails closed when the ACP agent advertises no allowed model", async () => {
		const provider = makeProvider({
			modelFilter: { mode: "only", models: ["not-advertised"] },
		});
		const session = provider.query(params());

		await expect(session.send("report-config")).rejects.toThrow(
			"does not advertise any model allowed by Hlid's ACP model visibility",
		);
		session.cancel();
	});

	it("publishes dependent model, effort, and mode options for the live session", async () => {
		const onSessionConfigChange = vi.fn();
		const session = behaviorProvider("dependent-config").query(
			params("allow", { onSessionConfigChange }),
		);
		await session.send("report-config");
		for await (const event of session) {
			if (event.type === "done") break;
		}
		expect(onSessionConfigChange).toHaveBeenLastCalledWith(
			expect.objectContaining({
				activeModel: "fake-fast",
				activeEffort: "medium",
				activeMode: "build",
				planModeValue: "plan",
			}),
		);
		expect(session.sessionConfig?.()).toEqual(
			expect.objectContaining({
				activeModel: "fake-fast",
				activeEffort: "medium",
				activeMode: "build",
			}),
		);

		onSessionConfigChange.mockClear();
		await session.setModel?.("fake-smart");
		expect(onSessionConfigChange).toHaveBeenCalledTimes(1);
		expect(onSessionConfigChange).toHaveBeenLastCalledWith({
			models: [
				expect.objectContaining({ value: "fake-fast" }),
				expect.objectContaining({
					value: "fake-smart",
					isDefault: true,
					efforts: [
						expect.objectContaining({ value: "high", isDefault: true }),
						expect.objectContaining({ value: "xhigh" }),
					],
				}),
			],
			activeModel: "fake-smart",
			effortLevels: [
				expect.objectContaining({ value: "high", isDefault: true }),
				expect.objectContaining({ value: "xhigh" }),
			],
			activeEffort: "high",
			modes: [
				expect.objectContaining({ value: "build", isDefault: true }),
				expect.objectContaining({ value: "plan" }),
				expect.objectContaining({ value: "review" }),
			],
			activeMode: "build",
			planModeValue: "plan",
		});

		onSessionConfigChange.mockClear();
		await session.setEffort?.("xhigh");
		expect(onSessionConfigChange).toHaveBeenCalledTimes(1);
		expect(onSessionConfigChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ activeEffort: "xhigh" }),
		);

		onSessionConfigChange.mockClear();
		await session.setSessionMode?.("review");
		expect(onSessionConfigChange).toHaveBeenCalledTimes(1);
		expect(onSessionConfigChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ activeMode: "review" }),
		);
		expect(session.sessionConfig?.()).toEqual(
			expect.objectContaining({ activeMode: "review" }),
		);
		session.cancel();
	});

	it("uses discoveryCwd for provider-owned metadata sessions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hlid-acp-discovery-"));
		try {
			const models = await makeProvider({
				discoveryCwd: cwd,
				env: { HLID_FAKE_ACP_BEHAVIOR: "cwd-model" },
			}).listModels();
			expect(models[0]).toMatchObject({
				value: cwd,
				label: "Discovery CWD",
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("coalesces metadata discovery and deletes its throwaway session", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hlid-acp-metadata-"));
		const initializeMarker = join(cwd, "initialize.log");
		const deleteMarker = join(cwd, "delete.log");
		try {
			const provider = makeProvider({
				discoveryCwd: cwd,
				env: {
					HLID_FAKE_ACP_INITIALIZE_MARKER: initializeMarker,
					HLID_FAKE_ACP_DELETE_MARKER: deleteMarker,
				},
			});
			const [models, forkCapability, capabilities] = await Promise.all([
				provider.listModels(),
				provider.resolveForkCapability(),
				provider.discoverCapabilities({ cwd }),
			]);
			expect(models).not.toHaveLength(0);
			expect(forkCapability).toMatchObject({ kind: "exact" });
			expect(capabilities.context).toEqual({ cwd });
			expect(capabilities.evidence).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						label: "Model configuration (2)",
						integration: "integrated",
					}),
					expect.objectContaining({
						label: "Session mode configuration (2)",
						integration: "integrated",
						readiness: "ready",
					}),
				]),
			);
			expect(readFileSync(initializeMarker, "utf8")).toBe("initialize\n");
			expect(readFileSync(deleteMarker, "utf8")).toBe("fake-session\n");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("AcpProvider — native session forking", () => {
	it("negotiates and executes whole-session forks", async () => {
		const provider = makeProvider();
		await expect(provider.resolveForkCapability()).resolves.toEqual({
			kind: "exact",
			wholeSession: true,
			throughMessage: false,
		});
		await expect(
			provider.forkSession({
				sessionId: "fake-session",
				cwd: process.cwd(),
			}),
		).resolves.toEqual({ sessionId: "fake-session-fork" });
	});

	it("rejects a message cutoff the ACP protocol cannot express", async () => {
		await expect(
			makeProvider().forkSession({
				sessionId: "fake-session",
				cutoff: { kind: "message", id: "message-1" },
			}),
		).rejects.toThrow("whole-session");
	});
});

describe("AcpProvider — error handling", () => {
	it("settles active Reasoning before surfacing a prompt transport error", async () => {
		const session = makeProvider().query(params());
		await session.send("thought-transport-error");
		const events: AgentEvent[] = [];
		let observedError: unknown;
		try {
			for await (const event of session) events.push(event);
		} catch (error) {
			observedError = error;
		}
		const starts = reasoningStarts(events);
		expect(starts).toHaveLength(1);
		expect(reasoningResults(events)).toEqual([
			expect.objectContaining({
				toolId: starts[0]?.toolId,
				content: "partial transport thought",
				isError: true,
			}),
		]);
		expect(observedError).toBeInstanceOf(Error);
		expect(String(observedError)).toMatch(
			/ACP (connection closed|agent exited)/,
		);
		session.cancel();
	});

	it.each([
		[
			"initialize",
			"hang-initialize",
			{},
			"fake initialize stalled",
			"initializeMs",
			500,
		],
		[
			"session creation",
			"hang-new",
			{},
			"fake session creation stalled",
			"sessionMs",
			100,
		],
		[
			"session load",
			"hang-load",
			{ sessionId: "resumed-session" },
			"fake session load stalled",
			"sessionMs",
			100,
		],
		[
			"model configuration",
			"hang-config",
			{ model: "fake-smart" },
			"fake config option stalled",
			"configMs",
			100,
		],
		[
			"legacy session mode configuration",
			"hang-mode",
			{ permissionMode: "plan" },
			"fake legacy mode configuration stalled",
			"modeMs",
			100,
		],
	])("bounds %s and includes agent stderr", async (phase, behavior, queryOverrides, stderr, timeoutField, timeoutMs) => {
		const session = behaviorProvider(behavior, {
			...processTestTimeouts,
			[timeoutField]: timeoutMs,
		}).query(params("allow", queryOverrides as Partial<AgentQueryParams>));
		await expect(session.send("test")).rejects.toThrow(
			new RegExp(
				`ACP ${phase} timed out after ${timeoutMs}ms[\\s\\S]*${stderr}`,
			),
		);
		session.cancel();
	});

	it("hard cancellation settles initialization and tears down its process", async () => {
		const session = behaviorProvider("hang-initialize", {
			...processTestTimeouts,
			initializeMs: 10_000,
		}).query(params());
		const pending = session.send("test");
		await new Promise((resolve) => setTimeout(resolve, 40));
		await session.cancelAndWait?.();
		await expect(pending).rejects.toThrow(/ACP initialize cancelled/);
		expect(await session[Symbol.asyncIterator]().next()).toEqual({
			done: true,
			value: undefined,
		});
	});

	it("bounds inspection initialization, reports stderr, and cleans up", async () => {
		await expect(
			inspectAcpAgent(
				behaviorProvider("hang-initialize", {
					...processTestTimeouts,
					initializeMs: 500,
				}).options,
			),
		).rejects.toThrow(
			/ACP initialize timed out after 500ms[\s\S]*fake initialize stalled/,
		);
	});

	it("cancels an inspection from the caller signal", async () => {
		const controller = new AbortController();
		const pending = inspectAcpAgent(
			behaviorProvider("hang-initialize", {
				...processTestTimeouts,
				initializeMs: 10_000,
			}).options,
			undefined,
			controller.signal,
		);
		await new Promise((resolve) => setTimeout(resolve, 40));
		controller.abort(new Error("managed install cancelled"));

		await expect(pending).rejects.toThrow(/managed install cancelled/);
	});

	it("bounds out-of-band authentication independently", async () => {
		await expect(
			inspectAcpAgent(
				behaviorProvider("hang-authenticate", {
					...processTestTimeouts,
					authenticationMs: 100,
				}).options,
				"fake-login",
			),
		).rejects.toThrow(
			/ACP authentication timed out after 100ms[\s\S]*fake authentication stalled/,
		);
	});

	it("bounds native session forks and cleans up inspection processes", async () => {
		await expect(
			behaviorProvider("hang-fork", {
				...processTestTimeouts,
				forkMs: 100,
			}).forkSession({
				sessionId: "fake-session",
				cwd: process.cwd(),
			}),
		).rejects.toThrow(
			/ACP session fork timed out after 100ms[\s\S]*fake session fork stalled/,
		);
	});

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

	it("lists only provider-native metadata from the exact requested workspace", async () => {
		const provider = behaviorProvider("list-sessions");
		const first = await listAcpProviderSessions(
			provider.options,
			process.cwd(),
		);
		expect(first).toEqual({
			sessions: [
				{
					sessionId: "native-1",
					title: "First provider session",
					updatedAt: "2026-08-12T12:00:00.000Z",
				},
			],
			canImportSessions: true,
			nextCursor: "next-page",
		});
		await expect(
			listAcpProviderSessions(provider.options, process.cwd(), "next-page"),
		).resolves.toEqual({
			sessions: [
				{
					sessionId: "native-2",
					title: "Second provider session",
					updatedAt: "2026-08-12T13:00:00.000Z",
				},
			],
			canImportSessions: true,
		});
	});

	it("keeps list-only provider sessions metadata-only and rejects import", async () => {
		const provider = behaviorProvider("list-sessions-metadata-only");

		await expect(
			listAcpProviderSessions(provider.options, process.cwd()),
		).resolves.toMatchObject({ canImportSessions: false });
		await expect(
			findAcpProviderSession(provider.options, process.cwd(), "native-1"),
		).rejects.toBeInstanceOf(AcpSessionImportUnsupportedError);
	});

	it("capability-gates and bounds provider-native session listing", async () => {
		await expect(
			listAcpProviderSessions(makeProvider().options, process.cwd()),
		).rejects.toBeInstanceOf(AcpSessionListUnsupportedError);
		await expect(
			listAcpProviderSessions(
				behaviorProvider("list-sessions-oversized").options,
				process.cwd(),
			),
		).rejects.toThrow("oversized session page");
	});

	it("finds an exact provider session across pages on one inspection process", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hlid-acp-session-list-"));
		const marker = join(directory, "initialize.log");
		try {
			const provider = makeProvider({
				env: {
					HLID_FAKE_ACP_BEHAVIOR: "list-sessions",
					HLID_FAKE_ACP_INITIALIZE_MARKER: marker,
				},
				timeouts: processTestTimeouts,
			});
			await expect(
				findAcpProviderSession(provider.options, process.cwd(), "native-2"),
			).resolves.toEqual({
				sessionId: "native-2",
				title: "Second provider session",
				updatedAt: "2026-08-12T13:00:00.000Z",
			});
			expect(readFileSync(marker, "utf8")).toBe("initialize\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects repeated cursors and bounded endless provider catalogs", async () => {
		await expect(
			findAcpProviderSession(
				behaviorProvider("list-sessions-repeated-cursor").options,
				process.cwd(),
				"missing",
			),
		).rejects.toThrow("repeated cursor");
		await expect(
			findAcpProviderSession(
				behaviorProvider("list-sessions-endless").options,
				process.cwd(),
				"missing",
			),
		).rejects.toThrow("25-page validation limit");
	});
});
