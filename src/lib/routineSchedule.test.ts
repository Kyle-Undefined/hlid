import { describe, expect, it } from "vitest";
import {
	localTimeInTimezone,
	nextRoutineOccurrence,
	previewRoutineOccurrences,
} from "./routineSchedule";

const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1_000);

describe("routine schedules", () => {
	it("uses the DST-aware local wall clock for schedule defaults", () => {
		expect(
			localTimeInTimezone(
				"America/New_York",
				Date.parse("2026-07-22T20:38:00Z"),
			),
		).toBe("16:38");
		expect(
			localTimeInTimezone(
				"America/New_York",
				Date.parse("2026-01-22T20:38:00Z"),
			),
		).toBe("15:38");
	});

	it("keeps interval schedules anchored instead of drifting", () => {
		const schedule = {
			kind: "interval" as const,
			everyMinutes: 15,
			anchorAt: "2026-07-22T12:00:00Z",
		};
		expect(
			nextRoutineOccurrence(schedule, "UTC", epoch("2026-07-22T12:17:00Z")),
		).toBe(epoch("2026-07-22T12:30:00Z"));
	});

	it("uses compatible DST handling for a skipped local time", () => {
		const next = nextRoutineOccurrence(
			{ kind: "daily", time: "02:30" },
			"America/New_York",
			epoch("2026-03-08T05:00:00Z"),
		);
		// 02:30 does not exist on spring-forward day, so Temporal moves it to 03:30.
		expect(next).toBe(epoch("2026-03-08T07:30:00Z"));
	});

	it("does not run twice during a repeated fall-back hour", () => {
		const occurrences = previewRoutineOccurrences(
			{ kind: "daily", time: "01:30" },
			"America/New_York",
			epoch("2026-11-01T05:00:00Z"),
			2,
		);
		expect(occurrences).toEqual([
			epoch("2026-11-01T05:30:00Z"),
			epoch("2026-11-02T06:30:00Z"),
		]);
	});

	it("filters weekly schedules by ISO weekday", () => {
		const next = nextRoutineOccurrence(
			{ kind: "weekly", time: "09:00", weekdays: [1, 3] },
			"UTC",
			epoch("2026-07-22T10:00:00Z"),
		);
		expect(next).toBe(epoch("2026-07-27T09:00:00Z"));
	});
});
