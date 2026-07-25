import type {
	SessionAttentionReason,
	SessionAttentionSnapshot,
} from "#/server/protocol";
import type { RoutineStatus } from "./routines";

export type RoutineAttentionRun = {
	status: RoutineStatus;
	scheduledFor: number;
	startedAt: number | null;
	finishedAt: number | null;
};

function routineReason(status: RoutineStatus): SessionAttentionReason {
	switch (status) {
		case "action_required":
			return "routine_action_required";
		case "delivery_error":
			return "routine_delivery_error";
		case "failed":
			return "routine_failed";
		case "provider_unavailable":
			return "routine_unavailable";
		case "running":
			return "routine_running";
		case "claimed":
			return "routine_queued";
		default:
			return "routine_recent";
	}
}

export function deriveRoutineAttention(
	run: RoutineAttentionRun | null | undefined,
): SessionAttentionSnapshot | undefined {
	if (!run) return undefined;
	const reason = routineReason(run.status);
	const bucket =
		reason === "routine_action_required" ||
		reason === "routine_delivery_error" ||
		reason === "routine_failed" ||
		reason === "routine_unavailable"
			? "needs_attention"
			: reason === "routine_running"
				? "working"
				: reason === "routine_queued"
					? "queued"
					: "recent";
	const atSeconds = run.finishedAt ?? run.startedAt ?? run.scheduledFor;
	const at = atSeconds * 1_000;
	return {
		bucket,
		reason,
		since: at,
		last_activity_at: at,
		queue_count: bucket === "queued" ? 1 : 0,
		pending_count: bucket === "needs_attention" ? 1 : 0,
	};
}
