// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerAnalyticsFilter } from "#/db";
import {
	EMPTY_ACTIVITY,
	EMPTY_AGG,
	getActivityStatsFn,
	getCockpitStatsFn,
	getLedgerAnalyticsFn,
	getThirtyDayStatsFn,
} from "#/lib/serverFns/stats";
import {
	resetLedgerStatsDataForTest,
	useLedgerStatsData,
} from "./useLedgerStatsData";

vi.mock("#/lib/serverFns/stats", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("#/lib/serverFns/stats")>();
	return {
		...original,
		getActivityStatsFn: vi.fn(),
		getCockpitStatsFn: vi.fn(),
		getLedgerAnalyticsFn: vi.fn(),
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

const filteredAnalytics = (queries: number) => ({
	selected: {
		...EMPTY_AGG.today,
		queries,
		sessions: queries > 0 ? 1 : 0,
	},
	trend: { days: [], total: queries },
	topTools: [],
	hourOfDay: [],
	weekdayHour: [],
	modelSplit: [],
	stopReasonSplit: [],
	facets: { agents: [], providers: [], models: [] },
});

beforeEach(() => {
	vi.clearAllMocks();
	resetLedgerStatsDataForTest();
	vi.mocked(getCockpitStatsFn).mockResolvedValue(statsData(1));
	vi.mocked(getThirtyDayStatsFn).mockResolvedValue(thirtyDayStats(2));
	vi.mocked(getActivityStatsFn).mockResolvedValue(activity(3));
	vi.mocked(getLedgerAnalyticsFn).mockResolvedValue(null);
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

	it("passes Today and custom date boundaries to filtered analytics", async () => {
		const { rerender } = renderHook(
			({ filter }) => useLedgerStatsData(true, undefined, filter),
			{
				initialProps: {
					filter: {
						range: "today" as const,
						from: undefined as string | undefined,
						to: undefined as string | undefined,
					} as LedgerAnalyticsFilter,
				},
			},
		);
		await waitFor(() => expect(getLedgerAnalyticsFn).toHaveBeenCalledTimes(1));
		expect(getLedgerAnalyticsFn).toHaveBeenLastCalledWith({
			data: expect.objectContaining({ range: "today" }),
		});

		rerender({
			filter: {
				range: "custom",
				from: "2026-07-01",
				to: "2026-07-16",
			},
		});
		await waitFor(() => expect(getLedgerAnalyticsFn).toHaveBeenCalledTimes(2));
		expect(getLedgerAnalyticsFn).toHaveBeenLastCalledWith({
			data: expect.objectContaining({
				range: "custom",
				from: "2026-07-01",
				to: "2026-07-16",
			}),
		});
	});

	it("never exposes one filter's analytics under another filter", async () => {
		const next =
			deferred<NonNullable<Awaited<ReturnType<typeof getLedgerAnalyticsFn>>>>();
		vi.mocked(getLedgerAnalyticsFn)
			.mockResolvedValueOnce(filteredAnalytics(7))
			.mockReturnValueOnce(next.promise);
		const { result, rerender } = renderHook(
			({ filter }) => useLedgerStatsData(true, undefined, filter),
			{
				initialProps: {
					filter: {
						range: "30d" as const,
						provider: "claude" as string | undefined,
					},
				},
			},
		);
		await waitFor(() =>
			expect(result.current.analytics?.selected.queries).toBe(7),
		);

		rerender({ filter: { range: "30d", provider: "codex" } });

		expect(result.current.analytics).toBeNull();
		expect(result.current.staleAnalytics?.selected.queries).toBe(7);
		expect(result.current.analyticsStatus).toBe("loading");
		next.resolve(filteredAnalytics(3));
		await waitFor(() =>
			expect(result.current.analytics?.selected.queries).toBe(3),
		);
	});

	it("reports a failed new filter independently from the prior last-good result", async () => {
		const next =
			deferred<NonNullable<Awaited<ReturnType<typeof getLedgerAnalyticsFn>>>>();
		vi.mocked(getLedgerAnalyticsFn)
			.mockResolvedValueOnce(filteredAnalytics(7))
			.mockReturnValueOnce(next.promise);
		const { result, rerender } = renderHook(
			({ filter }) => useLedgerStatsData(true, undefined, filter),
			{
				initialProps: {
					filter: {
						range: "30d" as const,
						agent: "/agents/raven" as string | undefined,
					},
				},
			},
		);
		await waitFor(() => expect(result.current.analyticsStatus).toBe("ready"));

		rerender({ filter: { range: "30d", agent: "/agents/forge" } });
		next.reject(new Error("offline"));

		await waitFor(() =>
			expect(result.current.analyticsStatus).toBe("unavailable"),
		);
		expect(result.current.analytics).toBeNull();
	});

	it("keeps last-good analytics during a same-filter refresh failure", async () => {
		vi.mocked(getLedgerAnalyticsFn)
			.mockResolvedValueOnce(filteredAnalytics(5))
			.mockRejectedValueOnce(new Error("offline"));
		const { result } = renderHook(() =>
			useLedgerStatsData(true, undefined, {
				range: "30d",
				provider: "codex",
			}),
		);
		await waitFor(() => expect(result.current.analyticsStatus).toBe("ready"));

		act(() => result.current.refresh());
		await waitFor(() => expect(getLedgerAnalyticsFn).toHaveBeenCalledTimes(2));

		expect(result.current.analytics?.selected.queries).toBe(5);
		expect(result.current.analyticsStatus).toBe("ready");
	});
});
