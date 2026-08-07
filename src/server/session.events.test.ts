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
vi.mock("./attachments", () => ({
	ingestGeneratedImage: vi.fn(),
	ingestPlanHtml: vi.fn(),
}));
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
	ProviderRealtimeEvent,
} from "./agentProvider";
import { ingestGeneratedImage } from "./attachments";
import { loadConfig } from "./config";
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
	beforeEach(() => {
		vi.mocked(dbMock.appendRealtimeTranscriptMessage).mockReset();
		vi.mocked(dbMock.appendRealtimeTranscriptMessage).mockImplementation(
			async (input) => ({
				id: input.seq + 1_000,
				seq: input.seq,
				inserted: true,
			}),
		);
		vi.mocked(dbMock.appendToolEvent).mockClear();
		vi.mocked(dbMock.setToolEventResult).mockClear();
		vi.mocked(dbMock.setToolEventSubagent).mockClear();
		vi.mocked(dbMock.setToolEventActivity).mockClear();
	});

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

	it("retires a wrapper that does not support realtime", async () => {
		const { provider, getSession } = makeSwitchableProvider({}, "codex");
		const base = makeConfig("gpt-5.6-sol");
		const manager = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);

		await expect(
			manager.controlRealtime(
				{ action: "start", mode: "dictation", sdp: "v=0\r\no=hlid" },
				{ sessionId: "voice-unsupported", emit: vi.fn() },
			),
		).rejects.toThrow("does not support realtime voice");
		expect(getSession()?.cancel).toHaveBeenCalledOnce();
	});

	it("does not initialize ordinary background activity for dictation", async () => {
		const listBackgroundActivities = vi.fn().mockResolvedValue([]);
		const { provider } = makeSwitchableProvider(
			{
				startRealtime: vi
					.fn()
					.mockResolvedValue({ providerSessionId: "dictation-thread" }),
				stopRealtime: vi.fn().mockResolvedValue(undefined),
				listBackgroundActivities,
			},
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const manager = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);

		await manager.controlRealtime(
			{ action: "start", mode: "dictation", sdp: "v=0\r\no=hlid" },
			{ sessionId: "voice-dictation-isolated", emit: vi.fn() },
		);

		expect(listBackgroundActivities).not.toHaveBeenCalled();
		manager.abort();
	});

	it("runs read-aloud out of band while an ordinary Codex turn remains active", async () => {
		let releaseOrdinaryTurn = () => {};
		const ordinaryTurnRelease = new Promise<void>((resolve) => {
			releaseOrdinaryTurn = resolve;
		});
		let markOrdinaryTurnActive = () => {};
		const ordinaryTurnActive = new Promise<void>((resolve) => {
			markOrdinaryTurnActive = resolve;
		});
		const ordinaryCancel = vi.fn();
		const ordinarySend = vi.fn().mockResolvedValue(undefined);
		const ordinarySession: AgentSession = {
			async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
				yield { type: "session_start", sessionId: "sdk-raven-active" };
				markOrdinaryTurnActive();
				await ordinaryTurnRelease;
				yield {
					type: "done",
					cost: 0,
					turns: 1,
					durationMs: 0,
				};
			},
			cancel: ordinaryCancel,
			send: ordinarySend,
		};
		const appendRealtimeSpeech = vi.fn().mockResolvedValue(undefined);
		const stopRealtime = vi.fn().mockResolvedValue(undefined);
		const speechCancel = vi.fn();
		const speechSession: AgentSession = {
			async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {},
			cancel: speechCancel,
			send: vi.fn().mockResolvedValue(undefined),
			startRealtime: vi.fn().mockResolvedValue({
				providerSessionId: "sdk-read-aloud-ephemeral",
			}),
			appendRealtimeSpeech,
			stopRealtime,
		};
		const query = vi
			.fn<(params: AgentQueryParams) => AgentSession>()
			.mockReturnValueOnce(ordinarySession)
			.mockReturnValueOnce(speechSession);
		const provider: AgentProvider = { providerId: "codex", query };
		const base = makeConfig("gpt-5.6-sol");
		const manager = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const typedTurn = manager.runQuery("Keep working", vi.fn(), {
			sessionId: "voice-concurrent-read-aloud",
		});
		await ordinaryTurnActive;

		await manager.controlRealtime(
			{ action: "start", mode: "read-aloud", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "voice-concurrent-read-aloud",
				requestId: "read-aloud-request",
				emit: vi.fn(),
			},
		);
		await manager.controlRealtime(
			{ action: "speak", mode: "read-aloud", text: "Read this" },
			{
				sessionId: "voice-concurrent-read-aloud",
				requestId: "read-aloud-request",
				emit: vi.fn(),
			},
		);

		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls[1]?.[0]).toMatchObject({
			persistSession: false,
			sandboxModeOverride: "read-only",
		});
		expect(query.mock.calls[1]?.[0].sessionId).toBeUndefined();
		expect(appendRealtimeSpeech).toHaveBeenCalledWith("Read this");
		expect(ordinaryCancel).not.toHaveBeenCalled();
		await expect(
			manager.controlRealtime(
				{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
				{ sessionId: "voice-concurrent-read-aloud", emit: vi.fn() },
			),
		).rejects.toThrow(
			"Wait for the current turn to finish before starting Live",
		);

		await manager.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "voice-concurrent-read-aloud",
				requestId: "read-aloud-request",
				emit: vi.fn(),
			},
		);
		expect(stopRealtime).toHaveBeenCalledOnce();
		expect(speechCancel).toHaveBeenCalledOnce();
		expect(ordinaryCancel).not.toHaveBeenCalled();
		releaseOrdinaryTurn();
		await typedTurn;
		expect(ordinarySend).toHaveBeenCalledWith("test prompt");
	});

	it("keeps delayed speech and stops from a replaced request off the active generation", async () => {
		const firstStop = vi.fn().mockResolvedValue(undefined);
		const firstCancel = vi.fn();
		const firstSpeech = vi.fn().mockResolvedValue(undefined);
		const firstSession: AgentSession = {
			async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {},
			cancel: firstCancel,
			send: vi.fn().mockResolvedValue(undefined),
			startRealtime: vi
				.fn()
				.mockResolvedValue({ providerSessionId: "speech-thread-first" }),
			appendRealtimeSpeech: firstSpeech,
			stopRealtime: firstStop,
		};
		const secondStop = vi.fn().mockResolvedValue(undefined);
		const secondCancel = vi.fn();
		const secondSpeech = vi.fn().mockResolvedValue(undefined);
		const secondSession: AgentSession = {
			async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {},
			cancel: secondCancel,
			send: vi.fn().mockResolvedValue(undefined),
			startRealtime: vi
				.fn()
				.mockResolvedValue({ providerSessionId: "speech-thread-second" }),
			appendRealtimeSpeech: secondSpeech,
			stopRealtime: secondStop,
		};
		const query = vi
			.fn<(params: AgentQueryParams) => AgentSession>()
			.mockReturnValueOnce(firstSession)
			.mockReturnValueOnce(secondSession);
		const provider: AgentProvider = { providerId: "codex", query };
		const base = makeConfig("gpt-5.6-sol");
		const manager = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);

		await manager.controlRealtime(
			{ action: "start", mode: "read-aloud", sdp: "v=0\r\no=first" },
			{
				sessionId: "voice-replaced-request",
				requestId: "request-first",
				emit: vi.fn(),
			},
		);
		await manager.controlRealtime(
			{ action: "start", mode: "read-aloud", sdp: "v=0\r\no=second" },
			{
				sessionId: "voice-replaced-request",
				requestId: "request-second",
				emit: vi.fn(),
			},
		);

		expect(firstStop).toHaveBeenCalledOnce();
		expect(firstCancel).toHaveBeenCalledOnce();
		const staleStopEmitted: ServerMessage[] = [];
		await manager.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "voice-replaced-request",
				requestId: "request-first",
				emit: (message) => staleStopEmitted.push(message),
			},
		);
		await manager.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "voice-replaced-request",
				emit: (message) => staleStopEmitted.push(message),
			},
		);
		expect(staleStopEmitted).toEqual([]);
		expect(secondStop).not.toHaveBeenCalled();
		expect(secondCancel).not.toHaveBeenCalled();

		await expect(
			manager.controlRealtime(
				{ action: "speak", mode: "read-aloud", text: "Stale text" },
				{
					sessionId: "voice-replaced-request",
					requestId: "request-first",
					emit: vi.fn(),
				},
			),
		).rejects.toThrow("replaced by a newer session");
		expect(firstSpeech).not.toHaveBeenCalled();
		expect(secondSpeech).not.toHaveBeenCalled();

		await manager.controlRealtime(
			{ action: "speak", mode: "read-aloud", text: "Current text" },
			{
				sessionId: "voice-replaced-request",
				requestId: "request-second",
				emit: vi.fn(),
			},
		);
		expect(secondSpeech).toHaveBeenCalledWith("Current text");
		await manager.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "voice-replaced-request",
				requestId: "request-second",
				emit: vi.fn(),
			},
		);
		expect(secondStop).toHaveBeenCalledOnce();
		expect(secondCancel).toHaveBeenCalledOnce();
	});

	it("keeps transient Cockpit dictation out of durable Raven session state", async () => {
		vi.mocked(dbMock.createSession).mockClear();
		vi.mocked(dbMock.getSessionById).mockClear();
		vi.mocked(dbMock.setCurrentSessionId).mockClear();
		vi.mocked(dbMock.setSessionAgentCwd).mockClear();
		vi.mocked(dbMock.setSessionProviderId).mockClear();
		vi.mocked(dbMock.setSessionProviderSession).mockClear();
		const startRealtime = vi
			.fn()
			.mockResolvedValue({ providerSessionId: "cockpit-dictation-thread" });
		const stopRealtime = vi.fn().mockResolvedValue(undefined);
		const { provider } = makeSwitchableProvider(
			{ startRealtime, stopRealtime },
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const manager = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const emitted: ServerMessage[] = [];

		await manager.controlRealtime(
			{ action: "start", mode: "dictation", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "cockpit-dictation",
				transient: true,
				emit: (message) => emitted.push(message),
			},
		);

		expect(startRealtime).toHaveBeenCalledOnce();
		expect(emitted).toContainEqual({
			type: "realtime_state",
			session_id: "cockpit-dictation",
			mode: "dictation",
			state: "starting",
		});
		expect(dbMock.getSessionById).not.toHaveBeenCalled();
		expect(dbMock.createSession).not.toHaveBeenCalled();
		expect(dbMock.setCurrentSessionId).not.toHaveBeenCalled();
		expect(dbMock.setSessionAgentCwd).not.toHaveBeenCalled();
		expect(dbMock.setSessionProviderId).not.toHaveBeenCalled();
		expect(dbMock.setSessionProviderSession).not.toHaveBeenCalled();

		await manager.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "cockpit-dictation",
				transient: true,
				emit: (message) => emitted.push(message),
			},
		);
		expect(stopRealtime).toHaveBeenCalledOnce();
	});

	it("targets and persists Live tools on the matching assistant utterance", async () => {
		let publishRealtime: ((event: ProviderRealtimeEvent) => void) | undefined;
		const startRealtime = vi.fn().mockImplementation(async (request) => {
			publishRealtime = request.onEvent;
			return { providerSessionId: "sdk-live-tools" };
		});
		const { provider } = makeSwitchableProvider(
			{ startRealtime, stopRealtime: vi.fn().mockResolvedValue(undefined) },
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const emitted: ServerMessage[] = [];
		await sm.controlRealtime(
			{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "voice-live-tools",
				emit: (message) => emitted.push(message),
			},
		);

		publishRealtime?.({
			type: "transcript_done",
			role: "user",
			text: "Check the workspace",
		});
		publishRealtime?.({
			type: "activity",
			event: {
				type: "tool_start",
				toolId: "live-tool-1",
				name: "exec_command",
				input: { cmd: "git status --short" },
			},
		});
		publishRealtime?.({
			type: "activity",
			event: {
				type: "tool_result",
				toolId: "live-tool-1",
				content: "clean",
			},
		});
		publishRealtime?.({
			type: "transcript_done",
			role: "assistant",
			text: "The workspace is clean.",
		});

		await waitFor(() =>
			expect(dbMock.appendRealtimeTranscriptMessage).toHaveBeenCalledTimes(2),
		);
		await waitFor(() =>
			expect(dbMock.setToolEventResult).toHaveBeenCalledWith(
				"voice-live-tools",
				"live-tool-1",
				"clean",
				false,
			),
		);
		const transcriptWrites = vi.mocked(dbMock.appendRealtimeTranscriptMessage)
			.mock.calls;
		const assistantWrite = transcriptWrites.find(
			([input]) => input.role === "assistant",
		)?.[0];
		expect(assistantWrite).toMatchObject({
			seq: 1,
			utteranceId: "codex-realtime-1",
			text: "The workspace is clean.",
		});
		expect(dbMock.appendToolEvent).toHaveBeenCalledWith(
			"voice-live-tools",
			1,
			"live-tool-1",
			"exec_command",
			{ cmd: "git status --short" },
			undefined,
			expect.objectContaining({ providerId: "codex" }),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "tool_event",
				id: "live-tool-1",
				realtime_utterance_id: "codex-realtime-1",
				transcript_seq: 1,
				fork_supported: false,
			}),
		);
		await sm.controlRealtime(
			{ action: "stop" },
			{ sessionId: "voice-live-tools", emit: vi.fn() },
		);
		expect(dbMock.appendRealtimeTranscriptMessage).toHaveBeenCalledTimes(2);
	});

	it("persists a tool-only Live assistant row before close", async () => {
		let publishRealtime: ((event: ProviderRealtimeEvent) => void) | undefined;
		const startRealtime = vi.fn().mockImplementation(async (request) => {
			publishRealtime = request.onEvent;
			return { providerSessionId: "sdk-live-tool-only" };
		});
		const { provider } = makeSwitchableProvider(
			{ startRealtime, stopRealtime: vi.fn().mockResolvedValue(undefined) },
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const emitted: ServerMessage[] = [];
		await sm.controlRealtime(
			{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "voice-live-tool-only",
				emit: (message) => emitted.push(message),
			},
		);
		publishRealtime?.({
			type: "activity",
			event: {
				type: "tool_start",
				toolId: "live-tool-only",
				name: "hlid_help",
				input: { topic: "voice_audio" },
			},
		});

		await sm.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "voice-live-tool-only",
				emit: (message) => emitted.push(message),
			},
		);

		expect(dbMock.appendRealtimeTranscriptMessage).toHaveBeenCalledOnce();
		expect(dbMock.appendRealtimeTranscriptMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "voice-live-tool-only",
				seq: 0,
				role: "assistant",
				text: "",
				utteranceId: "codex-realtime-0",
			}),
		);
		expect(dbMock.setToolEventResult).toHaveBeenCalledWith(
			"voice-live-tool-only",
			"live-tool-only",
			"Raven Live ended before Codex reported this tool's result.",
			true,
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				id: "live-tool-only",
				isError: true,
				realtime_utterance_id: "codex-realtime-0",
			}),
		);
		const finalIndex = emitted.findIndex(
			(message) =>
				message.type === "realtime_transcript" &&
				message.mode === "live" &&
				message.role === "assistant" &&
				message.done,
		);
		const closedIndex = emitted.findIndex(
			(message) =>
				message.type === "realtime_state" && message.state === "closed",
		);
		expect(finalIndex).toBeGreaterThan(-1);
		expect(closedIndex).toBeGreaterThan(finalIndex);
	});

	it("awaits Live subagent metadata durability before publishing close", async () => {
		let publishRealtime: ((event: ProviderRealtimeEvent) => void) | undefined;
		const startRealtime = vi.fn().mockImplementation(async (request) => {
			publishRealtime = request.onEvent;
			return { providerSessionId: "sdk-live-subagent" };
		});
		const { provider } = makeSwitchableProvider(
			{ startRealtime, stopRealtime: vi.fn().mockResolvedValue(undefined) },
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const emitted: ServerMessage[] = [];
		await sm.controlRealtime(
			{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "voice-live-subagent",
				emit: (message) => emitted.push(message),
			},
		);

		let releaseMetadata = () => {};
		vi.mocked(dbMock.setToolEventSubagent).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseMetadata = resolve;
				}),
		);
		publishRealtime?.({
			type: "activity",
			event: {
				type: "tool_start",
				toolId: "live-subagent-1",
				name: "spawn_agent",
				input: { task: "Inspect" },
				subagent: {
					provider: "codex",
					agentId: "live-subagent-1",
					status: "running",
					startedAtMs: 1,
				},
			},
		});
		publishRealtime?.({
			type: "activity",
			event: {
				type: "tool_update",
				toolId: "live-subagent-1",
				subagent: {
					provider: "codex",
					agentId: "live-subagent-1",
					status: "completed",
					startedAtMs: 1,
					endedAtMs: 2,
				},
			},
		});
		await waitFor(() => expect(dbMock.setToolEventSubagent).toHaveBeenCalled());

		let stopped = false;
		const stopping = sm
			.controlRealtime(
				{ action: "stop" },
				{
					sessionId: "voice-live-subagent",
					emit: (message) => emitted.push(message),
				},
			)
			.then(() => {
				stopped = true;
			});
		await Promise.resolve();
		expect(stopped).toBe(false);
		releaseMetadata();
		await stopping;
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "realtime_state",
				state: "closed",
			}),
		);
	});

	it("blocks provider changes while realtime startup is active", async () => {
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

		await expect(
			sm.setProvider("claude", { model: "claude-sonnet-5" }),
		).rejects.toThrow("Stop Raven Live before switching CLI.");
		finishRealtimeStart({ providerSessionId: "active-codex-native" });
		await starting;
		await sm.controlRealtime(
			{ action: "stop" },
			{ sessionId: "voice-aba", emit: vi.fn() },
		);
		expect(dbMock.setSessionProviderSession).toHaveBeenCalledWith(
			"voice-aba",
			"codex",
			"active-codex-native",
		);
	});

	it("tears down the provider on error and coalesces a browser stop", async () => {
		let publishRealtime:
			| ((event: { type: "error"; message: string }) => void)
			| undefined;
		let finishStop: () => void = () => {};
		const stopGate = new Promise<void>((resolve) => {
			finishStop = resolve;
		});
		const stopRealtime = vi.fn(() => stopGate);
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
		const emitted: ServerMessage[] = [];

		await sm.controlRealtime(
			{
				action: "start",
				mode: "dictation",
				sdp: "v=0\r\no=hlid",
			},
			{
				sessionId: "voice-session",
				emit: (message) => emitted.push(message),
			},
		);
		publishRealtime?.({ type: "error", message: "Realtime failed" });
		await waitFor(() => expect(stopRealtime).toHaveBeenCalledOnce());
		expect(emitted.some((message) => message.type === "realtime_error")).toBe(
			false,
		);
		finishStop();
		await waitFor(() =>
			expect(emitted).toContainEqual({
				type: "realtime_error",
				session_id: "voice-session",
				mode: "dictation",
				message: "Realtime failed",
			}),
		);
		await sm.controlRealtime(
			{ action: "stop" },
			{ sessionId: "voice-session", emit: vi.fn() },
		);

		expect(stopRealtime).toHaveBeenCalledOnce();
	});

	it("does not self-await an error deferred during explicit stop", async () => {
		let publishRealtime: ((event: ProviderRealtimeEvent) => void) | undefined;
		let finishStop: () => void = () => {};
		const stopGate = new Promise<void>((resolve) => {
			finishStop = resolve;
		});
		const stopRealtime = vi.fn(async () => {
			publishRealtime?.({ type: "error", message: "Stop-time failure" });
			await stopGate;
		});
		const startRealtime = vi.fn().mockImplementation(async (request) => {
			publishRealtime = request.onEvent;
			return { providerSessionId: "sdk-stop-error" };
		});
		const { provider } = makeSwitchableProvider(
			{ startRealtime, stopRealtime },
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const emitted: ServerMessage[] = [];
		await sm.controlRealtime(
			{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "voice-stop-error",
				requestId: "request-stop-error",
				emit: (message) => emitted.push(message),
			},
		);

		const stopping = sm.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "voice-stop-error",
				requestId: "request-stop-error",
				emit: (message) => emitted.push(message),
			},
		);
		await waitFor(() => expect(stopRealtime).toHaveBeenCalledOnce());
		expect(emitted.some((message) => message.type === "realtime_error")).toBe(
			false,
		);
		finishStop();
		await expect(stopping).resolves.toBeUndefined();
		expect(emitted).toContainEqual({
			type: "realtime_error",
			session_id: "voice-stop-error",
			request_id: "request-stop-error",
			mode: "live",
			message: "Stop-time failure",
		});
		expect(
			emitted.some(
				(message) =>
					message.type === "realtime_state" && message.state === "closed",
			),
		).toBe(false);
	});

	it("closes active Live voice before retiring Codex when preview is disabled", async () => {
		let finishStop: () => void = () => {};
		const stopGate = new Promise<void>((resolve) => {
			finishStop = resolve;
		});
		const stopRealtime = vi.fn(() => stopGate);
		const startRealtime = vi.fn().mockResolvedValue({
			providerSessionId: "sdk-live-session",
		});
		const { provider, getSession } = makeSwitchableProvider(
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
			voice: { ...base.voice, codex_live_mode: true },
		} as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));
		const emitted: ServerMessage[] = [];

		await sm.controlRealtime(
			{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "voice-disable-session",
				emit: (message) => emitted.push(message),
			},
		);
		const activeSession = getSession();
		const disabled = structuredClone(config);
		disabled.voice.codex_live_mode = false;

		sm.syncConfig(disabled);

		expect(stopRealtime).toHaveBeenCalledOnce();
		expect(activeSession?.cancel).not.toHaveBeenCalled();
		expect(
			emitted.some(
				(message) =>
					message.type === "realtime_state" && message.state === "closed",
			),
		).toBe(false);

		finishStop();
		await waitFor(() =>
			expect(emitted).toContainEqual({
				type: "realtime_state",
				session_id: "voice-disable-session",
				mode: "live",
				state: "closed",
				reason: "Codex realtime voice was disabled in Forge.",
			}),
		);
		await waitFor(() => expect(activeSession?.cancel).toHaveBeenCalledOnce());
	});

	it("blocks typed turns and settings until Live teardown finishes", async () => {
		let finishStop: () => void = () => {};
		const stopGate = new Promise<void>((resolve) => {
			finishStop = resolve;
		});
		const { provider, getSession } = makeSwitchableProvider(
			{
				startRealtime: vi.fn().mockResolvedValue({
					providerSessionId: "sdk-live-guard",
				}),
				stopRealtime: vi.fn(() => stopGate),
			},
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		await sm.controlRealtime(
			{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
			{ sessionId: "voice-guard", emit: vi.fn() },
		);

		await expect(sm.runQuery("overlap", vi.fn())).rejects.toThrow(
			"Stop Raven Live before sending a message.",
		);
		await expect(sm.setModel("gpt-5.6-sol")).rejects.toThrow(
			"Stop Raven Live before changing the model.",
		);
		await expect(sm.setEffort("high")).rejects.toThrow(
			"Stop Raven Live before changing effort.",
		);
		await expect(sm.setPermissionMode("default")).rejects.toThrow(
			"Stop Raven Live before changing permissions.",
		);
		expect(sm.hasActiveRealtime()).toBe(true);
		const stopping = sm.controlRealtime(
			{ action: "stop" },
			{ sessionId: "voice-guard", emit: vi.fn() },
		);
		expect(sm.hasActiveRealtime()).toBe(true);
		finishStop();
		await stopping;
		expect(sm.hasActiveRealtime()).toBe(false);
		expect(getSession()?.cancel).toHaveBeenCalledOnce();
	});

	it("retires the read-aloud wrapper after provider teardown", async () => {
		let publishRealtime: ((event: ProviderRealtimeEvent) => void) | undefined;
		const { provider, getSession } = makeSwitchableProvider(
			{
				startRealtime: vi.fn().mockImplementation(async (request) => {
					publishRealtime = request.onEvent;
					return { providerSessionId: "sdk-read-aloud" };
				}),
				stopRealtime: vi.fn().mockResolvedValue(undefined),
			},
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const emitted: ServerMessage[] = [];

		await sm.controlRealtime(
			{ action: "start", mode: "read-aloud", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "voice-read-aloud",
				requestId: "read-aloud-request",
				emit: (message) => emitted.push(message),
			},
		);
		const realtimeSession = getSession();
		publishRealtime?.({ type: "audio_output_started" });
		publishRealtime?.({ type: "audio_output_started" });
		expect(
			emitted.filter((message) => message.type === "realtime_audio"),
		).toEqual([
			{
				type: "realtime_audio",
				session_id: "voice-read-aloud",
				request_id: "read-aloud-request",
				mode: "read-aloud",
				state: "started",
			},
		]);
		await sm.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "voice-read-aloud",
				requestId: "read-aloud-request",
				emit: vi.fn(),
			},
		);

		expect(realtimeSession?.cancel).toHaveBeenCalledOnce();
	});

	it("cold-resumes the same Codex thread after Live closes instead of consuming its delayed event queue", async () => {
		let publishRealtime: ((event: ProviderRealtimeEvent) => void) | undefined;
		let liveClosed = false;
		const liveCancel = vi.fn();
		const liveSend = vi.fn().mockResolvedValue(undefined);
		const liveSession: AgentSession = {
			[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
				return (async function* (): AsyncGenerator<AgentEvent> {
					if (!liveClosed) {
						throw new Error("Live events were read before the close boundary");
					}
					// Codex can mirror the completed Live delegation onto its ordinary
					// turn stream after the realtime transport has already closed.
					yield { type: "text_delta", text: "Stale Live final" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
					};
				})();
			},
			cancel: liveCancel,
			send: liveSend,
			startRealtime: vi.fn().mockImplementation(async (request) => {
				publishRealtime = request.onEvent;
				return { providerSessionId: "sdk-live-thread" };
			}),
			stopRealtime: vi.fn().mockResolvedValue(undefined),
		};
		const resumedCancel = vi.fn();
		const resumedSend = vi.fn().mockResolvedValue(undefined);
		const resumedSession: AgentSession = {
			[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
				return (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-live-thread" };
					yield { type: "text_delta", text: "Fresh typed reply" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
					};
				})();
			},
			cancel: resumedCancel,
			send: resumedSend,
		};
		const query = vi
			.fn<(params: AgentQueryParams) => AgentSession>()
			.mockReturnValueOnce(liveSession)
			.mockReturnValueOnce(resumedSession);
		const provider: AgentProvider = { providerId: "codex", query };
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);

		await sm.controlRealtime(
			{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
			{ sessionId: "voice-resume", emit: vi.fn() },
		);
		liveClosed = true;
		publishRealtime?.({ type: "closed" });
		await waitFor(() => expect(liveCancel).toHaveBeenCalledOnce());

		const emitted: ServerMessage[] = [];
		await sm.runQuery(
			"First typed prompt after Live",
			(message) => emitted.push(message),
			{ sessionId: "voice-resume" },
		);

		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls[1]?.[0].sessionId).toBe("sdk-live-thread");
		expect(liveSend).not.toHaveBeenCalled();
		expect(resumedSend).toHaveBeenCalledWith("test prompt");
		expect(emitted.filter((message) => message.type === "chunk")).toEqual([
			{ type: "chunk", text: "Fresh typed reply", offset: 0 },
		]);
		expect(
			emitted.some(
				(message) =>
					message.type === "chunk" && message.text === "Stale Live final",
			),
		).toBe(false);
		expect(resumedCancel).not.toHaveBeenCalled();
	});

	it("retires dictation callbacks while the next typed turn resumes the saved Codex session", async () => {
		vi.mocked(dbMock.getSessionById).mockResolvedValueOnce({
			id: "voice-dictation",
			label: "Saved dictation chat",
		} as never);
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "Earlier message" },
		] as never);
		vi.mocked(dbMock.getSessionProviderId).mockResolvedValueOnce("codex");
		vi.mocked(dbMock.getSessionProviderSession).mockResolvedValueOnce(
			"sdk-raven-original",
		);
		vi.mocked(dbMock.setSessionProviderSession).mockClear();

		const dictationCancel = vi.fn();
		const dictationSend = vi.fn().mockResolvedValue(undefined);
		const stopRealtime = vi.fn().mockResolvedValue(undefined);
		const dictationSession: AgentSession = {
			[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
				return (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "text_delta", text: "Stale dictation event" };
				})();
			},
			cancel: dictationCancel,
			send: dictationSend,
			startRealtime: vi.fn().mockResolvedValue({
				providerSessionId: "sdk-dictation-transient",
			}),
			stopRealtime,
		};
		const typedSend = vi.fn().mockResolvedValue(undefined);
		const typedSession: AgentSession = {
			[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
				return (async function* (): AsyncGenerator<AgentEvent> {
					yield {
						type: "session_start",
						sessionId: "sdk-raven-original",
					};
					yield { type: "text_delta", text: "Fresh typed reply" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
					};
				})();
			},
			cancel: vi.fn(),
			send: typedSend,
		};
		const query = vi
			.fn<(params: AgentQueryParams) => AgentSession>()
			.mockReturnValueOnce(dictationSession)
			.mockReturnValueOnce(typedSession);
		const provider: AgentProvider = { providerId: "codex", query };
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const sessionIdentity = sm as unknown as {
			providerSessionId: string | null;
		};
		const realtimeEmitted: ServerMessage[] = [];
		await sm.controlRealtime(
			{ action: "start", mode: "dictation", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "voice-dictation",
				emit: (message) => realtimeEmitted.push(message),
			},
		);

		expect(query).toHaveBeenCalledOnce();
		expect(query.mock.calls[0]?.[0]).toMatchObject({
			persistSession: false,
			sandboxModeOverride: "read-only",
			historyResumeMode: "none",
		});
		expect(query.mock.calls[0]?.[0].sessionId).toBeUndefined();
		expect(sessionIdentity.providerSessionId).toBe("sdk-raven-original");
		expect(dbMock.setSessionProviderSession).not.toHaveBeenCalled();

		const stopEmitted: ServerMessage[] = [];
		await sm.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "voice-dictation",
				emit: (message) => stopEmitted.push(message),
			},
		);
		expect(stopEmitted).toContainEqual({
			type: "realtime_state",
			session_id: "voice-dictation",
			mode: "dictation",
			state: "closed",
		});
		expect(dictationCancel).toHaveBeenCalledOnce();

		const typedEmitted: ServerMessage[] = [];
		await expect(
			sm.runQuery("dictated prompt", (message) => typedEmitted.push(message), {
				sessionId: "voice-dictation",
			}),
		).resolves.toBeUndefined();
		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls[1]?.[0].sessionId).toBe("sdk-raven-original");
		expect(query.mock.calls[1]?.[0].canUseTool).not.toBe(
			query.mock.calls[0]?.[0].canUseTool,
		);
		expect(dictationSend).not.toHaveBeenCalled();
		expect(typedSend).toHaveBeenCalledWith("test prompt");
		expect(typedEmitted).toContainEqual({
			type: "chunk",
			text: "Fresh typed reply",
			offset: 0,
		});
		expect(
			typedEmitted.some(
				(message) =>
					message.type === "chunk" && message.text === "Stale dictation event",
			),
		).toBe(false);

		const typedPermission = query.mock.calls[1]?.[0].canUseTool(
			"Bash",
			{ command: "git status --short" },
			{
				toolUseID: "typed-after-dictation",
				signal: new AbortController().signal,
			},
		);
		expect(typedPermission).toBeDefined();
		await waitFor(() =>
			expect(typedEmitted).toContainEqual(
				expect.objectContaining({
					type: "permission_request",
					id: "typed-after-dictation",
				}),
			),
		);
		expect(
			realtimeEmitted.some(
				(message) =>
					message.type === "permission_request" &&
					message.id === "typed-after-dictation",
			),
		).toBe(false);
		sm.handlePermissionResponse("typed-after-dictation", true);
		await expect(typedPermission).resolves.toMatchObject({ behavior: "allow" });
		expect(sessionIdentity.providerSessionId).toBe("sdk-raven-original");
		expect(dbMock.setSessionProviderSession).not.toHaveBeenCalled();
	});

	it("retires a rejected dictation startup before the next typed turn", async () => {
		vi.mocked(dbMock.getSessionById).mockResolvedValueOnce({
			id: "voice-dictation-rejected",
			label: "Saved rejected dictation chat",
		} as never);
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "Earlier message" },
		] as never);
		vi.mocked(dbMock.getSessionProviderId).mockResolvedValueOnce("codex");
		vi.mocked(dbMock.getSessionProviderSession).mockResolvedValueOnce(
			"sdk-raven-before-rejected-dictation",
		);
		vi.mocked(dbMock.setSessionProviderSession).mockClear();

		const rejectedCancel = vi.fn();
		const rejectedSession: AgentSession = {
			[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
				return (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "text_delta", text: "Stale rejected event" };
				})();
			},
			cancel: rejectedCancel,
			send: vi.fn().mockResolvedValue(undefined),
			startRealtime: vi
				.fn()
				.mockRejectedValue(new Error("Rejected dictation startup")),
		};
		const typedSend = vi.fn().mockResolvedValue(undefined);
		const typedSession: AgentSession = {
			[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
				return (async function* (): AsyncGenerator<AgentEvent> {
					yield {
						type: "session_start",
						sessionId: "sdk-raven-before-rejected-dictation",
					};
					yield { type: "text_delta", text: "Fresh after rejection" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
					};
				})();
			},
			cancel: vi.fn(),
			send: typedSend,
		};
		const query = vi
			.fn<(params: AgentQueryParams) => AgentSession>()
			.mockReturnValueOnce(rejectedSession)
			.mockReturnValueOnce(typedSession);
		const provider: AgentProvider = { providerId: "codex", query };
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const realtimeEmitted: ServerMessage[] = [];

		await expect(
			sm.controlRealtime(
				{ action: "start", mode: "dictation", sdp: "v=0\r\no=hlid" },
				{
					sessionId: "voice-dictation-rejected",
					emit: (message) => realtimeEmitted.push(message),
				},
			),
		).rejects.toThrow("Rejected dictation startup");
		expect(rejectedCancel).toHaveBeenCalledOnce();
		expect(sm.hasActiveRealtime()).toBe(false);

		const typedEmitted: ServerMessage[] = [];
		await sm.runQuery(
			"Typed prompt after rejected dictation",
			(message) => typedEmitted.push(message),
			{ sessionId: "voice-dictation-rejected" },
		);

		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls[1]?.[0].sessionId).toBe(
			"sdk-raven-before-rejected-dictation",
		);
		expect(typedSend).toHaveBeenCalledWith("test prompt");
		expect(typedEmitted).toContainEqual({
			type: "chunk",
			text: "Fresh after rejection",
			offset: 0,
		});
		expect(
			typedEmitted.some(
				(message) =>
					message.type === "chunk" && message.text === "Stale rejected event",
			),
		).toBe(false);

		const typedPermission = query.mock.calls[1]?.[0].canUseTool(
			"Bash",
			{ command: "git status --short" },
			{
				toolUseID: "typed-after-rejected-dictation",
				signal: new AbortController().signal,
			},
		);
		expect(typedPermission).toBeDefined();
		await waitFor(() =>
			expect(typedEmitted).toContainEqual(
				expect.objectContaining({
					type: "permission_request",
					id: "typed-after-rejected-dictation",
				}),
			),
		);
		expect(
			realtimeEmitted.some(
				(message) =>
					message.type === "permission_request" &&
					message.id === "typed-after-rejected-dictation",
			),
		).toBe(false);
		sm.handlePermissionResponse("typed-after-rejected-dictation", true);
		await expect(typedPermission).resolves.toMatchObject({ behavior: "allow" });
		expect(dbMock.setSessionProviderSession).not.toHaveBeenCalled();
	});

	it("stops transient dictation when provider ownership changes during startup", async () => {
		let finishRealtimeStart: (value: { providerSessionId: string }) => void =
			() => {};
		const realtimeStart = new Promise<{ providerSessionId: string }>(
			(resolve) => {
				finishRealtimeStart = resolve;
			},
		);
		const startRealtime = vi.fn(() => realtimeStart);
		const stopRealtime = vi.fn().mockResolvedValue(undefined);
		const { provider } = makeSwitchableProvider(
			{ startRealtime, stopRealtime },
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		vi.mocked(dbMock.setSessionProviderSession).mockClear();

		const starting = sm.controlRealtime(
			{ action: "start", mode: "dictation", sdp: "v=0\r\no=hlid" },
			{ sessionId: "voice-dictation-race", emit: vi.fn() },
		);
		await vi.waitFor(() => expect(startRealtime).toHaveBeenCalledOnce());

		const providerOwnership = sm as unknown as {
			providerOwnershipGeneration: number;
		};
		providerOwnership.providerOwnershipGeneration += 1;
		finishRealtimeStart({ providerSessionId: "sdk-dictation-transient" });

		await expect(starting).rejects.toThrow(
			"The provider changed while realtime startup was in progress.",
		);
		expect(stopRealtime).toHaveBeenCalledOnce();
		expect(dbMock.setSessionProviderSession).not.toHaveBeenCalled();
	});

	it("treats an explicit stop during dictation startup as a normal close", async () => {
		let rejectRealtimeStart: (reason?: unknown) => void = () => {};
		const realtimeStart = new Promise<{ providerSessionId: string }>(
			(_resolve, reject) => {
				rejectRealtimeStart = reject;
			},
		);
		const startRealtime = vi.fn(() => realtimeStart);
		const stopRealtime = vi.fn().mockResolvedValue(undefined);
		const { provider } = makeSwitchableProvider(
			{ startRealtime, stopRealtime },
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const emitted: ServerMessage[] = [];

		const starting = sm.controlRealtime(
			{ action: "start", mode: "dictation", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "voice-dictation-user-stop",
				emit: (message) => emitted.push(message),
			},
		);
		await vi.waitFor(() => expect(startRealtime).toHaveBeenCalledOnce());

		const stopping = sm.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "voice-dictation-user-stop",
				emit: (message) => emitted.push(message),
			},
		);
		rejectRealtimeStart(new Error("Codex dictation stopped"));

		await expect(starting).resolves.toBeUndefined();
		await expect(stopping).resolves.toBeUndefined();
		expect(stopRealtime).toHaveBeenCalledOnce();
		expect(emitted).toContainEqual({
			type: "realtime_state",
			session_id: "voice-dictation-user-stop",
			mode: "dictation",
			state: "closed",
		});
		expect(emitted.some((message) => message.type === "realtime_error")).toBe(
			false,
		);
	});

	it("persists Live finals delivered while explicit stop is in flight", async () => {
		let publishRealtime: ((event: ProviderRealtimeEvent) => void) | undefined;
		let finishProviderStop: () => void = () => {};
		const providerStopGate = new Promise<void>((resolve) => {
			finishProviderStop = resolve;
		});
		const stopRealtime = vi.fn(async () => {
			publishRealtime?.({
				type: "transcript_done",
				role: "user",
				text: "Last question",
			});
			await providerStopGate;
			publishRealtime?.({
				type: "transcript_done",
				role: "assistant",
				text: "Last answer",
			});
		});
		const startRealtime = vi.fn().mockImplementation(async (request) => {
			publishRealtime = request.onEvent;
			return { providerSessionId: "sdk-live-stop-final" };
		});
		const { provider } = makeSwitchableProvider(
			{ startRealtime, stopRealtime },
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const emitted: ServerMessage[] = [];
		await sm.controlRealtime(
			{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "voice-stop-final",
				emit: (message) => emitted.push(message),
			},
		);

		const stopping = sm.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "voice-stop-final",
				emit: (message) => emitted.push(message),
			},
		);
		await waitFor(() =>
			expect(dbMock.appendRealtimeTranscriptMessage).toHaveBeenCalledTimes(1),
		);
		expect(
			emitted.some(
				(message) =>
					message.type === "realtime_state" && message.state === "closed",
			),
		).toBe(false);
		finishProviderStop();
		await stopping;

		const writes = vi.mocked(dbMock.appendRealtimeTranscriptMessage).mock.calls;
		expect(writes.map(([input]) => input.text)).toEqual([
			"Last question",
			"Last answer",
		]);
		expect(writes[1][0].seq).toBe(writes[0][0].seq + 1);
		const finalIndexes = emitted.flatMap((message, index) =>
			message.type === "realtime_transcript" && message.done ? [index] : [],
		);
		const closedIndex = emitted.findIndex(
			(message) =>
				message.type === "realtime_state" && message.state === "closed",
		);
		expect(finalIndexes).toHaveLength(2);
		expect(closedIndex).toBeGreaterThan(
			finalIndexes[1] ?? Number.MAX_SAFE_INTEGER,
		);
		expect(sm.hasActiveRealtime()).toBe(false);
	});

	it("keeps repeated identical done-only Live utterances", async () => {
		let publishRealtime: ((event: ProviderRealtimeEvent) => void) | undefined;
		const startRealtime = vi.fn().mockImplementation(async (request) => {
			publishRealtime = request.onEvent;
			return { providerSessionId: "sdk-live-repeated-done" };
		});
		const { provider } = makeSwitchableProvider(
			{ startRealtime, stopRealtime: vi.fn().mockResolvedValue(undefined) },
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		await sm.controlRealtime(
			{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
			{ sessionId: "voice-repeated-done", emit: vi.fn() },
		);

		publishRealtime?.({
			type: "transcript_done",
			role: "user",
			text: "Again",
		});
		publishRealtime?.({
			type: "transcript_done",
			role: "user",
			text: "Again",
		});
		await waitFor(() =>
			expect(dbMock.appendRealtimeTranscriptMessage).toHaveBeenCalledTimes(2),
		);

		const writes = vi.mocked(dbMock.appendRealtimeTranscriptMessage).mock.calls;
		expect(writes.map(([input]) => input.text)).toEqual(["Again", "Again"]);
		expect(writes[1][0].seq).toBe(writes[0][0].seq + 1);
		expect(writes[1][0].utteranceId).not.toBe(writes[0][0].utteranceId);
		await sm.controlRealtime(
			{ action: "stop" },
			{ sessionId: "voice-repeated-done", emit: vi.fn() },
		);
	});

	it("persists ordered Live finals, including repeated identical done-only messages", async () => {
		let publishRealtime: ((event: ProviderRealtimeEvent) => void) | undefined;
		const startRealtime = vi.fn().mockImplementation(async (request) => {
			publishRealtime = request.onEvent;
			return { providerSessionId: "sdk-live-transcript" };
		});
		const { provider } = makeSwitchableProvider(
			{ startRealtime, stopRealtime: vi.fn().mockResolvedValue(undefined) },
			"codex",
		);
		const base = makeConfig("gpt-5.6-sol");
		const sm = new SessionManager(
			{
				...base,
				vault_provider: "codex",
				voice: { ...base.voice, codex_live_mode: true },
			} as HlidConfig,
			makeProviders(provider),
		);
		const emitted: ServerMessage[] = [];
		const writes: Array<() => void> = [];
		vi.mocked(dbMock.appendRealtimeTranscriptMessage).mockImplementation(
			(input) =>
				new Promise((resolve) => {
					writes.push(() =>
						resolve({ id: input.seq + 500, seq: input.seq, inserted: true }),
					);
				}),
		);

		await sm.controlRealtime(
			{ action: "start", mode: "live", sdp: "v=0\r\no=hlid" },
			{
				sessionId: "voice-transcript",
				requestId: "request-live-transcript",
				emit: (message) => emitted.push(message),
			},
		);
		publishRealtime?.({ type: "started", realtimeSessionId: "provider-call" });
		publishRealtime?.({ type: "sdp", sdp: "v=0\r\no=codex" });
		publishRealtime?.({ type: "transcript_delta", role: "user", delta: "Hi" });
		publishRealtime?.({ type: "transcript_done", role: "user", text: "Hi" });
		publishRealtime?.({
			type: "transcript_delta",
			role: "assistant",
			delta: "Hello",
		});
		publishRealtime?.({
			type: "transcript_done",
			role: "assistant",
			text: "Hello",
		});

		await waitFor(() =>
			expect(dbMock.appendRealtimeTranscriptMessage).toHaveBeenCalledTimes(1),
		);
		expect(writes).toHaveLength(1);
		writes.shift()?.();
		await waitFor(() =>
			expect(dbMock.appendRealtimeTranscriptMessage).toHaveBeenCalledTimes(2),
		);
		writes.shift()?.();
		await waitFor(() =>
			expect(
				emitted.filter(
					(message) => message.type === "realtime_transcript" && message.done,
				),
			).toHaveLength(2),
		);

		const calls = vi.mocked(dbMock.appendRealtimeTranscriptMessage).mock.calls;
		expect(calls[1][0].seq).toBe(calls[0][0].seq + 1);
		expect(calls[0][0]).toMatchObject({
			sessionId: "voice-transcript",
			role: "user",
			text: "Hi",
			providerRealtimeSessionId: "provider-call",
			utteranceId: `codex-realtime-${calls[0][0].seq}`,
		});
		expect(calls[1][0]).toMatchObject({
			role: "assistant",
			text: "Hello",
			realtimeSessionId: calls[0][0].realtimeSessionId,
			utteranceId: `codex-realtime-${calls[1][0].seq}`,
		});
		expect(calls[0][0].realtimeSessionId).toMatch(/^raven-live-/);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "realtime_transcript",
				mode: "live",
				role: "user",
				done: true,
				db_id: calls[0][0].seq + 500,
				source: "codex_realtime",
				fork_supported: false,
			}),
		);
		publishRealtime?.({
			type: "transcript_done",
			role: "assistant",
			text: "Hello",
		});
		await waitFor(() =>
			expect(dbMock.appendRealtimeTranscriptMessage).toHaveBeenCalledTimes(3),
		);
		const repeated = vi.mocked(dbMock.appendRealtimeTranscriptMessage).mock
			.calls[2][0];
		expect(repeated).toMatchObject({ role: "assistant", text: "Hello" });
		expect(repeated.seq).toBe(calls[1][0].seq + 1);
		expect(repeated.utteranceId).not.toBe(calls[1][0].utteranceId);
		writes.shift()?.();
		await waitFor(() =>
			expect(
				emitted.filter(
					(message) => message.type === "realtime_transcript" && message.done,
				),
			).toHaveLength(3),
		);
		publishRealtime?.({
			type: "transcript_delta",
			role: "user",
			delta: "discard me",
		});
		const provisional = emitted.at(-1);
		publishRealtime?.({
			type: "transcript_done",
			role: "user",
			text: "   ",
		});
		expect(dbMock.appendRealtimeTranscriptMessage).toHaveBeenCalledTimes(3);
		expect(emitted.at(-1)).toMatchObject({
			type: "realtime_transcript",
			mode: "live",
			role: "user",
			text: "",
			done: true,
			utterance_id:
				provisional?.type === "realtime_transcript" &&
				provisional.mode === "live"
					? provisional.utterance_id
					: "missing",
		});
		expect(emitted.at(-1)).not.toHaveProperty("db_id");

		await sm.controlRealtime(
			{ action: "stop" },
			{
				sessionId: "voice-transcript",
				requestId: "request-live-transcript",
				emit: (message) => emitted.push(message),
			},
		);
		for (const message of emitted) {
			if (
				message.type === "realtime_state" ||
				message.type === "realtime_sdp" ||
				message.type === "realtime_transcript" ||
				message.type === "realtime_error"
			) {
				expect(message.request_id).toBe("request-live-transcript");
			}
		}
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
		vi.mocked(dbMock.setToolEventActivity).mockClear();
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

	it("emits and persists normalized task activity updates", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const initial = {
			kind: "tasks" as const,
			source: "claude-task-store" as const,
			operation: "list" as const,
			items: [],
		};
		const updated = {
			...initial,
			items: [
				{
					id: "4",
					subject: "Render task card",
					status: "in_progress" as const,
				},
			],
		};
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-task-1" },
				{
					type: "tool_start",
					toolId: "task-list-1",
					name: "TaskList",
					input: {},
					taskActivity: initial,
				},
				{
					type: "tool_activity_update",
					toolId: "task-list-1",
					taskActivity: updated,
				},
			],
			gate,
		);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery(
			"list tasks",
			(message) => emitted.push(message),
			{ sessionId: "sess-task-1" },
		);
		await gateReached;
		await waitFor(() => {
			expect(dbMock.appendToolEvent).toHaveBeenCalledWith(
				"sess-task-1",
				expect.any(Number),
				"task-list-1",
				"TaskList",
				{},
				undefined,
				expect.objectContaining({ providerId: "claude", agentCwd: null }),
				initial,
			);
			expect(dbMock.setToolEventActivity).toHaveBeenCalledWith(
				"sess-task-1",
				"task-list-1",
				updated,
			);
		});
		expect(emitted).toContainEqual({
			type: "tool_activity_update",
			id: "task-list-1",
			taskActivity: updated,
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

	it("persists generated media as a compact attachment-backed tool result", async () => {
		vi.mocked(loadConfig).mockReturnValue(makeConfig());
		vi.mocked(ingestGeneratedImage).mockResolvedValue({
			id: "generated-attachment-1",
			filename: "image-1.png",
			mime: "image/png",
			sizeBytes: 4_096,
			width: 1_024,
			height: 1_024,
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const rawBase64 = "raw-provider-image-base64";
		const { provider, gateReached } = makeControlledProvider(
			[
				{ type: "session_start", sessionId: "sdk-media-1" },
				{
					type: "tool_start",
					toolId: "image-1",
					name: "ImageGeneration",
					input: { type: "imageGeneration", status: "inProgress" },
				},
				{
					type: "generated_media",
					toolId: "image-1",
					kind: "image",
					status: "completed",
					mime: "image/png",
					dataBase64: rawBase64,
					prompt: "A quiet mountain lake",
					providerPath: "/provider/image-1.png",
				},
			],
			gate,
		);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const runPromise = sm.runQuery(
			"make an image",
			(message) => emitted.push(message),
			{ sessionId: "sess-media-1" },
		);
		await gateReached;

		expect(ingestGeneratedImage).toHaveBeenCalledWith(
			expect.objectContaining({
				dataBase64: rawBase64,
				providerItemId: "image-1",
				providerPath: "/provider/image-1.png",
				sessionId: "sess-media-1",
				messageSeq: expect.any(Number),
			}),
		);
		const persisted = vi
			.mocked(dbMock.setToolEventResult)
			.mock.calls.find((call) => call[1] === "image-1");
		expect(persisted).toBeDefined();
		expect(persisted?.[2]).not.toContain(rawBase64);
		expect(JSON.parse(persisted?.[2] ?? "{}")).toMatchObject({
			type: "hlid_generated_media",
			version: 1,
			status: "ready",
			provider: "claude",
			provider_item_id: "image-1",
			attachment_id: "generated-attachment-1",
			filename: "image-1.png",
			mime: "image/png",
			size_bytes: 4_096,
			width: 1_024,
			height: 1_024,
			prompt: "A quiet mountain lake",
		});
		expect(emitted).toContainEqual({
			type: "attachment_created",
			id: "generated-attachment-1",
			kind: "ephemeral",
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

	it("separates adjacent assistant messages in streaming and persisted text", async () => {
		const provider: AgentProvider = {
			providerId: "codex",
			query(_params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-message-boundaries" };
					yield { type: "text_delta", text: "First update." };
					yield { type: "assistant_message_boundary" };
					yield { type: "text_delta", text: "Second update." };
					yield {
						type: "tool_start",
						toolId: "tool-1",
						name: "Read",
						input: {},
					};
					yield { type: "assistant_message_boundary" };
					yield { type: "text_delta", text: "After tool." };
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
		await sm.runQuery("report progress", (message) => emitted.push(message), {
			sessionId: "sess-message-boundaries",
		});

		expect(emitted.filter((message) => message.type === "chunk")).toEqual([
			{ type: "chunk", text: "First update.", offset: 0 },
			{ type: "chunk", text: "\n\nSecond update.", offset: 13 },
			{ type: "chunk", text: "\n\nAfter tool.", offset: 29 },
		]);
		expect(dbMock.setMessageText).toHaveBeenCalledWith(
			"sess-message-boundaries",
			expect.any(Number),
			"First update.\n\nSecond update.\n\nAfter tool.",
		);
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
