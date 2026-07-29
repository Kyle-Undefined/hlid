// @vitest-environment jsdom
/**
 * Tests for RecentRunsSidebar focusing on the activeSession prop logic.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AggStats, SessionRow, WeeklyStats } from "#/db";
import * as privacyStore from "#/hooks/privacyStore";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import {
	replaceSessionsStatus,
	resetSessionStatusForTesting,
} from "#/hooks/wsSessionStatusStore";
import type { SessionStatusEntry } from "#/server/protocol";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import { RecentRunsSidebar } from "./CockpitSidebar";

// ── lifecycle ─────────────────────────────────────────────────────────────────

afterEach(() => {
	cleanup();
	resetSessionStatusForTesting();
});
beforeEach(() => {
	privacyStore.__resetForTesting();
	resetSessionStatusForTesting();
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
			routines={[]}
			onOpenRoutines={vi.fn()}
		/>,
	);
}

function liveSession(
	id: string,
	overrides: Partial<SessionStatusEntry> = {},
): SessionStatusEntry {
	return {
		session_id: `pool-${id}`,
		agent_cwd: `/work/${id}`,
		agent_name: `${id} agent`,
		state: "idle",
		provider_id: "codex",
		model: "gpt-5.6-sol",
		hasPendingPermissions: false,
		hasDbSession: true,
		db_session_id: `chat-${id}`,
		lastLabel: id,
		...overrides,
	};
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

	it("summarizes live attention and navigates to the selected Raven session", () => {
		replaceSessionsStatus([
			liveSession("approval", {
				hasPendingPermissions: true,
				attention: {
					bucket: "needs_attention",
					reason: "permission",
					since: 1,
					last_activity_at: 1,
					queue_count: 0,
					pending_count: 1,
				},
			}),
			liveSession("working", {
				state: "running",
				attention: {
					bucket: "working",
					reason: "provider_turn",
					since: 1,
					last_activity_at: 1,
					queue_count: 2,
					pending_count: 0,
				},
			}),
			liveSession("ready"),
		]);
		const onRunClick = vi.fn();
		render(
			<RecentRunsSidebar
				runs={[]}
				weeklyStats={defaultWeeklyStats}
				onRunClick={onRunClick}
				stats={defaultStats}
				agg={defaultAgg}
				activeSession={null}
				routines={[]}
				onOpenRoutines={vi.fn()}
			/>,
		);

		expect(screen.getByText("3 live")).not.toBeNull();
		expect(
			screen.getByText("Needs you").previousElementSibling?.textContent,
		).toBe("1");
		expect(
			screen.getAllByText("Working")[0]?.previousElementSibling?.textContent,
		).toBe("1");
		expect(screen.getByText("Queued").previousElementSibling?.textContent).toBe(
			"0",
		);

		screen
			.getByRole("button", {
				name: "Open approval from attention summary",
			})
			.click();
		expect(onRunClick).toHaveBeenCalledWith("chat-approval");
	});

	it("includes server-derived Routine attention without double-counting its live session", () => {
		replaceSessionsStatus([
			liveSession("routine-run", {
				db_session_id: "routine-session",
				state: "running",
				attention: {
					bucket: "working",
					reason: "routine_running",
					since: 1,
					last_activity_at: 1,
					queue_count: 0,
					pending_count: 0,
				},
			}),
		]);
		const onRunClick = vi.fn();
		render(
			<RecentRunsSidebar
				runs={[]}
				weeklyStats={defaultWeeklyStats}
				onRunClick={onRunClick}
				stats={defaultStats}
				agg={defaultAgg}
				activeSession={null}
				routines={[
					{
						id: "routine-1",
						name: "Nightly review",
						attention: {
							bucket: "working",
							reason: "routine_running",
							since: 1,
							last_activity_at: 1,
							queue_count: 0,
							pending_count: 0,
						},
						lastRun: {
							id: "run-1",
							status: "running",
							scheduledFor: 1,
							startedAt: 1,
							finishedAt: null,
							sessionId: "routine-session",
							error: null,
							actionRequired: null,
						},
					} as never,
				]}
				onOpenRoutines={vi.fn()}
			/>,
		);

		const routineButton = screen.getByRole("button", {
			name: "Open Nightly review from attention summary",
		});
		expect(
			screen.queryByRole("button", {
				name: "Open routine-run from attention summary",
			}),
		).toBeNull();
		routineButton.click();
		expect(onRunClick).toHaveBeenCalledWith("routine-session");
	});

	it("keeps a Routine representative when its delegated child needs attention", () => {
		replaceSessionsStatus([
			liveSession("routine-run", {
				db_session_id: "routine-session",
				attention: {
					bucket: "needs_attention",
					reason: "delegated_child_attention",
					since: 1,
					last_activity_at: 1,
					queue_count: 0,
					pending_count: 0,
				},
				delegated_attention: {
					direct_count: 1,
					descendant_count: 1,
					waiting_count: 0,
					completed_count: 0,
					failed_count: 0,
					needs_attention_count: 1,
					working_count: 0,
					queued_count: 0,
					recent_count: 0,
					leading_bucket: "needs_attention",
					since: 1,
					last_activity_at: 1,
					total_tokens: 7_500,
					total_cost: 0.125,
					elapsed_duration_seconds: 605,
				},
			}),
			liveSession("child", {
				db_session_id: "child-session",
				delegation_parent_session_id: "routine-session",
				attention: {
					bucket: "needs_attention",
					reason: "permission",
					since: 1,
					last_activity_at: 1,
					queue_count: 0,
					pending_count: 1,
				},
			}),
		]);
		render(
			<RecentRunsSidebar
				runs={[]}
				weeklyStats={defaultWeeklyStats}
				onRunClick={vi.fn()}
				stats={defaultStats}
				agg={defaultAgg}
				activeSession={null}
				routines={[
					{
						id: "routine-1",
						name: "Nightly review",
						attention: {
							bucket: "working",
							reason: "routine_running",
							since: 1,
							last_activity_at: 1,
							queue_count: 0,
							pending_count: 0,
						},
						lastRun: {
							id: "run-1",
							status: "running",
							scheduledFor: 1,
							startedAt: 1,
							finishedAt: null,
							sessionId: "routine-session",
							error: null,
							actionRequired: null,
						},
					} as never,
				]}
				onOpenRoutines={vi.fn()}
			/>,
		);

		const routineButton = screen.getByRole("button", {
			name: "Open Nightly review from attention summary",
		});
		expect(routineButton.textContent).toContain("1 delegated · 1 needs you");
		expect(
			within(routineButton).getByTitle(/all delegated descendants/).textContent,
		).toBe("7.5k tokens · $0.125 · 10m 5s elapsed");
		expect(
			screen.queryByRole("button", {
				name: "Open child from attention summary",
			}),
		).toBeNull();
	});

	it("distinguishes durable interrupted attention from live processes", () => {
		replaceSessionsStatus([
			liveSession("interrupted", {
				durable_only: true,
				delegation_status: "interrupted",
				delegation_resumable: true,
				attention: {
					bucket: "needs_attention",
					reason: "delegation_interrupted",
					since: 1,
					last_activity_at: 1,
					queue_count: 0,
					pending_count: 0,
				},
			}),
		]);

		renderSidebar(null);

		expect(screen.getByText("0 live · 1 interrupted")).not.toBeNull();
		expect(screen.getByText("Restart interrupted")).not.toBeNull();
	});

	it("aligns persisted Recent rows with pin, provenance, and live deduplication", () => {
		replaceSessionsStatus([
			liveSession("working", {
				db_session_id: "working",
				state: "running",
			}),
		]);
		renderSidebar(null, [
			makeSession({
				id: "new",
				label: "Review",
				agent_cwd: "/work/alpha",
				ended_at: 30,
			}),
			makeSession({
				id: "pinned",
				label: "Review",
				agent_cwd: "/work/beta",
				pinned: 1,
				ended_at: 20,
				fork_parent_session_id: "source",
				fork_parent_label: "Original",
				fork_kind: "exact",
			}),
			makeSession({
				id: "working",
				label: "Live duplicate",
				ended_at: 40,
			}),
		]);

		const recent = screen.getAllByRole("button", {
			name: /recent session$/,
		});
		expect(recent.map((button) => button.getAttribute("aria-label"))).toEqual([
			"Open Review recent session",
			"Open Review recent session",
		]);
		expect(recent[0]?.textContent).toContain("Pinned");
		expect(recent[0]?.textContent).toContain("beta · Fork of Original");
		expect(recent[1]?.textContent).toContain("alpha");
		expect(
			screen.queryByRole("button", {
				name: "Open Live duplicate recent session",
			}),
		).toBeNull();
	});
});
