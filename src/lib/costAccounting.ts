/**
 * Convert a provider's cumulative session estimate into the increment for the
 * latest turn. A lower reported total means the provider-side counter reset
 * (for example after resuming through a new process), so the new total itself
 * is the increment.
 */
export function cumulativeCostDelta(
	reportedTotal: number,
	previousReportedTotal: number,
): number {
	if (reportedTotal >= previousReportedTotal) {
		return reportedTotal - previousReportedTotal;
	}
	return reportedTotal;
}
