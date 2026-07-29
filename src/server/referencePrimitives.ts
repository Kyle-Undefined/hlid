import { relative, sep } from "node:path";
import { normalizeSearchText } from "#/lib/search";

type ReferenceSearchItem = {
	relativePath: string;
	name: string;
};

export function portableRelativePath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

export function createReferenceIndexItem(
	root: string,
	path: string,
	directory: string,
	name: string,
): ReferenceSearchItem & { directory: string } {
	return {
		relativePath: portableRelativePath(root, path),
		name,
		directory: portableRelativePath(root, directory),
	};
}

/** Syntax-only guard; callers must still canonicalize and authorize the resolved path. */
export function isSafeRelativeReference(path: string): boolean {
	if (
		!path ||
		path.includes("\0") ||
		path.startsWith("/") ||
		/^[A-Za-z]:/.test(path)
	) {
		return false;
	}
	return !path.split(/[\\/]+/).some((segment) => segment === ".." || !segment);
}

function sortReferenceIndexItems<T extends ReferenceSearchItem>(
	items: T[],
): void {
	items.sort((left, right) => {
		const leftDepth = left.relativePath.split("/").length;
		const rightDepth = right.relativePath.split("/").length;
		return (
			leftDepth - rightDepth ||
			left.relativePath.localeCompare(right.relativePath)
		);
	});
}

export function finalizeReferenceIndex<T extends ReferenceSearchItem>(
	root: string,
	items: T[],
	truncated: boolean,
	builtAt: number,
): { root: string; builtAt: number; items: T[]; truncated: boolean } {
	sortReferenceIndexItems(items);
	return { root, builtAt, items, truncated };
}

export function referenceIndexTruncationAtLimit(
	itemCount: number,
	maxItems: number,
	hasRemainingItems: boolean,
): boolean | null {
	return itemCount >= maxItems ? hasRemainingItems : null;
}

function matchRank(item: ReferenceSearchItem, normalizedQuery: string): number {
	if (!normalizedQuery) return 0;
	const path = normalizeSearchText(item.relativePath);
	const name = normalizeSearchText(item.name);
	const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
	if (!tokens.every((token) => path.includes(token))) return -1;
	if (name.startsWith(normalizedQuery)) return 0;
	if (name.includes(normalizedQuery)) return 1;
	if (path.startsWith(normalizedQuery)) return 2;
	return 3;
}

export function searchReferenceIndex<T extends ReferenceSearchItem>(
	items: readonly T[],
	options: {
		query?: string;
		limit?: number;
		defaultLimit: number;
		maxLimit: number;
	},
): { items: T[]; total: number; truncated: boolean } {
	const query = normalizeSearchText(options.query?.trim() ?? "");
	const limit = Math.max(
		1,
		Math.min(options.limit ?? options.defaultLimit, options.maxLimit),
	);
	const matches = items
		.map((item, ordinal) => ({ item, ordinal, rank: matchRank(item, query) }))
		.filter((entry) => entry.rank >= 0)
		.sort(
			(left, right) =>
				left.rank - right.rank ||
				(query
					? left.item.relativePath.localeCompare(right.item.relativePath)
					: left.ordinal - right.ordinal),
		);
	return {
		items: matches.slice(0, limit).map((entry) => entry.item),
		total: matches.length,
		truncated: matches.length > limit,
	};
}
