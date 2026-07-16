import { accessSync, constants, mkdirSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveClaudeExecutable } from "../lib/claudePath";
import type { CliUpdateStatus } from "../lib/cliUpdateTypes";
import { resolveCodexExecutable } from "../lib/codexPath";
import { canonicalInstallDir } from "../lib/install";
import { parseWslUnc } from "../lib/paths";
import { runBoundedProcess } from "../lib/process";

import { inspectAcpAgent } from "./acpProvider";
import { type AcpCatalogItem, AcpRegistry } from "./acpRegistry";
import { loadConfig } from "./config";

const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 4_000;
const STORE_TIMEOUT_MS = 15_000;
const REGISTRY_TIMEOUT_MS = 5_000;
const CACHE_SCHEMA_VERSION = 2;
const BACKGROUND_REFRESH_DELAY_MS = 1_500;
const CODEX_DESKTOP_STORE_ID = "9PLM9XGG6VKS";

type NativeCliId = "codex" | "claude";

type CliUpdateDependencies = {
	resolveExecutable(id: NativeCliId): string | undefined;
	readVersion(executable: string): Promise<string>;
	fetchLatest(packageName: string): Promise<string>;
	now(): number;
};

type CliDefinition = {
	id: NativeCliId;
	label: string;
	packageName: string;
};

type AcpUpdateCandidate = {
	item: AcpCatalogItem;
	customExecutable: boolean;
};

type AcpUpdateDependencies = {
	listCandidates(): Promise<AcpUpdateCandidate[]>;
	readVersion(item: AcpCatalogItem): Promise<string>;
	now(): number;
};

type WslCliInfo = { version: string; executable: string };

type WslUpdateDependencies = {
	listDistros(): string[];
	readCli(distro: string, id: NativeCliId): Promise<WslCliInfo>;
	fetchLatest(packageName: string): Promise<string>;
	now(): number;
};

type WindowsDesktopUpdateDependencies = {
	isWindows(): boolean;
	readInstalledVersion(): Promise<string | null>;
	readStoreVersions(): Promise<{
		installedVersion: string;
		latestVersion: string;
	}>;
	now(): number;
};

export type CliUpdateAction = {
	id: CliUpdateStatus["id"];
	displayCommand: string;
	command: string;
	args: string[];
	automatic: boolean;
	requiresElevation: boolean;
	drainSessions?: boolean;
};

const CLI_DEFINITIONS: CliDefinition[] = [
	{ id: "codex", label: "Codex", packageName: "@openai/codex" },
	{
		id: "claude",
		label: "Claude Code",
		packageName: "@anthropic-ai/claude-code",
	},
];

export function parseCliVersion(output: string): string | null {
	return (
		output.match(/\b(\d+\.\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ??
		null
	);
}

export function compareCliVersions(a: string, b: string): number {
	const parse = (value: string) => {
		const [base, prerelease = ""] = value.replace(/^v/i, "").split("-", 2);
		return {
			parts: base.split(".").map((part) => Number.parseInt(part, 10) || 0),
			prerelease,
		};
	};
	const left = parse(a);
	const right = parse(b);
	for (
		let index = 0;
		index < Math.max(left.parts.length, right.parts.length);
		index++
	) {
		const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

/** Parse winget's exact Store-package row without depending on localized headers. */
export function parseWindowsStoreVersions(
	output: string,
	storeId = CODEX_DESKTOP_STORE_ID,
): { installedVersion: string; latestVersion: string } | null {
	const row = output
		.split(/\r?\n/)
		.find((line) => line.toUpperCase().includes(storeId.toUpperCase()));
	if (!row) return null;
	const idIndex = row.toUpperCase().indexOf(storeId.toUpperCase());
	const versions = row
		.slice(idIndex + storeId.length)
		.match(/\b\d+\.\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?\b/g);
	const installedVersion = versions?.[0];
	if (!installedVersion) return null;
	return {
		installedVersion,
		latestVersion: versions?.[1] ?? installedVersion,
	};
}

async function readInstalledVersion(executable: string): Promise<string> {
	const result = await runBoundedProcess(executable, ["--version"], {
		timeoutMs: COMMAND_TIMEOUT_MS,
		timeoutError: "version command timed out",
	});
	if (result.code !== 0) {
		throw new Error(`version command exited ${result.code}`);
	}
	const version = parseCliVersion(result.output);
	if (!version) throw new Error("version output was not recognized");
	return version;
}

async function fetchLatestPackageVersion(packageName: string): Promise<string> {
	const response = await fetch(
		`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
		{
			headers: { Accept: "application/json", "User-Agent": "hlid-cli-updater" },
			signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
		},
	);
	if (!response.ok)
		throw new Error(`registry returned HTTP ${response.status}`);
	const body = (await response.json()) as { version?: unknown };
	if (typeof body.version !== "string") {
		throw new Error("registry response did not include a version");
	}
	return body.version;
}

function resolvedExecutable(executable: string): string {
	let resolved = executable;
	try {
		resolved = realpathSync(executable);
	} catch {}
	return resolved;
}

function needsElevation(executable: string): boolean {
	if (process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(executable)) {
		return false;
	}
	try {
		accessSync(resolvedExecutable(executable), constants.W_OK);
		return false;
	} catch {
		return true;
	}
}

function codexUpdateAction(executable: string): CliUpdateAction | undefined {
	const resolved = resolvedExecutable(executable);
	const normalized = resolved.replaceAll("\\", "/").toLowerCase();
	if (normalized.includes("/homebrew/") || normalized.includes("/cellar/")) {
		return {
			id: "codex",
			displayCommand: "brew upgrade codex",
			command: "brew",
			args: ["upgrade", "codex"],
			automatic: true,
			requiresElevation: false,
		};
	}
	if (
		normalized.includes("/.bun/") ||
		normalized.includes("/bun/install/global/")
	) {
		return {
			id: "codex",
			displayCommand: "bun add --global @openai/codex@latest",
			command: "bun",
			args: ["add", "--global", "@openai/codex@latest"],
			automatic: true,
			requiresElevation: false,
		};
	}
	if (
		normalized.includes("/node_modules/@openai/codex/") ||
		normalized.endsWith("/codex.cmd")
	) {
		const requiresElevation = needsElevation(resolved);
		return {
			id: "codex",
			displayCommand: `${requiresElevation ? "sudo " : ""}npm install --global @openai/codex@latest`,
			command: process.platform === "win32" ? "npm.cmd" : "npm",
			args: ["install", "--global", "@openai/codex@latest"],
			automatic: !requiresElevation,
			requiresElevation,
		};
	}
	return undefined;
}

function nativeUpdateAction(
	id: NativeCliId,
	executable: string,
): CliUpdateAction | undefined {
	if (id === "codex") return codexUpdateAction(executable);
	const requiresElevation = needsElevation(executable);
	const bundledSdk = resolvedExecutable(executable)
		.replaceAll("\\", "/")
		.includes("/node_modules/@anthropic-ai/claude-agent-sdk-");
	return {
		id,
		displayCommand: `${requiresElevation ? "sudo " : ""}claude update`,
		command: executable,
		args: ["update"],
		automatic: !requiresElevation && !bundledSdk,
		requiresElevation,
	};
}

const defaultDependencies: CliUpdateDependencies = {
	resolveExecutable: (id) =>
		id === "codex" ? resolveCodexExecutable() : resolveClaudeExecutable(),
	readVersion: readInstalledVersion,
	fetchLatest: fetchLatestPackageVersion,
	now: Date.now,
};

async function readInstalledCodexDesktopVersion(): Promise<string | null> {
	const result = await runBoundedProcess(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue; if ($package) { $package.Version.ToString() }",
		],
		{
			timeoutMs: COMMAND_TIMEOUT_MS,
			timeoutError: "Codex desktop version check timed out",
		},
	);
	if (result.code !== 0) {
		throw new Error(`PowerShell version check exited ${result.code}`);
	}
	return parseCliVersion(result.output);
}

async function readCodexDesktopStoreVersions(): Promise<{
	installedVersion: string;
	latestVersion: string;
}> {
	const result = await runBoundedProcess(
		"winget.exe",
		[
			"list",
			"--id",
			CODEX_DESKTOP_STORE_ID,
			"--source",
			"msstore",
			"--exact",
			"--accept-source-agreements",
			"--disable-interactivity",
		],
		{
			timeoutMs: STORE_TIMEOUT_MS,
			timeoutError: "Microsoft Store version check timed out",
		},
	);
	if (result.code !== 0) {
		throw new Error(`winget Store check exited ${result.code}`);
	}
	const versions = parseWindowsStoreVersions(result.output);
	if (!versions) throw new Error("winget Store output was not recognized");
	return versions;
}

const defaultWindowsDesktopDependencies: WindowsDesktopUpdateDependencies = {
	isWindows: () => process.platform === "win32",
	readInstalledVersion: readInstalledCodexDesktopVersion,
	readStoreVersions: readCodexDesktopStoreVersions,
	now: Date.now,
};

function windowsDesktopUpdateAction(): CliUpdateAction {
	const args = [
		"upgrade",
		"--id",
		CODEX_DESKTOP_STORE_ID,
		"--source",
		"msstore",
		"--exact",
		"--silent",
		"--accept-source-agreements",
		"--accept-package-agreements",
		"--disable-interactivity",
	];
	return {
		id: "codex-desktop",
		displayCommand: `winget ${args.join(" ")}`,
		command: "winget.exe",
		args,
		automatic: true,
		requiresElevation: false,
		drainSessions: false,
	};
}

async function readWslCli(
	distro: string,
	id: NativeCliId,
): Promise<WslCliInfo> {
	const script = buildWslCliProbeScript(id);
	const result = await runBoundedProcess(
		"wsl.exe",
		["-d", distro, "--", "bash", "-lc", script],
		{
			timeoutMs: COMMAND_TIMEOUT_MS,
			timeoutError: "WSL version command timed out",
		},
	);
	if (result.code !== 0) throw new Error(`WSL command exited ${result.code}`);
	const version = parseCliVersion(result.output);
	const lines = result.output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const executable = lines.at(-1);
	if (!version || !executable?.startsWith("/")) {
		throw new Error("WSL CLI version output was not recognized");
	}
	return { version, executable };
}

export function buildWslCliProbeScript(id: NativeCliId): string {
	// Avoid command substitution here. wsl.exe can expand $(command -v ...)
	// before the login shell has loaded the user's PATH, which hides CLIs
	// installed in locations such as ~/.local/bin and ~/.bun/bin.
	return [
		`command -v ${id}`,
		`${id} --version`,
		`command -v ${id} | xargs -r readlink -f`,
	].join(" && ");
}

function configuredWslDistros(): string[] {
	if (process.platform !== "win32") return [];
	const config = loadConfig();
	const paths = [
		config.vault.path,
		...(config.agents ?? []).map((agent) => agent.path),
	];
	return [
		...new Set(
			paths
				.map((path) => parseWslUnc(path)?.distro)
				.filter((distro): distro is string => distro != null),
		),
	].sort();
}

const defaultWslDependencies: WslUpdateDependencies = {
	listDistros: configuredWslDistros,
	readCli: readWslCli,
	fetchLatest: fetchLatestPackageVersion,
	now: Date.now,
};

function wslUpdateAction(
	distro: string,
	id: NativeCliId,
	executable: string,
): CliUpdateAction | undefined {
	if (!/^[A-Za-z0-9._-]+$/.test(distro)) return undefined;
	const normalized = executable.toLowerCase();
	const actionId = `wsl:${distro}:${id}` as CliUpdateStatus["id"];
	let displayCommand: string;
	let requiresElevation = false;
	if (id === "claude") {
		requiresElevation = normalized.startsWith("/usr/");
		displayCommand = `${requiresElevation ? "sudo " : ""}claude update`;
	} else if (
		normalized.includes("/.bun/") ||
		normalized.includes("/bun/install/global/")
	) {
		displayCommand = "bun add --global @openai/codex@latest";
	} else if (normalized.includes("/node_modules/@openai/codex/")) {
		requiresElevation = normalized.startsWith("/usr/");
		displayCommand = `${requiresElevation ? "sudo " : ""}npm install --global @openai/codex@latest`;
	} else {
		return undefined;
	}
	return {
		id: actionId,
		displayCommand,
		command: "wsl.exe",
		args: ["-d", distro, "--", "bash", "-lc", displayCommand],
		automatic: !requiresElevation,
		requiresElevation,
	};
}

const acpRegistry = new AcpRegistry();

function acpUpdateAction(
	candidate: AcpUpdateCandidate,
): CliUpdateAction | undefined {
	if (candidate.customExecutable) return undefined;
	const { distribution } = candidate.item;
	if (distribution.npx) {
		return {
			id: `acp:${candidate.item.id}`,
			displayCommand: `bun add --global ${distribution.npx.package}`,
			command: "bun",
			args: ["add", "--global", distribution.npx.package],
			automatic: true,
			requiresElevation: false,
		};
	}
	if (distribution.uvx) {
		return {
			id: `acp:${candidate.item.id}`,
			displayCommand: `uv tool install --force ${distribution.uvx.package}`,
			command: "uv",
			args: ["tool", "install", "--force", distribution.uvx.package],
			automatic: true,
			requiresElevation: false,
		};
	}
	return undefined;
}

const defaultAcpDependencies: AcpUpdateDependencies = {
	listCandidates: async () => {
		const config = loadConfig();
		const configured = new Map(
			(config.acp_agents ?? []).map((agent) => [agent.id, agent]),
		);
		return (await acpRegistry.catalog(config))
			.filter((item) => item.enabled && item.available)
			.map((item) => ({
				item,
				customExecutable: Boolean(configured.get(item.id)?.executable),
			}));
	},
	readVersion: async (item) => {
		const initialized = await inspectAcpAgent({
			id: item.providerId,
			label: item.name,
			command: item.command,
			args: item.args,
			env: item.env,
		});
		const version = initialized.agentInfo?.version;
		const parsed =
			typeof version === "string" ? parseCliVersion(version) : null;
		if (!parsed) {
			throw new Error("ACP agent did not report a version");
		}
		return parsed;
	},
	now: Date.now,
};

export async function inspectCliUpdates(
	dependencies: CliUpdateDependencies = defaultDependencies,
): Promise<CliUpdateStatus[]> {
	const checkedAt = dependencies.now();
	return (
		await Promise.all(
			CLI_DEFINITIONS.map(async (definition) => {
				const executable = dependencies.resolveExecutable(definition.id);
				if (!executable) return null;
				const [installedResult, latestResult] = await Promise.allSettled([
					dependencies.readVersion(executable),
					dependencies.fetchLatest(definition.packageName),
				]);
				const installedVersion =
					installedResult.status === "fulfilled" ? installedResult.value : null;
				const latestVersion =
					latestResult.status === "fulfilled" ? latestResult.value : null;
				const errors = [
					installedResult.status === "rejected"
						? `installed version: ${installedResult.reason instanceof Error ? installedResult.reason.message : String(installedResult.reason)}`
						: null,
					latestResult.status === "rejected"
						? `latest version: ${latestResult.reason instanceof Error ? latestResult.reason.message : String(latestResult.reason)}`
						: null,
				].filter((value): value is string => value != null);
				const action = nativeUpdateAction(definition.id, executable);
				return {
					id: definition.id,
					label: definition.label,
					installedVersion,
					latestVersion,
					available:
						installedVersion != null &&
						latestVersion != null &&
						compareCliVersions(latestVersion, installedVersion) > 0,
					...(action
						? {
								updateCommand: action.displayCommand,
								updateMode: action.automatic
									? ("automatic" as const)
									: ("interactive" as const),
								requiresElevation: action.requiresElevation,
							}
						: {}),
					checkedAt,
					...(errors.length > 0 ? { error: errors.join("; ") } : {}),
				} satisfies CliUpdateStatus;
			}),
		)
	).filter((status) => status != null);
}

export async function inspectWindowsDesktopUpdates(
	dependencies: WindowsDesktopUpdateDependencies = defaultWindowsDesktopDependencies,
): Promise<CliUpdateStatus[]> {
	if (!dependencies.isWindows()) return [];
	const installedVersion = await dependencies.readInstalledVersion();
	if (!installedVersion) return [];
	const storeResult = await Promise.allSettled([
		dependencies.readStoreVersions(),
	]);
	const storeVersions =
		storeResult[0].status === "fulfilled" ? storeResult[0].value : null;
	const latestVersion = storeVersions?.latestVersion ?? null;
	const action = windowsDesktopUpdateAction();
	return [
		{
			id: "codex-desktop",
			label: "Codex desktop app",
			surface: "desktop",
			installedVersion,
			latestVersion,
			available:
				latestVersion != null &&
				compareCliVersions(latestVersion, installedVersion) > 0,
			updateCommand: action.displayCommand,
			updateMode: "automatic",
			requiresElevation: false,
			checkedAt: dependencies.now(),
			...(storeResult[0].status === "rejected"
				? {
						error: `latest version: ${storeResult[0].reason instanceof Error ? storeResult[0].reason.message : String(storeResult[0].reason)}`,
					}
				: {}),
		} satisfies CliUpdateStatus,
	];
}

export async function inspectAcpUpdates(
	dependencies: AcpUpdateDependencies = defaultAcpDependencies,
): Promise<CliUpdateStatus[]> {
	const checkedAt = dependencies.now();
	const candidates = await dependencies.listCandidates();
	return Promise.all(
		candidates.map(async (candidate) => {
			const [installedResult] = await Promise.allSettled([
				dependencies.readVersion(candidate.item),
			]);
			const installedVersion =
				installedResult.status === "fulfilled" ? installedResult.value : null;
			const latestVersion = parseCliVersion(candidate.item.version);
			const errors = [
				installedResult.status === "rejected"
					? `installed version: ${installedResult.reason instanceof Error ? installedResult.reason.message : String(installedResult.reason)}`
					: null,
				latestVersion == null
					? "latest version: registry did not report a version"
					: null,
			].filter((value): value is string => value != null);
			const action = acpUpdateAction(candidate);
			return {
				id: `acp:${candidate.item.id}`,
				label: `${candidate.item.name} (ACP)`,
				installedVersion,
				latestVersion,
				available:
					installedVersion != null &&
					latestVersion != null &&
					compareCliVersions(latestVersion, installedVersion) > 0,
				...(action
					? {
							updateCommand: action.displayCommand,
							updateMode: action.automatic
								? ("automatic" as const)
								: ("interactive" as const),
							requiresElevation: action.requiresElevation,
						}
					: {}),
				checkedAt,
				...(errors.length > 0 ? { error: errors.join("; ") } : {}),
			} satisfies CliUpdateStatus;
		}),
	);
}

export async function inspectWslUpdates(
	dependencies: WslUpdateDependencies = defaultWslDependencies,
): Promise<CliUpdateStatus[]> {
	const checkedAt = dependencies.now();
	const definitions = dependencies
		.listDistros()
		.flatMap((distro) =>
			CLI_DEFINITIONS.map((definition) => ({ distro, definition })),
		);
	return (
		await Promise.all(
			definitions.map(async ({ distro, definition }) => {
				const [installedResult, latestResult] = await Promise.allSettled([
					dependencies.readCli(distro, definition.id),
					dependencies.fetchLatest(definition.packageName),
				]);
				// A configured distro does not have to contain every provider CLI.
				if (installedResult.status === "rejected") return null;
				const latestVersion =
					latestResult.status === "fulfilled" ? latestResult.value : null;
				const action = wslUpdateAction(
					distro,
					definition.id,
					installedResult.value.executable,
				);
				return {
					id: `wsl:${distro}:${definition.id}`,
					label: `${definition.label} (${distro})`,
					installedVersion: installedResult.value.version,
					latestVersion,
					available:
						latestVersion != null &&
						compareCliVersions(latestVersion, installedResult.value.version) >
							0,
					...(action
						? {
								updateCommand: action.displayCommand,
								updateMode: action.automatic
									? ("automatic" as const)
									: ("interactive" as const),
								requiresElevation: action.requiresElevation,
							}
						: {}),
					checkedAt,
					...(latestResult.status === "rejected"
						? {
								error: `latest version: ${latestResult.reason instanceof Error ? latestResult.reason.message : String(latestResult.reason)}`,
							}
						: {}),
				} satisfies CliUpdateStatus;
			}),
		)
	).filter((status) => status != null);
}

export async function resolveCliUpdateAction(
	id: string,
): Promise<CliUpdateAction | null> {
	if (id === "codex-desktop") return windowsDesktopUpdateAction();
	if (id === "codex" || id === "claude") {
		const executable = defaultDependencies.resolveExecutable(id);
		return executable ? (nativeUpdateAction(id, executable) ?? null) : null;
	}
	const wslMatch = id.match(/^wsl:([A-Za-z0-9._-]+):(codex|claude)$/);
	if (wslMatch) {
		const [, distro, provider] = wslMatch;
		const info = await defaultWslDependencies.readCli(
			distro,
			provider as NativeCliId,
		);
		return (
			wslUpdateAction(distro, provider as NativeCliId, info.executable) ?? null
		);
	}
	if (!id.startsWith("acp:")) return null;
	const candidateId = id.slice("acp:".length);
	const candidates = await defaultAcpDependencies.listCandidates();
	const candidate = candidates.find((entry) => entry.item.id === candidateId);
	return candidate ? (acpUpdateAction(candidate) ?? null) : null;
}

export type CliUpdateStatusCache = {
	checkedAt: number;
	statuses: CliUpdateStatus[];
};

export type CliUpdateStatusDependencies = {
	now(): number;
	readCache(): Promise<CliUpdateStatusCache | null>;
	writeCache(value: CliUpdateStatusCache): Promise<void>;
	inspectNative(): Promise<CliUpdateStatus[]>;
	inspectDesktop(): Promise<CliUpdateStatus[]>;
	inspectWsl(): Promise<CliUpdateStatus[]>;
	inspectAcp(): Promise<CliUpdateStatus[]>;
};

let cached: CliUpdateStatusCache | null = null;
let inflight: Promise<CliUpdateStatus[]> | null = null;
let cacheHydration: Promise<void> | null = null;
let scheduledRefresh: ReturnType<typeof setTimeout> | null = null;

function cachePath(): string {
	return join(canonicalInstallDir(), "cli-update-cache.json");
}

function isPersistedStatus(value: unknown): value is CliUpdateStatus {
	if (!value || typeof value !== "object") return false;
	const status = value as Partial<CliUpdateStatus>;
	const nullableString = (field: unknown) =>
		field === null || typeof field === "string";
	return (
		typeof status.id === "string" &&
		(status.id === "codex" ||
			status.id === "claude" ||
			status.id === "codex-desktop" ||
			/^wsl:[^:]+:(?:codex|claude)$/.test(status.id) ||
			/^acp:.+/.test(status.id)) &&
		typeof status.label === "string" &&
		(status.surface === undefined ||
			status.surface === "cli" ||
			status.surface === "desktop") &&
		nullableString(status.installedVersion) &&
		nullableString(status.latestVersion) &&
		typeof status.available === "boolean" &&
		(status.updateCommand === undefined ||
			typeof status.updateCommand === "string") &&
		(status.updateMode === undefined ||
			status.updateMode === "automatic" ||
			status.updateMode === "interactive") &&
		(status.requiresElevation === undefined ||
			typeof status.requiresElevation === "boolean") &&
		Number.isFinite(status.checkedAt) &&
		(status.error === undefined || typeof status.error === "string")
	);
}

/** @internal Strictly parse the advisory disk cache before exposing it to UI. */
export function parseCliUpdateStatusCache(
	raw: string,
): CliUpdateStatusCache | null {
	try {
		const parsed = JSON.parse(raw) as {
			schemaVersion?: unknown;
			checkedAt?: unknown;
			statuses?: unknown;
		};
		if (
			parsed.schemaVersion === CACHE_SCHEMA_VERSION &&
			Number.isFinite(parsed.checkedAt) &&
			Array.isArray(parsed.statuses) &&
			parsed.statuses.every(isPersistedStatus)
		) {
			return {
				checkedAt: parsed.checkedAt as number,
				statuses: parsed.statuses,
			};
		}
	} catch {}
	return null;
}

async function readPersistedCache(): Promise<CliUpdateStatusCache | null> {
	try {
		return parseCliUpdateStatusCache(await readFile(cachePath(), "utf8"));
	} catch {
		// First run or an unreadable cache falls back to normal discovery.
		return null;
	}
}

async function writePersistedCache(value: CliUpdateStatusCache): Promise<void> {
	mkdirSync(canonicalInstallDir(), { recursive: true });
	await writeFile(
		cachePath(),
		JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, ...value }, null, 2),
		"utf8",
	);
}

const defaultStatusDependencies: CliUpdateStatusDependencies = {
	now: Date.now,
	readCache: readPersistedCache,
	writeCache: writePersistedCache,
	inspectNative: inspectCliUpdates,
	inspectDesktop: inspectWindowsDesktopUpdates,
	inspectWsl: inspectWslUpdates,
	inspectAcp: inspectAcpUpdates,
};

async function hydrateCache(
	dependencies: CliUpdateStatusDependencies,
): Promise<void> {
	if (cached) return;
	if (cacheHydration) return cacheHydration;
	cacheHydration = dependencies
		.readCache()
		.then((persisted) => {
			if (persisted) cached = persisted;
		})
		.catch(() => {})
		.finally(() => {
			cacheHydration = null;
		});
	return cacheHydration;
}

function refreshCliUpdateStatuses(
	dependencies: CliUpdateStatusDependencies,
): Promise<CliUpdateStatus[]> {
	if (scheduledRefresh) {
		clearTimeout(scheduledRefresh);
		scheduledRefresh = null;
	}
	if (inflight) return inflight;
	const pending = Promise.all([
		dependencies.inspectNative(),
		dependencies.inspectDesktop().catch(() => []),
		dependencies.inspectWsl().catch(() => []),
		dependencies.inspectAcp().catch(() => []),
	])
		.then(([nativeStatuses, desktopStatuses, wslStatuses, acpStatuses]) => {
			const statuses = [
				...nativeStatuses,
				...desktopStatuses,
				...wslStatuses,
				...acpStatuses,
			];
			cached = { checkedAt: dependencies.now(), statuses };
			void dependencies.writeCache(cached).catch(() => {});
			return statuses;
		})
		.finally(() => {
			inflight = null;
		});
	inflight = pending;
	return pending;
}

function scheduleCliUpdateRefresh(
	dependencies: CliUpdateStatusDependencies,
	delayMs: number,
): void {
	if (inflight || scheduledRefresh) return;
	const timer = setTimeout(() => {
		if (scheduledRefresh !== timer) return;
		scheduledRefresh = null;
		void refreshCliUpdateStatuses(dependencies).catch(() => {});
	}, delayMs);
	scheduledRefresh = timer;
	timer.unref?.();
}

export async function getCliUpdateStatuses(
	opts?: {
		force?: boolean;
		/** Return persisted stale data immediately and refresh it out of band. */
		background?: boolean;
		/** @internal Override the startup grace period in focused tests. */
		backgroundDelayMs?: number;
	},
	dependencies = defaultStatusDependencies,
): Promise<CliUpdateStatus[]> {
	await hydrateCache(dependencies);
	if (
		!opts?.force &&
		cached &&
		dependencies.now() - cached.checkedAt < CHECK_TTL_MS
	) {
		return cached.statuses;
	}
	if (opts?.background) {
		scheduleCliUpdateRefresh(
			dependencies,
			Math.max(0, opts.backgroundDelayMs ?? BACKGROUND_REFRESH_DELAY_MS),
		);
		return cached?.statuses ?? [];
	}
	return refreshCliUpdateStatuses(dependencies);
}

export function isCliUpdateStatusRefreshPending(): boolean {
	return inflight !== null || scheduledRefresh !== null;
}

/** @internal Reset module-level cache state between dependency-injected tests. */
export function __resetCliUpdateStatusCacheForTesting(): void {
	if (scheduledRefresh) clearTimeout(scheduledRefresh);
	cached = null;
	inflight = null;
	cacheHydration = null;
	scheduledRefresh = null;
}
