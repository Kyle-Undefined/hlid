// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import { getProvidersFn } from "#/lib/serverFns/providers";

const testState = vi.hoisted(() => ({
	loaderData: {} as Record<string, unknown>,
	search: { tab: "stats" as "stats" | "sessions" } as {
		tab: "stats" | "sessions";
		page?: number;
		size?: 10 | 20 | 50;
		q?: string;
		agent?: string;
		model?: string;
		provider?: string;
		stop?: string;
		range?: "today" | "7d" | "30d" | "90d" | "all" | "custom";
		from?: string;
		to?: string;
		sort?: "recent" | "cost" | "tokens";
	},
	navigate: vi.fn(),
	liveStats: {} as Record<string, unknown>,
	activeSession: null as Record<string, unknown> | null,
	openSessionRows: [] as Record<string, unknown>[],
	emptySessions: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useLoaderData: () => testState.loaderData,
		useSearch: () => testState.search,
	}),
	useNavigate: () => testState.navigate,
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
	ModelSplitDonut: ({ onSelect }: { onSelect?: (model: string) => void }) => (
		<div>
			Model chart
			<button type="button" onClick={() => onSelect?.("gpt-test")}>
				Mock model drill-down
			</button>
		</div>
	),
}));
vi.mock("#/components/ledger/charts/StopReasonDonut", () => ({
	StopReasonDonut: ({ onSelect }: { onSelect?: (reason: string) => void }) => (
		<div>
			Stop reason chart
			<button type="button" onClick={() => onSelect?.("max_tokens")}>
				Mock stop drill-down
			</button>
		</div>
	),
}));
vi.mock("#/components/ledger/charts/TopToolsChart", () => ({
	TopToolsChart: () => <div>Tools chart</div>,
}));
vi.mock("#/components/ledger/LedgerStats", () => ({
	cacheHitPct: () => "25.0",
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
	SessionsLedger: ({
		onSearchChange,
		onSortChange,
	}: {
		onSearchChange: (value: string) => void;
		onSortChange: (value: "recent" | "cost" | "tokens") => void;
	}) => (
		<>
			<button type="button" onClick={() => onSearchChange("needle")}>
				Mock session search
			</button>
			<button type="button" onClick={() => onSortChange("cost")}>
				Mock session sort
			</button>
		</>
	),
}));
vi.mock("#/hooks/useLedgerSessionMutations", () => ({
	useLedgerSessionMutations: ({ sessionPage }: { sessionPage: unknown }) => ({
		sessionsData: sessionPage,
		mutationError: null,
		reconcile: vi.fn(),
		deleteSession: vi.fn(),
		renameSession: vi.fn(),
		setSessionPinned: vi.fn(),
		forkSession: vi.fn(),
		forkingIds: new Set<string>(),
		cleanupSessions: vi.fn(),
	}),
}));
vi.mock("#/hooks/useLedgerStatsData", () => ({
	useLedgerStatsData: () => ({
		statsData: testState.loaderData.statsData,
		thirtyDayStats: testState.loaderData.thirtyDayStats,
		activity: testState.loaderData.activity,
		statsStatus: testState.loaderData.statsStatus,
		thirtyDayStatus: testState.loaderData.thirtyDayStatus,
		activityStatus: testState.loaderData.activityStatus,
		analytics: testState.loaderData.analytics,
		staleAnalytics: testState.loaderData.staleAnalytics,
		analyticsStatus: testState.loaderData.analyticsStatus,
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
vi.mock("#/lib/serverFns/sessions", () => ({
	getActiveSessionRowFn: vi.fn(async () => testState.activeSession),
	getSessionRowsByIdsFn: vi.fn(async () => testState.openSessionRows),
}));
vi.mock("#/lib/serverFns/providers", () => ({
	getProvidersFn: vi.fn().mockResolvedValue([]),
}));
vi.mock("#/lib/serverFns/stats", () => ({
	EMPTY_AGG: {},
	getActivityStatsFn: vi.fn(),
	getThirtyDayStatsFn: vi.fn(),
}));

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
		analytics: {
			selected: { ...aggWindow({ queries: 2, cost: 1 }), sessions: 1 },
			trend: { days: [], total: 0 },
			modelSplit: [],
			stopReasonSplit: [],
			topTools: [],
			hourOfDay: [],
			weekdayHour: [],
			facets: { agents: [], providers: [], models: [] },
		},
		analyticsStatus: "ready",
		providerCatalog: [],
	};
}

function renderLedger(): void {
	const Component = (Route as unknown as { component: ComponentType })
		.component;
	render(<Component />);
}

beforeEach(() => {
	privacyStore.__resetForTesting();
	testState.navigate.mockClear();
	testState.search = { tab: "stats" };
	testState.liveStats = { ...EMPTY_STATS };
	testState.openSessionRows = [];
	testState.emptySessions = [];
	setLoader(null);
});

afterEach(cleanup);

type LedgerRouteShape = {
	shouldReload: (input: { cause: "preload" | "enter" | "stay" }) => boolean;
	loaderDeps: (input: {
		search: Record<string, unknown>;
	}) => Record<string, unknown>;
	loader: (input: {
		location: {
			search: Record<string, unknown>;
		};
	}) => Promise<Record<string, unknown>>;
};

const ledgerRoute = Route as unknown as LedgerRouteShape;

describe("ledger route loader", () => {
	it("keeps same-route dropdown changes out of the loader", () => {
		expect(ledgerRoute.shouldReload({ cause: "stay" })).toBe(false);
		expect(ledgerRoute.shouldReload({ cause: "enter" })).toBe(true);
		expect(ledgerRoute.shouldReload({ cause: "preload" })).toBe(true);
	});

	it("does not key the route match by live Ledger controls", () => {
		const listState = {
			page: 1,
			size: 20,
			q: "",
			agent: "vault",
			model: "claude-sonnet",
			sort: "recent" as const,
		};

		expect(
			ledgerRoute.loaderDeps({ search: { tab: "stats", ...listState } }),
		).toEqual({});
		expect(
			ledgerRoute.loaderDeps({
				search: { tab: "sessions", ...listState, sort: "cost" },
			}),
		).toEqual({});
	});

	it("does not hold navigation behind analytics hydration", async () => {
		vi.mocked(getThirtyDayStatsFn).mockImplementation(
			() => new Promise(() => {}),
		);
		vi.mocked(getActivityStatsFn).mockImplementation(
			() => new Promise(() => {}),
		);

		const loaded = await ledgerRoute.loader({
			location: {
				search: { tab: "sessions", page: 1, size: 20 },
			},
		});

		expect(loaded).toHaveProperty("initialSessions");
		expect(getThirtyDayStatsFn).not.toHaveBeenCalled();
		expect(getActivityStatsFn).not.toHaveBeenCalled();
	});

	it("does not let a stalled provider catalog hold Ledger navigation pending", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(getProvidersFn).mockImplementationOnce(
				() => new Promise(() => {}),
			);
			const pending = ledgerRoute.loader({
				location: {
					search: { tab: "sessions", page: 1, size: 20 },
				},
			});

			await vi.advanceTimersByTimeAsync(501);
			const loaded = await pending;
			expect(loaded.providerCatalog).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not hold Stats navigation behind the Sessions page seed", async () => {
		const loaded = await ledgerRoute.loader({
			location: {
				search: { tab: "stats", page: 1, size: 20 },
			},
		});

		expect(loaded.initialSessions).toEqual({
			sessions: [],
			total: 0,
			oldest_started_at: null,
			agent_cwds: [],
			models: [],
		});
		expect(loaded.activeSession).toBeNull();
	});
});

describe("ledger stats view", () => {
	it("takes filters from live search state and updates them without a loader navigation", () => {
		testState.loaderData.range = "30d";
		testState.search = { tab: "stats", range: "90d" };
		renderLedger();

		const range = screen.getByRole("combobox", {
			name: "Date range",
		}) as HTMLSelectElement;
		expect(range.value).toBe("90d");
		fireEvent.change(range, { target: { value: "7d" } });
		expect(testState.navigate).toHaveBeenCalledWith(
			expect.objectContaining({ replace: true, resetScroll: false }),
		);
	});

	it("offers Today and an inclusive custom date range", () => {
		testState.search = {
			tab: "stats",
			range: "custom",
			from: "2026-07-01",
			to: "2026-07-16",
		};
		renderLedger();

		const range = screen.getByRole("combobox", {
			name: "Date range",
		}) as HTMLSelectElement;
		expect(within(range).getByRole("option", { name: "Today" })).toBeDefined();
		expect((screen.getByLabelText("From date") as HTMLInputElement).value).toBe(
			"2026-07-01",
		);
		expect((screen.getByLabelText("To date") as HTMLInputElement).value).toBe(
			"2026-07-16",
		);

		fireEvent.change(screen.getByLabelText("From date"), {
			target: { value: "2026-07-20" },
		});
		expect(testState.navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				replace: true,
				resetScroll: false,
				search: expect.objectContaining({
					range: "custom",
					from: "2026-07-20",
					to: "2026-07-20",
				}),
			}),
		);
	});

	it("carries the selected Stats dates into model and stop drill-downs", () => {
		testState.search = {
			tab: "stats",
			range: "custom",
			from: "2026-07-01",
			to: "2026-07-16",
			provider: "codex",
		};
		renderLedger();

		fireEvent.click(
			screen.getByRole("button", { name: "Mock model drill-down" }),
		);
		expect(testState.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({
					tab: "sessions",
					model: "gpt-test",
					provider: "codex",
					range: "custom",
					from: "2026-07-01",
					to: "2026-07-16",
				}),
			}),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Mock stop drill-down" }),
		);
		expect(testState.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({
					tab: "sessions",
					stop: "max_tokens",
					provider: "codex",
					range: "custom",
					from: "2026-07-01",
					to: "2026-07-16",
				}),
			}),
		);
	});

	it("updates session search without resetting the Ledger scroll container", () => {
		testState.search = { tab: "sessions", page: 1, size: 20 };
		renderLedger();

		fireEvent.click(
			screen.getByRole("button", { name: "Mock session search" }),
		);
		expect(testState.navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				replace: true,
				resetScroll: false,
				search: expect.objectContaining({ q: "needle", page: 1 }),
			}),
		);
	});

	it("updates session sorting without replacing the Ledger route", () => {
		testState.search = {
			tab: "sessions",
			page: 2,
			size: 20,
			sort: "recent",
		};
		renderLedger();

		fireEvent.click(screen.getByRole("button", { name: "Mock session sort" }));
		expect(testState.navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				resetScroll: false,
				search: expect.objectContaining({ page: 1, sort: "cost" }),
			}),
		);
	});

	it("shows and clears Stats drill-down date, provider, and stop filters", () => {
		testState.search = {
			tab: "sessions",
			page: 1,
			size: 20,
			provider: "codex",
			stop: "max_tokens",
			range: "custom",
			from: "2026-07-01",
			to: "2026-07-16",
		};
		renderLedger();

		const filters = screen.getByLabelText("Active session drill-down filters");
		expect(filters.textContent).toContain("Date: 2026-07-01 – 2026-07-16");
		expect(filters.textContent).toContain("Provider: codex");
		expect(filters.textContent).toContain("Stop: max tokens");

		fireEvent.click(
			screen.getByRole("button", { name: "Clear session date filter" }),
		);
		expect(testState.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({
					range: undefined,
					from: undefined,
					to: undefined,
				}),
			}),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Clear session provider filter" }),
		);
		expect(testState.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({ provider: "" }),
			}),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Clear session stop reason filter" }),
		);
		expect(testState.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({ stop: "" }),
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
		expect(testState.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({
					agent: "",
					model: "",
					provider: "",
					stop: "",
					range: undefined,
				}),
			}),
		);
	});

	it("clears the drill-down-only stop reason when returning to Stats", () => {
		testState.search = {
			tab: "sessions",
			page: 1,
			provider: "codex",
			model: "gpt-test",
			stop: "max_tokens",
			range: "30d",
		};
		renderLedger();

		fireEvent.click(screen.getByRole("button", { name: "stats" }));
		expect(testState.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({
					tab: "stats",
					provider: "codex",
					model: "gpt-test",
					stop: "",
					range: "30d",
				}),
			}),
		);
	});

	it("does not apply or show a date filter on the ordinary Sessions view", () => {
		testState.search = { tab: "sessions", page: 1, size: 20 };
		renderLedger();

		expect(
			screen.queryByLabelText("Active session drill-down filters"),
		).toBeNull();
	});

	it("uses one aligned frame for the Overview metrics", () => {
		renderLedger();

		const summary = screen.getByText("Overview").closest("summary");
		expect(summary).not.toBeNull();
		expect(summary?.className).toContain("border");
		const section = summary?.parentElement;
		expect(section?.className).not.toContain("border");
		const content = summary?.nextElementSibling as HTMLElement;
		expect(content.className).toContain("pt-3");
		expect(content.className).not.toContain("p-2");

		const costTile = within(section as HTMLElement).getByText(
			"Cost",
		).parentElement;
		const metricGrid = costTile?.parentElement;
		expect(metricGrid?.className).toContain("gap-px");
		expect(costTile?.className).toContain("bg-card");
		expect(costTile?.className).not.toContain("border-r");
	});

	it("fully masks the Overview, Models, and Tools sections in privacy mode", () => {
		renderLedger();

		act(() => privacyStore.togglePrivacy());

		for (const title of ["Overview", "Models", "Tools"]) {
			const details = screen.getByText(title).closest("details");
			const summary = details?.querySelector("summary");
			const content = summary?.nextElementSibling as HTMLElement | null;
			const summaryMask = summary?.querySelector(
				'span[style*="blur(6px)"]',
			) as HTMLElement | null;

			expect(summaryMask?.style.filter).toBe("blur(6px)");
			expect(content?.style.filter).toBe("blur(6px)");
			expect(content?.style.pointerEvents).toBe("none");
		}
	});

	it("shows the full token accounting without a provider usage strip", () => {
		const analytics = testState.loaderData.analytics as {
			selected: Record<string, number>;
		};
		analytics.selected.input_tokens = 12_345;
		analytics.selected.output_tokens = 678;
		analytics.selected.cache_read_tokens = 2_000;
		analytics.selected.cache_creation_tokens = 300;

		renderLedger();

		const overview = screen.getByText("Overview").closest("details");
		const overviewQueries = within(overview as HTMLElement);
		expect(overviewQueries.getByText("Token counts")).toBeDefined();
		const inputTile = overviewQueries.getByText("Input").parentElement;
		const outputTile = overviewQueries.getByText("Output").parentElement;
		const nonCacheTile =
			overviewQueries.getByText("Non-cache total").parentElement;
		const cacheReadTile = overviewQueries.getByText("Cache read").parentElement;
		const cacheWriteTile =
			overviewQueries.getByText("Cache write").parentElement;
		const totalTile = overviewQueries.getByText("Total tokens").parentElement;
		expect(inputTile?.textContent).toContain("12.3k");
		expect(outputTile?.textContent).toContain("678");
		expect(nonCacheTile?.textContent).toContain("13.0k");
		expect(cacheReadTile?.textContent).toContain("2.0k");
		expect(cacheWriteTile?.textContent).toContain("300");
		expect(totalTile?.textContent).toContain("15.3k");
		expect(totalTile?.textContent).toContain("including cache");
		expect(screen.queryByText("Provider usage")).toBeNull();
		expect(screen.queryByText("Context usage")).toBeNull();
	});

	it("does not present pending activity hydration as an empty ledger", () => {
		setLoader(null);
		testState.loaderData.analytics = null;
		testState.loaderData.analyticsStatus = "loading";

		renderLedger();

		expect(screen.getByText("Loading filtered analytics…")).toBeTruthy();
		expect(screen.queryByText("Model chart")).toBeNull();
	});

	it("keeps the prior stats layout visible while a filter or reset refreshes", () => {
		const staleAnalytics = testState.loaderData.analytics;
		testState.loaderData.analytics = null;
		testState.loaderData.staleAnalytics = staleAnalytics;
		testState.loaderData.analyticsStatus = "loading";

		renderLedger();

		expect(screen.getByText("Overview")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toContain(
			"Updating filtered analytics",
		);
		expect(screen.queryByText("Loading filtered analytics…")).toBeNull();
	});

	it("sums header totals across every open session regardless of state", async () => {
		const first = activeSession();
		const second = activeSession({
			id: "session-2",
			query_count: 2,
			total_cost: 3,
			total_estimated_cost: 1,
			total_input_tokens: 500,
			total_output_tokens: 100,
			total_cache_read_tokens: 50,
			total_cache_creation_tokens: 0,
			total_turns: 2,
		});
		setLoader(first);
		testState.search = { tab: "sessions" };
		testState.openSessionRows = [first, second];
		testState.emptySessions = [
			{
				session_id: "pool-1",
				db_session_id: "session-1",
				state: "idle",
				hasPendingPermissions: false,
			},
			{
				session_id: "pool-2",
				db_session_id: "session-2",
				state: "error",
				hasPendingPermissions: false,
			},
		];
		testState.liveStats = {
			...EMPTY_STATS,
			queries: 99,
			cost: 99,
		};

		renderLedger();

		await waitFor(() =>
			expect(screen.getByTestId("stat-COST").textContent).toBe(
				"~$12.0000|includes API-equivalent estimate",
			),
		);
		expect(screen.getByTestId("stat-QUERIES").textContent).toBe("6|8 turns");
		expect(screen.getByTestId("stat-TOKENS").textContent).toBe(
			"2.3k|450 cached",
		);
		expect(screen.getByTestId("stat-SESSIONS").textContent).toBe("2|1 error");
	});

	it("shows honest empty states without an open session", () => {
		testState.search = { tab: "sessions" };
		renderLedger();

		expect(screen.getByTestId("stat-COST").textContent).toBe("$0.0000|");
		expect(screen.getByTestId("stat-QUERIES").textContent).toBe("0|");
		expect(screen.getByTestId("stat-TOKENS").textContent).toBe("0|");
		expect(screen.getByTestId("stat-SESSIONS").textContent).toBe("0|all idle");
	});

	it("does not count an unused idle pool placeholder as an open session", () => {
		testState.search = { tab: "sessions" };
		testState.emptySessions = [
			{
				session_id: "vault-placeholder",
				db_session_id: null,
				state: "idle",
				hasDbSession: false,
				hasPendingPermissions: false,
			},
		];
		renderLedger();

		expect(screen.getByTestId("stat-COST").textContent).toBe("$0.0000|");
		expect(screen.getByTestId("stat-QUERIES").textContent).toBe("0|");
		expect(screen.getByTestId("stat-TOKENS").textContent).toBe("0|");
		expect(screen.getByTestId("stat-SESSIONS").textContent).toBe("0|all idle");
	});
});
