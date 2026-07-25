import { describe, expect, it } from "vitest";
import { deriveRoutineAttention } from "./routineAttention";
import type { RoutineStatus } from "./routines";

function attention(status: RoutineStatus) {
	return deriveRoutineAttention({
		status,
		scheduledFor: 10,
		startedAt: status === "claimed" ? null : 20,
		finishedAt: status === "claimed" || status === "running" ? null : 30,
	});
}

describe("deriveRoutineAttention", () => {
	it("maps actionable failures to Needs attention", () => {
		expect(attention("action_required")).toMatchObject({
			bucket: "needs_attention",
			reason: "routine_action_required",
		});
		expect(attention("delivery_error")).toMatchObject({
			bucket: "needs_attention",
			reason: "routine_delivery_error",
		});
		expect(attention("failed")).toMatchObject({
			bucket: "needs_attention",
			reason: "routine_failed",
		});
		expect(attention("provider_unavailable")).toMatchObject({
			bucket: "needs_attention",
			reason: "routine_unavailable",
		});
	});

	it("maps active, claimed, and settled runs without treating schedules as queues", () => {
		expect(attention("running")).toMatchObject({
			bucket: "working",
			reason: "routine_running",
		});
		expect(attention("claimed")).toMatchObject({
			bucket: "queued",
			reason: "routine_queued",
			queue_count: 1,
		});
		expect(attention("succeeded")).toMatchObject({
			bucket: "recent",
			reason: "routine_recent",
		});
		expect(deriveRoutineAttention(undefined)).toBeUndefined();
	});
});
