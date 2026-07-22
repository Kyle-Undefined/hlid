import { randomBytes } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, posix, resolve } from "node:path";
import { parseFrontmatter } from "../lib/frontmatter";
import { pathStartsWith } from "../lib/paths";
import {
	managedSkillsDirectory,
	prepareLibrary,
	safeLibrarySegment,
	skillStagingDirectory,
	stagedSkillDirectory,
} from "./libraryStore";
import { managedSkillPackages, validatePackageTree } from "./skillImports";

const GITHUB_API = "https://api.github.com";
const MAX_SKILL_DOCUMENT_BYTES = 1024 * 1024;
const MAX_IMPORT_FILES = 2_000;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const STAGE_TTL_MS = 24 * 60 * 60 * 1000;
const STAGE_ID = /^[0-9a-f]{24}$/;

type GitHubSkillSource = {
	owner: string;
	repo: string;
	ref: string;
	path: string;
};

type RemoteSkillSource = {
	owner: string;
	repo: string;
	ref: string | null;
	path: string | null;
	skillSlug: string | null;
};

type GitHubContentItem = {
	type?: unknown;
	name?: unknown;
	path?: unknown;
	size?: unknown;
	sha?: unknown;
	encoding?: unknown;
	content?: unknown;
};

type GitHubTreeItem = {
	path?: unknown;
	type?: unknown;
	mode?: unknown;
	size?: unknown;
};

type GitHubTree = {
	tree?: unknown;
	truncated?: unknown;
};

export type StagedSkillFile = {
	path: string;
	bytes: number;
	readable: boolean;
};

export type StagedSkillReview = {
	id: string;
	name: string;
	description: string;
	sourceUrl: string;
	repository: string;
	requestedRef: string;
	resolvedSha: string;
	repositoryPath: string;
	createdAt: string;
	files: StagedSkillFile[];
	fileCount: number;
	bytes: number;
	skillDocument: string;
};

export type ManagedSkillSummary = {
	id: string;
	name: string;
	description: string;
	source: string;
	sourceUrl: string | null;
	resolvedSha: string | null;
	importedAt: string | null;
	fileCount: number;
	bytes: number;
};

export type RemoteSkillCandidate = {
	name: string;
	sourceUrl: string;
	repositoryPath: string;
	alreadyInstalled: boolean;
};

export type RemoteSkillDiscovery = {
	repository: string;
	requestedRef: string;
	resolvedSha: string;
	skills: RemoteSkillCandidate[];
};

type StageMetadata = StagedSkillReview & { packageName: string };

function githubHeaders(): HeadersInit {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	return {
		accept: "application/vnd.github+json",
		"user-agent": "hlid-skill-review",
		"x-github-api-version": "2022-11-28",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

async function githubJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: githubHeaders(),
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		let message = `GitHub request failed with HTTP ${response.status}`;
		try {
			const body = (await response.json()) as { message?: unknown };
			if (typeof body.message === "string" && body.message.trim()) {
				message = body.message;
			}
		} catch {
			// Keep the status-based error when GitHub did not return JSON.
		}
		throw new Error(message);
	}
	return response.json() as Promise<T>;
}

function cleanSegment(value: string, label: string): string {
	const decoded = decodeURIComponent(value);
	if (
		!decoded ||
		decoded === "." ||
		decoded === ".." ||
		/[\\/]/.test(decoded)
	) {
		throw new Error(`Invalid GitHub ${label}`);
	}
	return decoded;
}

function cleanRepoPath(parts: string[]): string {
	const cleaned = parts.map((part) => cleanSegment(part, "path"));
	const path = posix.normalize(cleaned.join("/"));
	if (
		!path ||
		path === "." ||
		path.startsWith("../") ||
		posix.isAbsolute(path)
	) {
		throw new Error("GitHub skill URL must include a skill directory");
	}
	return path;
}

function cleanRepository(ownerValue: string, repoValue: string) {
	const owner = cleanSegment(ownerValue, "owner");
	const repo = cleanSegment(repoValue, "repository").replace(/\.git$/i, "");
	if (!repo) throw new Error("Invalid GitHub repository");
	return { owner, repo };
}

function parseRemoteSkillSource(input: string): RemoteSkillSource {
	const value = input.trim();
	if (/^[^\s/]+\/[^\s/]+$/.test(value)) {
		const [ownerValue = "", repoValue = ""] = value.split("/");
		return {
			...cleanRepository(ownerValue, repoValue),
			ref: null,
			path: null,
			skillSlug: null,
		};
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Enter owner/repo or a GitHub or skills.sh URL");
	}
	if (url.protocol !== "https:") {
		throw new Error("Only HTTPS skill URLs are supported");
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	const parts = url.pathname.split("/").filter(Boolean);
	if (host === "skills.sh") {
		if (parts.length !== 3) {
			throw new Error("Enter a skills.sh page for one GitHub-backed skill");
		}
		return {
			...cleanRepository(parts[0] ?? "", parts[1] ?? ""),
			ref: null,
			path: null,
			skillSlug: cleanSegment(parts[2] ?? "", "skill"),
		};
	}
	if (host !== "github.com") {
		throw new Error("Only GitHub and skills.sh skill URLs are supported");
	}
	if (parts.length < 2) throw new Error("GitHub URL must include owner/repo");
	const repository = cleanRepository(parts[0] ?? "", parts[1] ?? "");
	if (parts.length === 2) {
		return {
			...repository,
			ref: null,
			path: null,
			skillSlug: null,
		};
	}
	if (parts[2] !== "tree" && parts[2] !== "blob") {
		throw new Error("Use a GitHub repository, tree, or SKILL.md URL");
	}
	if (parts.length < 5) {
		throw new Error("GitHub skill URL must include a ref and path");
	}
	const ref = cleanSegment(parts[3] ?? "", "ref");
	let path = cleanRepoPath(parts.slice(4));
	if (parts[2] === "blob") {
		if (basename(path).toLowerCase() !== "skill.md") {
			throw new Error("GitHub blob URLs must point to SKILL.md");
		}
		path = posix.dirname(path);
	}
	return { ...repository, ref, path, skillSlug: null };
}

export function parseGitHubSkillUrl(input: string): GitHubSkillSource {
	const source = parseRemoteSkillSource(input);
	if (!source.ref || !source.path) {
		throw new Error("GitHub skill URL must point to one skill directory");
	}
	return {
		owner: source.owner,
		repo: source.repo,
		ref: source.ref,
		path: source.path,
	};
}

function apiPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function contentsUrl(
	source: Pick<GitHubSkillSource, "owner" | "repo">,
	path: string,
	ref: string,
): string {
	const suffix = path === "." ? "" : `/${apiPath(path)}`;
	return `${GITHUB_API}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents${suffix}?ref=${encodeURIComponent(ref)}`;
}

function githubSkillUrl(
	source: Pick<GitHubSkillSource, "owner" | "repo">,
	ref: string,
	path: string,
): string {
	return path === "."
		? `https://github.com/${source.owner}/${source.repo}/blob/${ref}/SKILL.md`
		: `https://github.com/${source.owner}/${source.repo}/tree/${ref}/${path}`;
}

async function resolveCommit(source: GitHubSkillSource): Promise<string> {
	const commit = await githubJson<{ sha?: unknown }>(
		`${GITHUB_API}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/commits/${encodeURIComponent(source.ref)}`,
	);
	if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/i.test(commit.sha)) {
		throw new Error("GitHub did not return a valid commit for this skill");
	}
	return commit.sha.toLowerCase();
}

async function defaultBranch(
	source: Pick<RemoteSkillSource, "owner" | "repo">,
): Promise<string> {
	const repository = await githubJson<{ default_branch?: unknown }>(
		`${GITHUB_API}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`,
	);
	if (
		typeof repository.default_branch !== "string" ||
		!repository.default_branch.trim()
	) {
		throw new Error("GitHub did not return a default branch");
	}
	return repository.default_branch;
}

async function repositoryTree(
	source: Pick<GitHubSkillSource, "owner" | "repo">,
	resolvedSha: string,
	requireComplete = true,
): Promise<GitHubTreeItem[]> {
	const result = await githubJson<GitHubTree>(
		`${GITHUB_API}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${encodeURIComponent(resolvedSha)}?recursive=1`,
	);
	if (requireComplete && result.truncated === true) {
		throw new Error("GitHub repository is too large to discover skills safely");
	}
	if (!Array.isArray(result.tree)) {
		throw new Error("GitHub did not return a repository tree");
	}
	return result.tree as GitHubTreeItem[];
}

function skillDirectories(tree: GitHubTreeItem[], root: string | null) {
	const normalizedRoot = root === "." ? null : root;
	const prefix = normalizedRoot ? `${normalizedRoot}/` : "";
	const direct = normalizedRoot
		? `${normalizedRoot}/SKILL.md`.toLowerCase()
		: "skill.md";
	const candidates = tree.flatMap((item) => {
		if (
			typeof item.path !== "string" ||
			item.type !== "blob" ||
			(item.mode !== "100644" && item.mode !== "100755")
		) {
			return [];
		}
		const lower = item.path.toLowerCase();
		if (lower !== "skill.md" && !lower.endsWith("/skill.md")) return [];
		if (prefix && !item.path.startsWith(prefix)) return [];
		return [posix.dirname(item.path)];
	});
	if (
		root &&
		candidates.some((path) => {
			const document = path === "." ? "skill.md" : `${path}/skill.md`;
			return document.toLowerCase() === direct;
		})
	) {
		return [root];
	}
	return [...new Set(candidates)];
}

export async function discoverRemoteSkills(
	input: string,
): Promise<RemoteSkillDiscovery> {
	await prepareLibrary();
	const source = parseRemoteSkillSource(input);
	const requestedRef = source.ref ?? (await defaultBranch(source));
	const resolvedSha = await resolveCommit({
		owner: source.owner,
		repo: source.repo,
		ref: requestedRef,
		path: source.path ?? ".",
	});
	const tree = await repositoryTree(source, resolvedSha);
	let directories = skillDirectories(tree, source.path);
	if (source.skillSlug) {
		directories = directories.filter(
			(path) =>
				(path === "." ? source.repo : basename(path)).toLowerCase() ===
				source.skillSlug?.toLowerCase(),
		);
	}
	if (directories.length === 0) {
		throw new Error("No matching SKILL.md packages were found in this source");
	}
	if (directories.length > 500) {
		throw new Error("Repository contains too many skills to review safely");
	}
	const installed = new Set(
		(await managedSkillPackages()).map((skill) => skill.name.toLowerCase()),
	);
	const skills = directories
		.map((path) => {
			const name = safeLibrarySegment(
				path === "." ? source.repo : basename(path),
				"skill",
			);
			return {
				name,
				repositoryPath: path,
				sourceUrl: githubSkillUrl(source, resolvedSha, path),
				alreadyInstalled: installed.has(name.toLowerCase()),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	return {
		repository: `${source.owner}/${source.repo}`,
		requestedRef,
		resolvedSha,
		skills,
	};
}

function safeRelativeFile(root: string, file: string): string {
	const relative = posix.relative(root, file);
	if (
		!relative ||
		relative === "." ||
		relative.startsWith("../") ||
		posix.isAbsolute(relative)
	) {
		throw new Error("GitHub returned a file outside the selected skill");
	}
	return relative;
}

function isReadableFile(content: Buffer): boolean {
	return (
		content.length <= MAX_SKILL_DOCUMENT_BYTES &&
		!content.subarray(0, Math.min(content.length, 8_192)).includes(0)
	);
}

async function downloadSkillPackage(
	source: GitHubSkillSource,
	resolvedSha: string,
	destination: string,
): Promise<{ files: StagedSkillFile[]; bytes: number }> {
	const modes = new Map(
		(await repositoryTree(source, resolvedSha, false)).flatMap((item) =>
			typeof item.path === "string" && typeof item.mode === "string"
				? [[item.path, item.mode] as const]
				: [],
		),
	);
	const files: StagedSkillFile[] = [];
	const portablePaths = new Set<string>();
	let bytes = 0;
	const pending = [source.path];
	while (pending.length > 0) {
		const directory = pending.shift();
		if (!directory) continue;
		const contents = await githubJson<GitHubContentItem[] | GitHubContentItem>(
			contentsUrl(source, directory, resolvedSha),
		);
		if (!Array.isArray(contents)) {
			throw new Error("The selected GitHub path is not a skill directory");
		}
		for (const item of contents) {
			if (typeof item.path !== "string" || typeof item.type !== "string") {
				throw new Error("GitHub returned an invalid skill entry");
			}
			if (item.type === "dir") {
				pending.push(item.path);
				continue;
			}
			if (item.type !== "file") {
				throw new Error(
					"Skill packages containing links or submodules are not supported",
				);
			}
			const relative = safeRelativeFile(source.path, item.path);
			const portablePath = relative.toLowerCase();
			if (portablePaths.has(portablePath)) {
				throw new Error("Skill package contains paths that collide on Windows");
			}
			portablePaths.add(portablePath);
			if (basename(relative).toLowerCase() === ".hlid-source.json") {
				throw new Error(
					"Skill package contains reserved Hlid provenance metadata",
				);
			}
			const size = typeof item.size === "number" ? item.size : 0;
			if (
				size < 0 ||
				size > MAX_IMPORT_BYTES ||
				bytes + size > MAX_IMPORT_BYTES
			) {
				throw new Error("Skill package exceeds the import limit");
			}
			if (files.length + 1 > MAX_IMPORT_FILES) {
				throw new Error("Skill package exceeds the import limit");
			}
			const detail = await githubJson<GitHubContentItem>(
				contentsUrl(source, item.path, resolvedSha),
			);
			if (detail.encoding !== "base64" || typeof detail.content !== "string") {
				throw new Error(`Unable to download ${relative}`);
			}
			const content = Buffer.from(detail.content.replace(/\s/g, ""), "base64");
			if (
				content.length > MAX_IMPORT_BYTES ||
				bytes + content.length > MAX_IMPORT_BYTES
			) {
				throw new Error("Skill package exceeds the import limit");
			}
			const target = resolve(destination, ...relative.split("/"));
			if (!pathStartsWith(destination, target)) {
				throw new Error("Skill package path escapes its staging directory");
			}
			await mkdir(dirname(target), { recursive: true, mode: 0o700 });
			const mode = modes.get(item.path) === "100755" ? 0o700 : 0o600;
			await writeFile(target, content, { mode });
			await chmod(target, mode);
			bytes += content.length;
			files.push({
				path: relative,
				bytes: content.length,
				readable: isReadableFile(content),
			});
		}
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { files, bytes };
}

async function cleanupExpiredStages(): Promise<void> {
	const root = skillStagingDirectory();
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const cutoff = Date.now() - STAGE_TTL_MS;
	await Promise.all(
		entries.map(async (entry) => {
			if (!entry.isDirectory() || !STAGE_ID.test(entry.name)) return;
			const path = stagedSkillDirectory(entry.name);
			const info = await stat(path).catch(() => null);
			if (info && info.mtimeMs < cutoff) {
				await rm(path, { recursive: true, force: true });
			}
		}),
	);
}

function descriptionFromSkillDocument(content: string): string {
	const parsed = parseFrontmatter(content);
	if (typeof parsed.data.description === "string") {
		return parsed.data.description;
	}
	return (
		parsed.content
			.trim()
			.split("\n")
			.find((line) => line.trim())
			?.replace(/^#+\s*/, "") ?? ""
	);
}

async function writeStageMetadata(
	directory: string,
	metadata: StageMetadata,
): Promise<void> {
	await writeFile(
		resolve(directory, "stage.json"),
		`${JSON.stringify(metadata, null, 2)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

async function loadStage(id: string): Promise<{
	directory: string;
	metadata: StageMetadata;
}> {
	if (!STAGE_ID.test(id)) throw new Error("Invalid staged skill ID");
	const directory = stagedSkillDirectory(id);
	const raw = await readFile(resolve(directory, "stage.json"), "utf8").catch(
		() => null,
	);
	if (!raw) throw new Error("Staged skill not found or expired");
	const metadata = JSON.parse(raw) as StageMetadata;
	if (metadata.id !== id || !Array.isArray(metadata.files)) {
		throw new Error("Staged skill metadata is invalid");
	}
	return { directory, metadata };
}

export async function stageGitHubSkill(
	input: string,
): Promise<StagedSkillReview> {
	await prepareLibrary();
	await cleanupExpiredStages();
	const source = parseGitHubSkillUrl(input);
	const resolvedSha = await resolveCommit(source);
	const id = randomBytes(12).toString("hex");
	const temporary = resolve(skillStagingDirectory(), `.stage-${id}`);
	const directory = stagedSkillDirectory(id);
	const packageDirectory = resolve(temporary, "package");
	await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
	try {
		const { files, bytes } = await downloadSkillPackage(
			source,
			resolvedSha,
			packageDirectory,
		);
		const skillPath = resolve(packageDirectory, "SKILL.md");
		const skillInfo = await lstat(skillPath).catch(() => null);
		if (!skillInfo?.isFile()) {
			throw new Error("SKILL.md was not found in the selected skill directory");
		}
		if (skillInfo.size > MAX_SKILL_DOCUMENT_BYTES) {
			throw new Error("SKILL.md is too large to preview");
		}
		const skillDocument = await readFile(skillPath, "utf8");
		const packageName = safeLibrarySegment(
			source.path === "." ? source.repo : basename(source.path),
			"skill",
		);
		if (
			await lstat(resolve(managedSkillsDirectory(), packageName)).catch(
				() => null,
			)
		) {
			throw new Error(`Skill ${packageName} is already in Hlid`);
		}
		const parsed = parseFrontmatter(skillDocument);
		const frontmatterName =
			typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
		const review: StageMetadata = {
			id,
			name: frontmatterName || packageName,
			description: descriptionFromSkillDocument(skillDocument),
			sourceUrl: githubSkillUrl(source, resolvedSha, source.path),
			repository: `${source.owner}/${source.repo}`,
			requestedRef: source.ref,
			resolvedSha,
			repositoryPath: source.path,
			createdAt: new Date().toISOString(),
			files,
			fileCount: files.length,
			bytes,
			skillDocument,
			packageName,
		};
		await writeStageMetadata(temporary, review);
		await rename(temporary, directory);
		const { packageName: _packageName, ...result } = review;
		return result;
	} catch (error) {
		await rm(temporary, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

export async function readStagedSkillFile(
	id: string,
	path: string,
): Promise<{ path: string; content: string } | null> {
	const { directory, metadata } = await loadStage(id);
	const file = metadata.files.find(
		(candidate) => candidate.path === path && candidate.readable,
	);
	if (!file) return null;
	const target = resolve(directory, "package", ...path.split("/"));
	const packageRoot = resolve(directory, "package");
	if (!pathStartsWith(packageRoot, target)) return null;
	return { path, content: await readFile(target, "utf8") };
}

export async function discardStagedSkill(id: string): Promise<boolean> {
	if (!STAGE_ID.test(id)) return false;
	const directory = stagedSkillDirectory(id);
	const exists = await lstat(directory).catch(() => null);
	if (!exists?.isDirectory()) return false;
	await rm(directory, { recursive: true, force: false });
	return true;
}

export async function installStagedSkill(
	id: string,
): Promise<{ id: string; name: string }> {
	const { directory, metadata } = await loadStage(id);
	const packageDirectory = resolve(directory, "package");
	await validatePackageTree(packageDirectory);
	const target = resolve(managedSkillsDirectory(), metadata.packageName);
	if (!pathStartsWith(managedSkillsDirectory(), target)) {
		throw new Error("Invalid managed skill name");
	}
	const existing = await lstat(target).catch(() => null);
	if (existing)
		throw new Error(`Skill ${metadata.packageName} is already in Hlid`);
	await writeFile(
		resolve(packageDirectory, ".hlid-source.json"),
		`${JSON.stringify(
			{
				id,
				source: "github",
				sourcePath: metadata.sourceUrl,
				sourceUrl: metadata.sourceUrl,
				repository: metadata.repository,
				repositoryPath: metadata.repositoryPath,
				requestedRef: metadata.requestedRef,
				resolvedSha: metadata.resolvedSha,
				importedAt: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	await rename(packageDirectory, target);
	await rm(directory, { recursive: true, force: true });
	return { id, name: metadata.name };
}

export async function listManagedSkills(): Promise<ManagedSkillSummary[]> {
	await prepareLibrary();
	const packages = await managedSkillPackages();
	const skills = await Promise.all(
		packages.map(async (skill) => {
			const skillDocument = await readFile(
				resolve(skill.path, "SKILL.md"),
				"utf8",
			).catch(() => null);
			if (skillDocument === null) return null;
			const rawProvenance = await readFile(
				resolve(skill.path, ".hlid-source.json"),
				"utf8",
			).catch(() => "{}");
			let provenance: Record<string, unknown> = {};
			try {
				provenance = JSON.parse(rawProvenance) as Record<string, unknown>;
			} catch {
				// A malformed provenance file is still removable through its managed ID.
			}
			const summary = await validatePackageTree(skill.path).catch(() => null);
			if (!summary) return null;
			const source =
				typeof provenance.source === "string"
					? provenance.source === "github"
						? "GitHub"
						: provenance.source
					: "Hlid";
			return {
				id: skill.id,
				name: skill.name,
				description: descriptionFromSkillDocument(skillDocument),
				source,
				sourceUrl:
					typeof provenance.sourceUrl === "string"
						? provenance.sourceUrl
						: null,
				resolvedSha:
					typeof provenance.resolvedSha === "string"
						? provenance.resolvedSha
						: null,
				importedAt:
					typeof provenance.importedAt === "string"
						? provenance.importedAt
						: null,
				fileCount: summary.fileCount,
				bytes: summary.bytes,
			} satisfies ManagedSkillSummary;
		}),
	);
	return skills
		.filter((skill): skill is ManagedSkillSummary => skill !== null)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readManagedSkillDocument(
	id: string,
): Promise<{ id: string; name: string; content: string } | null> {
	const skill = (await managedSkillPackages()).find((item) => item.id === id);
	if (!skill) return null;
	const path = resolve(skill.path, "SKILL.md");
	const info = await lstat(path).catch(() => null);
	if (!info?.isFile() || info.size > MAX_SKILL_DOCUMENT_BYTES) return null;
	return { id, name: skill.name, content: await readFile(path, "utf8") };
}
