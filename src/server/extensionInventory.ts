import { createHash } from "node:crypto";
import {
	lstat,
	open,
	readdir,
	readFile,
	realpath,
	stat,
} from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { HlidConfig } from "../config";
import { resolveCodexExecutable } from "../lib/codexPath";
import { expandTilde, parseWslUncSyntax, pathStartsWith } from "../lib/paths";
import { runBoundedProcess } from "../lib/process";
import { writeWrapper } from "./wrappers";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_COMPONENT_FILES = 500;
const MAX_COMPONENT_DEPTH = 5;
const MAX_SKILL_FILES = 20;
const MAX_SKILL_FILE_BYTES = 128 * 1024;
const MAX_SKILL_TOTAL_BYTES = 512 * 1024;
const MARKETPLACE_LIST_TIMEOUT_MS = 10_000;
const MAX_MARKETPLACE_LIST_OUTPUT_CHARS = 256 * 1024;

export type ExtensionProviderId = "claude" | "codex";
export type ExtensionEnvironment = "windows" | "wsl" | "host";

export type ProviderExtensionHome = {
	path: string;
	environment: ExtensionEnvironment;
	environmentLabel: string;
};

export type ProviderExtensionEnvironment = {
	id: string;
	providerId: ExtensionProviderId;
	environment: ExtensionEnvironment;
	environmentLabel: string;
};

export type ExtensionComponent = {
	kind:
		| "skills"
		| "agents"
		| "commands"
		| "hooks"
		| "lsp"
		| "mcp"
		| "apps"
		| "scripts";
	label: string;
	count: number;
	names: string[];
};

export type ExtensionSkillFile = {
	path: string;
	content: string;
	truncated: boolean;
};

export type ProviderExtension = {
	id: string;
	providerId: ExtensionProviderId;
	providerLabel: string;
	environment: ExtensionEnvironment;
	environmentLabel: string;
	pluginId: string;
	name: string;
	displayName: string;
	marketplace: string;
	version: string;
	description: string;
	author: string;
	homepage: string;
	repository: string;
	license: string;
	scope: string;
	enabled: boolean;
	installPath: string;
	source: string;
	installedAt: string;
	lastUpdated: string;
	capabilities: string[];
	components: ExtensionComponent[];
	skillFiles: ExtensionSkillFile[];
	manifestPath: string;
	manifestText: string;
	errors: string[];
};

export type ProviderMarketplace = {
	id: string;
	providerId: ExtensionProviderId;
	environment: ExtensionEnvironment;
	environmentLabel: string;
	name: string;
	source: string;
	path: string;
	pluginCount: number | null;
	lastUpdated: string;
	canManage: boolean;
};

export type AvailableExtension = {
	id: string;
	providerId: ExtensionProviderId;
	providerLabel: string;
	environment: ExtensionEnvironment;
	environmentLabel: string;
	pluginId: string;
	name: string;
	displayName: string;
	marketplace: string;
	version: string;
	description: string;
	author: string;
	category: string;
	source: string;
	homepage: string;
	installed: boolean;
	enabled: boolean | null;
	reviewLevel: "package" | "marketplace";
};

export type ExtensionReview = AvailableExtension & {
	reviewMessage: string;
	reviewToken: string;
	manifestPath: string;
	manifestText: string;
	capabilities: string[];
	components: ExtensionComponent[];
	skillFiles: ExtensionSkillFile[];
	errors: string[];
};

export type ExtensionInventoryError = {
	providerId: ExtensionProviderId;
	environment: ExtensionEnvironment;
	environmentLabel: string;
	message: string;
};

export type ExtensionInventory = {
	generatedAt: string;
	environments: ProviderExtensionEnvironment[];
	extensions: ProviderExtension[];
	marketplaces: ProviderMarketplace[];
	available: AvailableExtension[];
	errors: ExtensionInventoryError[];
};

export type CodexMarketplaceRoot = {
	name: string;
	root: string;
	source: string;
};

export type ExtensionInventoryDependencies = {
	listCodexMarketplaces?: (
		config: HlidConfig,
		home: ProviderExtensionHome,
	) => Promise<CodexMarketplaceRoot[]>;
};

type JsonRecord = Record<string, unknown>;

type ExtensionReviewTarget = {
	available: AvailableExtension;
	root: string;
	boundary: string;
	manifestRelativePath: string;
	marketplaceEntry: JsonRecord;
	marketplaceEntryPath: string;
};

type ProviderInspection = {
	extensions: ProviderExtension[];
	marketplaces: ProviderMarketplace[];
	available: AvailableExtension[];
	reviewTargets: ExtensionReviewTarget[];
	errors: ExtensionInventoryError[];
};

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function recordValue(value: unknown): JsonRecord {
	return isRecord(value) ? value : {};
}

function extensionId(
	providerId: ExtensionProviderId,
	home: ProviderExtensionHome,
	pluginId: string,
	installPath: string,
): string {
	return createHash("sha256")
		.update(`${providerId}\0${home.path}\0${pluginId}\0${installPath}`)
		.digest("hex")
		.slice(0, 24);
}

function marketplaceId(
	providerId: ExtensionProviderId,
	home: ProviderExtensionHome,
	name: string,
): string {
	return createHash("sha256")
		.update(`${providerId}\0${home.path}\0${name}`)
		.digest("hex")
		.slice(0, 24);
}

export function extensionEnvironmentId(
	providerId: ExtensionProviderId,
	home: ProviderExtensionHome,
): string {
	return createHash("sha256")
		.update(`${providerId}\0${home.path}\0environment`)
		.digest("hex")
		.slice(0, 24);
}

function availableExtensionId(
	providerId: ExtensionProviderId,
	home: ProviderExtensionHome,
	marketplace: string,
	name: string,
): string {
	return createHash("sha256")
		.update(`${providerId}\0${home.path}\0${marketplace}\0${name}\0available`)
		.digest("hex")
		.slice(0, 24);
}

function runtimeForPath(
	path: string,
): Pick<ProviderExtensionHome, "environment" | "environmentLabel"> {
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
	if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
		return {
			environment: "wsl",
			environmentLabel: `WSL · ${process.env.WSL_DISTRO_NAME}`,
		};
	}
	return { environment: "host", environmentLabel: "Host" };
}

function addHome(
	homes: ProviderExtensionHome[],
	path: string,
	runtime = runtimeForPath(path),
): void {
	if (homes.some((home) => home.path === path)) return;
	homes.push({ path, ...runtime });
}

export function providerExtensionHomes(
	config: HlidConfig,
): ProviderExtensionHome[] {
	const homes: ProviderExtensionHome[] = [];
	if (process.env.HLID_TEST_EXTENSIONS_HOME) {
		addHome(homes, process.env.HLID_TEST_EXTENSIONS_HOME, {
			environment: "host",
			environmentLabel: "Host",
		});
	} else {
		addHome(homes, expandTilde("~"));
	}

	const workspaces = [
		...(config.vault.path ? [config.vault.path] : []),
		...(config.agents ?? []).map((agent) => agent.path),
	];
	for (const workspace of workspaces) {
		const parsed = parseWslUncSyntax(workspace);
		const share = workspace.match(
			/^(\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+)/i,
		)?.[1];
		const home = parsed?.posixPath.match(/^\/(home\/[^/]+|root)(?:\/|$)/)?.[1];
		if (!parsed || !share || !home) continue;
		addHome(homes, `${share}\\${home.replaceAll("/", "\\")}`, {
			environment: "wsl",
			environmentLabel: `WSL · ${parsed.distro}`,
		});
	}
	return homes;
}

function hostPathFromProvider(home: string, path: string): string {
	const wsl = parseWslUncSyntax(home);
	const share = home.match(/^(\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+)/i)?.[1];
	if (!wsl || !share || !path.startsWith("/")) return path;
	return `${share}\\${path.slice(1).replaceAll("/", "\\")}`;
}

function isAbsoluteProviderPath(path: string): boolean {
	return (
		path.startsWith("/") ||
		/^[A-Za-z]:[\\/]/.test(path) ||
		path.startsWith("\\\\")
	);
}

export function parseCodexMarketplaceList(
	output: string,
): CodexMarketplaceRoot[] {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error("Codex marketplace output did not contain JSON");
	}
	const parsed = recordValue(
		JSON.parse(output.slice(start, end + 1)) as unknown,
	);
	const marketplaces = Array.isArray(parsed.marketplaces)
		? parsed.marketplaces
		: [];
	const result: CodexMarketplaceRoot[] = [];
	for (const rawMarketplace of marketplaces) {
		const marketplace = recordValue(rawMarketplace);
		const name = stringValue(marketplace.name).trim();
		const root = stringValue(marketplace.root).trim();
		if (
			!name ||
			/[\r\n\0]/.test(name) ||
			!root ||
			/[\r\n\0]/.test(root) ||
			!isAbsoluteProviderPath(root)
		) {
			continue;
		}
		const rawSource = recordValue(marketplace.marketplaceSource);
		const sourceType = stringValue(rawSource.sourceType);
		const sourceValue = stringValue(rawSource.source);
		result.push({
			name,
			root,
			source: [sourceType, sourceValue].filter(Boolean).join(" · "),
		});
	}
	return result;
}

async function listCodexMarketplaceRoots(
	config: HlidConfig,
	home: ProviderExtensionHome,
): Promise<CodexMarketplaceRoot[]> {
	const wsl = parseWslUncSyntax(home.path);
	let executable: string | undefined;
	let shell = false;
	if (wsl) {
		executable = writeWrapper(home.path, "codex") ?? undefined;
		shell = true;
	} else {
		// Explicit homes outside the current runtime home are used by inventory
		// tests and cannot be queried accurately through this process's Codex CLI.
		if (resolve(home.path) !== resolve(expandTilde("~"))) return [];
		executable = config.codex.executable || resolveCodexExecutable();
		shell =
			process.platform === "win32" &&
			Boolean(executable?.toLowerCase().endsWith(".cmd"));
	}
	if (!executable) {
		throw new Error("Codex CLI was not found for this environment");
	}
	const result = await runBoundedProcess(
		executable,
		["plugin", "marketplace", "list", "--json"],
		{
			timeoutMs: MARKETPLACE_LIST_TIMEOUT_MS,
			timeoutError: "Codex marketplace lookup timed out",
			maxOutputChars: MAX_MARKETPLACE_LIST_OUTPUT_CHARS,
			shell,
			cwd: wsl ? undefined : home.path,
		},
	);
	if (result.code !== 0) {
		const detail = result.output.trim().split(/\r?\n/).slice(-6).join(" ");
		throw new Error(
			detail
				? `Codex marketplace lookup exited ${result.code}: ${detail}`
				: `Codex marketplace lookup exited ${result.code}`,
		);
	}
	return parseCodexMarketplaceList(result.output).map((marketplace) => ({
		...marketplace,
		root: hostPathFromProvider(home.path, marketplace.root),
	}));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
	return (
		isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function inventoryError(
	providerId: ExtensionProviderId,
	home: ProviderExtensionHome,
	message: string,
): ExtensionInventoryError {
	return {
		providerId,
		environment: home.environment,
		environmentLabel: home.environmentLabel,
		message,
	};
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readOptionalJson(path: string): Promise<unknown | null> {
	try {
		return await readJson(path);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

async function safeManifest(
	root: string,
	relativePath: string,
	boundary: string,
): Promise<{
	path: string;
	raw: string;
	value: JsonRecord;
	error: string | null;
}> {
	const path = resolve(root, relativePath);
	try {
		const [realBoundary, realPath] = await Promise.all([
			realpath(boundary),
			realpath(path),
		]);
		if (!pathStartsWith(realBoundary, realPath)) {
			return {
				path,
				raw: "",
				value: {},
				error: "Manifest resolves outside the provider plugin cache",
			};
		}
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) {
			return {
				path,
				raw: "",
				value: {},
				error: "Manifest is not a regular file",
			};
		}
		if (info.size > MAX_MANIFEST_BYTES) {
			return {
				path,
				raw: "",
				value: {},
				error: "Manifest exceeds the 256 KB review limit",
			};
		}
		const raw = await readFile(path, "utf8");
		try {
			const value = JSON.parse(raw) as unknown;
			return {
				path,
				raw: JSON.stringify(value, null, 2),
				value: recordValue(value),
				error: isRecord(value) ? null : "Manifest root is not an object",
			};
		} catch (error) {
			return {
				path,
				raw,
				value: {},
				error: `Manifest JSON is invalid: ${errorMessage(error)}`,
			};
		}
	} catch (error) {
		return {
			path,
			raw: "",
			value: {},
			error: isMissing(error)
				? "Plugin manifest is missing"
				: `Manifest could not be read: ${errorMessage(error)}`,
		};
	}
}

async function rootWithinBoundary(
	root: string,
	boundary: string,
): Promise<boolean> {
	try {
		const [realRoot, realBoundary] = await Promise.all([
			realpath(root),
			realpath(boundary),
		]);
		return pathStartsWith(realBoundary, realRoot);
	} catch {
		return false;
	}
}

async function countFiles(
	root: string,
	predicate: (name: string) => boolean,
	depth = 0,
): Promise<{ count: number; names: string[] }> {
	if (depth > MAX_COMPONENT_DEPTH) return { count: 0, names: [] };
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	let count = 0;
	const names: string[] = [];
	for (const entry of entries) {
		if (count >= MAX_COMPONENT_FILES) break;
		const path = resolve(root, entry.name);
		const info = await lstat(path).catch(() => null);
		if (!info || info.isSymbolicLink()) continue;
		if (info.isDirectory()) {
			const nested = await countFiles(path, predicate, depth + 1);
			count += nested.count;
			for (const name of nested.names) {
				if (names.length < 8 && !names.includes(name)) names.push(name);
			}
			continue;
		}
		if (!info.isFile() || !predicate(entry.name)) continue;
		count++;
		if (names.length < 8) names.push(basename(dirname(path)));
	}
	return { count, names };
}

async function inspectSkillFiles(
	root: string,
	boundary: string,
): Promise<ExtensionSkillFile[]> {
	const skillRoot = resolve(root, "skills");
	const files: ExtensionSkillFile[] = [];
	let totalBytes = 0;
	let realBoundary: string;
	try {
		realBoundary = await realpath(boundary);
	} catch {
		return files;
	}

	const visit = async (directory: string, depth: number): Promise<void> => {
		if (
			depth > MAX_COMPONENT_DEPTH ||
			files.length >= MAX_SKILL_FILES ||
			totalBytes >= MAX_SKILL_TOTAL_BYTES
		) {
			return;
		}
		const entries = await readdir(directory, { withFileTypes: true }).catch(
			() => [],
		);
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (
				files.length >= MAX_SKILL_FILES ||
				totalBytes >= MAX_SKILL_TOTAL_BYTES
			) {
				break;
			}
			const path = resolve(directory, entry.name);
			const info = await lstat(path).catch(() => null);
			if (!info || info.isSymbolicLink()) continue;
			if (info.isDirectory()) {
				await visit(path, depth + 1);
				continue;
			}
			if (!info.isFile() || !/^skill\.md$/i.test(entry.name)) continue;
			const realFile = await realpath(path).catch(() => "");
			if (!realFile || !pathStartsWith(realBoundary, realFile)) continue;

			const byteLimit = Math.min(
				MAX_SKILL_FILE_BYTES,
				MAX_SKILL_TOTAL_BYTES - totalBytes,
			);
			const handle = await open(path, "r").catch(() => null);
			if (!handle) continue;
			try {
				const buffer = Buffer.alloc(byteLimit);
				const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0);
				totalBytes += bytesRead;
				files.push({
					path: relative(root, path).replaceAll("\\", "/"),
					content: buffer.subarray(0, bytesRead).toString("utf8"),
					truncated: info.size > bytesRead,
				});
			} finally {
				await handle.close();
			}
		}
	};

	await visit(skillRoot, 0);
	return files;
}

async function namedJsonEntries(path: string, key?: string): Promise<string[]> {
	try {
		const value = await readJson(path);
		const target = key ? recordValue(value)[key] : value;
		return Object.keys(recordValue(target)).slice(0, 50);
	} catch {
		return [];
	}
}

function manifestPathValue(manifest: JsonRecord, key: string): string {
	const value = manifest[key];
	return typeof value === "string" ? value : "";
}

async function inspectComponents(
	root: string,
	manifest: JsonRecord,
): Promise<ExtensionComponent[]> {
	const components: ExtensionComponent[] = [];
	const add = (
		kind: ExtensionComponent["kind"],
		label: string,
		count: number,
		names: string[] = [],
	) => {
		if (count > 0) components.push({ kind, label, count, names });
	};

	const skills = await countFiles(resolve(root, "skills"), (name) =>
		/^skill\.md$/i.test(name),
	);
	add("skills", "Skills", skills.count, skills.names);

	const agents = await countFiles(resolve(root, "agents"), (name) =>
		/\.md$/i.test(name),
	);
	add("agents", "Agents", agents.count, agents.names);

	const commands = await countFiles(resolve(root, "commands"), (name) =>
		/\.md$/i.test(name),
	);
	add("commands", "Commands", commands.count, commands.names);

	const hookFiles = [
		resolve(root, "hooks", "hooks.json"),
		resolve(root, "hooks.json"),
	];
	let hookNames: string[] = [];
	for (const hookFile of hookFiles) {
		hookNames = await namedJsonEntries(hookFile, "hooks");
		if (hookNames.length > 0) break;
	}
	if (hookNames.length === 0 && manifest.hooks !== undefined) {
		hookNames = Object.keys(recordValue(manifest.hooks));
		if (hookNames.length === 0) hookNames = ["configured"];
	}
	add("hooks", "Hooks", hookNames.length, hookNames);

	const lspNames = Object.keys(recordValue(manifest.lspServers)).slice(0, 50);
	add("lsp", "Language servers", lspNames.length, lspNames);

	const mcpPath =
		manifestPathValue(manifest, "mcpServers") ||
		manifestPathValue(manifest, "mcp_servers") ||
		".mcp.json";
	const mcpNames = await namedJsonEntries(resolve(root, mcpPath), "mcpServers");
	add("mcp", "MCP servers", mcpNames.length, mcpNames);

	const appsPath = manifestPathValue(manifest, "apps") || ".app.json";
	const appNames = await namedJsonEntries(resolve(root, appsPath), "apps");
	const hasAppManifest = await stat(resolve(root, appsPath))
		.then((info) => info.isFile())
		.catch(() => false);
	add("apps", "Apps", appNames.length || (hasAppManifest ? 1 : 0), appNames);

	const scripts = await countFiles(resolve(root, "scripts"), () => true);
	add("scripts", "Scripts", scripts.count, scripts.names);
	return components;
}

function authorName(manifest: JsonRecord): string {
	const author = manifest.author;
	if (typeof author === "string") return author;
	return stringValue(recordValue(author).name);
}

function displayName(manifest: JsonRecord, fallback: string): string {
	const ui = recordValue(manifest.interface);
	return (
		stringValue(ui.displayName) ||
		stringValue(ui.display_name) ||
		stringValue(manifest.name) ||
		fallback
	);
}

function manifestCapabilities(manifest: JsonRecord): string[] {
	const value = recordValue(manifest.interface).capabilities;
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string")
				.slice(0, 20)
		: [];
}

function marketplaceSource(value: unknown): string {
	if (typeof value === "string") return value;
	const source = recordValue(value);
	const kind = stringValue(source.source);
	const location =
		stringValue(source.repo) ||
		stringValue(source.url) ||
		stringValue(source.path);
	return [kind, location].filter(Boolean).join(" · ");
}

function marketplacePluginId(name: string, marketplace: string): string {
	return `${name}@${marketplace}`;
}

function availableFromEntry(
	providerId: ExtensionProviderId,
	home: ProviderExtensionHome,
	marketplace: string,
	entry: JsonRecord,
	installed: ProviderExtension | undefined,
	hasLocalPackage: boolean,
): AvailableExtension | null {
	const name = stringValue(entry.name);
	if (!name) return null;
	return {
		id: availableExtensionId(providerId, home, marketplace, name),
		providerId,
		providerLabel: providerId === "claude" ? "Claude" : "Codex",
		environment: home.environment,
		environmentLabel: home.environmentLabel,
		pluginId: marketplacePluginId(name, marketplace),
		name,
		displayName: displayName(entry, name),
		marketplace,
		version: stringValue(entry.version) || installed?.version || "",
		description: stringValue(entry.description),
		author: authorName(entry),
		category: stringValue(entry.category),
		source: marketplaceSource(entry.source) || marketplace,
		homepage: stringValue(entry.homepage),
		installed: installed !== undefined,
		enabled: installed?.enabled ?? null,
		reviewLevel: hasLocalPackage ? "package" : "marketplace",
	};
}

async function marketplacePluginCount(path: string): Promise<number | null> {
	const candidates = [
		resolve(path, ".claude-plugin", "marketplace.json"),
		resolve(path, ".agents", "plugins", "marketplace.json"),
	];
	for (const candidate of candidates) {
		try {
			const manifest = recordValue(await readJson(candidate));
			if (Array.isArray(manifest.plugins)) return manifest.plugins.length;
		} catch (error) {
			if (!isMissing(error)) return null;
		}
	}
	return null;
}

function splitPluginId(pluginId: string): {
	name: string;
	marketplace: string;
} {
	const separator = pluginId.lastIndexOf("@");
	return separator > 0 && separator < pluginId.length - 1
		? {
				name: pluginId.slice(0, separator),
				marketplace: pluginId.slice(separator + 1),
			}
		: { name: pluginId, marketplace: "" };
}

async function inspectClaudeHome(
	home: ProviderExtensionHome,
): Promise<ProviderInspection> {
	const providerId = "claude" as const;
	const pluginHome = resolve(home.path, ".claude", "plugins");
	const extensions: ProviderExtension[] = [];
	const marketplaces: ProviderMarketplace[] = [];
	const available: AvailableExtension[] = [];
	const reviewTargets: ExtensionReviewTarget[] = [];
	const errors: ExtensionInventoryError[] = [];
	const marketplaceEntries = new Map<
		string,
		{
			value: JsonRecord;
			path: string;
			marketplaceRoot: string;
			localRoot: string;
		}
	>();
	let registry: JsonRecord = {};
	let enabledPlugins: JsonRecord = {};

	try {
		registry = recordValue(
			await readOptionalJson(resolve(pluginHome, "installed_plugins.json")),
		);
	} catch (error) {
		errors.push(
			inventoryError(
				providerId,
				home,
				`Installed plugin registry is invalid: ${errorMessage(error)}`,
			),
		);
	}
	try {
		const settings = recordValue(
			await readOptionalJson(resolve(home.path, ".claude", "settings.json")),
		);
		enabledPlugins = recordValue(settings.enabledPlugins);
	} catch (error) {
		errors.push(
			inventoryError(
				providerId,
				home,
				`Claude settings are invalid: ${errorMessage(error)}`,
			),
		);
	}

	try {
		const known = recordValue(
			await readOptionalJson(resolve(pluginHome, "known_marketplaces.json")),
		);
		for (const [name, rawMarketplace] of Object.entries(known)) {
			const marketplace = recordValue(rawMarketplace);
			const declaredPath = stringValue(marketplace.installLocation);
			const path = declaredPath
				? resolve(hostPathFromProvider(home.path, declaredPath))
				: "";
			const manifestPath = path
				? resolve(path, ".claude-plugin", "marketplace.json")
				: "";
			if (manifestPath) {
				const manifest = recordValue(
					await readOptionalJson(manifestPath).catch(() => null),
				);
				for (const rawPlugin of Array.isArray(manifest.plugins)
					? manifest.plugins
					: []) {
					const plugin = recordValue(rawPlugin);
					const pluginName = stringValue(plugin.name);
					if (pluginName) {
						const source = plugin.source;
						const localRoot =
							typeof source === "string" ? resolve(path, source) : "";
						marketplaceEntries.set(`${name}\0${pluginName}`, {
							value: plugin,
							path: `${manifestPath} · plugins[${pluginName}]`,
							marketplaceRoot: path,
							localRoot,
						});
					}
				}
			}
			marketplaces.push({
				id: marketplaceId(providerId, home, name),
				providerId,
				environment: home.environment,
				environmentLabel: home.environmentLabel,
				name,
				source: marketplaceSource(marketplace.source),
				path,
				pluginCount: path ? await marketplacePluginCount(path) : null,
				lastUpdated: stringValue(marketplace.lastUpdated),
				canManage: true,
			});
		}
	} catch (error) {
		errors.push(
			inventoryError(
				providerId,
				home,
				`Marketplace registry is invalid: ${errorMessage(error)}`,
			),
		);
	}

	const installed = recordValue(registry.plugins);
	for (const [pluginId, rawInstalls] of Object.entries(installed)) {
		if (!Array.isArray(rawInstalls)) continue;
		for (const rawInstall of rawInstalls) {
			const install = recordValue(rawInstall);
			const identity = splitPluginId(pluginId);
			const declaredPath = stringValue(install.installPath);
			const translatedPath = hostPathFromProvider(home.path, declaredPath);
			const installPath = resolve(translatedPath);
			const pluginErrors: string[] = [];
			if (!declaredPath || !pathStartsWith(pluginHome, installPath)) {
				pluginErrors.push("Install path falls outside Claude's plugin cache");
			}
			const safeRoot =
				declaredPath && pathStartsWith(pluginHome, installPath)
					? installPath
					: resolve(
							pluginHome,
							"cache",
							identity.marketplace,
							identity.name,
							stringValue(install.version) || "unknown",
						);
			let manifest = await safeManifest(
				safeRoot,
				".claude-plugin/plugin.json",
				pluginHome,
			);
			const marketplaceEntry = marketplaceEntries.get(
				`${identity.marketplace}\0${identity.name}`,
			);
			if (manifest.error === "Plugin manifest is missing" && marketplaceEntry) {
				manifest = {
					path: marketplaceEntry.path,
					raw: JSON.stringify(marketplaceEntry.value, null, 2),
					value: marketplaceEntry.value,
					error: null,
				};
			}
			if (manifest.error) pluginErrors.push(manifest.error);
			const metadata = {
				...(marketplaceEntry?.value ?? {}),
				...manifest.value,
			};
			const rootIsSafe = await rootWithinBoundary(safeRoot, pluginHome);
			const [components, skillFiles] = rootIsSafe
				? await Promise.all([
						inspectComponents(safeRoot, metadata),
						inspectSkillFiles(safeRoot, pluginHome),
					])
				: [[], []];
			extensions.push({
				id: extensionId(providerId, home, pluginId, safeRoot),
				providerId,
				providerLabel: "Claude",
				environment: home.environment,
				environmentLabel: home.environmentLabel,
				pluginId,
				name: identity.name,
				displayName: displayName(metadata, identity.name),
				marketplace: identity.marketplace,
				version:
					stringValue(install.version) ||
					stringValue(metadata.version) ||
					"unknown",
				description: stringValue(metadata.description),
				author: authorName(metadata),
				homepage: stringValue(metadata.homepage),
				repository: stringValue(metadata.repository),
				license: stringValue(metadata.license),
				scope: stringValue(install.scope) || "user",
				enabled: enabledPlugins[pluginId] === true,
				installPath: safeRoot,
				source: marketplaceSource(metadata.source) || identity.marketplace,
				installedAt: stringValue(install.installedAt),
				lastUpdated: stringValue(install.lastUpdated),
				capabilities: manifestCapabilities(metadata),
				components,
				skillFiles,
				manifestPath: manifest.path,
				manifestText: manifest.raw,
				errors: pluginErrors,
			});
		}
	}

	for (const [key, entry] of marketplaceEntries) {
		const [marketplace, name] = key.split("\0");
		if (!marketplace || !name) continue;
		const installedExtension = extensions.find(
			(item) => item.marketplace === marketplace && item.name === name,
		);
		const root = entry.localRoot || installedExtension?.installPath || "";
		const boundary = entry.localRoot ? entry.marketplaceRoot : pluginHome;
		const hasLocalPackage =
			Boolean(root) &&
			(await safeManifest(root, ".claude-plugin/plugin.json", boundary))
				.error === null;
		const summary = availableFromEntry(
			providerId,
			home,
			marketplace,
			entry.value,
			installedExtension,
			hasLocalPackage,
		);
		if (!summary) continue;
		available.push(summary);
		reviewTargets.push({
			available: summary,
			root,
			boundary,
			manifestRelativePath: ".claude-plugin/plugin.json",
			marketplaceEntry: entry.value,
			marketplaceEntryPath: entry.path,
		});
	}
	return { extensions, marketplaces, available, reviewTargets, errors };
}

async function codexPluginRoot(
	cacheRoot: string,
	marketplace: string,
	name: string,
): Promise<string | null> {
	const root = resolve(cacheRoot, marketplace, name);
	const rootManifest = resolve(root, ".codex-plugin", "plugin.json");
	if (
		await stat(rootManifest)
			.then((info) => info.isFile())
			.catch(() => false)
	) {
		return root;
	}
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const candidates = (
		await Promise.all(
			entries.map(async (entry) => {
				if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
				const candidate = resolve(root, entry.name);
				const manifest = resolve(candidate, ".codex-plugin", "plugin.json");
				const info = await stat(manifest).catch(() => null);
				return info?.isFile()
					? { path: candidate, modified: info.mtimeMs }
					: null;
			}),
		)
	)
		.filter(
			(candidate): candidate is { path: string; modified: number } =>
				candidate !== null,
		)
		.sort((a, b) => b.modified - a.modified);
	return candidates[0]?.path ?? null;
}

async function inspectCodexHome(
	configValue: HlidConfig,
	home: ProviderExtensionHome,
	dependencies: ExtensionInventoryDependencies,
): Promise<ProviderInspection> {
	const providerId = "codex" as const;
	const codexHome = resolve(home.path, ".codex");
	const cacheRoot = resolve(codexHome, "plugins", "cache");
	const extensions: ProviderExtension[] = [];
	const marketplaces: ProviderMarketplace[] = [];
	const available: AvailableExtension[] = [];
	const reviewTargets: ExtensionReviewTarget[] = [];
	const errors: ExtensionInventoryError[] = [];
	let config: JsonRecord = {};
	try {
		const raw = await readFile(resolve(codexHome, "config.toml"), "utf8");
		config = recordValue(parseToml(raw));
	} catch (error) {
		if (!isMissing(error)) {
			errors.push(
				inventoryError(
					providerId,
					home,
					`Codex config is invalid: ${errorMessage(error)}`,
				),
			);
		}
	}
	let configuredMarketplaceRoots: CodexMarketplaceRoot[] = [];
	try {
		configuredMarketplaceRoots = await (
			dependencies.listCodexMarketplaces ?? listCodexMarketplaceRoots
		)(configValue, home);
	} catch (error) {
		errors.push(
			inventoryError(
				providerId,
				home,
				`Configured marketplace lookup failed: ${errorMessage(error)}`,
			),
		);
	}

	const plugins = recordValue(config.plugins);
	for (const [pluginId, rawPlugin] of Object.entries(plugins)) {
		const plugin = recordValue(rawPlugin);
		const identity = splitPluginId(pluginId);
		const discoveredRoot = await codexPluginRoot(
			cacheRoot,
			identity.marketplace,
			identity.name,
		);
		const safeFallback = resolve(
			cacheRoot,
			identity.marketplace,
			identity.name,
		);
		const installPath = discoveredRoot ?? safeFallback;
		const manifest = await safeManifest(
			installPath,
			".codex-plugin/plugin.json",
			cacheRoot,
		);
		const pluginErrors = manifest.error ? [manifest.error] : [];
		const rootIsSafe = await rootWithinBoundary(installPath, cacheRoot);
		const [components, skillFiles] = rootIsSafe
			? await Promise.all([
					inspectComponents(installPath, manifest.value),
					inspectSkillFiles(installPath, cacheRoot),
				])
			: [[], []];
		extensions.push({
			id: extensionId(providerId, home, pluginId, installPath),
			providerId,
			providerLabel: "Codex",
			environment: home.environment,
			environmentLabel: home.environmentLabel,
			pluginId,
			name: identity.name,
			displayName: displayName(manifest.value, identity.name),
			marketplace: identity.marketplace,
			version:
				stringValue(manifest.value.version) ||
				(discoveredRoot ? basename(discoveredRoot) : "unknown"),
			description: stringValue(manifest.value.description),
			author: authorName(manifest.value),
			homepage: stringValue(manifest.value.homepage),
			repository: stringValue(manifest.value.repository),
			license: stringValue(manifest.value.license),
			scope: "user",
			enabled: plugin.enabled === true,
			installPath,
			source: identity.marketplace,
			installedAt: "",
			lastUpdated: "",
			capabilities: manifestCapabilities(manifest.value),
			components,
			skillFiles,
			manifestPath: manifest.path,
			manifestText: manifest.raw,
			errors: pluginErrors,
		});
	}

	const marketplaceRoots = [
		...configuredMarketplaceRoots.map((marketplace) => ({
			...marketplace,
			canManage: Boolean(marketplace.source),
		})),
		{
			name: "openai-curated",
			root: resolve(codexHome, ".tmp", "plugins"),
			source: "Codex curated marketplace",
			canManage: false,
		},
		{
			name: "personal",
			root: home.path,
			source: "Personal marketplace",
			canManage: false,
		},
	];
	const seenMarketplaceRoots = new Set<string>();
	for (const configuredMarketplace of marketplaceRoots) {
		const snapshotRoot = resolve(configuredMarketplace.root);
		const rootKey = snapshotRoot;
		if (seenMarketplaceRoots.has(rootKey)) continue;
		seenMarketplaceRoots.add(rootKey);
		const snapshotPath = resolve(
			snapshotRoot,
			".agents",
			"plugins",
			"marketplace.json",
		);
		try {
			const snapshotValue = await readOptionalJson(snapshotPath);
			if (snapshotValue === null) continue;
			const snapshot = recordValue(snapshotValue);
			const name = stringValue(snapshot.name);
			if (!name) continue;
			const configuredEntry = recordValue(
				recordValue(config.marketplaces)[name],
			);
			marketplaces.push({
				id: marketplaceId(providerId, home, name),
				providerId,
				environment: home.environment,
				environmentLabel: home.environmentLabel,
				name,
				source:
					configuredMarketplace.source ||
					stringValue(recordValue(snapshot.interface).displayName) ||
					"Codex marketplace snapshot",
				path: snapshotRoot,
				pluginCount: Array.isArray(snapshot.plugins)
					? snapshot.plugins.length
					: null,
				lastUpdated: stringValue(configuredEntry.last_updated),
				canManage: configuredMarketplace.canManage,
			});
			for (const rawPlugin of Array.isArray(snapshot.plugins)
				? snapshot.plugins
				: []) {
				const plugin = recordValue(rawPlugin);
				const pluginName = stringValue(plugin.name);
				if (!pluginName) continue;
				const installedExtension = extensions.find(
					(item) => item.marketplace === name && item.name === pluginName,
				);
				const source = recordValue(plugin.source);
				const localRoot =
					typeof plugin.source === "string"
						? resolve(snapshotRoot, plugin.source)
						: stringValue(source.source) === "local" && stringValue(source.path)
							? resolve(snapshotRoot, stringValue(source.path))
							: "";
				const root = localRoot || installedExtension?.installPath || "";
				const boundary = localRoot ? snapshotRoot : cacheRoot;
				const hasLocalPackage =
					Boolean(root) &&
					(await safeManifest(root, ".codex-plugin/plugin.json", boundary))
						.error === null;
				const summary = availableFromEntry(
					providerId,
					home,
					name,
					plugin,
					installedExtension,
					hasLocalPackage,
				);
				if (!summary) continue;
				available.push(summary);
				reviewTargets.push({
					available: summary,
					root,
					boundary,
					manifestRelativePath: ".codex-plugin/plugin.json",
					marketplaceEntry: plugin,
					marketplaceEntryPath: `${snapshotPath} · plugins[${pluginName}]`,
				});
			}
		} catch (error) {
			errors.push(
				inventoryError(
					providerId,
					home,
					`Marketplace snapshot is invalid: ${errorMessage(error)}`,
				),
			);
		}
	}

	for (const marketplaceName of new Set(
		extensions.map((extension) => extension.marketplace).filter(Boolean),
	)) {
		if (marketplaces.some((item) => item.name === marketplaceName)) continue;
		marketplaces.push({
			id: marketplaceId(providerId, home, marketplaceName),
			providerId,
			environment: home.environment,
			environmentLabel: home.environmentLabel,
			name: marketplaceName,
			source: marketplaceName === "openai-bundled" ? "Codex bundled" : "",
			path: resolve(cacheRoot, marketplaceName),
			pluginCount: null,
			lastUpdated: "",
			canManage: false,
		});
	}
	return { extensions, marketplaces, available, reviewTargets, errors };
}

async function inspectProviderHomes(
	config: HlidConfig,
	homes: ProviderExtensionHome[],
	dependencies: ExtensionInventoryDependencies,
): Promise<ProviderInspection[]> {
	return Promise.all(
		homes.flatMap((home) => [
			inspectClaudeHome(home),
			inspectCodexHome(config, home, dependencies),
		]),
	);
}

export async function discoverExtensionInventory(
	config: HlidConfig,
	homes = providerExtensionHomes(config),
	dependencies: ExtensionInventoryDependencies = {},
): Promise<ExtensionInventory> {
	const results = await inspectProviderHomes(config, homes, dependencies);
	const extensions = results
		.flatMap((result) => result.extensions)
		.sort(
			(a, b) =>
				a.providerLabel.localeCompare(b.providerLabel) ||
				a.environmentLabel.localeCompare(b.environmentLabel) ||
				a.displayName.localeCompare(b.displayName),
		);
	const marketplaces = results
		.flatMap((result) => result.marketplaces)
		.sort(
			(a, b) =>
				a.providerId.localeCompare(b.providerId) ||
				a.environmentLabel.localeCompare(b.environmentLabel) ||
				a.name.localeCompare(b.name),
		);
	const available = results
		.flatMap((result) => result.available)
		.sort(
			(a, b) =>
				a.providerId.localeCompare(b.providerId) ||
				a.environmentLabel.localeCompare(b.environmentLabel) ||
				a.displayName.localeCompare(b.displayName),
		);
	const environments = homes.flatMap((home) =>
		(["claude", "codex"] as const).map((providerId) => ({
			id: extensionEnvironmentId(providerId, home),
			providerId,
			environment: home.environment,
			environmentLabel: home.environmentLabel,
		})),
	);
	return {
		generatedAt: new Date().toISOString(),
		environments,
		extensions,
		marketplaces,
		available,
		errors: results.flatMap((result) => result.errors),
	};
}

export async function reviewAvailableExtension(
	config: HlidConfig,
	id: string,
	homes = providerExtensionHomes(config),
	dependencies: ExtensionInventoryDependencies = {},
): Promise<ExtensionReview | null> {
	const results = await inspectProviderHomes(config, homes, dependencies);
	const target = results
		.flatMap((result) => result.reviewTargets)
		.find((item) => item.available.id === id);
	if (!target) return null;

	const errors: string[] = [];
	let manifestPath = target.marketplaceEntryPath;
	let manifestText = JSON.stringify(target.marketplaceEntry, null, 2);
	let metadata = target.marketplaceEntry;
	let components: ExtensionComponent[] = [];
	let skillFiles: ExtensionSkillFile[] = [];
	let reviewLevel: ExtensionReview["reviewLevel"] = "marketplace";

	if (target.root) {
		const manifest = await safeManifest(
			target.root,
			target.manifestRelativePath,
			target.boundary,
		);
		if (manifest.error) {
			errors.push(manifest.error);
		} else {
			reviewLevel = "package";
			manifestPath = manifest.path;
			manifestText = manifest.raw;
			metadata = { ...target.marketplaceEntry, ...manifest.value };
			if (await rootWithinBoundary(target.root, target.boundary)) {
				[components, skillFiles] = await Promise.all([
					inspectComponents(target.root, metadata),
					inspectSkillFiles(target.root, target.boundary),
				]);
			}
		}
	}

	return {
		...target.available,
		displayName: displayName(metadata, target.available.name),
		version:
			stringValue(metadata.version) || target.available.version || "unknown",
		description:
			stringValue(metadata.description) || target.available.description,
		author: authorName(metadata) || target.available.author,
		category: stringValue(metadata.category) || target.available.category,
		source: marketplaceSource(metadata.source) || target.available.source,
		homepage: stringValue(metadata.homepage) || target.available.homepage,
		reviewLevel,
		reviewMessage:
			reviewLevel === "package"
				? "Complete package review from the provider's local marketplace cache."
				: "Marketplace metadata only. The package files are not present locally, so Hlið cannot inspect the complete package yet.",
		reviewToken: createHash("sha256")
			.update(
				JSON.stringify({
					id: target.available.id,
					reviewLevel,
					manifestText,
					skillFiles,
				}),
			)
			.digest("hex"),
		manifestPath,
		manifestText,
		capabilities: manifestCapabilities(metadata),
		components,
		skillFiles,
		errors,
	};
}
