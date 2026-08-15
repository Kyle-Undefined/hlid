import { describe, expect, it, vi } from "vitest";
import type { PushNotificationEventRecord } from "../db";
import { isRoutineNotificationRelevant } from "./routineNotificationRelevance";

function event(
	patch: Partial<PushNotificationEventRecord> = {},
): Pick<
	PushNotificationEventRecord,
	"sourceKind" | "sourceId" | "category" | "metadata"
> {
	return {
		sourceKind: "routine",
		sourceId: "run-1",
		category: "problem",
		metadata: {
			routineId: "routine-1",
			routineRunId: "run-1",
			status: "failed",
		},
		...patch,
	};
}

describe("Routine notification relevance", () => {
	it("keeps only the exact latest terminal outcome relevant", async () => {
		const getRoutine = vi.fn(async () => ({
			archived: false,
			lastRun: { id: "run-1", status: "failed" as const },
		}));
		expect(await isRoutineNotificationRelevant(event(), getRoutine)).toBe(true);
		expect(getRoutine).toHaveBeenCalledWith("routine-1");
	});

	it.each([
		{
			label: "missing Routine",
			state: null,
		},
		{
			label: "archived Routine",
			state: {
				archived: true,
				lastRun: { id: "run-1", status: "failed" as const },
			},
		},
		{
			label: "newer run",
			state: {
				archived: false,
				lastRun: { id: "run-2", status: "succeeded" as const },
			},
		},
		{
			label: "changed status",
			state: {
				archived: false,
				lastRun: { id: "run-1", status: "succeeded" as const },
			},
		},
	])("rejects a $label", async ({ state }) => {
		expect(
			await isRoutineNotificationRelevant(
				event(),
				vi.fn(async () => state),
			),
		).toBe(false);
	});

	it("fails closed for malformed or category-inconsistent metadata", async () => {
		const getRoutine = vi.fn();
		for (const candidate of [
			event({ metadata: {} }),
			event({ sourceId: "other-run" }),
			event({ category: "completion" }),
			event({
				metadata: {
					routineId: "routine-1",
					routineRunId: "run-1",
					status: "running",
				},
			}),
		]) {
			expect(await isRoutineNotificationRelevant(candidate, getRoutine)).toBe(
				false,
			);
		}
		expect(getRoutine).not.toHaveBeenCalled();
	});

	it.each([
		["succeeded", "completion"],
		["action_required", "request"],
		["delivery_error", "problem"],
		["provider_unavailable", "problem"],
		["interrupted", "problem"],
	] as const)("accepts %s only as a %s outcome", async (status, category) => {
		const selected = event({
			category,
			metadata: {
				routineId: "routine-1",
				routineRunId: "run-1",
				status,
			},
		});
		expect(
			await isRoutineNotificationRelevant(
				selected,
				vi.fn(async () => ({
					archived: false,
					lastRun: { id: "run-1", status },
				})),
			),
		).toBe(true);
	});
});
