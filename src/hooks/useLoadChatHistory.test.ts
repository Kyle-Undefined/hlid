/**
 * useLoadChatHistory — reconnect recovery tests.
 *
 * We verify that when wsStatus transitions disconnected → connected (after an
 * initial load has completed), the hook re-fetches session history from DB and
 * dispatches LOAD_HISTORY with the fresh data. This is the core of the
 * "dot went green but chat didn't update" bug fix.
 *
 * jsdom environment is required because the hook uses React effects.
 * wsStore and serverFns are fully mocked to prevent real WS connections
 * or network calls.
 */
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "#/server/protocol";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("#/hooks/wsStore", () => ({
	setBufferingEnabled: vi.fn(),
	send: vi.fn(),
	drainMessageBuffer: vi.fn().mockReturnValue([]),
	clearMessageBuffer: vi.fn(),
	getSnapshot: vi.fn().mockReturnValue({ sessionState: "idle" }),
	seedActualModel: vi.fn(),
}));

vi.mock("#/hooks/wsChatQueueStore", () => ({
	claimPendingPrompt: vi.fn().mockReturnValue(null),
}));

vi.mock("#/hooks/wsLiveStatsStore", () => ({
	seedContextStats: vi.fn(),
	resetLiveStats: vi.fn(),
}));

vi.mock("#/lib/serverFns/sessions", () => ({
	getSessionDataFn: vi.fn(),
	getSessionContextFn: vi.fn(),
	getSessionPermissionsFn: vi.fn(),
	getSessionPlanProposalsFn: vi.fn(),
	getSessionAskUserQuestionsFn: vi.fn(),
	getSessionToolEventPageFn: vi.fn(),
}));

vi.mock("#/lib/utils", () => ({
	uid: vi.fn().mockReturnValue("test-uid"),
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import * as chatQueueStore from "#/hooks/wsChatQueueStore";
import * as liveStatsStore from "#/hooks/wsLiveStatsStore";
import * as wsStore from "#/hooks/wsStore";
import {
	getSessionAskUserQuestionsFn,
	getSessionContextFn,
	getSessionDataFn,
	getSessionPermissionsFn,
	getSessionPlanProposalsFn,
	getSessionToolEventPageFn,
} from "#/lib/serverFns/sessions";
import { useLoadChatHistory } from "./useLoadChatHistory";

// ── helpers ───────────────────────────────────────────────────────────────────

const noopWsHandler = vi.fn();

let _seq = 0;
function makeRow(role: "user" | "assistant", text: string, timestamp = 1000) {
	const id = ++_seq;
	return {
		id,
		session_id: "sess-1",
		seq: id,
		role,
		text,
		timestamp,
		toolEvents: [],
		attachments: [],
		recap: null,
	};
}

function makePerms() {
	return [];
}

function makeCtx() {
	return { context_window: null, last_context_used: null, actual_model: null };
}

type HookProps = Parameters<typeof useLoadChatHistory>[0];

function renderHistory(props: HookProps) {
	return renderHook((p: HookProps) => useLoadChatHistory(p), {
		initialProps: props,
	});
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("useLoadChatHistory — initial load", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_seq = 0;
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "idle",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: null,
			sleepState: null,
		});
		vi.mocked(chatQueueStore.claimPendingPrompt).mockReturnValue(null);
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([]);
		vi.mocked(getSessionContextFn).mockResolvedValue(makeCtx());
		vi.mocked(getSessionPermissionsFn).mockResolvedValue(makePerms());
		vi.mocked(getSessionPlanProposalsFn).mockResolvedValue([]);
		vi.mocked(getSessionAskUserQuestionsFn).mockResolvedValue([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("preserves live stats across session navigation (does not reset on load)", async () => {
		// Stats should persist when navigating to any session — they track the active
		// running session, not the viewed session. Reset only happens when a new run
		// starts (index.tsx) or the user explicitly clears (raven.tsx).
		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hello", 1000),
		]);

		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		expect(liveStatsStore.resetLiveStats).not.toHaveBeenCalled();
	});

	it("deduplicates one per-response page request and maps it through the history mapper", async () => {
		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("assistant", "done", 1000),
		]);
		let resolvePage!: (
			value: Awaited<ReturnType<typeof getSessionToolEventPageFn>>,
		) => void;
		vi.mocked(getSessionToolEventPageFn).mockReturnValue(
			new Promise((resolve) => {
				resolvePage = resolve;
			}),
		);
		const dispatch = vi.fn();
		const view = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});
		await act(async () => {});

		const first = view.result.current.loadEarlierToolEvents(
			"response-1",
			2,
			30,
		);
		const second = view.result.current.loadEarlierToolEvents(
			"response-1",
			2,
			30,
		);
		expect(first).toBe(second);
		expect(getSessionToolEventPageFn).toHaveBeenCalledOnce();
		expect(getSessionToolEventPageFn).toHaveBeenCalledWith({
			data: {
				sessionId: "sess-1",
				assistantSeq: 2,
				beforeId: 30,
				limit: 20,
			},
		});

		await act(async () => {
			resolvePage({
				total: 40,
				errorCount: 1,
				hasEarlier: false,
				nextBeforeId: null,
				items: [
					{
						id: 20,
						session_id: "sess-1",
						assistant_seq: 2,
						tool_id: "tool-20",
						name: "Read",
						input_json: "{}",
						result_text: "preview",
						result_length: 500,
						result_truncated: 1,
						is_error: 0,
						subagent_json: null,
						activity_json: null,
					},
				],
			});
			await first;
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "PREPEND_TOOL_EVENT_PAGE",
			id: "response-1",
			expectedBeforeId: 30,
			events: [
				expect.objectContaining({
					id: "tool-20",
					resultTruncated: true,
					detailSessionId: "sess-1",
				}),
			],
			page: {
				total: 40,
				errorCount: 1,
				hasEarlier: false,
				nextBeforeId: null,
			},
		});
	});

	it("shows base messages before optional question history finishes", async () => {
		let resolveQuestions!: (value: []) => void;
		vi.mocked(getSessionAskUserQuestionsFn).mockReturnValue(
			new Promise((resolve) => {
				resolveQuestions = resolve;
			}),
		);
		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "visible immediately", 1000),
		]);
		const dispatch = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await act(async () => {});
		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load.items).toEqual([
			expect.objectContaining({ text: "visible immediately" }),
		]);
		expect(
			dispatch.mock.calls.some(([action]) => action.type === "HYDRATE_HISTORY"),
		).toBe(false);

		await act(async () => resolveQuestions([]));
		expect(
			dispatch.mock.calls.some(([action]) => action.type === "HYDRATE_HISTORY"),
		).toBe(true);
	});

	it("restores Raven Live rows with their stable utterance identity", async () => {
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...makeRow("assistant", "Persisted voice reply", 1000),
				source: "codex_realtime",
				utterance_id: "utterance-assistant-1",
				realtime_session_id: "realtime-1",
				fork_supported: 0,
			},
		]);
		const dispatch = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await act(async () => {});
		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load.items).toEqual([
			expect.objectContaining({
				id: "utterance-assistant-1",
				dbId: expect.any(Number),
				source: "codex_realtime",
				utteranceId: "utterance-assistant-1",
				realtimeSessionId: "realtime-1",
				forkSupported: false,
			}),
		]);
	});

	it("refreshes a stale idle snapshot after a buffered durable Live final", async () => {
		const prior = makeRow("user", "Earlier message", 1000);
		const liveRow = {
			...makeRow("assistant", "Persisted during hydration", 2000),
			source: "codex_realtime",
			utterance_id: "utterance-assistant-refresh",
			realtime_session_id: "realtime-refresh",
			fork_supported: 0,
		};
		const durableFinal: ServerMessage = {
			type: "realtime_transcript",
			session_id: "sess-1",
			mode: "live",
			role: "assistant",
			text: liveRow.text,
			done: true,
			utterance_id: liveRow.utterance_id,
			realtime_session_id: liveRow.realtime_session_id,
			transcript_seq: liveRow.seq,
			db_id: liveRow.id,
			source: "codex_realtime",
			fork_supported: false,
		};
		vi.mocked(getSessionDataFn)
			.mockResolvedValueOnce([prior])
			.mockResolvedValueOnce([prior, liveRow]);
		vi.mocked(wsStore.drainMessageBuffer)
			.mockReturnValueOnce([durableFinal])
			.mockReturnValueOnce([])
			.mockReturnValueOnce([]);
		const dispatch = vi.fn();
		const handleWsMessage = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await vi.waitFor(() => expect(getSessionDataFn).toHaveBeenCalledTimes(2));
		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load?.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: liveRow.utterance_id,
					text: liveRow.text,
					dbId: liveRow.id,
					source: "codex_realtime",
				}),
			]),
		);
		expect(handleWsMessage).toHaveBeenCalledWith(durableFinal);
	});

	it("replays only Live frames for an idle session, including the final buffer tail", async () => {
		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("assistant", "Existing reply", 1000),
		]);
		const partial: ServerMessage = {
			type: "realtime_transcript",
			session_id: "sess-1",
			mode: "live",
			role: "user",
			text: "Still speaking",
			done: false,
			utterance_id: "utterance-user-tail",
			realtime_session_id: "realtime-tail",
			transcript_seq: 2,
			source: "codex_realtime",
			fork_supported: false,
		};
		const closed: ServerMessage = {
			type: "realtime_state",
			session_id: "sess-1",
			mode: "live",
			state: "closed",
		};
		const tool: ServerMessage = {
			type: "tool_event",
			id: "live-tool-tail",
			name: "hlid_help",
			input: { topic: "voice_audio" },
			realtime_utterance_id: "utterance-assistant-tail",
			realtime_session_id: "realtime-tail",
			transcript_seq: 3,
			fork_supported: false,
		};
		const result: ServerMessage = {
			type: "tool_result",
			id: "live-tool-tail",
			content: "available",
			realtime_utterance_id: "utterance-assistant-tail",
			realtime_session_id: "realtime-tail",
			transcript_seq: 3,
		};
		vi.mocked(wsStore.drainMessageBuffer)
			.mockReturnValueOnce([
				partial,
				tool,
				{ type: "chunk", text: "stale ordinary turn" },
			])
			.mockReturnValueOnce([
				result,
				closed,
				{
					type: "realtime_error",
					session_id: "sess-1",
					mode: "dictation",
					message: "unrelated dictation",
				},
			]);
		const handleWsMessage = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch: vi.fn(),
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await vi.waitFor(() => expect(handleWsMessage).toHaveBeenCalledTimes(4));
		expect(handleWsMessage.mock.calls.map(([message]) => message)).toEqual([
			partial,
			tool,
			result,
			closed,
		]);
	});

	it("maps persisted exact, estimated, zero, and unknown query costs into history", async () => {
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...makeRow("assistant", "provider cost", 1000),
				query_cost: 0.1234,
				query_cost_known: 1,
				query_estimated_cost: null,
			},
			{
				...makeRow("assistant", "estimated cost", 2000),
				query_cost: 0,
				query_cost_known: 1,
				query_estimated_cost: 0.2345,
			},
			{
				...makeRow("assistant", "free", 3000),
				query_cost: 0,
				query_cost_known: 1,
				query_estimated_cost: null,
			},
			{
				...makeRow("assistant", "unpriced", 4000),
				query_cost: 0,
				query_cost_known: 0,
				query_estimated_cost: null,
			},
		]);
		const dispatch = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await act(async () => {});

		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load.items).toEqual([
			expect.objectContaining({
				text: "provider cost",
				cost: 0.1234,
				costEstimated: false,
			}),
			expect.objectContaining({
				text: "estimated cost",
				cost: 0.2345,
				costEstimated: true,
			}),
			expect.objectContaining({
				text: "free",
				cost: 0,
				costEstimated: false,
			}),
			expect.objectContaining({
				text: "unpriced",
				cost: null,
				costEstimated: false,
			}),
		]);
	});

	it("refetches when completion lands during the initial DB snapshot", async () => {
		const staleUser = makeRow("user", "still running", 1000);
		const finalAssistant = makeRow("assistant", "completed response", 2000);
		vi.mocked(getSessionDataFn)
			.mockResolvedValueOnce([staleUser])
			.mockResolvedValueOnce([staleUser, finalAssistant]);
		vi.mocked(wsStore.drainMessageBuffer)
			.mockReturnValueOnce([{ type: "done" } as ServerMessage])
			.mockReturnValueOnce([]);
		const dispatch = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await vi.waitFor(() => {
			expect(
				dispatch.mock.calls.filter(
					([action]) => action.type === "LOAD_HISTORY",
				),
			).toHaveLength(1);
		});
		expect(getSessionDataFn).toHaveBeenCalledTimes(2);
		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load?.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					text: "completed response",
				}),
			]),
		);
	});

	it("marks persisted user turns that have inspectable context receipts", async () => {
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...makeRow("user", "inspect this turn", 1000),
				context_manifest_json: '{"contractVersion":1}',
			},
			makeRow("user", "legacy turn", 2000),
		]);
		const dispatch = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await act(async () => {});
		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load.items).toEqual([
			expect.objectContaining({
				text: "inspect this turn",
				hasContextReceipt: true,
			}),
			expect.objectContaining({
				text: "legacy turn",
				hasContextReceipt: false,
			}),
		]);
	});

	it("hydrates trailing pending questions and plans newer than the latest message", async () => {
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...makeRow("user", "make a plan", 1000),
				seq: 0,
			},
			{
				...makeRow("assistant", "I need two choices first", 2000),
				seq: 1,
			},
		]);
		vi.mocked(getSessionAskUserQuestionsFn).mockResolvedValue([
			{
				request_id: "question-1",
				seq: 2,
				questions_json: JSON.stringify([
					{ question: "Which scope?", options: ["A", "B"], multiSelect: false },
				]),
				provenance_json: JSON.stringify({
					provider_id: "claude",
					kind: "mcp_elicitation",
					source_name: "github",
					turn_id: "turn-1",
				}),
				answers_json: null,
				notes_json: null,
				timestamp: 3000,
			},
		]);
		vi.mocked(getSessionPlanProposalsFn).mockResolvedValue([
			{
				proposal_id: "plan-1",
				seq: 3,
				plan: "The pending plan",
				decision: "pending",
				html_attachment_id: null,
				timestamp: 4000,
			},
		]);
		const dispatch = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await act(async () => {});

		expect(getSessionAskUserQuestionsFn).toHaveBeenCalledWith({
			data: { sessionId: "sess-1", minSeq: 0 },
		});
		expect(getSessionPlanProposalsFn).toHaveBeenCalledWith({
			data: { sessionId: "sess-1", minSeq: 0 },
		});
		const hydrated = dispatch.mock.calls.find(
			([action]) => action.type === "HYDRATE_HISTORY",
		)?.[0].items;
		expect(hydrated).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "ask_user_question",
					id: "question-1",
					provenance: expect.objectContaining({
						provider_id: "claude",
						source_name: "github",
						turn_id: "turn-1",
					}),
				}),
				expect.objectContaining({ kind: "plan_proposal", id: "plan-1" }),
			]),
		);
	});

	it("restores persisted subagent snapshots on tool events", async () => {
		const row = makeRow("assistant", "", 1000);
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...row,
				toolEvents: [
					{
						id: 1,
						session_id: "sess-1",
						assistant_seq: row.seq,
						tool_id: "spawn-1",
						name: "spawn_agent",
						input_json: JSON.stringify({ prompt: "Inspect auth" }),
						result_text: null,
						result_length: null,
						result_truncated: 0,
						is_error: null,
						subagent_json: JSON.stringify({
							provider: "codex",
							agentId: "child-1",
							status: "running",
							startedAtMs: 1000,
							currentStep: "Reading files",
						}),
					},
				],
			},
		]);
		const dispatch = vi.fn();
		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});
		await act(async () => {});

		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load.items[0].toolEvents[0].subagent).toMatchObject({
			agentId: "child-1",
			status: "running",
			currentStep: "Reading files",
		});
	});

	it("restores persisted task activity on tool events", async () => {
		const row = makeRow("assistant", "", 1000);
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...row,
				toolEvents: [
					{
						id: 1,
						session_id: "sess-1",
						assistant_seq: row.seq,
						tool_id: "plan-1",
						name: "update_plan",
						input_json: JSON.stringify({ plan: [] }),
						result_text: "updated",
						result_length: 7,
						result_truncated: 0,
						is_error: 0,
						subagent_json: null,
						activity_json: JSON.stringify({
							kind: "tasks",
							source: "codex-plan",
							operation: "snapshot",
							items: [{ subject: "Hydrate Raven", status: "completed" }],
						}),
					},
				],
			},
		]);
		const dispatch = vi.fn();
		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});
		await act(async () => {});

		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load.items[0].toolEvents[0].taskActivity).toEqual({
			kind: "tasks",
			source: "codex-plan",
			operation: "snapshot",
			items: [{ subject: "Hydrate Raven", status: "completed" }],
		});
	});

	it("maps historical result previews to lazy session-scoped tool events", async () => {
		const row = makeRow("assistant", "", 1000);
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...row,
				toolEvents: [
					{
						id: 1,
						session_id: "sess-1",
						assistant_seq: row.seq,
						tool_id: "tool-1",
						name: "Read",
						input_json: JSON.stringify({ path: "README.md" }),
						result_text: "preview",
						result_length: 10_000,
						result_truncated: 1,
						is_error: 0,
						subagent_json: null,
					},
				],
			},
		]);
		const dispatch = vi.fn();
		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});
		await act(async () => {});

		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load.items[0].toolEvents[0]).toMatchObject({
			id: "tool-1",
			result: "preview",
			resultLength: 10_000,
			resultTruncated: true,
			detailSessionId: "sess-1",
		});
	});

	it("uses a 101-row lookahead and prepends the preceding cursor page without overlap", async () => {
		const rows = (start: number, end: number) =>
			Array.from({ length: end - start + 1 }, (_, index) => {
				const seq = start + index;
				return {
					id: seq + 1,
					session_id: "sess-1",
					seq,
					role: seq % 2 === 0 ? "user" : "assistant",
					text: `message ${seq}`,
					timestamp: 1_000 + seq,
					toolEvents: [],
					attachments: [],
					recap: null,
				};
			});
		vi.mocked(getSessionDataFn)
			.mockResolvedValueOnce(rows(100, 200))
			.mockResolvedValueOnce(rows(0, 100));
		const dispatch = vi.fn();
		const hook = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await act(async () => {});
		expect(hook.result.current.hasOlderHistory).toBe(true);
		let loaded = 0;
		await act(async () => {
			loaded = await hook.result.current.loadOlderHistory();
		});

		expect(loaded).toBe(100);
		expect(getSessionDataFn).toHaveBeenNthCalledWith(1, {
			data: { sessionId: "sess-1", limit: 101 },
		});
		expect(getSessionDataFn).toHaveBeenNthCalledWith(2, {
			data: {
				sessionId: "sess-1",
				beforeSeq: 101,
				beforeId: 102,
				limit: 101,
			},
		});
		const initial = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		const prepend = dispatch.mock.calls.find(
			([action]) => action.type === "PREPEND_HISTORY",
		)?.[0];
		const combinedMessages = [...prepend.items, ...initial.items].filter(
			(item) => item.kind === "message",
		);
		const combinedTexts = combinedMessages.map((item) => item.text);
		expect(combinedTexts).toEqual(
			Array.from({ length: 200 }, (_, index) => `message ${index + 1}`),
		);
		expect(new Set(combinedTexts).size).toBe(200);
		expect(combinedMessages.map((item) => item.id)).toEqual(
			Array.from(
				{ length: 200 },
				(_, index) => `persisted-message:${index + 2}`,
			),
		);
		expect(getSessionPlanProposalsFn).toHaveBeenNthCalledWith(2, {
			data: {
				sessionId: "sess-1",
				minSeq: 1,
				maxSeq: 100,
				beforeSeq: 101,
			},
		});
	});
});

describe("useLoadChatHistory — reconnect recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_seq = 0;
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "idle",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: null,
			sleepState: null,
		});
		vi.mocked(chatQueueStore.claimPendingPrompt).mockReturnValue(null);
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([]);
		vi.mocked(getSessionContextFn).mockResolvedValue(makeCtx());
		vi.mocked(getSessionPermissionsFn).mockResolvedValue(makePerms());
		vi.mocked(getSessionPlanProposalsFn).mockResolvedValue([]);
		vi.mocked(getSessionAskUserQuestionsFn).mockResolvedValue([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("dispatches LOAD_HISTORY on reconnect with fresh DB data", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		const userRow = makeRow("user", "hello", 1000);
		const assistantRow = makeRow("assistant", "world", 2000);
		// First DB call (initial load) returns just a user message. Reconnect
		// returns that same persisted row plus the newly persisted assistant.
		vi.mocked(getSessionDataFn)
			.mockResolvedValueOnce([userRow])
			// Second call (reconnect) returns user + assistant
			.mockResolvedValueOnce([userRow, assistantRow]);

		const { rerender } = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		// Wait for initial load to complete
		await act(async () => {});

		expect(historyReadyRef.current).toBe(true);
		const loadHistoryCallCount = dispatch.mock.calls.filter(
			([a]) => a.type === "LOAD_HISTORY",
		).length;
		expect(loadHistoryCallCount).toBe(1);

		// Simulate disconnect then reconnect
		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "disconnected",
			sessionIdRef,
		});

		await act(async () => {});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// getSessionDataFn called twice (initial + reconnect)
		expect(getSessionDataFn).toHaveBeenCalledTimes(2);
		expect(getSessionDataFn).toHaveBeenNthCalledWith(2, {
			data: { sessionId: "sess-1", minSeq: 1, minId: 1 },
		});

		// LOAD_HISTORY dispatched twice
		const loadHistoryCalls = dispatch.mock.calls.filter(
			([a]) => a.type === "LOAD_HISTORY",
		);
		expect(loadHistoryCalls).toHaveLength(2);
		expect(loadHistoryCalls[0][0].items[0].id).toBe("persisted-message:1");
		expect(loadHistoryCalls[1][0].items[0].id).toBe("persisted-message:1");
		expect(loadHistoryCalls[0][0].preserveToolEventPages).toBeUndefined();
		expect(loadHistoryCalls[1][0].preserveToolEventPages).toBe(true);

		// Second LOAD_HISTORY includes the assistant message
		const secondItems = loadHistoryCalls[1][0].items as { role: string }[];
		expect(secondItems.some((i) => i.role === "assistant")).toBe(true);
	});

	it("keeps a persisted user message keyed by its queued turn id", async () => {
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{ ...makeRow("user", "queued prompt"), turn_id: "queued-turn-1" },
		]);

		const dispatch = vi.fn();
		const pendingIdRef = { current: null };
		const historyReadyRef = { current: false };
		const sessionIdRef = { current: "sess-1" };
		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		const loadHistory = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(loadHistory.items[0].id).toBe("queued-turn-1");
	});

	it("hydrates the assistant sequence targeted by a persisted steer", async () => {
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...makeRow("assistant", ""),
				seq: 4,
			},
			{
				...makeRow("user", "change direction"),
				id: 2,
				seq: 5,
				turn_id: "steer-turn",
				steer_target_seq: 4,
				steer_tool_event_index: 2,
			},
		]);

		const dispatch = vi.fn();
		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await act(async () => {});

		const loadHistory = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(loadHistory.items).toEqual([
			expect.objectContaining({ role: "assistant", text: "", seq: 4 }),
			expect.objectContaining({
				id: "steer-turn",
				role: "user",
				seq: 5,
				steerTargetSeq: 4,
				steerToolEventIndex: 2,
			}),
		]);
	});

	it("serializes reconnect behind an in-flight older-page load", async () => {
		const rows = (start: number, end: number) =>
			Array.from({ length: end - start + 1 }, (_, index) => {
				const seq = start + index;
				return {
					id: seq + 1,
					session_id: "sess-1",
					seq,
					role: "user" as const,
					text: `message ${seq}`,
					timestamp: 1_000 + seq,
					toolEvents: [],
					attachments: [],
					recap: null,
				};
			});
		let resolveOlder!: (value: ReturnType<typeof rows>) => void;
		const olderPage = new Promise<ReturnType<typeof rows>>((resolve) => {
			resolveOlder = resolve;
		});
		vi.mocked(getSessionDataFn)
			.mockResolvedValueOnce(rows(100, 300))
			.mockReturnValueOnce(olderPage)
			.mockResolvedValueOnce(rows(0, 300));
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };
		const hook = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});
		await act(async () => {});

		let olderRequest!: Promise<number>;
		act(() => {
			olderRequest = hook.result.current.loadOlderHistory();
		});
		hook.rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "disconnected",
			sessionIdRef,
		});
		hook.rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});
		await act(async () => {});
		expect(getSessionDataFn).toHaveBeenCalledTimes(2);

		await act(async () => {
			resolveOlder(rows(0, 100));
			await olderRequest;
		});
		await act(async () => {});

		expect(getSessionDataFn).toHaveBeenCalledTimes(3);
		expect(getSessionDataFn).toHaveBeenNthCalledWith(3, {
			data: { sessionId: "sess-1", minSeq: 1, minId: 2 },
		});
		expect(
			dispatch.mock.calls
				.map(([action]) => action.type)
				.filter(
					(type) => type === "LOAD_HISTORY" || type === "PREPEND_HISTORY",
				),
		).toEqual(["LOAD_HISTORY", "PREPEND_HISTORY", "LOAD_HISTORY"]);
	});

	it("on reconnect clears stale pendingIdRef before re-fetch", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: "stale-bubble-id" as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hi", 1000),
		]);

		const { rerender } = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Simulate stale pending bubble (e.g., done was missed)
		pendingIdRef.current = "stale-bubble-id";

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "disconnected",
			sessionIdRef,
		});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Stale bubble cleared before re-fetch
		expect(pendingIdRef.current).toBeNull();
	});

	it("on reconnect with running session, adds bubble and drains buffer", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };
		const handleWsMessage = vi.fn();
		const bufferedMsg = { type: "chunk" as const, text: "hello" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "query", 1000),
		]);
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([bufferedMsg]);

		const { rerender } = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Session is running when we reconnect
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "running",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: null,
			sleepState: null,
		});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage,
			wsStatus: "disconnected",
			sessionIdRef,
		});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// ADD_ASSISTANT dispatched for new bubble
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ type: "ADD_ASSISTANT" }),
		);
		// Buffered message replayed
		expect(handleWsMessage).toHaveBeenCalledWith(bufferedMsg);
	});

	it("skips reconnect re-fetch if historyReady is still false", async () => {
		const dispatch = vi.fn();
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([]);

		const { rerender } = renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef: { current: false }, // stays false
			handleWsMessage: noopWsHandler,
			wsStatus: "connecting",
			sessionIdRef,
		});

		await act(async () => {});

		// Force wsConnectedOnceRef to be set by simulating an initial connect
		// without a real initial load completing (historyReady stays false)
		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef: { current: false }, // still not ready
			handleWsMessage: noopWsHandler,
			wsStatus: "disconnected",
			sessionIdRef,
		});

		rerender({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// getSessionDataFn should only be called once (initial load, NOT the reconnect)
		// because historyReady is false
		// Note: initial load may have called it depending on whether existingSessionId triggers it
		// The reconnect effect guards with historyReadyRef.current === false → skip
		// So reconnect fetch does NOT add a second call beyond initial load
		const calls = vi.mocked(getSessionDataFn).mock.calls;
		// All calls should be with { data: "sess-1" } but we verify reconnect didn't add extras
		// The initial load effect fires (existingSessionId="sess-1"), so 1 call expected
		// Reconnect would be a 2nd call — we expect it NOT to fire
		expect(calls.length).toBe(1);
	});

	it("does not reset live stats when navigating to an explicit session", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-2" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hello", 1000),
		]);

		renderHistory({
			existingSessionId: "sess-2",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Stats persist across SPA navigation — only index.tsx resets on new run.
		expect(liveStatsStore.resetLiveStats).not.toHaveBeenCalled();
	});

	it("does not reset live stats when navigating to an implicit session", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hello", 1000),
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: false,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		expect(liveStatsStore.resetLiveStats).not.toHaveBeenCalled();
	});

	it("does NOT re-fetch on first connect (initial load handles that)", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hello", 1000),
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Only ONE LOAD_HISTORY dispatch — initial load, not a duplicate from reconnect effect
		const loadHistoryCalls = dispatch.mock.calls.filter(
			([a]) => a.type === "LOAD_HISTORY",
		);
		expect(loadHistoryCalls).toHaveLength(1);
		// And only one DB fetch
		expect(getSessionDataFn).toHaveBeenCalledTimes(1);
	});
});

// ── Mid-turn placeholder reuse ────────────────────────────────────────────────
// When the server pre-inserts an empty assistant placeholder + tool_event rows
// at first tool_start, a mid-turn reload must reuse that placeholder id as the
// pending bubble (instead of opening a fresh ADD_ASSISTANT bubble) so the user
// sees a single coherent assistant turn — not the placeholder followed by a
// second empty bubble.

function makeAssistantRowWithTools(
	toolIds: string[],
	{ text = "", timestamp = 2000 }: { text?: string; timestamp?: number } = {},
) {
	const id = ++_seq;
	return {
		id,
		session_id: "sess-1",
		seq: id,
		role: "assistant" as const,
		text,
		timestamp,
		toolEvents: toolIds.map((tid) => ({
			id: 0,
			session_id: "sess-1",
			assistant_seq: id,
			tool_id: tid,
			name: "Read",
			input_json: "{}",
			result_text: null,
			result_length: null,
			result_truncated: 0,
			is_error: null,
		})),
		attachments: [],
		recap: null,
	};
}

describe("useLoadChatHistory — in-flight assistant reuse during running turn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_seq = 0;
		// Session is RUNNING — mid-turn reload scenario.
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "running",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: null,
			sleepState: null,
		});
		vi.mocked(chatQueueStore.claimPendingPrompt).mockReturnValue(null);
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([]);
		vi.mocked(getSessionContextFn).mockResolvedValue(makeCtx());
		vi.mocked(getSessionPermissionsFn).mockResolvedValue([]);
		vi.mocked(getSessionPlanProposalsFn).mockResolvedValue([]);
		vi.mocked(getSessionAskUserQuestionsFn).mockResolvedValue([]);
	});

	it("reuses placeholder id as pendingIdRef when last assistant row has empty text", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "read please", 1000),
			makeAssistantRowWithTools(["tu-1", "tu-2"]),
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		// Should NOT dispatch a fresh ADD_ASSISTANT — we reuse the placeholder.
		const addAssistantCalls = dispatch.mock.calls.filter(
			([a]) => a.type === "ADD_ASSISTANT",
		);
		expect(addAssistantCalls).toHaveLength(0);

		// pendingIdRef should match the placeholder's stable persisted-row id from
		// the LOAD_HISTORY items.
		const loadCall = dispatch.mock.calls.find(
			([a]) => a.type === "LOAD_HISTORY",
		);
		const items = loadCall?.[0].items as { role: string; id: string }[];
		const placeholder = [...items]
			.reverse()
			.find((i: { role: string; id: string }) => i.role === "assistant");
		expect(pendingIdRef.current).toBe(placeholder?.id);
		expect(dispatch).toHaveBeenCalledWith({
			type: "RESUME_ASSISTANT",
			id: placeholder?.id,
		});
	});

	it("reuses the in-flight assistant when a persisted steer trails it", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };
		const original = makeRow("user", "start", 1000);
		const assistant = makeRow("assistant", "partial response", 2000);
		const steer = {
			...makeRow("user", "change direction", 3000),
			turn_id: "steer-turn",
			steer_target_seq: assistant.seq,
		};

		vi.mocked(getSessionDataFn).mockResolvedValue([original, assistant, steer]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		expect(
			dispatch.mock.calls.filter(([action]) => action.type === "ADD_ASSISTANT"),
		).toHaveLength(0);
		const loadCall = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		);
		const items = loadCall?.[0].items as Array<{
			role: string;
			id: string;
			seq?: number;
		}>;
		const restoredAssistant = items.find(
			(item) => item.role === "assistant" && item.seq === assistant.seq,
		);
		expect(pendingIdRef.current).toBe(restoredAssistant?.id);
		expect(dispatch).toHaveBeenCalledWith({
			type: "RESUME_ASSISTANT",
			id: restoredAssistant?.id,
		});
	});

	it("reuses an assistant after a steer accepted before its row was reserved", async () => {
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "running",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: "original-turn",
			sleepState: null,
		});
		const original = {
			...makeRow("user", "start", 1000),
			turn_id: "original-turn",
		};
		const earlySteer = {
			...makeRow("user", "change direction", 2000),
			turn_id: "steer-turn",
			steer_target_seq: null,
		};
		const assistant = makeRow("assistant", "partial response", 3000);
		vi.mocked(getSessionDataFn).mockResolvedValue([
			original,
			earlySteer,
			assistant,
		]);
		const dispatch = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await vi.waitFor(() =>
			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({ type: "RESUME_ASSISTANT" }),
			),
		);
		expect(
			dispatch.mock.calls.filter(([action]) => action.type === "ADD_ASSISTANT"),
		).toHaveLength(0);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "SET_ASSISTANT_TURN",
				turnId: "original-turn",
			}),
		);
	});

	it("refetches a running snapshot after a buffered steer acknowledgement", async () => {
		const dispatch = vi.fn();
		const original = makeRow("user", "start", 1000);
		const assistant = makeRow("assistant", "partial response", 2000);
		const steer = {
			...makeRow("user", "change direction", 3000),
			turn_id: "steer-turn",
			steer_target_seq: assistant.seq,
		};
		vi.mocked(getSessionDataFn)
			.mockResolvedValueOnce([original, assistant])
			.mockResolvedValueOnce([original, assistant, steer]);
		vi.mocked(wsStore.drainMessageBuffer)
			.mockReturnValueOnce([
				{
					type: "turn_steered",
					turn_id: "steer-turn",
					target_turn_id: "original-turn",
					target_assistant_seq: assistant.seq,
					steer_seq: steer.seq,
					session_id: "sess-1",
				},
			])
			.mockReturnValueOnce([]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await vi.waitFor(() => expect(getSessionDataFn).toHaveBeenCalledTimes(2));
		const load = dispatch.mock.calls.find(
			([action]) => action.type === "LOAD_HISTORY",
		)?.[0];
		expect(load?.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "steer-turn",
					steerTargetSeq: assistant.seq,
				}),
			]),
		);
	});

	it("replays only the next-turn tail when a queued turn starts during refetch", async () => {
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "running",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: "turn-b",
			sleepState: null,
		});
		const turnAUser = {
			...makeRow("user", "first turn", 1000),
			turn_id: "turn-a",
		};
		const turnAAssistant = makeRow("assistant", "finished A", 2000);
		vi.mocked(getSessionDataFn).mockResolvedValue([turnAUser, turnAAssistant]);
		const doneA = {
			type: "done",
			turn_id: "turn-a",
			session_id: "sess-1",
		} as ServerMessage;
		const buffered: ServerMessage[] = [
			{ type: "chunk", text: "stale A", offset: 0 },
			{ type: "tool_result", id: "tool-a", content: "settled" },
			doneA,
			{
				type: "user_message",
				id: "turn-b",
				text: "second turn",
				session_id: "sess-1",
			},
			{ type: "chunk", text: "live B", offset: 0 },
		];
		vi.mocked(wsStore.drainMessageBuffer)
			.mockReturnValueOnce(buffered)
			.mockReturnValueOnce([]);
		const dispatch = vi.fn();
		const handleWsMessage = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await vi.waitFor(() =>
			expect(dispatch).toHaveBeenCalledWith({
				type: "ADD_ASSISTANT",
				id: "test-uid",
				afterUserId: "turn-b",
			}),
		);
		expect(handleWsMessage.mock.calls.map(([message]) => message)).toEqual([
			{ type: "tool_result", id: "tool-a", content: "settled" },
			{
				type: "user_message",
				id: "turn-b",
				text: "second turn",
				session_id: "sess-1",
			},
			{ type: "chunk", text: "live B", offset: 0 },
		]);
	});

	it("does not replay a failed turn onto the queued turn that follows it", async () => {
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "running",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: "turn-b",
			sleepState: null,
		});
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...makeRow("user", "first turn", 1000),
				turn_id: "turn-a",
			},
			makeRow("assistant", "partial A", 2000),
		]);
		vi.mocked(wsStore.drainMessageBuffer)
			.mockReturnValueOnce([
				{ type: "chunk", text: "stale A", offset: 0 },
				{
					type: "error",
					message: "turn A failed",
					turn_id: "turn-a",
					turn_scoped: true,
				},
				{
					type: "user_message",
					id: "turn-b",
					text: "second turn",
					session_id: "sess-1",
				},
				{ type: "chunk", text: "live B", offset: 0 },
			])
			.mockReturnValueOnce([]);
		const handleWsMessage = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch: vi.fn(),
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await vi.waitFor(() =>
			expect(handleWsMessage).toHaveBeenCalledWith({
				type: "chunk",
				text: "live B",
				offset: 0,
			}),
		);
		expect(handleWsMessage.mock.calls.map(([message]) => message)).toEqual([
			{
				type: "user_message",
				id: "turn-b",
				text: "second turn",
				session_id: "sess-1",
			},
			{ type: "chunk", text: "live B", offset: 0 },
		]);
	});

	it("retains an error for the same turn while its terminal status is pending", async () => {
		vi.mocked(wsStore.getSnapshot).mockReturnValue({
			sessionState: "running",
			wsStatus: "connected",
			model: "",
			actualModel: null,
			permissionMode: null,
			effort: null,
			hasPendingPermissions: false,
			runningTurnId: "turn-a",
			sleepState: null,
		});
		const error: ServerMessage = {
			type: "error",
			message: "turn A failed",
			turn_id: "turn-a",
			turn_scoped: true,
		};
		vi.mocked(getSessionDataFn).mockResolvedValue([
			{
				...makeRow("user", "first turn", 1000),
				turn_id: "turn-a",
			},
			makeRow("assistant", "partial A", 2000),
		]);
		vi.mocked(wsStore.drainMessageBuffer)
			.mockReturnValueOnce([error])
			.mockReturnValueOnce([]);
		const handleWsMessage = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch: vi.fn(),
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await vi.waitFor(() => expect(handleWsMessage).toHaveBeenCalledWith(error));
	});

	it("retains an uncorrelated done for a running goal continuation", async () => {
		const done = {
			type: "done",
			session_id: "sess-1",
		} as ServerMessage;
		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("assistant", "goal continuation", 1000),
		]);
		vi.mocked(wsStore.drainMessageBuffer)
			.mockReturnValueOnce([done])
			.mockReturnValueOnce([]);
		const handleWsMessage = vi.fn();

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch: vi.fn(),
			pendingIdRef: { current: null },
			historyReadyRef: { current: false },
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef: { current: "sess-1" },
		});

		await vi.waitFor(() => expect(handleWsMessage).toHaveBeenCalledWith(done));
	});

	it("does not reuse an unrelated assistant when a steer target is outside the page", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("assistant", "older completed response", 1000),
			{
				...makeRow("user", "change direction", 3000),
				turn_id: "steer-turn",
				steer_target_seq: 999,
			},
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		const addAssistantCalls = dispatch.mock.calls.filter(
			([action]) => action.type === "ADD_ASSISTANT",
		);
		expect(addAssistantCalls).toHaveLength(1);
		expect(pendingIdRef.current).toBe(addAssistantCalls[0][0].id);
	});

	it("opens a fresh bubble when no placeholder exists (last row is user)", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hello", 1000),
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		const addAssistantCalls = dispatch.mock.calls.filter(
			([a]) => a.type === "ADD_ASSISTANT",
		);
		expect(addAssistantCalls).toHaveLength(1);
		expect(pendingIdRef.current).toBe(addAssistantCalls[0][0].id);
	});

	it("reuses the in-flight assistant when its persisted text is non-empty", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "hi", 1000),
			makeRow("assistant", "partial response", 2000),
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage: noopWsHandler,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		const addAssistantCalls = dispatch.mock.calls.filter(
			([a]) => a.type === "ADD_ASSISTANT",
		);
		expect(addAssistantCalls).toHaveLength(0);
		const loadCall = dispatch.mock.calls.find(
			([a]) => a.type === "LOAD_HISTORY",
		);
		const items = loadCall?.[0].items as { role: string; id: string }[];
		const assistant = items.find((item) => item.role === "assistant");
		expect(pendingIdRef.current).toBe(assistant?.id);
		expect(dispatch).toHaveBeenCalledWith({
			type: "RESUME_ASSISTANT",
			id: assistant?.id,
		});
	});

	it("forwards replay events after reusing the persisted in-flight assistant", async () => {
		const dispatch = vi.fn();
		const historyReadyRef = { current: false };
		const pendingIdRef = { current: null as string | null };
		const sessionIdRef = { current: "sess-1" };

		vi.mocked(getSessionDataFn).mockResolvedValue([
			makeRow("user", "go", 1000),
			makeAssistantRowWithTools(["tu-1"]),
		]);

		// Buffer contains duplicate tu-1 events, a fresh tu-2, an offset-aware
		// chunk (the reducer can safely reconcile it), and an ask_user_question.
		const readyStates: boolean[] = [];
		const handleWsMessage = vi.fn((_message: ServerMessage) => {
			readyStates.push(historyReadyRef.current);
		});
		vi.mocked(wsStore.drainMessageBuffer).mockReturnValue([
			{ type: "tool_event", id: "tu-1", name: "Read", input: {} },
			{ type: "tool_result", id: "tu-1", content: "duplicate" },
			{ type: "tool_event", id: "tu-2", name: "Read", input: {} },
			{ type: "chunk", text: "live text", offset: 0 },
			{
				type: "ask_user_question",
				id: "aq-1",
				questions: [{ question: "?", options: ["a"], multiSelect: false }],
			},
		]);

		renderHistory({
			existingSessionId: "sess-1",
			isExplicitSession: true,
			dispatch,
			pendingIdRef,
			historyReadyRef,
			handleWsMessage,
			wsStatus: "connected",
			sessionIdRef,
		});

		await act(async () => {});

		const forwarded = handleWsMessage.mock.calls.map((c) => c[0]);
		expect(readyStates.every(Boolean)).toBe(true);
		expect(forwarded).toEqual([
			{ type: "tool_event", id: "tu-1", name: "Read", input: {} },
			{ type: "tool_result", id: "tu-1", content: "duplicate" },
			{ type: "tool_event", id: "tu-2", name: "Read", input: {} },
			{ type: "chunk", text: "live text", offset: 0 },
			{
				type: "ask_user_question",
				id: "aq-1",
				questions: [{ question: "?", options: ["a"], multiSelect: false }],
			},
		]);
	});
});
