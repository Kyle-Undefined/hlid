import { describe, expect, it, vi } from "vitest";
import type { SessionRow, ThirtyDayStats, WeeklyStats } from "#/db";
import * as wsStore from "#/hooks/wsStore";
import { getCurrentSessionFn, getRecentSessionsFn } from "#/lib/serverFns";
import {
	incrementThirtyDayStats,
	incrementWeeklyStats,
	prependPendingRun,
	useCockpitRun,
} from "./useCockpitRun";

vi.mock("#/lib/serverFns", () => ({
	getCurrentSessionFn: vi.fn(),
	getRecentSessionsFn: vi.fn(),
}));

vi.mock("#/hooks/wsStore", () => ({
	enqueueChat: vi.fn(),
	resetLiveStats: vi.fn(),
	setPendingPrompt: vi.fn(),
}));

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

function runOptions(
	overrides: Partial<Parameters<typeof useCockpitRun>[0]> = {},
): Parameters<typeof useCockpitRun>[0] {
	return {
		prompt: "ship the fix",
		activeSkill: null,
		allSkills: [],
		wsStatus: "connected",
		sameSession: true,
		attachSessionIdRef: { current: "attached-session" },
		pendingAttachments: [],
		clearPendingAttachments: vi.fn(),
		isRunning: false,
		selectedAgentPath: "/agent",
		background: false,
		model: "gpt-5.5",
		send: vi.fn(),
		setRunError: vi.fn(),
		setPrompt: vi.fn(),
		setActiveSkill: vi.fn(),
		setRecentRuns: vi.fn(),
		setThirtyDayStats: vi.fn(),
		setWeeklyStats: vi.fn(),
		navigateToRaven: vi.fn(),
		...overrides,
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

describe("cockpit run controller", () => {
	it("surfaces session lookup failures without consuming composer state", async () => {
		vi.mocked(getCurrentSessionFn).mockRejectedValueOnce(
			new Error("session service unavailable"),
		);
		const options = runOptions({
			pendingAttachments: [{ id: "attachment-1" }] as never,
		});

		await expect(useCockpitRun(options)()).resolves.toBeUndefined();

		expect(options.setRunError).toHaveBeenLastCalledWith(
			"session service unavailable",
		);
		expect(options.attachSessionIdRef.current).toBe("attached-session");
		expect(options.clearPendingAttachments).not.toHaveBeenCalled();
		expect(options.setPrompt).not.toHaveBeenCalled();
		expect(options.send).not.toHaveBeenCalled();
	});

	it("falls back to a recent session and starts a foreground run", async () => {
		vi.mocked(getCurrentSessionFn).mockResolvedValueOnce(null);
		vi.mocked(getRecentSessionsFn).mockResolvedValueOnce([
			session("recent-session"),
		]);
		const options = runOptions();

		await useCockpitRun(options)();

		expect(options.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chat",
				text: "ship the fix",
				session_id: "recent-session",
				agent_cwd: "/agent",
			}),
		);
		expect(options.clearPendingAttachments).toHaveBeenCalledOnce();
		expect(options.setPrompt).toHaveBeenCalledWith("");
		expect(wsStore.setPendingPrompt).toHaveBeenCalledWith("ship the fix");
		expect(options.navigateToRaven).toHaveBeenCalledWith(
			"recent-session",
			"/agent",
		);
	});

	it("queues into a running session without optimistic activity updates", async () => {
		vi.mocked(getCurrentSessionFn).mockResolvedValueOnce("active-session");
		const options = runOptions({ isRunning: true, background: true });

		await useCockpitRun(options)();

		expect(wsStore.enqueueChat).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "ship the fix",
				session_id: "active-session",
			}),
		);
		expect(options.send).not.toHaveBeenCalled();
		expect(options.setRecentRuns).not.toHaveBeenCalled();
		expect(options.navigateToRaven).not.toHaveBeenCalled();
	});
});
