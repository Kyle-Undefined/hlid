export const VALID_PAGE_SIZES = [10, 20, 50, 100] as const;
export type PageSize = (typeof VALID_PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: PageSize = 20;

export function isValidSize(value: number): value is PageSize {
	return (VALID_PAGE_SIZES as readonly number[]).includes(value);
}

export const SESSION_SORTS = ["recent", "cost", "tokens"] as const;
export type SessionSortKey = (typeof SESSION_SORTS)[number];
export const LEDGER_STATS_RANGES = [
	"today",
	"7d",
	"30d",
	"90d",
	"all",
	"custom",
] as const;
export type LedgerStatsRange = (typeof LEDGER_STATS_RANGES)[number];

function parseDateValue(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return undefined;
	}
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) &&
		date.toISOString().slice(0, 10) === value
		? value
		: undefined;
}

function parsePage(value: unknown): number {
	if (typeof value !== "number") return 1;
	return Math.max(1, Math.floor(value));
}

function parsePageSize(value: unknown): PageSize {
	const size =
		typeof value === "number" ? Math.floor(value) : DEFAULT_PAGE_SIZE;
	return isValidSize(size) ? size : DEFAULT_PAGE_SIZE;
}

function parseBoundedString(
	value: unknown,
	maxLength: number,
): string | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	return value.slice(0, maxLength);
}

function parseTrimmedString(
	value: unknown,
	maxLength: number,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function parseEnumValue<T extends string>(
	value: unknown,
	valid: readonly T[],
): T | undefined {
	return valid.includes(value as T) ? (value as T) : undefined;
}

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
	/** Provider filter shared by Stats and session drill-downs. */
	provider?: string;
	/** Stop-reason drill-down filter. */
	stop?: string;
	/** Global Stats time window. */
	range?: LedgerStatsRange;
	/** Inclusive local-calendar boundaries used by the custom Stats range. */
	from?: string;
	to?: string;
	/** Session sort; omitted from the URL for the default ("recent"). */
	sort?: SessionSortKey;
	/** True when browsing sessions hidden from the active Ledger list. */
	archived?: boolean;
} {
	const tab = search.tab === "stats" ? "stats" : "sessions";
	const page = parsePage(search.page);
	const size = parsePageSize(search.size);
	const q = parseBoundedString(search.q, 200);
	const agent = parseTrimmedString(search.agent, 4096);
	const model = parseTrimmedString(search.model, 200);
	const provider = parseTrimmedString(search.provider, 100);
	const stop = parseTrimmedString(search.stop, 100);
	const range = parseEnumValue(search.range, LEDGER_STATS_RANGES);
	const from = parseDateValue(search.from);
	const to = parseDateValue(search.to);
	const parsedSort = parseEnumValue(search.sort, SESSION_SORTS);
	const sort = parsedSort === "recent" ? undefined : parsedSort;
	const archived =
		search.archived === true ||
		search.archived === "true" ||
		search.archived === 1 ||
		search.archived === "1"
			? true
			: undefined;
	return {
		tab,
		page,
		size,
		q,
		agent,
		model,
		provider,
		stop,
		range,
		from,
		to,
		sort,
		archived,
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
