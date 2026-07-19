import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { isPathAccessibleFromRuntime, pathStartsWith } from "#/lib/paths";
import { normalizeSearchText } from "#/lib/search";
import type {
	VaultReferenceItem,
	VaultReferenceSearchResult,
} from "#/lib/vaultReferences";
import { MAX_VAULT_REFERENCES } from "#/lib/vaultReferences";

const INDEX_TTL_MS = 30_000;
const MAX_INDEX_FILES = 20_000;
const DEFAULT_RESULT_LIMIT = 48;
const MAX_RESULT_LIMIT = 100;
const IGNORED_DIRECTORIES = new Set([
	".git",
	".obsidian",
	".trash",
	"node_modules",
]);

type VaultReferenceIndex = {
	root: string;
	builtAt: number;
	items: VaultReferenceItem[];
	truncated: boolean;
};

let cachedIndex: VaultReferenceIndex | null = null;
let inflightIndex: {
	root: string;
	promise: Promise<VaultReferenceIndex>;
} | null = null;

function portableRelativePath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function directoryEntries(entries: Dirent[]): Dirent[] {
	return entries
		.filter((entry) => !entry.isSymbolicLink())
		.sort((left, right) => left.name.localeCompare(right.name));
}

async function buildIndex(root: string): Promise<VaultReferenceIndex> {
	const items: VaultReferenceItem[] = [];
	const pending = [root];
	let truncated = false;

	while (pending.length > 0 && items.length < MAX_INDEX_FILES) {
		const directory = pending.pop();
		if (!directory) break;
		let entries: Dirent[];
		try {
			entries = directoryEntries(
				await readdir(directory, { withFileTypes: true }),
			);
		} catch {
			continue;
		}
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (!entry) continue;
			const fullPath = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			const relativePath = portableRelativePath(root, fullPath);
			items.push({
				relativePath,
				name: entry.name,
				directory: portableRelativePath(root, directory),
			});
			if (items.length >= MAX_INDEX_FILES) {
				truncated = pending.length > 0 || index > 0;
				break;
			}
		}
	}

	items.sort((left, right) => {
		const leftDepth = left.relativePath.split("/").length;
		const rightDepth = right.relativePath.split("/").length;
		return (
			leftDepth - rightDepth ||
			left.relativePath.localeCompare(right.relativePath)
		);
	});
	return { root, builtAt: Date.now(), items, truncated };
}

async function getIndex(root: string): Promise<VaultReferenceIndex> {
	if (
		cachedIndex?.root === root &&
		Date.now() - cachedIndex.builtAt < INDEX_TTL_MS
	) {
		return cachedIndex;
	}
	if (inflightIndex?.root === root) return inflightIndex.promise;
	const promise = buildIndex(root)
		.then((index) => {
			cachedIndex = index;
			return index;
		})
		.finally(() => {
			if (inflightIndex?.promise === promise) inflightIndex = null;
		});
	inflightIndex = { root, promise };
	return promise;
}

function matchRank(item: VaultReferenceItem, normalizedQuery: string): number {
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

// fallow-ignore-next-line unused-export -- Loaded dynamically by the vault-reference server function to keep Node filesystem code out of the client bundle.
export async function searchVaultReferences(options: {
	vaultPath: string;
	vaultName?: string;
	query?: string;
	limit?: number;
}): Promise<VaultReferenceSearchResult> {
	const root = resolve(options.vaultPath);
	const rootLabel = options.vaultName?.trim() || basename(root) || "Vault";
	if (!options.vaultPath) {
		return { rootLabel, items: [], total: 0, truncated: false };
	}
	const index = await getIndex(root);
	const query = normalizeSearchText(options.query?.trim() ?? "");
	const limit = Math.max(
		1,
		Math.min(options.limit ?? DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT),
	);
	const matches = index.items
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
		rootLabel,
		items: matches.slice(0, limit).map((entry) => entry.item),
		total: matches.length,
		truncated: index.truncated || matches.length > limit,
	};
}

function validRelativeReference(path: string): boolean {
	if (
		!path ||
		path.includes("\0") ||
		path.startsWith("/") ||
		/^[A-Za-z]:/.test(path)
	)
		return false;
	return !path.split(/[\\/]+/).some((segment) => segment === ".." || !segment);
}

export type ResolvedVaultReference = {
	relativePath: string;
	path: string;
};

/** Resolve client-supplied relative references and reject escapes/symlinks. */
export async function resolveVaultReferences(options: {
	vaultPath: string;
	references?: readonly string[];
	runtimeCwd?: string;
}): Promise<ResolvedVaultReference[]> {
	const requested = [...new Set(options.references ?? [])].slice(
		0,
		MAX_VAULT_REFERENCES,
	);
	if (!options.vaultPath || requested.length === 0) return [];
	const root = resolve(options.vaultPath);
	const rootReal = await realpath(root).catch(() => root);
	const resolved = await Promise.all(
		requested.map(async (relativePath) => {
			if (!validRelativeReference(relativePath)) return null;
			const candidate = resolve(root, ...relativePath.split(/[\\/]+/));
			const canonical = await realpath(candidate).catch(() => null);
			if (!canonical || !pathStartsWith(rootReal, canonical)) return null;
			if (
				options.runtimeCwd &&
				!isPathAccessibleFromRuntime(options.runtimeCwd, canonical)
			)
				return null;
			const info = await stat(canonical).catch(() => null);
			if (!info?.isFile()) return null;
			return { relativePath, path: canonical };
		}),
	);
	return resolved.filter(
		(reference): reference is ResolvedVaultReference => reference !== null,
	);
}

// fallow-ignore-next-line unused-export -- test-only cache reset
export function resetVaultReferenceIndexForTesting(): void {
	cachedIndex = null;
	inflightIndex = null;
}
