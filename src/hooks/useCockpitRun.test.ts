import { describe, expect, it, vi } from "vitest";
import type { SessionRow, ThirtyDayStats, WeeklyStats } from "#/db";
import {
	incrementThirtyDayStats,
	incrementWeeklyStats,
	prependPendingRun,
} from "./useCockpitRun";

function session(id: string): SessionRow {
	return {
		id,
		label: id.toUpperCase(),
		model: null,
		started_at: 1,
		ended_at: null,
		query_count: 0,
		total_cost: 0,
		total_input_tokens: 0,
		total_output_tokens: 0,
		total_cache_read_tokens: 0,
		total_cache_creation_tokens: 0,
		total_turns: 0,
	};
}

describe("cockpit optimistic activity", () => {
	it("increments a weekly bucket without mutating loader data", () => {
		const initial: WeeklyStats = { total: 4, days: [0, 1, 0, 2, 0, 1, 0] };
		const next = incrementWeeklyStats(initial, 2);

		expect(next).toEqual({ total: 5, days: [0, 1, 1, 2, 0, 1, 0] });
		expect(initial).toEqual({ total: 4, days: [0, 1, 0, 2, 0, 1, 0] });
	});

	it("increments or appends today's thirty-day bucket", () => {
		const existing: ThirtyDayStats = {
			total: 2,
			days: [{ date: "2026-07-11", count: 2 }],
		};
		expect(incrementThirtyDayStats(existing, "2026-07-11")).toEqual({
			total: 3,
			days: [{ date: "2026-07-11", count: 3 }],
		});
		expect(incrementThirtyDayStats(existing, "2026-07-12")).toEqual({
			total: 3,
			days: [
				{ date: "2026-07-11", count: 2 },
				{ date: "2026-07-12", count: 1 },
			],
		});
	});

	it("prepends one pending run, caps the list, and preserves duplicates", () => {
		vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
		const runs = ["a", "b", "c", "d", "e"].map(session);
		const next = prependPendingRun(runs, {
			sessionId: "new",
			text: "a useful pending session label",
			model: "gpt-5.5",
		});

		expect(next.map((run) => run.id)).toEqual(["new", "a", "b", "c", "d"]);
		expect(next[0]).toMatchObject({
			label: "A USEFUL PENDING SESSION LABEL",
			model: "gpt-5.5",
			started_at: 1_750_000_000,
		});
		expect(
			prependPendingRun(runs, {
				sessionId: "a",
				text: "ignored",
				model: null,
			}),
		).toBe(runs);
	});
});
