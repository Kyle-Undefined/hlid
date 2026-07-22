import { Temporal } from "@js-temporal/polyfill";
import type { RoutineSchedule } from "./routines";

function parseTime(time: string): Temporal.PlainTime {
	return Temporal.PlainTime.from(`${time}:00`);
}

/** Return the HH:mm wall-clock time for an instant in an IANA timezone. */
export function localTimeInTimezone(
	timezone: string,
	epochMilliseconds = Date.now(),
): string {
	const local =
		Temporal.Instant.fromEpochMilliseconds(
			epochMilliseconds,
		).toZonedDateTimeISO(timezone);
	return `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
}

function zonedCandidate(
	date: Temporal.PlainDate,
	time: string,
	timezone: string,
): Temporal.ZonedDateTime {
	return date
		.toPlainDateTime(parseTime(time))
		.toZonedDateTime(timezone, { disambiguation: "compatible" });
}

/** Return the first occurrence strictly after `afterEpochSeconds`. */
export function nextRoutineOccurrence(
	schedule: RoutineSchedule,
	timezone: string,
	afterEpochSeconds: number,
): number | null {
	if (schedule.kind === "once") {
		const at = Math.floor(
			Temporal.Instant.from(schedule.at).epochMilliseconds / 1_000,
		);
		return at > afterEpochSeconds ? at : null;
	}
	if (schedule.kind === "interval") {
		const anchor = Math.floor(
			Temporal.Instant.from(schedule.anchorAt).epochMilliseconds / 1_000,
		);
		const interval = schedule.everyMinutes * 60;
		if (afterEpochSeconds < anchor) return anchor;
		return (
			anchor +
			(Math.floor((afterEpochSeconds - anchor) / interval) + 1) * interval
		);
	}

	const after = Temporal.Instant.fromEpochMilliseconds(
		afterEpochSeconds * 1_000,
	);
	const local = after.toZonedDateTimeISO(timezone);
	const allowed =
		schedule.kind === "weekly" ? new Set(schedule.weekdays) : null;
	for (let offset = 0; offset <= 370; offset++) {
		const date = local.toPlainDate().add({ days: offset });
		if (allowed && !allowed.has(date.dayOfWeek)) continue;
		const candidate = zonedCandidate(date, schedule.time, timezone);
		const epoch = Math.floor(candidate.epochMilliseconds / 1_000);
		if (epoch > afterEpochSeconds) return epoch;
	}
	return null;
}

export function previewRoutineOccurrences(
	schedule: RoutineSchedule,
	timezone: string,
	afterEpochSeconds: number,
	count = 3,
): number[] {
	const occurrences: number[] = [];
	let cursor = afterEpochSeconds;
	for (let index = 0; index < count; index++) {
		const next = nextRoutineOccurrence(schedule, timezone, cursor);
		if (next === null) break;
		occurrences.push(next);
		cursor = next;
	}
	return occurrences;
}
