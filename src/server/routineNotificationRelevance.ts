import type { PushNotificationEventRecord } from "../db";
import type { RoutineStatus } from "../lib/routines";

type RoutineNotificationState = {
	archived: boolean;
	lastRun?: {
		id: string;
		status: RoutineStatus;
	} | null;
};

type RoutineLookup = (
	routineId: string,
) => Promise<RoutineNotificationState | null>;

const NOTIFIABLE_ROUTINE_STATUSES = new Set<RoutineStatus>([
	"succeeded",
	"action_required",
	"failed",
	"delivery_error",
	"provider_unavailable",
	"interrupted",
]);

function metadataString(
	metadata: Record<string, unknown>,
	key: string,
): string | null {
	const value = metadata[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function categoryForStatus(
	status: RoutineStatus,
): PushNotificationEventRecord["category"] | null {
	if (!NOTIFIABLE_ROUTINE_STATUSES.has(status)) return null;
	if (status === "succeeded") return "completion";
	if (status === "action_required") return "request";
	return "problem";
}

/**
 * Routine outcomes have no read/ack state, but they do have an authoritative
 * latest run. A deferred outcome remains relevant only while it is still the
 * exact terminal result represented by the current, unarchived Routine.
 */
export async function isRoutineNotificationRelevant(
	event: Pick<
		PushNotificationEventRecord,
		"sourceKind" | "sourceId" | "category" | "metadata"
	>,
	getRoutine: RoutineLookup,
): Promise<boolean> {
	if (event.sourceKind !== "routine") return false;
	const routineId = metadataString(event.metadata, "routineId");
	const runId = metadataString(event.metadata, "routineRunId");
	const status = metadataString(
		event.metadata,
		"status",
	) as RoutineStatus | null;
	if (
		!routineId ||
		!runId ||
		!status ||
		runId !== event.sourceId ||
		categoryForStatus(status) !== event.category
	) {
		return false;
	}
	const routine = await getRoutine(routineId);
	return Boolean(
		routine &&
			!routine.archived &&
			routine.lastRun?.id === runId &&
			routine.lastRun.status === status,
	);
}
