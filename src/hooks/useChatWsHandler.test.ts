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
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

vi.mock("#/lib/utils", () => ({
	uid: vi.fn().mockReturnValue("test-uid"),
}));

import { useChatWsHandler } from "./useChatWsHandler";

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
});

describe("useChatWsHandler — immediate messages", () => {
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
		handler({ type: "chunk", text: "first" });
		handler({ type: "chunk", text: " second" });
		expect(refs.pendingIdRef.current).toBe("test-uid");
		expect(dispatch.mock.calls).toEqual([
			[{ type: "ADD_ASSISTANT", id: "test-uid" }],
			[{ type: "APPEND_CHUNK", id: "test-uid", text: "first" }],
			[{ type: "APPEND_CHUNK", id: "test-uid", text: " second" }],
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
		handler({ type: "error", message: "connection lost" });
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
