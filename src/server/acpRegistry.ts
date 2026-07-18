import { basename } from "node:path";
import { z } from "zod";
import type { HlidConfig } from "../config";
import { bumpDataRevision } from "./dataRevision";
import { type CachedList, createCachedList } from "./providerCatalog";
import { createSlowOperationObserver } from "./requestDiagnostics";

const ACP_REGISTRY_URL =
	"https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const ACP_AVAILABILITY_TTL_MS = 60_000;

const InvocationSchema = z.object({
	cmd: z.string(),
	args: z.array(z.string()).optional(),
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
	unavailableReason?: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	installGuidance: string;
};

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

function platformTarget(): string {
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
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
): {
	command: string;
	args: string[];
	env: Record<string, string>;
	installGuidance: string;
} {
	const binary = agent.distribution.binary?.[platformTarget()];
	const npx = agent.distribution.npx;
	const uvx = agent.distribution.uvx;
	const registryCommand = binary
		? basename(binary.cmd).replace(
				/\.exe$/i,
				process.platform === "win32" ? ".exe" : "",
			)
		: npx
			? inferredNpxCommand(npx.package)
			: uvx
				? inferredUvxCommand(uvx.package)
				: "";
	const command = override?.executable || registryCommand;
	const args = override?.args ?? binary?.args ?? npx?.args ?? uvx?.args ?? [];
	const env = { ...(npx?.env ?? uvx?.env), ...override?.env };
	const installGuidance = npx
		? `bun add --global ${npx.package}`
		: uvx
			? `uv tool install ${uvx.package}`
			: binary?.archive
				? `Download and place ${binary.archive} on PATH as ${registryCommand}`
				: `Install ${agent.name} for ${platformTarget()} and place its ACP command on PATH`;
	return { command, args, env, installGuidance };
}

export class AcpRegistry {
	private readonly cache: CachedList<z.infer<typeof RegistrySchema>>;
	private readonly which: (command: string) => string | null | undefined;
	private readonly now: () => number;
	private readonly availabilityTtlMs: number;
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
			which?: (command: string) => string | null | undefined;
			now?: () => number;
			availabilityTtlMs?: number;
		} = {},
	) {
		this.which =
			options.which ??
			((command) => (typeof Bun === "undefined" ? null : Bun.which(command)));
		this.now = options.now ?? Date.now;
		this.availabilityTtlMs =
			options.availabilityTtlMs ?? ACP_AVAILABILITY_TTL_MS;
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
	): Promise<AcpCatalogItem[]> {
		if (refresh) this.materializedCatalog = null;
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
		const configKey = JSON.stringify(config.acp_agents ?? []);
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
			() =>
				value.agents.map((agent) => {
					const override = (config.acp_agents ?? []).find(
						(item) => item.id === agent.id,
					);
					const invocation = resolveAcpInvocation(agent, override);
					const available = Boolean(
						invocation.command && this.which(invocation.command),
					);
					return {
						...agent,
						providerId: `acp:${agent.id}`,
						enabled: Boolean(override),
						available,
						unavailableReason: available
							? undefined
							: invocation.command
								? `${invocation.command} is not installed`
								: `No distribution for ${platformTarget()}`,
						...invocation,
					};
				}),
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
