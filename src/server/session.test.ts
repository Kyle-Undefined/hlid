/**
 * SessionManager unit tests — state machine, config methods, and
 * session-scoped permission persistence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, HlidConfig } from "../config";

// ── module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock("./config", () => ({ loadConfig: vi.fn() }));
vi.mock("./agentPaths", () => ({
	computeAllowedAgentRealPaths: vi.fn().mockReturnValue([]),
	isAllowedAgentPath: vi.fn().mockReturnValue(false),
	resolveAgentMode: vi.fn().mockReturnValue("cwd"),
}));
vi.mock("../lib/claudePath", () => ({
	resolveClaudeExecutable: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../db", () => ({
	clearCurrentSessionId: vi.fn().mockResolvedValue(undefined),
	setCurrentSessionId: vi.fn().mockResolvedValue(undefined),
	appendMessage: vi.fn().mockResolvedValue(undefined),
	appendToolEvent: vi.fn().mockResolvedValue(undefined),
	appendPlanProposal: vi.fn().mockResolvedValue(undefined),
	setPlanProposalDecision: vi.fn().mockResolvedValue(undefined),
	appendAskUserQuestion: vi.fn().mockResolvedValue(undefined),
	setAskUserQuestionResolution: vi.fn().mockResolvedValue(undefined),
	setMessageText: vi.fn().mockResolvedValue(undefined),
	setMessageRecap: vi.fn().mockResolvedValue(undefined),
	setToolEventResult: vi.fn().mockResolvedValue(undefined),
	setToolEventSubagent: vi.fn().mockResolvedValue(undefined),
	appendLog: vi.fn().mockResolvedValue(undefined),
	createSession: vi.fn().mockResolvedValue(undefined),
	recordQuery: vi.fn().mockResolvedValue(undefined),
	getSessionById: vi.fn().mockResolvedValue(null),
	getSessionMessages: vi.fn().mockResolvedValue([]),
	getSessionNextMessageSeq: vi.fn().mockResolvedValue(0),
	getSessionAgentCwd: vi.fn().mockResolvedValue(null),
	getSessionModel: vi.fn().mockResolvedValue(null),
	getSessionProviderId: vi.fn().mockResolvedValue(null),
	getSessionProviderSession: vi.fn().mockResolvedValue(null),
	getSessionClaudeId: vi.fn().mockResolvedValue(null),
	setSessionProviderId: vi.fn().mockResolvedValue(undefined),
	setSessionProviderSession: vi.fn().mockResolvedValue(undefined),
	setSessionClaudeId: vi.fn().mockResolvedValue(undefined),
	setSessionActualModel: vi.fn().mockResolvedValue(undefined),
	setSessionAgentCwd: vi.fn().mockResolvedValue(undefined),
	setSessionModel: vi.fn().mockResolvedValue(undefined),
	saveSetting: vi.fn().mockResolvedValue(undefined),
	linkAttachmentToMessage: vi.fn().mockResolvedValue(undefined),
	recordPermissionEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./recap", () => ({
	generateTurnRecap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./umbod", () => ({
	authorizeHlidTool: vi.fn().mockResolvedValue(null),
	registerUmbodApprovalSession: vi.fn(() => vi.fn()),
}));
vi.mock("./executionContext", () => ({
	resolveExecutionContext: vi.fn().mockReturnValue({
		activeCwd: "/tmp/hlid-test-cwd",
		extraDirs: new Set(),
		executable: undefined,
	}),
}));
vi.mock("./promptBuilder", () => ({
	buildPlanHtmlInstructions: vi.fn((path: string) => `HTML plan: ${path}`),
	buildPrompt: vi.fn().mockReturnValue({
		prompt: "test prompt",
		safeAttachments: [],
	}),
}));
vi.mock("node:fs", () => ({
	mkdirSync: vi.fn(),
	readFileSync: vi.fn((path: string) => {
		if (typeof path === "string" && path.includes("settings.json")) {
			return "{}";
		}
		return "{}";
	}),
	writeFileSync: vi.fn(),
	renameSync: vi.fn(),
	rmSync: vi.fn(),
	realpathSync: vi.fn((p: string) => p),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import * as fsMock from "node:fs";
import * as dbMock from "../db";
import * as agentPathsMock from "./agentPaths";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	AgentToolDecision,
	McpServerStatus,
} from "./agentProvider";
import { loadConfig } from "./config";
import type { RateLimitMessage, ServerMessage } from "./protocol";
import { getWindowMark } from "./proxy";
import { generateTurnRecap } from "./recap";
import { SessionManager } from "./session";
import { authorizeHlidTool, registerUmbodApprovalSession } from "./umbod";
import {
	evaluateSleep,
	reportRateLimitSignal,
	_resetForTests as resetUsageGate,
} from "./usageGate";

// Bun doesn't support waitFor() — poll until assertion passes or timeout
async function waitFor(fn: () => void, timeout = 1000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			fn();
			return;
		} catch {
			/* keep polling */
		}
		await new Promise((r) => setTimeout(r, 10));
	}
	fn(); // final attempt — throws if still failing
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(model = "claude-test"): HlidConfig {
	return {
		claude: {
			model,
			effort: "medium",
			permission_mode: "default",
			turn_recaps: false,
		},
		vault: { path: "/tmp/hlid-test-vault", name: "Test" },
		agents: [],
	} as unknown as HlidConfig;
}

/** Wrap a single AgentProvider in the Map the SessionManager constructor expects. */
function makeProviders(provider: AgentProvider): Map<string, AgentProvider> {
	return new Map([[provider.providerId, provider]]);
}

/** Build a mock AgentProvider whose query() calls canUseTool once for toolName. */
function makeProvider(
	toolName: string,
	toolUseID = "tid-1",
	onDecision?: (decision: AgentToolDecision) => void,
): AgentProvider {
	return {
		providerId: "claude",
		query(params: AgentQueryParams): AgentSession {
			const gen = (async function* (): AsyncGenerator<AgentEvent> {
				yield { type: "session_start", sessionId: "sdk-session-1" };
				const decision = await params.canUseTool(
					toolName,
					{},
					{
						toolUseID,
						signal: new AbortController().signal,
						title: undefined,
						displayName: undefined,
						description: undefined,
					},
				);
				onDecision?.(decision);
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
}

// ── getStatus / initial state ─────────────────────────────────────────────────

describe("SessionManager — initial state", () => {
	it("reports idle state and configured model", () => {
		const sm = new SessionManager(
			makeConfig("model-x"),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.getStatus()).toEqual({
			state: "idle",
			model: "model-x",
			permission_mode: "default",
			effort: "medium",
		});
	});

	it("isRunning() returns false initially", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.isRunning()).toBe(false);
	});

	it("getLastMcpStatus() returns null initially", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.getLastMcpStatus()).toBeNull();
	});

	it("getCurrentSessionId() returns null initially", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.getCurrentSessionId()).toBeNull();
	});

	it("getPendingPermissionRequests() returns empty array initially", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.getPendingPermissionRequests()).toEqual([]);
	});
});

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
		await sm.runQuery("hello", (event) => emitted.push(event), "db-session");
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
				inputs: { command: "git status" },
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
				description: "matched approval rule",
			}),
		);
		sm.handlePermissionResponse("hook-tool-1", true);
		await expect(approval).resolves.toBe("allow");
	});
});

// ── restoreMcpStatus ──────────────────────────────────────────────────────────

describe("SessionManager — restoreMcpStatus", () => {
	it("sets and retrieves MCP status", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		const statuses = [{ name: "my-server", status: "connected" as const }];
		sm.restoreMcpStatus(statuses);
		expect(sm.getLastMcpStatus()).toEqual(statuses);
	});

	it("replaces previous MCP status on second call", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.restoreMcpStatus([{ name: "a", status: "connected" }]);
		sm.restoreMcpStatus([{ name: "b", status: "failed" }]);
		const last = sm.getLastMcpStatus();
		expect(last).not.toBeNull();
		expect(last?.[0].name).toBe("b");
	});

	it("keeps cached MCP snapshots isolated by provider", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.restoreMcpStatus(
			[{ name: "claude.ai Excalidraw", status: "connected" }],
			"claude",
		);
		sm.restoreMcpStatus([{ name: "github", status: "connected" }], "codex");

		expect(sm.getLastMcpStatus("claude")?.[0].name).toBe(
			"claude.ai Excalidraw",
		);
		expect(sm.getLastMcpStatus("codex")?.[0].name).toBe("github");
	});
});

// ── syncConfig ────────────────────────────────────────────────────────────────

describe("SessionManager — syncConfig", () => {
	it("returns false when model unchanged", () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.syncConfig(makeConfig("model-a"))).toBe(false);
	});

	it("returns true when model changes", () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.syncConfig(makeConfig("model-b"))).toBe(true);
	});

	it("updates model in getStatus after syncConfig", () => {
		const sm = new SessionManager(
			makeConfig("old-model"),
			makeProviders(makeProvider("Bash")),
		);
		sm.syncConfig(makeConfig("new-model"));
		expect(sm.getStatus().model).toBe("new-model");
	});

	it("updates effort and permission defaults when no session override exists", () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		const next = makeConfig("model-a");
		next.claude.effort = "high";
		next.claude.permission_mode = "acceptEdits";

		expect(sm.syncConfig(next)).toBe(true);
		expect(sm.getStatus()).toMatchObject({
			model: "model-a",
			effort: "high",
			permission_mode: "acceptEdits",
		});
	});

	it("preserves explicit session picker overrides across config refreshes", async () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		await sm.setModel("session-model");
		await sm.setEffort("xhigh");
		await sm.setPermissionMode("bypassPermissions");
		const next = makeConfig("model-b");
		next.claude.effort = "low";
		next.claude.permission_mode = "acceptEdits";

		expect(sm.syncConfig(next)).toBe(false);
		expect(sm.getStatus()).toMatchObject({
			model: "session-model",
			effort: "xhigh",
			permission_mode: "bypassPermissions",
		});
	});

	it("does not reset session state (non-destructive update)", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.syncConfig(makeConfig("new-model"));
		expect(sm.getStatus().state).toBe("idle");
		expect(sm.getCurrentSessionId()).toBeNull();
	});

	it("updates Computer Use preferences on an already-open Codex session", async () => {
		const setWindowsComputerUse = vi.fn().mockResolvedValue(undefined);
		const { provider } = makeSwitchableProvider(
			{ setWindowsComputerUse },
			"codex",
		);
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
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("hi", () => {}, "live-computer-use-config");

		const next = structuredClone(config);
		next.codex.windows_computer_use = { model: "gpt-5.4", effort: "high" };
		sm.syncConfig(next);

		expect(setWindowsComputerUse).toHaveBeenCalledWith({
			model: "gpt-5.4",
			effort: "high",
		});
	});
});

// ── setModel / setPermissionMode / getAccountInfo ─────────────────────────────

/** Build a fake single-turn AgentProvider whose session exposes the given optional methods. */
function makeSwitchableProvider(
	sessionOverrides: Partial<AgentSession> = {},
	providerId = "claude",
): {
	provider: AgentProvider;
	getSession: () => AgentSession | undefined;
} {
	let session: AgentSession | undefined;
	const provider: AgentProvider = {
		providerId,
		query(): AgentSession {
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
			session = {
				[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
				cancel: vi.fn(),
				send: vi.fn().mockResolvedValue(undefined),
				...sessionOverrides,
			};
			return session;
		},
	};
	return { provider, getSession: () => session };
}

describe("SessionManager — setModel", () => {
	it("updates getStatus().model with no active AgentSession (no-op delegate)", async () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		await sm.setModel("model-b");
		expect(sm.getStatus().model).toBe("model-b");
	});

	it("resets to the provider default (empty string) when called with undefined", async () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		await sm.setModel(undefined);
		expect(sm.getStatus().model).toBe("");
	});

	it("delegates to the active AgentSession's setModel", async () => {
		const setModel = vi.fn().mockResolvedValue(undefined);
		const { provider, getSession } = makeSwitchableProvider({ setModel });
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(provider),
		);
		await sm.runQuery("hi", () => {}, "sess-1");

		await sm.setModel("model-b");
		expect(getSession()?.setModel).toHaveBeenCalledWith("model-b");
		expect(sm.getStatus().model).toBe("model-b");
		expect(dbMock.setSessionModel).toHaveBeenCalledWith("sess-1", "model-b");
	});

	it("restores a saved session model instead of the current config model", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		vi.mocked(dbMock.getSessionModel).mockResolvedValueOnce("claude-fable-5");
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "prior" },
		] as never);
		const sm = new SessionManager(
			makeConfig("gpt-5.6-sol"),
			makeProviders(provider),
		);

		await sm.runQuery("continue", () => {}, "saved-session");

		expect(captured.params?.model).toBe("claude-fable-5");
		expect(sm.getStatus().model).toBe("claude-fable-5");
	});

	it("restores a saved session label into live status", async () => {
		const { provider } = makeCaptureProvider("claude");
		vi.mocked(dbMock.getSessionById).mockResolvedValueOnce({
			id: "saved-session",
			label: "MY SAVED NAME",
		} as never);
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "prior" },
		] as never);
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		let labelWhileRunning: string | null | undefined;

		await sm.runQuery(
			"continue",
			(event) => {
				if (event.type === "status" && event.state === "running") {
					labelWhileRunning = sm.getSessionLabel();
				}
			},
			"saved-session",
		);

		expect(labelWhileRunning).toBe("MY SAVED NAME");
		expect(sm.getSessionLabel()).toBe("MY SAVED NAME");
	});

	it("resumes after the maximum persisted transcript sequence", async () => {
		const { provider } = makeCaptureProvider("claude");
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "prior" },
		] as never);
		vi.mocked(dbMock.getSessionNextMessageSeq).mockResolvedValueOnce(8);
		vi.mocked(dbMock.appendMessage).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("continue", () => {}, "saved-session");

		expect(dbMock.getSessionMessages).toHaveBeenCalledWith(
			"saved-session",
			undefined,
			1,
		);
		expect(dbMock.appendMessage).toHaveBeenCalledWith(
			"saved-session",
			8,
			"user",
			"continue",
		);
	});
});

describe("SessionManager — setProvider", () => {
	it("switches CLI per chat and hands the persisted transcript to the new provider", async () => {
		const claudeSend = vi.fn().mockResolvedValue(undefined);
		const piSend = vi.fn().mockResolvedValue(undefined);
		const makeCli = (providerId: string, send: AgentSession["send"]) => ({
			providerId,
			query: (): AgentSession => {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: `${providerId}-session` };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send,
				};
			},
		});
		const sm = new SessionManager(
			makeConfig("claude-sonnet-4-6"),
			new Map([
				["claude", makeCli("claude", claudeSend)],
				["pi", makeCli("pi", piSend)],
			]),
		);

		await sm.runQuery("first", () => {}, "switch-chat");
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "first" },
			{ role: "assistant", text: "prior answer" },
		] as never);
		await sm.setProvider("pi", {
			model: "pi-pro",
			effort: "medium",
			permissionMode: "default",
		});
		await sm.runQuery("continue", () => {}, "switch-chat");

		expect(claudeSend).toHaveBeenCalledTimes(1);
		expect(piSend).toHaveBeenCalledTimes(1);
		expect(piSend.mock.calls[0]?.[0]).toContain("<hlid_provider_handoff>");
		expect(piSend.mock.calls[0]?.[0]).toContain("USER: first");
		expect(piSend.mock.calls[0]?.[0]).toContain("ASSISTANT: prior answer");
		expect(piSend.mock.calls[0]?.[0]).toContain("test prompt");
		expect(dbMock.setSessionProviderId).toHaveBeenCalledWith(
			"switch-chat",
			"pi",
		);
		expect(dbMock.setSessionModel).toHaveBeenCalledWith(
			"switch-chat",
			"pi-pro",
		);
	});

	it("rejects unavailable CLI identifiers", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		await expect(sm.setProvider("missing")).rejects.toThrow(
			"Unknown or unavailable provider: missing",
		);
	});
});

describe("SessionManager — setEffort", () => {
	it("updates getStatus().effort with no active AgentSession", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		await sm.setEffort("xhigh");
		expect(sm.getStatus().effort).toBe("xhigh");
	});

	it("delegates live effort changes without rebuilding a capable provider", async () => {
		const setEffort = vi.fn().mockResolvedValue(undefined);
		const { provider, getSession } = makeSwitchableProvider({ setEffort });
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("first", () => {}, "live-effort");
		const firstSession = getSession();

		await sm.setEffort("xhigh");
		await sm.runQuery("second", () => {}, "live-effort");

		expect(getSession()?.setEffort).toHaveBeenCalledWith("xhigh");
		expect(getSession()).toBe(firstSession);
	});

	it("rebuilds and resumes Claude on the next turn when effort changes", async () => {
		const params: AgentQueryParams[] = [];
		const cancels: ReturnType<typeof vi.fn>[] = [];
		const provider: AgentProvider = {
			providerId: "claude",
			query(queryParams): AgentSession {
				params.push(queryParams);
				const index = params.length;
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: `claude-session-${index}` };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				const cancel = vi.fn();
				cancels.push(cancel);
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel,
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("first", () => {}, "claude-effort");

		await sm.setEffort("max");
		await sm.runQuery("second", () => {}, "claude-effort");

		expect(params).toHaveLength(2);
		expect(cancels[0]).toHaveBeenCalledOnce();
		expect(params[1]).toMatchObject({
			effort: "max",
			sessionId: "claude-session-1",
		});
	});
});

describe("SessionManager — per-turn plan mode", () => {
	it("synchronizes plan mode on a cached provider session", async () => {
		const setPermissionMode = vi.fn().mockResolvedValue(undefined);
		const setPlanHtmlPath = vi.fn();
		const { provider } = makeSwitchableProvider({
			setPermissionMode,
			setPlanHtmlPath,
		});
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery(
			"plan this",
			() => {},
			"session-plan-toggle",
			undefined,
			undefined,
			undefined,
			undefined,
			true,
			true,
		);
		await sm.runQuery(
			"continue normally",
			() => {},
			"session-plan-toggle",
			undefined,
			undefined,
			undefined,
			undefined,
			false,
		);

		expect(setPermissionMode).toHaveBeenNthCalledWith(1, "plan");
		expect(setPermissionMode).toHaveBeenNthCalledWith(2, "default");
		expect(setPlanHtmlPath).toHaveBeenNthCalledWith(
			1,
			"/tmp/hlid-test-vault/.hlid/plans/plan-session-plan-toggle.html",
		);
		expect(setPlanHtmlPath).toHaveBeenNthCalledWith(2, undefined);
	});
});

describe("SessionManager — provider usage refresh", () => {
	it("emits authoritative live provider context before the result boundary", async () => {
		const contextUsage = vi.fn().mockResolvedValue({
			contextTokens: 110_882,
			contextWindow: 1_000_000,
			model: "claude-fable-5",
		});
		const { provider } = makeSwitchableProvider({ contextUsage });
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("hello", (message) => emitted.push(message), "fable");

		expect(emitted).toContainEqual({
			type: "context_update",
			tokens_in_context: 110_882,
			context_window: 1_000_000,
			actualModel: "claude-fable-5",
		});
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "done",
				tokens_in_context: 110_882,
				context_window: 1_000_000,
			}),
		);
	});

	it("refreshes and stores structured usage after a successful turn", async () => {
		const usageWindows = vi.fn().mockResolvedValue([
			{
				windowId: "five_hour",
				label: "5-HOUR",
				utilization: 0.42,
				remaining: null,
				limit: null,
				resetsAt: 1_900_000_000,
			},
		]);
		const { provider } = makeSwitchableProvider({ usageWindows });
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("hello", () => {}, "usage-refresh-session");

		// One live seed when the stream starts, then the authoritative completed-
		// turn reconciliation before `done` reaches the client.
		expect(usageWindows).toHaveBeenCalledTimes(2);
		expect(getWindowMark("claude", "five_hour")).toMatchObject({
			utilization: 0.42,
			resetsAt: 1_900_000_000,
		});
		expect(dbMock.saveSetting).toHaveBeenCalledWith(
			"rl_claude_five_hour",
			expect.stringContaining('"utilization":0.42'),
		);
	});

	it("refreshes structured usage while a turn is still running", async () => {
		vi.useFakeTimers();
		let finishTurn = () => {};
		const turnHeld = new Promise<void>((resolve) => {
			finishTurn = resolve;
		});
		let firstRefreshStarted = () => {};
		const firstRefresh = new Promise<void>((resolve) => {
			firstRefreshStarted = resolve;
		});
		let refreshCount = 0;
		const resetsAt = Math.floor(Date.now() / 1000) + 3600;
		const usageWindows = vi.fn(async () => {
			refreshCount += 1;
			if (refreshCount === 1) firstRefreshStarted();
			return [
				{
					windowId: "five_hour",
					label: "5-HOUR",
					utilization: refreshCount === 1 ? 0.2 : 0.91,
					remaining: null,
					limit: null,
					resetsAt,
				},
			];
		});
		const provider: AgentProvider = {
			providerId: "live-usage-test",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "live-usage-sdk" };
					await turnHeld;
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 5_000,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					usageWindows,
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const running = sm.runQuery("hello", () => {}, "live-usage-session");

		try {
			await firstRefresh;
			await vi.advanceTimersByTimeAsync(0);
			expect(getWindowMark("live-usage-test", "five_hour")).toMatchObject({
				utilization: 0.2,
				resetsAt,
			});

			await vi.advanceTimersByTimeAsync(5_000);
			expect(usageWindows).toHaveBeenCalledTimes(2);
			expect(getWindowMark("live-usage-test", "five_hour")).toMatchObject({
				utilization: 0.91,
				resetsAt,
			});
			expect(
				evaluateSleep("live-usage-test", {
					enabled: true,
					threshold: 0.9,
					max_sleep_minutes: 360,
					resume_buffer_seconds: 30,
				}),
			).toMatchObject({ reason: "threshold", utilization: 0.91 });

			finishTurn();
			await running;
			expect(usageWindows).toHaveBeenCalledTimes(3);
		} finally {
			finishTurn();
			await running;
			vi.useRealTimers();
		}
	});

	it("does not fail a successful turn when usage refresh rejects", async () => {
		const usageWindows = vi.fn().mockRejectedValue(new Error("unsupported"));
		const { provider } = makeSwitchableProvider({ usageWindows });
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await expect(
			sm.runQuery("hello", () => {}, "usage-refresh-fallback"),
		).resolves.toBeUndefined();
		expect(sm.getStatus().state).toBe("idle");
	});
});

describe("SessionManager — setPermissionMode", () => {
	it("rejects an unknown mode without mutating state", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		await expect(sm.setPermissionMode("bogus")).rejects.toThrow(
			"Unknown permission mode: bogus",
		);
		expect(sm.getStatus().permission_mode).toBe("default");
	});

	it("updates getStatus().permission_mode and delegates to the active AgentSession", async () => {
		const setPermissionMode = vi.fn().mockResolvedValue(undefined);
		const { provider, getSession } = makeSwitchableProvider({
			setPermissionMode,
		});
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hi", () => {}, "sess-1");

		await sm.setPermissionMode("acceptEdits");
		expect(getSession()?.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
		expect(sm.getStatus().permission_mode).toBe("acceptEdits");
	});
});

describe("SessionManager — getAccountInfo", () => {
	it("returns null with no active AgentSession", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(await sm.getAccountInfo()).toBeNull();
	});

	it("returns null when the active provider doesn't expose accountInfo", async () => {
		const { provider } = makeSwitchableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hi", () => {}, "sess-1");
		expect(await sm.getAccountInfo()).toBeNull();
	});

	it("delegates to the active AgentSession's accountInfo", async () => {
		const accountInfo = vi.fn().mockResolvedValue({
			email: "kyle@example.com",
			subscriptionType: "max",
		});
		const { provider } = makeSwitchableProvider({ accountInfo });
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hi", () => {}, "sess-1");

		expect(await sm.getAccountInfo()).toEqual({
			email: "kyle@example.com",
			subscriptionType: "max",
		});
	});

	it("returns null when the AgentSession's accountInfo call fails", async () => {
		const accountInfo = vi.fn().mockRejectedValue(new Error("not logged in"));
		const { provider } = makeSwitchableProvider({ accountInfo });
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hi", () => {}, "sess-1");

		expect(await sm.getAccountInfo()).toBeNull();
	});
});

// ── clearHistory ──────────────────────────────────────────────────────────────

describe("SessionManager — clearHistory", () => {
	it("does not throw", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(() => sm.clearHistory()).not.toThrow();
	});

	it("session remains idle after clearHistory", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.clearHistory();
		expect(sm.getStatus().state).toBe("idle");
	});

	it("calls db.clearCurrentSessionId", () => {
		vi.mocked(dbMock.clearCurrentSessionId).mockClear();
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.clearHistory();
		expect(vi.mocked(dbMock.clearCurrentSessionId)).toHaveBeenCalled();
	});
});

// ── abort ─────────────────────────────────────────────────────────────────────

describe("SessionManager — abort", () => {
	it("does not throw when no query is running", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(() => sm.abort()).not.toThrow();
	});

	it("state remains idle after abort when not running", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.abort();
		expect(sm.getStatus().state).toBe("idle");
	});
});

// ── reinitialize ──────────────────────────────────────────────────────────────

describe("SessionManager — reinitialize", () => {
	it("applies new config", () => {
		const sm = new SessionManager(
			makeConfig("old-model"),
			makeProviders(makeProvider("Bash")),
		);
		sm.reinitialize(makeConfig("fresh-model"));
		expect(sm.getStatus().model).toBe("fresh-model");
	});

	it("resets state to idle", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.reinitialize(makeConfig());
		expect(sm.getStatus().state).toBe("idle");
	});

	it("clears currentSessionId", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.reinitialize(makeConfig());
		expect(sm.getCurrentSessionId()).toBeNull();
	});
});

// ── AskUserQuestion support ───────────────────────────────────────────────────

describe("SessionManager — AskUserQuestion", () => {
	it("getPendingAskUserQuestions() returns empty array initially", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.getPendingAskUserQuestions()).toEqual([]);
	});

	it("handleAskUserQuestionResponse() does not throw when id is unknown", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(() =>
			sm.handleAskUserQuestionResponse("ghost-id", { Q: ["Option A"] }),
		).not.toThrow();
	});

	it("abort() clears all pending ask_user_questions", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.abort();
		expect(sm.getPendingAskUserQuestions()).toEqual([]);
	});

	// SDK contract: AskUserQuestionOutput.answers is keyed by question text.
	// A flat `answer` field caused the SDK to fall back to a default option
	// (often the last), making the model act on the wrong choice.
	it("canUseTool resolves AskUserQuestion with answers map keyed by question text", async () => {
		const QUESTION = "Which library?";
		const SELECTED = "React";
		const askInput = {
			questions: [
				{
					question: QUESTION,
					header: "Library",
					options: [
						{ label: "React", description: "Popular UI lib" },
						{ label: "Vue", description: "Progressive framework" },
					],
					multiSelect: false,
				},
			],
		};

		let capturedResult: unknown;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					capturedResult = await params.canUseTool(
						"AskUserQuestion",
						askInput,
						{ toolUseID: "tid-ask-1", signal: new AbortController().signal },
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
		const turn = sm.runQuery("hello", () => {}, "sess-1");
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);

		// Persistence: the pending question is written to DB on emit so it
		// survives reload and is visible from any device that loads the session.
		expect(vi.mocked(dbMock.appendAskUserQuestion)).toHaveBeenCalledWith(
			"sess-1",
			"tid-ask-1",
			expect.any(Number),
			expect.stringContaining(QUESTION),
		);

		sm.handleAskUserQuestionResponse("tid-ask-1", { [QUESTION]: [SELECTED] });
		await turn;

		expect(capturedResult).toEqual({
			behavior: "allow",
			updatedInput: {
				...askInput,
				answers: { [QUESTION]: SELECTED },
			},
		});
		expect(
			(capturedResult as { updatedInput: Record<string, unknown> }).updatedInput
				.answer,
		).toBeUndefined();
	});

	it("canUseTool merges into any pre-existing answers map", async () => {
		const QUESTION = "Pick one";
		const SELECTED = "B";
		const askInput = {
			questions: [
				{
					question: QUESTION,
					header: "Pick",
					options: [{ label: "A" }, { label: "B" }],
					multiSelect: false,
				},
			],
			answers: { "Earlier question?": "Yes" },
		};

		let capturedResult: unknown;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					capturedResult = await params.canUseTool(
						"AskUserQuestion",
						askInput,
						{ toolUseID: "tid-ask-2", signal: new AbortController().signal },
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
		const turn = sm.runQuery("hi", () => {}, "sess-1");
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);

		sm.handleAskUserQuestionResponse("tid-ask-2", { [QUESTION]: [SELECTED] });
		await turn;

		const updated = (
			capturedResult as { updatedInput: { answers: Record<string, string> } }
		).updatedInput;
		expect(updated.answers).toEqual({
			"Earlier question?": "Yes",
			[QUESTION]: SELECTED,
		});
	});

	it("emits ask_user_question event with parsed question and option labels", async () => {
		const askInput = {
			questions: [
				{
					question: "Which framework?",
					header: "Framework",
					options: [
						{ label: "Next.js", description: "React meta-framework" },
						{ label: "Remix", description: "Web standards focused" },
						{ label: "SvelteKit", description: "Svelte meta-framework" },
					],
					multiSelect: false,
				},
			],
		};

		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					await params.canUseTool("AskUserQuestion", askInput, {
						toolUseID: "tid-ask-3",
						signal: new AbortController().signal,
					});
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

		const emitted: unknown[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const turn = sm.runQuery("hi", (m) => emitted.push(m), "sess-1");
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);

		sm.handleAskUserQuestionResponse("tid-ask-3", {
			"Which framework?": ["Remix"],
		});
		await turn;

		const askEvent = emitted.find(
			(m) => (m as { type: string }).type === "ask_user_question",
		) as
			| {
					questions: Array<{
						question: string;
						options: string[];
						multiSelect: boolean;
					}>;
			  }
			| undefined;
		expect(askEvent).toBeDefined();
		expect(askEvent?.questions).toHaveLength(1);
		expect(askEvent?.questions[0].question).toBe("Which framework?");
		expect(askEvent?.questions[0].options).toEqual([
			"Next.js",
			"Remix",
			"SvelteKit",
		]);
		expect(askEvent?.questions[0].multiSelect).toBe(false);
	});

	// Multi-question support — single AskUserQuestion call with N questions.
	it("canUseTool resolves multi-question input with all answers comma-joined per question", async () => {
		const askInput = {
			questions: [
				{
					question: "First?",
					header: "Q1",
					options: [{ label: "Yes" }, { label: "No" }],
					multiSelect: false,
				},
				{
					question: "Second?",
					header: "Q2",
					options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
					multiSelect: true,
				},
			],
		};

		let capturedResult: unknown;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					capturedResult = await params.canUseTool(
						"AskUserQuestion",
						askInput,
						{ toolUseID: "tid-multi", signal: new AbortController().signal },
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
		const turn = sm.runQuery("hi", () => {}, "sess-1");
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);

		// Single-select Q1 picks one; multiSelect Q2 picks two.
		sm.handleAskUserQuestionResponse("tid-multi", {
			"First?": ["Yes"],
			"Second?": ["Alpha", "Gamma"],
		});
		await turn;

		const updated = (
			capturedResult as { updatedInput: { answers: Record<string, string> } }
		).updatedInput;
		expect(updated.answers).toEqual({
			"First?": "Yes",
			"Second?": "Alpha, Gamma",
		});
	});

	it("emits ask_user_question event carrying every question and its multiSelect flag", async () => {
		const askInput = {
			questions: [
				{
					question: "Single?",
					header: "S",
					options: [{ label: "A" }, { label: "B" }],
					multiSelect: false,
				},
				{
					question: "Multi?",
					header: "M",
					options: [{ label: "X" }, { label: "Y" }],
					multiSelect: true,
				},
			],
		};

		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					await params.canUseTool("AskUserQuestion", askInput, {
						toolUseID: "tid-multi-emit",
						signal: new AbortController().signal,
					});
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

		const emitted: unknown[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const turn = sm.runQuery("hi", (m) => emitted.push(m), "sess-1");
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);

		sm.handleAskUserQuestionResponse("tid-multi-emit", {
			"Single?": ["A"],
			"Multi?": ["X", "Y"],
		});
		await turn;

		const askEvent = emitted.find(
			(m) => (m as { type: string }).type === "ask_user_question",
		) as
			| {
					questions: Array<{
						question: string;
						options: string[];
						multiSelect: boolean;
					}>;
			  }
			| undefined;
		expect(askEvent).toBeDefined();
		expect(askEvent?.questions).toHaveLength(2);
		expect(askEvent?.questions[0].multiSelect).toBe(false);
		expect(askEvent?.questions[1].multiSelect).toBe(true);
	});

	it("canUseTool appends user notes to the SDK answer string when provided", async () => {
		const QUESTION = "Which library?";
		const askInput = {
			questions: [
				{
					question: QUESTION,
					header: "Library",
					options: [{ label: "React" }, { label: "Vue" }],
					multiSelect: false,
				},
			],
		};

		let capturedResult: unknown;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					capturedResult = await params.canUseTool(
						"AskUserQuestion",
						askInput,
						{ toolUseID: "tid-notes", signal: new AbortController().signal },
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
		const turn = sm.runQuery("hi", () => {}, "sess-notes");
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);

		sm.handleAskUserQuestionResponse(
			"tid-notes",
			{ [QUESTION]: ["React"] },
			{ [QUESTION]: "team already uses it" },
		);
		await turn;

		const updated = (
			capturedResult as { updatedInput: { answers: Record<string, string> } }
		).updatedInput;
		expect(updated.answers[QUESTION]).toContain("React");
		expect(updated.answers[QUESTION]).toContain("team already uses it");
	});

	it("canUseTool omits notes section when none provided", async () => {
		const QUESTION = "Pick?";
		const askInput = {
			questions: [
				{
					question: QUESTION,
					header: "Q",
					options: [{ label: "A" }, { label: "B" }],
					multiSelect: false,
				},
			],
		};

		let capturedResult: unknown;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-session-1" };
					capturedResult = await params.canUseTool(
						"AskUserQuestion",
						askInput,
						{
							toolUseID: "tid-no-notes",
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
		const turn = sm.runQuery("hi", () => {}, "sess-no-notes");
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);

		sm.handleAskUserQuestionResponse("tid-no-notes", { [QUESTION]: ["A"] });
		await turn;

		const updated = (
			capturedResult as { updatedInput: { answers: Record<string, string> } }
		).updatedInput;
		expect(updated.answers[QUESTION]).toBe("A");
	});
});

// ── Session-scoped permission persistence ──────────────────────────────────────

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
		const turn = sm.runQuery(
			"open Docker",
			(event) => emitted.push(event),
			"sess-1",
		);

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
		const turn = sm.runQuery("open Calculator", () => {}, "sess-1");

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
			"sess-1",
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
		) {
			return sm.runQuery(
				"/computer-use open Docker",
				emit,
				"sess-1",
				undefined,
				undefined,
				undefined,
				turnId,
				undefined,
				undefined,
				"computer-use",
			);
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
				description: "matched capability approval rule",
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
		const sm = new SessionManager(config, makeProviders(makeProvider("Bash")));
		const emitted: ServerMessage[] = [];
		const turn = sm.runQuery("hello", (event) => emitted.push(event), "sess-1");

		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "permission_request",
				id: "tid-1",
				description: "matched approval rule",
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
		const turn1 = sm.runQuery("hello", (m) => turn1Events.push(m), "sess-1");
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
		await sm.runQuery("hello again", (m) => turn2Events.push(m), "sess-1");
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

		const turn1 = sm.runQuery("hello", () => {}, "sess-1");
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
		const turn2 = sm2.runQuery(
			"new session msg",
			(m) => emittedTurn2.push(m),
			"sess-2",
		);
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

		const turn1 = sm.runQuery("hello", () => {}, "sess-1");
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
		const turn2 = sm2.runQuery(
			"after reinit",
			(m) => emittedTurn2.push(m),
			"sess-2",
		);
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

		const turn1 = sm.runQuery("hello", () => {}, "sess-1");
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		sm.handlePermissionResponse("tid-1", false);
		await turn1;

		// Second turn: should still prompt (not auto-allowed)
		const emittedTurn2: unknown[] = [];
		const provider2 = makeProvider("Bash", "tid-2");
		const sm2 = new SessionManager(makeConfig(), makeProviders(provider2));
		const turn2 = sm2.runQuery("again", (m) => emittedTurn2.push(m), "sess-1");
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
		const turn1 = sm.runQuery("hello", () => {}, "sess-1");
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
		const turn1 = sm.runQuery("hello", () => {}, "sess-1");
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

		const turn1 = sm.runQuery("hello", () => {}, "sess-1");
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
		await sm.runQuery("hello", () => {}, "sess-1");

		expect(capturedSettingSources).toContain("local");
	});
});

// ── summary passed to generateTurnRecap ───────────────────────────────────────

describe("SessionManager — summary passed to recap", () => {
	it("passes summary to generateTurnRecap as sdkSummary", async () => {
		const config = makeConfig();
		config.claude.turn_recaps = true;

		const provider: AgentProvider = {
			providerId: "claude",
			query(_params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-s1" };
					yield {
						type: "tool_start",
						toolId: "t1",
						name: "Bash",
						input: {},
					};
					yield { type: "summary", text: "Ran lint and fixed 2 warnings." };
					yield { type: "text_delta", text: "Done." };
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

		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("fix lint", () => {}, "sess-sdk");

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].sdkSummary).toBe("Ran lint and fixed 2 warnings.");
	});

	it("passes null sdkSummary when no summary event emitted", async () => {
		const config = makeConfig();
		config.claude.turn_recaps = true;

		const provider: AgentProvider = {
			providerId: "claude",
			query(_params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-s2" };
					yield { type: "tool_start", toolId: "t2", name: "Bash", input: {} };
					yield { type: "text_delta", text: "Done." };
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

		const sm = new SessionManager(config, makeProviders(provider));
		vi.mocked(generateTurnRecap).mockClear();
		await sm.runQuery("hello", () => {}, "sess-no-sdk");

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].sdkSummary).toBeNull();
	});
});

// ── recap model resolution ────────────────────────────────────────────────────

/** Provider that emits tool_start + text_delta to satisfy recap trigger conditions. */
function makeRecapTriggerProvider(): AgentProvider {
	return {
		providerId: "claude",
		query(_params: AgentQueryParams): AgentSession {
			const gen = (async function* (): AsyncGenerator<AgentEvent> {
				yield { type: "session_start", sessionId: "sdk-recap-1" };
				yield { type: "tool_start", toolId: "t-r1", name: "Bash", input: {} };
				yield { type: "text_delta", text: "Done." };
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
}

describe("SessionManager — recap model resolution", () => {
	it("uses claude-haiku-4-5 when no recap_model set in config", async () => {
		const config = makeConfig();
		config.claude.turn_recaps = true;
		const sm = new SessionManager(
			config,
			makeProviders(makeRecapTriggerProvider()),
		);
		vi.mocked(generateTurnRecap).mockClear();
		await sm.runQuery("hello", () => {}, "sess-rm-default");

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].recapModel).toBe("claude-haiku-4-5");
	});

	it("uses global recap_model from config when set", async () => {
		const config = makeConfig();
		config.claude.turn_recaps = true;
		config.claude.recap_model = "claude-sonnet-4-6";
		const sm = new SessionManager(
			config,
			makeProviders(makeRecapTriggerProvider()),
		);
		vi.mocked(generateTurnRecap).mockClear();
		await sm.runQuery("hello", () => {}, "sess-rm-global");

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].recapModel).toBe("claude-sonnet-4-6");
	});
});

describe("SessionManager — per-agent recap model", () => {
	const AGENT_PATH = "/tmp/test-agent-recap";

	beforeEach(() => {
		vi.mocked(agentPathsMock.isAllowedAgentPath).mockReturnValue(true);
		vi.mocked(agentPathsMock.computeAllowedAgentRealPaths).mockReturnValue([
			AGENT_PATH,
		]);
		// biome-ignore lint/suspicious/noExplicitAny: PathLike vs string mock type mismatch
		vi.mocked(fsMock.realpathSync).mockImplementation((p: any) => p as string);
	});

	it("uses agent recap_model overriding global", async () => {
		const config = makeConfigWithAgent(AGENT_PATH, {
			recap_model: "claude-haiku-4-5-20251001",
		});
		config.claude.turn_recaps = true;
		config.claude.recap_model = "claude-sonnet-4-6";
		const sm = new SessionManager(
			config,
			makeProviders(makeRecapTriggerProvider()),
		);
		vi.mocked(generateTurnRecap).mockClear();
		await sm.runQuery(
			"hello",
			() => {},
			"sess-rm-agent",
			undefined,
			undefined,
			AGENT_PATH,
		);

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].recapModel).toBe("claude-haiku-4-5-20251001");
	});

	it("falls back to global recap_model when agent has none", async () => {
		const config = makeConfigWithAgent(AGENT_PATH);
		config.claude.turn_recaps = true;
		config.claude.recap_model = "claude-sonnet-4-6";
		const sm = new SessionManager(
			config,
			makeProviders(makeRecapTriggerProvider()),
		);
		vi.mocked(generateTurnRecap).mockClear();
		await sm.runQuery(
			"hello",
			() => {},
			"sess-rm-fallback",
			undefined,
			undefined,
			AGENT_PATH,
		);

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].recapModel).toBe("claude-sonnet-4-6");
	});
});

// ── helpers for provider resolution / per-agent settings tests ────────────────

/** Build a provider that captures query params. Returns provider + captured-ref. */
function makeCaptureProvider(id = "claude"): {
	provider: AgentProvider;
	captured: { params: AgentQueryParams | null };
} {
	const captured: { params: AgentQueryParams | null } = { params: null };
	const provider: AgentProvider = {
		providerId: id,
		query(params: AgentQueryParams): AgentSession {
			captured.params = params;
			const gen = (async function* (): AsyncGenerator<AgentEvent> {
				yield { type: "session_start", sessionId: "sdk-1" };
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
	return { provider, captured };
}

function makeConfigWithAgent(
	agentPath: string,
	agentOverrides: Partial<Agent> = {},
): HlidConfig {
	return {
		...makeConfig(),
		vault_provider: "claude",
		agents: [
			{ path: agentPath, mode: "cwd", provider: "claude", ...agentOverrides },
		],
	} as unknown as HlidConfig;
}

// ── SessionManager — provider resolution ─────────────────────────────────────

describe("SessionManager — provider resolution", () => {
	const AGENT_PATH = "/tmp/test-agent";

	beforeEach(() => {
		vi.mocked(agentPathsMock.isAllowedAgentPath).mockReturnValue(false);
		vi.mocked(agentPathsMock.computeAllowedAgentRealPaths).mockReturnValue([]);
		// biome-ignore lint/suspicious/noExplicitAny: PathLike vs string mock type mismatch
		vi.mocked(fsMock.realpathSync).mockImplementation((p: any) => p as string);
	});

	it("vault query uses vaultProviderId from config", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config: HlidConfig = {
			...makeConfig(),
			vault_provider: "claude",
		} as unknown as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("hello", () => {}, "sess-v");
		expect(captured.params).not.toBeNull();
		// vault query: model should be the vault model
		expect(captured.params?.model).toBe("claude-test");
	});

	it("agent query uses provider from agentProviderMap when set", async () => {
		const { provider: claudeProvider, captured: claudeCaptured } =
			makeCaptureProvider("claude");
		const { provider: altProvider, captured: altCaptured } =
			makeCaptureProvider("alt");
		const config = makeConfigWithAgent(AGENT_PATH, { provider: "alt" });
		const providers = new Map([
			["claude", claudeProvider],
			["alt", altProvider],
		]);
		vi.mocked(agentPathsMock.isAllowedAgentPath).mockReturnValue(true);
		vi.mocked(agentPathsMock.computeAllowedAgentRealPaths).mockReturnValue([
			AGENT_PATH,
		]);
		const sm = new SessionManager(config, providers);
		await sm.runQuery(
			"hello",
			() => {},
			"sess-a",
			undefined,
			undefined,
			AGENT_PATH,
		);
		expect(altCaptured.params).not.toBeNull();
		expect(claudeCaptured.params).toBeNull();
	});

	it("restored session keeps its saved provider after agent config changes", async () => {
		const { provider: claudeProvider, captured: claudeCaptured } =
			makeCaptureProvider("claude");
		const { provider: codexProvider, captured: codexCaptured } =
			makeCaptureProvider("codex");
		const config = makeConfigWithAgent(AGENT_PATH, {
			provider: "codex",
			model: "gpt-5.6-sol",
		});
		const providers = new Map([
			["claude", claudeProvider],
			["codex", codexProvider],
		]);
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "prior" },
		] as never);
		vi.mocked(dbMock.getSessionAgentCwd).mockResolvedValueOnce(AGENT_PATH);
		vi.mocked(dbMock.getSessionModel).mockResolvedValueOnce("claude-fable-5");
		vi.mocked(dbMock.getSessionProviderId).mockResolvedValueOnce("claude");
		vi.mocked(dbMock.getSessionProviderSession).mockResolvedValueOnce(
			"claude-session-id",
		);

		const sm = new SessionManager(config, providers);
		await sm.runQuery("continue", () => {}, "saved-session");

		expect(claudeCaptured.params).toMatchObject({
			model: "claude-fable-5",
			sessionId: "claude-session-id",
		});
		expect(codexCaptured.params).toBeNull();
		expect(dbMock.setSessionProviderId).toHaveBeenCalledWith(
			"saved-session",
			"claude",
		);
	});

	it("agent query falls back to vaultProviderId when agent not in map", async () => {
		// Agent config has no provider set — should fall back to vault provider ("claude").
		// Register two providers; only the vault one should be called.
		const { provider: claudeProvider, captured: claudeCaptured } =
			makeCaptureProvider("claude");
		const { provider: altProvider, captured: altCaptured } =
			makeCaptureProvider("alt");
		// Agent entry omits provider so it maps to "claude" (vault default)
		const config = makeConfigWithAgent(AGENT_PATH);
		const providers = new Map([
			["claude", claudeProvider],
			["alt", altProvider],
		]);
		vi.mocked(agentPathsMock.isAllowedAgentPath).mockReturnValue(true);
		vi.mocked(agentPathsMock.computeAllowedAgentRealPaths).mockReturnValue([
			AGENT_PATH,
		]);
		const sm = new SessionManager(config, providers);
		await sm.runQuery(
			"hello",
			() => {},
			"sess-b",
			undefined,
			undefined,
			AGENT_PATH,
		);
		expect(claudeCaptured.params).not.toBeNull(); // vault provider was used
		expect(altCaptured.params).toBeNull(); // alt provider was NOT used
	});

	it("rejects with 'No providers' when no providers registered", async () => {
		const sm = new SessionManager(makeConfig(), new Map());
		await expect(sm.runQuery("hello", () => {}, "sess-c")).rejects.toThrow(
			/No providers/,
		);
	});

	it("passes Windows Computer Use preferences into Codex sessions", async () => {
		const { provider, captured } = makeCaptureProvider("codex");
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
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.runQuery("hello", () => {}, "computer-use-settings");

		expect(captured.params?.windowsComputerUse).toEqual({
			model: "inherit",
			effort: "medium",
		});
	});
});

// ── SessionManager — per-agent settings ──────────────────────────────────────

describe("SessionManager — per-agent settings", () => {
	const AGENT_PATH = "/tmp/test-agent-settings";

	beforeEach(() => {
		vi.mocked(agentPathsMock.isAllowedAgentPath).mockReturnValue(true);
		vi.mocked(agentPathsMock.computeAllowedAgentRealPaths).mockReturnValue([
			AGENT_PATH,
		]);
		// biome-ignore lint/suspicious/noExplicitAny: PathLike vs string mock type mismatch
		vi.mocked(fsMock.realpathSync).mockImplementation((p: any) => p as string);
	});

	it("agent query uses agent-specific model when configured", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config = makeConfigWithAgent(AGENT_PATH, {
			model: "claude-opus-4-7",
		});
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery(
			"hello",
			() => {},
			"sess-m",
			undefined,
			undefined,
			AGENT_PATH,
		);
		expect(captured.params?.model).toBe("claude-opus-4-7");
		expect(dbMock.createSession).toHaveBeenCalledWith(
			"sess-m",
			"HELLO",
			"claude-opus-4-7",
		);
	});

	it("agent query uses agent-specific effort when configured", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config = makeConfigWithAgent(AGENT_PATH, { effort: "low" });
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery(
			"hello",
			() => {},
			"sess-e",
			undefined,
			undefined,
			AGENT_PATH,
		);
		expect(captured.params?.effort).toBe("low");
	});

	it("keeps WSL caller settings ahead of unrelated vault defaults for Computer Use inheritance", async () => {
		const { provider, captured } = makeCaptureProvider("codex");
		const config = makeConfigWithAgent(AGENT_PATH, {
			provider: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
		});
		config.vault_provider = "codex";
		config.codex = {
			model: "gpt-5.6-terra",
			effort: "medium",
			permission_mode: "default",
			turn_recaps: false,
			windows_computer_use: { model: "inherit", effort: "inherit" },
		};
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.runQuery(
			"hello",
			() => {},
			"wsl-caller-inheritance",
			undefined,
			undefined,
			AGENT_PATH,
		);

		expect(captured.params).toMatchObject({
			model: "gpt-5.6-sol",
			effort: "high",
			windowsComputerUse: { model: "inherit", effort: "inherit" },
		});
	});

	it("agent query uses agent-specific permissionMode when configured", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config = makeConfigWithAgent(AGENT_PATH, {
			permission_mode: "bypassPermissions",
		});
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery(
			"hello",
			() => {},
			"sess-pm",
			undefined,
			undefined,
			AGENT_PATH,
		);
		expect(captured.params?.permissionMode).toBe("bypassPermissions");
	});

	it.each([
		"claude",
		"codex",
	])("session picker overrides outrank %s agent defaults on the first turn", async (providerId) => {
		const { provider, captured } = makeCaptureProvider(providerId);
		const config = makeConfigWithAgent(AGENT_PATH, {
			provider: providerId,
			model: "configured-model",
			effort: "high",
			permission_mode: "default",
		});
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.setModel("picked-model");
		await sm.setEffort("xhigh");
		await sm.setPermissionMode("bypassPermissions");

		await sm.runQuery(
			"hello",
			() => {},
			`sess-overrides-${providerId}`,
			undefined,
			undefined,
			AGENT_PATH,
		);

		expect(captured.params).toMatchObject({
			model: "picked-model",
			effort: "xhigh",
			permissionMode: "bypassPermissions",
		});
	});

	it("plan_mode=true overrides permissionMode to 'plan' without mutating config", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config: HlidConfig = {
			...makeConfig(),
			vault_provider: "claude",
		} as unknown as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery(
			"hello",
			() => {},
			"sess-plan",
			undefined,
			undefined,
			undefined,
			undefined,
			true,
		);
		expect(captured.params?.permissionMode).toBe("plan");
		expect(captured.params?.implementationPermissionMode).toBe("default");
		// config-level default remains unchanged
		expect(config.claude.permission_mode).toBe("default");
	});

	it("preserves auto-approve all as the post-plan implementation mode", async () => {
		const { provider, captured } = makeCaptureProvider("codex");
		const base = makeConfig();
		const config: HlidConfig = {
			...base,
			vault_provider: "codex",
			codex: { ...base.codex, permission_mode: "bypassPermissions" },
		};
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery(
			"hello",
			() => {},
			"sess-plan-bypass",
			undefined,
			undefined,
			undefined,
			undefined,
			true,
		);
		expect(captured.params?.permissionMode).toBe("plan");
		expect(captured.params?.implementationPermissionMode).toBe(
			"bypassPermissions",
		);
	});

	it("agent query uses agent-specific maxTurns when configured", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config = makeConfigWithAgent(AGENT_PATH, { max_turns: 5 });
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery(
			"hello",
			() => {},
			"sess-mt",
			undefined,
			undefined,
			AGENT_PATH,
		);
		expect(captured.params?.maxTurns).toBe(5);
	});

	it("agent query passes undefined model when agent has no model override (defers to CLAUDE.md)", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config = makeConfigWithAgent(AGENT_PATH);
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery(
			"hello",
			() => {},
			"sess-nomodel",
			undefined,
			undefined,
			AGENT_PATH,
		);
		expect(captured.params?.model).toBeUndefined();
	});

	it("vault query always uses vault model (this.model)", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config: HlidConfig = {
			...makeConfig("vault-model-x"),
			vault_provider: "claude",
		} as unknown as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));
		// No agentCwd — vault query
		await sm.runQuery("hello", () => {}, "sess-vault");
		expect(captured.params?.model).toBe("vault-model-x");
	});
});

// ── Live tool_event persistence ────────────────────────────────────────────────
// Background: tool_event rows used to be persisted only at handleDone, alongside
// the assistant message row. SPA navigation away from /raven and back during a
// running query lost the in-memory reducer state, and the DB was empty for the
// in-flight turn — so tool calls vanished until the query finished AND the user
// did a full refresh. The current behavior pre-inserts an empty assistant
// message + tool_event rows on the first tool_start so a mid-turn reload sees
// them. Tool results UPDATE the row live as they arrive.

/**
 * Provider that surfaces controllable hooks for "in-flight" tests:
 *   - resolves a promise once each named milestone has been emitted
 *   - blocks the generator on `gateRelease` so the test can inspect DB state
 *     mid-turn before letting the generator emit `done`
 */
function makeControlledProvider(
	events: AgentEvent[],
	gateRelease: Promise<void>,
): { provider: AgentProvider; gateReached: Promise<void> } {
	let resolveGate: () => void = () => {};
	const gateReached = new Promise<void>((res) => {
		resolveGate = res;
	});
	const provider: AgentProvider = {
		providerId: "claude",
		query(_params: AgentQueryParams): AgentSession {
			const gen = (async function* (): AsyncGenerator<AgentEvent> {
				for (const e of events) yield e;
				resolveGate();
				await gateRelease;
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
	return { provider, gateReached };
}

describe("SessionManager — live tool_event persistence", () => {
	beforeEach(() => {
		vi.mocked(dbMock.appendMessage).mockClear();
		vi.mocked(dbMock.appendToolEvent).mockClear();
		vi.mocked(dbMock.setToolEventResult).mockClear();
		vi.mocked(dbMock.setToolEventSubagent).mockClear();
		vi.mocked(dbMock.setMessageText).mockClear();
		vi.mocked(dbMock.appendToolEvent).mockResolvedValue(undefined);
	});

	it("inserts assistant placeholder + tool_event row on first tool_start (before done)", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-live-1" },
				{
					type: "tool_start",
					toolId: "tu-1",
					name: "Read",
					input: { file_path: "/a" },
				},
			],
			gate,
		);

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery("read a", () => {}, "sess-live-1");
		await gateReached;
		// At this point, before done, the placeholder + tool_event must have hit DB.
		await waitFor(() => {
			expect(dbMock.appendMessage).toHaveBeenCalledWith(
				"sess-live-1",
				expect.any(Number),
				"assistant",
				"",
			);
			expect(dbMock.appendToolEvent).toHaveBeenCalledWith(
				"sess-live-1",
				expect.any(Number),
				"tu-1",
				"Read",
				{ file_path: "/a" },
			);
		});
		release();
		await runPromise;
	});

	it("multiple tool_starts share the reserved assistant_seq with a single placeholder", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-live-2" },
				{ type: "tool_start", toolId: "tu-1", name: "Read", input: {} },
				{ type: "tool_start", toolId: "tu-2", name: "Read", input: {} },
				{ type: "tool_start", toolId: "tu-3", name: "Bash", input: {} },
			],
			gate,
		);

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery("multi", () => {}, "sess-live-2");
		await gateReached;
		await waitFor(() => {
			expect(dbMock.appendToolEvent).toHaveBeenCalledTimes(3);
		});
		// Only one assistant placeholder for the 3 tools
		const placeholderCalls = vi
			.mocked(dbMock.appendMessage)
			.mock.calls.filter(
				(c) => c[0] === "sess-live-2" && c[2] === "assistant" && c[3] === "",
			);
		expect(placeholderCalls).toHaveLength(1);
		// All three tool_event rows share the same assistant_seq
		const seqs = vi.mocked(dbMock.appendToolEvent).mock.calls.map((c) => c[1]);
		expect(new Set(seqs).size).toBe(1);
		release();
		await runPromise;
	});

	it("tool_result triggers setToolEventResult live (after the tool_event has been inserted)", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-live-3" },
				{ type: "tool_start", toolId: "tu-1", name: "Read", input: {} },
				{ type: "tool_result", toolId: "tu-1", content: "file contents" },
			],
			gate,
		);

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery("read", () => {}, "sess-live-3");
		await gateReached;
		await waitFor(() => {
			expect(dbMock.setToolEventResult).toHaveBeenCalledWith(
				"sess-live-3",
				"tu-1",
				"file contents",
				false,
			);
		});
		release();
		await runPromise;
	});

	it("persists the latest subagent snapshot when an update races the tool insert", async () => {
		let releaseTurn!: () => void;
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		let releaseInsert!: () => void;
		vi.mocked(dbMock.appendToolEvent).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseInsert = resolve;
				}),
		);
		const started = {
			provider: "codex" as const,
			agentId: "spawn-1",
			prompt: "Inspect auth",
			status: "pending" as const,
			startedAtMs: 1000,
		};
		const running = {
			...started,
			agentId: "child-1",
			status: "running" as const,
			currentStep: "Reading files",
		};
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-subagent" },
				{
					type: "tool_start",
					toolId: "spawn-tool",
					name: "spawn_agent",
					input: { prompt: "Inspect auth" },
					subagent: started,
				},
				{ type: "tool_update", toolId: "spawn-tool", subagent: running },
			],
			turnGate,
		);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery(
			"delegate",
			(message) => emitted.push(message),
			"sess-subagent",
		);
		await gateReached;
		expect(emitted).toContainEqual({
			type: "tool_update",
			id: "spawn-tool",
			subagent: running,
		});
		expect(dbMock.setToolEventSubagent).not.toHaveBeenCalled();
		releaseInsert();
		await waitFor(() => {
			expect(dbMock.setToolEventSubagent).toHaveBeenCalledWith(
				"sess-subagent",
				"spawn-tool",
				running,
			);
		});
		releaseTurn();
		await runPromise;
	});

	it("tool_result with isError=true persists is_error=true", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-live-3e" },
				{ type: "tool_start", toolId: "tu-1", name: "Bash", input: {} },
				{
					type: "tool_result",
					toolId: "tu-1",
					content: "denied",
					isError: true,
				},
			],
			gate,
		);

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery("bash", () => {}, "sess-live-3e");
		await gateReached;
		await waitFor(() => {
			expect(dbMock.setToolEventResult).toHaveBeenCalledWith(
				"sess-live-3e",
				"tu-1",
				"denied",
				true,
			);
		});
		release();
		await runPromise;
	});

	it("handleDone updates the placeholder message text (does not insert a duplicate)", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(_p: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-live-4" };
					yield { type: "tool_start", toolId: "tu-1", name: "Read", input: {} };
					yield { type: "tool_result", toolId: "tu-1", content: "ok" };
					yield { type: "text_delta", text: "All set." };
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
		await sm.runQuery("go", () => {}, "sess-live-4");

		// Placeholder appendMessage("assistant", "") was called, NOT a second
		// appendMessage with the final text.
		const assistantInserts = vi
			.mocked(dbMock.appendMessage)
			.mock.calls.filter((c) => c[0] === "sess-live-4" && c[2] === "assistant");
		expect(assistantInserts).toHaveLength(1);
		expect(assistantInserts[0][3]).toBe("");
		// setMessageText carries the final assistant text under the same seq.
		// session.ts prepends "\n\n" when text follows a tool block.
		expect(dbMock.setMessageText).toHaveBeenCalledWith(
			"sess-live-4",
			assistantInserts[0][1],
			"\n\nAll set.",
		);
		// Tool_event row was NOT inserted a second time at done.
		expect(dbMock.appendToolEvent).toHaveBeenCalledTimes(1);
	});

	it("ExitPlanMode tool_start does not write a tool_event row (renders as PlanCard only)", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(_params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-live-5" };
					// canUseTool registers the plan_mode_exit and waits for user response;
					// since the test never resolves it, we don't await here. We only need
					// to confirm the tool_start branch does not persist.
					yield {
						type: "tool_start",
						toolId: "tu-plan",
						name: "ExitPlanMode",
						input: { plan: "## Plan" },
					};
					yield { type: "text_delta", text: "Awaiting decision." };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
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
		await sm.runQuery("propose", () => {}, "sess-live-5");

		// No appendToolEvent for the ExitPlanMode tool.
		const toolCalls = vi
			.mocked(dbMock.appendToolEvent)
			.mock.calls.filter((c) => c[0] === "sess-live-5");
		expect(toolCalls).toHaveLength(0);
	});

	it("text_delta streams accumulated assistant text to DB live (throttled to coalesce chunks)", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-live-text" },
				{ type: "text_delta", text: "Hello, " },
				{ type: "text_delta", text: "world." },
			],
			gate,
		);

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const emitted: ServerMessage[] = [];
		const runPromise = sm.runQuery(
			"hi",
			(message) => emitted.push(message),
			"sess-live-text",
		);
		try {
			await gateReached;
			expect(emitted.filter((message) => message.type === "chunk")).toEqual([
				{ type: "chunk", text: "Hello, ", offset: 0 },
				{ type: "chunk", text: "world.", offset: 7 },
			]);

			// The first chunk inserts the placeholder immediately, while both text
			// chunks remain coalesced until the 800ms write window expires.
			const placeholderInserts = vi
				.mocked(dbMock.appendMessage)
				.mock.calls.filter(
					(c) =>
						c[0] === "sess-live-text" && c[2] === "assistant" && c[3] === "",
				);
			expect(placeholderInserts).toHaveLength(1);
			expect(
				vi
					.mocked(dbMock.setMessageText)
					.mock.calls.filter((c) => c[0] === "sess-live-text"),
			).toHaveLength(0);

			await vi.advanceTimersByTimeAsync(800);
			const liveTexts = vi
				.mocked(dbMock.setMessageText)
				.mock.calls.filter((c) => c[0] === "sess-live-text")
				.map((c) => c[2]);
			expect(liveTexts).toEqual(["Hello, world."]);

			release();
			await runPromise;
		} finally {
			release();
			vi.useRealTimers();
			await runPromise;
		}
	});

	it("only one setMessageText is scheduled when many chunks arrive in quick succession", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const chunks: AgentEvent[] = [];
		for (let i = 0; i < 50; i++) {
			chunks.push({ type: "text_delta", text: `${i} ` });
		}
		const { provider, gateReached } = makeControlledProvider(
			[{ type: "session_start", sessionId: "sdk-live-throttle" }, ...chunks],
			gate,
		);

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery("burst", () => {}, "sess-live-throttle");
		try {
			await gateReached;
			expect(
				vi
					.mocked(dbMock.setMessageText)
					.mock.calls.filter((c) => c[0] === "sess-live-throttle"),
			).toHaveLength(0);

			// Advance the coalescing window deterministically. Real-time polling here
			// used to flap when the full suite starved the event loop past its wall-
			// clock deadline even though the scheduled callback was still correct.
			await vi.advanceTimersByTimeAsync(800);
			const writes = vi
				.mocked(dbMock.setMessageText)
				.mock.calls.filter((c) => c[0] === "sess-live-throttle");
			expect(writes).toHaveLength(1);
			expect(writes[0]?.[2]).toBe(
				Array.from({ length: 50 }, (_, index) => `${index} `).join(""),
			);

			release();
			await runPromise;
		} finally {
			release();
			await runPromise;
			vi.useRealTimers();
		}
	});

	it("text_delta after a tool_start reuses the same placeholder (one assistant row per turn)", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-live-mix" },
				{ type: "tool_start", toolId: "tu-1", name: "Read", input: {} },
				{ type: "text_delta", text: "After tool." },
			],
			gate,
		);

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery("go", () => {}, "sess-live-mix");
		try {
			await gateReached;
			const placeholderInserts = vi
				.mocked(dbMock.appendMessage)
				.mock.calls.filter(
					(c) =>
						c[0] === "sess-live-mix" && c[2] === "assistant" && c[3] === "",
				);
			expect(placeholderInserts).toHaveLength(1);
			const toolCall = vi
				.mocked(dbMock.appendToolEvent)
				.mock.calls.find((c) => c[0] === "sess-live-mix" && c[2] === "tu-1");
			expect(toolCall?.[1]).toBe(placeholderInserts[0][1]);

			await vi.advanceTimersByTimeAsync(800);
			const textCall = vi
				.mocked(dbMock.setMessageText)
				.mock.calls.find((c) => c[0] === "sess-live-mix");
			expect(textCall?.[1]).toBe(placeholderInserts[0][1]);

			release();
			await runPromise;
		} finally {
			release();
			await runPromise;
			vi.useRealTimers();
		}
	});

	it("tool_result before any tool_start is a no-op (defensive: gated on persistedToolIds)", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(_p: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-live-6" };
					// Out-of-order: tool_result without a preceding tool_start
					yield { type: "tool_result", toolId: "ghost", content: "x" };
					yield { type: "text_delta", text: "ok." };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
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
		await sm.runQuery("noop", () => {}, "sess-live-6");

		// Live setToolEventResult must NOT be invoked for an unknown tool id.
		const ghostCalls = vi
			.mocked(dbMock.setToolEventResult)
			.mock.calls.filter((c) => c[1] === "ghost");
		expect(ghostCalls).toHaveLength(0);
	});
});

// ── runQuery queueing (Slice A) ───────────────────────────────────────────────

/**
 * Slice B-aware controllable provider: one long-lived AgentSession per chat,
 * each send() call enrolls a `{ resolveDone }` controller so the test can
 * release turns individually. Use `turns.length` as the probe for "how many
 * turns have started" — provider.query() is invoked once per chat under
 * Slice B caching, so it is no longer a useful probe.
 */
function makeControllableProvider() {
	const turns: Array<{ resolveDone: () => void }> = [];
	let queryCount = 0;
	const eventQueue: AgentEvent[] = [];
	const waiters: Array<(e: AgentEvent | null) => void> = [];
	let closed = false;

	function pushEvent(e: AgentEvent): void {
		const w = waiters.shift();
		if (w) w(e);
		else eventQueue.push(e);
	}

	const provider: AgentProvider = {
		providerId: "claude",
		query(_p: AgentQueryParams): AgentSession {
			queryCount++;
			const queryIndex = queryCount;
			let started = false;
			const cachedIter: AsyncIterator<AgentEvent> = {
				async next(): Promise<IteratorResult<AgentEvent>> {
					if (closed) return { value: undefined as never, done: true };
					if (!started) {
						started = true;
						return {
							value: {
								type: "session_start",
								sessionId: `sdk-${queryIndex}`,
							},
							done: false,
						};
					}
					if (eventQueue.length > 0) {
						return {
							value: eventQueue.shift() as AgentEvent,
							done: false,
						};
					}
					return new Promise<IteratorResult<AgentEvent>>((resolve) => {
						waiters.push((e) => {
							if (e === null) {
								resolve({ value: undefined as never, done: true });
							} else {
								resolve({ value: e, done: false });
							}
						});
					});
				},
			};
			const send = vi.fn(async () => {
				let resolveDone!: () => void;
				const donePromise = new Promise<void>((r) => {
					resolveDone = r;
				});
				turns.push({ resolveDone });
				void donePromise.then(() => {
					pushEvent({
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					});
				});
			});
			return {
				[Symbol.asyncIterator]: () => cachedIter,
				cancel: () => {
					closed = true;
					while (waiters.length > 0) {
						const w = waiters.shift();
						w?.(null);
					}
				},
				send,
				mcpServerStatus: () => Promise.resolve([]),
			};
		},
	};
	return {
		provider,
		turns,
		getQueryCount: () => queryCount,
		getSendCount: () => turns.length,
	};
}

describe("SessionManager — runQuery queueing", () => {
	it("queues second runQuery while first is running and drains FIFO at done", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const events1: unknown[] = [];
		const events2: unknown[] = [];
		const turn1 = sm.runQuery("first", (m) => events1.push(m), "sess-1");
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));

		// Second runQuery while first is still running — must queue, not reject.
		const turn2 = sm.runQuery("second", (m) => events2.push(m), "sess-1");

		// Provider must NOT have been invoked for turn 2 yet.
		expect(ctl.getSendCount()).toBe(1);

		// Release turn 1 — turn 2 should then start.
		ctl.turns[0].resolveDone();
		await turn1;
		await waitFor(() => expect(ctl.getSendCount()).toBe(2));
		ctl.turns[1].resolveDone();
		await turn2;

		expect(events1.some((m) => (m as { type: string }).type === "done")).toBe(
			true,
		);
		expect(events2.some((m) => (m as { type: string }).type === "done")).toBe(
			true,
		);
	});

	it("preserves FIFO order across multiple queued turns", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const order: string[] = [];
		const recordDone =
			(label: string) =>
			(m: ServerMessage): void => {
				if (m.type === "done") order.push(label);
			};
		const t1 = sm.runQuery("a", recordDone("a"), "sess-1");
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery("b", recordDone("b"), "sess-1");
		const t3 = sm.runQuery("c", recordDone("c"), "sess-1");

		ctl.turns[0].resolveDone();
		await t1;
		await waitFor(() => expect(ctl.getSendCount()).toBe(2));
		ctl.turns[1].resolveDone();
		await t2;
		await waitFor(() => expect(ctl.getSendCount()).toBe(3));
		ctl.turns[2].resolveDone();
		await t3;

		expect(order).toEqual(["a", "b", "c"]);
	});

	it("emits status=running per queued turn (with turn_id) and status=idle once at drain end", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const statusEvents: Array<{ state: string; turn_id?: string }> = [];
		const onMsg = (m: ServerMessage): void => {
			if (m.type === "status") {
				statusEvents.push({
					state: m.state,
					...(m.turn_id !== undefined ? { turn_id: m.turn_id } : {}),
				});
			}
		};

		const t1 = sm.runQuery(
			"a",
			onMsg,
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-a",
		);
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery(
			"b",
			onMsg,
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-b",
		);

		ctl.turns[0].resolveDone();
		await t1;
		await waitFor(() => expect(ctl.getSendCount()).toBe(2));

		// Between turn 1 and turn 2 we must NOT see an idle status.
		expect(statusEvents.map((e) => e.state)).not.toContain("idle");

		ctl.turns[1].resolveDone();
		await t2;

		// Slice C: each turn emits a running status with its turn_id so the
		// client can mark the corresponding chatQueue entry as RUN.
		const runningEvents = statusEvents.filter((e) => e.state === "running");
		expect(runningEvents).toHaveLength(2);
		expect(runningEvents[0].turn_id).toBe("turn-a");
		expect(runningEvents[1].turn_id).toBe("turn-b");
		// Idle emitted exactly once after full drain.
		expect(statusEvents.filter((e) => e.state === "idle")).toHaveLength(1);
	});

	it("first turn error does not block subsequent queued turn from running", async () => {
		let calls = 0;
		const provider: AgentProvider = {
			providerId: "claude",
			query(_p: AgentQueryParams): AgentSession {
				calls++;
				const willThrow = calls === 1;
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					if (willThrow) throw new Error("first turn fail");
					yield { type: "session_start", sessionId: "sdk-2" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
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
		const t1 = sm.runQuery("a", () => {}, "sess-1");
		const t2 = sm.runQuery("b", () => {}, "sess-1");

		const results = await Promise.allSettled([t1, t2]);
		// runQuery itself never throws — errors are emitted as events. Both
		// promises resolve; second turn must have invoked the provider.
		expect(results[0].status).toBe("fulfilled");
		expect(results[1].status).toBe("fulfilled");
		expect(calls).toBe(2);
	});

	it("clearHistory drops queued turns silently and does not start them", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const t1 = sm.runQuery("a", () => {}, "sess-1");
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery("b", () => {}, "sess-1");

		// Clear before turn 1 completes — turn 2 should never start.
		sm.clearHistory();

		// Let turn 1 finish so its iterator drains.
		ctl.turns[0].resolveDone();
		await t1;

		// Give the drain loop a tick; turn 2 must not have invoked the provider.
		await new Promise((r) => setTimeout(r, 20));
		expect(ctl.getSendCount()).toBe(1);

		// t2 should resolve (or reject) without hanging.
		await Promise.race([
			t2,
			new Promise((_, rej) => setTimeout(() => rej(new Error("t2 hung")), 200)),
		]).catch(() => {
			/* either resolution acceptable */
		});
	});
});

// ── Slice C: cancelQueued ─────────────────────────────────────────────────────

describe("SessionManager — cancelQueued", () => {
	it("removes a pending queued turn by turn_id and resolves its promise silently", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const t1 = sm.runQuery(
			"first",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-1",
		);
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery(
			"second",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-2",
		);

		expect(sm.cancelQueued("turn-2")).toBe(true);

		ctl.turns[0].resolveDone();
		await t1;
		// t2 was cancelled — its promise resolves silently; no second send.
		await t2;
		expect(ctl.getSendCount()).toBe(1);
	});

	it("returns false when the turn_id is unknown", () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		expect(sm.cancelQueued("nope")).toBe(false);
	});

	it("returns false for the currently running turn (cannot cancel-running)", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const t1 = sm.runQuery(
			"first",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-1",
		);
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));

		// turn-1 is currently running (already shifted off turnQueue), so
		// cancelQueued must NOT match it.
		expect(sm.cancelQueued("turn-1")).toBe(false);

		ctl.turns[0].resolveDone();
		await t1;
	});
});

describe("SessionManager — promoteQueued", () => {
	it("moves a queued turn to the head and calls agentSession.interrupt", async () => {
		const ctl = makeControllableProvider();
		// Wrap provider so we can capture the interrupt spy on the live session.
		let capturedInterrupt: ReturnType<typeof vi.fn> | null = null;
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(p: AgentQueryParams): AgentSession {
				const sess = ctl.provider.query(p);
				const interruptSpy = vi.fn().mockResolvedValue(undefined);
				capturedInterrupt = interruptSpy;
				return { ...sess, interrupt: interruptSpy };
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));

		const t1 = sm.runQuery(
			"first",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-1",
		);
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery(
			"second",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-2",
		);
		const t3 = sm.runQuery(
			"third",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-3",
		);

		// Promote turn-3 — should reorder turnQueue (turn-3 before turn-2) and
		// interrupt the currently running turn.
		expect(sm.promoteQueued("turn-3")).toBe(true);
		expect(capturedInterrupt).not.toBeNull();
		expect(capturedInterrupt).toHaveBeenCalledTimes(1);

		// Resolve current turn (turn-1) — drain proceeds to turn-3 (promoted),
		// then turn-2.
		ctl.turns[0].resolveDone();
		await t1;
		await waitFor(() => expect(ctl.getSendCount()).toBe(2));
		ctl.turns[1].resolveDone();
		await t3;
		await waitFor(() => expect(ctl.getSendCount()).toBe(3));
		ctl.turns[2].resolveDone();
		await t2;
	});

	it("returns false for unknown turn id", () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		expect(sm.promoteQueued("nope")).toBe(false);
	});

	it("returns false for the currently running turn (already shifted off queue)", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const t1 = sm.runQuery(
			"first",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-1",
		);
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		expect(sm.promoteQueued("turn-1")).toBe(false);
		ctl.turns[0].resolveDone();
		await t1;
	});
});

describe("SessionManager — Slice C edge cases", () => {
	it("cancel after promote: cancels the promoted turn (still in queue, just at head)", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const t1 = sm.runQuery(
			"first",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-1",
		);
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery(
			"second",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-2",
		);
		const t3 = sm.runQuery(
			"third",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-3",
		);

		expect(sm.promoteQueued("turn-3")).toBe(true);
		// Now turnQueue is [turn-3, turn-2]. Cancel turn-3 → only turn-2 remains.
		expect(sm.cancelQueued("turn-3")).toBe(true);

		ctl.turns[0].resolveDone();
		await t1;
		await t3; // resolved silently by cancel
		await waitFor(() => expect(ctl.getSendCount()).toBe(2));
		ctl.turns[1].resolveDone();
		await t2;
		expect(ctl.getSendCount()).toBe(2); // turn-3 never ran
	});

	it("double promote: second promote moves a different turn to head", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const t1 = sm.runQuery(
			"first",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-1",
		);
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery(
			"second",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-2",
		);
		const t3 = sm.runQuery(
			"third",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-3",
		);

		expect(sm.promoteQueued("turn-3")).toBe(true);
		// Queue: [turn-3, turn-2]. Promote turn-2 → [turn-2, turn-3].
		expect(sm.promoteQueued("turn-2")).toBe(true);

		ctl.turns[0].resolveDone();
		await t1;
		await waitFor(() => expect(ctl.getSendCount()).toBe(2));
		ctl.turns[1].resolveDone();
		await t2;
		await waitFor(() => expect(ctl.getSendCount()).toBe(3));
		ctl.turns[2].resolveDone();
		await t3;
	});

	it("abort clears queue and tears down session even if queue had promotions", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const t1 = sm.runQuery(
			"first",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-1",
		);
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery(
			"second",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-2",
		);
		const t3 = sm.runQuery(
			"third",
			() => {},
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-3",
		);
		expect(sm.promoteQueued("turn-3")).toBe(true);

		sm.abort();
		// Drain the running turn so Promise.allSettled resolves.
		ctl.turns[0].resolveDone();

		await Promise.allSettled([t1, t2, t3]);
		// Queue was cleared by abort — turn-2 and turn-3 never ran.
		expect(ctl.getSendCount()).toBe(1);
	});
});

describe("SessionManager — turn_id forwarding", () => {
	it("done event includes the turn_id supplied to runQuery", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const events: ServerMessage[] = [];
		const turn = sm.runQuery(
			"first",
			(m) => events.push(m),
			"sess-1",
			undefined,
			undefined,
			undefined,
			"turn-xyz",
		);
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		ctl.turns[0].resolveDone();
		await turn;

		const doneEvt = events.find((e) => e.type === "done") as
			| { type: "done"; turn_id?: string }
			| undefined;
		expect(doneEvt?.turn_id).toBe("turn-xyz");
	});
});

// ── Slice B: long-lived AgentSession reuse ────────────────────────────────────

/**
 * Build a provider whose AgentSession stays open across send() calls. Each
 * send() emits its own done event into the shared stream so iterateConversation
 * sees one done per turn and breaks (preserving iterator state between turns).
 * Counts how many times provider.query() was invoked.
 */
function makeLongLivedProvider() {
	let queryCallCount = 0;
	const eventQueue: AgentEvent[] = [];
	const waiters: Array<(e: AgentEvent | null) => void> = [];
	let closed = false;

	function pushEvent(e: AgentEvent): void {
		if (waiters.length > 0) {
			const w = waiters.shift();
			w?.(e);
		} else {
			eventQueue.push(e);
		}
	}

	function close(): void {
		closed = true;
		while (waiters.length > 0) {
			const w = waiters.shift();
			w?.(null);
		}
	}

	const provider: AgentProvider = {
		providerId: "claude",
		query(_p: AgentQueryParams): AgentSession {
			queryCallCount++;
			const queryIndex = queryCallCount;
			let started = false;
			const cachedIter: AsyncIterator<AgentEvent> = {
				async next(): Promise<IteratorResult<AgentEvent>> {
					if (closed) return { value: undefined as never, done: true };
					if (!started) {
						started = true;
						return {
							value: {
								type: "session_start",
								sessionId: `sdk-${queryIndex}`,
							},
							done: false,
						};
					}
					if (eventQueue.length > 0) {
						const next = eventQueue.shift();
						return { value: next as AgentEvent, done: false };
					}
					return new Promise<IteratorResult<AgentEvent>>((resolve) => {
						waiters.push((e) => {
							if (e === null) {
								resolve({ value: undefined as never, done: true });
							} else {
								resolve({ value: e, done: false });
							}
						});
					});
				},
			};
			return {
				[Symbol.asyncIterator]: () => cachedIter,
				send: vi.fn(async (_msg: string) => {
					pushEvent({
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					});
				}),
				cancel: () => close(),
				mcpServerStatus: () => Promise.resolve([]),
			};
		},
	};
	return {
		provider,
		getQueryCallCount: () => queryCallCount,
		closeStream: close,
	};
}

describe("SessionManager — Slice B AgentSession reuse", () => {
	it("two consecutive runQuery calls in same chat reuse one provider.query()", async () => {
		const ctl = makeLongLivedProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		await sm.runQuery("first", () => {}, "sess-1");
		await sm.runQuery("second", () => {}, "sess-1");

		expect(ctl.getQueryCallCount()).toBe(1);
		ctl.closeStream();
	});

	it("switching to a different sessionId rebuilds the AgentSession", async () => {
		const ctl = makeLongLivedProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		await sm.runQuery("first", () => {}, "sess-A");
		await sm.runQuery("second", () => {}, "sess-B");

		expect(ctl.getQueryCallCount()).toBe(2);
		ctl.closeStream();
	});

	it("clearHistory tears down the cached AgentSession", async () => {
		const ctl = makeLongLivedProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		await sm.runQuery("first", () => {}, "sess-1");
		sm.clearHistory();
		await sm.runQuery("second", () => {}, "sess-2");

		expect(ctl.getQueryCallCount()).toBe(2);
		ctl.closeStream();
	});

	it("abort tears down the cached AgentSession", async () => {
		const ctl = makeLongLivedProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		await sm.runQuery("first", () => {}, "sess-1");
		sm.abort();
		await sm.runQuery("second", () => {}, "sess-1");

		expect(ctl.getQueryCallCount()).toBe(2);
		ctl.closeStream();
	});

	it("regression: cached iterator survives turn-boundary break (for-await must not close it)", async () => {
		// Use a real AsyncGenerator (which has a `return` method) to catch
		// the for-await early-exit bug. A naive impl that returns the
		// underlying iter from [Symbol.asyncIterator] gets closed by
		// iterateConversation's `return` on done — symptom: turn 2 hangs
		// because every iter.next() resolves done=true forever.
		let generatorReturnCalled = 0;
		const eventQueue: AgentEvent[] = [];
		const waiters: Array<(e: AgentEvent | null) => void> = [];

		function pushEvent(e: AgentEvent): void {
			const w = waiters.shift();
			if (w) w(e);
			else eventQueue.push(e);
		}

		const realGenerator = (async function* (): AsyncGenerator<AgentEvent> {
			try {
				yield { type: "session_start", sessionId: "sdk-real" };
				while (true) {
					if (eventQueue.length > 0) {
						const next = eventQueue.shift();
						if (next) yield next;
						continue;
					}
					const next = await new Promise<AgentEvent | null>((r) => {
						waiters.push(r);
					});
					if (next === null) return;
					yield next;
				}
			} finally {
				generatorReturnCalled++;
			}
		})();

		// Wrap the inner iterator so consumer's break/return DOES NOT close
		// the underlying generator (mirrors ClaudeAgentSession's wrapper).
		const innerIter = realGenerator[Symbol.asyncIterator]();
		const wrapperIter: AsyncIterator<AgentEvent> = {
			next: () => innerIter.next(),
			return: async () =>
				({ value: undefined, done: true }) as IteratorResult<AgentEvent>,
		};

		const provider: AgentProvider = {
			providerId: "claude",
			query(_p: AgentQueryParams): AgentSession {
				return {
					[Symbol.asyncIterator]: () => wrapperIter,
					send: vi.fn(async () => {
						pushEvent({
							type: "done",
							cost: 0,
							turns: 1,
							durationMs: 0,
							usage: { inputTokens: 1, outputTokens: 1 },
						});
					}),
					cancel: () => {
						const w = waiters.shift();
						w?.(null);
					},
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const events1: ServerMessage[] = [];
		const events2: ServerMessage[] = [];

		await sm.runQuery("first", (m) => events1.push(m), "sess-1");
		expect(events1.some((m) => m.type === "done")).toBe(true);
		expect(generatorReturnCalled).toBe(0);

		// CRITICAL: turn 2 must receive its own done event. With a naive
		// [Symbol.asyncIterator] that returns the raw AsyncGenerator,
		// for-await's exit closes it and turn 2 hangs.
		await Promise.race([
			sm.runQuery("second", (m) => events2.push(m), "sess-1"),
			new Promise((_, rej) =>
				setTimeout(() => rej(new Error("turn 2 hung")), 1000),
			),
		]);
		expect(events2.some((m) => m.type === "done")).toBe(true);
	});

	it("runOneTurn calls agentSession.send() with the user message", async () => {
		const ctl = makeLongLivedProvider();
		const sendSpies: Array<ReturnType<typeof vi.fn>> = [];
		const wrappedProvider: AgentProvider = {
			providerId: "claude",
			query(p: AgentQueryParams): AgentSession {
				const sess = ctl.provider.query(p);
				sendSpies.push(sess.send as ReturnType<typeof vi.fn>);
				return sess;
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(wrappedProvider));
		await sm.runQuery("hello world", () => {}, "sess-1");
		const lastSendSpy = sendSpies[0];
		expect(lastSendSpy).not.toBeNull();
		if (!lastSendSpy) throw new Error("send spy was never assigned");
		expect(lastSendSpy).toHaveBeenCalledTimes(1);
		const sentArg = lastSendSpy.mock.calls[0][0] as string;
		// buildPrompt is mocked at module level to return "test prompt", which
		// SessionManager forwards verbatim to agentSession.send().
		expect(sentArg).toBe("test prompt");
		ctl.closeStream();
	});
});

// ── handleRateLimit → updateWindowMark ───────────────────────────────────────
// proxy.ts is NOT mocked in this file, so updateWindowMark writes to the real
// in-memory windowHighMark and getWindowMark can verify it. Uses unique
// ── local_command_output ──────────────────────────────────────────────────────

describe("SessionManager — exact context usage", () => {
	it("prefers provider-reported context occupancy over turn input estimates", async () => {
		const provider: AgentProvider = {
			providerId: "acp:test",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield {
						type: "usage",
						inputTokens: 0,
						outputTokens: 0,
						contextTokens: 1_234,
						contextWindow: 8_192,
					};
					yield {
						type: "done",
						cost: 0.25,
						turns: 1,
						durationMs: 1,
						usage: { inputTokens: 4, outputTokens: 2 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery(
			"hello",
			(message) => emitted.push(message),
			"sess-context",
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "usage_update",
				tokens_in_context: 1_234,
				context_window: 8_192,
			}),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "done",
				tokens_in_context: 1_234,
				context_window: 8_192,
			}),
		);
	});
});

describe("SessionManager — local_command_output forwarding", () => {
	it("emits local_command_output WS message when agent yields local_command_output event", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-cmd-1" };
					yield { type: "local_command_output", content: "/help output here" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 5, outputTokens: 2 },
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

		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", (m) => emitted.push(m), "sess-cmd-1");

		expect(
			emitted.some(
				(m) =>
					m.type === "local_command_output" &&
					(m as { type: string; content: string }).content ===
						"/help output here",
			),
		).toBe(true);
	});

	it("does not interrupt text accumulation around local_command_output", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-cmd-2" };
					yield { type: "local_command_output", content: "cmd out" };
					yield { type: "text_delta", text: "assistant reply" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 5, outputTokens: 2 },
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

		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", (m) => emitted.push(m), "sess-cmd-2");

		expect(emitted.some((m) => m.type === "local_command_output")).toBe(true);
		expect(emitted.some((m) => m.type === "chunk")).toBe(true);
	});
});

describe("SessionManager — deferred MCP discovery", () => {
	it("refreshes Claude MCP status again when the first turn completes", async () => {
		const mcpServerStatus = vi
			.fn<() => Promise<McpServerStatus[]>>()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					name: "claude.ai Excalidraw",
					status: "connected" as const,
					scope: "claudeai",
				},
			]);
		const provider: AgentProvider = {
			providerId: "claude",
			probeRequiresTurn: true,
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-mcp-late" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus,
				};
			},
		};
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("hello", (message) => emitted.push(message), "sess-mcp");

		expect(mcpServerStatus).toHaveBeenCalledTimes(2);
		expect(sm.getLastMcpStatus("claude")).toEqual([
			{
				name: "claude.ai Excalidraw",
				status: "connected",
				scope: "claudeai",
			},
		]);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "mcp_status",
				provider_id: "claude",
				servers: [
					expect.objectContaining({
						name: "claude.ai Excalidraw",
						status: "connected",
					}),
				],
			}),
		);
	});

	it("keeps checking while a Claude.ai MCP is still pending", async () => {
		vi.useFakeTimers();
		try {
			const mcpServerStatus = vi
				.fn<() => Promise<McpServerStatus[]>>()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([
					{ name: "claude.ai Excalidraw", status: "pending" as const },
				])
				.mockResolvedValueOnce([
					{ name: "claude.ai Excalidraw", status: "connected" as const },
				]);
			const provider: AgentProvider = {
				providerId: "claude",
				probeRequiresTurn: true,
				query(): AgentSession {
					const gen = (async function* (): AsyncGenerator<AgentEvent> {
						yield { type: "session_start", sessionId: "sdk-mcp-pending" };
						yield {
							type: "done",
							cost: 0,
							turns: 1,
							durationMs: 0,
							usage: { inputTokens: 1, outputTokens: 1 },
						};
					})();
					return {
						[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
						cancel: vi.fn(),
						send: vi.fn().mockResolvedValue(undefined),
						mcpServerStatus,
					};
				},
			};
			const emitted: ServerMessage[] = [];
			const sm = new SessionManager(makeConfig(), makeProviders(provider));

			await sm.runQuery(
				"hello",
				(message) => emitted.push(message),
				"sess-mcp-pending",
			);
			expect(sm.getLastMcpStatus("claude")?.[0].status).toBe("pending");

			await vi.advanceTimersByTimeAsync(500);

			expect(sm.getLastMcpStatus("claude")?.[0].status).toBe("connected");
			expect(mcpServerStatus).toHaveBeenCalledTimes(3);
			expect(
				emitted.some(
					(message) =>
						message.type === "mcp_status" &&
						message.servers[0]?.status === "connected",
				),
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── probeSlashCommands ────────────────────────────────────────────────────────

describe("SessionManager — probeSlashCommands", () => {
	it("serializes simultaneous MCP and command probes without dropping either", async () => {
		const query = vi.fn(
			(): AgentSession => ({
				async *[Symbol.asyncIterator]() {},
				cancel: vi.fn(),
				send: vi.fn().mockResolvedValue(undefined),
				mcpServerStatus: () =>
					Promise.resolve([{ name: "github", status: "connected" as const }]),
				supportedCommands: () =>
					Promise.resolve([
						{ name: "review", description: "Review changes", argumentHint: "" },
					]),
			}),
		);
		const provider: AgentProvider = { providerId: "codex", query };
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await Promise.all([
			sm.probeMcpStatus((message) => emitted.push(message), {
				agentCwd: "/tmp/project",
			}),
			sm.probeSlashCommands((message) => emitted.push(message)),
		]);

		expect(query).toHaveBeenCalledTimes(2);
		expect(emitted.some((message) => message.type === "mcp_status")).toBe(true);
		expect(emitted.some((message) => message.type === "slash_commands")).toBe(
			true,
		);
		expect(sm.getLastMcpStatus()).toBeNull();
	});

	it("does not start a hidden assistant turn for turn-gated providers", async () => {
		const query = vi.fn();
		const provider: AgentProvider = {
			providerId: "claude",
			probeRequiresTurn: true,
			query,
		};
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.probeSlashCommands((message) => emitted.push(message), {
			agentCwd: "/tmp/project",
			sessionId: "session-1",
		});
		expect(query).not.toHaveBeenCalled();
		expect(emitted).toEqual([
			{
				type: "slash_commands",
				provider_id: "claude",
				agent_cwd: "/tmp/project",
				session_id: "session-1",
				commands: [],
			},
		]);
	});

	it("emits slash_commands WS message with commands from supportedCommands()", async () => {
		const mockCommands = [
			{ name: "help", description: "Show help", argumentHint: "" },
			{ name: "usage", description: "Show token usage", argumentHint: "" },
		];

		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
					supportedCommands: () => Promise.resolve(mockCommands),
				};
			},
		};

		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.probeSlashCommands((m) => emitted.push(m));

		expect(
			emitted.some(
				(m) =>
					m.type === "slash_commands" &&
					(m as { type: string; commands: unknown[] }).commands.length === 2,
			),
		).toBe(true);
	});

	it("does not throw when supportedCommands is not available on provider session", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
					// no supportedCommands
				};
			},
		};

		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await expect(
			sm.probeSlashCommands((m) => emitted.push(m)),
		).resolves.not.toThrow();
	});
});

// providerId strings to avoid colliding with other tests.

describe("SessionManager — handleRateLimit mirrors rate_limit into window mark", () => {
	function makeRateLimitProvider(
		providerId: string,
		utilization: number | undefined,
		resetsAt: number | undefined,
		rateLimitType = "five_hour",
	): AgentProvider {
		return {
			providerId,
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-rl-1" };
					yield {
						type: "rate_limit",
						status: "warning",
						rateLimitType,
						utilization,
						resetsAt,
					};
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
	}

	it("sets window mark after rate_limit event with utilization", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3600;
		const provider = makeRateLimitProvider("rl-mirror", 0.75, resetsAt);
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("test", () => {}, "sess-rl");
		const mark = getWindowMark("rl-mirror", "five_hour");
		expect(mark?.utilization).toBeCloseTo(0.75);
		expect(mark?.resetsAt).toBe(resetsAt);
	});

	it('translates SDK "seven_day" → "weekly" window mark and emitted rateLimitType', async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3600;
		const provider = makeRateLimitProvider(
			"rl-7day",
			0.6,
			resetsAt,
			"seven_day",
		);
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const emitted: ServerMessage[] = [];
		await sm.runQuery("test", (m) => emitted.push(m), "sess-7day");
		// window mark written under "weekly", NOT "seven_day"
		expect(getWindowMark("rl-7day", "weekly")?.utilization).toBeCloseTo(0.6);
		expect(getWindowMark("rl-7day", "seven_day")).toBeUndefined();
		// emitted WS message carries canonical name
		const rlMsg = emitted.find((m) => m.type === "rate_limit") as
			| RateLimitMessage
			| undefined;
		expect(rlMsg?.rateLimitType).toBe("weekly");
	});

	it('translates SDK "seven_day_sonnet" → "weekly_sonnet" window mark and emitted rateLimitType', async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3600;
		const provider = makeRateLimitProvider(
			"rl-sonnet",
			0.4,
			resetsAt,
			"seven_day_sonnet",
		);
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const emitted: ServerMessage[] = [];
		await sm.runQuery("test", (m) => emitted.push(m), "sess-sonnet");
		expect(
			getWindowMark("rl-sonnet", "weekly_sonnet")?.utilization,
		).toBeCloseTo(0.4);
		expect(getWindowMark("rl-sonnet", "seven_day_sonnet")).toBeUndefined();
		const rlMsg = emitted.find((m) => m.type === "rate_limit") as
			| RateLimitMessage
			| undefined;
		expect(rlMsg?.rateLimitType).toBe("weekly_sonnet");
	});

	it("does not set window mark when utilization is absent", async () => {
		// event.utilization == null → handleRateLimit skips the updateWindowMark call
		const provider = makeRateLimitProvider("rl-no-util", undefined, undefined);
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("test", () => {}, "sess-rl-null");
		expect(getWindowMark("rl-no-util", "five_hour")).toBeUndefined();
	});

	it("does not set window mark when rateLimitType is absent", async () => {
		const provider: AgentProvider = {
			providerId: "rl-no-type",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-rl-2" };
					// rateLimitType omitted — condition: event.utilization != null && event.rateLimitType
					yield { type: "rate_limit", status: "warning", utilization: 0.5 };
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
		await sm.runQuery("test", () => {}, "sess-rl-notype");
		// No windowId → no mark should be written (rateLimitType is the windowId key)
		expect(getWindowMark("rl-no-type", "five_hour")).toBeUndefined();
	});

	it("lower utilization replaces higher within same window after second rate_limit event", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3600;

		// First session: sets mark at 0.75
		const providerHigh = makeRateLimitProvider("rl-downward", 0.75, resetsAt);
		const smHigh = new SessionManager(
			makeConfig(),
			makeProviders(providerHigh),
		);
		await smHigh.runQuery("test", () => {}, "sess-rl-high");
		expect(getWindowMark("rl-downward", "five_hour")?.utilization).toBeCloseTo(
			0.75,
		);

		// Second session: same resetsAt, lower utilization = external Anthropic reset
		const providerLow = makeRateLimitProvider("rl-downward", 0.12, resetsAt);
		const smLow = new SessionManager(makeConfig(), makeProviders(providerLow));
		await smLow.runQuery("test", () => {}, "sess-rl-low");
		expect(getWindowMark("rl-downward", "five_hour")?.utilization).toBeCloseTo(
			0.12,
		);
	});
});

// ── status event ordering ─────────────────────────────────────────────────────

/**
 * Bug fix: "status: running" must fire AFTER initSessionContext so that
 * getCurrentSessionId() is non-null when clients receive the event.
 * Previously drainTurnQueue emitted it before runOneTurn → before
 * initSessionContext set currentSessionId.
 */
describe("SessionManager — status:running fires after initSessionContext", () => {
	/** Provider that completes immediately (no tool permission gate). */
	function makeImmediateProvider(): AgentProvider {
		return {
			providerId: "claude",
			query(): ReturnType<AgentProvider["query"]> {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-immediate" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
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
	}

	it("getCurrentSessionId() is non-null when status:running event fires", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeImmediateProvider()),
		);

		let sessionIdOnRunning: string | null | undefined;

		await sm.runQuery(
			"hello",
			(event) => {
				if (event.type === "status" && event.state === "running") {
					sessionIdOnRunning = sm.getCurrentSessionId();
				}
			},
			"test-db-session-id",
		);

		// status:running must have fired (undefined means it never fired)
		expect(sessionIdOnRunning).not.toBeUndefined();
		// and currentSessionId must be set at that point
		expect(sessionIdOnRunning).toBe("test-db-session-id");
	});

	it("turn_id is included in status:running when provided", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeImmediateProvider()),
		);

		let runningEvent: Record<string, unknown> | null = null;

		await sm.runQuery(
			"hello",
			(event) => {
				if (event.type === "status" && event.state === "running") {
					runningEvent = event as Record<string, unknown>;
				}
			},
			"test-db-session-id",
			undefined,
			undefined,
			undefined,
			"turn-abc-123",
		);

		expect(runningEvent).not.toBeNull();
		expect((runningEvent as { turn_id?: string } | null)?.turn_id).toBe(
			"turn-abc-123",
		);
	});
});

// ── auto-sleep gates ──────────────────────────────────────────────────────────

describe("SessionManager — auto-sleep gates", () => {
	const AUTO_SLEEP = {
		enabled: true,
		threshold: 0.95,
		max_sleep_minutes: 360,
		resume_buffer_seconds: 0,
	};

	function sleepConfig(): HlidConfig {
		return { ...makeConfig(), auto_sleep: AUTO_SLEEP } as HlidConfig;
	}

	function epochNow(): number {
		return Math.floor(Date.now() / 1000);
	}

	/** Provider that completes immediately (no tool permission gate). */
	function makeImmediateProvider(): AgentProvider {
		return {
			providerId: "claude",
			query(): ReturnType<AgentProvider["query"]> {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-sleep" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
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
	}

	beforeEach(() => {
		vi.mocked(loadConfig).mockReturnValue(sleepConfig());
	});

	afterEach(() => {
		resetUsageGate();
		vi.mocked(loadConfig).mockReset();
	});

	it.each([
		"claude",
		"codex",
	] as const)("registers the normalized %s PreToolUse gate for the provider session", async (providerId) => {
		const provider: AgentProvider = {
			...makeImmediateProvider(),
			providerId,
		};
		const sm = new SessionManager(sleepConfig(), makeProviders(provider));

		await sm.runQuery("hi", vi.fn(), `sleep-${providerId}-hook`);

		const registration = vi
			.mocked(registerUmbodApprovalSession)
			.mock.calls.at(-1);
		expect(registration?.[0]).toBe("sdk-sleep");
		expect(registration?.[2]).toBeTypeOf("function");
	});

	it("turn gate holds dispatch until the hard limit expires, emitting sleeping/resumed", async () => {
		// Hard limit that lifts in ~1s (buffer 0).
		reportRateLimitSignal("claude", "five_hour", "rejected", epochNow() + 1);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeImmediateProvider()),
		);
		await sm.runQuery("hi", (m) => emitted.push(m), "sleep-turn");

		const sleeps = emitted.filter((m) => m.type === "agent_sleep");
		expect(sleeps[0]).toMatchObject({
			state: "sleeping",
			providerId: "claude",
			reason: "limit_reached",
			windowId: "five_hour",
		});
		expect(sleeps.at(-1)).toMatchObject({ state: "resumed", cause: "reset" });
		// The turn ran to completion after the wake.
		expect(emitted.some((m) => m.type === "done")).toBe(true);
	});

	it("abort during a turn-gate sleep cancels without dispatching", async () => {
		reportRateLimitSignal("claude", "five_hour", "rejected", epochNow() + 3600);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeImmediateProvider()),
		);
		const turn = sm.runQuery("hi", (m) => emitted.push(m), "sleep-abort");
		await waitFor(() =>
			expect(
				emitted.some((m) => m.type === "agent_sleep" && m.state === "sleeping"),
			).toBe(true),
		);
		sm.abort();
		await turn;

		expect(emitted).toContainEqual(
			expect.objectContaining({ type: "agent_sleep", cause: "aborted" }),
		);
		// Provider never ran: no session_start / done.
		expect(emitted.some((m) => m.type === "done")).toBe(false);
		expect(sm.getSleepState()).toBeNull();
	});

	it("tool gate defers the permission pipeline until skipSleep, so no card shows while sleeping", async () => {
		const emitted: ServerMessage[] = [];
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-toolgate" };
					// Consumed (and fed to reportRateLimitSignal) before the next
					// generator step, so the hard limit is set before canUseTool.
					yield {
						type: "rate_limit",
						status: "rejected",
						rateLimitType: "five_hour",
						resetsAt: epochNow() + 3600,
					};
					await params.canUseTool(
						"Bash",
						{},
						{
							toolUseID: "tid-sleep",
							signal: new AbortController().signal,
							title: undefined,
							displayName: undefined,
							description: undefined,
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
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const turn = sm.runQuery("hi", (m) => emitted.push(m), "sleep-tool");

		await waitFor(() =>
			expect(
				emitted.some((m) => m.type === "agent_sleep" && m.state === "sleeping"),
			).toBe(true),
		);
		// Sleeping at the tool gate: the permission card must not have appeared.
		expect(emitted.some((m) => m.type === "permission_request")).toBe(false);

		sm.skipSleep();
		await waitFor(() =>
			expect(emitted.some((m) => m.type === "permission_request")).toBe(true),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({ type: "agent_sleep", cause: "skipped" }),
		);
		sm.handlePermissionResponse("tid-sleep", true);
		await turn;
		expect(emitted.some((m) => m.type === "done")).toBe(true);
	});

	it("gates special question tools before they can resume the model", async () => {
		const emitted: ServerMessage[] = [];
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-question-gate" };
					yield {
						type: "rate_limit",
						status: "rejected",
						rateLimitType: "five_hour",
						resetsAt: epochNow() + 3600,
					};
					await params.canUseTool(
						"AskUserQuestion",
						{
							questions: [
								{
									question: "Continue?",
									header: "Continue",
									options: [{ label: "Yes" }, { label: "No" }],
								},
							],
						},
						{
							toolUseID: "question-sleep",
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
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const sm = new SessionManager(sleepConfig(), makeProviders(provider));
		const turn = sm.runQuery("hi", (m) => emitted.push(m), "sleep-question");

		await waitFor(() =>
			expect(
				emitted.some((m) => m.type === "agent_sleep" && m.state === "sleeping"),
			).toBe(true),
		);
		expect(sm.getPendingAskUserQuestions()).toHaveLength(0);

		sm.skipSleep();
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);
		sm.handleAskUserQuestionResponse("question-sleep", {
			"Continue?": ["Yes"],
		});
		await turn;
		expect(emitted.some((m) => m.type === "done")).toBe(true);
	});

	it("handleRateLimit registers provider hard limits for the gate", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-rl" };
					yield {
						type: "rate_limit",
						status: "rejected",
						rateLimitType: "five_hour",
						resetsAt: epochNow() + 3600,
					};
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
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
		await sm.runQuery("hi", () => {}, "sleep-register");
		expect(evaluateSleep("claude", AUTO_SLEEP)).toMatchObject({
			reason: "limit_reached",
		});
	});

	it("getSleepState() exposes the banner for sync replay while sleeping", async () => {
		reportRateLimitSignal("claude", "five_hour", "rejected", epochNow() + 3600);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeImmediateProvider()),
		);
		const turn = sm.runQuery("hi", (m) => emitted.push(m), "sleep-replay");
		await waitFor(() =>
			expect(sm.getSleepState()).toMatchObject({
				type: "agent_sleep",
				state: "sleeping",
			}),
		);
		sm.skipSleep();
		await turn;
		expect(sm.getSleepState()).toBeNull();
	});
});
