export const VALID_PAGE_SIZES = [10, 20, 50, 100] as const;
export type PageSize = (typeof VALID_PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: PageSize = 20;

export function isValidSize(value: number): value is PageSize {
	return (VALID_PAGE_SIZES as readonly number[]).includes(value);
}

export function parseLedgerSearch(search: Record<string, unknown>): {
	tab: "stats" | "sessions";
	page: number;
	size: PageSize;
} {
	const tab = search.tab === "stats" ? "stats" : "sessions";
	const page =
		typeof search.page === "number" ? Math.max(1, Math.floor(search.page)) : 1;
	const sizeRaw =
		typeof search.size === "number"
			? Math.floor(search.size)
			: DEFAULT_PAGE_SIZE;
	return {
		tab,
		page,
		size: isValidSize(sizeRaw) ? sizeRaw : DEFAULT_PAGE_SIZE,
	};
}

export function filterOptimisticIds(
	previous: Set<string>,
	freshIds: Set<string>,
): Set<string> {
	if (previous.size === 0) return previous;
	const next = new Set([...previous].filter((id) => freshIds.has(id)));
	return next.size === previous.size ? previous : next;
}

export function filterOptimisticLabels(
	previous: Map<string, string>,
	freshIds: Set<string>,
): Map<string, string> {
	if (previous.size === 0) return previous;
	const next = new Map([...previous].filter(([id]) => freshIds.has(id)));
	return next.size === previous.size ? previous : next;
}
