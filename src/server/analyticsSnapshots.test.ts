import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	markAnalyticsChanged,
	resetAnalyticsRevisionForTest,
} from "../db/analyticsRevision";
import {
	readAnalyticsSnapshot,
	resetAnalyticsSnapshotsForTest,
} from "./analyticsSnapshots";

describe("analytics snapshots", () => {
	beforeEach(() => {
		resetAnalyticsRevisionForTest();
		resetAnalyticsSnapshotsForTest();
		vi.useRealTimers();
	});

	it("reuses a successful value until its authoritative scope changes", async () => {
		const load = vi
			.fn<() => Promise<number>>()
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(2);

		expect(await readAnalyticsSnapshot("stats", "dashboard", load)).toBe(1);
		expect(await readAnalyticsSnapshot("stats", "dashboard", load)).toBe(1);
		expect(load).toHaveBeenCalledTimes(1);

		markAnalyticsChanged(["activity"], "unrelated");
		expect(await readAnalyticsSnapshot("stats", "dashboard", load)).toBe(1);

		markAnalyticsChanged(["stats"], "query_recorded");
		expect(await readAnalyticsSnapshot("stats", "dashboard", load)).toBe(2);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("single-flights concurrent reads", async () => {
		let resolve!: (value: number) => void;
		const load = vi.fn(
			() =>
				new Promise<number>((done) => {
					resolve = done;
				}),
		);

		const first = readAnalyticsSnapshot("activity", "ledger", load);
		const second = readAnalyticsSnapshot("activity", "ledger", load);
		expect(load).toHaveBeenCalledTimes(1);
		resolve(42);
		await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
	});

	it("does not let an old in-flight revision overwrite a newer snapshot", async () => {
		let resolveOld!: (value: number) => void;
		const oldLoad = vi.fn(
			() =>
				new Promise<number>((done) => {
					resolveOld = done;
				}),
		);
		const freshLoad = vi.fn().mockResolvedValue(2);

		const oldRead = readAnalyticsSnapshot("stats", "dashboard", oldLoad);
		markAnalyticsChanged(["stats"], "query_recorded");
		expect(await readAnalyticsSnapshot("stats", "dashboard", freshLoad)).toBe(
			2,
		);
		resolveOld(1);
		await expect(oldRead).resolves.toBe(1);

		expect(await readAnalyticsSnapshot("stats", "dashboard", freshLoad)).toBe(
			2,
		);
		expect(freshLoad).toHaveBeenCalledTimes(1);
	});

	it("expires time-sensitive snapshots and never retains errors", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
		const load = vi
			.fn<() => Promise<number>>()
			.mockRejectedValueOnce(new Error("temporary"))
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(2);

		await expect(
			readAnalyticsSnapshot("providerUsage", "claude", load, {
				maxAgeMs: 15_000,
			}),
		).rejects.toThrow("temporary");
		expect(
			await readAnalyticsSnapshot("providerUsage", "claude", load, {
				maxAgeMs: 15_000,
			}),
		).toBe(1);

		vi.advanceTimersByTime(15_001);
		expect(
			await readAnalyticsSnapshot("providerUsage", "claude", load, {
				maxAgeMs: 15_000,
			}),
		).toBe(2);
	});
});
