import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { HlidConfig } from "#/config";
import {
	expandTilde,
	explicitPathEnvironment,
	isPathAccessibleFromRuntime,
	pathStartsWith,
	samePath,
} from "#/lib/paths";
import {
	MAX_WORKSPACE_REFERENCES,
	type WorkspaceReferenceEnvironment,
	type WorkspaceReferenceItem,
	type WorkspaceReferencePreview,
	type WorkspaceReferenceRequest,
	type WorkspaceReferenceSearchResult,
	type WorkspaceReferenceSelection,
} from "#/lib/vaultReferences";
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
const MAX_INDEX_DEPTH = 12;
const DEFAULT_RESULT_LIMIT = 32;
const MAX_RESULT_LIMIT = 100;
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024;
const IGNORED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	".cache",
	".claude",
	".codex",
	".config",
	".gemini",
	".next",
	".nuxt",
	".openai",
	".parcel-cache",
	".pnpm-store",
	".turbo",
	".venv",
	".yarn",
	".aws",
	".azure",
	".gnupg",
	".hlid",
	".ssh",
	"__pycache__",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"target",
	"vendor",
	"venv",
]);
const SAFE_ENV_SUFFIXES = [".example", ".sample", ".template"];
const SECRET_FILENAMES = new Set([
	".npmrc",
	".pypirc",
	"credentials.json",
	"secrets.json",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"id_rsa",
]);
const SECRET_EXTENSIONS = [".key", ".p12", ".pfx", ".pem"];

type WorkspaceReferenceIndex = {
	root: string;
	builtAt: number;
	items: WorkspaceReferenceItem[];
	truncated: boolean;
};

const cachedIndexes = new Map<string, WorkspaceReferenceIndex>();
const inflightIndexes = new Map<string, Promise<WorkspaceReferenceIndex>>();

function isKnownSecret(relativePath: string): boolean {
	const name = basename(relativePath).toLowerCase();
	if (
		name === ".env" ||
		(name.startsWith(".env.") &&
			!SAFE_ENV_SUFFIXES.some((suffix) => name.endsWith(suffix)))
	) {
		return true;
	}
	if (SECRET_FILENAMES.has(name)) return true;
	if (name.startsWith("secrets.") || name.startsWith("credentials."))
		return true;
	return SECRET_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function environmentForPath(path: string): {
	environment: WorkspaceReferenceEnvironment;
	environmentLabel: string;
} {
	const explicit = explicitPathEnvironment(path, {
		platform: process.platform,
		allowWindowsUnc: true,
	});
	if (explicit) return explicit;
	const distro = process.env.WSL_DISTRO_NAME;
	return distro
		? { environment: "wsl", environmentLabel: `WSL · ${distro}` }
		: { environment: "host", environmentLabel: "Host" };
}

async function authorizedWorkspaceRoot(
	requestedCwd: string,
	allowedRoots: readonly string[],
): Promise<string> {
	const requested = await realpath(resolve(expandTilde(requestedCwd))).catch(
		() => null,
	);
	if (!requested) throw new Error("This workspace is no longer available.");
	const configured = allowedRoots
		.filter(Boolean)
		.map((path) => resolve(expandTilde(path)));
	const allowed = await Promise.all(
		configured.map((path) => realpath(path).catch(() => null)),
	);
	if (!allowed.some((path) => path && samePath(path, requested))) {
		throw new Error("This workspace is not registered with Hlid.");
	}
	return requested;
}

function configuredWorkspaceRoots(config: HlidConfig): string[] {
	return [
		config.vault.path,
		...(config.agents ?? []).map((agent) => agent.path),
	].filter(Boolean);
}

async function buildIndex(root: string): Promise<WorkspaceReferenceIndex> {
	const items: WorkspaceReferenceItem[] = [];
	const pending: Array<{ directory: string; depth: number }> = [
		{ directory: root, depth: 0 },
	];
	let truncated = false;
	while (pending.length > 0 && items.length < MAX_INDEX_FILES) {
		const current = pending.pop();
		if (!current) break;
		let entries: Dirent[];
		try {
			entries = (await readdir(current.directory, { withFileTypes: true }))
				.filter((entry) => !entry.isSymbolicLink())
				.sort((left, right) => left.name.localeCompare(right.name));
		} catch {
			continue;
		}
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (!entry) continue;
			const fullPath = resolve(current.directory, entry.name);
			if (entry.isDirectory()) {
				if (
					current.depth < MAX_INDEX_DEPTH &&
					!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())
				) {
					pending.push({ directory: fullPath, depth: current.depth + 1 });
				} else if (current.depth >= MAX_INDEX_DEPTH) {
					truncated = true;
				}
				continue;
			}
			if (!entry.isFile()) continue;
			const item = createReferenceIndexItem(
				root,
				fullPath,
				current.directory,
				entry.name,
			);
			if (isKnownSecret(item.relativePath)) continue;
			items.push(item);
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

async function getIndex(root: string): Promise<WorkspaceReferenceIndex> {
	const cached = cachedIndexes.get(root);
	if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) return cached;
	const inflight = inflightIndexes.get(root);
	if (inflight) return inflight;
	const promise = buildIndex(root)
		.then((index) => {
			cachedIndexes.set(root, index);
			if (cachedIndexes.size > 8) {
				const oldest = [...cachedIndexes.entries()].sort(
					(left, right) => left[1].builtAt - right[1].builtAt,
				)[0]?.[0];
				if (oldest) cachedIndexes.delete(oldest);
			}
			return index;
		})
		.finally(() => inflightIndexes.delete(root));
	inflightIndexes.set(root, promise);
	return promise;
}

async function resolveWorkspaceFile(
	allowedRoots: readonly string[],
	agentCwd: string,
	relativePath: string,
): Promise<{ root: string; path: string }> {
	if (!isSafeRelativeReference(relativePath) || isKnownSecret(relativePath)) {
		throw new Error("That workspace file cannot be referenced.");
	}
	const root = await authorizedWorkspaceRoot(agentCwd, allowedRoots);
	const candidate = resolve(root, ...relativePath.split(/[\\/]+/));
	const canonical = await realpath(candidate).catch(() => null);
	if (!canonical || !pathStartsWith(root, canonical)) {
		throw new Error("That workspace file is outside the active workspace.");
	}
	const info = await stat(canonical).catch(() => null);
	if (!info?.isFile()) throw new Error("That workspace file is unavailable.");
	if (info.size > MAX_REFERENCE_BYTES) {
		throw new Error("Workspace references are limited to 4 MB files.");
	}
	return { root, path: canonical };
}

function decodeText(bytes: Buffer): string {
	if (bytes.includes(0))
		throw new Error("Binary files cannot be referenced yet.");
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("Only UTF-8 text files can be referenced.");
	}
	const controls = [...bytes].filter(
		(byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13,
	).length;
	if (controls > Math.max(2, bytes.length * 0.01)) {
		throw new Error("Binary files cannot be referenced yet.");
	}
	return content;
}

function decodeTextPreview(bytes: Buffer, truncated: boolean): string {
	return new TextDecoder("utf-8").decode(bytes, { stream: truncated });
}

function rasterImageMime(bytes: Buffer): string | null {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return "image/jpeg";
	}
	const header = bytes.subarray(0, 6).toString("ascii");
	if (header === "GIF87a" || header === "GIF89a") return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return null;
}

function referenceContentType(
	bytes: Buffer,
): Pick<WorkspaceReferenceSelection, "previewKind" | "mime"> {
	const mime = rasterImageMime(bytes);
	if (mime) return { previewKind: "image", mime };
	decodeText(bytes);
	return { previewKind: "text", mime: "text/plain" };
}

// fallow-ignore-next-line unused-export -- Loaded dynamically by the workspace-reference server function to keep Node filesystem code out of the client bundle.
export async function searchWorkspaceReferences(options: {
	config: HlidConfig;
	agentCwd: string;
	query?: string;
	limit?: number;
}): Promise<WorkspaceReferenceSearchResult> {
	const root = await authorizedWorkspaceRoot(
		options.agentCwd,
		configuredWorkspaceRoots(options.config),
	);
	const index = await getIndex(root);
	const matches = searchReferenceIndex(index.items, {
		query: options.query,
		limit: options.limit,
		defaultLimit: DEFAULT_RESULT_LIMIT,
		maxLimit: MAX_RESULT_LIMIT,
	});
	return {
		rootLabel: basename(root) || "Workspace",
		...environmentForPath(root),
		items: matches.items,
		total: matches.total,
		truncated: index.truncated || matches.truncated,
	};
}

// fallow-ignore-next-line unused-export -- Loaded dynamically by the workspace-reference server function to keep Node filesystem code out of the client bundle.
export async function previewWorkspaceReference(options: {
	config: HlidConfig;
	agentCwd: string;
	relativePath: string;
}): Promise<WorkspaceReferencePreview> {
	const { bytes, selection } = await loadWorkspaceReference(options);
	if (selection.previewKind === "image") {
		return {
			...selection,
			previewKind: "image",
			dataUrl: `data:${selection.mime};base64,${bytes.toString("base64")}`,
			truncated: false,
		};
	}
	const previewBytes = bytes.subarray(0, MAX_PREVIEW_BYTES);
	return {
		...selection,
		previewKind: "text",
		content: decodeTextPreview(previewBytes, bytes.length > MAX_PREVIEW_BYTES),
		truncated: bytes.length > MAX_PREVIEW_BYTES,
	};
}

async function loadWorkspaceReference(options: {
	config: HlidConfig;
	agentCwd: string;
	relativePath: string;
}): Promise<{ bytes: Buffer; selection: WorkspaceReferenceSelection }> {
	const resolved = await resolveWorkspaceFile(
		configuredWorkspaceRoots(options.config),
		options.agentCwd,
		options.relativePath,
	);
	const bytes = await readFile(resolved.path);
	const contentType = referenceContentType(bytes);
	const common: WorkspaceReferenceSelection = {
		relativePath: options.relativePath,
		name: basename(resolved.path),
		directory: portableRelativePath(
			resolved.root,
			resolve(resolved.path, ".."),
		),
		sizeBytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		...environmentForPath(resolved.root),
		...contentType,
	};
	return { bytes, selection: common };
}

// fallow-ignore-next-line unused-export -- Loaded dynamically by the workspace-reference server function to keep Node filesystem code out of the client bundle.
export async function selectWorkspaceReference(options: {
	config: HlidConfig;
	agentCwd: string;
	relativePath: string;
}): Promise<WorkspaceReferenceSelection> {
	return (await loadWorkspaceReference(options)).selection;
}

export type ResolvedWorkspaceReference = WorkspaceReferenceRequest & {
	path: string;
	sizeBytes: number;
	environment: WorkspaceReferenceEnvironment;
	environmentLabel: string;
	previewKind: "text" | "image";
	mime: string;
};

export async function resolveWorkspaceReferences(options: {
	allowedWorkspaceRoots: readonly string[];
	agentCwd?: string;
	runtimeCwd?: string;
	references?: readonly WorkspaceReferenceRequest[];
}): Promise<ResolvedWorkspaceReference[]> {
	const requested = [...(options.references ?? [])].slice(
		0,
		MAX_WORKSPACE_REFERENCES,
	);
	if (requested.length === 0) return [];
	if (!options.agentCwd) {
		throw new Error("Workspace references require an active workspace.");
	}
	const resolved: ResolvedWorkspaceReference[] = [];
	for (const reference of requested) {
		const file = await resolveWorkspaceFile(
			options.allowedWorkspaceRoots,
			options.agentCwd,
			reference.relativePath,
		);
		const bytes = await readFile(file.path);
		const contentType = referenceContentType(bytes);
		if (
			options.runtimeCwd &&
			!isPathAccessibleFromRuntime(options.runtimeCwd, file.path)
		) {
			throw new Error(
				`${reference.relativePath} is not accessible from the provider environment.`,
			);
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (sha256 !== reference.sha256) {
			throw new Error(
				`${reference.relativePath} changed after selection. Select it again before sending.`,
			);
		}
		resolved.push({
			relativePath: reference.relativePath,
			path: file.path,
			sizeBytes: bytes.length,
			sha256,
			...environmentForPath(file.root),
			...contentType,
		});
	}
	return resolved;
}

// fallow-ignore-next-line unused-export -- test-only cache reset
export function resetWorkspaceReferenceIndexesForTesting(): void {
	cachedIndexes.clear();
	inflightIndexes.clear();
}
