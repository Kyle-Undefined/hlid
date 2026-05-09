/**
 * SessionManager unit tests — state machine, config methods, and
 * session-scoped permission persistence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import * as dbMock from "../db";
import * as agentPathsMock from "./agentPaths";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
} from "./agentProvider";
import { generateTurnRecap } from "./recap";
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

/** Wrap a single AgentProvider in the Map the SessionManager constructor expects. */
function makeProviders(provider: AgentProvider): Map<string, AgentProvider> {
	return new Map([[provider.providerId, provider]]);
}

/** Build a mock AgentProvider whose query() calls canUseTool once for toolName. */
function makeProvider(toolName: string, toolUseID = "tid-1"): AgentProvider {
	return {
		providerId: "claude",
		query(params: AgentQueryParams): AgentSession {
			const gen = (async function* (): AsyncGenerator<AgentEvent> {
				yield { type: "session_start", sessionId: "sdk-session-1" };
				await params.canUseTool(
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
		expect(sm.getStatus()).toEqual({ state: "idle", model: "model-x" });
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

	it("does not reset session state (non-destructive update)", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.syncConfig(makeConfig("new-model"));
		expect(sm.getStatus().state).toBe("idle");
		expect(sm.getCurrentSessionId()).toBeNull();
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
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const turn = sm.runQuery("hello", () => {}, "sess-1");
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
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
});

// ── Session-scoped permission persistence ──────────────────────────────────────

describe("SessionManager — session-scoped permission persistence", () => {
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

		const provider = makeProvider("Bash");
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		const turn1 = sm.runQuery("hello", () => {}, "sess-1");
		await waitFor(() =>
			expect(sm.getPendingPermissionRequests()).toHaveLength(1),
		);

		sm.handlePermissionResponse("tid-1", true, "local");
		await turn1;

		expect(vi.mocked(fsMock.writeFileSync)).toHaveBeenCalledWith(
			expect.stringContaining(".claude/settings.local.json"),
			expect.stringContaining('"Bash"'),
			"utf8",
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
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};

		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("fix lint", () => {}, "sess-sdk");

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		// sdkSummary is the 9th argument (index 8)
		expect(lastCall[8]).toBe("Ran lint and fixed 2 warnings.");
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
		expect(lastCall[8]).toBeNull();
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
		// recapModel is argument index 10
		expect(lastCall[10]).toBe("claude-haiku-4-5");
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
		expect(lastCall[10]).toBe("claude-sonnet-4-6");
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
		expect(lastCall[10]).toBe("claude-haiku-4-5-20251001");
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
		expect(lastCall[10]).toBe("claude-sonnet-4-6");
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
