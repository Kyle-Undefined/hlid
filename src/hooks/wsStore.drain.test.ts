/**
 * wsStore — Slice A drain behavior tests.
 *
 * New semantics: enqueueChat sends to the server immediately (server-side
 * queue accepts mid-run). Client queue mirrors what's still in flight; items
 * are removed when their `done` event arrives. WS-closed enqueues remain in
 * the queue and drain on next ws.onopen.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as wsStore from "./wsStore";
import { type MockWs, makeMockWs, WS_STATES } from "./wsStore.test-utils";

let currentWs: MockWs;
let wsCtorSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	currentWs = makeMockWs(WS_STATES.OPEN);
	// biome-ignore lint/complexity/useArrowFunction: constructor mock for Vitest 4
	wsCtorSpy = vi.fn().mockImplementation(function () {
		return currentWs;
	});
	vi.stubGlobal("WebSocket", Object.assign(wsCtorSpy, WS_STATES));
	wsStore.__resetForTesting();
	// Bring the store's internal _ws up to OPEN by triggering a visibility
	// connect — mirrors the production lifecycle so enqueueChat sees a live ws.
	Object.defineProperty(document, "visibilityState", {
		value: "visible",
		writable: true,
		configurable: true,
	});
	document.dispatchEvent(new Event("visibilitychange"));
	// Module-load-time connect() may have run too; the latest ws is currentWs.
	currentWs.onopen?.();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("wsStore — Slice A: immediate-send drain", () => {
	it("enqueueChat sends a chat message to the server immediately when ws is open", () => {
		wsStore.enqueueChat({ id: "m1", text: "hello", session_id: "s1" });

		const sentChats = currentWs.send.mock.calls
			.map((c) => JSON.parse(c[0] as string))
			.filter((m) => m.type === "chat");
		expect(sentChats).toHaveLength(1);
		expect(sentChats[0]).toMatchObject({
			type: "chat",
			text: "hello",
			session_id: "s1",
		});
	});

	it("preserves plan and HTML flags when a Raven turn is queued", () => {
		wsStore.enqueueChat({
			id: "plan-1",
			text: "make a plan",
			session_id: "s1",
			plan_mode: true,
			plan_html: true,
		});

		const sent = currentWs.send.mock.calls
			.map((call) => JSON.parse(call[0] as string))
			.find((message) => message.type === "chat");
		expect(sent).toMatchObject({
			turn_id: "plan-1",
			plan_mode: true,
			plan_html: true,
		});
	});

	it("enqueueChat retains the item in the client queue after sending", () => {
		wsStore.enqueueChat({ id: "m1", text: "hello", session_id: "s1" });
		expect(wsStore.getQueue()).toHaveLength(1);
		expect(wsStore.getQueue()[0].id).toBe("m1");
	});

	it("done event removes the queued item matching its turn_id (not just the head)", () => {
		wsStore.enqueueChat({ id: "m1", text: "first", session_id: "s1" });
		wsStore.enqueueChat({ id: "m2", text: "second", session_id: "s1" });
		expect(wsStore.getQueue()).toHaveLength(2);

		// Simulate server emitting `done` for the first turn — turn_id must
		// match queue head so the client pops it (Slice C correlation).
		currentWs.onmessage?.({
			data: JSON.stringify({
				type: "done",
				session_id: "s1",
				turn_id: "m1",
				cost: 0,
				turns: 1,
				duration_ms: 0,
				input_tokens: 0,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_creation_tokens: 0,
				context_window: 200000,
				max_output_tokens: 4096,
				stop_reason: "end_turn",
				tokens_in_context: 0,
			}),
		});

		expect(wsStore.getQueue()).toHaveLength(1);
		expect(wsStore.getQueue()[0].id).toBe("m2");
	});

	it("does NOT drain the queue on status=idle (server now manages drain order)", () => {
		wsStore.enqueueChat({ id: "m1", text: "x", session_id: "s1" });
		const sendCountBefore = currentWs.send.mock.calls.filter(
			(c) => JSON.parse(c[0] as string).type === "chat",
		).length;

		// status=idle from server should NOT trigger any extra drain send.
		currentWs.onmessage?.({
			data: JSON.stringify({ type: "status", state: "idle", model: "x" }),
		});

		const sendCountAfter = currentWs.send.mock.calls.filter(
			(c) => JSON.parse(c[0] as string).type === "chat",
		).length;
		expect(sendCountAfter).toBe(sendCountBefore);
	});

	it("enqueueChat with ws closed retains the item without sending", () => {
		currentWs.readyState = WS_STATES.CLOSED;
		currentWs.send.mockClear();
		wsStore.enqueueChat({ id: "m1", text: "deferred", session_id: "s1" });
		expect(wsStore.getQueue()).toHaveLength(1);
		expect(currentWs.send).not.toHaveBeenCalled();
	});

	it("multiple enqueues send each chat as a separate message (no \\n\\n batching)", () => {
		wsStore.enqueueChat({ id: "m1", text: "first", session_id: "s1" });
		wsStore.enqueueChat({ id: "m2", text: "second", session_id: "s1" });

		const sentChats = currentWs.send.mock.calls
			.map((c) => JSON.parse(c[0] as string))
			.filter((m) => m.type === "chat");
		expect(sentChats).toHaveLength(2);
		expect(sentChats[0].text).toBe("first");
		expect(sentChats[1].text).toBe("second");
	});

	it("removeFromQueue still works for local UI removal (cancel button)", () => {
		wsStore.enqueueChat({ id: "m1", text: "x", session_id: "s1" });
		const removed = wsStore.removeFromQueue("m1");
		expect(removed?.id).toBe("m1");
		expect(wsStore.getQueue()).toHaveLength(0);
	});

	it("removeFromQueue sends cancel_queued to server for already-sent items (Slice C)", () => {
		wsStore.enqueueChat({ id: "m1", text: "x", session_id: "s1" });
		// Item is auto-sent on enqueue; clear send history so we only see the
		// cancel_queued msg next.
		currentWs.send.mockClear();
		wsStore.removeFromQueue("m1");
		const sent = currentWs.send.mock.calls
			.map((c) => JSON.parse(c[0] as string))
			.filter((m) => m.type === "cancel_queued");
		expect(sent).toEqual([{ type: "cancel_queued", turn_id: "m1" }]);
	});

	it("done event without matching turn_id leaves the queue intact", () => {
		wsStore.enqueueChat({ id: "m1", text: "x", session_id: "s1" });
		expect(wsStore.getQueue()).toHaveLength(1);

		// done event from a different turn (no turn_id, or non-matching)
		// should NOT pop the queue head.
		currentWs.onmessage?.({
			data: JSON.stringify({
				type: "done",
				session_id: "s1",
				cost: 0,
				turns: 1,
				duration_ms: 0,
				input_tokens: 0,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_creation_tokens: 0,
				context_window: 200000,
				max_output_tokens: 4096,
				stop_reason: "end_turn",
				tokens_in_context: 0,
			}),
		});

		expect(wsStore.getQueue()).toHaveLength(1);
	});

	it("done event for a non-head turn_id pops the matching item (post-promote)", () => {
		// After a promote, the server may finish a turn that ISN'T at the
		// head of the client's insertion-order queue. The matching item must
		// still pop, otherwise it lingers in the UI until refresh.
		wsStore.enqueueChat({ id: "m1", text: "first", session_id: "s1" });
		wsStore.enqueueChat({ id: "m2", text: "second", session_id: "s1" });
		wsStore.enqueueChat({ id: "m3", text: "third", session_id: "s1" });

		// Server promoted m3 then finished it first.
		currentWs.onmessage?.({
			data: JSON.stringify({
				type: "done",
				session_id: "s1",
				turn_id: "m3",
				cost: 0,
				turns: 1,
				duration_ms: 0,
				input_tokens: 0,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_creation_tokens: 0,
				context_window: 200000,
				max_output_tokens: 4096,
				stop_reason: "end_turn",
				tokens_in_context: 0,
			}),
		});

		const remaining = wsStore.getQueue().map((q) => q.id);
		expect(remaining).toEqual(["m1", "m2"]);
	});

	it("promoteQueued sends promote_queued to server (Slice C)", () => {
		wsStore.enqueueChat({ id: "m1", text: "x", session_id: "s1" });
		currentWs.send.mockClear();
		wsStore.promoteQueued("m1");
		const sent = currentWs.send.mock.calls
			.map((c) => JSON.parse(c[0] as string))
			.filter((m) => m.type === "promote_queued");
		expect(sent).toEqual([{ type: "promote_queued", turn_id: "m1" }]);
	});

	it("queue_state prunes orphan _sent items the server doesn't have (Slice C polish)", () => {
		wsStore.enqueueChat({ id: "m1", text: "a", session_id: "s1" });
		wsStore.enqueueChat({ id: "m2", text: "b", session_id: "s1" });
		wsStore.enqueueChat({ id: "m3", text: "c", session_id: "s1" });
		expect(wsStore.getQueue()).toHaveLength(3);

		// Server reports it has m2 running, m3 queued — m1 is an orphan.
		currentWs.onmessage?.({
			data: JSON.stringify({
				type: "queue_state",
				pending_turn_ids: ["m3"],
				running_turn_id: "m2",
			}),
		});

		const remaining = wsStore.getQueue().map((q) => q.id);
		expect(remaining).toEqual(["m2", "m3"]);
	});

	it("queue_state preserves not-yet-sent items even if server doesn't know them", () => {
		// Item enqueued while ws was down (no _sent flag); server has no record.
		currentWs.readyState = WS_STATES.CLOSED;
		wsStore.enqueueChat({ id: "m1", text: "deferred", session_id: "s1" });
		currentWs.readyState = WS_STATES.OPEN;

		currentWs.onmessage?.({
			data: JSON.stringify({
				type: "queue_state",
				pending_turn_ids: [],
				running_turn_id: null,
			}),
		});

		expect(wsStore.getQueue().map((q) => q.id)).toEqual(["m1"]);
	});

	it("removeFromQueue does NOT send cancel_queued for items not yet sent (ws closed at enqueue)", () => {
		currentWs.readyState = WS_STATES.CLOSED;
		currentWs.send.mockClear();
		wsStore.enqueueChat({ id: "m1", text: "deferred", session_id: "s1" });
		wsStore.removeFromQueue("m1");
		// Nothing was ever sent → no cancel_queued needed (server has no
		// record of this turn_id).
		expect(currentWs.send).not.toHaveBeenCalled();
	});
});
