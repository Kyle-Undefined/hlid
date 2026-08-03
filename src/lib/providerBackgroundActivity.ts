import type { ProviderBackgroundActivity } from "#/server/agentProvider";

/** Keep live work first, then newest provider activity, with a stable id tie-break. */
export function compareProviderBackgroundActivity(
	left: ProviderBackgroundActivity,
	right: ProviderBackgroundActivity,
): number {
	return (
		Number(right.status === "running") - Number(left.status === "running") ||
		right.updatedAtMs - left.updatedAtMs ||
		left.activityId.localeCompare(right.activityId)
	);
}
