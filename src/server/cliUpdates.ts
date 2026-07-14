import { accessSync, constants, realpathSync } from "node:fs";
import { resolveClaudeExecutable } from "../lib/claudePath";
import type { CliUpdateStatus } from "../lib/cliUpdateTypes";
import { resolveCodexExecutable } from "../lib/codexPath";
import { parseWslUnc } from "../lib/paths";
import { runBoundedProcess } from "../lib/process";

import { inspectAcpAgent } from "./acpProvider";
import { type AcpCatalogItem, AcpRegistry } from "./acpRegistry";
import { loadConfig } from "./config";

const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 4_000;
const REGISTRY_TIMEOUT_MS = 5_000;

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

export type CliUpdateAction = {
	id: CliUpdateStatus["id"];
	displayCommand: string;
	command: string;
	args: string[];
	automatic: boolean;
	requiresElevation: boolean;
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
	return output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
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
	for (let index = 0; index < 3; index++) {
		const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
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

let cached: { checkedAt: number; statuses: CliUpdateStatus[] } | null = null;
let inflight: Promise<CliUpdateStatus[]> | null = null;

export async function getCliUpdateStatuses(opts?: {
	force?: boolean;
}): Promise<CliUpdateStatus[]> {
	if (!opts?.force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) {
		return cached.statuses;
	}
	if (inflight) return inflight;
	const pending = Promise.all([
		inspectCliUpdates(),
		inspectWslUpdates().catch(() => []),
		inspectAcpUpdates().catch(() => []),
	])
		.then(([nativeStatuses, wslStatuses, acpStatuses]) => {
			const statuses = [...nativeStatuses, ...wslStatuses, ...acpStatuses];
			cached = { checkedAt: Date.now(), statuses };
			return statuses;
		})
		.finally(() => {
			inflight = null;
		});
	inflight = pending;
	return pending;
}
