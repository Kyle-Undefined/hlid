import type {
	PushNotificationCategory,
	PushPreferences,
	PushQuietHours,
} from "../lib/pushNotificationSchemas";

export type PushNotificationTiming =
	| { action: "deliver" }
	| { action: "suppress"; reason: "pause" | "quiet_hours" };

type LocalClock = {
	year: number;
	month: number;
	day: number;
	weekday: number;
	minute: number;
};

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

function clockFormatter(timezone: string): Intl.DateTimeFormat {
	let formatter = clockFormatters.get(timezone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		clockFormatters.set(timezone, formatter);
	}
	return formatter;
}

const WEEKDAY_NUMBER: Record<string, number> = {
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
	Sun: 7,
};

function localClock(timestamp: number, timezone: string): LocalClock {
	const values = Object.fromEntries(
		clockFormatter(timezone)
			.formatToParts(timestamp)
			.map((part) => [part.type, part.value]),
	);
	return {
		year: Number(values.year),
		month: Number(values.month),
		day: Number(values.day),
		weekday: WEEKDAY_NUMBER[values.weekday ?? ""] ?? 1,
		minute: Number(values.hour) * 60 + Number(values.minute),
	};
}

function clockMinute(value: string): number {
	const [hour = "0", minute = "0"] = value.split(":");
	return Number(hour) * 60 + Number(minute);
}

function previousWeekday(value: number): number {
	return value === 1 ? 7 : value - 1;
}

function quietAt(
	quiet: PushQuietHours,
	clock: Pick<LocalClock, "weekday" | "minute">,
): boolean {
	const selected = new Set(quiet.weekdays);
	const start = clockMinute(quiet.start);
	const end = clockMinute(quiet.end);
	if (start === end) return selected.has(clock.weekday);
	if (start < end) {
		return (
			selected.has(clock.weekday) && clock.minute >= start && clock.minute < end
		);
	}
	return (
		(selected.has(clock.weekday) && clock.minute >= start) ||
		(selected.has(previousWeekday(clock.weekday)) && clock.minute < end)
	);
}

function quietAllows(
	quiet: PushQuietHours,
	category: PushNotificationCategory,
): boolean {
	return (
		(category === "request" && quiet.allow_requests) ||
		(category === "problem" && quiet.allow_problems)
	);
}

/** Resolve per-device pause and quiet-hour timing without widening overrides. */
export function pushNotificationTiming(
	preferences: PushPreferences,
	category: PushNotificationCategory,
	nowMs = Date.now(),
): PushNotificationTiming {
	if (preferences.paused_indefinitely) {
		return { action: "suppress", reason: "pause" };
	}
	const pausedUntilMs =
		preferences.paused_until === null ? null : preferences.paused_until * 1_000;
	if (pausedUntilMs !== null && pausedUntilMs > nowMs) {
		return { action: "suppress", reason: "pause" };
	}
	const quiet = preferences.quiet_hours;
	if (
		quiet === null ||
		quietAllows(quiet, category) ||
		!quietAt(quiet, localClock(nowMs, quiet.timezone))
	) {
		return { action: "deliver" };
	}
	return { action: "suppress", reason: "quiet_hours" };
}
