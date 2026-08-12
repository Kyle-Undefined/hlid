import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { HlidConfig } from "../config";
import { declaredPathKey } from "../lib/paths";
import { findAcpExecutable } from "./acpExecutable";
import { bumpDataRevision } from "./dataRevision";
import { type CachedList, createCachedList } from "./providerCatalog";
import { createSlowOperationObserver } from "./requestDiagnostics";

const ACP_REGISTRY_URL =
	"https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const ACP_AVAILABILITY_TTL_MS = 60_000;
const ACP_AVAILABILITY_PROBE_TIMEOUT_MS = 1_000;

async function boundedExecutableProbe<T>(
	probe: Promise<T | null | undefined>,
	timeoutMs: number,
): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		probe.then(
			(value) => value ?? null,
			() => null,
		),
		new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), timeoutMs);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

const InvocationSchema = z.object({
	cmd: z.string(),
	args: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	archive: z.string().url().optional(),
});

const RegistryAgentSchema = z.object({
	id: z.string(),
	name: z.string(),
	version: z.string(),
	description: z.string().default(""),
	repository: z.string().url().optional(),
	website: z.string().url().optional(),
	license: z.string().optional(),
	distribution: z.object({
		npx: z
			.object({
				package: z.string(),
				args: z.array(z.string()).optional(),
				env: z.record(z.string(), z.string()).optional(),
			})
			.optional(),
		uvx: z
			.object({
				package: z.string(),
				args: z.array(z.string()).optional(),
				env: z.record(z.string(), z.string()).optional(),
			})
			.optional(),
		binary: z.record(z.string(), InvocationSchema).optional(),
	}),
});

const RegistrySchema = z.object({
	version: z.string(),
	agents: z.array(RegistryAgentSchema),
});

export type AcpRegistryAgent = z.infer<typeof RegistryAgentSchema>;
export type AcpCatalogItem = AcpRegistryAgent & {
	providerId: string;
	enabled: boolean;
	available: boolean;
	resolvedExecutable?: string;
	unavailableReason?: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	installGuidance: string;
	/** Server-only evidence for the exact locally resolved runtime artifact. */
	runtimeExecutableEvidence?: AcpRuntimeExecutableEvidence;
};

export type AcpRuntimeExecutableFileEvidence = {
	pathKey: string;
	size: string;
	mtimeNs: string;
};

export type AcpRuntimeExecutableEvidence = {
	launcher: AcpRuntimeExecutableFileEvidence;
	/** Installed OpenCode package evidence when the launcher is a stable shim. */
	packageManifest?: AcpRuntimeExecutableFileEvidence;
};

async function executableFileEvidence(
	path: string,
): Promise<AcpRuntimeExecutableFileEvidence | null> {
	try {
		const canonicalPath = await realpath(path);
		const metadata = await stat(canonicalPath, { bigint: true });
		if (!metadata.isFile()) return null;
		return {
			pathKey: declaredPathKey(canonicalPath),
			size: metadata.size.toString(),
			mtimeNs: metadata.mtimeNs.toString(),
		};
	} catch {
		return null;
	}
}

function openCodeManifestCandidates(
	resolvedExecutable: string,
	launcherPathKey: string,
): string[] {
	const candidates = [
		join(
			dirname(resolvedExecutable),
			"node_modules",
			"opencode-ai",
			"package.json",
		),
	];
	const normalized = launcherPathKey.replaceAll("\\", "/");
	const packageRoot = normalized.match(
		/^(.*\/node_modules\/opencode-ai)(?:\/|$)/i,
	)?.[1];
	if (packageRoot?.startsWith("native:")) {
		candidates.unshift(
			join(packageRoot.slice("native:".length), "package.json"),
		);
	}
	return [...new Set(candidates)];
}

async function runtimeExecutableEvidence(
	agentId: string,
	resolvedExecutable: string,
): Promise<AcpRuntimeExecutableEvidence | undefined> {
	const launcher = await executableFileEvidence(resolvedExecutable);
	if (!launcher) return undefined;
	if (agentId !== "opencode") return { launcher };
	for (const candidate of openCodeManifestCandidates(
		resolvedExecutable,
		launcher.pathKey,
	)) {
		const packageManifest = await executableFileEvidence(candidate);
		if (packageManifest) return { launcher, packageManifest };
	}
	return { launcher };
}

const FALLBACK: z.infer<typeof RegistrySchema> = {
	version: "offline",
	agents: [
		{
			id: "opencode",
			name: "OpenCode",
			version: "unknown",
			description: "The open source coding agent",
			distribution: {
				binary: {
					"linux-x86_64": { cmd: "opencode", args: ["acp"] },
					"linux-aarch64": { cmd: "opencode", args: ["acp"] },
					"darwin-x86_64": { cmd: "opencode", args: ["acp"] },
					"darwin-aarch64": { cmd: "opencode", args: ["acp"] },
					"windows-x86_64": { cmd: "opencode.exe", args: ["acp"] },
				},
			},
		},
		{
			id: "pi-acp",
			name: "Pi ACP",
			version: "unknown",
			description: "ACP adapter for the Pi coding agent",
			distribution: { npx: { package: "pi-acp" } },
		},
	],
};

function platformTarget(
	platform: NodeJS.Platform = process.platform,
	architecture: NodeJS.Architecture = process.arch,
): string {
	const os = platform === "win32" ? "windows" : platform;
	const arch = architecture === "arm64" ? "aarch64" : "x86_64";
	return `${os}-${arch}`;
}

function inferredNpxCommand(packageName: string): string {
	const withoutVersion = packageName.replace(/@[^@/]+$/, "");
	return withoutVersion.split("/").at(-1) ?? withoutVersion;
}

function inferredUvxCommand(packageName: string): string {
	return packageName.split(/[=@]/)[0] ?? packageName;
}

export function resolveAcpInvocation(
	agent: AcpRegistryAgent,
	override?: NonNullable<HlidConfig["acp_agents"]>[number],
	runtime: {
		platform?: NodeJS.Platform;
		architecture?: NodeJS.Architecture;
	} = {},
): {
	command: string;
	args: string[];
	env: Record<string, string>;
	installGuidance: string;
} {
	const target = platformTarget(runtime.platform, runtime.architecture);
	const binary = agent.distribution.binary?.[target];
	const npx = agent.distribution.npx;
	const uvx = agent.distribution.uvx;
	const binaryFilename = binary ? basename(binary.cmd) : "";
	const registryCommand = binary
		? binaryFilename.replace(/\.exe$/i, "")
		: npx
			? inferredNpxCommand(npx.package)
			: uvx
				? inferredUvxCommand(uvx.package)
				: "";
	const command = override?.executable || registryCommand;
	const args = override?.args ?? binary?.args ?? npx?.args ?? uvx?.args ?? [];
	const env = {
		...(binary?.env ?? npx?.env ?? uvx?.env),
		...override?.env,
	};
	const installGuidance = npx
		? `bun add --global ${npx.package}`
		: uvx
			? `uv tool install ${uvx.package}`
			: binary?.archive
				? `Download and place ${binary.archive} on PATH as ${binaryFilename}`
				: `Install ${agent.name} for ${target} and place its ACP command on PATH`;
	return { command, args, env, installGuidance };
}

export class AcpRegistry {
	private readonly cache: CachedList<z.infer<typeof RegistrySchema>>;
	private readonly which: (
		command: string,
		options?: Parameters<typeof findAcpExecutable>[1],
	) => string | null | undefined | Promise<string | null | undefined>;
	private readonly now: () => number;
	private readonly availabilityTtlMs: number;
	private readonly availabilityProbeTimeoutMs: number;
	private readonly observeAvailability: ReturnType<
		typeof createSlowOperationObserver
	>;
	private materializedCatalog: {
		registryKey: string;
		configKey: string;
		value: AcpCatalogItem[];
		refreshedAt: number;
	} | null = null;

	constructor(
		fetcher: () => Promise<unknown> = async () => {
			const response = await fetch(ACP_REGISTRY_URL, {
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok)
				throw new Error(`ACP registry returned ${response.status}`);
			return response.json();
		},
		onChange?: () => void,
		options: {
			which?: (
				command: string,
				options?: Parameters<typeof findAcpExecutable>[1],
			) => string | null | undefined | Promise<string | null | undefined>;
			now?: () => number;
			availabilityTtlMs?: number;
			availabilityProbeTimeoutMs?: number;
		} = {},
	) {
		// Bun.which performs synchronous filesystem work. On a cold PATH that held
		// the server event loop for seconds while cataloging ACP agents. The default
		// resolver indexes PATH through asynchronous fs reads instead.
		this.which = options.which ?? findAcpExecutable;
		this.now = options.now ?? Date.now;
		this.availabilityTtlMs =
			options.availabilityTtlMs ?? ACP_AVAILABILITY_TTL_MS;
		this.availabilityProbeTimeoutMs =
			options.availabilityProbeTimeoutMs ?? ACP_AVAILABILITY_PROBE_TIMEOUT_MS;
		this.observeAvailability = createSlowOperationObserver({
			scope: "acp registry",
		});
		this.cache = createCachedList({
			persistKey: "acp_registry_catalog",
			ttlMs: 6 * 3600_000,
			fetcher: async () => RegistrySchema.parse(await fetcher()),
			fallback: FALLBACK,
			onChange: () => {
				this.materializedCatalog = null;
				bumpDataRevision("providers");
				onChange?.();
			},
			validate: (value): value is z.infer<typeof RegistrySchema> =>
				RegistrySchema.safeParse(value).success,
		});
	}

	async catalog(
		config: HlidConfig,
		refresh = false,
		refreshRuntimeEvidence = false,
	): Promise<AcpCatalogItem[]> {
		if (refresh || refreshRuntimeEvidence) this.materializedCatalog = null;
		const { value } = refresh
			? await this.cache.get(true)
			: await this.cache.getCached();
		if (!refresh) {
			// Navigation should never wait on the remote registry. Refresh the
			// server-owned snapshot once in the background; createCachedList keeps
			// concurrent tabs and PWAs on the same single flight.
			void this.cache.get().catch(() => {});
		}
		const registryKey = JSON.stringify(value);
		const configKey = JSON.stringify({
			agents: config.acp_agents ?? [],
			discoveryCwd: config.vault.path,
		});
		const materialized = this.materializedCatalog;
		if (
			materialized &&
			materialized.registryKey === registryKey &&
			materialized.configKey === configKey &&
			this.now() - materialized.refreshedAt < this.availabilityTtlMs
		) {
			return materialized.value;
		}
		const catalog = await this.observeAvailability(
			"availability",
			`availability scan for ${value.agents.length} agents`,
			async () => {
				const resolved = value.agents.map((agent) => {
					const override = (config.acp_agents ?? []).find(
						(item) => item.id === agent.id,
					);
					const invocation = resolveAcpInvocation(agent, override);
					return { agent, invocation, enabled: Boolean(override) };
				});
				const resolvedExecutables = await Promise.all(
					resolved.map(({ invocation }) =>
						invocation.command
							? boundedExecutableProbe(
									Promise.resolve(
										this.which(invocation.command, {
											cwd: config.vault.path || process.cwd(),
											env: { ...process.env, ...invocation.env },
										}),
									),
									this.availabilityProbeTimeoutMs,
								)
							: null,
					),
				);
				const runtimeEvidence = await Promise.all(
					resolvedExecutables.map((resolvedExecutable, index) =>
						resolvedExecutable
							? boundedExecutableProbe(
									runtimeExecutableEvidence(
										resolved[index]?.agent.id ?? "",
										resolvedExecutable,
									),
									this.availabilityProbeTimeoutMs,
								)
							: undefined,
					),
				);
				return resolved.map(({ agent, invocation, enabled }, index) => {
					const resolvedExecutable = resolvedExecutables[index] ?? undefined;
					const available = Boolean(resolvedExecutable);
					return {
						...agent,
						providerId: `acp:${agent.id}`,
						enabled,
						available,
						resolvedExecutable,
						runtimeExecutableEvidence: runtimeEvidence[index] ?? undefined,
						unavailableReason: available
							? undefined
							: invocation.command
								? `${invocation.command} is not installed`
								: `No distribution for ${platformTarget()}`,
						...invocation,
					};
				});
			},
		);
		catalog.sort((a, b) => {
			const featured = ["opencode", "pi-acp"];
			const ai = featured.indexOf(a.id);
			const bi = featured.indexOf(b.id);
			if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
			return a.name.localeCompare(b.name);
		});
		this.materializedCatalog = {
			registryKey,
			configKey,
			value: catalog,
			refreshedAt: this.now(),
		};
		return catalog;
	}
}
