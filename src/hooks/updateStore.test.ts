/**
 * updateStore — module-level singleton with subscribe/snapshot/fetch.
 * Mirrors the wsStore/privacyStore test pattern: __resetForTesting() between
 * tests, fetch is stubbed via vi.stubGlobal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "./updateStore";
import * as store from "./updateStore";

function makeStatus(overrides?: Partial<UpdateStatus>): UpdateStatus {
	return {
		current: "0.0.61",
		latest: "0.0.62",
		available: true,
		lastCheckedAt: 1_700_000_000_000,
		...overrides,
	};
}

beforeEach(() => {
	store.__resetForTesting();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("getUpdateSnapshot", () => {
	it("returns null initially", () => {
		expect(store.getUpdateSnapshot()).toBeNull();
	});

	it("returns the status after setUpdateStatus", () => {
		const s = makeStatus();
		store.setUpdateStatus(s);
		expect(store.getUpdateSnapshot()).toEqual(s);
	});
});

describe("getUpdateServerSnapshot", () => {
	it("always returns null (no window on server)", () => {
		expect(store.getUpdateServerSnapshot()).toBeNull();
		store.setUpdateStatus(makeStatus());
		expect(store.getUpdateServerSnapshot()).toBeNull();
	});
});

describe("setUpdateStatus", () => {
	it("replaces the snapshot", () => {
		store.setUpdateStatus(makeStatus({ available: false }));
		expect(store.getUpdateSnapshot()?.available).toBe(false);
		store.setUpdateStatus(makeStatus({ available: true }));
		expect(store.getUpdateSnapshot()?.available).toBe(true);
	});

	it("notifies subscribers", () => {
		const cb = vi.fn();
		store.subscribeUpdateStatus(cb);
		store.setUpdateStatus(makeStatus());
		expect(cb).toHaveBeenCalledTimes(1);
	});
});

describe("subscribeUpdateStatus", () => {
	it("returns an unsubscribe function", () => {
		const unsub = store.subscribeUpdateStatus(vi.fn());
		expect(typeof unsub).toBe("function");
	});

	it("unsubscribed listener is not notified", () => {
		const cb = vi.fn();
		const unsub = store.subscribeUpdateStatus(cb);
		unsub();
		store.setUpdateStatus(makeStatus());
		expect(cb).not.toHaveBeenCalled();
	});

	it("notifies multiple subscribers in order", () => {
		const a = vi.fn();
		const b = vi.fn();
		store.subscribeUpdateStatus(a);
		store.subscribeUpdateStatus(b);
		store.setUpdateStatus(makeStatus());
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it("only unsubscribes the specific listener", () => {
		const a = vi.fn();
		const b = vi.fn();
		const unsubA = store.subscribeUpdateStatus(a);
		store.subscribeUpdateStatus(b);
		unsubA();
		store.setUpdateStatus(makeStatus());
		expect(a).not.toHaveBeenCalled();
		expect(b).toHaveBeenCalledTimes(1);
	});
});

describe("fetchUpdateStatus", () => {
	it("populates snapshot from /api/updates on success", async () => {
		const s = makeStatus();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({ ok: true, data: s }),
			}),
		);
		await store.fetchUpdateStatus();
		expect(store.getUpdateSnapshot()).toEqual(s);
	});

	it("calls subscribers after a successful fetch", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({ ok: true, data: makeStatus() }),
			}),
		);
		const cb = vi.fn();
		store.subscribeUpdateStatus(cb);
		await store.fetchUpdateStatus();
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("does not refetch on a second call (idempotent)", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			json: async () => ({ ok: true, data: makeStatus() }),
		});
		vi.stubGlobal("fetch", fetchMock);
		await store.fetchUpdateStatus();
		await store.fetchUpdateStatus();
		await store.fetchUpdateStatus();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("coalesces concurrent calls onto a single in-flight fetch", async () => {
		// Two mounts in the same tick (banner + sidebar) must share one
		// network round-trip — a plain boolean guard races because both
		// callers can pass the check before either marks the work done.
		let resolveFetch: ((value: unknown) => void) | undefined;
		const fetchMock = vi.fn().mockReturnValue(
			new Promise((resolve) => {
				resolveFetch = resolve;
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const p1 = store.fetchUpdateStatus();
		const p2 = store.fetchUpdateStatus();
		const p3 = store.fetchUpdateStatus();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		resolveFetch?.({
			json: async () => ({ ok: true, data: makeStatus() }),
		});
		await Promise.all([p1, p2, p3]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reconciles a background-refreshed snapshot exactly once", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				json: async () => ({
					ok: true,
					data: makeStatus({ refreshing: true, available: false }),
				}),
			})
			.mockResolvedValueOnce({
				json: async () => ({ ok: true, data: makeStatus() }),
			});
		vi.stubGlobal("fetch", fetchMock);

		await store.fetchUpdateStatus();
		expect(store.getUpdateSnapshot()?.available).toBe(false);
		await vi.advanceTimersByTimeAsync(25_000);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(store.getUpdateSnapshot()?.available).toBe(true);
		await vi.advanceTimersByTimeAsync(24_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("leaves snapshot null when the response is not ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({ ok: false }),
			}),
		);
		await store.fetchUpdateStatus();
		expect(store.getUpdateSnapshot()).toBeNull();
	});

	it("does not notify subscribers when the response is not ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({ ok: false }),
			}),
		);
		const cb = vi.fn();
		store.subscribeUpdateStatus(cb);
		await store.fetchUpdateStatus();
		expect(cb).not.toHaveBeenCalled();
	});

	it("allows retry after a not-ok response (does not lock subsequent fetches)", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				json: async () => ({ ok: false }),
			})
			.mockResolvedValueOnce({
				json: async () => ({ ok: true, data: makeStatus() }),
			});
		vi.stubGlobal("fetch", fetchMock);

		await store.fetchUpdateStatus();
		expect(store.getUpdateSnapshot()).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// `didFetch` must stay false on an ok:false response — otherwise the
		// banner/sidebar dot stays empty until a page refresh.
		await store.fetchUpdateStatus();
		expect(store.getUpdateSnapshot()).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("allows retry after a network error", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce({
				json: async () => ({ ok: true, data: makeStatus() }),
			});
		vi.stubGlobal("fetch", fetchMock);

		await store.fetchUpdateStatus();
		expect(store.getUpdateSnapshot()).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Second call should hit the network again since `didFetch` stayed
		// false through the rejected promise.
		await store.fetchUpdateStatus();
		expect(store.getUpdateSnapshot()).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("__resetForTesting", () => {
	it("clears the snapshot, the didFetch flag, and the listeners", async () => {
		const cb = vi.fn();
		store.subscribeUpdateStatus(cb);
		store.setUpdateStatus(makeStatus());

		store.__resetForTesting();

		expect(store.getUpdateSnapshot()).toBeNull();
		// Listener from before reset is dropped.
		store.setUpdateStatus(makeStatus());
		expect(cb).toHaveBeenCalledTimes(1); // once from before reset; not after

		// `fetched` flag is reset — a new fetch should hit the network.
		const fetchMock = vi.fn().mockResolvedValue({
			json: async () => ({ ok: true, data: makeStatus() }),
		});
		vi.stubGlobal("fetch", fetchMock);
		await store.fetchUpdateStatus();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
