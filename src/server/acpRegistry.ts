import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { HlidConfig } from "../config";
import {
	type AcpExecutionTarget,
	acpExecutionTargetKey,
	acpExecutionTargetLabel,
	HOST_ACP_EXECUTION_TARGET,
} from "../lib/acpExecutionTarget";
import type {
	AcpManagedOperationSnapshot,
	AcpTargetStatus,
} from "../lib/acpManagedTypes";
import { declaredPathKey } from "../lib/paths";
import { findAcpExecutable } from "./acpExecutable";
import {
	type AcpExecutionAdapterFactory,
	createAcpExecutionAdapter,
} from "./acpExecutionAdapter";
import type { AcpTargetPlatformEvidenceStore } from "./acpPlatformEvidence";
import {
	type AcpExecutionTargetDescriptor,
	configuredAcpExecutionTargets,
} from "./acpTargets";
import { bumpDataRevision } from "./dataRevision";
import { type CachedList, createCachedList } from "./providerCatalog";
import { createSlowOperationObserver } from "./requestDiagnostics";

const ACP_REGISTRY_URL =
	"https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const ACP_AVAILABILITY_TTL_MS = 60_000;
const ACP_AVAILABILITY_PROBE_TIMEOUT_MS = 1_000;
const ACP_AVAILABILITY_SCAN_SLOW_MS = 1_000;
const ACP_PLATFORM_SUCCESS_TTL_MS = 6 * 3600_000;
const ACP_PLATFORM_FAILURE_TTL_MS = 5_000;

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

function managedMutationRevision(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const AcpRegistryInvocationSchema = z.object({
	cmd: z.string(),
	args: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	archive: z.string().url().optional(),
	sha256: z
		.string()
		.regex(/^[a-fA-F0-9]{64}$/)
		.optional(),
});

export const AcpRegistryAgentSchema = z.object({
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
		binary: z.record(z.string(), AcpRegistryInvocationSchema).optional(),
	}),
});

export const AcpRegistrySchema = z.object({
	version: z.string(),
	agents: z.array(AcpRegistryAgentSchema),
});

export type AcpRegistryAgent = z.infer<typeof AcpRegistryAgentSchema>;
export type AcpRegistrySnapshot = z.infer<typeof AcpRegistrySchema>;
export type AcpCatalogTargetStatus = AcpTargetStatus & {
	/** Server-only environment. `/acp/registry` removes it before serialization. */
	env: Record<string, string>;
};
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
	targets: AcpCatalogTargetStatus[];
	/** Server-only evidence for the exact locally resolved runtime artifact. */
	runtimeExecutableEvidence?: AcpRuntimeExecutableEvidence;
};

export type AcpCatalogOptions = {
	/** Materialize only these registry ids. Omitted means the complete Forge catalog. */
	agentIds?: Iterable<string>;
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

type AcpTargetPlatformSuccess = {
	platform: NodeJS.Platform;
	architecture: NodeJS.Architecture;
	platformTarget: string;
	/** Persisted architecture is known, but exact-target liveness is still pending. */
	verificationPending?: boolean;
	/** Latest exact-target liveness failure while retaining known architecture. */
	error?: string;
};

type AcpTargetPlatformFailure = {
	error: string;
	platformTarget: string;
};

type AcpTargetPlatform = AcpTargetPlatformSuccess | AcpTargetPlatformFailure;

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

export type AcpManagedCatalogSource = {
	claimedTargets?: () => Array<{
		agentId: string;
		target: AcpExecutionTarget;
		targetId: string;
		hostCwd: string;
	}>;
	managedRecord: (
		agentId: string,
		target: AcpExecutionTarget,
	) => {
		target: AcpExecutionTarget;
		command: string;
		args: string[];
		env: Record<string, string>;
		installedVersion: string;
		observedVersion?: string;
		usable: boolean;
		error?: string;
	} | null;
	resolveManagedInvocation: (
		agentId: string,
		target: AcpExecutionTarget,
	) => {
		target: AcpExecutionTarget;
		command: string;
		args: string[];
		env: Record<string, string>;
		installedVersion: string;
		observedVersion?: string;
	} | null;
	targetState: (
		agentId: string,
		target: AcpExecutionTarget,
	) => { operation?: AcpManagedOperationSnapshot; error?: string };
	installSupport: (
		agent: AcpRegistryAgent,
		target: AcpExecutionTarget,
		platformTarget: string,
	) => {
		supported: boolean;
		blockedReason?: string;
		updateAvailable?: boolean;
	};
};

const FALLBACK: AcpRegistrySnapshot = {
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

export function platformTarget(
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
	private readonly cache: CachedList<AcpRegistrySnapshot>;
	private readonly which: (
		command: string,
		options?: Parameters<typeof findAcpExecutable>[1],
	) => string | null | undefined | Promise<string | null | undefined>;
	private readonly now: () => number;
	private readonly availabilityTtlMs: number;
	private readonly availabilityProbeTimeoutMs: number;
	private readonly platformSuccessTtlMs: number;
	private readonly platformFailureTtlMs: number;
	private readonly platform: NodeJS.Platform;
	private readonly architecture: NodeJS.Architecture;
	private readonly adapterFactory: AcpExecutionAdapterFactory;
	private readonly platformEvidence: AcpTargetPlatformEvidenceStore | null;
	private managed: AcpManagedCatalogSource | null;
	private readonly observeAvailability: ReturnType<
		typeof createSlowOperationObserver
	>;
	private readonly observeFullAvailability: ReturnType<
		typeof createSlowOperationObserver
	>;
	private readonly observePlatform: ReturnType<
		typeof createSlowOperationObserver
	>;
	private readonly onPlatformChange: (() => void) | undefined;
	private readonly materializedCatalogs = new Map<
		string,
		{
			registryKey: string;
			configKey: string;
			value: AcpCatalogItem[];
			refreshedAt: number;
		}
	>();
	private readonly materializedCatalogInflight = new Map<
		string,
		Promise<AcpCatalogItem[]>
	>();
	private materializationGeneration = 0;
	private readonly targetPlatformCache = new Map<
		string,
		{
			value?: AcpTargetPlatform;
			lastGood?: AcpTargetPlatformSuccess;
			expiresAt: number;
			generation: number;
			inflight?: Promise<AcpTargetPlatform>;
		}
	>();
	private readonly targetPlatformHydrations = new Map<string, Promise<void>>();

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
			platformSuccessTtlMs?: number;
			platformFailureTtlMs?: number;
			platform?: NodeJS.Platform;
			architecture?: NodeJS.Architecture;
			adapterFactory?: AcpExecutionAdapterFactory;
			platformEvidence?: AcpTargetPlatformEvidenceStore | null;
			onPlatformChange?: () => void;
			managed?: AcpManagedCatalogSource;
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
		this.platformSuccessTtlMs =
			options.platformSuccessTtlMs ?? ACP_PLATFORM_SUCCESS_TTL_MS;
		this.platformFailureTtlMs =
			options.platformFailureTtlMs ?? ACP_PLATFORM_FAILURE_TTL_MS;
		this.platform = options.platform ?? process.platform;
		this.architecture = options.architecture ?? process.arch;
		this.adapterFactory = options.adapterFactory ?? createAcpExecutionAdapter;
		this.platformEvidence = options.platformEvidence ?? null;
		this.onPlatformChange = options.onPlatformChange;
		this.managed = options.managed ?? null;
		this.observeAvailability = createSlowOperationObserver({
			scope: "acp registry",
		});
		this.observeFullAvailability = createSlowOperationObserver({
			scope: "acp registry",
			thresholdMs: ACP_AVAILABILITY_SCAN_SLOW_MS,
		});
		this.observePlatform = createSlowOperationObserver({
			scope: "acp registry platform",
		});
		this.cache = createCachedList({
			persistKey: "acp_registry_catalog",
			ttlMs: 6 * 3600_000,
			fetcher: async () => AcpRegistrySchema.parse(await fetcher()),
			fallback: FALLBACK,
			onChange: () => {
				this.invalidateAvailability();
				bumpDataRevision("providers");
				onChange?.();
			},
			validate: (value): value is AcpRegistrySnapshot =>
				AcpRegistrySchema.safeParse(value).success,
		});
	}

	attachManagedCatalog(source: AcpManagedCatalogSource): void {
		this.managed = source;
		this.invalidateAvailability();
	}

	invalidateAvailability(): void {
		this.materializationGeneration += 1;
		this.materializedCatalogs.clear();
		this.materializedCatalogInflight.clear();
	}

	private publishPlatformChange(): void {
		this.invalidateAvailability();
		bumpDataRevision("providers");
		try {
			this.onPlatformChange?.();
		} catch {
			// Platform evidence still remains authoritative when a consumer cannot
			// schedule its optional runtime reconciliation.
		}
	}

	async snapshot(refresh = false): Promise<AcpRegistrySnapshot> {
		const { value } = refresh
			? await this.cache.get(true)
			: await this.cache.getCached();
		if (!refresh) void this.cache.get().catch(() => {});
		return value;
	}

	private withLiveManagedState(catalog: AcpCatalogItem[]): AcpCatalogItem[] {
		if (!this.managed) return catalog;
		return catalog.flatMap((item) => {
			const targets = item.targets.flatMap((target) => {
				const state = this.managed?.targetState(item.id, target.target);
				if (!target.cleanupOnly) {
					return [
						{ ...target, operation: state?.operation, error: state?.error },
					];
				}
				const record = this.managed?.managedRecord(item.id, target.target);
				if (!record && !state?.operation) return [];
				return [
					{
						...target,
						canRemove: Boolean(record),
						installedVersion: record?.installedVersion,
						observedVersion: record?.observedVersion,
						operation: state?.operation,
						error: state?.error,
					},
				];
			});
			return targets.length > 0 ? [{ ...item, targets }] : [];
		});
	}

	private cleanupTarget(
		agent: AcpRegistryAgent | undefined,
		claim: {
			agentId: string;
			target: AcpExecutionTarget;
			targetId: string;
			hostCwd: string;
		},
	): AcpCatalogTargetStatus | null {
		if (!this.managed) return null;
		const record = this.managed.managedRecord(claim.agentId, claim.target);
		const state = this.managed.targetState(claim.agentId, claim.target);
		if (!record && !state.operation) return null;
		const registryVersion =
			agent?.version ?? record?.installedVersion ?? "managed";
		const blockedReason = agent
			? claim.target.kind === "wsl"
				? "The workspace for this managed WSL installation is no longer configured. Remove Hlid's managed files here when they are no longer needed."
				: "This managed Windows installation is retained only for cleanup. Remove Hlid's managed files here when they are no longer needed."
			: "This managed agent is no longer listed in the ACP registry. Remove Hlid's managed files here when they are no longer needed.";
		const canRemove = Boolean(record);
		return {
			targetId: claim.targetId,
			target: claim.target,
			label: acpExecutionTargetLabel(claim.target),
			recommended: false,
			selected: false,
			platformTarget:
				claim.target.kind === "host"
					? platformTarget(this.platform, this.architecture)
					: "linux-unknown",
			provenance: "managed",
			available: false,
			canEnable: false,
			canInstall: false,
			canUpdate: false,
			canRemove,
			cleanupOnly: true,
			registryVersion,
			mutationRevision: managedMutationRevision({
				schemaVersion: 1,
				cleanupOnly: true,
				claim,
				record,
				canRemove,
			}),
			installedVersion: record?.installedVersion,
			observedVersion: record?.observedVersion,
			command: record?.command ?? "",
			args: record?.args ?? [],
			env: record?.env ?? {},
			installGuidance: blockedReason,
			blockedReason,
			operation: state.operation,
			error: state.error,
		};
	}

	private targetPlatform(
		descriptor: AcpExecutionTargetDescriptor,
		adapter: ReturnType<AcpExecutionAdapterFactory>,
		force: boolean,
	): Promise<AcpTargetPlatform> {
		const key = acpExecutionTargetKey(descriptor.target);
		const cached = this.targetPlatformCache.get(key);
		const now = this.now();
		if (cached?.inflight) {
			return cached.lastGood
				? Promise.resolve(cached.value ?? cached.lastGood)
				: cached.inflight;
		}
		if (!force && cached?.value && cached.expiresAt > now) {
			return Promise.resolve(cached.value);
		}

		const generation = (cached?.generation ?? 0) + 1;
		const lastGood = cached?.lastGood;
		const pending = this.observePlatform(
			`platform:${key}`,
			`platform discovery for ${descriptor.label}`,
			() =>
				adapter.registryPlatform({
					timeoutMs: Math.max(this.availabilityProbeTimeoutMs, 2_500),
				}),
		).then<AcpTargetPlatform, AcpTargetPlatform>(
			(runtime) => {
				const success: AcpTargetPlatformSuccess = {
					...runtime,
					platformTarget: platformTarget(
						runtime.platform,
						runtime.architecture,
					),
				};
				if (this.targetPlatformCache.get(key)?.generation === generation) {
					const changed =
						cached?.value?.error !== undefined ||
						(cached?.value !== undefined &&
							"verificationPending" in cached.value &&
							cached.value.verificationPending === true) ||
						(lastGood !== undefined &&
							(lastGood.platform !== success.platform ||
								lastGood.architecture !== success.architecture));
					this.targetPlatformCache.set(key, {
						value: success,
						lastGood: success,
						expiresAt: this.now() + this.platformSuccessTtlMs,
						generation,
					});
					if (
						runtime.platform === "linux" &&
						(runtime.architecture === "x64" || runtime.architecture === "arm64")
					) {
						const evidenceStore = this.platformEvidence;
						const evidencePlatform = runtime.platform;
						const evidenceArchitecture = runtime.architecture;
						void Promise.resolve()
							.then(() =>
								evidenceStore?.save({
									targetKey: key,
									targetId: descriptor.targetId,
									platform: evidencePlatform,
									architecture: evidenceArchitecture,
									observedAt: this.now(),
								}),
							)
							.catch(() => {
								// Persistence is only a startup optimization. Live platform
								// evidence remains authoritative when storage is unavailable.
							});
					}
					if (changed) this.publishPlatformChange();
				}
				return success;
			},
			(error) => {
				const failure: AcpTargetPlatformFailure = {
					error:
						error instanceof Error
							? error.message
							: "WSL target is unavailable",
					platformTarget: "linux-unknown",
				};
				// A transient WSL startup timeout must not erase a target the user has
				// already proved works. Keep last-good evidence authoritative and retry
				// after the short failure TTL. Real harness launches still fail normally
				// when the distro is genuinely unavailable.
				const value = lastGood ?? failure;
				if (this.targetPlatformCache.get(key)?.generation === generation) {
					this.targetPlatformCache.set(key, {
						value,
						lastGood,
						expiresAt: this.now() + this.platformFailureTtlMs,
						generation,
					});
				}
				return value;
			},
		);
		this.targetPlatformCache.set(key, {
			value: cached?.value,
			lastGood,
			expiresAt: 0,
			generation,
			inflight: pending,
		});
		// A previously observed architecture is stable for this exact target. A
		// forced refresh may verify it in the background, but registry rendering
		// should never block on a WSL startup timeout once last-good evidence exists.
		return lastGood ? Promise.resolve(cached?.value ?? lastGood) : pending;
	}

	private hydrateTargetPlatform(
		descriptor: AcpExecutionTargetDescriptor,
	): Promise<void> {
		const key = acpExecutionTargetKey(descriptor.target);
		if (this.targetPlatformCache.has(key) || !this.platformEvidence)
			return Promise.resolve();
		const existing = this.targetPlatformHydrations.get(key);
		if (existing) return existing;
		const evidenceStore = this.platformEvidence;
		const pending = Promise.resolve()
			.then(() =>
				evidenceStore.load({
					targetKey: key,
					targetId: descriptor.targetId,
					now: this.now(),
				}),
			)
			.then((evidence) => {
				if (!evidence || this.targetPlatformCache.has(key)) return;
				const lastGood: AcpTargetPlatformSuccess = {
					platform: evidence.platform,
					architecture: evidence.architecture,
					platformTarget: platformTarget(
						evidence.platform,
						evidence.architecture,
					),
				};
				this.targetPlatformCache.set(key, {
					value: lastGood,
					lastGood,
					// Persisted evidence supplies stable architecture. The single registry
					// availability batch below supplies current distro liveness without
					// launching a second WSL process during every Hlid restart.
					expiresAt: this.now() + this.platformSuccessTtlMs,
					generation: 0,
				});
			})
			.catch(() => {
				// A missing or inaccessible optimization must not block the catalog.
			});
		this.targetPlatformHydrations.set(key, pending);
		return pending;
	}

	private async targetPlatforms(
		descriptors: AcpExecutionTargetDescriptor[],
		adapters: Map<string, ReturnType<AcpExecutionAdapterFactory>>,
		force: boolean,
	): Promise<Map<string, AcpTargetPlatform>> {
		const entries: Array<readonly [string, AcpTargetPlatform]> =
			await Promise.all(
				descriptors.map(async (descriptor) => {
					if (descriptor.target.kind === "host") {
						return [
							descriptor.targetId,
							{
								platform: this.platform,
								architecture: this.architecture,
								platformTarget: platformTarget(
									this.platform,
									this.architecture,
								),
							},
						] as const;
					}
					try {
						const adapter = adapters.get(descriptor.targetId);
						if (!adapter)
							throw new Error("ACP execution target is unavailable");
						await this.hydrateTargetPlatform(descriptor);
						return [
							descriptor.targetId,
							await this.targetPlatform(descriptor, adapter, force),
						] as const;
					} catch (error) {
						return [
							descriptor.targetId,
							{
								error:
									error instanceof Error
										? error.message
										: "WSL target is unavailable",
								platformTarget: "linux-unknown",
							},
						] as const;
					}
				}),
			);
		return new Map(entries);
	}

	async catalog(
		config: HlidConfig,
		refresh = false,
		refreshRuntimeEvidence = false,
		options: AcpCatalogOptions = {},
	): Promise<AcpCatalogItem[]> {
		if (refresh || refreshRuntimeEvidence) this.invalidateAvailability();
		const value = await this.snapshot(refresh);
		const scopedAgentIds = options.agentIds ? new Set(options.agentIds) : null;
		const scopeKey = scopedAgentIds
			? JSON.stringify([...scopedAgentIds].sort((a, b) => a.localeCompare(b)))
			: "*";
		const registryAgents = scopedAgentIds
			? value.agents.filter((agent) => scopedAgentIds.has(agent.id))
			: value.agents;
		const registryKey = JSON.stringify(value);
		const managedClaims = Array.from(
			new Map(
				(this.managed?.claimedTargets?.() ?? [])
					.filter(
						(claim) => !scopedAgentIds || scopedAgentIds.has(claim.agentId),
					)
					.map((claim) => [
						`${claim.agentId}\0${acpExecutionTargetKey(claim.target)}`,
						claim,
					]),
			).values(),
		);
		const configKey = JSON.stringify({
			agents: config.acp_agents ?? [],
			discoveryCwd: config.vault.path,
			workspacePaths: config.agents.map((agent) => agent.path),
			managedClaims,
		});
		const materialized = this.materializedCatalogs.get(scopeKey);
		if (
			materialized &&
			materialized.registryKey === registryKey &&
			materialized.configKey === configKey &&
			this.now() - materialized.refreshedAt < this.availabilityTtlMs
		) {
			return this.withLiveManagedState(materialized.value);
		}
		if (registryAgents.length === 0 && managedClaims.length === 0) {
			// Exact-id routes accept bounded user input. Do not retain a distinct
			// cache entry for every unknown id; the registry snapshot itself remains
			// cached, and an empty scope needs no execution-target work.
			return [];
		}
		const generation = this.materializationGeneration;
		const materializationIdentity = createHash("sha256")
			.update(`${registryKey}\0${configKey}`)
			.digest("hex");
		const materializationKey = `${generation}\0${scopeKey}\0${materializationIdentity}`;
		const inflight = this.materializedCatalogInflight.get(materializationKey);
		if (inflight) {
			return this.withLiveManagedState(await inflight);
		}

		const pending = (async (): Promise<AcpCatalogItem[]> => {
			const descriptors = configuredAcpExecutionTargets(config, this.platform);
			const adapters = new Map(
				descriptors.map((descriptor) => [
					descriptor.targetId,
					this.adapterFactory(descriptor.target),
				]),
			);
			const platforms = await this.targetPlatforms(
				descriptors,
				adapters,
				refreshRuntimeEvidence,
			);
			const planKey = (agentId: string, targetId: string) =>
				`${agentId}\0${targetId}`;
			const createTargetPlan = (
				agent: AcpRegistryAgent,
				descriptor: AcpExecutionTargetDescriptor,
			) => {
				const override = (config.acp_agents ?? []).find(
					(item) => item.id === agent.id,
				);
				const selected =
					Boolean(override) &&
					acpExecutionTargetKey(descriptor.target) ===
						acpExecutionTargetKey(override?.target);
				const runtime = platforms.get(descriptor.targetId);
				const runtimeError =
					runtime?.error ??
					(runtime &&
					"verificationPending" in runtime &&
					runtime.verificationPending
						? `Verifying ${descriptor.label} availability`
						: undefined);
				const runtimePlatform =
					runtime && "platform" in runtime
						? {
								platform: runtime.platform,
								architecture: runtime.architecture,
							}
						: {
								platform:
									descriptor.target.kind === "wsl"
										? ("linux" as const)
										: this.platform,
								architecture: this.architecture,
							};
				const platformKey =
					runtime?.platformTarget ??
					platformTarget(
						runtimePlatform.platform,
						runtimePlatform.architecture,
					);
				const targetOverride = selected ? override : undefined;
				const registryInvocation = resolveAcpInvocation(
					agent,
					targetOverride,
					runtimePlatform,
				);
				const managedRecord =
					this.managed?.managedRecord(agent.id, descriptor.target) ?? null;
				const managedInvocation = managedRecord?.usable
					? (this.managed?.resolveManagedInvocation(
							agent.id,
							descriptor.target,
						) ?? null)
					: null;
				const invocation = managedRecord
					? {
							command: managedRecord.command,
							args: targetOverride?.args ?? managedRecord.args,
							env: { ...managedRecord.env, ...targetOverride?.env },
							installGuidance: registryInvocation.installGuidance,
						}
					: registryInvocation;
				// A usable managed record has already passed Hlid's contained-file,
				// receipt, and exact target-path validation. Do not make that owned
				// installation depend on a second fallible PATH/WSL subprocess probe.
				// Exact WSL liveness remains gated by the platform probe above.
				const validatedManagedExecutable =
					!runtimeError && managedRecord?.usable && managedInvocation
						? managedInvocation.command
						: undefined;
				return {
					selected,
					runtimeError,
					platformKey,
					targetOverride,
					managedRecord,
					invocation,
					validatedManagedExecutable,
					probeEligible:
						selected &&
						!validatedManagedExecutable &&
						!runtimeError &&
						Boolean(invocation.command) &&
						(!managedRecord || Boolean(managedInvocation)),
				};
			};
			type TargetPlan = ReturnType<typeof createTargetPlan>;
			const targetPlans = new Map<string, TargetPlan>();
			for (const agent of registryAgents) {
				for (const descriptor of descriptors) {
					targetPlans.set(
						planKey(agent.id, descriptor.targetId),
						createTargetPlan(agent, descriptor),
					);
				}
			}
			const observeAvailability = scopedAgentIds
				? this.observeAvailability
				: this.observeFullAvailability;
			const catalog = await observeAvailability(
				"availability",
				`availability scan for configured ACP agents`,
				async () => {
					const resolvedExecutables = new Map<string, string | null>();
					const configuredProbes: Promise<void>[] = [];
					for (const agent of registryAgents) {
						for (const descriptor of descriptors) {
							const key = planKey(agent.id, descriptor.targetId);
							const plan = targetPlans.get(key);
							const adapter = adapters.get(descriptor.targetId);
							if (!plan?.probeEligible || !adapter) continue;
							const environment = { ...process.env, ...plan.invocation.env };
							const forwardedEnvNames = Object.keys(plan.invocation.env).sort(
								(a, b) => a.localeCompare(b),
							);
							configuredProbes.push(
								(async () => {
									const resolved = await boundedExecutableProbe(
										Promise.resolve().then(() =>
											descriptor.target.kind === "host"
												? this.which(plan.invocation.command, {
														cwd: descriptor.cwd,
														env: environment,
													})
												: adapter.resolveExecutable(plan.invocation.command, {
														hostCwd: descriptor.cwd,
														env: environment,
														forwardedEnvNames,
														timeoutMs: this.availabilityProbeTimeoutMs,
													}),
										),
										this.availabilityProbeTimeoutMs,
									);
									resolvedExecutables.set(key, resolved);
								})(),
							);
						}
					}
					await Promise.all(configuredProbes);
					const items = await Promise.all(
						registryAgents.map(async (agent): Promise<AcpCatalogItem> => {
							const override = (config.acp_agents ?? []).find(
								(item) => item.id === agent.id,
							);
							const targetStatuses = await Promise.all(
								descriptors.map(
									async (descriptor): Promise<AcpCatalogTargetStatus> => {
										const plan = targetPlans.get(
											planKey(agent.id, descriptor.targetId),
										);
										if (!plan)
											throw new Error("ACP target plan is unavailable");
										const {
											selected,
											runtimeError,
											platformKey,
											targetOverride,
											managedRecord,
											invocation,
										} = plan;
										const resolvedExecutable =
											resolvedExecutables.get(
												planKey(agent.id, descriptor.targetId),
											) ??
											plan.validatedManagedExecutable ??
											null;
										const available = Boolean(resolvedExecutable);
										const provenance = managedRecord
											? "managed"
											: available
												? "external"
												: "missing";
										const support = this.managed?.installSupport(
											agent,
											descriptor.target,
											platformKey,
										) ?? {
											supported: false,
											blockedReason: "Managed ACP installation is unavailable",
										};
										const canInstall =
											!runtimeError &&
											!targetOverride?.executable &&
											provenance === "missing" &&
											support.supported;
										const canUpdate =
											!runtimeError &&
											!targetOverride?.executable &&
											provenance === "managed" &&
											support.supported &&
											support.updateAvailable === true;
										const canRemove = provenance === "managed";
										const mutationRevision = managedMutationRevision({
											schemaVersion: 1,
											agentId: agent.id,
											registryVersion: agent.version,
											distribution: agent.distribution,
											targetDescriptor: {
												targetId: descriptor.targetId,
												target: descriptor.target,
												cwd: descriptor.cwd,
											},
											platformTarget: platformKey,
											provenance,
											available,
											resolvedExecutable,
											managedRecord,
											canInstall,
											canUpdate,
											canRemove,
										});
										return {
											targetId: descriptor.targetId,
											target: descriptor.target,
											label: descriptor.label,
											recommended: descriptor.recommended,
											selected,
											platformTarget: platformKey,
											provenance,
											available,
											canEnable: available,
											canInstall,
											canUpdate,
											canRemove,
											registryVersion: agent.version,
											mutationRevision,
											installedVersion: managedRecord?.installedVersion,
											observedVersion: managedRecord?.observedVersion,
											resolvedExecutable: resolvedExecutable ?? undefined,
											command: invocation.command,
											args: invocation.args,
											env: invocation.env,
											installGuidance: invocation.installGuidance,
											blockedReason:
												runtimeError ??
												managedRecord?.error ??
												(targetOverride?.executable && managedRecord
													? "Remove this Hlid-managed installation before switching to a custom executable"
													: undefined) ??
												(provenance === "missing" && !support.supported
													? support.blockedReason
													: undefined),
										};
									},
								),
							);
							const configuredTargetIds = new Set(
								descriptors.map((descriptor) => descriptor.targetId),
							);
							for (const claim of managedClaims) {
								if (
									claim.agentId !== agent.id ||
									configuredTargetIds.has(claim.targetId)
								) {
									continue;
								}
								const cleanup = this.cleanupTarget(agent, claim);
								if (cleanup) targetStatuses.push(cleanup);
							}
							const selected =
								targetStatuses.find((target) => target.selected) ??
								targetStatuses.find(
									(target) =>
										acpExecutionTargetKey(target.target) ===
										acpExecutionTargetKey(HOST_ACP_EXECUTION_TARGET),
								) ??
								targetStatuses[0];
							if (!selected)
								throw new Error("ACP catalog has no execution target");
							const selectedRuntimeEvidence =
								selected.target.kind === "host" && selected.resolvedExecutable
									? await boundedExecutableProbe(
											runtimeExecutableEvidence(
												agent.id,
												selected.resolvedExecutable,
											),
											this.availabilityProbeTimeoutMs,
										)
									: undefined;
							return {
								...agent,
								providerId: `acp:${agent.id}`,
								enabled: Boolean(override),
								available: selected.available,
								resolvedExecutable: selected.resolvedExecutable,
								runtimeExecutableEvidence: selectedRuntimeEvidence ?? undefined,
								unavailableReason: selected.available
									? undefined
									: (selected.blockedReason ??
										(selected.command
											? `${selected.command} is not installed in ${selected.label}`
											: `No distribution for ${selected.platformTarget}`)),
								command: selected.command,
								args: selected.args,
								env: selected.env,
								installGuidance: selected.installGuidance,
								targets: targetStatuses,
							};
						}),
					);
					const registryAgentIds = new Set(
						registryAgents.map((agent) => agent.id),
					);
					const missingAgentClaims = new Map<string, typeof managedClaims>();
					for (const claim of managedClaims) {
						if (registryAgentIds.has(claim.agentId)) continue;
						const claims = missingAgentClaims.get(claim.agentId) ?? [];
						claims.push(claim);
						missingAgentClaims.set(claim.agentId, claims);
					}
					for (const [agentId, claims] of missingAgentClaims) {
						const targets = claims.flatMap((claim) => {
							const target = this.cleanupTarget(undefined, claim);
							return target ? [target] : [];
						});
						const target = targets[0];
						if (!target) continue;
						items.push({
							id: agentId,
							name: agentId,
							version: target.registryVersion,
							description:
								"Hlid-managed ACP installation retained for cleanup.",
							distribution: {},
							providerId: `acp:${agentId}`,
							enabled: false,
							available: false,
							unavailableReason: target.blockedReason,
							command: target.command,
							args: target.args,
							env: target.env,
							installGuidance: target.installGuidance,
							targets,
						});
					}
					return items;
				},
			);
			catalog.sort((a, b) => {
				const featured = ["opencode", "pi-acp"];
				const ai = featured.indexOf(a.id);
				const bi = featured.indexOf(b.id);
				if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
				return a.name.localeCompare(b.name);
			});
			return catalog;
		})();
		this.materializedCatalogInflight.set(materializationKey, pending);
		try {
			const catalog = await pending;
			if (this.materializationGeneration === generation) {
				this.materializedCatalogs.set(scopeKey, {
					registryKey,
					configKey,
					value: catalog,
					refreshedAt: this.now(),
				});
			}
			return this.withLiveManagedState(catalog);
		} finally {
			if (
				this.materializedCatalogInflight.get(materializationKey) === pending
			) {
				this.materializedCatalogInflight.delete(materializationKey);
			}
		}
	}
}
