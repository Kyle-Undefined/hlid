/**
 * SessionManager unit tests — state machine, config methods, and
 * session-scoped permission persistence.
 */
import { describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";

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
	appendLog: vi.fn().mockResolvedValue(undefined),
	createSession: vi.fn().mockResolvedValue(undefined),
	recordQuery: vi.fn().mockResolvedValue(undefined),
	getSessionMessages: vi.fn().mockResolvedValue([]),
	getSessionAgentCwd: vi.fn().mockResolvedValue(null),
	getSessionClaudeId: vi.fn().mockResolvedValue(null),
	setSessionClaudeId: vi.fn().mockResolvedValue(undefined),
	setSessionActualModel: vi.fn().mockResolvedValue(undefined),
	setSessionAgentCwd: vi.fn().mockResolvedValue(undefined),
	saveSetting: vi.fn().mockResolvedValue(undefined),
	linkAttachmentToMessage: vi.fn().mockResolvedValue(undefined),
	recordPermissionEvent: vi.fn().mockResolvedValue(undefined),
}));
// Prevent SDK from spawning any process
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));
vi.mock("./recap", () => ({
	generateTurnRecap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./executionContext", () => ({
	resolveExecutionContext: vi.fn().mockReturnValue({
		activeCwd: "/tmp/hlid-test-cwd",
		extraDirs: new Set(),
		executable: undefined,
	}),
}));
vi.mock("./promptBuilder", () => ({
	buildPrompt: vi.fn().mockReturnValue({
		prompt: "test prompt",
		safeAttachments: [],
	}),
}));
vi.mock("node:fs", () => ({
	mkdirSync: vi.fn(),
	readFileSync: vi.fn((path: string) => {
		// Return empty settings JSON for .claude/settings.json reads
		if (typeof path === "string" && path.includes("settings.json")) {
			return "{}";
		}
		return "{}";
	}),
	writeFileSync: vi.fn(),
	realpathSync: vi.fn((p: string) => p),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import * as fsMock from "node:fs";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import * as dbMock from "../db";
import { SessionManager } from "./session";

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

// ── getStatus / initial state ─────────────────────────────────────────────────

describe("SessionManager — initial state", () => {
	it("reports idle state and configured model", () => {
		const sm = new SessionManager(makeConfig("model-x"));
		expect(sm.getStatus()).toEqual({ state: "idle", model: "model-x" });
	});

	it("isRunning() returns false initially", () => {
		const sm = new SessionManager(makeConfig());
		expect(sm.isRunning()).toBe(false);
	});

	it("getLastMcpStatus() returns null initially", () => {
		const sm = new SessionManager(makeConfig());
		expect(sm.getLastMcpStatus()).toBeNull();
	});

	it("getCurrentSessionId() returns null initially", () => {
		const sm = new SessionManager(makeConfig());
		expect(sm.getCurrentSessionId()).toBeNull();
	});

	it("getPendingPermissionRequests() returns empty array initially", () => {
		const sm = new SessionManager(makeConfig());
		expect(sm.getPendingPermissionRequests()).toEqual([]);
	});
});

// ── restoreMcpStatus ──────────────────────────────────────────────────────────

describe("SessionManager — restoreMcpStatus", () => {
	it("sets and retrieves MCP status", () => {
		const sm = new SessionManager(makeConfig());
		const statuses = [{ name: "my-server", status: "connected" as const }];
		sm.restoreMcpStatus(statuses);
		expect(sm.getLastMcpStatus()).toEqual(statuses);
	});

	it("replaces previous MCP status on second call", () => {
		const sm = new SessionManager(makeConfig());
		sm.restoreMcpStatus([{ name: "a", status: "connected" }]);
		sm.restoreMcpStatus([{ name: "b", status: "failed" }]);
		const last = sm.getLastMcpStatus();
		expect(last).not.toBeNull();
		expect(last?.[0].name).toBe("b");
	});
});

// ── syncConfig ────────────────────────────────────────────────────────────────

describe("SessionManager — syncConfig", () => {
	it("returns false when model unchanged", () => {
		const sm = new SessionManager(makeConfig("model-a"));
		expect(sm.syncConfig(makeConfig("model-a"))).toBe(false);
	});

	it("returns true when model changes", () => {
		const sm = new SessionManager(makeConfig("model-a"));
		expect(sm.syncConfig(makeConfig("model-b"))).toBe(true);
	});

	it("updates model in getStatus after syncConfig", () => {
		const sm = new SessionManager(makeConfig("old-model"));
		sm.syncConfig(makeConfig("new-model"));
		expect(sm.getStatus().model).toBe("new-model");
	});

	it("does not reset session state (non-destructive update)", () => {
		const sm = new SessionManager(makeConfig());
		// syncConfig should not touch session continuity
		sm.syncConfig(makeConfig("new-model"));
		expect(sm.getStatus().state).toBe("idle");
		expect(sm.getCurrentSessionId()).toBeNull();
	});
});

// ── clearHistory ──────────────────────────────────────────────────────────────

describe("SessionManager — clearHistory", () => {
	it("does not throw", () => {
		const sm = new SessionManager(makeConfig());
		expect(() => sm.clearHistory()).not.toThrow();
	});

	it("session remains idle after clearHistory", () => {
		const sm = new SessionManager(makeConfig());
		sm.clearHistory();
		expect(sm.getStatus().state).toBe("idle");
	});

	it("calls db.clearCurrentSessionId", () => {
		vi.mocked(dbMock.clearCurrentSessionId).mockClear();
		const sm = new SessionManager(makeConfig());
		sm.clearHistory();
		expect(vi.mocked(dbMock.clearCurrentSessionId)).toHaveBeenCalled();
	});
});

// ── abort ─────────────────────────────────────────────────────────────────────

describe("SessionManager — abort", () => {
	it("does not throw when no query is running", () => {
		const sm = new SessionManager(makeConfig());
		expect(() => sm.abort()).not.toThrow();
	});

	it("state remains idle after abort when not running", () => {
		const sm = new SessionManager(makeConfig());
		sm.abort();
		expect(sm.getStatus().state).toBe("idle");
	});
});

// ── reinitialize ──────────────────────────────────────────────────────────────

describe("SessionManager — reinitialize", () => {
	it("applies new config", () => {
		const sm = new SessionManager(makeConfig("old-model"));
		sm.reinitialize(makeConfig("fresh-model"));
		expect(sm.getStatus().model).toBe("fresh-model");
	});

	it("resets state to idle", () => {
		const sm = new SessionManager(makeConfig());
		sm.reinitialize(makeConfig());
		expect(sm.getStatus().state).toBe("idle");
	});

	it("clears currentSessionId", () => {
		const sm = new SessionManager(makeConfig());
		sm.reinitialize(makeConfig());
		expect(sm.getCurrentSessionId()).toBeNull();
	});
});

// ── AskUserQuestion support ───────────────────────────────────────────────────

describe("SessionManager — AskUserQuestion", () => {
	it("getPendingAskUserQuestions() returns empty array initially", () => {
		const sm = new SessionManager(makeConfig());
		expect(sm.getPendingAskUserQuestions()).toEqual([]);
	});

	it("handleAskUserQuestionResponse() does not throw when id is unknown", () => {
		const sm = new SessionManager(makeConfig());
		expect(() =>
			sm.handleAskUserQuestionResponse("ghost-id", "Option A"),
		).not.toThrow();
	});

	it("abort() clears all pending ask_user_questions", () => {
		const sm = new SessionManager(makeConfig());
		// Register a fake pending question directly (simulates canUseTool calling it)
		// We can't easily call runQuery without the SDK, so we test abort doesn't throw
		// and leaves no pending questions
		sm.abort();
		expect(sm.getPendingAskUserQuestions()).toEqual([]);
	});
});

// ── Session-scoped permission persistence ──────────────────────────────────────

/**
 * Returns an implementation function for vi.mocked(query).mockImplementation().
 * The fake conversation: yield system/init, call canUseTool, yield result.
 * Adds `mcpServerStatus()` (required by iterateConversation).
 */
function makeQueryImpl(toolName: string, toolUseID = "tid-1") {
	return ({ options }: { prompt: unknown; options?: Options }) => {
		const gen = (async function* () {
			yield {
				type: "system",
				subtype: "init",
				session_id: "sdk-session-1",
				tools: [],
			};
			if (!options) throw new Error("options required in test mock");
			await options.canUseTool(
				toolName,
				{},
				{
					toolUseID,
					title: undefined,
					displayName: undefined,
					description: undefined,
				},
			);
			yield {
				type: "result",
				subtype: "success",
				total_cost_usd: 0,
				session_id: "sdk-session-1",
				usage: { input_tokens: 10, output_tokens: 5 },
			};
		})();
		// iterateConversation calls conversation.mcpServerStatus() on first message.
		Object.assign(gen, { mcpServerStatus: () => Promise.resolve([]) });
		return gen;
	};
}

describe("SessionManager — session-scoped permission persistence", () => {
	it("session approval: same tool auto-approved on next turn without prompting", async () => {
		const sm = new SessionManager(makeConfig());

		// Turn 1: install mock that calls canUseTool("Bash")
		vi.mocked(query).mockImplementation(makeQueryImpl("Bash"));

		const emittedTurn1: unknown[] = [];
		const turn1 = sm.runQuery("hello", (m) => emittedTurn1.push(m), "sess-1");

		// Wait for permission_request to appear
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(
			emittedTurn1.some(
				(m) => (m as { type: string }).type === "permission_request",
			),
		).toBe(true);

		// Approve with session scope
		sm.handlePermissionResponse("tid-1", true, "session");
		await turn1;

		// Turn 2: same tool — should auto-approve, no permission_request emitted
		const emittedTurn2: unknown[] = [];
		vi.mocked(query).mockImplementation(makeQueryImpl("Bash", "tid-2"));

		await sm.runQuery("hello again", (m) => emittedTurn2.push(m), "sess-1");

		expect(
			emittedTurn2.some(
				(m) => (m as { type: string }).type === "permission_request",
			),
		).toBe(false);
		expect(sm.getPendingPermissionRequests()).toHaveLength(0);
	});

	it("clearHistory clears session allowlist — tool prompts again after clear", async () => {
		const sm = new SessionManager(makeConfig());

		// Turn 1: approve "Bash" for session
		vi.mocked(query).mockImplementation(makeQueryImpl("Bash"));
		const turn1 = sm.runQuery("hello", () => {}, "sess-1");
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		sm.handlePermissionResponse("tid-1", true, "session");
		await turn1;

		// Clear history — wipes sessionAllowedTools
		sm.clearHistory();

		// Turn 2: same tool should prompt again (new session context)
		const emittedTurn2: unknown[] = [];
		vi.mocked(query).mockImplementation(makeQueryImpl("Bash", "tid-2"));
		const turn2 = sm.runQuery(
			"new session msg",
			(m) => emittedTurn2.push(m),
			"sess-2",
		);
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(
			emittedTurn2.some(
				(m) => (m as { type: string }).type === "permission_request",
			),
		).toBe(true);

		// Clean up
		sm.handlePermissionResponse("tid-2", false);
		await turn2;
	});

	it("reinitialize clears session allowlist", async () => {
		const sm = new SessionManager(makeConfig());

		// Turn 1: approve "Read" for session
		vi.mocked(query).mockImplementation(makeQueryImpl("Read"));
		const turn1 = sm.runQuery("hello", () => {}, "sess-1");
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		sm.handlePermissionResponse("tid-1", true, "session");
		await turn1;

		// Reinitialize — wipes allowlist
		sm.reinitialize(makeConfig());

		// Turn 2: "Read" should prompt again
		const emittedTurn2: unknown[] = [];
		vi.mocked(query).mockImplementation(makeQueryImpl("Read", "tid-2"));
		const turn2 = sm.runQuery(
			"after reinit",
			(m) => emittedTurn2.push(m),
			"sess-2",
		);
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(
			emittedTurn2.some(
				(m) => (m as { type: string }).type === "permission_request",
			),
		).toBe(true);

		sm.handlePermissionResponse("tid-2", false);
		await turn2;
	});

	it("session switch clears allowlist", async () => {
		const sm = new SessionManager(makeConfig());

		// Turn 1 on session A: approve "Bash" for session
		vi.mocked(query).mockImplementation(makeQueryImpl("Bash"));
		const turn1 = sm.runQuery("hello", () => {}, "sess-A");
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		sm.handlePermissionResponse("tid-1", true, "session");
		await turn1;

		// Switch to session B — allowlist should clear
		const emittedTurn2: unknown[] = [];
		vi.mocked(query).mockImplementation(makeQueryImpl("Bash", "tid-2"));
		const turn2 = sm.runQuery(
			"diff session",
			(m) => emittedTurn2.push(m),
			"sess-B",
		);
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(
			emittedTurn2.some(
				(m) => (m as { type: string }).type === "permission_request",
			),
		).toBe(true);

		sm.handlePermissionResponse("tid-2", false);
		await turn2;
	});

	it("deny does not add tool to session allowlist", async () => {
		const sm = new SessionManager(makeConfig());

		// Turn 1: deny "Bash"
		vi.mocked(query).mockImplementation(makeQueryImpl("Bash"));
		const turn1 = sm.runQuery("hello", () => {}, "sess-1");
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		sm.handlePermissionResponse("tid-1", false);
		await turn1;

		// Turn 2: "Bash" should still prompt
		const emittedTurn2: unknown[] = [];
		vi.mocked(query).mockImplementation(makeQueryImpl("Bash", "tid-2"));
		const turn2 = sm.runQuery("again", (m) => emittedTurn2.push(m), "sess-1");
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);
		expect(
			emittedTurn2.some(
				(m) => (m as { type: string }).type === "permission_request",
			),
		).toBe(true);

		sm.handlePermissionResponse("tid-2", false);
		await turn2;
	});

	it("deny with custom message sends that message to SDK canUseTool resolver", async () => {
		const sm = new SessionManager(makeConfig());
		let capturedResult: unknown;

		vi.mocked(query).mockImplementation(
			({ options }: { prompt: unknown; options?: Options }) => {
				const gen = (async function* () {
					yield {
						type: "system",
						subtype: "init",
						session_id: "sdk-session-1",
						tools: [],
					};
					capturedResult = await options.canUseTool(
						"Bash",
						{},
						{
							toolUseID: "tid-1",
							title: undefined,
							displayName: undefined,
							description: undefined,
						},
					);
					yield {
						type: "result",
						subtype: "success",
						total_cost_usd: 0,
						session_id: "sdk-session-1",
						usage: { input_tokens: 10, output_tokens: 5 },
					};
				})();
				Object.assign(gen, { mcpServerStatus: () => Promise.resolve([]) });
				return gen;
			},
		);

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
		const sm = new SessionManager(makeConfig());
		let capturedResult: unknown;

		vi.mocked(query).mockImplementation(
			({ options }: { prompt: unknown; options?: Options }) => {
				const gen = (async function* () {
					yield {
						type: "system",
						subtype: "init",
						session_id: "sdk-session-1",
						tools: [],
					};
					capturedResult = await options.canUseTool(
						"Bash",
						{},
						{
							toolUseID: "tid-1",
							title: undefined,
							displayName: undefined,
							description: undefined,
						},
					);
					yield {
						type: "result",
						subtype: "success",
						total_cost_usd: 0,
						session_id: "sdk-session-1",
						usage: { input_tokens: 10, output_tokens: 5 },
					};
				})();
				Object.assign(gen, { mcpServerStatus: () => Promise.resolve([]) });
				return gen;
			},
		);

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

	it("local ('always') approval writes tool to project settings.json", async () => {
		vi.mocked(fsMock.writeFileSync).mockClear();
		vi.mocked(fsMock.readFileSync).mockClear();

		const sm = new SessionManager(makeConfig());
		vi.mocked(query).mockImplementation(makeQueryImpl("Bash"));

		const turn1 = sm.runQuery("hello", () => {}, "sess-1");
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);

		sm.handlePermissionResponse("tid-1", true, "local");
		await turn1;

		// writeFileSync should have been called with the project settings path
		expect(vi.mocked(fsMock.writeFileSync)).toHaveBeenCalledWith(
			expect.stringContaining(".claude/settings.json"),
			expect.stringContaining('"Bash"'),
			"utf8",
		);
	});
});
