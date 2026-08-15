/**
 * SessionManager — runQuery queueing, steer/cancel/promote, AgentSession reuse.
 * Shared module mocks and provider builders: see session.test-utils.ts.
 */
import { describe, expect, it, vi } from "vitest";

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
	SendOptions,
} from "./agentProvider";
import { createClaudeHostInteractionHandlers } from "./claudeHostInteractions";
import { buildPromptAsync } from "./promptBuilder";
import type { ServerMessage } from "./protocol";
import { SessionManager } from "./session";
import {
	makeConfig,
	makeControllableProvider,
	makeLongLivedProvider,
	makeProviders,
	testPromptContextManifest,
	waitFor,
} from "./session.test-utils";

function peerDoneEvent(): AgentEvent {
	return {
		type: "done",
		cost: 0,
		turns: 1,
		durationMs: 0,
		usage: { inputTokens: 1, outputTokens: 1 },
	};
}

function makePeerInboxHarness(): {
	provider: AgentProvider;
	pushEvent: (event: AgentEvent) => void;
	getParams: () => AgentQueryParams;
	send: ReturnType<typeof vi.fn>;
	setPermissionMode: ReturnType<typeof vi.fn>;
	interrupt: ReturnType<typeof vi.fn>;
	cancel: ReturnType<typeof vi.fn>;
} {
	const events: AgentEvent[] = [];
	const waiters: Array<(event: AgentEvent | null) => void> = [];
	let params: AgentQueryParams | null = null;
	let started = false;
	let closed = false;
	const send = vi.fn().mockResolvedValue(undefined);
	const setPermissionMode = vi.fn().mockResolvedValue(undefined);
	const interrupt = vi.fn().mockResolvedValue(undefined);
	const cancel = vi.fn(() => {
		closed = true;
		while (waiters.length > 0) waiters.shift()?.(null);
	});
	const pushEvent = (event: AgentEvent): void => {
		const waiter = waiters.shift();
		if (waiter) waiter(event);
		else events.push(event);
	};
	const iterator: AsyncIterator<AgentEvent> = {
		async next(): Promise<IteratorResult<AgentEvent>> {
			if (closed) return { value: undefined as never, done: true };
			if (!started) {
				started = true;
				return {
					value: { type: "session_start", sessionId: "sdk-peer-session" },
					done: false,
				};
			}
			const event = events.shift();
			if (event) return { value: event, done: false };
			return new Promise<IteratorResult<AgentEvent>>((resolve) => {
				waiters.push((next) => {
					resolve(
						next
							? { value: next, done: false }
							: { value: undefined as never, done: true },
					);
				});
			});
		},
	};
	const provider: AgentProvider = {
		providerId: "claude",
		query(nextParams: AgentQueryParams): AgentSession {
			params = nextParams;
			return {
				[Symbol.asyncIterator]: () => iterator,
				send,
				setPermissionMode,
				interrupt,
				cancel,
				mcpServerStatus: () => Promise.resolve([]),
			};
		},
	};
	return {
		provider,
		pushEvent,
		getParams: () => {
			if (!params) throw new Error("provider query params were not captured");
			return params;
		},
		send,
		setPermissionMode,
		interrupt,
		cancel,
	};
}

function peerInboxConfig(
	permissionMode: "default" | "bypassPermissions" = "default",
) {
	const config = makeConfig();
	config.claude.peer_inbox = true;
	config.claude.permission_mode = permissionMode;
	return config;
}

async function establishIdlePeerSession(
	sm: SessionManager,
	ctl: ReturnType<typeof makePeerInboxHarness>,
	emit: (message: ServerMessage) => void = () => {},
): Promise<void> {
	const turn = sm.runQuery("initial human turn", emit, {
		inputOrigin: "human",
		sessionId: "peer-session",
		turnId: "initial-human-turn",
	});
	await waitFor(() => expect(ctl.send).toHaveBeenCalledTimes(1));
	ctl.pushEvent(peerDoneEvent());
	await turn;
}

describe("SessionManager — runQuery queueing", () => {
	it("commits the initial notification policy before durable ownership and provider work", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		let releaseCreate: (() => void) | undefined;
		const createPending = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		vi.mocked(dbMock.createSession).mockClear();
		vi.mocked(dbMock.enqueuePendingSessionTurn).mockClear();
		vi.mocked(dbMock.createSession).mockImplementationOnce(
			async () => createPending,
		);

		const initialNotificationPolicy = {
			mode: "notify_completion_once" as const,
			scope: "session" as const,
			targetDeviceIds: null,
		};
		const run = sm.runQuery("durable prompt", () => {}, {
			inputOrigin: "human",
			sessionId: "durable-policy-session",
			turnId: "durable-policy-turn",
			initialNotificationPolicy,
		});

		await waitFor(() => expect(dbMock.createSession).toHaveBeenCalledTimes(1));
		expect(dbMock.createSession).toHaveBeenCalledWith(
			"durable-policy-session",
			"DURABLE PROMPT",
			"claude-test",
			expect.objectContaining({ initialNotificationPolicy }),
		);
		expect(dbMock.enqueuePendingSessionTurn).not.toHaveBeenCalled();
		expect(ctl.getQueryCount()).toBe(0);

		releaseCreate?.();
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const queued = vi.mocked(dbMock.enqueuePendingSessionTurn).mock
			.calls[0]?.[0];
		expect(queued?.payloadJson).not.toContain("initialNotificationPolicy");
		ctl.turns[0].resolveDone();
		await run;
	});

	it("fails closed before provider work when initial policy persistence fails", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		vi.mocked(dbMock.createSession).mockRejectedValueOnce(
			new Error("policy insert failed"),
		);
		vi.mocked(dbMock.enqueuePendingSessionTurn).mockClear();

		await expect(
			sm.runQuery("do not dispatch", () => {}, {
				inputOrigin: "human",
				sessionId: "failed-policy-session",
				turnId: "failed-policy-turn",
				initialNotificationPolicy: {
					mode: "mute",
					scope: "session",
					targetDeviceIds: null,
				},
			}),
		).rejects.toThrow("policy insert failed");

		expect(dbMock.enqueuePendingSessionTurn).not.toHaveBeenCalled();
		expect(ctl.getQueryCount()).toBe(0);
	});

	it("applies the initial policy on a non-durable first turn", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		vi.mocked(dbMock.createSession).mockClear();
		const initialNotificationPolicy = {
			mode: "notify" as const,
			scope: "delegation_tree" as const,
			targetDeviceIds: null,
		};

		const run = sm.runQuery("ordinary prompt", () => {}, {
			inputOrigin: "human",
			sessionId: "ordinary-policy-session",
			initialNotificationPolicy,
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		expect(dbMock.createSession).toHaveBeenCalledWith(
			"ordinary-policy-session",
			"ORDINARY PROMPT",
			"claude-test",
			expect.objectContaining({ initialNotificationPolicy }),
		);
		ctl.turns[0].resolveDone();
		await run;
	});

	it("persists an interactive turn through the dispatch boundary", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		const run = sm.runQuery("durable prompt", () => {}, {
			inputOrigin: "human",
			sessionId: "durable-session",
			turnId: "durable-turn",
		});

		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		expect(dbMock.enqueuePendingSessionTurn).toHaveBeenCalledWith({
			turnId: "durable-turn",
			sessionId: "durable-session",
			payloadJson: expect.stringContaining('"inputOrigin":"human"'),
		});
		expect(dbMock.markPendingSessionTurnDispatching).toHaveBeenCalledWith(
			"durable-turn",
		);
		ctl.turns[0].resolveDone();
		await run;
		expect(dbMock.deletePendingSessionTurn).toHaveBeenCalledWith(
			"durable-turn",
		);
	});

	it("restores durable turns in FIFO order after a restart", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		const emitted: ServerMessage[] = [];
		const now = Math.floor(Date.now() / 1_000);
		const row = (
			turnId: string,
			position: number,
			message: string,
		): dbMock.PendingSessionTurnRow => ({
			turn_id: turnId,
			session_id: "restored-session",
			position,
			payload_json: JSON.stringify({ userMessage: message, options: {} }),
			state: "queued",
			provider_id: null,
			window_id: null,
			sleep_reason: null,
			sleep_until: null,
			sleep_target: null,
			sleep_utilization: null,
			cap_deadline: null,
			created_at: now,
			updated_at: now,
		});

		expect(
			sm.restoreDurableTurns(
				[row("turn-1", 1, "first"), row("turn-2", 2, "second")],
				(message) => emitted.push(message),
			),
		).toBe(2);
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "status",
				state: "running",
				turn_id: "turn-1",
			}),
		);
		ctl.turns[0].resolveDone();
		await waitFor(() => expect(ctl.getSendCount()).toBe(2));
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "status",
				state: "running",
				turn_id: "turn-2",
			}),
		);
		ctl.turns[1].resolveDone();
		await waitFor(() => expect(sm.getStatus().state).toBe("idle"));
	});

	it.each([
		{
			label: "stored coordinator provenance",
			inputOrigin: "coordinator" as const,
			expected: "coordinator",
		},
		{
			label: "a legacy row without provenance",
			inputOrigin: undefined,
			expected: "unclassified",
		},
	])("restores $label without recomputing authority", async ({
		inputOrigin,
		expected,
	}) => {
		const ctl = makeLongLivedProvider();
		let sendSpy: ReturnType<typeof vi.fn> | undefined;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const session = ctl.provider.query(params);
				sendSpy = session.send as ReturnType<typeof vi.fn>;
				return session;
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const now = Math.floor(Date.now() / 1_000);
		const payload = {
			userMessage: "restored input",
			...(inputOrigin ? { inputOrigin } : {}),
			options: {},
		};

		expect(
			sm.restoreDurableTurns(
				[
					{
						turn_id: `restored-${expected}`,
						session_id: "restored-origin-session",
						position: 1,
						payload_json: JSON.stringify(payload),
						state: "queued",
						provider_id: null,
						window_id: null,
						sleep_reason: null,
						sleep_until: null,
						sleep_target: null,
						sleep_utilization: null,
						cap_deadline: null,
						created_at: now,
						updated_at: now,
					},
				],
				() => {},
			),
		).toBe(1);
		await waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));
		expect(sendSpy).toHaveBeenCalledWith("test prompt", {
			inputOrigin: expected,
		});
		ctl.closeStream();
	});

	it("reuses a transcript row written before a pre-dispatch restart", async () => {
		const ctl = makeControllableProvider();
		vi.mocked(dbMock.getUserMessageSeqByTurnId).mockResolvedValueOnce(7);
		vi.mocked(dbMock.appendMessage).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		const now = Math.floor(Date.now() / 1_000);

		sm.restoreDurableTurns(
			[
				{
					turn_id: "turn-restart",
					session_id: "session-restart",
					position: 1,
					payload_json: JSON.stringify({
						userMessage: "survive once",
						options: {},
					}),
					state: "queued",
					provider_id: null,
					window_id: null,
					sleep_reason: null,
					sleep_until: null,
					sleep_target: null,
					sleep_utilization: null,
					cap_deadline: null,
					created_at: now,
					updated_at: now,
				},
			],
			() => {},
		);

		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		expect(
			vi
				.mocked(dbMock.appendMessage)
				.mock.calls.some(
					(call) => call[0] === "session-restart" && call[2] === "user",
				),
		).toBe(false);
		ctl.turns[0].resolveDone();
		await waitFor(() => expect(sm.getStatus().state).toBe("idle"));
	});

	it.each([
		{ label: "foreground", backgroundSession: false },
		{ label: "background", backgroundSession: true },
	])("settles an explicitly aborted $label turn idle and records its partial usage once", async ({
		backgroundSession,
	}) => {
		let step = 0;
		let rejectPending: ((error: Error) => void) | null = null;
		let pending = false;
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const iterator: AsyncIterator<AgentEvent> = {
					async next(): Promise<IteratorResult<AgentEvent>> {
						if (step++ === 0) {
							return {
								value: {
									type: "session_start",
									sessionId: "sdk-aborted-child",
								},
								done: false,
							};
						}
						if (step === 2) {
							return {
								value: {
									type: "usage",
									inputTokens: 10,
									outputTokens: 5,
									cacheReadTokens: 20,
									cacheCreationTokens: 2,
									queryUsage: {
										inputTokens: 10,
										outputTokens: 5,
										cacheReadTokens: 20,
										cacheCreationTokens: 2,
									},
									model: "claude-sonnet-4-6",
								},
								done: false,
							};
						}
						if (step === 3) {
							return {
								value: { type: "text_delta", text: "Partial child result." },
								done: false,
							};
						}
						pending = true;
						return new Promise<IteratorResult<AgentEvent>>((_, reject) => {
							rejectPending = reject;
						});
					},
				};
				return {
					[Symbol.asyncIterator]: () => iterator,
					cancel: () => {
						rejectPending?.(new Error("provider cancelled"));
					},
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		vi.mocked(dbMock.recordQuery).mockClear();
		vi.mocked(dbMock.setMessageQueryId).mockClear();
		vi.mocked(dbMock.setSessionActualModelForProvider).mockClear();
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const turn = sm.runQuery(
			"delegated work",
			(message) => emitted.push(message),
			{
				sessionId: "child-session",
				attachments: [],
				turnId: "child-turn",
				backgroundSession,
			},
		);

		await waitFor(() => expect(pending).toBe(true));
		sm.abort();
		await turn;

		expect(sm.getStatus().state).toBe("idle");
		expect(emitted.some((message) => message.type === "error")).toBe(false);
		expect(dbMock.recordQuery).toHaveBeenCalledTimes(1);
		expect(dbMock.recordQuery).toHaveBeenCalledWith(
			"child-session",
			expect.objectContaining({
				input_tokens: 10,
				output_tokens: 5,
				cache_read_tokens: 20,
				cache_creation_tokens: 2,
				tokens_in_context: 32,
				model: "claude-sonnet-4-6",
				stop_reason: null,
			}),
			"claude",
		);
		expect(dbMock.setMessageQueryId).toHaveBeenCalledWith(
			"child-session",
			expect.any(Number),
			1,
		);
		expect(dbMock.setSessionActualModelForProvider).toHaveBeenCalledWith(
			"child-session",
			"claude",
			"claude-test",
			"claude-sonnet-4-6",
		);
	});

	it("does not duplicate normal done accounting for a background turn", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const generator = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-complete-child" };
					yield {
						type: "usage",
						inputTokens: 8,
						outputTokens: 3,
						queryUsage: {
							inputTokens: 8,
							outputTokens: 3,
							cacheReadTokens: 0,
							cacheCreationTokens: 0,
						},
						model: "claude-sonnet-4-6",
					};
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 12,
						usage: { inputTokens: 8, outputTokens: 3 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => generator[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		vi.mocked(dbMock.recordQuery).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("delegated work", () => {}, {
			sessionId: "child-session",
			attachments: [],
			turnId: "child-turn",
			backgroundSession: true,
		});

		expect(dbMock.recordQuery).toHaveBeenCalledTimes(1);
	});

	it("does not invent a zero-token background query before usage is reported", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const generator = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-no-usage-child" };
				})();
				return {
					[Symbol.asyncIterator]: () => generator[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		vi.mocked(dbMock.recordQuery).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("delegated work", () => {}, {
			sessionId: "child-session",
			attachments: [],
			turnId: "child-turn",
			backgroundSession: true,
		});

		expect(dbMock.recordQuery).not.toHaveBeenCalled();
	});

	it("preserves the ordinary error path when the provider was not explicitly aborted", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const generator = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-real-error" };
					throw new Error("real provider failure");
				})();
				return {
					[Symbol.asyncIterator]: () => generator[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		vi.mocked(dbMock.appendLog).mockClear();
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("ordinary work", (message) => emitted.push(message), {
			sessionId: "session-1",
		});

		expect(sm.getStatus().state).toBe("error");
		expect(emitted).toContainEqual({
			type: "error",
			message: "real provider failure",
			turn_scoped: true,
		});
		expect(dbMock.appendLog).toHaveBeenCalledWith(
			"error",
			"session",
			"runQuery error",
			expect.objectContaining({ message: "real provider failure" }),
		);
	});

	it("queues second runQuery while first is running and drains FIFO at done", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const events1: unknown[] = [];
		const events2: unknown[] = [];
		const turn1 = sm.runQuery("first", (m) => events1.push(m), {
			sessionId: "sess-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));

		// Second runQuery while first is still running — must queue, not reject.
		const turn2 = sm.runQuery("second", (m) => events2.push(m), {
			sessionId: "sess-1",
		});

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
		const t1 = sm.runQuery("a", recordDone("a"), {
			sessionId: "sess-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery("b", recordDone("b"), {
			sessionId: "sess-1",
		});
		const t3 = sm.runQuery("c", recordDone("c"), {
			sessionId: "sess-1",
		});

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

		const t1 = sm.runQuery("a", onMsg, {
			sessionId: "sess-1",
			turnId: "turn-a",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery("b", onMsg, {
			sessionId: "sess-1",
			turnId: "turn-b",
		});

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
		const t1 = sm.runQuery("a", () => {}, {
			sessionId: "sess-1",
		});
		const t2 = sm.runQuery("b", () => {}, {
			sessionId: "sess-1",
		});

		const results = await Promise.allSettled([t1, t2]);
		// runQuery itself never throws — errors are emitted as events. Both
		// promises resolve; second turn must have invoked the provider.
		expect(results[0].status).toBe("fulfilled");
		expect(results[1].status).toBe("fulfilled");
		expect(calls).toBe(2);
	});
});

// ── Slice C: cancelQueued ─────────────────────────────────────────────────────

describe("SessionManager — cancelQueued", () => {
	it("removes a pending queued turn by turn_id and resolves its promise silently", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		const t1 = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-2",
		});

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

		const t1 = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));

		// turn-1 is currently running (already shifted off turnQueue), so
		// cancelQueued must NOT match it.
		expect(sm.cancelQueued("turn-1")).toBe(false);

		ctl.turns[0].resolveDone();
		await t1;
	});
});

describe("SessionManager — steerQueued", () => {
	it("steers a delegated instruction directly without creating a queued fallback", async () => {
		const ctl = makeControllableProvider();
		const steer = vi.fn().mockResolvedValue(undefined);
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				return { ...ctl.provider.query(params), steer };
			},
		};
		vi.mocked(dbMock.appendMessage).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		ctl.pushEvent({ type: "text_delta", text: "partial response" });
		await waitFor(() =>
			expect(dbMock.appendMessage).toHaveBeenCalledWith(
				"sess-1",
				1,
				"assistant",
				"",
			),
		);

		const receipt = await sm.steerActiveTurn(
			"Check the delegated edge case",
			() => {},
			"sess-1",
			"delegation-steer-1",
			"coordinator",
		);

		expect(receipt).toEqual({
			targetTurnId: "turn-1",
			targetAssistantSeq: 1,
			steerSeq: 2,
			steerToolEventIndex: 0,
		});
		expect(steer).toHaveBeenCalledWith("test prompt", {
			inputOrigin: "coordinator",
		});
		expect(sm.getQueueState().pending_turn_ids).toEqual([]);
		expect(dbMock.appendMessage).toHaveBeenCalledWith(
			"sess-1",
			2,
			"user",
			"Check the delegated edge case",
			"delegation-steer-1",
			1,
			expect.stringContaining('"delivery":"steer"'),
			0,
		);
		ctl.turns[0].resolveDone();
		await first;
	});

	it("reports unsupported direct steering without queuing a new turn", async () => {
		const ctl = makeControllableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));

		await expect(
			sm.steerActiveTurn(
				"Do not queue this",
				() => {},
				"sess-1",
				"delegation-steer-unsupported",
				"coordinator",
			),
		).rejects.toThrow("does not support steering");
		expect(sm.getQueueState().pending_turn_ids).toEqual([]);
		expect(ctl.getSendCount()).toBe(1);
		ctl.turns[0].resolveDone();
		await first;
	});

	it("does not steer a replacement turn when prompt preparation outlives the original turn", async () => {
		const ctl = makeControllableProvider();
		const steer = vi.fn().mockResolvedValue(undefined);
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				return { ...ctl.provider.query(params), steer };
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));

		let preparationStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			preparationStarted = resolve;
		});
		let releasePreparation!: () => void;
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		vi.mocked(buildPromptAsync).mockImplementationOnce(async () => {
			preparationStarted();
			await preparationGate;
			return {
				prompt: "prepared steer",
				safeSkillContexts: [],
				safeAttachments: [],
				resourcePaths: [],
				safeVaultReferences: [],
				safeWorkspaceReferences: [],
				contextManifest: testPromptContextManifest(),
			};
		});
		const steering = sm.steerActiveTurn(
			"Do not leak into the next turn",
			() => {},
			"sess-1",
			"delegation-steer-race",
			"coordinator",
		);
		await started;
		const second = sm.runQuery("second", () => {}, {
			inputOrigin: "human",
			sessionId: "sess-1",
			turnId: "turn-2",
		});
		ctl.turns[0].resolveDone();
		await first;
		await waitFor(() => expect(ctl.getSendCount()).toBe(2));

		releasePreparation();
		await expect(steering).rejects.toThrow(
			"active provider turn changed while steering was being prepared",
		);
		expect(steer).not.toHaveBeenCalled();

		ctl.turns[1].resolveDone();
		await second;
	});

	it("reports when direct steering was accepted but transcript persistence failed", async () => {
		const ctl = makeControllableProvider();
		const steer = vi.fn().mockResolvedValue(undefined);
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				return { ...ctl.provider.query(params), steer };
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		vi.mocked(dbMock.appendMessage).mockRejectedValueOnce(
			new Error("transcript write failed"),
		);

		await expect(
			sm.steerActiveTurn(
				"Accepted once",
				() => {},
				"sess-1",
				"delegation-steer-persist-failure",
				"coordinator",
			),
		).rejects.toThrow(
			"Do not retry this instruction automatically because that may duplicate it",
		);
		expect(steer).toHaveBeenCalledTimes(1);

		ctl.turns[0].resolveDone();
		await first;
	});

	it("folds a plain queued message into the active turn without another send", async () => {
		const ctl = makeControllableProvider();
		const steer = vi.fn().mockResolvedValue(undefined);
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				return { ...ctl.provider.query(params), steer };
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		expect(sm.getStatus()).toMatchObject({
			state: "running",
			turn_id: "turn-1",
		});
		const second = sm.runQuery("second", () => {}, {
			inputOrigin: "human",
			sessionId: "sess-1",
			turnId: "turn-2",
		});

		expect(sm.getQueueState().pending_turns).toEqual([
			expect.objectContaining({ id: "turn-2", steerable: true }),
		]);
		await expect(sm.steerQueued("turn-2")).resolves.toMatchObject({
			targetTurnId: "turn-1",
			steerSeq: expect.any(Number),
			steerToolEventIndex: 0,
		});
		expect(steer).toHaveBeenCalledWith("test prompt", {
			inputOrigin: "human",
		});
		expect(sm.getQueueState().pending_turn_ids).toEqual([]);
		await second;

		ctl.turns[0].resolveDone();
		await first;
		expect(ctl.getSendCount()).toBe(1);
	});

	it("settles an accepted queued turn when transcript persistence fails", async () => {
		const ctl = makeControllableProvider();
		const steer = vi.fn().mockResolvedValue(undefined);
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				return { ...ctl.provider.query(params), steer };
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const second = sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-2",
		});
		vi.mocked(dbMock.appendMessage).mockRejectedValueOnce(
			new Error("transcript write failed"),
		);

		await expect(sm.steerQueued("turn-2")).rejects.toThrow(
			"provider accepted the steering instruction, but Hlid could not persist",
		);
		await expect(second).resolves.toBeUndefined();
		expect(sm.getQueueState().pending_turn_ids).toEqual([]);
		expect(steer).toHaveBeenCalledTimes(1);

		ctl.turns[0].resolveDone();
		await first;
		expect(ctl.getSendCount()).toBe(1);
	});

	it("persists which in-flight assistant row an accepted prompt steered", async () => {
		const ctl = makeControllableProvider();
		const steer = vi.fn().mockResolvedValue(undefined);
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				return { ...ctl.provider.query(params), steer };
			},
		};
		vi.mocked(dbMock.appendMessage).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		ctl.pushEvent({ type: "text_delta", text: "partial response" });
		await waitFor(() =>
			expect(dbMock.appendMessage).toHaveBeenCalledWith(
				"sess-1",
				1,
				"assistant",
				"",
			),
		);

		const second = sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-2",
		});
		await expect(sm.steerQueued("turn-2")).resolves.toMatchObject({
			targetTurnId: "turn-1",
			targetAssistantSeq: 1,
			steerSeq: 2,
			steerToolEventIndex: 0,
		});

		expect(dbMock.appendMessage).toHaveBeenCalledWith(
			"sess-1",
			2,
			"user",
			"second",
			"turn-2",
			1,
			expect.stringContaining('"delivery":"steer"'),
			0,
		);
		await second;
		ctl.turns[0].resolveDone();
		await first;
	});

	it("persists the raw tool-event boundary at provider acceptance", async () => {
		const ctl = makeControllableProvider();
		let acceptSteer: (() => void) | undefined;
		const steer = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					acceptSteer = resolve;
				}),
		);
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				return { ...ctl.provider.query(params), steer };
			},
		};
		vi.mocked(dbMock.appendMessage).mockClear();
		vi.mocked(dbMock.appendToolEvent).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		ctl.pushEvent({
			type: "tool_start",
			toolId: "before-1",
			name: "Read",
			input: { path: "one" },
		});
		await waitFor(() =>
			expect(dbMock.appendToolEvent).toHaveBeenCalledWith(
				"sess-1",
				1,
				"before-1",
				"Read",
				{ path: "one" },
				undefined,
				expect.objectContaining({ providerId: "claude" }),
			),
		);

		const second = sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-2",
		});
		const steering = sm.steerQueued("turn-2");
		await waitFor(() => expect(steer).toHaveBeenCalledOnce());
		ctl.pushEvent({
			type: "tool_start",
			toolId: "before-2",
			name: "Read",
			input: { path: "two" },
		});
		await waitFor(() =>
			expect(dbMock.appendToolEvent).toHaveBeenCalledWith(
				"sess-1",
				1,
				"before-2",
				"Read",
				{ path: "two" },
				undefined,
				expect.objectContaining({ providerId: "claude" }),
			),
		);

		acceptSteer?.();
		await expect(steering).resolves.toMatchObject({
			targetTurnId: "turn-1",
			targetAssistantSeq: 1,
			steerSeq: 2,
			steerToolEventIndex: 2,
		});
		expect(dbMock.appendMessage).toHaveBeenCalledWith(
			"sess-1",
			2,
			"user",
			"second",
			"turn-2",
			1,
			expect.stringContaining('"delivery":"steer"'),
			2,
		);
		await second;
		ctl.turns[0].resolveDone();
		await first;
	});

	it("reserves a durable assistant row before persisting an early steer", async () => {
		const ctl = makeControllableProvider();
		const steer = vi.fn().mockResolvedValue(undefined);
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				return { ...ctl.provider.query(params), steer };
			},
		};
		vi.mocked(dbMock.appendMessage).mockClear();
		vi.mocked(dbMock.setMessageSteerTargetSeq).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const second = sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-2",
		});

		await expect(sm.steerQueued("turn-2")).resolves.toEqual({
			targetTurnId: "turn-1",
			targetAssistantSeq: 1,
			steerSeq: 2,
			steerToolEventIndex: 0,
		});
		expect(dbMock.appendMessage).toHaveBeenCalledWith(
			"sess-1",
			1,
			"assistant",
			"",
		);
		expect(dbMock.appendMessage).toHaveBeenCalledWith(
			"sess-1",
			2,
			"user",
			"second",
			"turn-2",
			1,
			expect.stringContaining('"delivery":"steer"'),
			0,
		);
		expect(dbMock.setMessageSteerTargetSeq).not.toHaveBeenCalled();
		const assistantCall = vi
			.mocked(dbMock.appendMessage)
			.mock.calls.findIndex((call) => call[1] === 1);
		const steerCall = vi
			.mocked(dbMock.appendMessage)
			.mock.calls.findIndex((call) => call[1] === 2);
		expect(assistantCall).toBeGreaterThanOrEqual(0);
		expect(steerCall).toBeGreaterThan(assistantCall);

		await second;
		ctl.turns[0].resolveDone();
		await first;
		expect(dbMock.setMessageSteerTargetSeq).not.toHaveBeenCalled();
	});

	it("retains the target assistant when done races ahead of steer persistence", async () => {
		const ctl = makeControllableProvider();
		let acceptSteer: (() => void) | undefined;
		const steer = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					acceptSteer = resolve;
				}),
		);
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				return { ...ctl.provider.query(params), steer };
			},
		};
		vi.mocked(dbMock.appendMessage).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		ctl.pushEvent({ type: "text_delta", text: "partial response" });
		await waitFor(() =>
			expect(dbMock.appendMessage).toHaveBeenCalledWith(
				"sess-1",
				1,
				"assistant",
				"",
			),
		);

		const second = sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-2",
		});
		const steering = sm.steerQueued("turn-2");
		await waitFor(() => expect(steer).toHaveBeenCalledOnce());

		ctl.turns[0].resolveDone();
		await first;
		acceptSteer?.();
		await expect(steering).resolves.toMatchObject({
			targetTurnId: "turn-1",
			targetAssistantSeq: 1,
			steerSeq: 2,
			steerToolEventIndex: 0,
		});
		await second;

		expect(dbMock.appendMessage).toHaveBeenCalledWith(
			"sess-1",
			2,
			"user",
			"second",
			"turn-2",
			1,
			expect.stringContaining('"delivery":"steer"'),
			0,
		);
	});

	it("restores the queued turn when the provider rejects steering", async () => {
		const ctl = makeControllableProvider();
		const steer = vi.fn().mockRejectedValue(new Error("not steerable"));
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				return { ...ctl.provider.query(params), steer };
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const second = sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-2",
		});

		await expect(sm.steerQueued("turn-2")).rejects.toThrow("not steerable");
		expect(sm.getQueueState().pending_turn_ids).toEqual(["turn-2"]);
		ctl.turns[0].resolveDone();
		await first;
		await waitFor(() => expect(ctl.getSendCount()).toBe(2));
		ctl.turns[1].resolveDone();
		await second;
	});

	it("marks attachment turns as not steerable", async () => {
		const ctl = makeControllableProvider();
		const wrapped: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				return {
					...ctl.provider.query(params),
					steer: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(wrapped));
		const first = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const second = sm.runQuery("with file", () => {}, {
			sessionId: "sess-1",
			attachments: [
				{
					id: "attachment-1",
					filename: "notes.txt",
					mime: "text/plain",
					path: "/tmp/notes.txt",
					kind: "file",
				},
			],
			turnId: "turn-2",
		});

		expect(sm.getQueueState().pending_turns).toEqual([
			expect.objectContaining({ id: "turn-2", steerable: false }),
		]);
		await expect(sm.steerQueued("turn-2")).rejects.toThrow("file attachments");
		expect(sm.cancelQueued("turn-2")).toBe(true);
		await second;
		ctl.turns[0].resolveDone();
		await first;
		expect(ctl.getSendCount()).toBe(1);
	});

	it("exposes only validated current-turn selections for explicit delegation handoff", async () => {
		const ctl = makeControllableProvider();
		vi.mocked(buildPromptAsync).mockResolvedValueOnce({
			prompt: "test prompt",
			safeSkillContexts: ["/vault/skills/review/SKILL.md"],
			safeAttachments: [
				{
					id: "relic-1",
					path: "/artifacts/client-claimed-report.html",
					filename: "client-claimed-report.html",
					mime: "text/plain",
					kind: "ephemeral",
					reference: "relic",
				},
				{
					id: "upload-1",
					path: "/artifacts/upload.txt",
					filename: "upload.txt",
					mime: "text/plain",
					kind: "ephemeral",
				},
				{
					id: "spoofed-relic",
					path: "/artifacts/spoofed.html",
					filename: "spoofed.html",
					mime: "text/html",
					kind: "vault",
					reference: "relic",
				},
			],
			resourcePaths: [],
			safeVaultReferences: [
				{ relativePath: "Plans/Exact.md", path: "/vault/Plans/Exact.md" },
			],
			safeWorkspaceReferences: [
				{
					relativePath: "src/exact.ts",
					sha256: "abc123",
					path: "/work/project/src/exact.ts",
					sizeBytes: 100,
					mime: "text/typescript",
					environment: "host",
					environmentLabel: "Host",
					previewKind: "text",
				},
			],
			contextManifest: testPromptContextManifest(),
		});
		vi.mocked(dbMock.getAttachment)
			.mockResolvedValueOnce({
				id: "relic-1",
				session_id: "source-session",
				message_seq: 4,
				kind: "vault",
				filename: "durable-report.html",
				path: "/library/durable-report.html",
				mime: "text/html",
				size_bytes: 100,
				sha256: "a".repeat(64),
				created_at: 1,
				retention: "retained",
			})
			.mockResolvedValueOnce({
				id: "spoofed-relic",
				session_id: "sess-handoff",
				message_seq: 0,
				kind: "ephemeral",
				filename: "spoofed.html",
				path: "/artifacts/spoofed.html",
				mime: "text/html",
				size_bytes: 100,
				sha256: "b".repeat(64),
				created_at: 1,
				retention: "session",
			});
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		expect(sm.getCurrentDelegationHandoff()).toBeNull();

		const run = sm.runQuery("parent task", () => {}, {
			sessionId: "sess-handoff",
			skillContexts: ["/vault/skills/review/SKILL.md"],
			attachments: [],
			turnId: "turn-handoff",
			vaultReferences: ["Plans/Exact.md"],
			workspaceReferences: [{ relativePath: "src/exact.ts", sha256: "abc123" }],
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));

		expect(sm.getCurrentDelegationHandoff()).toEqual({
			skillContexts: ["/vault/skills/review/SKILL.md"],
			relics: [
				{
					id: "relic-1",
					path: "/library/durable-report.html",
					filename: "durable-report.html",
					mime: "text/html",
					kind: "vault",
					reference: "relic",
				},
			],
			vaultReferences: ["Plans/Exact.md"],
			workspaceReferences: [{ relativePath: "src/exact.ts", sha256: "abc123" }],
			currentAssistantSequence: null,
		});
		expect(dbMock.getAttachment).toHaveBeenCalledWith("relic-1");
		expect(dbMock.getAttachment).toHaveBeenCalledWith("spoofed-relic");
		ctl.turns[0].resolveDone();
		await run;
		expect(sm.getCurrentDelegationHandoff()).toBeNull();
	});

	it("updates the handoff exclusion cursor when partial assistant output starts streaming", async () => {
		const ctl = makeControllableProvider();
		vi.mocked(dbMock.appendMessage).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		const run = sm.runQuery("parent task", () => {}, {
			sessionId: "sess-partial-handoff",
			turnId: "turn-partial-handoff",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		expect(
			sm.getCurrentDelegationHandoff()?.currentAssistantSequence,
		).toBeNull();

		ctl.pushEvent({ type: "text_delta", text: "incomplete assistant work" });
		await waitFor(() =>
			expect(dbMock.appendMessage).toHaveBeenCalledWith(
				"sess-partial-handoff",
				1,
				"assistant",
				"",
			),
		);
		expect(sm.getCurrentDelegationHandoff()?.currentAssistantSequence).toBe(1);

		ctl.turns[0].resolveDone();
		await run;
		expect(sm.getCurrentDelegationHandoff()).toBeNull();
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

		const t1 = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-2",
		});
		const t3 = sm.runQuery("third", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-3",
		});
		expect(sm.getQueueState()).toMatchObject({
			pending_turn_ids: ["turn-2", "turn-3"],
			pending_turns: [
				{ id: "turn-2", text: "second", session_id: "sess-1" },
				{ id: "turn-3", text: "third", session_id: "sess-1" },
			],
			running_turn_id: "turn-1",
		});

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

		const t1 = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
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

		const t1 = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-2",
		});
		const t3 = sm.runQuery("third", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-3",
		});

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

		const t1 = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-2",
		});
		const t3 = sm.runQuery("third", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-3",
		});

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

		const t1 = sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-1",
		});
		await waitFor(() => expect(ctl.getSendCount()).toBe(1));
		const t2 = sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-2",
		});
		const t3 = sm.runQuery("third", () => {}, {
			sessionId: "sess-1",
			turnId: "turn-3",
		});
		expect(sm.promoteQueued("turn-3")).toBe(true);

		sm.abort();
		// Drain the running turn so Promise.allSettled resolves.
		ctl.turns[0].resolveDone();

		await Promise.allSettled([t1, t2, t3]);
		// Queue was cleared by abort — turn-2 and turn-3 never ran.
		expect(ctl.getSendCount()).toBe(1);
	});
});

describe("SessionManager — Slice B AgentSession reuse", () => {
	it("two consecutive runQuery calls in same chat reuse one provider.query()", async () => {
		const ctl = makeLongLivedProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		await sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
		});
		await sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
		});

		expect(ctl.getQueryCallCount()).toBe(1);
		ctl.closeStream();
	});

	it("reuses the provider runtime when config sync restores the vault path", async () => {
		const config = makeConfig();
		const ctl = makeLongLivedProvider();
		try {
			const sm = new SessionManager(
				config,
				makeProviders(ctl.provider),
				config.vault.path,
			);

			await sm.runQuery("first", () => {}, {
				sessionId: "sess-vault-alias",
			});
			expect(sm.getAgentCwd()).toBeUndefined();
			sm.syncConfig(config);
			expect(sm.getAgentCwd()).toBe(config.vault.path);
			await sm.runQuery("second", () => {}, {
				sessionId: "sess-vault-alias",
			});

			expect(ctl.getQueryCallCount()).toBe(1);
		} finally {
			ctl.closeStream();
		}
	});

	it("rebuilds the provider runtime when the restored vault path has agent settings", async () => {
		const config = makeConfig();
		config.agents = [
			{
				path: config.vault.path,
				mode: "cwd",
				provider: "claude",
				model: "agent-specific-model",
			},
		];
		const ctl = makeLongLivedProvider();
		try {
			const sm = new SessionManager(
				config,
				makeProviders(ctl.provider),
				config.vault.path,
			);

			await sm.runQuery("first", () => {}, {
				sessionId: "sess-vault-agent",
			});
			sm.syncConfig(config);
			await sm.runQuery("second", () => {}, {
				sessionId: "sess-vault-agent",
			});

			expect(ctl.getQueryCallCount()).toBe(2);
		} finally {
			ctl.closeStream();
		}
	});

	it("switching to a different sessionId rebuilds the AgentSession", async () => {
		const ctl = makeLongLivedProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		await sm.runQuery("first", () => {}, {
			sessionId: "sess-A",
		});
		await sm.runQuery("second", () => {}, {
			sessionId: "sess-B",
		});

		expect(ctl.getQueryCallCount()).toBe(2);
		ctl.closeStream();
	});

	it("abort tears down the cached AgentSession", async () => {
		const ctl = makeLongLivedProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));

		await sm.runQuery("first", () => {}, {
			sessionId: "sess-1",
		});
		sm.abort();
		await sm.runQuery("second", () => {}, {
			sessionId: "sess-1",
		});

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

		await sm.runQuery("first", (m) => events1.push(m), {
			sessionId: "sess-1",
		});
		expect(events1.some((m) => m.type === "done")).toBe(true);
		expect(generatorReturnCalled).toBe(0);

		// CRITICAL: turn 2 must receive its own done event. With a naive
		// [Symbol.asyncIterator] that returns the raw AsyncGenerator,
		// for-await's exit closes it and turn 2 hangs.
		await Promise.race([
			sm.runQuery("second", (m) => events2.push(m), {
				sessionId: "sess-1",
			}),
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
		await sm.runQuery("hello world", () => {}, {
			inputOrigin: "human",
			sessionId: "sess-1",
		});
		const lastSendSpy = sendSpies[0];
		expect(lastSendSpy).not.toBeNull();
		if (!lastSendSpy) throw new Error("send spy was never assigned");
		expect(lastSendSpy).toHaveBeenCalledTimes(1);
		const sentArg = lastSendSpy.mock.calls[0][0] as string;
		// buildPromptAsync is mocked at module level to return "test prompt", which
		// SessionManager forwards verbatim to agentSession.send().
		expect(sentArg).toBe("test prompt");
		expect(lastSendSpy.mock.calls[0][1]).toEqual({
			inputOrigin: "human",
		});
		ctl.closeStream();
	});

	it("persists only the structured content accepted by an ACP provider", async () => {
		const structuredContent = [
			{
				type: "image" as const,
				data: "AQID",
				mimeType: "image/png",
			},
			{
				type: "resource" as const,
				uri: "hlid://vault-reference/Selected.md",
				mimeType: "text/markdown",
				text: "selected content",
			},
		];
		vi.mocked(buildPromptAsync).mockResolvedValueOnce({
			prompt: "review selection",
			safeAttachments: [],
			resourcePaths: [],
			safeVaultReferences: [],
			safeWorkspaceReferences: [],
			structuredContent,
			contextManifest: {
				...testPromptContextManifest(),
				structuredPrompt: {
					imageCount: 99,
					imageDecodedBytes: 99,
					embeddedResourceCount: 99,
					embeddedResourceChars: 99,
				},
			},
		});
		const ctl = makeLongLivedProvider();
		let sendSpy: ReturnType<typeof vi.fn> | undefined;
		const appendCallCount = vi.mocked(dbMock.appendMessage).mock.calls.length;
		const replaceCallCount = vi.mocked(dbMock.replaceUserMessageContextManifest)
			.mock.calls.length;
		const provider: AgentProvider = {
			providerId: "acp:fake",
			query(params: AgentQueryParams): AgentSession {
				const session = ctl.provider.query(params);
				const send = session.send.bind(session);
				const acceptedSend = vi.fn(
					async (message: string, options?: SendOptions) => {
						await options?.onStructuredContentAccepted?.(structuredContent);
						await send(message, options);
					},
				);
				sendSpy = acceptedSend;
				return { ...session, send: acceptedSend };
			},
		};
		const sm = new SessionManager(
			{ ...makeConfig(), vault_provider: "acp:fake" } as HlidConfig,
			makeProviders(provider),
		);

		await sm.runQuery("review selection", () => {}, {
			inputOrigin: "human",
			sessionId: "structured-acp-session",
		});

		expect(sendSpy).toHaveBeenCalledWith(
			"review selection",
			expect.objectContaining({
				inputOrigin: "human",
				structuredContent,
				onStructuredContentAccepted: expect.any(Function),
			}),
		);
		const userAppend = vi
			.mocked(dbMock.appendMessage)
			.mock.calls.slice(appendCallCount)
			.find(
				(call) => call[0] === "structured-acp-session" && call[2] === "user",
			);
		if (!userAppend) throw new Error("persisted user receipt was not captured");
		const initialJson = userAppend[6];
		expect(initialJson).toBeTypeOf("string");
		expect(JSON.parse(initialJson as string).structuredPrompt).toBeUndefined();
		const replacement = vi
			.mocked(dbMock.replaceUserMessageContextManifest)
			.mock.calls.slice(replaceCallCount);
		expect(replacement).toHaveLength(1);
		expect(replacement[0]?.slice(0, 3)).toEqual([
			"structured-acp-session",
			0,
			initialJson,
		]);
		expect(JSON.parse(replacement[0]?.[3] ?? "{}").structuredPrompt).toEqual({
			imageCount: 1,
			imageDecodedBytes: 3,
			embeddedResourceCount: 1,
			embeddedResourceChars: "selected content".length,
		});
		ctl.closeStream();
	});

	it("keeps the initial receipt when ACP gates off every structured block", async () => {
		const structuredContent = [
			{ type: "image" as const, data: "AQID", mimeType: "image/png" },
		];
		vi.mocked(buildPromptAsync).mockResolvedValueOnce({
			prompt: "review selection",
			safeAttachments: [],
			resourcePaths: [],
			safeVaultReferences: [],
			safeWorkspaceReferences: [],
			structuredContent,
			contextManifest: testPromptContextManifest(),
		});
		const ctl = makeLongLivedProvider();
		const replaceCallCount = vi.mocked(dbMock.replaceUserMessageContextManifest)
			.mock.calls.length;
		const provider: AgentProvider = {
			providerId: "acp:fake",
			query(params: AgentQueryParams): AgentSession {
				const session = ctl.provider.query(params);
				const send = session.send.bind(session);
				return {
					...session,
					send: async (message, options) => {
						await options?.onStructuredContentAccepted?.([]);
						await send(message, options);
					},
				};
			},
		};
		const sm = new SessionManager(
			{ ...makeConfig(), vault_provider: "acp:fake" } as HlidConfig,
			makeProviders(provider),
		);

		await sm.runQuery("review selection", () => {}, {
			sessionId: "gated-acp-session",
		});

		expect(
			vi
				.mocked(dbMock.replaceUserMessageContextManifest)
				.mock.calls.slice(replaceCallCount),
		).toEqual([]);
		ctl.closeStream();
	});

	it.each([
		{
			label: "a scheduled Routine",
			options: { inputOrigin: "scheduled-task" as const },
			expected: "scheduled-task",
		},
		{
			label: "an Hlid delegation",
			options: {
				inputOrigin: "coordinator" as const,
				backgroundSession: true,
			},
			expected: "coordinator",
		},
		{
			label: "generic background work",
			options: { backgroundSession: true },
			expected: "unclassified",
		},
	])("captures $label provenance before provider send", async ({
		options,
		expected,
	}) => {
		const ctl = makeLongLivedProvider();
		let sendSpy: ReturnType<typeof vi.fn> | undefined;
		const provider: AgentProvider = {
			providerId: "claude",
			query(params: AgentQueryParams): AgentSession {
				const session = ctl.provider.query(params);
				sendSpy = session.send as ReturnType<typeof vi.fn>;
				return session;
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("classified input", () => {}, {
			...options,
			sessionId: `origin-${expected}`,
		});

		expect(sendSpy).toHaveBeenCalledWith("test prompt", {
			inputOrigin: expected,
		});
		ctl.closeStream();
	});

	it("passes managed audio attachments to a native Codex turn", async () => {
		const attachment = {
			id: "voice-1",
			path: "/tmp/hlid-test-vault/voice-message.wav",
			filename: "voice-message.wav",
			mime: "audio/wav",
			kind: "ephemeral",
		};
		vi.mocked(buildPromptAsync).mockResolvedValueOnce({
			prompt: "Voice message",
			safeAttachments: [attachment],
			resourcePaths: [attachment.path],
			safeVaultReferences: [],
			safeWorkspaceReferences: [],
			contextManifest: testPromptContextManifest(),
		});
		const ctl = makeLongLivedProvider();
		let sendSpy: ReturnType<typeof vi.fn> | undefined;
		const provider: AgentProvider = {
			providerId: "codex",
			query(p: AgentQueryParams): AgentSession {
				const session = ctl.provider.query(p);
				sendSpy = session.send as ReturnType<typeof vi.fn>;
				return session;
			},
		};
		const sm = new SessionManager(
			{ ...makeConfig(), vault_provider: "codex" } as HlidConfig,
			makeProviders(provider),
		);

		await sm.runQuery("Voice message", () => {}, {
			inputOrigin: "human",
			sessionId: "voice-session",
			attachments: [attachment],
		});

		expect(sendSpy).toHaveBeenCalledWith("Voice message", {
			inputOrigin: "human",
			audioPaths: [attachment.path],
		});
		expect(vi.mocked(buildPromptAsync).mock.calls.at(-1)?.[0]).toMatchObject({
			nativeAudio: true,
		});
		ctl.closeStream();
	});
});

describe("SessionManager — Claude peer inbox", () => {
	it("persists an idle approval before releasing the peer into a dedicated default-mode turn", async () => {
		let resolveDecisionPersistence!: () => void;
		const decisionPersistence = new Promise<void>((resolve) => {
			resolveDecisionPersistence = resolve;
		});
		vi.mocked(dbMock.appendAskUserQuestion).mockClear();
		vi.mocked(dbMock.appendAskUserQuestion).mockResolvedValue(undefined);
		vi.mocked(dbMock.setAskUserQuestionResolution).mockClear();
		vi.mocked(dbMock.setAskUserQuestionResolution).mockImplementationOnce(
			() => decisionPersistence,
		);
		vi.mocked(dbMock.setAskUserQuestionProvenance).mockClear();
		vi.mocked(dbMock.appendMessage).mockClear();
		const ctl = makePeerInboxHarness();
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(
			peerInboxConfig("bypassPermissions"),
			makeProviders(ctl.provider),
		);

		const first = sm.runQuery(
			"human turn",
			(message) => emitted.push(message),
			{
				sessionId: "peer-session",
				turnId: "human-turn-1",
			},
		);
		await waitFor(() => expect(ctl.send).toHaveBeenCalledTimes(1));
		ctl.pushEvent(peerDoneEvent());
		await first;
		ctl.setPermissionMode.mockClear();
		vi.mocked(dbMock.appendMessage).mockClear();

		const params = ctl.getParams();
		expect(params.claudeCrossSessionInbound).toBe("hold");
		const handlers = createClaudeHostInteractionHandlers(params);
		const dialog = handlers.onUserDialog(
			{
				dialogKind: "peer_inbound_approval",
				toolUseID: "native-peer-1",
				payload: {
					preview: "Please inspect the failing queue test",
					fromAddress: "peer-release",
					claimedName: "Release helper",
					verifiedPeerPid: 7312,
					holdCause: "explicit-setting",
				},
			},
			{
				signal: new AbortController().signal,
				requestId: "control-native-peer-1",
			},
		);
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);
		const pending = sm.getPendingAskUserQuestions()[0];
		if (!pending) throw new Error("peer approval was not registered");
		expect(pending.provenance).not.toHaveProperty("turn_id");
		const question = pending.questions[0]?.question;
		if (!question) throw new Error("peer approval question was missing");
		const acceptedResponse = sm.handleAskUserQuestionResponse(pending.id, {
			[question]: ["Deliver to Claude"],
		});
		await waitFor(() =>
			expect(dbMock.setAskUserQuestionResolution).toHaveBeenCalledTimes(1),
		);
		await expect(
			sm.handleAskUserQuestionResponse(pending.id, {
				[question]: ["Deny"],
			}),
		).resolves.toBe(false);
		expect(ctl.setPermissionMode).not.toHaveBeenCalled();
		resolveDecisionPersistence();
		await expect(acceptedResponse).resolves.toBe(true);

		await expect(dialog).resolves.toEqual({
			behavior: "completed",
			result: { behavior: "approve" },
		});
		expect(dbMock.setAskUserQuestionResolution).toHaveBeenCalledWith(
			"peer-session",
			pending.id,
			JSON.stringify({ [question]: ["Deliver to Claude"] }),
			null,
		);
		expect(ctl.setPermissionMode).toHaveBeenCalledWith("default");
		expect(ctl.send).toHaveBeenCalledTimes(1);

		const exactBody =
			"Please inspect the failing queue test in session.queueing.test.ts";
		ctl.pushEvent({
			type: "provider_history_warning",
			code: "history_mirror_failed",
			reason: "timeout",
			providerSessionId: "sdk-peer-session",
			providerEventId: "33333333-3333-4333-8333-333333333333",
			scope: "main",
		});
		ctl.pushEvent({
			type: "provider_peer_message",
			body: exactBody,
			fromAddress: "peer-release",
			claimedName: "Release helper",
			fromSession: "native-sender-session",
			verifiedPeerPid: 7312,
		});
		ctl.pushEvent({ type: "text_delta", text: "Peer work complete." });
		ctl.pushEvent(peerDoneEvent());
		await waitFor(() => expect(sm.getStatus().state).toBe("idle"));

		expect(dbMock.setAskUserQuestionProvenance).toHaveBeenCalledWith(
			"peer-session",
			pending.id,
			expect.stringContaining(exactBody),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "ask_user_question_provenance_updated",
				id: pending.id,
				provenance: expect.objectContaining({
					peer: expect.objectContaining({
						body: exactBody,
						from_session: "native-sender-session",
					}),
				}),
			}),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "local_command_output",
				content: expect.stringContaining(
					"future claude resume or fork history may be incomplete",
				),
			}),
		);
		expect(
			vi
				.mocked(dbMock.appendMessage)
				.mock.calls.some(
					(call) => call[2] === "user" && String(call[3]).includes(exactBody),
				),
		).toBe(false);
		expect(ctl.setPermissionMode.mock.calls.at(-1)?.[0]).toBe(
			"bypassPermissions",
		);
		sm.abort();
	});

	it("runs an approved active-turn peer before a queued human without interrupting either", async () => {
		vi.mocked(dbMock.appendAskUserQuestion).mockResolvedValue(undefined);
		vi.mocked(dbMock.setAskUserQuestionResolution).mockResolvedValue(undefined);
		vi.mocked(dbMock.appendMessage).mockClear();
		const ctl = makePeerInboxHarness();
		const sm = new SessionManager(
			peerInboxConfig(),
			makeProviders(ctl.provider),
		);
		const first = sm.runQuery("first human", () => {}, {
			sessionId: "peer-priority-session",
			turnId: "human-turn-1",
		});
		await waitFor(() => expect(ctl.send).toHaveBeenCalledTimes(1));

		const handlers = createClaudeHostInteractionHandlers(ctl.getParams());
		let dialogSettled = false;
		const dialog = handlers
			.onUserDialog(
				{
					dialogKind: "peer_inbound_approval",
					toolUseID: "native-peer-2",
					payload: {
						preview: "Run before the queued follow-up",
						fromAddress: "peer-priority",
						holdCause: "mode-mismatch",
					},
				},
				{
					signal: new AbortController().signal,
					requestId: "control-native-peer-2",
				},
			)
			.then((result) => {
				dialogSettled = true;
				return result;
			});
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);
		const pending = sm.getPendingAskUserQuestions()[0];
		if (!pending) throw new Error("peer approval was not registered");
		expect(pending.provenance).not.toHaveProperty("turn_id");
		const question = pending.questions[0]?.question;
		if (!question) throw new Error("peer approval question was missing");
		await sm.handleAskUserQuestionResponse(pending.id, {
			[question]: ["Deliver to Claude"],
		});
		const second = sm.runQuery("second human", () => {}, {
			sessionId: "peer-priority-session",
			turnId: "human-turn-2",
		});
		await Promise.resolve();
		expect(dialogSettled).toBe(false);
		expect(ctl.send).toHaveBeenCalledTimes(1);

		ctl.pushEvent(peerDoneEvent());
		await expect(dialog).resolves.toEqual({
			behavior: "completed",
			result: { behavior: "approve" },
		});
		expect(ctl.send).toHaveBeenCalledTimes(1);
		expect(sm.promoteQueued("human-turn-2")).toBe(true);
		expect(ctl.interrupt).not.toHaveBeenCalled();
		ctl.pushEvent({
			type: "provider_peer_message",
			body: "Run before the queued follow-up",
			fromAddress: "peer-priority",
		});
		ctl.pushEvent({ type: "text_delta", text: "Peer response." });
		ctl.pushEvent(peerDoneEvent());
		await waitFor(() => expect(ctl.send).toHaveBeenCalledTimes(2));
		ctl.pushEvent(peerDoneEvent());
		await Promise.all([first, second]);

		const persistedUserMessages = vi
			.mocked(dbMock.appendMessage)
			.mock.calls.filter((call) => call[2] === "user");
		expect(persistedUserMessages).toHaveLength(2);
		expect(
			persistedUserMessages.some((call) =>
				String(call[3]).includes("Run before the queued follow-up"),
			),
		).toBe(false);
		sm.abort();
	});

	it("cancels a not-yet-released peer continuation when the inbox is disabled", async () => {
		vi.mocked(dbMock.appendAskUserQuestion).mockResolvedValue(undefined);
		vi.mocked(dbMock.setAskUserQuestionResolution).mockResolvedValue(undefined);
		const ctl = makePeerInboxHarness();
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(
			peerInboxConfig(),
			makeProviders(ctl.provider),
		);
		await establishIdlePeerSession(sm, ctl, (message) => emitted.push(message));
		ctl.setPermissionMode.mockClear();
		let releaseModeChange!: () => void;
		ctl.setPermissionMode.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseModeChange = resolve;
				}),
		);

		const handlers = createClaudeHostInteractionHandlers(ctl.getParams());
		const dialog = handlers.onUserDialog(
			{
				dialogKind: "peer_inbound_approval",
				toolUseID: "native-peer-disabled",
				payload: {
					preview: "Do not release after opt-out",
					holdCause: "explicit-setting",
				},
			},
			{
				signal: new AbortController().signal,
				requestId: "control-native-peer-disabled",
			},
		);
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);
		const pending = sm.getPendingAskUserQuestions()[0];
		const question = pending?.questions[0]?.question;
		if (!pending || !question) throw new Error("peer approval was missing");
		await sm.handleAskUserQuestionResponse(pending.id, {
			[question]: ["Deliver to Claude"],
		});
		await waitFor(() => expect(ctl.setPermissionMode).toHaveBeenCalledTimes(1));

		const disabled = peerInboxConfig();
		disabled.claude.peer_inbox = false;
		sm.syncConfig(disabled);
		await expect(dialog).resolves.toEqual({ behavior: "cancelled" });
		releaseModeChange();
		await waitFor(() => expect(sm.getStatus().state).toBe("idle"));
		expect(ctl.cancel).toHaveBeenCalled();
		expect(emitted.some((message) => message.type === "error")).toBe(false);
		sm.abort();
	});

	it("reconciles a rejected current permission restore after a peer continuation", async () => {
		const ctl = makePeerInboxHarness();
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(
			peerInboxConfig("bypassPermissions"),
			makeProviders(ctl.provider),
		);
		await establishIdlePeerSession(sm, ctl, (message) => emitted.push(message));
		ctl.setPermissionMode.mockClear();
		ctl.setPermissionMode.mockImplementation(async (mode) => {
			if (mode === "bypassPermissions") {
				throw new Error("native restore rejected");
			}
		});

		const acquire = ctl.getParams().onProviderInitiatedTurn;
		if (!acquire) throw new Error("peer continuation callback was missing");
		const ready = acquire({
			kind: "claude_peer_message",
			interactionId: "peer-current-restore",
			sourceName: "Claude peer",
			preview: "current restore rejection",
		});
		await expect(ready).resolves.toBe(true);
		ctl.pushEvent({
			type: "provider_peer_message",
			body: "current restore rejection",
			fromAddress: "peer-current",
		});
		ctl.pushEvent(peerDoneEvent());
		await waitFor(() => expect(sm.getStatus().state).toBe("idle"));

		expect(sm.getStatus().permission_mode).toBe("default");
		expect(dbMock.setSessionPermissionMode).toHaveBeenCalledWith(
			"peer-session",
			"default",
			expect.objectContaining({ guard: expect.any(Function) }),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "session_control_rejected",
				control: "permission_mode",
				attempted_value: "bypassPermissions",
				authoritative_value: "default",
			}),
		);
		sm.abort();
	});

	it("retries the latest permission when an older peer restore rejects", async () => {
		const ctl = makePeerInboxHarness();
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(
			peerInboxConfig("bypassPermissions"),
			makeProviders(ctl.provider),
		);
		await establishIdlePeerSession(sm, ctl, (message) => emitted.push(message));
		ctl.setPermissionMode.mockClear();
		let rejectOldRestore!: (error: Error) => void;
		ctl.setPermissionMode.mockImplementation((mode) => {
			if (mode !== "bypassPermissions") return Promise.resolve();
			return new Promise<void>((_resolve, reject) => {
				rejectOldRestore = reject;
			});
		});

		const acquire = ctl.getParams().onProviderInitiatedTurn;
		if (!acquire) throw new Error("peer continuation callback was missing");
		await expect(
			acquire({
				kind: "claude_peer_message",
				interactionId: "peer-stale-restore",
				sourceName: "Claude peer",
				preview: "stale restore rejection",
			}),
		).resolves.toBe(true);
		ctl.pushEvent({
			type: "provider_peer_message",
			body: "stale restore rejection",
			fromAddress: "peer-stale",
		});
		ctl.pushEvent(peerDoneEvent());
		await waitFor(() =>
			expect(ctl.setPermissionMode).toHaveBeenCalledWith("bypassPermissions"),
		);

		await sm.setPermissionMode("acceptEdits");
		rejectOldRestore(new Error("old restore rejected"));
		await waitFor(() => expect(sm.getStatus().state).toBe("idle"));

		expect(ctl.setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
			"default",
			"bypassPermissions",
			"acceptEdits",
		]);
		expect(sm.getStatus().permission_mode).toBe("acceptEdits");
		expect(
			emitted.some(
				(message) =>
					message.type === "session_control_rejected" &&
					message.control === "permission_mode",
			),
		).toBe(false);
		sm.abort();
	});

	it("retires the attached consumer when the provider cancels before release", async () => {
		vi.mocked(dbMock.appendAskUserQuestion).mockResolvedValue(undefined);
		vi.mocked(dbMock.setAskUserQuestionResolution).mockResolvedValue(undefined);
		const ctl = makePeerInboxHarness();
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(
			peerInboxConfig(),
			makeProviders(ctl.provider),
		);
		await establishIdlePeerSession(sm, ctl, (message) => emitted.push(message));
		ctl.cancel.mockClear();
		const params = ctl.getParams();
		const acquire = params.onProviderInitiatedTurn;
		if (!acquire) throw new Error("peer continuation callback was missing");
		const dialogController = new AbortController();
		params.onProviderInitiatedTurn = async (turn) => {
			const ready = await acquire(turn);
			if (ready) dialogController.abort();
			return ready;
		};
		const handlers = createClaudeHostInteractionHandlers(params);
		const dialog = handlers.onUserDialog(
			{
				dialogKind: "peer_inbound_approval",
				toolUseID: "native-peer-control-cancel",
				payload: {
					preview: "Cancelled before provider release",
					holdCause: "explicit-setting",
				},
			},
			{
				signal: dialogController.signal,
				requestId: "control-native-peer-control-cancel",
			},
		);
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);
		const pending = sm.getPendingAskUserQuestions()[0];
		const question = pending?.questions[0]?.question;
		if (!pending || !question) throw new Error("peer approval was missing");
		await sm.handleAskUserQuestionResponse(pending.id, {
			[question]: ["Deliver to Claude"],
		});

		await expect(dialog).resolves.toEqual({ behavior: "cancelled" });
		await waitFor(() => expect(sm.getStatus().state).toBe("idle"));
		expect(ctl.cancel).toHaveBeenCalledTimes(1);
		expect(emitted.some((message) => message.type === "error")).toBe(false);
		sm.abort();
	});

	it("fails a peer approval closed and clears its card when decision persistence fails", async () => {
		vi.mocked(dbMock.appendAskUserQuestion).mockResolvedValue(undefined);
		vi.mocked(dbMock.setAskUserQuestionResolution)
			.mockRejectedValueOnce(new Error("decision storage unavailable"))
			.mockResolvedValue(undefined);
		const ctl = makePeerInboxHarness();
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(
			peerInboxConfig(),
			makeProviders(ctl.provider),
		);
		await establishIdlePeerSession(sm, ctl, (message) => emitted.push(message));
		ctl.setPermissionMode.mockClear();
		const handlers = createClaudeHostInteractionHandlers(ctl.getParams());
		const dialog = handlers.onUserDialog(
			{
				dialogKind: "peer_inbound_approval",
				toolUseID: "native-peer-storage-failure",
				payload: {
					preview: "Do not release without a durable decision",
					holdCause: "explicit-setting",
				},
			},
			{
				signal: new AbortController().signal,
				requestId: "control-native-peer-storage-failure",
			},
		);
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);
		const pending = sm.getPendingAskUserQuestions()[0];
		const question = pending?.questions[0]?.question;
		if (!pending || !question) throw new Error("peer approval was missing");

		await expect(
			sm.handleAskUserQuestionResponse(pending.id, {
				[question]: ["Deliver to Claude"],
			}),
		).rejects.toThrow("decision storage unavailable");
		await expect(dialog).resolves.toEqual({ behavior: "cancelled" });
		expect(sm.getPendingAskUserQuestions()).toEqual([]);
		expect(emitted).toContainEqual({
			type: "ask_user_question_resolved",
			id: pending.id,
			answers: { __hlid_cancelled__: [] },
		});
		expect(ctl.setPermissionMode).not.toHaveBeenCalled();
		sm.abort();
	});

	it("cancels a held peer immediately when its durable question cannot be inserted", async () => {
		vi.mocked(dbMock.appendAskUserQuestion).mockResolvedValue(undefined);
		const ctl = makePeerInboxHarness();
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(
			peerInboxConfig(),
			makeProviders(ctl.provider),
		);
		await establishIdlePeerSession(sm, ctl, (message) => emitted.push(message));
		vi.mocked(dbMock.appendAskUserQuestion).mockRejectedValueOnce(
			new Error("question storage unavailable"),
		);
		const handlers = createClaudeHostInteractionHandlers(ctl.getParams());

		await expect(
			handlers.onUserDialog(
				{
					dialogKind: "peer_inbound_approval",
					toolUseID: "native-peer-insert-failure",
					payload: {
						preview: "Do not leave a ghost card",
						holdCause: "explicit-setting",
					},
				},
				{
					signal: new AbortController().signal,
					requestId: "control-native-peer-insert-failure",
				},
			),
		).resolves.toEqual({ behavior: "cancelled" });
		expect(sm.getPendingAskUserQuestions()).toEqual([]);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "ask_user_question_resolved",
				answers: { __hlid_cancelled__: [] },
			}),
		);
		sm.abort();
	});

	it("retries the latest permission mode when it changes during restoration", async () => {
		vi.mocked(dbMock.appendAskUserQuestion).mockResolvedValue(undefined);
		vi.mocked(dbMock.setAskUserQuestionResolution).mockResolvedValue(undefined);
		const ctl = makePeerInboxHarness();
		const sm = new SessionManager(
			peerInboxConfig(),
			makeProviders(ctl.provider),
		);
		await establishIdlePeerSession(sm, ctl);
		ctl.setPermissionMode.mockClear();

		const handlers = createClaudeHostInteractionHandlers(ctl.getParams());
		const dialog = handlers.onUserDialog(
			{
				dialogKind: "peer_inbound_approval",
				toolUseID: "native-peer-mode-race",
				payload: {
					preview: "Change mode during restore",
					holdCause: "explicit-setting",
				},
			},
			{
				signal: new AbortController().signal,
				requestId: "control-native-peer-mode-race",
			},
		);
		await waitFor(() =>
			expect(sm.getPendingAskUserQuestions()).toHaveLength(1),
		);
		const pending = sm.getPendingAskUserQuestions()[0];
		const question = pending?.questions[0]?.question;
		if (!pending || !question) throw new Error("peer approval was missing");
		await sm.handleAskUserQuestionResponse(pending.id, {
			[question]: ["Deliver to Claude"],
		});
		await expect(dialog).resolves.toEqual({
			behavior: "completed",
			result: { behavior: "approve" },
		});
		expect(ctl.setPermissionMode).toHaveBeenCalledTimes(1);

		let releaseRestore!: () => void;
		ctl.setPermissionMode.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseRestore = resolve;
				}),
		);
		ctl.pushEvent({
			type: "provider_peer_message",
			body: "Change mode during restore",
		});
		ctl.pushEvent(peerDoneEvent());
		await waitFor(() => expect(ctl.setPermissionMode).toHaveBeenCalledTimes(2));
		await sm.setPermissionMode("bypassPermissions");
		expect(ctl.setPermissionMode).toHaveBeenCalledTimes(2);
		releaseRestore();
		await waitFor(() => expect(ctl.setPermissionMode).toHaveBeenCalledTimes(3));
		await waitFor(() => expect(sm.getStatus().state).toBe("idle"));
		expect(ctl.setPermissionMode.mock.calls.at(-1)?.[0]).toBe(
			"bypassPermissions",
		);
		sm.abort();
	});

	it("fails closed on an external peer origin outside an approved continuation", async () => {
		vi.mocked(dbMock.appendMessage).mockClear();
		const ctl = makePeerInboxHarness();
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(ctl.provider));
		const turn = sm.runQuery(
			"ordinary human turn",
			(message) => emitted.push(message),
			{
				sessionId: "unexpected-peer-session",
				turnId: "ordinary-human-turn",
			},
		);
		await waitFor(() => expect(ctl.send).toHaveBeenCalledTimes(1));
		ctl.pushEvent({
			type: "provider_peer_message",
			body: "Unapproved external input",
			fromAddress: "unexpected-peer",
		});
		await turn;

		expect(sm.getStatus().state).toBe("error");
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "error",
				message: expect.stringContaining("outside an owned peer continuation"),
			}),
		);
		expect(
			vi
				.mocked(dbMock.appendMessage)
				.mock.calls.some(
					(call) =>
						call[2] === "user" && String(call[3]).includes("Unapproved"),
				),
		).toBe(false);
		sm.abort();
	});
});

// ── handleRateLimit → updateWindowMark ───────────────────────────────────────
// proxy.ts is NOT mocked in this file, so updateWindowMark writes to the real
// in-memory windowHighMark and getWindowMark can verify it. Uses unique
// ── local_command_output ──────────────────────────────────────────────────────
