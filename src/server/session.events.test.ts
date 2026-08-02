/**
 * SessionManager — streamed events, AskUserQuestion, tool_event persistence, Codex realtime.
 * Shared module mocks and provider builders: see session.test-utils.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import type { HlidConfig } from "../config";
import * as dbMock from "../db";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
} from "./agentProvider";
import { ASK_USER_QUESTION_CANCEL_KEY, type ServerMessage } from "./protocol";
import { SessionManager } from "./session";
import {
	makeConfig,
	makeControllableProvider,
	makeControlledProvider,
	makeProvider,
	makeProviders,
	makeSwitchableProvider,
	waitFor,
} from "./session.test-utils";

describe("SessionManager — native Codex goals", () => {
	it("sets the goal before sending the same objective as the starting turn", async () => {
		const goal = {
			threadId: "sdk-session-1",
			objective: "Finish the release gate",
			status: "active" as const,
			tokenBudget: 50_000,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		};
		const controlGoal = vi.fn().mockResolvedValue({
			providerSessionId: "sdk-session-1",
			goal,
		});
		const send = vi.fn().mockResolvedValue(undefined);
		const { provider } = makeSwitchableProvider({ controlGoal, send }, "codex");
		const config = {
			...makeConfig("gpt-5.6-sol"),
			vault_provider: "codex",
			codex: {
				model: "gpt-5.6-sol",
				effort: "high",
				permission_mode: "default",
				turn_recaps: false,
			},
		} as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));
		const emitted: ServerMessage[] = [];

		await sm.runQuery(
			"Finish the release gate",
			(message) => emitted.push(message),
			{
				sessionId: "goal-session",
				turnId: "goal-turn",
				goalStart: {
					objective: "Finish the release gate",
					tokenBudget: 50_000,
				},
			},
		);

		expect(controlGoal).toHaveBeenCalledWith({
			action: "set",
			objective: "Finish the release gate",
			tokenBudget: 50_000,
		});
		expect(send).toHaveBeenCalledWith("test prompt");
		expect(controlGoal.mock.invocationCallOrder[0]).toBeLessThan(
			send.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(emitted).toContainEqual({
			type: "goal_state",
			session_id: "goal-session",
			provider_id: "codex",
			goal: {
				thread_id: "sdk-session-1",
				objective: "Finish the release gate",
				status: "active",
				token_budget: 50_000,
				tokens_used: 0,
				time_used_seconds: 0,
				created_at: 1,
				updated_at: 1,
			},
		});
		expect(sm.getCurrentGoal()).toEqual(goal);
	});

	it("drains a resumed goal as an active Raven continuation", async () => {
		let releaseContinuation: () => void = () => {};
		const continuationGate = new Promise<void>((resolve) => {
			releaseContinuation = resolve;
		});
		let iteratorCount = 0;
		const send = vi.fn().mockResolvedValue(undefined);
		const controlGoal = vi.fn().mockResolvedValue({
			providerSessionId: "sdk-goal-session",
			goal: {
				threadId: "sdk-goal-session",
				objective: "Finish the release gate",
				status: "active" as const,
				tokenBudget: 50_000,
				tokensUsed: 120,
				timeUsedSeconds: 12,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		const session: AgentSession = {
			[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
				iteratorCount += 1;
				if (iteratorCount === 1) {
					return (async function* (): AsyncGenerator<AgentEvent> {
						yield {
							type: "session_start",
							sessionId: "sdk-goal-session",
						};
						yield {
							type: "done",
							cost: 0,
							turns: 1,
							durationMs: 0,
							usage: { inputTokens: 10, outputTokens: 5 },
						};
					})();
				}
				return (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "text_delta", text: "Continued work" };
					await continuationGate;
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 100,
						usage: { inputTokens: 20, outputTokens: 8 },
					};
				})();
			},
			cancel: vi.fn(),
			send,
			controlGoal,
		};
		const provider: AgentProvider = {
			providerId: "codex",
			query: vi.fn(() => session),
		};
		const base = makeConfig("gpt-5.6-sol");
		const config = {
			...base,
			vault_provider: "codex",
			codex: {
				model: "gpt-5.6-sol",
				effort: "high",
				permission_mode: "default",
				turn_recaps: false,
			},
		} as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));
		const emitted: ServerMessage[] = [];

		await sm.runQuery("Start", (message) => emitted.push(message), {
			sessionId: "goal-session",
		});
		vi.mocked(dbMock.recordQuery).mockClear();
		vi.mocked(dbMock.appendMessage).mockClear();
		vi.mocked(dbMock.setMessageText).mockClear();
		emitted.length = 0;

		await sm.controlGoal(
			{ action: "resume" },
			{
				sessionId: "goal-session",
				emit: (message) => emitted.push(message),
			},
		);

		expect(sm.getStatus().state).toBe("running");
		expect(sm.getCurrentGoal()?.status).toBe("active");
		await waitFor(() => {
			expect(emitted).toContainEqual(
				expect.objectContaining({ type: "status", state: "running" }),
			);
			expect(emitted).toContainEqual({
				type: "chunk",
				text: "Continued work",
				offset: 0,
			});
		});
		expect(send).toHaveBeenCalledOnce();

		releaseContinuation();
		await waitFor(() => expect(sm.getStatus().state).toBe("idle"));

		expect(dbMock.recordQuery).toHaveBeenCalledOnce();
		expect(dbMock.appendMessage).toHaveBeenCalledWith(
			"goal-session",
			expect.any(Number),
			"assistant",
			"",
		);
		expect(dbMock.setMessageText).toHaveBeenCalledWith(
			"goal-session",
			expect.any(Number),
			"Continued work",
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({ type: "done", session_id: "goal-session" }),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({ type: "status", state: "idle" }),
		);
	});

	it("does not create an empty DB chat for a standalone goal control", async () => {
		vi.mocked(dbMock.createSession).mockClear();
		const { provider } = makeSwitchableProvider({}, "codex");
		const config = {
			...makeConfig("gpt-5.6-sol"),
			vault_provider: "codex",
			codex: {
				model: "gpt-5.6-sol",
				effort: "high",
				permission_mode: "default",
				turn_recaps: false,
			},
		} as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));

		await expect(
			sm.controlGoal(
				{ action: "set", objective: "Do not create a blank chat" },
				{
					sessionId: "missing-session",
					emit: vi.fn(),
				},
			),
		).rejects.toThrow("Start the goal by submitting it from Raven.");
		expect(dbMock.createSession).not.toHaveBeenCalled();
	});
});

describe("SessionManager — native Codex realtime", () => {
	it("rejects realtime unless the Forge Developer Preview is enabled", async () => {
		const { provider } = makeSwitchableProvider(
			{ startRealtime: vi.fn() },
			"codex",
		);
		const manager = new SessionManager(
			{ ...makeConfig(), vault_provider: "codex" } as HlidConfig,
			makeProviders(provider),
		);

		await expect(
			manager.controlRealtime(
				{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
				{ sessionId: "voice-session", emit: vi.fn() },
			),
		).rejects.toThrow("Enable the Developer Preview in Forge");
	});

	it("rejects a delayed Codex native session after an A-to-B-to-A switch", async () => {
		let finishRealtimeStart: (value: { providerSessionId: string }) => void =
			() => {};
		const realtimeStart = new Promise<{ providerSessionId: string }>(
			(resolve) => {
				finishRealtimeStart = resolve;
			},
		);
		const startRealtime = vi.fn(() => realtimeStart);
		const { provider: codex } = makeSwitchableProvider(
			{ startRealtime },
			"codex",
		);
		const { provider: claude } = makeSwitchableProvider({}, "claude");
		const base = makeConfig("gpt-5.6-sol");
		const config = {
			...base,
			vault_provider: "codex",
			codex: {
				model: "gpt-5.6-sol",
				effort: "high",
				permission_mode: "default",
				turn_recaps: false,
			},
			voice: { codex_live_mode: true } as HlidConfig["voice"],
		} as HlidConfig;
		const sm = new SessionManager(
			config,
			new Map([
				["codex", codex],
				["claude", claude],
			]),
		);

		const starting = sm.controlRealtime(
			{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
			{ sessionId: "voice-aba", emit: vi.fn() },
		);
		await vi.waitFor(() => expect(startRealtime).toHaveBeenCalledOnce());

		await sm.setProvider("claude", { model: "claude-sonnet-5" });
		await sm.setProvider("codex", { model: "gpt-5.6-sol" });
		finishRealtimeStart({ providerSessionId: "stale-codex-native" });

		await expect(starting).rejects.toThrow(
			"The provider changed while realtime startup was in progress.",
		);
		expect(dbMock.setSessionProviderSession).not.toHaveBeenCalledWith(
			"voice-aba",
			"codex",
			"stale-codex-native",
		);
	});

	it("tears down the provider on error and coalesces a browser stop", async () => {
		let publishRealtime:
			| ((event: { type: "error"; message: string }) => void)
			| undefined;
		const stopRealtime = vi.fn().mockResolvedValue(undefined);
		const startRealtime = vi.fn().mockImplementation(async (request) => {
			publishRealtime = request.onEvent;
			return { providerSessionId: "sdk-session-1" };
		});
		const { provider } = makeSwitchableProvider(
			{ startRealtime, stopRealtime },
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const config = {
			...base,
			vault_provider: "codex",
			codex: {
				model: "gpt-5.6-sol",
				effort: "high",
				permission_mode: "default",
				turn_recaps: false,
			},
			voice: { codex_live_mode: true } as HlidConfig["voice"],
		} as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.controlRealtime(
			{
				action: "start",
				mode: "dictation",
				sdp: "v=0\r\no=hlid",
			},
			{ sessionId: "voice-session", emit: vi.fn() },
		);
		publishRealtime?.({ type: "error", message: "Realtime failed" });
		expect(stopRealtime).toHaveBeenCalledOnce();
		await sm.controlRealtime(
			{ action: "stop" },
			{ sessionId: "voice-session", emit: vi.fn() },
		);

		expect(stopRealtime).toHaveBeenCalledOnce();
	});
});

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

	it("abort() resolves a live provider interaction as cancelled", async () => {
		let providerDecision: unknown;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					providerDecision = await params.canUseTool(
						"AskUserQuestion",
						{
							questions: [
								{
									question: "Continue?",
									options: ["Yes", "No"],
									multiSelect: false,
								},
							],
						},
						{
							toolUseID: "claude-dialog:sess-1:1",
							signal: params.signal ?? new AbortController().signal,
							interaction: {
								provider_id: "claude",
								kind: "provider_dialog",
								source_name: "refusal_fallback_prompt",
							},
						},
					);
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
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
		const turn = sm.runQuery("hi", (message) => emitted.push(message), {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);

		sm.abort();
		await turn;

		expect(providerDecision).toMatchObject({
			behavior: "allow",
			updatedInput: {
				answers: {},
			},
		});
		expect(emitted).toContainEqual({
			type: "ask_user_question_resolved",
			id: "claude-dialog:sess-1:1",
			answers: { [ASK_USER_QUESTION_CANCEL_KEY]: [] },
		});
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
		const turn = sm.runQuery("hello", () => {}, {
			sessionId: "sess-1",
		});
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
			null,
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
		const turn = sm.runQuery("hi", () => {}, {
			sessionId: "sess-1",
		});
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
						interaction: {
							provider_id: "claude",
							kind: "mcp_elicitation",
							source_name: "github",
							tool_name: "authenticate",
						},
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
		const turn = sm.runQuery("hi", (m) => emitted.push(m), {
			sessionId: "sess-1",
			turnId: "turn-origin-1",
		});
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
					provenance?: {
						provider_id: string;
						kind: string;
						source_name: string;
						tool_name?: string;
						turn_id?: string;
					};
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
		expect(askEvent?.provenance).toEqual({
			provider_id: "claude",
			kind: "mcp_elicitation",
			source_name: "github",
			tool_name: "authenticate",
			turn_id: "turn-origin-1",
		});
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
		const turn = sm.runQuery("hi", () => {}, {
			sessionId: "sess-1",
		});
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
		const turn = sm.runQuery("hi", (m) => emitted.push(m), {
			sessionId: "sess-1",
		});
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
		const turn = sm.runQuery("hi", () => {}, {
			sessionId: "sess-notes",
		});
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
		const turn = sm.runQuery("hi", () => {}, {
			sessionId: "sess-no-notes",
		});
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
		const runPromise = sm.runQuery("read a", () => {}, {
			sessionId: "sess-live-1",
		});
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
				undefined,
				expect.objectContaining({ providerId: "claude", agentCwd: null }),
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
		const runPromise = sm.runQuery("multi", () => {}, {
			sessionId: "sess-live-2",
		});
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
		const runPromise = sm.runQuery("read", () => {}, {
			sessionId: "sess-live-3",
		});
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

	it("emits only a lazy preview after a large live tool result is persisted", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fullResult = "x".repeat(400);
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-live-compact" },
				{ type: "tool_start", toolId: "tu-compact", name: "Read", input: {} },
				{
					type: "tool_result",
					toolId: "tu-compact",
					content: fullResult,
				},
			],
			gate,
		);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery("read", (message) => emitted.push(message), {
			sessionId: "sess-live-compact",
		});
		await gateReached;

		expect(dbMock.setToolEventResult).toHaveBeenCalledWith(
			"sess-live-compact",
			"tu-compact",
			fullResult,
			false,
		);
		expect(
			emitted.find(
				(message) =>
					message.type === "tool_result" && message.id === "tu-compact",
			),
		).toEqual({
			type: "tool_result",
			id: "tu-compact",
			content: fullResult.slice(0, 256),
			resultTruncated: true,
			resultLength: fullResult.length,
			detailSessionId: "sess-live-compact",
		});

		release();
		await runPromise;
	});

	it("keeps the full live result when lazy-detail persistence fails", async () => {
		vi.mocked(dbMock.setToolEventResult).mockRejectedValueOnce(
			new Error("disk unavailable"),
		);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fullResult = "y".repeat(400);
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-live-fallback" },
				{
					type: "tool_start",
					toolId: "tu-fallback",
					name: "Read",
					input: {},
				},
				{
					type: "tool_result",
					toolId: "tu-fallback",
					content: fullResult,
				},
			],
			gate,
		);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery("read", (message) => emitted.push(message), {
			sessionId: "sess-live-fallback",
		});
		await gateReached;

		expect(
			emitted.find(
				(message) =>
					message.type === "tool_result" && message.id === "tu-fallback",
			),
		).toEqual({
			type: "tool_result",
			id: "tu-fallback",
			content: fullResult,
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
			{
				sessionId: "sess-subagent",
			},
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

	it("settles an unfinished subagent before the parent done event", async () => {
		let releaseTurn!: () => void;
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const running = {
			provider: "codex" as const,
			agentId: "desktop-task-1",
			name: "Computer Use",
			status: "running" as const,
			startedAtMs: 1000,
			currentStep: "Checking the Windows app",
		};
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-computer-use" },
				{
					type: "tool_start",
					toolId: "computer-use-tool",
					name: "hlid.windows_computer_use",
					input: { task: "Check the app" },
					subagent: running,
				},
			],
			turnGate,
		);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery(
			"delegate",
			(message) => emitted.push(message),
			{
				sessionId: "sess-computer-use",
			},
		);
		await gateReached;
		releaseTurn();
		await runPromise;

		const interruptedIndex = emitted.findIndex(
			(message) =>
				message.type === "tool_update" &&
				message.id === "computer-use-tool" &&
				message.subagent.status === "interrupted",
		);
		const doneIndex = emitted.findIndex((message) => message.type === "done");
		expect(interruptedIndex).toBeGreaterThan(-1);
		expect(interruptedIndex).toBeLessThan(doneIndex);
		expect(emitted[interruptedIndex]).toMatchObject({
			type: "tool_update",
			id: "computer-use-tool",
			subagent: {
				status: "interrupted",
				currentStep: "Parent turn ended before the subagent completed",
			},
		});
		await waitFor(() =>
			expect(dbMock.setToolEventSubagent).toHaveBeenCalledWith(
				"sess-computer-use",
				"computer-use-tool",
				expect.objectContaining({ status: "interrupted" }),
			),
		);
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
		const runPromise = sm.runQuery("bash", () => {}, {
			sessionId: "sess-live-3e",
		});
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
		await sm.runQuery("go", () => {}, {
			sessionId: "sess-live-4",
		});

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
		await sm.runQuery("propose", () => {}, {
			sessionId: "sess-live-5",
		});

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
		const runPromise = sm.runQuery("hi", (message) => emitted.push(message), {
			sessionId: "sess-live-text",
		});
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

	it("replaces an arbitrary streamed tail with authoritative completed text", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-live-replace" },
				{ type: "text_delta", text: "Earlier note. " },
				{ type: "text_delta", text: "Broken ending." },
				{
					type: "text_replace",
					previousText: "Broken ending.",
					text: "Restored ending.",
				},
			],
			gate,
		);

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const emitted: ServerMessage[] = [];
		const runPromise = sm.runQuery(
			"repair the stream",
			(message) => emitted.push(message),
			{
				sessionId: "sess-live-replace",
			},
		);
		try {
			await gateReached;
			expect(emitted.filter((message) => message.type === "chunk")).toEqual([
				{ type: "chunk", text: "Earlier note. ", offset: 0 },
				{ type: "chunk", text: "Broken ending.", offset: 14 },
				{
					type: "chunk",
					text: "Earlier note. Restored ending.",
					offset: 0,
					replace: true,
				},
			]);

			release();
			await runPromise;
			expect(dbMock.setMessageText).toHaveBeenCalledWith(
				"sess-live-replace",
				expect.any(Number),
				"Earlier note. Restored ending.",
			);
		} finally {
			release();
			await runPromise;
		}
	});

	it("does not erase earlier text when a replacement tail cannot be matched", async () => {
		const provider: AgentProvider = {
			providerId: "codex",
			query(_params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-replace-mismatch" };
					yield { type: "text_delta", text: "Earlier commentary." };
					yield {
						type: "text_replace",
						previousText: "a different tail",
						text: "Authoritative final.",
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
		const emitted: ServerMessage[] = [];
		await sm.runQuery("keep prior text", (message) => emitted.push(message), {
			sessionId: "sess-replace-mismatch",
		});

		expect(emitted.filter((message) => message.type === "chunk")).toEqual([
			{ type: "chunk", text: "Earlier commentary.", offset: 0 },
		]);
		expect(dbMock.setMessageText).toHaveBeenCalledWith(
			"sess-replace-mismatch",
			expect.any(Number),
			"Earlier commentary.",
		);
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
		const runPromise = sm.runQuery("burst", () => {}, {
			sessionId: "sess-live-throttle",
		});
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
		const runPromise = sm.runQuery("go", () => {}, {
			sessionId: "sess-live-mix",
		});
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
		await sm.runQuery("noop", () => {}, {
			sessionId: "sess-live-6",
		});

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

describe("SessionManager — turn_id forwarding", () => {
	it("done event includes the turn_id supplied to runQuery", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const events: ServerMessage[] = [];
		const turn = sm.runQuery("first", (m) => events.push(m), {
			sessionId: "sess-1",
			turnId: "turn-xyz",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		expect(dbMock.appendMessage).toHaveBeenCalledWith(
			"sess-1",
			expect.any(Number),
			"user",
			"first",
			"turn-xyz",
			undefined,
			expect.stringContaining('"contractVersion":1'),
		);
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
