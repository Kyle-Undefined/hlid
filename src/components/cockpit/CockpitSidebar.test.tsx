// @vitest-environment jsdom
/**
 * Tests for RecentRunsSidebar focusing on the activeSession prop logic.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AggStats, SessionRow, WeeklyStats } from "#/db";
import * as privacyStore from "#/hooks/privacyStore";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import { RecentRunsSidebar } from "./CockpitSidebar";

// ── lifecycle ─────────────────────────────────────────────────────────────────

afterEach(cleanup);
beforeEach(() => {
	privacyStore.__resetForTesting();
});

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
	return {
		id: "session-1",
		label: "default session",
		model: "claude-3-opus",
		started_at: 1700000000000,
		ended_at: 1700000060000,
		query_count: 4,
		total_cost: 0.1234,
		total_input_tokens: 800,
		total_output_tokens: 400,
		total_cache_read_tokens: 100,
		total_cache_creation_tokens: 50,
		total_turns: 2,
		...overrides,
	};
}

const defaultWeeklyStats: WeeklyStats = {
	total: 7,
	days: [1, 2, 3, 4, 5, 6, 7],
};

const defaultAgg: AggStats = {
	allTime: {
		cost: 10.5,
		queries: 200,
		sessions: 0,
		input_tokens: 50000,
		output_tokens: 25000,
		cache_read_tokens: 5000,
		cache_creation_tokens: 2500,
		turns: 100,
	},
	today: {
		cost: 0.5,
		queries: 10,
		tokens: 3000,
		turns: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
	},
	thisMonth: {
		cost: 3.0,
		queries: 80,
		tokens: 20000,
		turns: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
	},
};

const defaultStats: LiveStats = {
	turns: 0,
	cost: 0,
	duration_ms: 0,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
	pending_input_tokens: 0,
	pending_output_tokens: 0,
	pending_cache_read_tokens: 0,
	pending_cache_creation_tokens: 0,
	context_window: null,
	max_output_tokens: null,
	last_context_used: null,
	last_output_tokens: null,
	queries: 0,
};

function renderSidebar(
	activeSession: SessionRow | null,
	runs: SessionRow[] = [],
) {
	return render(
		<RecentRunsSidebar
			runs={runs}
			weeklyStats={defaultWeeklyStats}
			onRunClick={vi.fn()}
			stats={defaultStats}
			agg={defaultAgg}
			activeSession={activeSession}
		/>,
	);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("RecentRunsSidebar — activeSession prop", () => {
	it("shows activeSession cost and stats when provided, ignoring runs[0]", () => {
		const active = makeSession({
			id: "active-session",
			total_cost: 0.5678,
			query_count: 9,
			total_turns: 5,
		});
		const firstRun = makeSession({
			id: "run-0",
			total_cost: 0.0001,
			query_count: 1,
			total_turns: 1,
		});

		renderSidebar(active, [firstRun]);

		// Should show active session cost, not firstRun cost
		expect(screen.getByText("$0.5678")).not.toBeNull();
		expect(screen.queryByText("$0.0001")).toBeNull();

		// Should show active session query + turns, not firstRun's
		expect(screen.getByText("9q · 5 turns")).not.toBeNull();
		expect(screen.queryByText("1q · 1 turns")).toBeNull();
	});

	it("falls back to runs[0] when activeSession is null", () => {
		const firstRun = makeSession({
			id: "run-0",
			total_cost: 0.2345,
			query_count: 3,
			total_turns: 7,
		});

		renderSidebar(null, [firstRun]);

		expect(screen.getByText("$0.2345")).not.toBeNull();
		expect(screen.getByText("3q · 7 turns")).not.toBeNull();
	});

	it("shows '--' and 'no sessions' when both activeSession and runs are empty", () => {
		renderSidebar(null, []);

		expect(screen.getByText("--")).not.toBeNull();
		expect(screen.getByText("no sessions")).not.toBeNull();
	});
});
