// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
	loaderData: {} as Record<string, unknown>,
	search: { tab: "stats" as const },
	liveStats: {} as Record<string, unknown>,
	activeSession: null as Record<string, unknown> | null,
	emptySessions: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useLoaderData: () => testState.loaderData,
		useSearch: () => testState.search,
	}),
	useNavigate: () => vi.fn(),
	useRouterState: ({
		select,
	}: {
		select: (state: { status: string }) => unknown;
	}) => select({ status: "idle" }),
}));

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		const chain = {
			validator: () => chain,
			handler: () => vi.fn(),
		};
		return chain;
	},
}));

vi.mock("#/components/cockpit/ThirtyDayGraph", () => ({
	ThirtyDayGraph: () => <div>Thirty-day graph</div>,
}));
vi.mock("#/components/ledger/ActiveSessionsPanel", () => ({
	ActiveSessionsPanel: () => null,
}));
vi.mock("#/components/ledger/CostBreakdown", () => ({
	CostBreakdown: () => <div>Cost breakdown</div>,
}));
vi.mock("#/components/ledger/charts/HourOfDayChart", () => ({
	HourOfDayChart: () => <div>Hour chart</div>,
}));
vi.mock("#/components/ledger/charts/ModelSplitDonut", () => ({
	ModelSplitDonut: () => <div>Model chart</div>,
}));
vi.mock("#/components/ledger/charts/StopReasonDonut", () => ({
	StopReasonDonut: () => <div>Stop reason chart</div>,
}));
vi.mock("#/components/ledger/charts/TopToolsChart", () => ({
	TopToolsChart: () => <div>Tools chart</div>,
}));
vi.mock("#/components/ledger/LedgerStats", () => ({
	StatCell: ({
		label,
		value,
		sub,
	}: {
		label: string;
		value: string;
		sub?: string;
	}) => <div data-testid={`stat-${label}`}>{`${value}|${sub ?? ""}`}</div>,
	StatRows: () => <div>Stat rows</div>,
}));
vi.mock("#/components/ledger/SessionsLedger", () => ({
	SessionsLedger: () => null,
}));
vi.mock("#/components/usage/ProviderUsageStrip", () => ({
	ProviderUsageStrip: ({ tail }: { tail: unknown }) => (
		<div>
			Provider usage
			{tail as never}
		</div>
	),
}));
vi.mock("#/components/usage/UsageWindowSections", () => ({
	ContextWindowSection: () => <div>Context usage</div>,
}));
vi.mock("#/hooks/useLedgerSessionMutations", () => ({
	useLedgerSessionMutations: ({ sessionPage }: { sessionPage: unknown }) => ({
		sessionsData: sessionPage,
		mutationError: null,
		reconcile: vi.fn(),
		deleteSession: vi.fn(),
		renameSession: vi.fn(),
		cleanupSessions: vi.fn(),
	}),
}));
vi.mock("#/hooks/useLedgerStatsData", () => ({
	useLedgerStatsData: () => ({
		statsData: testState.loaderData.statsData,
		thirtyDayStats: testState.loaderData.thirtyDayStats,
		providerUsages: testState.loaderData.providerUsages,
		providerIds: testState.loaderData.providerIds,
		activity: testState.loaderData.activity,
		statsStatus: testState.loaderData.statsStatus,
		thirtyDayStatus: testState.loaderData.thirtyDayStatus,
		activityStatus: testState.loaderData.activityStatus,
		refresh: vi.fn(),
	}),
}));
vi.mock("#/hooks/useWs", () => ({
	useWs: () => ({ model: "", actualModel: null, send: vi.fn() }),
}));
vi.mock("#/hooks/useWsSelectors", () => ({
	useWsLiveStats: () => testState.liveStats,
}));
vi.mock("#/hooks/wsSessionStatusStore", () => ({
	getSessionsStatus: () => testState.emptySessions,
	subscribeSessionsStatus: () => () => {},
}));
vi.mock("#/lib/serverFns/providers", () => ({
	getProvidersFn: vi.fn(),
	getProviderUsagesFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/sessions", () => ({
	getActiveSessionRowFn: vi.fn(async () => testState.activeSession),
}));
vi.mock("#/lib/serverFns/stats", () => ({
	EMPTY_AGG: {},
	getActivityStatsFn: vi.fn(),
	getThirtyDayStatsFn: vi.fn(),
}));

import { getProvidersFn, getProviderUsagesFn } from "#/lib/serverFns/providers";
import { getActivityStatsFn, getThirtyDayStatsFn } from "#/lib/serverFns/stats";
import { Route } from "./ledger";

const EMPTY_STATS = {
	turns: 0,
	cost: 0,
	estimated_cost: 0,
	unpriced_queries: 0,
	duration_ms: 0,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
	context_window: null,
	max_output_tokens: null,
	last_context_used: null,
	last_output_tokens: null,
	queries: 0,
};

function aggWindow(overrides: Record<string, number> = {}) {
	return {
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
		...overrides,
	};
}

function activeSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "session-1",
		label: "Session",
		model: "claude-sonnet",
		started_at: 1,
		ended_at: null,
		query_count: 4,
		total_cost: 8,
		total_estimated_cost: 0,
		unpriced_query_count: 0,
		total_input_tokens: 1_000,
		total_output_tokens: 200,
		total_cache_read_tokens: 300,
		total_cache_creation_tokens: 100,
		total_turns: 6,
		...overrides,
	};
}

function setLoader(active: Record<string, unknown> | null): void {
	testState.activeSession = active;
	testState.loaderData = {
		statsData: {
			agg: {
				today: aggWindow({ queries: 2, cost: 1 }),
				thisMonth: aggWindow(),
				allTime: {
					...aggWindow({ queries: 2, cost: 1 }),
					sessions: 1,
				},
			},
		},
		initialSessions: { sessions: [], total: 0 },
		page: 1,
		size: 20,
		thirtyDayStats: { days: [], total: 0 },
		providerUsages: [],
		providerIds: ["claude"],
		activeSession: active,
		activity: {
			modelSplit: [],
			stopReasonSplit: [],
			topTools: [],
			hourOfDay: [],
		},
		statsStatus: "ready",
		thirtyDayStatus: "ready",
		activityStatus: "ready",
	};
}

function renderLedger(): void {
	const Component = (Route as unknown as { component: ComponentType })
		.component;
	render(<Component />);
}

beforeEach(() => {
	testState.search = { tab: "stats" };
	testState.liveStats = { ...EMPTY_STATS };
	setLoader(null);
});

afterEach(cleanup);

type LedgerRouteShape = {
	loaderDeps: (input: {
		search: {
			tab: "stats" | "sessions";
			page: number;
			size: number;
			q: string;
			agent: string;
			model: string;
			sort: "recent";
		};
	}) => Record<string, unknown>;
	loader: (input: {
		deps: {
			page: number;
			size: number;
			q: string;
			agent?: string;
			model?: string;
			sort: "recent";
		};
	}) => Promise<Record<string, unknown>>;
};

const ledgerRoute = Route as unknown as LedgerRouteShape;

describe("ledger route loader", () => {
	it("does not key route data by the selected tab", () => {
		const listState = {
			page: 1,
			size: 20,
			q: "",
			agent: "vault",
			model: "claude-sonnet",
			sort: "recent" as const,
		};

		expect(
			ledgerRoute.loaderDeps({
				search: { tab: "stats", ...listState },
			}),
		).toEqual(
			ledgerRoute.loaderDeps({
				search: { tab: "sessions", ...listState },
			}),
		);
	});

	it("does not hold navigation behind analytics hydration", async () => {
		vi.mocked(getProvidersFn).mockImplementation(() => new Promise(() => {}));
		vi.mocked(getProviderUsagesFn).mockImplementation(
			() => new Promise(() => {}),
		);
		vi.mocked(getThirtyDayStatsFn).mockImplementation(
			() => new Promise(() => {}),
		);
		vi.mocked(getActivityStatsFn).mockImplementation(
			() => new Promise(() => {}),
		);

		const loaded = await ledgerRoute.loader({
			deps: { page: 1, size: 20, q: "", sort: "recent" },
		});

		expect(loaded).toHaveProperty("initialSessions");
		expect(getProvidersFn).not.toHaveBeenCalled();
		expect(getProviderUsagesFn).not.toHaveBeenCalled();
		expect(getThirtyDayStatsFn).not.toHaveBeenCalled();
		expect(getActivityStatsFn).not.toHaveBeenCalled();
	});
});

describe("ledger stats view", () => {
	it("does not present pending activity hydration as an empty ledger", () => {
		setLoader(null);
		testState.loaderData.activityStatus = "loading";

		renderLedger();

		expect(screen.getByText("Loading activity breakdowns…")).toBeTruthy();
		expect(screen.queryByText("Model chart")).toBeNull();
	});

	it("prefers live query cost, query, and token totals over persisted session data", () => {
		setLoader(activeSession());
		testState.liveStats = {
			...EMPTY_STATS,
			queries: 2,
			turns: 3,
			cost: 2,
			estimated_cost: 0.5,
			input_tokens: 100,
			output_tokens: 20,
			cache_read_tokens: 30,
			cache_creation_tokens: 10,
		};

		renderLedger();

		expect(screen.getByTestId("stat-COST").textContent).toBe(
			"~$2.5000|includes API-equivalent estimate",
		);
		expect(screen.getByTestId("stat-QUERIES").textContent).toBe("2|3 turns");
		expect(screen.getByTestId("stat-TOKENS").textContent).toBe("160|40 cached");
		expect(screen.getByTestId("stat-MODEL").textContent).toBe("sonnet|");
		expect(screen.getByText("Provider usage")).toBeTruthy();
	});

	it("falls back to persisted session totals when no live query is active", () => {
		setLoader(activeSession());

		renderLedger();

		expect(screen.getByTestId("stat-COST").textContent).toBe(
			"$8.0000|$2.0000/query",
		);
		expect(screen.getByTestId("stat-QUERIES").textContent).toBe("4|6 turns");
		expect(screen.getByTestId("stat-TOKENS").textContent).toBe(
			"1.6k|400 cached",
		);
	});

	it("shows honest empty states without an active or persisted session", () => {
		renderLedger();

		expect(screen.getByTestId("stat-COST").textContent).toBe("--|");
		expect(screen.getByTestId("stat-QUERIES").textContent).toBe("--|");
		expect(screen.getByTestId("stat-TOKENS").textContent).toBe("--|");
		expect(screen.getByTestId("stat-MODEL").textContent).toBe("--|");
	});
});
