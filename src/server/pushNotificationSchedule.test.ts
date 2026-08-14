import { describe, expect, it } from "vitest";
import type { PushPreferences } from "../lib/pushNotificationSchemas";
import { pushNotificationTiming } from "./pushNotificationSchedule";

function preferences(patch: Partial<PushPreferences> = {}): PushPreferences {
	return {
		requests: true,
		problems: true,
		work_finished: false,
		privacy: "generic",
		completion_min_runtime_minutes: 0,
		paused_until: null,
		paused_indefinitely: false,
		quiet_hours: null,
		...patch,
	};
}

describe("push notification timing", () => {
	it("hard-suppresses notifications during a timed pause", () => {
		const now = Date.UTC(2026, 7, 10, 12);
		expect(
			pushNotificationTiming(
				preferences({ paused_until: Math.floor(now / 1_000) + 3_600 }),
				"request",
				now,
			),
		).toEqual({ action: "suppress", reason: "pause" });
	});

	it("hard-suppresses notifications during an indefinite pause", () => {
		expect(
			pushNotificationTiming(
				preferences({ paused_indefinitely: true }),
				"problem",
				Date.UTC(2026, 7, 10, 12),
			),
		).toEqual({ action: "suppress", reason: "pause" });
	});

	it("handles overnight windows and category exceptions in local time", () => {
		const quiet = {
			timezone: "America/New_York",
			start: "22:00",
			end: "07:00",
			weekdays: [1, 2, 3, 4, 5],
			allow_requests: true,
			allow_problems: false,
		};
		// Monday 23:30 EDT.
		const now = Date.UTC(2026, 7, 11, 3, 30);
		expect(
			pushNotificationTiming(
				preferences({ quiet_hours: quiet }),
				"request",
				now,
			),
		).toEqual({ action: "deliver" });
		expect(
			pushNotificationTiming(
				preferences({ quiet_hours: quiet }),
				"problem",
				now,
			),
		).toEqual({ action: "suppress", reason: "quiet_hours" });
		expect(
			pushNotificationTiming(
				preferences({ quiet_hours: quiet }),
				"completion",
				Date.UTC(2026, 7, 11, 12),
			),
		).toEqual({ action: "deliver" });
	});

	it("hard-suppresses quiet-hour work without deferring it", () => {
		const now = Date.UTC(2026, 7, 10, 23);
		expect(
			pushNotificationTiming(
				preferences({
					quiet_hours: {
						timezone: "UTC",
						start: "22:00",
						end: "07:00",
						weekdays: [1],
						allow_requests: false,
						allow_problems: false,
					},
				}),
				"completion",
				now,
			),
		).toEqual({ action: "suppress", reason: "quiet_hours" });
	});
});
