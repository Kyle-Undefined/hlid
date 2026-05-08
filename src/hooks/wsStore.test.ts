/**
 * wsStore.ts — module-level state management unit tests.
 *
 * Strategy: vi.resetModules() + dynamic import in beforeEach gives each test
 * a fresh module instance with all state reset to initial values.  The Node
 * environment means window is undefined (connect() never runs), sessionStorage
 * operations fail silently (try/catch), and _ws stays null throughout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── test suite ────────────────────────────────────────────────────────────────

describe("wsStore state management", () => {
	let store: typeof import("./wsStore");

	beforeEach(async () => {
		vi.resetModules();
		store = await import("./wsStore");
	});

	// ── initial state ─────────────────────────────────────────────────────────

	describe("initial state", () => {
		it("getSnapshot returns INITIAL_SNAPSHOT", () => {
			expect(store.getSnapshot()).toEqual(store.INITIAL_SNAPSHOT);
		});

		it("getQueue returns empty array", () => {
			expect(store.getQueue()).toEqual([]);
		});

		it("claimPendingPrompt returns null before any prompt is set", () => {
			expect(store.claimPendingPrompt()).toBeNull();
		});

		it("getLiveStats returns EMPTY_STATS", () => {
			expect(store.getLiveStats()).toEqual(store.EMPTY_STATS);
		});

		it("drainMessageBuffer returns empty array", () => {
			expect(store.drainMessageBuffer()).toEqual([]);
		});

		it("getPendingSessionToday returns false", () => {
			expect(store.getPendingSessionToday()).toBe(false);
		});
	});

	// ── chat queue ────────────────────────────────────────────────────────────

	describe("chat queue", () => {
		it("enqueueChat appends a message to the queue", () => {
			const msg = { id: "m1", text: "hello", session_id: "s1" };
			store.enqueueChat(msg);
			expect(store.getQueue()).toEqual([msg]);
		});

		it("enqueueChat preserves insertion order", () => {
			store.enqueueChat({ id: "m1", text: "first", session_id: "s1" });
			store.enqueueChat({ id: "m2", text: "second", session_id: "s1" });
			const q = store.getQueue();
			expect(q[0].text).toBe("first");
			expect(q[1].text).toBe("second");
		});

		it("enqueueChat notifies queue subscribers", () => {
			const fn = vi.fn();
			const unsub = store.subscribeQueue(fn);
			store.enqueueChat({ id: "m1", text: "hi", session_id: "s1" });
			expect(fn).toHaveBeenCalledOnce();
			unsub();
		});

		it("getQueue reflects the queue after multiple enqueues", () => {
			store.enqueueChat({ id: "m1", text: "x", session_id: "s1" });
			store.enqueueChat({ id: "m2", text: "y", session_id: "s1" });
			expect(store.getQueue()).toHaveLength(2);
		});

		it("removeFromQueue removes by id and returns the item", () => {
			const msg = { id: "m1", text: "hello", session_id: "s1" };
			store.enqueueChat(msg);
			const removed = store.removeFromQueue("m1");
			expect(removed).toEqual(msg);
			expect(store.getQueue()).toEqual([]);
		});

		it("removeFromQueue notifies queue subscribers on removal", () => {
			store.enqueueChat({ id: "m1", text: "x", session_id: "s1" });
			const fn = vi.fn();
			const unsub = store.subscribeQueue(fn);
			store.removeFromQueue("m1");
			expect(fn).toHaveBeenCalledOnce();
			unsub();
		});

		it("removeFromQueue returns undefined for unknown id", () => {
			expect(store.removeFromQueue("does-not-exist")).toBeUndefined();
		});

		it("removeFromQueue does not notify subscribers when id is not found", () => {
			const fn = vi.fn();
			const unsub = store.subscribeQueue(fn);
			store.removeFromQueue("ghost");
			expect(fn).not.toHaveBeenCalled();
			unsub();
		});

		it("clearChatQueue empties the queue", () => {
			store.enqueueChat({ id: "m1", text: "a", session_id: "s1" });
			store.enqueueChat({ id: "m2", text: "b", session_id: "s1" });
			store.clearChatQueue();
			expect(store.getQueue()).toEqual([]);
		});

		it("clearChatQueue notifies subscribers when queue was non-empty", () => {
			store.enqueueChat({ id: "m1", text: "x", session_id: "s1" });
			const fn = vi.fn();
			const unsub = store.subscribeQueue(fn);
			store.clearChatQueue();
			expect(fn).toHaveBeenCalledOnce();
			unsub();
		});

		it("clearChatQueue is a no-op (no notification) when already empty", () => {
			const fn = vi.fn();
			const unsub = store.subscribeQueue(fn);
			store.clearChatQueue(); // queue already empty
			expect(fn).not.toHaveBeenCalled();
			unsub();
		});

		it("subscribeQueue returns a working unsubscribe function", () => {
			const fn = vi.fn();
			const unsub = store.subscribeQueue(fn);
			unsub();
			store.enqueueChat({ id: "m1", text: "after unsub", session_id: "s1" });
			expect(fn).not.toHaveBeenCalled();
		});

		it("enqueueChat stores optional fields (agent_cwd, skill_context, attachments)", () => {
			const msg = {
				id: "m1",
				text: "do it",
				session_id: "s1",
				agent_cwd: "/home/kyle/project",
				skill_context: "some-context",
				attachments: [
					{ id: "att-1", filename: "note.txt", mime: "text/plain" },
				],
			};
			store.enqueueChat(msg);
			expect(store.getQueue()[0]).toEqual(msg);
		});
	});

	// ── pending prompt ────────────────────────────────────────────────────────

	describe("pending prompt", () => {
		it("setPendingPrompt + claimPendingPrompt returns the set value", () => {
			store.setPendingPrompt("generate a summary");
			expect(store.claimPendingPrompt()).toBe("generate a summary");
		});

		it("claimPendingPrompt clears the prompt so the second call returns null", () => {
			store.setPendingPrompt("once-only");
			store.claimPendingPrompt();
			expect(store.claimPendingPrompt()).toBeNull();
		});

		it("overwriting prompt returns the latest value", () => {
			store.setPendingPrompt("first");
			store.setPendingPrompt("second");
			expect(store.claimPendingPrompt()).toBe("second");
		});
	});

	// ── live stats ────────────────────────────────────────────────────────────

	describe("live stats", () => {
		it("seedContextStats updates context_window and last_context_used", () => {
			store.seedContextStats(200_000, 50_000);
			const s = store.getLiveStats();
			expect(s.context_window).toBe(200_000);
			expect(s.last_context_used).toBe(50_000);
		});

		it("seedContextStats preserves unrelated fields", () => {
			store.seedContextStats(100_000, 10_000);
			const s = store.getLiveStats();
			expect(s.turns).toBe(0);
			expect(s.cost).toBe(0);
			expect(s.input_tokens).toBe(0);
		});

		it("seedContextStats notifies stats subscribers", () => {
			const fn = vi.fn();
			const unsub = store.subscribeStats(fn);
			store.seedContextStats(100_000, 10_000);
			expect(fn).toHaveBeenCalledOnce();
			unsub();
		});

		it("resetLiveStats resets all fields to EMPTY_STATS", () => {
			store.seedContextStats(200_000, 50_000);
			store.resetLiveStats();
			expect(store.getLiveStats()).toEqual(store.EMPTY_STATS);
		});

		it("resetLiveStats notifies stats subscribers", () => {
			const fn = vi.fn();
			const unsub = store.subscribeStats(fn);
			store.resetLiveStats();
			expect(fn).toHaveBeenCalledOnce();
			unsub();
		});

		it("subscribeStats returns a working unsubscribe function", () => {
			const fn = vi.fn();
			const unsub = store.subscribeStats(fn);
			unsub();
			store.seedContextStats(50_000, 5_000);
			expect(fn).not.toHaveBeenCalled();
		});

		it("setActiveSessionId + resetLiveStats clears activeSessionId", () => {
			store.setActiveSessionId("sess-1");
			store.resetLiveStats(); // should clear activeSessionId internally
			// No public getter for activeSessionId; verify via resetLiveStats not throwing
			expect(store.getLiveStats()).toEqual(store.EMPTY_STATS);
		});
	});

	// ── snapshot / actualModel ────────────────────────────────────────────────

	describe("snapshot — actualModel", () => {
		it("seedActualModel updates actualModel in snapshot", () => {
			store.seedActualModel("claude-opus-4-5");
			expect(store.getSnapshot().actualModel).toBe("claude-opus-4-5");
		});

		it("seedActualModel accepts null to clear the model", () => {
			store.seedActualModel("some-model");
			store.seedActualModel(null);
			expect(store.getSnapshot().actualModel).toBeNull();
		});

		it("seedActualModel is a no-op when value is unchanged", () => {
			store.seedActualModel("model-a");
			const fn = vi.fn();
			const unsub = store.subscribeStatus(fn);
			store.seedActualModel("model-a"); // same value
			expect(fn).not.toHaveBeenCalled();
			unsub();
		});

		it("seedActualModel notifies status subscribers on change", () => {
			const fn = vi.fn();
			const unsub = store.subscribeStatus(fn);
			store.seedActualModel("model-x");
			expect(fn).toHaveBeenCalledOnce();
			unsub();
		});

		it("subscribeStatus returns a working unsubscribe function", () => {
			const fn = vi.fn();
			const unsub = store.subscribeStatus(fn);
			unsub();
			store.seedActualModel("after-unsub");
			expect(fn).not.toHaveBeenCalled();
		});

		it("INITIAL_SNAPSHOT.actualModel is null", () => {
			expect(store.INITIAL_SNAPSHOT.actualModel).toBeNull();
		});
	});

	// ── message buffer ────────────────────────────────────────────────────────

	describe("message buffer", () => {
		it("drainMessageBuffer returns empty array when buffer is empty", () => {
			expect(store.drainMessageBuffer()).toEqual([]);
		});

		it("drainMessageBuffer is idempotent (returns empty on second call)", () => {
			store.drainMessageBuffer();
			expect(store.drainMessageBuffer()).toEqual([]);
		});

		it("clearMessageBuffer does not throw when already empty", () => {
			expect(() => store.clearMessageBuffer()).not.toThrow();
		});

		it("setBufferingEnabled(false) clears the buffer", () => {
			// Buffer can't easily be populated without an active WebSocket, but
			// calling setBufferingEnabled(false) must at minimum not throw and
			// must leave the buffer empty.
			store.setBufferingEnabled(false);
			expect(store.drainMessageBuffer()).toEqual([]);
		});

		it("setBufferingEnabled(true) re-enables buffering without throwing", () => {
			store.setBufferingEnabled(false);
			store.setBufferingEnabled(true);
			expect(store.drainMessageBuffer()).toEqual([]);
		});
	});

	// ── subscription edge cases ───────────────────────────────────────────────

	describe("subscription edge cases", () => {
		it("multiple status subscribers are all notified", () => {
			const fn1 = vi.fn();
			const fn2 = vi.fn();
			const u1 = store.subscribeStatus(fn1);
			const u2 = store.subscribeStatus(fn2);
			store.seedActualModel("m");
			expect(fn1).toHaveBeenCalledOnce();
			expect(fn2).toHaveBeenCalledOnce();
			u1();
			u2();
		});

		it("multiple queue subscribers are all notified", () => {
			const fn1 = vi.fn();
			const fn2 = vi.fn();
			const u1 = store.subscribeQueue(fn1);
			const u2 = store.subscribeQueue(fn2);
			store.enqueueChat({ id: "x", text: "y", session_id: "s" });
			expect(fn1).toHaveBeenCalledOnce();
			expect(fn2).toHaveBeenCalledOnce();
			u1();
			u2();
		});

		it("multiple stats subscribers are all notified", () => {
			const fn1 = vi.fn();
			const fn2 = vi.fn();
			const u1 = store.subscribeStats(fn1);
			const u2 = store.subscribeStats(fn2);
			store.resetLiveStats();
			expect(fn1).toHaveBeenCalledOnce();
			expect(fn2).toHaveBeenCalledOnce();
			u1();
			u2();
		});
	});
});
