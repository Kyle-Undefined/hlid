/** Aggregate usage/activity stats server fns (cockpit tiles + ledger charts). */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type {
	AggStats,
	HourOfDayBucket,
	LatencyDistribution,
	ModelSplitEntry,
	SessionRow,
	StopReasonEntry,
	ThirtyDayStats,
	TopToolCall,
	WeeklyStats,
} from "#/db";
import { dbJson } from "#/lib/dbClient";

const EMPTY_AGG_WINDOW = {
	cost: 0,
	estimated_cost: 0,
	unpriced_queries: 0,
	queries: 0,
	turns: 0,
	tokens: 0,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
};

export const EMPTY_AGG: AggStats = {
	allTime: {
		cost: 0,
		estimated_cost: 0,
		unpriced_queries: 0,
		queries: 0,
		sessions: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		turns: 0,
	},
	today: { ...EMPTY_AGG_WINDOW },
	thisMonth: { ...EMPTY_AGG_WINDOW },
};

export const getRecentSessionsFn = createServerFn({ method: "GET" }).handler(
	() => dbJson<SessionRow[]>("/db/recent-sessions?limit=5", []),
);

export const getCockpitStatsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const data = await dbJson<{
			agg: AggStats;
			sessions: SessionRow[];
		} | null>("/db/stats", null);
		return { agg: data?.agg ?? EMPTY_AGG };
	},
);

export const getWeeklyStatsFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<WeeklyStats>("/db/weekly-stats", {
		total: 0,
		days: [0, 0, 0, 0, 0, 0, 0],
	}),
);

export const getThirtyDayStatsFn = createServerFn({
	method: "GET",
}).handler(() =>
	dbJson<ThirtyDayStats>("/db/thirty-day-stats", { days: [], total: 0 }),
);

export type ActivityStats = {
	topTools: TopToolCall[];
	hourOfDay: HourOfDayBucket[];
	latency: LatencyDistribution;
	modelSplit: ModelSplitEntry[];
	stopReasonSplit: StopReasonEntry[];
};

const EMPTY_LATENCY_BUCKETS = [
	{ label: "<100", count: 0 },
	{ label: "100-500", count: 0 },
	{ label: "500-1k", count: 0 },
	{ label: "1-5k", count: 0 },
	{ label: "5-15k", count: 0 },
	{ label: "15-60k", count: 0 },
	{ label: "60k+", count: 0 },
];

export const EMPTY_ACTIVITY: ActivityStats = {
	topTools: [],
	hourOfDay: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
	latency: { buckets: EMPTY_LATENCY_BUCKETS, p50: 0, p95: 0, total: 0 },
	modelSplit: [],
	stopReasonSplit: [],
};

export const getActivityStatsFn = createServerFn({ method: "GET" }).handler(
	() => dbJson<ActivityStats>("/db/activity", EMPTY_ACTIVITY),
);

export const getToolErrorsFn = createServerFn({ method: "GET" })
	.validator((raw) => z.string().min(1).parse(raw))
	.handler(async ({ data: toolName }) => {
		const { getToolErrors } = await import("#/db");
		return getToolErrors(toolName, 10);
	});
