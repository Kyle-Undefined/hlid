import type { ProviderGoalStatus } from "#/server/agentProvider";
import type {
	AgentSleepMessage,
	SessionAttentionBucket,
	SessionAttentionReason,
	SessionAttentionSnapshot,
} from "#/server/protocol";

export type SessionAttentionInput = {
	state: "idle" | "running" | "error";
	permissionCount: number;
	questionCount: number;
	planReviewCount: number;
	permissionIds?: string[];
	questionIds?: string[];
	planReviewIds?: string[];
	queueCount: number;
	goalStatus?: ProviderGoalStatus;
	routine?: boolean;
	terminal?: boolean;
	backgroundRunningCount?: number;
	backgroundFailedCount?: number;
	backgroundCompletedCount?: number;
	sleepState?: Pick<
		AgentSleepMessage,
		"until" | "windowId" | "reason" | "utilization"
	> | null;
};

function classifyAttention(input: SessionAttentionInput): {
	bucket: SessionAttentionBucket;
	reason: SessionAttentionReason;
} {
	if (input.permissionCount > 0) {
		return { bucket: "needs_attention", reason: "permission" };
	}
	if (input.questionCount > 0) {
		return { bucket: "needs_attention", reason: "question" };
	}
	if (input.planReviewCount > 0) {
		return { bucket: "needs_attention", reason: "plan_review" };
	}
	if (input.state === "error") {
		return { bucket: "needs_attention", reason: "error" };
	}
	if ((input.backgroundFailedCount ?? 0) > 0) {
		return { bucket: "needs_attention", reason: "background_failed" };
	}
	if (input.goalStatus === "blocked") {
		return { bucket: "needs_attention", reason: "goal_blocked" };
	}
	if (input.goalStatus === "budgetLimited") {
		return { bucket: "needs_attention", reason: "goal_budget" };
	}
	if (input.sleepState) {
		return { bucket: "sleeping", reason: "usage_sleep" };
	}
	if (input.goalStatus === "paused") {
		return { bucket: "recent", reason: "goal_paused" };
	}
	if (input.goalStatus === "usageLimited") {
		return { bucket: "recent", reason: "goal_usage_wait" };
	}
	if (input.terminal) {
		return { bucket: "working", reason: "terminal" };
	}
	if ((input.backgroundRunningCount ?? 0) > 0) {
		return { bucket: "working", reason: "provider_activity" };
	}
	if (input.state === "running") {
		return {
			bucket: "working",
			reason: input.routine
				? "routine_running"
				: input.goalStatus === "active"
					? "goal_active"
					: "provider_turn",
		};
	}
	if (input.queueCount > 0) {
		return { bucket: "queued", reason: "queued_prompt" };
	}
	if ((input.backgroundCompletedCount ?? 0) > 0) {
		return { bucket: "recent", reason: "background_completed" };
	}
	return {
		bucket: "recent",
		reason: input.goalStatus === "active" ? "goal_active" : "ready",
	};
}

export function deriveSessionAttention(
	input: SessionAttentionInput,
	previous: SessionAttentionSnapshot | undefined,
	now = Date.now(),
): SessionAttentionSnapshot {
	const classified = classifyAttention(input);
	const pendingCount =
		input.permissionCount + input.questionCount + input.planReviewCount;
	const pendingReasonCount =
		classified.reason === "permission"
			? input.permissionCount
			: classified.reason === "question"
				? input.questionCount
				: classified.reason === "plan_review"
					? input.planReviewCount
					: 0;
	const rawPendingIds =
		classified.reason === "permission"
			? input.permissionIds
			: classified.reason === "question"
				? input.questionIds
				: classified.reason === "plan_review"
					? input.planReviewIds
					: undefined;
	const validPendingIds = Array.from(
		new Set(
			(rawPendingIds ?? []).filter(
				(id) =>
					typeof id === "string" &&
					id.length >= 1 &&
					id.length <= 128 &&
					/^[A-Za-z0-9._:-]+$/.test(id),
			),
		),
	).slice(0, 32);
	const hasCurrentRequestIdentity =
		classified.reason === "permission" ||
		classified.reason === "question" ||
		classified.reason === "plan_review";
	const previousPendingIds = previous?.pending_ids ?? [];
	const samePendingIds =
		previousPendingIds.length === validPendingIds.length &&
		previousPendingIds.every((id, index) => id === validPendingIds[index]);
	const sameState =
		previous?.bucket === classified.bucket &&
		previous.reason === classified.reason;
	const sameActivity =
		sameState &&
		previous.queue_count === input.queueCount &&
		previous.pending_count === pendingCount &&
		samePendingIds;

	return {
		...classified,
		since: sameState ? previous.since : now,
		last_activity_at: sameActivity ? previous.last_activity_at : now,
		queue_count: input.queueCount,
		pending_count: pendingCount,
		...(pendingReasonCount > 0
			? { pending_reason_count: pendingReasonCount }
			: {}),
		// An empty array is meaningful for current request snapshots: the manager
		// supplied identity data, but none of it was safe to expose. Undefined is
		// reserved for legacy snapshots that predate exact request identities.
		...(hasCurrentRequestIdentity ? { pending_ids: validPendingIds } : {}),
		...(classified.bucket === "sleeping" && input.sleepState?.until != null
			? { sleep_until: input.sleepState.until }
			: {}),
		...(classified.bucket === "sleeping" && input.sleepState?.windowId
			? { sleep_window_id: input.sleepState.windowId }
			: {}),
	};
}
