export const VALID_PAGE_SIZES = [10, 20, 50, 100] as const;
export type PageSize = (typeof VALID_PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: PageSize = 20;

export function isValidSize(value: number): value is PageSize {
	return (VALID_PAGE_SIZES as readonly number[]).includes(value);
}

export const SESSION_SORTS = ["recent", "cost", "tokens"] as const;
export type SessionSortKey = (typeof SESSION_SORTS)[number];

export function parseLedgerSearch(search: Record<string, unknown>): {
	tab: "stats" | "sessions";
	page: number;
	size: PageSize;
	/** Session label filter; omitted from the URL when empty. */
	q?: string;
	/** Vault ("vault") or the persisted cwd for an Einherjar agent. */
	agent?: string;
	/** Effective model filter; omitted from the URL when empty. */
	model?: string;
	/** Session sort; omitted from the URL for the default ("recent"). */
	sort?: SessionSortKey;
} {
	const tab = search.tab === "stats" ? "stats" : "sessions";
	const page =
		typeof search.page === "number" ? Math.max(1, Math.floor(search.page)) : 1;
	const sizeRaw =
		typeof search.size === "number"
			? Math.floor(search.size)
			: DEFAULT_PAGE_SIZE;
	const q =
		typeof search.q === "string" && search.q !== ""
			? search.q.slice(0, 200)
			: undefined;
	const agent =
		typeof search.agent === "string" && search.agent.trim() !== ""
			? search.agent.trim().slice(0, 4096)
			: undefined;
	const model =
		typeof search.model === "string" && search.model.trim() !== ""
			? search.model.trim().slice(0, 200)
			: undefined;
	const sort =
		(SESSION_SORTS as readonly unknown[]).includes(search.sort) &&
		search.sort !== "recent"
			? (search.sort as SessionSortKey)
			: undefined;
	return {
		tab,
		page,
		size: isValidSize(sizeRaw) ? sizeRaw : DEFAULT_PAGE_SIZE,
		q,
		agent,
		model,
		sort,
	};
}

export type LedgerAgentOption = { value: string; label: string };

/**
 * Merge configured names with agent paths observed in persisted sessions.
 * Removed agents stay filterable, while configured agents appear before they
 * have any history. Vault is represented by the dedicated "vault" value.
 */
export function buildLedgerAgentOptions(
	configured: ReadonlyArray<{
		path: string;
		resolvedPath?: string;
		name: string;
	}>,
	observedPaths: readonly string[],
): LedgerAgentOption[] {
	const labels = new Map<string, string>();
	for (const agent of configured) {
		labels.set(agent.resolvedPath ?? agent.path, agent.name);
	}
	for (const path of observedPaths) {
		if (!labels.has(path)) labels.set(path, path);
	}
	return [
		{ value: "vault", label: "Vault" },
		...[...labels].map(([value, label]) => ({ value, label })),
	];
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
