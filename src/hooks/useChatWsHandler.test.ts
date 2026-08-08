/**
 * useChatWsHandler — unit tests for the WS message handler hook.
 *
 * Strategy: renderHook in jsdom to get the stable callback, then call it
 * directly with typed ServerMessage payloads. Mocks uid() to a fixed string
 * so dispatch call assertions are deterministic.
 */
// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "#/components/chat/chatReducer";
import { clearChatQueue, enqueueLocalChat } from "#/hooks/wsChatQueueStore";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

vi.mock("#/lib/utils", () => ({
	uid: vi.fn().mockReturnValue("test-uid"),
}));

import { useChatWsHandler } from "./useChatWsHandler";

beforeEach(() => {
	clearChatQueue();
});

function makeRefs() {
	return {
		pendingIdRef: { current: null as string | null },
		lastAssistantIdRef: { current: null as string | null },
		historyReadyRef: { current: true },
		sessionIdRef: { current: "session-1" },
	};
}

function renderHandler(
	options: {
		historyReady?: boolean;
		pendingId?: string | null;
		lastAssistantId?: string | null;
	} = {},
) {
	const dispatch = vi.fn<(action: Action) => void>();
	const setRateLimit = vi.fn<(rateLimit: RateLimitMessage | null) => void>();
	const refs = makeRefs();
	refs.historyReadyRef.current = options.historyReady ?? true;
	refs.pendingIdRef.current = options.pendingId ?? null;
	refs.lastAssistantIdRef.current = options.lastAssistantId ?? null;
	const { result } = renderHook(() =>
		useChatWsHandler({ dispatch, ...refs, setRateLimit }),
	);
	return { handler: result.current, dispatch, setRateLimit, refs };
}

// ── local_command_output ───────────────────────────────────────────────────────

describe("useChatWsHandler — local_command_output", () => {
	let dispatch: ReturnType<typeof vi.fn<(action: Action) => void>>;
	let setRateLimit: ReturnType<
		typeof vi.fn<(rateLimit: RateLimitMessage | null) => void>
	>;

	beforeEach(() => {
		dispatch = vi.fn();
		setRateLimit = vi.fn();
	});

	it("dispatches ADD_LOCAL_COMMAND_OUTPUT with a uid and content", () => {
		const refs = makeRefs();
		const { result } = renderHook(() =>
			useChatWsHandler({ dispatch, ...refs, setRateLimit }),
		);

		result.current({ type: "local_command_output", content: "/help output" });

		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch).toHaveBeenCalledWith({
			type: "ADD_LOCAL_COMMAND_OUTPUT",
			id: "test-uid",
			content: "/help output",
		});
	});

	it("retains a durable transcript id when the server supplies one", () => {
		const refs = makeRefs();
		const { result } = renderHook(() =>
			useChatWsHandler({ dispatch, ...refs, setRateLimit }),
		);

		result.current({
			type: "local_command_output",
			id: "persisted-message:42",
			content: "Claude started a new native context",
		});

		expect(dispatch).toHaveBeenCalledWith({
			type: "ADD_LOCAL_COMMAND_OUTPUT",
			id: "persisted-message:42",
			content: "Claude started a new native context",
		});
	});

	it("does not dispatch when history is not yet ready", () => {
		const refs = makeRefs();
		refs.historyReadyRef.current = false;
		const { result } = renderHook(() =>
			useChatWsHandler({ dispatch, ...refs, setRateLimit }),
		);

		result.current({ type: "local_command_output", content: "/help output" });

		expect(dispatch).not.toHaveBeenCalled();
	});

	it("returns early after dispatching (does not fall through to other handlers)", () => {
		const refs = makeRefs();
		refs.pendingIdRef.current = "active-turn";
		const { result } = renderHook(() =>
			useChatWsHandler({ dispatch, ...refs, setRateLimit }),
		);

		result.current({ type: "local_command_output", content: "cmd result" });

		// Only ADD_LOCAL_COMMAND_OUTPUT should fire — no APPEND_CHUNK or DONE
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ type: "ADD_LOCAL_COMMAND_OUTPUT" }),
		);
	});
});

describe("useChatWsHandler — session id domains", () => {
	it("does not compare pool session_id tags against the DB session id ref", () => {
		const dispatch = vi.fn();
		const setRateLimit = vi.fn();
		const refs = makeRefs();
		refs.sessionIdRef.current = "db-session-id";
		refs.pendingIdRef.current = "assistant-1";

		const { result } = renderHook(() =>
			useChatWsHandler({ dispatch, ...refs, setRateLimit }),
		);

		result.current({
			type: "done",
			session_id: "pool-session-id",
			cost: null,
			turns: 1,
			duration_ms: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			context_window: null,
			max_output_tokens: null,
			stop_reason: null,
			tokens_in_context: null,
		});

		expect(dispatch).toHaveBeenCalledWith({
			type: "DONE",
			id: "assistant-1",
			cost: null,
		});
		expect(refs.pendingIdRef.current).toBeNull();
	});

	it("forwards db_id from a done message as dbId so the row can be branched from without a reload", () => {
		const dispatch = vi.fn();
		const setRateLimit = vi.fn();
		const refs = makeRefs();
		refs.sessionIdRef.current = "db-session-id";
		refs.pendingIdRef.current = "assistant-1";

		const { result } = renderHook(() =>
			useChatWsHandler({ dispatch, ...refs, setRateLimit }),
		);

		result.current({
			type: "done",
			session_id: "pool-session-id",
			db_id: 42,
			cost: null,
			turns: 1,
			duration_ms: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			context_window: null,
			max_output_tokens: null,
			stop_reason: null,
			tokens_in_context: null,
		});

		expect(dispatch).toHaveBeenCalledWith({
			type: "DONE",
			id: "assistant-1",
			cost: null,
			dbId: 42,
		});
	});

	it("marks the completed live user turn as having a context receipt", () => {
		const dispatch = vi.fn();
		const refs = makeRefs();
		refs.pendingIdRef.current = "assistant-1";
		const { result } = renderHook(() =>
			useChatWsHandler({ dispatch, ...refs, setRateLimit: vi.fn() }),
		);

		result.current({
			type: "done",
			turn_id: "turn-1",
			cost: null,
			turns: 1,
			duration_ms: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			context_window: null,
			max_output_tokens: null,
			stop_reason: null,
			tokens_in_context: null,
		});

		expect(dispatch).toHaveBeenCalledWith({
			type: "MARK_USER_CONTEXT_RECEIPT",
			id: "turn-1",
		});
	});
});

describe("useChatWsHandler — immediate messages", () => {
	it("attaches targeted Live tools without borrowing the typed-turn pending ref", () => {
		const { handler, dispatch, refs } = renderHandler();
		handler({
			type: "tool_event",
			id: "live-tool-1",
			name: "exec_command",
			input: { cmd: "git status --short" },
			realtime_utterance_id: "utterance-assistant-1",
			realtime_session_id: "realtime-1",
			transcript_seq: 5,
			fork_supported: false,
		});

		expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
			{
				type: "UPSERT_REALTIME_TRANSCRIPT",
				id: "utterance-assistant-1",
				role: "assistant",
				text: "",
				done: false,
				realtimeSessionId: "realtime-1",
				transcriptSeq: 5,
				forkSupported: false,
			},
			{
				type: "ADD_TOOL_EVENT",
				id: "utterance-assistant-1",
				event: expect.objectContaining({
					type: "tool_event",
					id: "live-tool-1",
				}),
			},
		]);
		expect(refs.pendingIdRef.current).toBeNull();
	});

	it("upserts Raven Live transcript deltas with stable wire identity", () => {
		const { handler, dispatch } = renderHandler();
		handler({
			type: "realtime_transcript",
			session_id: "session-1",
			mode: "live",
			role: "user",
			text: "Hello ",
			done: false,
			utterance_id: "utterance-user-1",
			realtime_session_id: "realtime-1",
			transcript_seq: 4,
			source: "codex_realtime",
			fork_supported: false,
		});

		expect(dispatch).toHaveBeenCalledWith({
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-user-1",
			role: "user",
			text: "Hello ",
			done: false,
			realtimeSessionId: "realtime-1",
			transcriptSeq: 4,
			forkSupported: false,
		});
	});

	it("forwards an empty final so the reducer can remove that provisional bubble", () => {
		const { handler, dispatch } = renderHandler();
		handler({
			type: "realtime_transcript",
			session_id: "session-1",
			mode: "live",
			role: "assistant",
			text: " ",
			done: true,
			utterance_id: "private-utterance",
			realtime_session_id: "realtime-1",
			transcript_seq: 5,
			source: "codex_realtime",
			fork_supported: false,
		});

		expect(dispatch).toHaveBeenCalledWith({
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "private-utterance",
			role: "assistant",
			text: " ",
			done: true,
			realtimeSessionId: "realtime-1",
			transcriptSeq: 5,
			forkSupported: false,
		});
	});

	it("leaves one-shot dictation transcripts to their dedicated consumer", () => {
		const { handler, dispatch } = renderHandler();
		handler({
			type: "realtime_transcript",
			session_id: "session-1",
			mode: "dictation",
			role: "user",
			text: "Typed from dictation",
			done: true,
		});

		expect(dispatch).not.toHaveBeenCalled();
	});

	it("discards provisional Live bubbles when the realtime call closes", () => {
		const { handler, dispatch } = renderHandler();
		handler({
			type: "realtime_state",
			session_id: "session-1",
			mode: "live",
			state: "closed",
		});

		expect(dispatch).toHaveBeenCalledWith({
			type: "DISCARD_REALTIME_PARTIALS",
		});
	});

	it("marks the exact user turn when Claude captures a file checkpoint", () => {
		const { handler, dispatch } = renderHandler();
		handler({
			type: "file_checkpoint",
			session_id: "session-1",
			turn_id: "turn-1",
		});

		expect(dispatch).toHaveBeenCalledWith({
			type: "MARK_USER_FILE_CHECKPOINT",
			id: "turn-1",
		});
	});

	it("moves an accepted steer before the active assistant response", () => {
		const { handler, dispatch } = renderHandler({
			pendingId: "assistant-1",
		});
		handler({
			type: "turn_steered",
			turn_id: "steer-1",
			target_turn_id: "original-turn",
			target_assistant_seq: 7,
			steer_seq: 8,
			steer_tool_event_index: 3,
			session_id: "session-1",
		});

		expect(dispatch).toHaveBeenCalledWith({
			type: "STEER_USER",
			turnId: "steer-1",
			targetTurnId: "original-turn",
			targetAssistantSeq: 7,
			steerSeq: 8,
			steerToolEventIndex: 3,
			assistantId: "assistant-1",
		});
	});

	it("materializes a queued steer before its acknowledgement removes it", () => {
		enqueueLocalChat({
			id: "steer-from-queue",
			text: "Use the narrower approach",
			session_id: "session-1",
			vault_references: ["Plans/Current.md"],
			_sent: true,
		});
		const { handler, dispatch } = renderHandler({
			pendingId: "assistant-1",
		});

		handler({
			type: "turn_steered",
			turn_id: "steer-from-queue",
			target_turn_id: "original-turn",
			target_assistant_seq: 7,
			steer_seq: 8,
			session_id: "session-1",
		});

		expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
			{
				type: "ADD_USER",
				id: "steer-from-queue",
				text: "Use the narrower approach\n\nVault references:\n- Plans/Current.md",
			},
			{
				type: "STEER_USER",
				turnId: "steer-from-queue",
				targetTurnId: "original-turn",
				targetAssistantSeq: 7,
				steerSeq: 8,
				assistantId: "assistant-1",
			},
		]);
	});

	it("moves a late steer acknowledgement above the just-completed response", () => {
		const { handler, dispatch } = renderHandler({
			lastAssistantId: "assistant-1",
		});
		handler({
			type: "turn_steered",
			turn_id: "steer-1",
			target_turn_id: "original-turn",
			session_id: "session-1",
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "STEER_USER",
			turnId: "steer-1",
			targetTurnId: "original-turn",
			assistantId: "assistant-1",
		});
	});

	it("keeps the exact target when a newer response is already active", () => {
		const { handler, dispatch } = renderHandler({
			pendingId: "new-assistant",
			lastAssistantId: "old-assistant",
		});
		handler({
			type: "turn_steered",
			turn_id: "steer-1",
			target_turn_id: "old-turn",
			session_id: "session-1",
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "STEER_USER",
			turnId: "steer-1",
			targetTurnId: "old-turn",
			assistantId: "new-assistant",
		});
	});

	it("ignores a legacy steer acknowledgement without a known response", () => {
		const { handler, dispatch } = renderHandler();
		handler({
			type: "turn_steered",
			turn_id: "steer-1",
			session_id: "session-1",
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("falls back to the known response for a legacy steer acknowledgement", () => {
		const { handler, dispatch } = renderHandler({
			pendingId: "assistant-1",
		});
		handler({
			type: "turn_steered",
			turn_id: "steer-1",
			session_id: "session-1",
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "STEER_USER",
			turnId: "steer-1",
			assistantId: "assistant-1",
		});
	});

	it("renders live vault references without waiting for history refresh", () => {
		const { handler, dispatch } = renderHandler();
		handler({
			type: "user_message",
			id: "user-1",
			text: "Compare these",
			vault_references: ["Projects/Hlid.md", "Notes/Decision.md"],
		});

		expect(dispatch).toHaveBeenCalledWith({
			type: "ADD_USER",
			id: "user-1",
			text: "Compare these\n\nVault references:\n- Projects/Hlid.md\n- Notes/Decision.md",
		});
	});

	it("renders multiple live workspace revisions without waiting for history refresh", () => {
		const { handler, dispatch } = renderHandler();
		handler({
			type: "user_message",
			id: "user-workspace",
			text: "Compare these",
			workspace_references: [
				{ relativePath: "src/app.ts", sha256: "a".repeat(64) },
				{ relativePath: "screens/pixel.png", sha256: "b".repeat(64) },
			],
		});

		expect(dispatch).toHaveBeenCalledWith({
			type: "ADD_USER",
			id: "user-workspace",
			text: `Compare these\n\nWorkspace references:\n- src/app.ts (sha256:${"a".repeat(64)})\n- screens/pixel.png (sha256:${"b".repeat(64)})`,
		});
	});

	it.each([
		"idle",
		"error",
	] as const)("settles stale subagents when the session becomes %s", (state) => {
		const { handler, dispatch } = renderHandler();
		handler({ type: "status", state, model: "gpt-5.4" });
		expect(dispatch).toHaveBeenCalledWith({
			type: "SETTLE_ACTIVE_SUBAGENTS",
			endedAtMs: expect.any(Number),
		});
	});

	it("stores rate limits without dispatching a chat action", () => {
		const { handler, dispatch, setRateLimit } = renderHandler();
		const message = {
			type: "rate_limit",
			provider: "claude",
			windows: [],
		} as unknown as RateLimitMessage;
		handler(message);
		expect(setRateLimit).toHaveBeenCalledWith(message);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it.each<[ServerMessage, Action]>([
		[
			{ type: "user_message", id: "user-1", text: "hello" },
			{ type: "ADD_USER", id: "user-1", text: "hello" },
		],
		[
			{
				type: "assistant_revision",
				session_id: "session-1",
				transcript_seq: 7,
				current: true,
				text: "canonical",
				removed_tool_ids: ["removed-tool"],
				cleared_tool_result_ids: ["cleared-result"],
				remaining_tool_count: 3,
				remaining_tool_error_count: 1,
				restored_tool_metadata: [
					{
						id: "cleared-result",
						subagent: null,
						taskActivity: {
							kind: "tasks",
							source: "claude-task-store",
							operation: "create",
							items: [{ subject: "Start work", status: "pending" }],
						},
					},
				],
				steer_tool_event_indexes: [],
			},
			{
				type: "REVISE_ASSISTANT",
				transcriptSeq: 7,
				currentAssistantId: "assistant-1",
				text: "canonical",
				removedToolIds: ["removed-tool"],
				clearedToolResultIds: ["cleared-result"],
				remainingToolCount: 3,
				remainingToolErrorCount: 1,
				restoredToolMetadata: [
					{
						toolId: "cleared-result",
						subagent: null,
						taskActivity: {
							kind: "tasks",
							source: "claude-task-store",
							operation: "create",
							items: [{ subject: "Start work", status: "pending" }],
						},
					},
				],
				steerToolEventIndexes: [],
			},
		],
		[
			{
				type: "permission_resolved",
				id: "permission-1",
				toolName: "Bash",
				displayName: "Run command",
				decision: "approved",
			},
			{
				type: "RESOLVE_OR_ADD_PERMISSION",
				id: "permission-1",
				toolName: "Bash",
				displayName: "Run command",
				decision: "approved",
			},
		],
		[
			{
				type: "provider_permission_denied",
				id: "permission-1",
				toolName: "Bash",
				displayName: "Run command",
				providerId: "claude",
				reasonType: "rule",
				reason: "Managed policy",
				providerMessage: "Command blocked",
			},
			{
				type: "REPORT_PROVIDER_PERMISSION_DENIAL",
				id: "permission-1",
				toolName: "Bash",
				displayName: "Run command",
				providerId: "claude",
				reasonType: "rule",
				reason: "Managed policy",
				providerMessage: "Command blocked",
			},
		],
		[
			{
				type: "ask_user_question_resolved",
				id: "question-1",
				answers: { choice: ["yes"] },
				notes: { choice: "because" },
			},
			{
				type: "RESOLVE_ASK_USER_QUESTION",
				id: "question-1",
				answers: { choice: ["yes"] },
				notes: { choice: "because" },
			},
		],
		[
			{
				type: "ask_user_question_provenance_updated",
				id: "question-1",
				provenance: {
					provider_id: "claude",
					kind: "provider_dialog",
					source_name: "peer_inbound_approval",
					peer: {
						preview: "held preview",
						body: "Exact delivered body",
						from_session: "claimed-session-17",
					},
				},
			},
			{
				type: "UPDATE_ASK_USER_QUESTION_PROVENANCE",
				id: "question-1",
				provenance: {
					provider_id: "claude",
					kind: "provider_dialog",
					source_name: "peer_inbound_approval",
					peer: {
						preview: "held preview",
						body: "Exact delivered body",
						from_session: "claimed-session-17",
					},
				},
			},
		],
		[
			{
				type: "plan_mode_exit_resolved",
				id: "plan-1",
				decision: "approved",
			},
			{
				type: "RESOLVE_PLAN_PROPOSAL",
				id: "plan-1",
				decision: "approved",
			},
		],
		[
			{
				type: "tool_result",
				id: "tool-1",
				content: "failed",
				isError: true,
			},
			{
				type: "ADD_TOOL_RESULT",
				toolUseId: "tool-1",
				content: "failed",
				isError: true,
			},
		],
		[
			{
				type: "tool_result",
				id: "tool-compact",
				content: "preview",
				resultTruncated: true,
				resultLength: 50_000,
				detailSessionId: "session-1",
			},
			{
				type: "ADD_TOOL_RESULT",
				toolUseId: "tool-compact",
				content: "preview",
				resultTruncated: true,
				resultLength: 50_000,
				detailSessionId: "session-1",
			},
		],
		[
			{
				type: "tool_update",
				id: "spawn-1",
				subagent: {
					provider: "codex",
					agentId: "child-1",
					status: "running",
					startedAtMs: 1000,
				},
			},
			{
				type: "UPDATE_TOOL_EVENT",
				toolUseId: "spawn-1",
				subagent: {
					provider: "codex",
					agentId: "child-1",
					status: "running",
					startedAtMs: 1000,
				},
			},
		],
		[
			{
				type: "tool_activity_update",
				id: "plan-1",
				taskActivity: {
					kind: "tasks",
					source: "codex-plan",
					operation: "snapshot",
					items: [{ subject: "Test", status: "in_progress" }],
				},
			},
			{
				type: "UPDATE_TOOL_ACTIVITY",
				toolUseId: "plan-1",
				taskActivity: {
					kind: "tasks",
					source: "codex-plan",
					operation: "snapshot",
					items: [{ subject: "Test", status: "in_progress" }],
				},
			},
		],
	])("maps $type to its reducer action", (message, action) => {
		const { handler, dispatch } = renderHandler({ pendingId: "assistant-1" });
		handler(message);
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch).toHaveBeenCalledWith(action);
	});

	it("preserves attachments when a queued user message is re-promoted", () => {
		const { handler, dispatch } = renderHandler();
		const attachments = [
			{
				id: "attachment-1",
				path: "/tmp/image.png",
				filename: "image.png",
				mime: "image/png",
				kind: "ephemeral" as const,
			},
		];
		handler({
			type: "user_message",
			id: "user-1",
			text: "look at this",
			attachments,
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "ADD_USER",
			id: "user-1",
			text: "look at this",
			attachments,
		});
	});

	it("preserves structured plan text and its optional HTML relic", () => {
		const { handler, dispatch } = renderHandler();
		handler({
			type: "plan_mode_exit",
			id: "plan-1",
			input: { plan: { steps: ["one", "two"] } },
			html_relic_id: "relic-1",
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "ADD_PLAN_PROPOSAL",
			id: "plan-1",
			plan: JSON.stringify({ steps: ["one", "two"] }),
			htmlRelicId: "relic-1",
		});
	});
});

describe("useChatWsHandler — assistant lifecycle", () => {
	it("creates one pending assistant and appends every streamed chunk to it", () => {
		const { handler, dispatch, refs } = renderHandler();
		handler({ type: "chunk", text: "first", offset: 0 });
		handler({ type: "chunk", text: " second", offset: 5 });
		expect(refs.pendingIdRef.current).toBe("test-uid");
		expect(dispatch.mock.calls).toEqual([
			[{ type: "ADD_ASSISTANT", id: "test-uid" }],
			[{ type: "APPEND_CHUNK", id: "test-uid", text: "first", offset: 0 }],
			[
				{
					type: "APPEND_CHUNK",
					id: "test-uid",
					text: " second",
					offset: 5,
				},
			],
		]);
	});

	it("dispatches an authoritative chunk as a full text replacement", () => {
		const { handler, dispatch, refs } = renderHandler();
		handler({
			type: "chunk",
			text: "Complete authoritative response.",
			offset: 0,
			replace: true,
		});
		expect(refs.pendingIdRef.current).toBe("test-uid");
		expect(dispatch.mock.calls).toEqual([
			[{ type: "ADD_ASSISTANT", id: "test-uid" }],
			[
				{
					type: "REPLACE_TEXT",
					id: "test-uid",
					text: "Complete authoritative response.",
				},
			],
		]);
	});

	it("anchors a running status to its turn id", () => {
		const { handler, dispatch, refs } = renderHandler();
		handler({
			type: "status",
			state: "running",
			model: "model",
			turn_id: "user-1",
		});
		expect(refs.pendingIdRef.current).toBe("test-uid");
		expect(dispatch).toHaveBeenCalledWith({
			type: "ADD_ASSISTANT",
			id: "test-uid",
			afterUserId: "user-1",
		});
	});

	it("anchors a restored pending assistant to the running turn id", () => {
		const { handler, dispatch } = renderHandler({
			pendingId: "persisted-assistant",
		});
		handler({
			type: "status",
			state: "running",
			model: "model",
			turn_id: "user-1",
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "SET_ASSISTANT_TURN",
			id: "persisted-assistant",
			turnId: "user-1",
		});
	});

	it("completes the active assistant and makes it the recap fallback", () => {
		const { handler, dispatch, refs } = renderHandler({
			pendingId: "assistant-1",
		});
		handler({
			type: "done",
			cost: 0.25,
			turns: 1,
			duration_ms: 1,
			input_tokens: 1,
			output_tokens: 1,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			context_window: null,
			max_output_tokens: null,
			stop_reason: null,
			tokens_in_context: null,
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "DONE",
			id: "assistant-1",
			cost: 0.25,
		});
		expect(refs.pendingIdRef.current).toBeNull();
		expect(refs.lastAssistantIdRef.current).toBe("assistant-1");
	});

	it("turns an error into visible output and closes the pending assistant", () => {
		const { handler, dispatch, refs } = renderHandler({
			pendingId: "assistant-1",
		});
		handler({
			type: "error",
			message: "connection lost",
			turn_scoped: true,
		});
		expect(dispatch.mock.calls).toEqual([
			[
				{
					type: "APPEND_CHUNK",
					id: "assistant-1",
					text: "\n\n[ERROR: connection lost]",
				},
			],
			[{ type: "DONE", id: "assistant-1", cost: null }],
		]);
		expect(refs.pendingIdRef.current).toBeNull();
	});

	it("surfaces a rejected steer without closing the active assistant", () => {
		const { handler, dispatch, refs } = renderHandler({
			pendingId: "assistant-1",
		});

		handler({ type: "error", message: "not steerable" });

		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch).toHaveBeenCalledWith({
			type: "ADD_LOCAL_COMMAND_OUTPUT",
			id: "test-uid",
			content: "ERROR: not steerable",
		});
		expect(refs.pendingIdRef.current).toBe("assistant-1");
	});

	it("ignores a stale turn-scoped error after a newer turn starts", () => {
		const { handler, dispatch, refs } = renderHandler({
			pendingId: "assistant-1",
		});
		handler({
			type: "status",
			state: "running",
			model: "model",
			turn_id: "new-turn",
		});
		dispatch.mockClear();

		handler({
			type: "error",
			message: "old failure",
			turn_scoped: true,
			turn_id: "old-turn",
		});

		expect(dispatch).not.toHaveBeenCalled();
		expect(refs.pendingIdRef.current).toBe("assistant-1");
	});

	it.each([
		[
			"pending",
			{ pendingId: "pending-1", lastAssistantId: "last-1" },
			"pending-1",
		],
		["last", { pendingId: null, lastAssistantId: "last-1" }, "last-1"],
	] as const)("attaches a tool summary to the %s assistant", (_label, refs, id) => {
		const { handler, dispatch } = renderHandler(refs);
		handler({ type: "tool_use_summary", summary: "inspected files" });
		expect(dispatch).toHaveBeenCalledWith({
			type: "SET_RECAP",
			id,
			recap: "inspected files",
		});
	});
});
