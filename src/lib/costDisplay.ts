export type CostSummary = {
	cost: number;
	estimated_cost?: number | null;
	unpriced_queries?: number;
};

export function totalDisplayCost(summary: CostSummary): number {
	return summary.cost + (summary.estimated_cost ?? 0);
}

export function formatDisplayCost(summary: CostSummary, digits = 4): string {
	const estimated = summary.estimated_cost ?? 0;
	const total = summary.cost + estimated;
	if (total === 0 && (summary.unpriced_queries ?? 0) > 0) return "--";
	return `${estimated > 0 ? "~" : ""}$${total.toFixed(digits)}`;
}

export function costDisplayNote(summary: CostSummary): string | undefined {
	const estimated = summary.estimated_cost ?? 0;
	const unpriced = summary.unpriced_queries ?? 0;
	if (estimated > 0 && unpriced > 0) {
		return `includes API estimate · ${unpriced} unpriced`;
	}
	if (estimated > 0) return "includes API-equivalent estimate";
	if (unpriced > 0)
		return `${unpriced} unpriced ${unpriced === 1 ? "query" : "queries"}`;
	return undefined;
}
