/**
 * SessionManager — permission routing and session-scoped permission persistence.
 * Shared module mocks and provider builders: see session.test-utils.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", async () =>
	(await import("./session.test-utils")).mockConfigModule(),
);
vi.mock("./agentPaths", async () =>
	(await import("./session.test-utils")).mockAgentPaths(),
);
vi.mock("../lib/claudePath", async () =>
	(await import("./session.test-utils")).mockClaudePath(),
);
vi.mock("../db", async () =>
	(await import("./session.test-utils")).mockDbModule(),
);
vi.mock("./recap", async () =>
	(await import("./session.test-utils")).mockRecap(),
);
vi.mock("./claudeWarmup", async () =>
	(await import("./session.test-utils")).mockClaudeWarmup(),
);
vi.mock("./umbod", async () =>
	(await import("./session.test-utils")).mockUmbod(),
);
vi.mock("./executionContext", async () =>
	(await import("./session.test-utils")).mockExecutionContext(),
);
vi.mock("./libraryStore", async () =>
	(await import("./session.test-utils")).mockLibraryStore(),
);
vi.mock("./promptBuilder", async () =>
	(await import("./session.test-utils")).mockPromptBuilder(),
);
vi.mock("./obsidianCli", async () =>
	(await import("./session.test-utils")).mockObsidianCli(),
);
vi.mock("node:fs", async () =>
	(await import("./session.test-utils")).mockNodeFs(),
);

import * as fsMock from "node:fs";
import type { HlidConfig } from "../config";
import * as dbMock from "../db";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	AgentToolDecision,
} from "./agentProvider";
import { getActiveObsidianNote } from "./obsidianCli";
import { buildPromptAsync } from "./promptBuilder";
import type { ServerMessage } from "./protocol";
import { SessionManager } from "./session";
import {
	makeConfig,
	makeProvider,
	makeProviders,
	makeSwitchableProvider,
	routinePermissionContext,
	testPromptContextManifest,
	waitFor,
} from "./session.test-utils";
import { authorizeHlidTool, registerUmbodApprovalSession } from "./umbod";

describe("SessionManager — unattended Routine permissions", () => {
	beforeEach(() => {
		vi.mocked(authorizeHlidTool).mockClear();
	});
	afterEach(() => {
		vi.mocked(authorizeHlidTool).mockClear();
	});

	for (const providerId of ["claude", "codex", "acp:test"]) {
		it(`uses the same reviewed grant boundary for ${providerId}`, async () => {
			let decision: AgentToolDecision | undefined;
			let queryParams: AgentQueryParams | undefined;
			const provider: AgentProvider = {
				providerId,
				query(params): AgentSession {
					queryParams = params;
					const generator = (async function* (): AsyncGenerator<AgentEvent> {
						yield { type: "session_start", sessionId: `${providerId}-session` };
						decision = await params.canUseTool(
							"Bash",
							{ command: "bun test" },
							{
								toolUseID: `${providerId}-tool`,
								signal: new AbortController().signal,
							},
						);
						yield {
							type: "done",
							cost: 0,
							turns: 1,
							durationMs: 0,
							usage: { inputTokens: 1, outputTokens: 1 },
						};
					})();
					return {
						[Symbol.asyncIterator]: () => generator[Symbol.asyncIterator](),
						cancel: vi.fn(),
						send: vi.fn().mockResolvedValue(undefined),
					};
				},
			};
			const sm = new SessionManager(makeConfig(), makeProviders(provider));
			const onGrantUsed = vi.fn();
			const routine = routinePermissionContext(providerId, onGrantUsed);
			const emitted: ServerMessage[] = [];

			await sm.runQuery("run tests", (message) => emitted.push(message), {
				sessionId: `routine-${providerId}`,
				skillContexts: [],
				attachments: [],
				agentCwd: "/tmp/hlid-test-cwd",
				turnId: "turn-1",
				planMode: false,
				planHtml: false,
				vaultReferences: [],
				routineContext: routine,
			});

			expect(decision).toMatchObject({ behavior: "allow" });
			expect(onGrantUsed).toHaveBeenCalledOnce();
			expect(
				emitted.some((message) => message.type === "permission_request"),
			).toBe(false);
			if (providerId === "codex") {
				expect(queryParams?.sandboxModeOverride).toBe("read-only");
			}
		});
	}

	it("fails closed and marks a changed command as action required", async () => {
		let decision: AgentToolDecision | undefined;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params): AgentSession {
				const generator = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "routine-denied" };
					decision = await params.canUseTool(
						"Bash",
						{ command: "bun test && curl example.com" },
						{
							toolUseID: "changed-command",
							signal: new AbortController().signal,
						},
					);
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => generator[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const routine = routinePermissionContext("claude");

		await sm.runQuery("run tests", () => {}, {
			sessionId: "routine-denied",
			skillContexts: [],
			attachments: [],
			agentCwd: "/tmp/hlid-test-cwd",
			turnId: "turn-1",
			planMode: false,
			planHtml: false,
			vaultReferences: [],
			routineContext: routine,
		});

		expect(decision).toMatchObject({ behavior: "deny" });
		expect(routine.actionRequired?.reason).toContain("No Routine grant");
		expect(sm.getPendingPermissionRequests()).toEqual([]);
	});
});

// ── fixtures ──────────────────────────────────────────────────────────────────

describe("SessionManager — Umbod hook approval routing", () => {
	it("registers the provider session and emits hook approvals into chat", async () => {
		const provider: AgentProvider = {
			providerId: "codex",
			query(): AgentSession {
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "session_start", sessionId: "codex-thread-1" };
						yield {
							type: "done",
							cost: 0,
							turns: 1,
							durationMs: 0,
							usage: { inputTokens: 1, outputTokens: 1 },
						};
					},
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", (event) => emitted.push(event), {
			sessionId: "db-session",
		});
		const handler = vi
			.mocked(registerUmbodApprovalSession)
			.mock.calls.at(-1)?.[1];
		expect(handler).toBeTypeOf("function");
		const beforeToolUse = vi
			.mocked(registerUmbodApprovalSession)
			.mock.calls.at(-1)?.[2];
		expect(beforeToolUse).toBeUndefined();

		const approval = handler?.(
			{
				agent: "codex",
				tool: "Bash",
				command: "git status",
				inputs: {
					session_id: "codex-thread-1",
					transcript_path: "/tmp/transcript.jsonl",
					tool_input: { command: "git status" },
					agent_id: "workflow-child-1",
					agent_type: "repository-reader",
				},
				workingDirectory: "/tmp/project",
				timestamp: new Date().toISOString(),
				sessionId: "codex-thread-1",
				toolUseId: "hook-tool-1",
			},
			"matched approval rule",
		);
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "permission_request",
				id: "hook-tool-1",
				displayName: "Shell command",
				input: { command: "git status" },
				requester: {
					providerId: "codex",
					agentId: "workflow-child-1",
					agentType: "repository-reader",
				},
				policy: {
					source: "umbod",
					reason: "matched approval rule",
				},
			}),
		);
		sm.handlePermissionResponse("hook-tool-1", true);
		await expect(approval).resolves.toBe("allow");
	});

	it("keeps hook approvals scoped to the exact Obsidian command", async () => {
		vi.mocked(getActiveObsidianNote).mockResolvedValueOnce("Notes/Active.md");
		const provider: AgentProvider = {
			providerId: "codex",
			query(): AgentSession {
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "session_start", sessionId: "codex-thread-1" };
						yield {
							type: "done",
							cost: 0,
							turns: 1,
							durationMs: 0,
							usage: { inputTokens: 1, outputTokens: 1 },
						};
					},
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", (event) => emitted.push(event), {
			sessionId: "db-session",
		});
		const handler = vi
			.mocked(registerUmbodApprovalSession)
			.mock.calls.at(-1)?.[1];
		const commandCall = (toolUseId: string, id: string) =>
			handler?.(
				{
					agent: "codex",
					tool: "mcp__hlid_obsidian__run_command",
					command: `run ${id}`,
					inputs: { id },
					workingDirectory: "/tmp/project",
					timestamp: new Date().toISOString(),
					sessionId: "codex-thread-1",
					toolUseId,
				},
				"matched approval rule",
			);
		const first = commandCall("hook-command-1", "app:go-back");

		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()[0]?.id).toBe("hook-command-1"),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "permission_request",
				id: "hook-command-1",
				displayName: "Obsidian command",
				title: "Run an Obsidian command in Test?",
				input: { id: "app:go-back", activeNote: "Notes/Active.md" },
			}),
		);
		sm.handlePermissionResponse("hook-command-1", true, "session");
		await expect(first).resolves.toBe("allow");

		await expect(commandCall("hook-command-2", "app:go-back")).resolves.toBe(
			"allow",
		);
		const second = commandCall("hook-command-3", "app:go-forward");
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()[0]?.id).toBe("hook-command-3"),
		);
		sm.handlePermissionResponse("hook-command-3", false);
		await expect(second).resolves.toBe("block");
	});
});

// ── restoreMcpStatus ──────────────────────────────────────────────────────────

describe("SessionManager — session-scoped permission persistence", () => {
	it("routes Windows Computer Use through explicit app approval instead of Umbod", async () => {
		let decision: AgentToolDecision | undefined;
		const toolName =
			"hlid.windows_computer_use:Docker.DockerForWindows.Settings";
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(
				makeProvider(toolName, "computer-use-1", (value) => {
					decision = value;
				}),
			),
		);
		const emitted: ServerMessage[] = [];
		const turn = sm.runQuery("open Docker", (event) => emitted.push(event), {
			sessionId: "sess-1",
		});

		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(authorizeHlidTool).not.toHaveBeenCalled();
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "permission_request",
				id: "computer-use-1",
				toolName,
				allowOnce: false,
			}),
		);

		sm.handlePermissionResponse("computer-use-1", true, "session");
		await turn;
		expect(decision).toEqual({
			behavior: "allow",
			updatedInput: {},
			saveScope: "session",
		});
	});

	it("leaves always persistence for Computer Use to the native plugin", async () => {
		vi.mocked(fsMock.writeFileSync).mockClear();
		let decision: AgentToolDecision | undefined;
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(
				makeProvider(
					"hlid.windows_computer_use:Microsoft.WindowsCalculator",
					"computer-use-1",
					(value) => {
						decision = value;
					},
				),
			),
		);
		const turn = sm.runQuery("open Calculator", () => {}, {
			sessionId: "sess-1",
		});

		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		sm.handlePermissionResponse("computer-use-1", true, "local");
		await turn;

		expect(decision).toEqual({
			behavior: "allow",
			updatedInput: {},
			saveScope: "local",
		});
		expect(fsMock.writeFileSync).not.toHaveBeenCalled();
	});

	it("keeps Computer Use session approval scoped to the exact app", async () => {
		const dockerTool =
			"hlid.windows_computer_use:Docker.DockerForWindows.Settings";
		const paintTool = "hlid.windows_computer_use:Microsoft.Paint";
		const decisions: AgentToolDecision[] = [];
		const provider: AgentProvider = {
			providerId: "codex",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "codex-session-1" };
					decisions.push(
						await params.canUseTool(
							dockerTool,
							{},
							{
								toolUseID: "docker-1",
								signal: new AbortController().signal,
							},
						),
					);
					decisions.push(
						await params.canUseTool(
							dockerTool,
							{},
							{
								toolUseID: "docker-2",
								signal: new AbortController().signal,
							},
						),
					);
					decisions.push(
						await params.canUseTool(
							paintTool,
							{},
							{
								toolUseID: "paint-1",
								signal: new AbortController().signal,
							},
						),
					);
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const emitted: ServerMessage[] = [];
		const turn = sm.runQuery(
			"use Docker, then Paint",
			(event) => emitted.push(event),
			{
				sessionId: "sess-1",
			},
		);

		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()[0]?.id).toBe("docker-1"),
		);
		sm.handlePermissionResponse("docker-1", true, "session");
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()[0]?.id).toBe("paint-1"),
		);
		expect(
			emitted.filter((event) => event.type === "permission_request"),
		).toEqual([
			expect.objectContaining({ id: "docker-1", toolName: dockerTool }),
			expect.objectContaining({ id: "paint-1", toolName: paintTool }),
		]);
		sm.handlePermissionResponse("paint-1", false);
		await turn;

		expect(decisions).toEqual([
			{ behavior: "allow", updatedInput: {}, saveScope: "session" },
			{ behavior: "allow", updatedInput: {}, saveScope: "session" },
			{ behavior: "deny", message: "Denied by user" },
		]);
		expect(authorizeHlidTool).not.toHaveBeenCalled();
	});

	it("keeps Obsidian session approval scoped to the exact command ID", async () => {
		vi.mocked(getActiveObsidianNote).mockResolvedValueOnce("Notes/Active.md");
		const toolName = "mcp__hlid_obsidian__run_command";
		const decisions: AgentToolDecision[] = [];
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const call = (id: string, commandId: string, name = toolName) =>
					params.canUseTool(
						name,
						{ id: commandId },
						{
							toolUseID: id,
							signal: new AbortController().signal,
						},
					);
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					decisions.push(await call("command-1", "app:go-back"));
					decisions.push(
						await call(
							"command-1-again",
							"app:go-back",
							"Run Obsidian command",
						),
					);
					decisions.push(await call("command-2", "app:go-forward"));
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const emitted: ServerMessage[] = [];
		const turn = sm.runQuery(
			"navigate in Obsidian",
			(event) => emitted.push(event),
			{
				sessionId: "sess-command",
			},
		);

		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()[0]?.id).toBe("command-1"),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "permission_request",
				id: "command-1",
				displayName: "Obsidian command",
				title: "Run an Obsidian command in Test?",
				input: { id: "app:go-back", activeNote: "Notes/Active.md" },
			}),
		);
		sm.handlePermissionResponse("command-1", true, "session");
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()[0]?.id).toBe("command-2"),
		);
		expect(
			emitted.filter((event) => event.type === "permission_request"),
		).toEqual([
			expect.objectContaining({ id: "command-1" }),
			expect.objectContaining({ id: "command-2" }),
		]);
		sm.handlePermissionResponse("command-2", false);
		await turn;

		expect(decisions).toEqual([
			{ behavior: "allow", updatedInput: { id: "app:go-back" } },
			{ behavior: "allow", updatedInput: { id: "app:go-back" } },
			{ behavior: "deny", message: "Denied by user" },
		]);
	});

	it("uses remembered Obsidian command approval without prompting", async () => {
		let decision: AgentToolDecision | undefined;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					decision = await params.canUseTool(
						"mcp__hlid_obsidian__run_command",
						{ id: "app:go-back" },
						{
							toolUseID: "remembered-command",
							signal: new AbortController().signal,
						},
					);
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		const config = makeConfig();
		config.vault.obsidian_command_allowlist = ["app:go-back"];
		const sm = new SessionManager(config, makeProviders(provider));
		const emitted: ServerMessage[] = [];

		await sm.runQuery("go back in Obsidian", (event) => emitted.push(event), {
			sessionId: "sess-remembered-command",
		});

		expect(emitted.some((event) => event.type === "permission_request")).toBe(
			false,
		);
		expect(decision).toEqual({
			behavior: "allow",
			updatedInput: { id: "app:go-back" },
		});
	});

	it("requires exact command approval when Umbod generically allows the tool", async () => {
		vi.mocked(authorizeHlidTool).mockResolvedValueOnce({
			decision: "allow",
			policyDecision: "allow",
			reason: "default allow",
		});
		let decision: AgentToolDecision | undefined;
		const provider: AgentProvider = {
			providerId: "codex",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "codex-session-1" };
					decision = await params.canUseTool(
						"mcp__hlid_obsidian__run_command",
						{ id: "file-explorer:new-file" },
						{
							toolUseID: "umbod-command",
							signal: new AbortController().signal,
						},
					);
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		const config = { ...makeConfig(), umbod: { enabled: true } } as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));
		const turn = sm.runQuery("create a file", () => {}, {
			sessionId: "sess-command-policy",
		});

		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()[0]?.id).toBe("umbod-command"),
		);
		sm.handlePermissionResponse("umbod-command", true);
		await turn;

		expect(decision).toEqual({
			behavior: "allow",
			updatedInput: { id: "file-explorer:new-file" },
		});
	});

	it("honors an explicit Umbod block without prompting for the command", async () => {
		vi.mocked(authorizeHlidTool).mockResolvedValueOnce({
			decision: "block",
			policyDecision: "block",
			reason: "command blocked by policy",
		});
		let decision: AgentToolDecision | undefined;
		const provider: AgentProvider = {
			providerId: "codex",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "codex-session-1" };
					decision = await params.canUseTool(
						"mcp__hlid_obsidian__run_command",
						{ id: "file-explorer:new-file" },
						{
							toolUseID: "blocked-command",
							signal: new AbortController().signal,
						},
					);
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		const config = { ...makeConfig(), umbod: { enabled: true } } as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));
		const emitted: ServerMessage[] = [];

		await sm.runQuery("create a file", (event) => emitted.push(event), {
			sessionId: "sess-command-block",
		});

		expect(emitted.some((event) => event.type === "permission_request")).toBe(
			false,
		);
		expect(decision).toEqual({
			behavior: "deny",
			message: "command blocked by policy",
		});
	});

	it("does not let provider bypass mode auto-approve an unknown command", async () => {
		let decision: AgentToolDecision | undefined;
		const commandProvider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					decision = await params.canUseTool(
						"mcp__hlid_obsidian__run_command",
						{ id: "app:toggle-left-sidebar" },
						{
							toolUseID: "bypass-command",
							signal: new AbortController().signal,
						},
					);
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		const config = makeConfig();
		config.claude.permission_mode = "bypassPermissions";
		config.auto_sleep = {
			enabled: true,
			threshold: 0.95,
			max_sleep_minutes: 360,
			resume_buffer_seconds: 0,
		};
		const sm = new SessionManager(config, makeProviders(commandProvider));
		const turn = sm.runQuery("toggle sidebar", () => {}, {
			sessionId: "sess-command-bypass",
		});

		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()[0]?.id).toBe("bypass-command"),
		);
		sm.handlePermissionResponse("bypass-command", false);
		await turn;

		expect(decision).toEqual({ behavior: "deny", message: "Denied by user" });
	});

	describe("Computer Use capability policy", () => {
		function setup() {
			const executeCommand = vi.fn().mockResolvedValue(undefined);
			const { provider } = makeSwitchableProvider({ executeCommand }, "codex");
			const config = {
				...makeConfig("gpt-5.5"),
				vault_provider: "codex",
				codex: {
					model: "gpt-5.5",
					effort: "high",
					permission_mode: "default",
					turn_recaps: false,
					windows_computer_use: { model: "inherit", effort: "medium" },
				},
			} as HlidConfig;
			return {
				executeCommand,
				sm: new SessionManager(config, makeProviders(provider)),
			};
		}

		function run(
			sm: SessionManager,
			emit: (message: ServerMessage) => void,
			turnId = "computer-use-turn",
			vaultReferences?: string[],
		) {
			return sm.runQuery("/computer-use open Docker", emit, {
				sessionId: "sess-1",
				turnId: turnId,
				commandAction: "computer-use",
				vaultReferences: vaultReferences,
			});
		}

		it("lets Umbod allow the capability without approving a Windows app", async () => {
			vi.mocked(authorizeHlidTool).mockResolvedValueOnce({
				decision: "allow",
				policyDecision: "allow",
				reason: "matched capability allow rule",
			});
			const { sm, executeCommand } = setup();
			const emitted: ServerMessage[] = [];

			await run(sm, (message) => emitted.push(message));

			expect(authorizeHlidTool).toHaveBeenCalledWith(
				expect.objectContaining({
					agent: "codex",
					tool: "hlid.windows_computer_use",
					input: { task: "open Docker" },
					sessionId: "sess-1",
					toolUseId: "hlid-windows-computer-use-computer-use-turn",
					bypassApproval: false,
				}),
			);
			expect(executeCommand).toHaveBeenCalledWith(
				"computer-use",
				"open Docker",
			);
			expect(
				emitted.some((message) => message.type === "permission_request"),
			).toBe(false);
		});

		it("passes validated vault references into capability tasks and history", async () => {
			vi.mocked(authorizeHlidTool).mockResolvedValueOnce({
				decision: "allow",
				policyDecision: "allow",
				reason: "matched capability allow rule",
			});
			vi.mocked(buildPromptAsync).mockResolvedValueOnce({
				prompt: "test prompt",
				safeAttachments: [],
				resourcePaths: ["C:\\Vault\\Projects\\Hlid.md"],
				safeVaultReferences: [
					{
						relativePath: "Projects/Hlid.md",
						path: "C:\\Vault\\Projects\\Hlid.md",
					},
				],
				safeWorkspaceReferences: [],
				contextManifest: {
					...testPromptContextManifest(),
					blocks: [
						{ kind: "workspace_instruction", chars: 40, count: 1 },
						{ kind: "attachments", chars: 50, count: 1 },
						{ kind: "skills", chars: 60, count: 1 },
						{ kind: "vault_references", chars: 70, count: 1 },
					],
					instructionFile: "C:\\Vault\\AGENTS.md",
					skills: ["C:\\Vault\\Skills\\review.md"],
					attachments: [
						{
							filename: "context.txt",
							mime: "text/plain",
							delivery: "path",
						},
					],
					vaultReferences: [
						{
							path: "Projects/Hlid.md",
							delivery: "metadata",
							includedChars: 0,
						},
					],
					operatingBrief: {
						version: 1,
						briefRevision: "v1-a1b2c3d4",
						included: false,
						delivery: "not-delivered",
						chars: 0,
					},
				},
			});
			const { sm, executeCommand } = setup();

			await run(sm, () => {}, "computer-use-turn", ["Projects/Hlid.md"]);

			const task =
				"open Docker\n\nVault references:\n- C:\\Vault\\Projects\\Hlid.md (Vault: Projects/Hlid.md)";
			expect(authorizeHlidTool).toHaveBeenCalledWith(
				expect.objectContaining({ input: { task } }),
			);
			expect(executeCommand).toHaveBeenCalledWith("computer-use", task);
			expect(dbMock.appendMessage).toHaveBeenCalledWith(
				"sess-1",
				expect.any(Number),
				"user",
				"/computer-use open Docker\n\nVault references:\n- Projects/Hlid.md",
				"computer-use-turn",
				undefined,
				expect.stringContaining('"delivery":"provider-command"'),
			);
			const userCall = vi
				.mocked(dbMock.appendMessage)
				.mock.calls.filter(
					(call) =>
						call[0] === "sess-1" &&
						call[2] === "user" &&
						call[4] === "computer-use-turn",
				)
				.at(-1);
			const receipt = JSON.parse(String(userCall?.[6]));
			expect(receipt).toMatchObject({
				delivery: "provider-command",
				promptChars: task.length,
				hlidAddedChars: task.length - "open Docker".length,
				blocks: [
					{
						kind: "vault_references",
						chars: task.length - "open Docker".length,
						count: 1,
					},
				],
				skills: [],
				attachments: [],
				planHtml: false,
				operatingBrief: {
					included: false,
					delivery: "not-delivered",
					chars: 0,
				},
			});
			expect(receipt).not.toHaveProperty("instructionFile");
		});

		it("routes an Umbod approve decision to a capability-level card", async () => {
			vi.mocked(authorizeHlidTool).mockImplementationOnce(async (options) => ({
				decision: await options.prompt("matched capability approval rule"),
				policyDecision: "approve",
				reason: "matched capability approval rule",
			}));
			const { sm, executeCommand } = setup();
			const emitted: ServerMessage[] = [];
			const turn = run(sm, (message) => emitted.push(message));

			await waitFor(() =>
				expect(sm.getPendingPermissionRequests()).toHaveLength(1),
			);
			expect(executeCommand).not.toHaveBeenCalled();
			expect(sm.getPendingPermissionRequests()[0]).toMatchObject({
				toolName: "hlid.windows_computer_use",
				displayName: "Windows Computer Use",
				policy: {
					source: "umbod",
					reason: "matched capability approval rule",
				},
				input: { task: "open Docker" },
				allowAlways: false,
			});

			sm.handlePermissionResponse(
				"hlid-windows-computer-use-computer-use-turn",
				true,
				"session",
			);
			await turn;
			expect(executeCommand).toHaveBeenCalledWith(
				"computer-use",
				"open Docker",
			);
		});

		it("does not start the worker when Umbod blocks the capability", async () => {
			vi.mocked(authorizeHlidTool).mockResolvedValueOnce({
				decision: "block",
				policyDecision: "block",
				reason: "matched capability block rule",
			});
			const { sm, executeCommand } = setup();
			const emitted: ServerMessage[] = [];

			await run(sm, (message) => emitted.push(message));

			expect(executeCommand).not.toHaveBeenCalled();
			expect(emitted).toContainEqual({
				type: "error",
				message: "matched capability block rule",
			});
		});
	});

	it("routes an Umbod approve decision to chat even in bypassPermissions mode", async () => {
		vi.mocked(authorizeHlidTool).mockImplementationOnce(async (options) => {
			expect(options.bypassApproval).toBe(false);
			const decision = await options.prompt("matched approval rule");
			return {
				decision,
				policyDecision: "approve",
				reason: "matched approval rule",
			};
		});

		const config = makeConfig();
		config.claude.permission_mode = "bypassPermissions";
		const sm = new SessionManager(
			config,
			makeProviders(
				makeProvider("Bash", "tid-1", undefined, "workflow-child-2"),
			),
		);
		const emitted: ServerMessage[] = [];
		const turn = sm.runQuery("hello", (event) => emitted.push(event), {
			sessionId: "sess-1",
		});

		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "permission_request",
				id: "tid-1",
				displayName: "Shell command",
				requester: {
					providerId: "claude",
					agentId: "workflow-child-2",
				},
				policy: {
					source: "umbod",
					reason: "matched approval rule",
				},
			}),
		);

		sm.handlePermissionResponse("tid-1", true);
		await turn;
	});

	it("session approval: same tool auto-approved on next turn without prompting", async () => {
		let callCount = 0;
		const multiTurnProvider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				callCount++;
				const toolUseID = `tid-turn${callCount}`;
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					await params.canUseTool(
						"Bash",
						{},
						{ toolUseID, signal: new AbortController().signal },
					);
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(multiTurnProvider),
		);

		// Turn 1: permission_request emitted, user approves for session
		const turn1Events: unknown[] = [];
		const turn1 = sm.runQuery("hello", (m) => turn1Events.push(m), {
			sessionId: "sess-1",
		});
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(
			turn1Events.some(
				(m) => (m as { type: string }).type === "permission_request",
			),
		).toBe(true);
		sm.handlePermissionResponse("tid-turn1", true, "session");
		await turn1;

		// Turn 2: Bash in sessionAllowedTools — canUseTool auto-approves, no prompt
		const turn2Events: unknown[] = [];
		await sm.runQuery("hello again", (m) => turn2Events.push(m), {
			sessionId: "sess-1",
		});
		expect(
			turn2Events.some(
				(m) => (m as { type: string }).type === "permission_request",
			),
		).toBe(false);
		expect(sm.getPendingPermissionRequests()).toHaveLength(0);
	});

	it("clearHistory clears session allowlist — tool prompts again after clear", async () => {
		const provider = makeProvider("Bash");
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		const turn1 = sm.runQuery("hello", () => {}, {
			sessionId: "sess-1",
		});
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		sm.handlePermissionResponse("tid-1", true, "session");
		await turn1;

		sm.clearHistory();

		const provider2 = makeProvider("Bash", "tid-2");
		const sm2 = new SessionManager(makeConfig(), makeProviders(provider2));
		// sm2 has clean state — should prompt for Bash
		const emittedTurn2: unknown[] = [];
		const turn2 = sm2.runQuery("new session msg", (m) => emittedTurn2.push(m), {
			sessionId: "sess-2",
		});
		await waitFor(() =>
			expect(sm2.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(
			emittedTurn2.some(
				(m) => (m as { type: string }).type === "permission_request",
			),
		).toBe(true);

		sm2.handlePermissionResponse("tid-2", false);
		await turn2;
	});

	it("reinitialize clears session allowlist", async () => {
		const provider = makeProvider("Read");
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		const turn1 = sm.runQuery("hello", () => {}, {
			sessionId: "sess-1",
		});
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		sm.handlePermissionResponse("tid-1", true, "session");
		await turn1;

		sm.reinitialize(makeConfig());

		// After reinitialize, sessionAllowedTools is cleared.
		// A new runQuery with a provider that calls canUseTool should prompt again.
		const provider2 = makeProvider("Read", "tid-2");
		const sm2 = new SessionManager(makeConfig(), makeProviders(provider2));
		const emittedTurn2: unknown[] = [];
		const turn2 = sm2.runQuery("after reinit", (m) => emittedTurn2.push(m), {
			sessionId: "sess-2",
		});
		await waitFor(() =>
			expect(sm2.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(
			emittedTurn2.some(
				(m) => (m as { type: string }).type === "permission_request",
			),
		).toBe(true);

		sm2.handlePermissionResponse("tid-2", false);
		await turn2;
	});

	it("deny does not add tool to session allowlist", async () => {
		const provider = makeProvider("Bash");
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		const turn1 = sm.runQuery("hello", () => {}, {
			sessionId: "sess-1",
		});
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		sm.handlePermissionResponse("tid-1", false);
		await turn1;

		// Second turn: should still prompt (not auto-allowed)
		const emittedTurn2: unknown[] = [];
		const provider2 = makeProvider("Bash", "tid-2");
		const sm2 = new SessionManager(makeConfig(), makeProviders(provider2));
		const turn2 = sm2.runQuery("again", (m) => emittedTurn2.push(m), {
			sessionId: "sess-1",
		});
		await waitFor(() =>
			expect(sm2.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(
			emittedTurn2.some(
				(m) => (m as { type: string }).type === "permission_request",
			),
		).toBe(true);

		sm2.handlePermissionResponse("tid-2", false);
		await turn2;
	});

	it("deny with custom message sends that message to canUseTool resolver", async () => {
		let capturedResult: unknown;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					capturedResult = await params.canUseTool(
						"Bash",
						{},
						{
							toolUseID: "tid-1",
							signal: new AbortController().signal,
						},
					);
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const turn1 = sm.runQuery("hello", () => {}, {
			sessionId: "sess-1",
		});
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		sm.handlePermissionResponse("tid-1", false, undefined, "use Read instead");
		await turn1;

		expect(capturedResult).toEqual({
			behavior: "deny",
			message: "use Read instead",
		});
	});

	it("deny without custom message uses default 'Denied by user'", async () => {
		let capturedResult: unknown;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					capturedResult = await params.canUseTool(
						"Bash",
						{},
						{
							toolUseID: "tid-1",
							signal: new AbortController().signal,
						},
					);
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const turn1 = sm.runQuery("hello", () => {}, {
			sessionId: "sess-1",
		});
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		sm.handlePermissionResponse("tid-1", false);
		await turn1;

		expect(capturedResult).toEqual({
			behavior: "deny",
			message: "Denied by user",
		});
	});

	it("local ('always') approval writes tool to settings.local.json", async () => {
		vi.mocked(fsMock.writeFileSync).mockClear();
		vi.mocked(fsMock.readFileSync).mockClear();

		let decision: AgentToolDecision | undefined;
		const provider = makeProvider("Bash", "tid-1", (value) => {
			decision = value;
		});
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		const turn1 = sm.runQuery("hello", () => {}, {
			sessionId: "sess-1",
		});
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);

		sm.handlePermissionResponse("tid-1", true, "local");
		await turn1;
		expect(decision).toEqual({
			behavior: "allow",
			updatedInput: {},
			saveScope: "local",
		});

		expect(vi.mocked(fsMock.writeFileSync)).toHaveBeenCalledWith(
			expect.stringContaining(".claude/settings.local.json."),
			expect.stringContaining('"Bash"'),
			expect.objectContaining({ encoding: "utf8", mode: 0o600 }),
		);
		expect(vi.mocked(fsMock.renameSync)).toHaveBeenCalledWith(
			expect.stringContaining(".claude/settings.local.json."),
			expect.stringContaining(".claude/settings.local.json"),
		);
		const calls = vi.mocked(fsMock.writeFileSync).mock.calls;
		expect(
			calls.some(
				([p]) =>
					typeof p === "string" &&
					p.endsWith("settings.json") &&
					!p.endsWith("settings.local.json"),
			),
		).toBe(false);
	});

	it("query params include 'local' in settingSources", async () => {
		let capturedSettingSources: unknown;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				capturedSettingSources = params.settingSources;
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-1",
		});

		expect(capturedSettingSources).toContain("local");
	});
});

// ── summary passed to generateTurnRecap ───────────────────────────────────────
