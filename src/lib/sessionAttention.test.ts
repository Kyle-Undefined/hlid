import { describe, expect, it } from "vitest";
import { deriveSessionAttention } from "./sessionAttention";

const idle = {
	state: "idle" as const,
	permissionCount: 0,
	questionCount: 0,
	planReviewCount: 0,
	queueCount: 0,
};

describe("deriveSessionAttention", () => {
	it("classifies actionable requests before execution state", () => {
		expect(
			deriveSessionAttention(
				{ ...idle, state: "running", permissionCount: 1 },
				undefined,
				10,
			),
		).toMatchObject({
			bucket: "needs_attention",
			reason: "permission",
			pending_count: 1,
		});
		expect(
			deriveSessionAttention(
				{ ...idle, state: "running", questionCount: 1 },
				undefined,
				10,
			),
		).toMatchObject({
			bucket: "needs_attention",
			reason: "question",
		});
		expect(
			deriveSessionAttention(
				{ ...idle, state: "running", planReviewCount: 1 },
				undefined,
				10,
			),
		).toMatchObject({
			bucket: "needs_attention",
			reason: "plan_review",
		});
	});

	it("distinguishes errors, active work, queued work, and ready sessions", () => {
		expect(
			deriveSessionAttention({ ...idle, state: "error" }, undefined, 10),
		).toMatchObject({ bucket: "needs_attention", reason: "error" });
		expect(
			deriveSessionAttention({ ...idle, state: "running" }, undefined, 10),
		).toMatchObject({ bucket: "working", reason: "provider_turn" });
		expect(
			deriveSessionAttention({ ...idle, queueCount: 2 }, undefined, 10),
		).toMatchObject({
			bucket: "queued",
			reason: "queued_prompt",
			queue_count: 2,
		});
		expect(deriveSessionAttention(idle, undefined, 10)).toMatchObject({
			bucket: "recent",
			reason: "ready",
		});
	});

	it("projects provider background work without making success urgent", () => {
		expect(
			deriveSessionAttention(
				{ ...idle, backgroundRunningCount: 1 },
				undefined,
				10,
			),
		).toMatchObject({ bucket: "working", reason: "provider_activity" });
		expect(
			deriveSessionAttention(
				{ ...idle, backgroundFailedCount: 1 },
				undefined,
				20,
			),
		).toMatchObject({
			bucket: "needs_attention",
			reason: "background_failed",
		});
		expect(
			deriveSessionAttention(
				{ ...idle, backgroundCompletedCount: 1 },
				undefined,
				30,
			),
		).toMatchObject({ bucket: "recent", reason: "background_completed" });
	});

	it("classifies an exact usage sleep ahead of generic running work", () => {
		const sleeping = deriveSessionAttention(
			{
				...idle,
				state: "running",
				queueCount: 1,
				sleepState: {
					until: 1_784_060_475,
					windowId: "five_hour",
					reason: "limit_reached",
				},
			},
			undefined,
			10,
		);
		expect(sleeping).toMatchObject({
			bucket: "sleeping",
			reason: "usage_sleep",
			queue_count: 1,
			sleep_until: 1_784_060_475,
			sleep_window_id: "five_hour",
		});

		expect(
			deriveSessionAttention(
				{
					...idle,
					state: "running",
					questionCount: 1,
					sleepState: { reason: "threshold" },
				},
				sleeping,
				20,
			),
		).toMatchObject({ bucket: "needs_attention", reason: "question" });
	});

	it("maps known goal and Routine state without making usage waits urgent", () => {
		expect(
			deriveSessionAttention({ ...idle, goalStatus: "blocked" }, undefined, 10),
		).toMatchObject({
			bucket: "needs_attention",
			reason: "goal_blocked",
		});
		expect(
			deriveSessionAttention(
				{ ...idle, goalStatus: "budgetLimited" },
				undefined,
				10,
			),
		).toMatchObject({
			bucket: "needs_attention",
			reason: "goal_budget",
		});
		expect(
			deriveSessionAttention(
				{ ...idle, state: "running", goalStatus: "active" },
				undefined,
				10,
			),
		).toMatchObject({
			bucket: "working",
			reason: "goal_active",
		});
		expect(
			deriveSessionAttention(
				{ ...idle, state: "running", goalStatus: "usageLimited" },
				undefined,
				10,
			),
		).toMatchObject({
			bucket: "recent",
			reason: "goal_usage_wait",
		});
		expect(
			deriveSessionAttention(
				{ ...idle, state: "running", routine: true },
				undefined,
				10,
			),
		).toMatchObject({
			bucket: "working",
			reason: "routine_running",
		});
	});

	it("keeps state timing stable and advances activity only on meaningful changes", () => {
		const initial = deriveSessionAttention(
			{ ...idle, state: "running", queueCount: 1 },
			undefined,
			10,
		);
		const unchanged = deriveSessionAttention(
			{ ...idle, state: "running", queueCount: 1 },
			initial,
			20,
		);
		const queueChanged = deriveSessionAttention(
			{ ...idle, state: "running", queueCount: 2 },
			unchanged,
			30,
		);
		const attention = deriveSessionAttention(
			{ ...idle, state: "running", permissionCount: 1, queueCount: 2 },
			queueChanged,
			40,
		);

		expect(unchanged).toMatchObject({
			since: 10,
			last_activity_at: 10,
		});
		expect(queueChanged).toMatchObject({
			since: 10,
			last_activity_at: 30,
		});
		expect(attention).toMatchObject({
			since: 40,
			last_activity_at: 40,
		});
	});

	it("filters request identities individually and preserves an explicit empty identity set", () => {
		const mixed = deriveSessionAttention(
			{
				...idle,
				permissionCount: 3,
				permissionIds: ["permission-1", "not safe/for a URL", "permission-2"],
			},
			undefined,
			10,
		);
		expect(mixed).toMatchObject({
			pending_count: 3,
			pending_reason_count: 3,
			pending_ids: ["permission-1", "permission-2"],
		});

		expect(
			deriveSessionAttention(
				{
					...idle,
					questionCount: 1,
					questionIds: ["unsafe question id"],
				},
				undefined,
				20,
			),
		).toMatchObject({ pending_ids: [] });
	});
});
