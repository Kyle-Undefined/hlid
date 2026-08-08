/**
 * SessionManager — provider usage refresh, rate-limit window marks, auto-sleep gates.
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

import type { HlidConfig } from "../config";
import * as dbMock from "../db";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
} from "./agentProvider";
import { loadConfig } from "./config";
import type { RateLimitMessage, ServerMessage } from "./protocol";
import { getWindowMark, updateWindowMark } from "./proxy";
import { SessionManager } from "./session";
import {
	makeConfig,
	makeControllableProvider,
	makeProviders,
	makeSwitchableProvider,
	waitFor,
} from "./session.test-utils";
import { registerUmbodApprovalSession } from "./umbod";
import {
	evaluateSleep,
	reportRateLimitSignal,
	_resetForTests as resetUsageGate,
} from "./usageGate";

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

		await sm.runQuery("hello", (message) => emitted.push(message), {
			sessionId: "fable",
		});

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

		await sm.runQuery("hello", () => {}, {
			sessionId: "usage-refresh-session",
		});

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
		const autoSleep = {
			enabled: true,
			threshold: 0.9,
			max_sleep_minutes: 360,
			resume_buffer_seconds: 30,
		};
		const config = { ...makeConfig(), auto_sleep: autoSleep } as HlidConfig;
		vi.mocked(loadConfig).mockReturnValue(config);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(config, makeProviders(provider));
		const running = sm.runQuery("hello", (message) => emitted.push(message), {
			sessionId: "live-usage-session",
		});

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
			expect(evaluateSleep("live-usage-test", autoSleep)).toMatchObject({
				reason: "threshold",
				utilization: 0.91,
			});
			expect(emitted).toContainEqual(
				expect.objectContaining({
					type: "agent_sleep",
					state: "sleeping",
					providerId: "live-usage-test",
					utilization: 0.91,
				}),
			);
			expect(sm.getSleepState()).toMatchObject({
				type: "agent_sleep",
				state: "sleeping",
				providerId: "live-usage-test",
			});

			sm.skipSleep();
			expect(sm.getSleepState()).toBeNull();
			expect(emitted).toContainEqual(
				expect.objectContaining({
					type: "agent_sleep",
					state: "resumed",
					providerId: "live-usage-test",
					cause: "skipped",
				}),
			);
			finishTurn();
			await running;
			expect(usageWindows).toHaveBeenCalledTimes(3);
		} finally {
			sm.skipSleep();
			finishTurn();
			await running;
			resetUsageGate();
			vi.mocked(loadConfig).mockReset();
			vi.useRealTimers();
		}
	});

	it("does not fail a successful turn when usage refresh rejects", async () => {
		const usageWindows = vi.fn().mockRejectedValue(new Error("unsupported"));
		const { provider } = makeSwitchableProvider({ usageWindows });
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await expect(
			sm.runQuery("hello", () => {}, {
				sessionId: "usage-refresh-fallback",
			}),
		).resolves.toBeUndefined();
		expect(sm.getStatus().state).toBe("idle");
	});
});

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
		await sm.runQuery("test", () => {}, {
			sessionId: "sess-rl",
		});
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
		await sm.runQuery("test", (m) => emitted.push(m), {
			sessionId: "sess-7day",
		});
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
		await sm.runQuery("test", (m) => emitted.push(m), {
			sessionId: "sess-sonnet",
		});
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
		await sm.runQuery("test", () => {}, {
			sessionId: "sess-rl-null",
		});
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
		await sm.runQuery("test", () => {}, {
			sessionId: "sess-rl-notype",
		});
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
		await smHigh.runQuery("test", () => {}, {
			sessionId: "sess-rl-high",
		});
		expect(getWindowMark("rl-downward", "five_hour")?.utilization).toBeCloseTo(
			0.75,
		);

		// Second session: same resetsAt, lower utilization = external Anthropic reset
		const providerLow = makeRateLimitProvider("rl-downward", 0.12, resetsAt);
		const smLow = new SessionManager(makeConfig(), makeProviders(providerLow));
		await smLow.runQuery("test", () => {}, {
			sessionId: "sess-rl-low",
		});
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

		await sm.runQuery("hi", vi.fn(), {
			sessionId: `sleep-${providerId}-hook`,
		});

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
		await sm.runQuery("hi", (m) => emitted.push(m), {
			sessionId: "sleep-turn",
		});

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

	it("registers a Claude session-limit transport error before the next turn", async () => {
		let queryCount = 0;
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				queryCount += 1;
				const current = queryCount;
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: `sdk-limit-${current}` };
					if (current === 1) {
						yield {
							type: "transport_error",
							message:
								"You've hit your session limit · resets 12:30am (America/New_York)",
						};
						return;
					}
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
		const firstEvents: ServerMessage[] = [];
		const sm = new SessionManager(sleepConfig(), makeProviders(provider));
		await sm.runQuery("probe", (message) => firstEvents.push(message), {
			sessionId: "transport-limit-session",
		});
		expect(firstEvents).toContainEqual(
			expect.objectContaining({
				type: "rate_limit",
				status: "rejected",
				rateLimitType: "five_hour",
				providerId: "claude",
			}),
		);

		const second = sm.runQuery("wait for reset", () => {}, {
			sessionId: "transport-limit-session",
			turnId: "transport-limit-turn",
		});
		await waitFor(() =>
			expect(sm.getSleepState()).toMatchObject({
				state: "sleeping",
				reason: "limit_reached",
			}),
		);
		expect(queryCount).toBe(1);
		sm.skipSleep();
		await second;
		expect(queryCount).toBe(2);
	});

	it("registers a Claude spend-limit transport error as spend_control", async () => {
		const providerMessage =
			"spend limit reached (monthly; resets 2030-08-09 14:30 UTC) — Ask your organization owner to raise the limit";
		const expectedReset = Math.floor(
			Date.parse("2030-08-09T14:30:00Z") / 1_000,
		);
		let queryCount = 0;
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				queryCount += 1;
				const current = queryCount;
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: `spend-limit-${current}` };
					if (current === 1) {
						yield { type: "transport_error", message: providerMessage };
						return;
					}
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
		const firstEvents: ServerMessage[] = [];
		const sm = new SessionManager(sleepConfig(), makeProviders(provider));
		await sm.runQuery("probe", (message) => firstEvents.push(message), {
			sessionId: "transport-spend-limit-session",
		});
		expect(firstEvents).toContainEqual(
			expect.objectContaining({
				type: "rate_limit",
				status: "rejected",
				rateLimitType: "spend_control",
				resetsAt: expectedReset,
				providerId: "claude",
			}),
		);
		expect(firstEvents).toContainEqual(
			expect.objectContaining({ type: "error", message: providerMessage }),
		);

		const second = sm.runQuery("wait for reset", () => {}, {
			sessionId: "transport-spend-limit-session",
			turnId: "transport-spend-limit-turn",
		});
		await waitFor(() =>
			expect(sm.getSleepState()).toMatchObject({
				state: "sleeping",
				reason: "limit_reached",
				windowId: "spend_control",
			}),
		);
		expect(queryCount).toBe(1);
		sm.skipSleep();
		await second;
		expect(queryCount).toBe(2);
	});

	it("does not treat a spend-limit availability error as a hard cap", async () => {
		const providerMessage = "spend limit unavailable (fetch_error)";
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "spend-unavailable" };
					yield { type: "transport_error", message: providerMessage };
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
		const config = sleepConfig();
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("probe", (message) => emitted.push(message), {
			sessionId: "spend-unavailable-session",
		});
		expect(emitted.some((message) => message.type === "rate_limit")).toBe(
			false,
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({ type: "error", message: providerMessage }),
		);
		expect(evaluateSleep("claude", config.auto_sleep)).toBeNull();
	});

	it("abort during a turn-gate sleep cancels without dispatching", async () => {
		reportRateLimitSignal("claude", "five_hour", "rejected", epochNow() + 3600);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeImmediateProvider()),
		);
		const turn = sm.runQuery("hi", (m) => emitted.push(m), {
			sessionId: "sleep-abort",
		});
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
		const turn = sm.runQuery("hi", (m) => emitted.push(m), {
			sessionId: "sleep-tool",
		});

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
		const turn = sm.runQuery("hi", (m) => emitted.push(m), {
			sessionId: "sleep-question",
		});

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
		await sm.runQuery("hi", () => {}, {
			sessionId: "sleep-register",
		});
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
		const turn = sm.runQuery("hi", (m) => emitted.push(m), {
			sessionId: "sleep-replay",
		});
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

	it("rehydrates a durable sleeping prompt without provider spend", async () => {
		const ctl = makeControllableProvider();
		const emitted: ServerMessage[] = [];
		const now = epochNow();
		// Match the persisted hard limit to the currently hydrated provider window.
		updateWindowMark("claude", "five_hour", 0.2, now + 3_600);
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		expect(
			sm.restoreDurableTurns(
				[
					{
						turn_id: "restored-sleep-turn",
						session_id: "restored-sleep-session",
						position: 1,
						payload_json: JSON.stringify({
							userMessage: "continue after reset",
							options: {},
						}),
						state: "sleeping",
						provider_id: "claude",
						window_id: "five_hour",
						sleep_reason: "limit_reached",
						sleep_until: now + 3_600,
						sleep_target: now + 3_600,
						sleep_utilization: null,
						cap_deadline: now + 3_600,
						created_at: now,
						updated_at: now,
					},
				],
				(message) => emitted.push(message),
			),
		).toBe(1);
		await waitFor(() =>
			expect(sm.getSleepState()).toMatchObject({
				state: "sleeping",
				reason: "limit_reached",
			}),
		);
		expect(ctl.getSendCount()).toBe(0);
		expect(sm.getQueueState()).toMatchObject({
			running_turn_id: "restored-sleep-turn",
			running_turn: {
				id: "restored-sleep-turn",
				text: "continue after reset",
			},
		});

		sm.skipSleep();
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		expect(dbMock.markPendingSessionTurnSleeping).toHaveBeenCalledWith(
			expect.objectContaining({
				turnId: "restored-sleep-turn",
				capDeadline: expect.any(Number),
			}),
		);
		expect(dbMock.markPendingSessionTurnDispatching).toHaveBeenCalledWith(
			"restored-sleep-turn",
		);
		ctl.turns[0].resolveDone();
		await waitFor(() =>
			expect(dbMock.deletePendingSessionTurn).toHaveBeenCalledWith(
				"restored-sleep-turn",
			),
		);
	});
});

// ── assistant_message_id → sdk_uuid capture ────────────────────────────────────
