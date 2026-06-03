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

// ── local_command_output ───────────────────────────────────────────────────────

describe("useChatWsHandler — local_command_output", () => {
	let dispatch: ReturnType<typeof vi.fn>;
	let setRateLimit: ReturnType<typeof vi.fn>;

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
