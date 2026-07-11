import { describe, expect, it, vi } from "vitest";
import { SessionTurnQueue } from "./sessionTurnQueue";

describe("SessionTurnQueue", () => {
	it("preserves FIFO order and exposes only identified turns", () => {
		const queue = new SessionTurnQueue<[string]>();
		void queue.enqueue(["first"], "one");
		void queue.enqueue(["anonymous"]);
		void queue.enqueue(["third"], "three");
		expect(queue.length).toBe(3);
		expect(queue.pendingTurnIds()).toEqual(["one", "three"]);
		expect(queue.shift()?.args).toEqual(["first"]);
		expect(queue.shift()?.args).toEqual(["anonymous"]);
		expect(queue.shift()?.args).toEqual(["third"]);
	});

	it("cancels and resolves a pending turn", async () => {
		const queue = new SessionTurnQueue<[]>();
		const resolved = vi.fn();
		const pending = queue.enqueue([], "cancel-me").then(resolved);
		expect(queue.cancel("missing")).toBe(false);
		expect(queue.cancel("cancel-me")).toBe(true);
		await pending;
		expect(resolved).toHaveBeenCalledOnce();
		expect(queue.length).toBe(0);
	});

	it("promotes a pending turn without settling it", () => {
		const queue = new SessionTurnQueue<[string]>();
		void queue.enqueue(["one"], "one");
		void queue.enqueue(["two"], "two");
		void queue.enqueue(["three"], "three");
		expect(queue.promote("three")).toBe(true);
		expect(queue.pendingTurnIds()).toEqual(["three", "one", "two"]);
		expect(queue.promote("missing")).toBe(false);
	});

	it("resolves all queued work when a session is cleared", async () => {
		const queue = new SessionTurnQueue<[]>();
		const first = queue.enqueue([], "one");
		const second = queue.enqueue([], "two");
		queue.resolveAll();
		await expect(Promise.all([first, second])).resolves.toEqual([
			undefined,
			undefined,
		]);
		expect(queue.length).toBe(0);
	});

	it("allows the executor to settle success and failure", async () => {
		const queue = new SessionTurnQueue<[]>();
		const success = queue.enqueue([], "success");
		queue.shift()?.resolve();
		await expect(success).resolves.toBeUndefined();

		const failure = queue.enqueue([], "failure");
		queue.shift()?.reject(new Error("turn failed"));
		await expect(failure).rejects.toThrow("turn failed");
	});
});
