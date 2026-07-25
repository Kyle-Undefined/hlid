import type { ProviderGoalStatus } from "#/server/agentProvider";
import type {
	SessionAttentionBucket,
	SessionAttentionReason,
	SessionAttentionSnapshot,
} from "#/server/protocol";

export type SessionAttentionInput = {
	state: "idle" | "running" | "error";
	permissionCount: number;
	questionCount: number;
	planReviewCount: number;
	queueCount: number;
	goalStatus?: ProviderGoalStatus;
	routine?: boolean;
	terminal?: boolean;
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
	if (input.goalStatus === "blocked") {
		return { bucket: "needs_attention", reason: "goal_blocked" };
	}
	if (input.goalStatus === "budgetLimited") {
		return { bucket: "needs_attention", reason: "goal_budget" };
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
	const sameState =
		previous?.bucket === classified.bucket &&
		previous.reason === classified.reason;
	const sameActivity =
		sameState &&
		previous.queue_count === input.queueCount &&
		previous.pending_count === pendingCount;

	return {
		...classified,
		since: sameState ? previous.since : now,
		last_activity_at: sameActivity ? previous.last_activity_at : now,
		queue_count: input.queueCount,
		pending_count: pendingCount,
	};
}
