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
});
