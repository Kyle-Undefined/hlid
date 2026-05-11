/**
 * SessionManager unit tests — state machine, config methods, and
 * session-scoped permission persistence.
 */

import type { Mock } from "vitest";
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
	appendPlanProposal: vi.fn().mockResolvedValue(undefined),
	setPlanProposalDecision: vi.fn().mockResolvedValue(undefined),
	setMessageText: vi.fn().mockResolvedValue(undefined),
	setMessageRecap: vi.fn().mockResolvedValue(undefined),
	setToolEventResult: vi.fn().mockResolvedValue(undefined),
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
import type { ServerMessage } from "./protocol";
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
		// config-level default remains unchanged
		expect(config.claude.permission_mode).toBe("default");
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
		vi.mocked(dbMock.setMessageText).mockClear();
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
		const runPromise = sm.runQuery("hi", () => {}, "sess-live-text");
		await gateReached;

		// Placeholder inserted on first text_delta. Both chunks fall inside the
		// ~150ms throttle window, so a single setMessageText fires with the
		// fully accumulated text — bounded I/O without losing liveness.
		await waitFor(() => {
			const placeholderInserts = vi
				.mocked(dbMock.appendMessage)
				.mock.calls.filter(
					(c) =>
						c[0] === "sess-live-text" && c[2] === "assistant" && c[3] === "",
				);
			expect(placeholderInserts).toHaveLength(1);

			const liveTexts = vi
				.mocked(dbMock.setMessageText)
				.mock.calls.filter((c) => c[0] === "sess-live-text")
				.map((c) => c[2]);
			expect(liveTexts.length).toBeGreaterThanOrEqual(1);
			// Whichever write fires, the *latest* one always reflects full text.
			expect(liveTexts[liveTexts.length - 1]).toBe("Hello, world.");
		});
		release();
		await runPromise;
	});

	it("only one setMessageText is scheduled when many chunks arrive in quick succession", async () => {
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
		await gateReached;

		// Wait for the throttled flush to fire at least once, then confirm we
		// did NOT do 50 writes — only a small handful.
		// Throttle fires after TEXT_WRITE_THROTTLE_MS (800ms); use 2500ms to give
		// comfortable headroom under CI / full-suite load and avoid flakiness.
		await waitFor(() => {
			const writes = vi
				.mocked(dbMock.setMessageText)
				.mock.calls.filter((c) => c[0] === "sess-live-throttle");
			expect(writes.length).toBeGreaterThanOrEqual(1);
		}, 2500);
		const writes = vi
			.mocked(dbMock.setMessageText)
			.mock.calls.filter((c) => c[0] === "sess-live-throttle");
		// 50 chunks emitted essentially synchronously → coalesced into ≤ a few
		// writes (one per TEXT_WRITE_THROTTLE_MS window). Allow slack for jitter.
		expect(writes.length).toBeLessThanOrEqual(5);
		release();
		await runPromise;
	});

	it("text_delta after a tool_start reuses the same placeholder (one assistant row per turn)", async () => {
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
		await gateReached;
		await waitFor(() => {
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
			const textCall = vi
				.mocked(dbMock.setMessageText)
				.mock.calls.find((c) => c[0] === "sess-live-mix");
			expect(textCall?.[1]).toBe(placeholderInserts[0][1]);
		});
		release();
		await runPromise;
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
		let lastSendSpy: Mock | null = null;
		const wrappedProvider: AgentProvider = {
			providerId: "claude",
			query(p: AgentQueryParams): AgentSession {
				const sess = ctl.provider.query(p);
				lastSendSpy = sess.send as ReturnType<typeof vi.fn>;
				return sess;
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(wrappedProvider));
		await sm.runQuery("hello world", () => {}, "sess-1");
		expect(lastSendSpy).not.toBeNull();
		expect(lastSendSpy).toHaveBeenCalledTimes(1);
		const sentArg = (lastSendSpy as Mock).mock.calls[0][0] as string;
		// buildPrompt is mocked at module level to return "test prompt", which
		// SessionManager forwards verbatim to agentSession.send().
		expect(sentArg).toBe("test prompt");
		ctl.closeStream();
	});
});
