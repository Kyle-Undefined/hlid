import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isPathAccessibleFromRuntime, pathStartsWith } from "#/lib/paths";
import type {
	VaultReferenceItem,
	VaultReferenceSearchResult,
} from "#/lib/vaultReferences";
import { MAX_VAULT_REFERENCES } from "#/lib/vaultReferences";
import {
	createReferenceIndexItem,
	finalizeReferenceIndex,
	isSafeRelativeReference,
	portableRelativePath,
	referenceIndexTruncationAtLimit,
	searchReferenceIndex,
} from "./referencePrimitives";

const INDEX_TTL_MS = 30_000;
const MAX_INDEX_FILES = 20_000;
const DEFAULT_RESULT_LIMIT = 48;
const MAX_RESULT_LIMIT = 100;
const MAX_PREVIEW_CHARS = 64 * 1024;
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

function directoryEntries(entries: Dirent[]): Dirent[] {
	return entries
		.filter((entry) => !entry.isSymbolicLink())
		.sort((left, right) => left.name.localeCompare(right.name));
}

async function buildIndex(root: string): Promise<VaultReferenceIndex> {
	const items: VaultReferenceItem[] = [];
	const pending = [root];
	const truncated = false;

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
			items.push(
				createReferenceIndexItem(root, fullPath, directory, entry.name),
			);
			const limitTruncation = referenceIndexTruncationAtLimit(
				items.length,
				MAX_INDEX_FILES,
				pending.length > 0 || index > 0,
			);
			if (limitTruncation !== null) {
				return finalizeReferenceIndex(root, items, limitTruncation, Date.now());
			}
		}
	}

	return finalizeReferenceIndex(root, items, truncated, Date.now());
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

// fallow-ignore-next-line unused-export -- Loaded dynamically by the vault-reference server function to keep Node filesystem code out of the client bundle.
export async function searchVaultReferences(options: {
	vaultPath: string;
	vaultName?: string;
	query?: string;
	limit?: number;
	notesOnly?: boolean;
}): Promise<VaultReferenceSearchResult> {
	const root = resolve(options.vaultPath);
	const rootLabel = options.vaultName?.trim() || basename(root) || "Vault";
	if (!options.vaultPath) {
		return { rootLabel, items: [], total: 0, truncated: false };
	}
	const index = await getIndex(root);
	const sourceItems = options.notesOnly
		? index.items.filter((item) =>
				item.relativePath.toLowerCase().endsWith(".md"),
			)
		: index.items;
	const matches = searchReferenceIndex(sourceItems, {
		query: options.query,
		limit: options.limit,
		defaultLimit: DEFAULT_RESULT_LIMIT,
		maxLimit: MAX_RESULT_LIMIT,
	});
	return {
		rootLabel,
		items: matches.items,
		total: matches.total,
		truncated: index.truncated || matches.truncated,
	};
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
			if (!isSafeRelativeReference(relativePath)) return null;
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

// fallow-ignore-next-line unused-export -- Loaded dynamically by the vault-reference server function to keep Node and Obsidian access out of the client bundle.
export async function previewVaultReference(options: {
	vaultPath: string;
	relativePath: string;
	read: (relativePath: string) => Promise<string>;
}): Promise<import("#/lib/vaultReferences").VaultReferencePreview> {
	const [resolved] = await resolveVaultReferences({
		vaultPath: options.vaultPath,
		references: [options.relativePath],
	});
	if (!resolved) throw new Error("The requested vault note was not found.");
	const content = await options.read(resolved.relativePath);
	return {
		relativePath: resolved.relativePath,
		name: basename(resolved.relativePath),
		directory: portableRelativePath(
			resolve(options.vaultPath),
			resolve(resolved.path, ".."),
		),
		content: content.slice(0, MAX_PREVIEW_CHARS),
		truncated: content.length > MAX_PREVIEW_CHARS,
	};
}

// fallow-ignore-next-line unused-export -- test-only cache reset
export function resetVaultReferenceIndexForTesting(): void {
	cachedIndex = null;
	inflightIndex = null;
}
