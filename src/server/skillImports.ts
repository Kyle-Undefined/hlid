import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	cp,
	lstat,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { HlidConfig } from "../config";
import { parseFrontmatter } from "../lib/frontmatter";
import {
	expandTilde,
	parseWslUncSyntax,
	pathStartsWith,
	samePath,
} from "../lib/paths";
import type { AgentProvider } from "./agentProvider";
import {
	managedSkillsDirectory,
	prepareLibrary,
	safeLibrarySegment,
} from "./libraryStore";

export type SkillImportSource = "claude" | "codex" | "acp" | "agent";

const MAX_IMPORT_FILES = 2_000;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_SKILL_DOCUMENT_BYTES = 1024 * 1024;
const MAX_DISCOVERY_DEPTH = 8;

export type DiscoveredSkillPackage = {
	id: string;
	name: string;
	description: string;
	source: SkillImportSource;
	providerId: string;
	providerLabel: string;
	environment: "windows" | "wsl" | "host";
	environmentLabel: string;
	scope: string;
	enabled: boolean | null;
	alreadyImported: boolean;
	managedId: string | null;
	fileCount: number;
	bytes: number;
};

type SkillRoot = {
	path: string;
	source: SkillImportSource;
	providerId: string;
	providerLabel: string;
	environment: DiscoveredSkillPackage["environment"];
	environmentLabel: string;
	scope: string;
	enabled?: boolean;
	discover: boolean;
};

type InternalDiscoveredSkill = DiscoveredSkillPackage & { sourcePath: string };

async function validatePackageTree(
	root: string,
): Promise<{ fileCount: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			const info = await lstat(path);
			if (info.isSymbolicLink()) {
				throw new Error(
					"Skill packages containing symbolic links cannot be imported",
				);
			}
			if (info.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!info.isFile())
				throw new Error("Skill package contains an unsupported file");
			files++;
			bytes += info.size;
			if (files > MAX_IMPORT_FILES || bytes > MAX_IMPORT_BYTES) {
				throw new Error("Skill package exceeds the import limit");
			}
		}
	};
	await visit(root);
	return { fileCount: files, bytes };
}

function addRoot(roots: SkillRoot[], root: SkillRoot): void {
	if (
		roots.some(
			(existing) =>
				existing.path === root.path &&
				existing.source === root.source &&
				existing.providerId === root.providerId,
		)
	)
		return;
	roots.push(root);
}

function runtimeForPath(
	path: string,
): Pick<SkillRoot, "environment" | "environmentLabel"> {
	const wsl = parseWslUncSyntax(path);
	if (wsl) {
		return {
			environment: "wsl",
			environmentLabel: `WSL · ${wsl.distro}`,
		};
	}
	if (process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(path)) {
		return { environment: "windows", environmentLabel: "Windows" };
	}
	return { environment: "host", environmentLabel: "Host" };
}

function installedClaudePluginRoots(home: string): SkillRoot[] {
	const pluginHome = resolve(home, ".claude", "plugins");
	try {
		const registry = JSON.parse(
			readFileSync(resolve(pluginHome, "installed_plugins.json"), "utf8"),
		) as {
			plugins?: Record<string, Array<{ installPath?: unknown }>>;
		};
		const roots: SkillRoot[] = [];
		for (const installs of Object.values(registry.plugins ?? {})) {
			for (const install of installs) {
				if (typeof install.installPath !== "string") continue;
				const translated = hostPathFromProvider(home, install.installPath);
				const path = resolve(translated);
				if (!pathStartsWith(pluginHome, path)) continue;
				roots.push({
					path,
					source: "claude",
					providerId: "claude",
					providerLabel: "Claude",
					...runtimeForPath(path),
					scope: "plugin",
					enabled: true,
					discover: true,
				});
			}
		}
		return roots;
	} catch {
		return [];
	}
}

function installedCodexPluginRoots(home: string): SkillRoot[] {
	const pluginCache = resolve(home, ".codex", "plugins", "cache");
	try {
		const config = parseToml(
			readFileSync(resolve(home, ".codex", "config.toml"), "utf8"),
		) as { plugins?: Record<string, { enabled?: unknown }> };
		const roots: SkillRoot[] = [];
		for (const [id, plugin] of Object.entries(config.plugins ?? {})) {
			if (plugin?.enabled !== true) continue;
			const separator = id.lastIndexOf("@");
			if (separator <= 0 || separator === id.length - 1) continue;
			const name = id.slice(0, separator);
			const marketplace = id.slice(separator + 1);
			const path = resolve(pluginCache, marketplace, name);
			if (!pathStartsWith(pluginCache, path)) continue;
			roots.push({
				path,
				source: "codex",
				providerId: "codex",
				providerLabel: "Codex",
				...runtimeForPath(path),
				scope: "plugin",
				enabled: true,
				discover: true,
			});
		}
		return roots;
	} catch {
		return [];
	}
}

function configuredRoots(config: HlidConfig): SkillRoot[] {
	const roots: SkillRoot[] = [];
	const addProviderHome = (home: string) => {
		const runtime = runtimeForPath(home);
		addRoot(roots, {
			path: resolve(home, ".claude", "skills"),
			source: "claude",
			providerId: "claude",
			providerLabel: "Claude",
			...runtime,
			scope: "user",
			discover: true,
		});
		addRoot(roots, {
			path: resolve(home, ".codex", "skills"),
			source: "codex",
			providerId: "codex",
			providerLabel: "Codex",
			...runtime,
			scope: "user",
			discover: true,
		});
		addRoot(roots, {
			path: resolve(home, ".agents", "skills"),
			source: "codex",
			providerId: "codex",
			providerLabel: "Codex",
			...runtime,
			scope: "user",
			discover: true,
		});
		for (const root of installedClaudePluginRoots(home)) addRoot(roots, root);
		for (const root of installedCodexPluginRoots(home)) addRoot(roots, root);
	};
	addProviderHome(process.env.HLID_TEST_SKILLS_HOME ?? expandTilde("~"));

	const workspaceRoots = [
		...(config.vault.path
			? [{ path: config.vault.path, provider: config.vault_provider }]
			: []),
		...(config.agents ?? []).map((agent) => ({
			path: agent.path,
			provider: agent.provider,
		})),
	];
	for (const workspace of workspaceRoots) {
		const root = resolve(expandTilde(workspace.path));
		const runtime = runtimeForPath(workspace.path);
		const scope = "workspace";
		for (const item of [
			{ folder: ".claude", source: "claude" as const, label: "Claude" },
			{ folder: ".codex", source: "codex" as const, label: "Codex" },
		]) {
			addRoot(roots, {
				path: resolve(root, item.folder, "skills"),
				source: item.source,
				providerId: item.source,
				providerLabel: item.label,
				...runtime,
				scope,
				discover: true,
			});
		}
		for (const folder of [".agents", ".agent"]) {
			const providerId = workspace.provider?.startsWith("acp:")
				? workspace.provider
				: "acp";
			addRoot(roots, {
				path: resolve(root, folder, "skills"),
				source: "acp",
				providerId,
				providerLabel:
					providerId === "acp" ? "ACP" : providerId.slice("acp:".length),
				...runtime,
				scope,
				discover: true,
			});
		}

		const wsl = parseWslUncSyntax(workspace.path);
		const share = workspace.path.match(
			/^(\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+)/i,
		)?.[1];
		const home = wsl?.posixPath.match(/^\/(home\/[^/]+|root)(?:\/|$)/)?.[1];
		if (share && home) {
			addProviderHome(`${share}\\${home.replace(/\//g, "\\")}`);
		}
	}
	return roots;
}

function hostPathFromProvider(cwd: string, path: string): string {
	const wsl = parseWslUncSyntax(cwd);
	const share = cwd.match(/^(\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+)/i)?.[1];
	if (!wsl || !share || !path.startsWith("/")) return path;
	return `${share}\\${path.slice(1).replace(/\//g, "\\")}`;
}

function discoveryId(source: SkillImportSource, packagePath: string): string {
	return createHash("sha256")
		.update(`${source}\0${packagePath}`)
		.digest("hex")
		.slice(0, 24);
}

function managedSkillId(packagePath: string): string {
	return createHash("sha256")
		.update(`hlid\0${packagePath}`)
		.digest("hex")
		.slice(0, 24);
}

async function managedSkillPackages(): Promise<
	Array<{ id: string; name: string; path: string; sourcePath: string }>
> {
	const root = managedSkillsDirectory();
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const packages = await Promise.all(
		entries.map(async (entry) => {
			if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
			const path = await realpath(resolve(root, entry.name)).catch(() => null);
			if (!path || !pathStartsWith(root, path) || path === root) return null;
			const rawProvenance = await readFile(
				resolve(path, ".hlid-source.json"),
				"utf8",
			).catch(() => null);
			if (rawProvenance === null) return null;
			let sourcePath: unknown;
			try {
				sourcePath = (JSON.parse(rawProvenance) as { sourcePath?: unknown })
					.sourcePath;
			} catch {
				return null;
			}
			if (typeof sourcePath !== "string") return null;
			return { id: managedSkillId(path), name: entry.name, path, sourcePath };
		}),
	);
	return packages.filter(
		(
			candidate,
		): candidate is {
			id: string;
			name: string;
			path: string;
			sourcePath: string;
		} => candidate !== null,
	);
}

async function findSkillFiles(directory: string, depth = 0): Promise<string[]> {
	if (depth > MAX_DISCOVERY_DEPTH) return [];
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		() => [],
	);
	return (
		await Promise.all(
			entries.map(async (entry) => {
				const path = resolve(directory, entry.name);
				const info = await lstat(path).catch(() => null);
				if (!info || info.isSymbolicLink()) return [];
				if (info.isFile() && entry.name.toLowerCase() === "skill.md") {
					return [path];
				}
				return info.isDirectory() ? findSkillFiles(path, depth + 1) : [];
			}),
		)
	).flat();
}

async function discoverSkillPackagesInternal(
	config: HlidConfig,
	providers: ReadonlyMap<string, AgentProvider> = new Map(),
): Promise<InternalDiscoveredSkill[]> {
	const roots = configuredRoots(config);
	// Catalog requests must not start provider processes. Installed CLI registries
	// and configured skill roots are authoritative and remain responsive even
	// while Claude, Codex, or a WSL runtime is busy.
	const discoveredFiles = (
		await Promise.all(
			roots
				.filter((item) => item.discover)
				.map(async (root) =>
					(await findSkillFiles(root.path)).map((file) => ({ file, root })),
				),
		)
	).flat() as Array<{
		file: string;
		root: SkillRoot;
	}>;

	const managedByName = new Map(
		(await managedSkillPackages()).map((skill) => [
			skill.name.toLowerCase(),
			skill,
		]),
	);
	const seen = new Set<string>();
	const result: InternalDiscoveredSkill[] = [];
	for (const item of discoveredFiles) {
		const packageReal = await realpath(dirname(item.file)).catch(() => null);
		if (!packageReal) continue;
		const key = `${item.root.source}\0${packageReal}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const raw = await readFile(resolve(packageReal, "SKILL.md"), "utf8").catch(
			() => null,
		);
		if (raw === null) continue;
		const parsed = parseFrontmatter(raw);
		const fallbackName = basename(packageReal);
		const frontmatterName =
			typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
		const name = frontmatterName || fallbackName;
		const firstLine =
			parsed.content
				.trim()
				.split("\n")
				.find((line) => line.trim()) ?? "";
		const description =
			typeof parsed.data.description === "string"
				? parsed.data.description
				: firstLine.replace(/^#+\s*/, "");
		let summary: { fileCount: number; bytes: number };
		try {
			summary = await validatePackageTree(packageReal);
		} catch {
			continue;
		}
		const packageName = safeLibrarySegment(fallbackName, "skill");
		const managed = managedByName.get(packageName.toLowerCase());
		const importedFromThisSource = Boolean(
			managed && samePath(managed.sourcePath, packageReal),
		);
		result.push({
			id: discoveryId(item.root.source, packageReal),
			name,
			description,
			source: item.root.source,
			providerId: item.root.providerId,
			providerLabel:
				providers.get(item.root.providerId)?.label ?? item.root.providerLabel,
			environment: item.root.environment,
			environmentLabel: item.root.environmentLabel,
			scope: item.root.scope,
			enabled: item.root.enabled ?? null,
			alreadyImported: Boolean(managed),
			managedId: importedFromThisSource ? (managed?.id ?? null) : null,
			fileCount: summary.fileCount,
			bytes: summary.bytes,
			sourcePath: packageReal,
		});
	}
	result.sort(
		(a, b) =>
			a.providerLabel.localeCompare(b.providerLabel) ||
			a.name.localeCompare(b.name),
	);
	return result;
}

export async function removeManagedSkill(
	id: string,
): Promise<{ id: string; name: string } | null> {
	const skill = (await managedSkillPackages()).find(
		(candidate) => candidate.id === id,
	);
	if (!skill) return null;
	await rm(skill.path, { recursive: true, force: false });
	return { id: skill.id, name: skill.name };
}

export async function discoverSkillPackages(
	config: HlidConfig,
	providers: ReadonlyMap<string, AgentProvider> = new Map(),
): Promise<DiscoveredSkillPackage[]> {
	return (await discoverSkillPackagesInternal(config, providers)).map(
		({ sourcePath: _sourcePath, ...skill }) => skill,
	);
}

export async function readDiscoveredSkillDocument(opts: {
	id: string;
	config: HlidConfig;
	providers?: ReadonlyMap<string, AgentProvider>;
}): Promise<{ id: string; name: string; content: string } | null> {
	const catalog = await discoverSkillPackagesInternal(
		opts.config,
		opts.providers,
	);
	const skill = catalog.find((candidate) => candidate.id === opts.id);
	if (!skill) return null;
	const file = resolve(skill.sourcePath, "SKILL.md");
	const info = await lstat(file).catch(() => null);
	if (!info?.isFile()) return null;
	if (info.size > MAX_SKILL_DOCUMENT_BYTES) {
		throw new Error("SKILL.md is too large to preview");
	}
	return {
		id: skill.id,
		name: skill.name,
		content: await readFile(file, "utf8"),
	};
}

export async function importDiscoveredSkillPackages(opts: {
	ids: string[];
	config: HlidConfig;
	providers?: ReadonlyMap<string, AgentProvider>;
}): Promise<{
	imported: Array<{ id: string; name: string; source: SkillImportSource }>;
	failed: Array<{ id: string; name: string; message: string }>;
}> {
	const requested = new Set(opts.ids);
	const catalog = await discoverSkillPackagesInternal(
		opts.config,
		opts.providers,
	);
	const byId = new Map(catalog.map((skill) => [skill.id, skill]));
	const imported: Array<{
		id: string;
		name: string;
		source: SkillImportSource;
	}> = [];
	const failed: Array<{ id: string; name: string; message: string }> = [];
	for (const id of requested) {
		const candidate = byId.get(id);
		if (!candidate) {
			failed.push({
				id,
				name: "Unknown skill",
				message: "Skill is no longer available",
			});
			continue;
		}
		try {
			const skill = await importSkillPackage({
				sourcePath: candidate.sourcePath,
				source: candidate.source,
				config: opts.config,
			});
			imported.push({ id, name: skill.name, source: skill.source });
		} catch (error) {
			failed.push({
				id,
				name: candidate.name,
				message: error instanceof Error ? error.message : "Import failed",
			});
		}
	}
	return { imported, failed };
}

async function authorizedPackage(
	sourcePath: string,
	source: SkillImportSource,
	config: HlidConfig,
): Promise<string> {
	const requested = await realpath(resolve(expandTilde(sourcePath)));
	const packageDir =
		basename(requested).toLowerCase() === "skill.md"
			? dirname(requested)
			: requested;
	const packageReal = await realpath(packageDir);
	const roots = await Promise.all(
		configuredRoots(config)
			.filter((root) => root.source === source)
			.map(async (root) => ({
				...root,
				path: await realpath(root.path).catch(() => null),
			})),
	);
	if (
		!roots.some((root) => root.path && pathStartsWith(root.path, packageReal))
	) {
		throw new Error(
			"Skill source is not in a configured provider or agent root",
		);
	}
	await readFile(resolve(packageReal, "SKILL.md"), "utf8");
	return packageReal;
}

export async function importSkillPackage(opts: {
	sourcePath: string;
	source: SkillImportSource;
	config: HlidConfig;
}): Promise<{ name: string; path: string; source: SkillImportSource }> {
	const packageDir = await authorizedPackage(
		opts.sourcePath,
		opts.source,
		opts.config,
	);
	await validatePackageTree(packageDir);
	await prepareLibrary();
	const name = safeLibrarySegment(basename(packageDir), "skill");
	const target = resolve(managedSkillsDirectory(), name);
	if (!pathStartsWith(managedSkillsDirectory(), target)) {
		throw new Error("Invalid skill package name");
	}
	try {
		await lstat(target);
		throw Object.assign(new Error(`Skill ${name} is already managed by Hlid`), {
			code: "EEXIST",
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const importId = randomUUID();
	const temporary = resolve(
		managedSkillsDirectory(),
		`.import-${name}-${importId}`,
	);
	try {
		await cp(packageDir, temporary, {
			recursive: true,
			errorOnExist: true,
			force: false,
			filter: (source) => basename(source) !== ".hlid-source.json",
		});
		await writeFile(
			resolve(temporary, ".hlid-source.json"),
			`${JSON.stringify(
				{
					id: importId,
					source: opts.source,
					sourcePath: packageDir,
					importedAt: new Date().toISOString(),
				},
				null,
				2,
			)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
	return { name, path: target, source: opts.source };
}
