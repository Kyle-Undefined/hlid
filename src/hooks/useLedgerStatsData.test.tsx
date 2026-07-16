// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProvidersFn, getProviderUsagesFn } from "#/lib/serverFns/providers";
import {
	EMPTY_ACTIVITY,
	EMPTY_AGG,
	getActivityStatsFn,
	getCockpitStatsFn,
	getThirtyDayStatsFn,
} from "#/lib/serverFns/stats";
import {
	resetLedgerStatsDataForTest,
	useLedgerStatsData,
} from "./useLedgerStatsData";

vi.mock("#/lib/serverFns/providers", () => ({
	getProvidersFn: vi.fn(),
	getProviderUsagesFn: vi.fn(),
}));

vi.mock("#/lib/serverFns/stats", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("#/lib/serverFns/stats")>();
	return {
		...original,
		getActivityStatsFn: vi.fn(),
		getCockpitStatsFn: vi.fn(),
		getThirtyDayStatsFn: vi.fn(),
	};
});

function deferred<T>() {
	return Promise.withResolvers<T>();
}

const statsData = (sessions: number) => ({
	agg: {
		...EMPTY_AGG,
		allTime: { ...EMPTY_AGG.allTime, sessions },
	},
});

const thirtyDayStats = (total: number) => ({
	total,
	days: [{ date: "2026-07-16", count: total }],
});

const activity = (count: number) => ({
	...EMPTY_ACTIVITY,
	topTools: [{ name: "Read", count, errorRate: 0 }],
});

const providerUsages = [
	{ providerId: "codex", providerLabel: "Codex", windows: [] },
];

beforeEach(() => {
	vi.clearAllMocks();
	resetLedgerStatsDataForTest();
	vi.mocked(getCockpitStatsFn).mockResolvedValue(statsData(1));
	vi.mocked(getThirtyDayStatsFn).mockResolvedValue(thirtyDayStats(2));
	vi.mocked(getActivityStatsFn).mockResolvedValue(activity(3));
	vi.mocked(getProvidersFn).mockResolvedValue([
		{ id: "codex", label: "Codex", available: true },
	]);
	vi.mocked(getProviderUsagesFn).mockResolvedValue(providerUsages);
});

afterEach(cleanup);

describe("useLedgerStatsData", () => {
	it("returns cold defaults immediately while the first refresh is pending", () => {
		vi.mocked(getCockpitStatsFn).mockReturnValue(
			deferred<Awaited<ReturnType<typeof getCockpitStatsFn>>>().promise,
		);
		vi.mocked(getThirtyDayStatsFn).mockReturnValue(
			deferred<Awaited<ReturnType<typeof getThirtyDayStatsFn>>>().promise,
		);
		vi.mocked(getActivityStatsFn).mockReturnValue(
			deferred<Awaited<ReturnType<typeof getActivityStatsFn>>>().promise,
		);

		const { result } = renderHook(() => useLedgerStatsData(true));

		expect(result.current.statsData.agg.allTime.sessions).toBe(0);
		expect(result.current.thirtyDayStats).toEqual({ days: [], total: 0 });
		expect(result.current.activity).toBe(EMPTY_ACTIVITY);
		expect(result.current.statsStatus).toBe("loading");
		expect(result.current.thirtyDayStatus).toBe("loading");
		expect(result.current.activityStatus).toBe("loading");
	});

	it("reports a cold failed activity read instead of a false empty history", async () => {
		vi.mocked(getActivityStatsFn).mockRejectedValueOnce(new Error("offline"));
		const { result } = renderHook(() => useLedgerStatsData(true));

		await waitFor(() =>
			expect(result.current.activityStatus).toBe("unavailable"),
		);
		expect(result.current.statsStatus).toBe("ready");
	});

	it("keeps last-good data visible while a later refresh is pending", async () => {
		const first = renderHook(() => useLedgerStatsData(true));
		await waitFor(() =>
			expect(first.result.current.statsData.agg.allTime.sessions).toBe(1),
		);
		first.unmount();

		vi.mocked(getCockpitStatsFn).mockReturnValue(
			deferred<Awaited<ReturnType<typeof getCockpitStatsFn>>>().promise,
		);
		const second = renderHook(() => useLedgerStatsData(true));

		expect(second.result.current.statsData.agg.allTime.sessions).toBe(1);
		expect(second.result.current.statsStatus).toBe("ready");
	});

	it("reconciles successful sources independently and retains rejected data", async () => {
		const first = renderHook(() => useLedgerStatsData(true));
		await waitFor(() =>
			expect(first.result.current.thirtyDayStats.total).toBe(2),
		);
		first.unmount();

		vi.mocked(getCockpitStatsFn).mockRejectedValueOnce(new Error("offline"));
		vi.mocked(getThirtyDayStatsFn).mockResolvedValueOnce(thirtyDayStats(9));
		vi.mocked(getActivityStatsFn).mockResolvedValueOnce(activity(8));
		const second = renderHook(() => useLedgerStatsData(true));

		await waitFor(() =>
			expect(second.result.current.thirtyDayStats.total).toBe(9),
		);
		expect(second.result.current.statsData.agg.allTime.sessions).toBe(1);
		expect(second.result.current.activity.topTools[0]?.count).toBe(8);
		expect(second.result.current.statsStatus).toBe("ready");
	});

	it("ignores an older refresh that resolves after a newer one", async () => {
		const older = deferred<Awaited<ReturnType<typeof getCockpitStatsFn>>>();
		vi.mocked(getCockpitStatsFn)
			.mockReturnValueOnce(older.promise)
			.mockResolvedValueOnce(statsData(7));
		const { result } = renderHook(() => useLedgerStatsData(true));

		act(() => result.current.refresh());
		await waitFor(() =>
			expect(result.current.statsData.agg.allTime.sessions).toBe(7),
		);
		older.resolve(statsData(2));
		await act(async () => await older.promise);

		expect(result.current.statsData.agg.allTime.sessions).toBe(7);
	});

	it("refreshes when enabled and whenever the refresh token changes", async () => {
		const { rerender } = renderHook(
			({ token }) => useLedgerStatsData(true, token),
			{ initialProps: { token: 1 } },
		);
		await waitFor(() => expect(getCockpitStatsFn).toHaveBeenCalledTimes(1));

		rerender({ token: 2 });

		await waitFor(() => expect(getCockpitStatsFn).toHaveBeenCalledTimes(2));
	});
});
