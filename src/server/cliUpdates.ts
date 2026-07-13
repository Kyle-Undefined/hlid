import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolveClaudeExecutable } from "../lib/claudePath";
import type { CliUpdateStatus } from "../lib/cliUpdateTypes";
import { resolveCodexExecutable } from "../lib/codexPath";

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

function readInstalledVersion(executable: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let output = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (error) reject(error);
			else {
				const version = parseCliVersion(output);
				if (version) resolve(version);
				else reject(new Error("version output was not recognized"));
			}
		};
		const append = (chunk: Buffer | string) => {
			if (output.length < 8_192) output += chunk.toString();
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (error) => finish(error));
		child.on("close", (code) =>
			finish(
				code === 0 ? undefined : new Error(`version command exited ${code}`),
			),
		);
		timer = setTimeout(() => {
			child.kill();
			finish(new Error("version command timed out"));
		}, COMMAND_TIMEOUT_MS);
	});
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

function codexUpdateCommand(executable: string): string | undefined {
	let resolved = executable;
	try {
		resolved = realpathSync(executable);
	} catch {}
	const normalized = resolved.replaceAll("\\", "/").toLowerCase();
	if (normalized.includes("/homebrew/") || normalized.includes("/cellar/")) {
		return "brew upgrade codex";
	}
	if (
		normalized.includes("/.bun/") ||
		normalized.includes("/bun/install/global/")
	) {
		return "bun add --global @openai/codex@latest";
	}
	if (
		normalized.includes("/node_modules/@openai/codex/") ||
		normalized.endsWith("/codex.cmd")
	) {
		return "npm install --global @openai/codex@latest";
	}
	return undefined;
}

function updateCommand(
	id: NativeCliId,
	executable: string,
): string | undefined {
	return id === "claude" ? "claude update" : codexUpdateCommand(executable);
}

const defaultDependencies: CliUpdateDependencies = {
	resolveExecutable: (id) =>
		id === "codex" ? resolveCodexExecutable() : resolveClaudeExecutable(),
	readVersion: readInstalledVersion,
	fetchLatest: fetchLatestPackageVersion,
	now: Date.now,
};

const acpRegistry = new AcpRegistry();

function acpUpdateCommand(candidate: AcpUpdateCandidate): string | undefined {
	if (candidate.customExecutable) return undefined;
	const { distribution } = candidate.item;
	if (distribution.npx) {
		return `bun add --global ${distribution.npx.package}`;
	}
	if (distribution.uvx) {
		return `uv tool install --force ${distribution.uvx.package}`;
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
				const command = updateCommand(definition.id, executable);
				return {
					id: definition.id,
					label: definition.label,
					installedVersion,
					latestVersion,
					available:
						installedVersion != null &&
						latestVersion != null &&
						compareCliVersions(latestVersion, installedVersion) > 0,
					...(command ? { updateCommand: command } : {}),
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
			const command = acpUpdateCommand(candidate);
			return {
				id: `acp:${candidate.item.id}`,
				label: `${candidate.item.name} (ACP)`,
				installedVersion,
				latestVersion,
				available:
					installedVersion != null &&
					latestVersion != null &&
					compareCliVersions(latestVersion, installedVersion) > 0,
				...(command ? { updateCommand: command } : {}),
				checkedAt,
				...(errors.length > 0 ? { error: errors.join("; ") } : {}),
			} satisfies CliUpdateStatus;
		}),
	);
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
		inspectAcpUpdates().catch(() => []),
	])
		.then(([nativeStatuses, acpStatuses]) => {
			const statuses = [...nativeStatuses, ...acpStatuses];
			cached = { checkedAt: Date.now(), statuses };
			return statuses;
		})
		.finally(() => {
			inflight = null;
		});
	inflight = pending;
	return pending;
}
