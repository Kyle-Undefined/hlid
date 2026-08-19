import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "bun";
import type { HlidConfig } from "#/config";
import {
	type AcpExecutionTarget,
	acpExecutionTargetKey,
} from "#/lib/acpExecutionTarget";
import {
	OLLAMA_INFERENCE_RELAY_PORT,
	type OllamaKeepWarmPolicy,
	OPENCODE_LOCAL_MODEL_MIN_CONTEXT,
	OPENCODE_LOCAL_MODEL_OUTPUT_LIMIT,
	ollamaKeepAliveValue,
} from "#/lib/ollama";
import { parseWslUncSyntax } from "#/lib/paths";
import type { AcpWorkspaceEnvironmentResolver } from "./acpRuntime";
import {
	HLID_OLLAMA_RELAY_TOKEN_ENV,
	withOpenCodeOllamaProvider,
} from "./acpRuntime";
import {
	createOllamaInferenceRelay,
	OLLAMA_INFERENCE_MAX_REQUEST_BYTES,
	type OllamaInferenceLease,
	OllamaInferenceLeaseRegistry,
	type OllamaInferenceUpstreamFetch,
	type OllamaLocalModelValidation,
} from "./ollamaInferenceRelay";
import { serveOllamaInferenceRelay } from "./ollamaInferenceRelayServer";
import {
	OllamaClientError,
	type OllamaClientErrorCode,
	type OllamaLoadedModel,
	type OllamaLocalModel,
	OllamaManager,
	type OllamaModelDetails,
	type OllamaPullProgress,
	type OllamaStatus,
} from "./ollamaManager";
import {
	getOllamaWindowsFirewallStatus,
	installOllamaWindowsFirewallRule,
	type OllamaWindowsFirewallStatus,
	removeOllamaWindowsFirewallRule,
} from "./ollamaWindowsFirewall";
import {
	type OllamaWindowsSetupController,
	OllamaWindowsSetupManager,
	type OllamaWindowsSetupState,
} from "./ollamaWindowsSetup";
import {
	isCanonicalIpv4Address,
	type OllamaWslNetworkReadiness,
	resolveOllamaWslNetwork,
} from "./ollamaWslNetwork";

const OLLAMA_RELAY_LEASE_MS = 15 * 60_000;
const OLLAMA_RELAY_RENEWAL_INTERVAL_MS = 5 * 60_000;
const OLLAMA_WSL_RELAY_PROBE_TIMEOUT_MS = 7_000;
const OLLAMA_WSL_RELAY_PROBE_MAX_OUTPUT_CHARS = 4_096;
const OLLAMA_INVENTORY_DETAILS_CONCURRENCY = 4;
const OLLAMA_INVENTORY_INSPECTION_BUDGET_MS = 750;
const OLLAMA_INVENTORY_INSPECTIONS_PER_REFRESH = 64;
const OLLAMA_INVENTORY_INSPECTION_COOLDOWN_MS = 30_000;
const OLLAMA_INVENTORY_INSPECTION_CACHE_LIMIT = 512;
const OLLAMA_OPEN_CODE_VARIANT_PREFIX = "hlid-opencode/";
const OLLAMA_OPEN_CODE_VARIANT_PATTERN = new RegExp(
	`^hlid-opencode/[a-f0-9]{64}:ctx${OPENCODE_LOCAL_MODEL_MIN_CONTEXT}$`,
);
const OLLAMA_MANAGED_VARIANT_CLEANUP_LIMIT = 256;

function relayAddressInUse(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = (error as { code?: unknown }).code;
	if (code === "EADDRINUSE") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /(?:address|port).*(?:already )?in use/i.test(message);
}

function resolvedRelayPort(server: RelayServer): number {
	const port = server.port;
	if (
		typeof port !== "number" ||
		!Number.isSafeInteger(port) ||
		port < 1 ||
		port > 65_535
	) {
		throw new Error("Hlid's Ollama relay did not receive a usable TCP port.");
	}
	return port;
}

export type OllamaPullState =
	| { state: "idle" }
	| {
			state: "running" | "canceling";
			model: string;
			startedAt: number;
			progress?: OllamaPullProgress;
	  }
	| {
			state: "complete";
			model: string;
			startedAt: number;
			completedAt: number;
	  }
	| {
			state: "canceled" | "failed";
			model: string;
			startedAt: number;
			completedAt: number;
			reason?: string;
	  };

export type OllamaCompatibilityInspection =
	| { status: "verified"; checkedAt: number }
	| {
			status: "unknown";
			reason: "inspection-failed" | "not-inspected";
	  };

export type OllamaInventoryModel = OllamaLocalModel & {
	compatibilityInspection: OllamaCompatibilityInspection;
};

export type OllamaIntegrationInfo = {
	supported: boolean;
	host: "windows";
	status: OllamaStatus;
	setup: OllamaWindowsSetupState;
	models: OllamaInventoryModel[];
	loadedModels: OllamaLoadedModel[];
	preparedModels: OllamaLoadedModel[];
	selectedModels: string[];
	pull: OllamaPullState;
	firewall: OllamaWindowsFirewallStatus;
	wsl: OllamaWslNetworkReadiness[];
	relay: {
		port: number;
		listeners: Array<{ address: string; port: number }>;
	};
};

export type OllamaWindowsSetupInfo = {
	status: OllamaStatus;
	setup: OllamaWindowsSetupState;
};

type RelayServer = Pick<Server<unknown>, "port" | "stop">;
type RelayServerFactory = (options: {
	hostname: string;
	port: number;
	maxRequestBodySize: number;
	fetch: (request: Request) => Promise<Response>;
}) => RelayServer;

export type OllamaIntegrationOptions = {
	manager?: OllamaManager;
	setup?: OllamaWindowsSetupController;
	platform?: NodeJS.Platform;
	now?: () => number;
	inventoryInspectionBudgetMs?: number;
	onOpenCodeRuntimeInvalidated?: () => Promise<void> | void;
	getWindowsFirewallStatus?: typeof getOllamaWindowsFirewallStatus;
	removeWindowsFirewallRule?: typeof removeOllamaWindowsFirewallRule;
	resolveWslNetwork?: typeof resolveOllamaWslNetwork;
	probeWslRelay?: OllamaWslRelayProbe;
	serve?: RelayServerFactory;
	upstreamFetch?: OllamaInferenceUpstreamFetch;
};

type ActiveLease = {
	id: string;
	profileId: string;
	targetId: string;
	processId: string;
	relayAddress: string;
	modelDigests: ReadonlyMap<string, string>;
	selectedModelDigests: ReadonlyMap<string, string>;
	keepWarm: OllamaKeepWarmPolicy;
	inferenceVariants: Map<
		string,
		{ baseDigest: string; digest: string; model: string }
	>;
	renewalTimer: ReturnType<typeof setInterval>;
};

type LocalModelValidationInput = {
	lease: OllamaInferenceLease;
	models: readonly string[];
	route: "models" | "chat";
	signal: AbortSignal;
};

type InferenceLaneWaiter = {
	signal: AbortSignal;
	onAbort: () => void;
	resolve: (release: () => void) => void;
	reject: (reason: unknown) => void;
};

type InventoryInspectionCacheEntry =
	| {
			status: "verified";
			checkedAt: number;
			details: OllamaModelDetails;
	  }
	| {
			status: "unknown";
			reason: "inspection-failed";
			retryAfter: number;
	  };

export type OllamaWslRelayProbe = (input: {
	distro: string;
	url: string;
	token: string;
	signal?: AbortSignal;
}) => Promise<void>;

export type OllamaWslRelayProbeDependencies = {
	spawnProcess?: OllamaWslRelayProbeSpawner;
	timeoutMs?: number;
};

export type OllamaWslRelayProbeSpawner = (
	executable: string,
	args: string[],
	options: {
		stdio: ["pipe", "pipe", "pipe"];
		windowsHide: true;
		shell: false;
	},
) => ChildProcessWithoutNullStreams;

function unavailableStatus(reason: OllamaClientErrorCode): OllamaStatus {
	return {
		available: false,
		checkedAt: Date.now(),
		reason,
		version: null,
	};
}

function inventoryInspectionBudget(value: number | undefined): number {
	const budget = value ?? OLLAMA_INVENTORY_INSPECTION_BUDGET_MS;
	if (
		!Number.isSafeInteger(budget) ||
		budget <= 0 ||
		budget > OLLAMA_INVENTORY_INSPECTION_BUDGET_MS
	) {
		throw new Error(
			`Ollama inventory inspection budget must be between 1 and ${OLLAMA_INVENTORY_INSPECTION_BUDGET_MS} milliseconds`,
		);
	}
	return budget;
}

function selectedOllamaModels(config: HlidConfig): string[] {
	return config.ollama?.models ?? [];
}

function configuredWslDistros(config: HlidConfig): string[] {
	const distros = new Map<string, string>();
	for (const path of [
		config.vault.path,
		...config.agents.map((agent) => agent.path),
	]) {
		const distro = parseWslUncSyntax(path)?.distro;
		if (distro) distros.set(distro.toLowerCase(), distro);
	}
	return [...distros.values()].sort((a, b) => a.localeCompare(b));
}

function pullFailureReason(error: unknown): string {
	if (error instanceof OllamaClientError) {
		if (error.code === "aborted")
			return "The Hlid download request was canceled.";
		if (error.code === "timeout") return "The Ollama download timed out.";
		if (error.code === "unavailable")
			return "Ollama is unavailable on Windows.";
		return error.message;
	}
	return error instanceof Error ? error.message : "The Ollama download failed.";
}

function localModelFor(
	models: readonly OllamaLocalModel[],
	model: string,
): OllamaLocalModel | undefined {
	return models.find(
		(candidate) => candidate.model === model || candidate.name === model,
	);
}

function loadedModelFor(
	models: readonly OllamaLoadedModel[],
	model: string,
	local: OllamaLocalModel,
): OllamaLoadedModel | undefined {
	return models.find(
		(candidate) =>
			candidate.digest === local.digest &&
			(candidate.model === model ||
				candidate.name === model ||
				candidate.model === local.model ||
				candidate.name === local.name),
	);
}

function openCodeVariantName(digest: string): string {
	const identity = createHash("sha256")
		.update(digest)
		.update("\0")
		.update(String(OPENCODE_LOCAL_MODEL_MIN_CONTEXT))
		.digest("hex");
	return `${OLLAMA_OPEN_CODE_VARIANT_PREFIX}${identity}:ctx${OPENCODE_LOCAL_MODEL_MIN_CONTEXT}`;
}

function isOpenCodeVariant(model: string): boolean {
	return OLLAMA_OPEN_CODE_VARIANT_PATTERN.test(model);
}

function withoutReservedRelayCredential(
	environment: Readonly<Record<string, string>>,
): Record<string, string> {
	const reserved = HLID_OLLAMA_RELAY_TOKEN_ENV.toUpperCase();
	return Object.fromEntries(
		Object.entries(environment).filter(
			([name]) => name.toUpperCase() !== reserved,
		),
	);
}

function unknownCompatibilityEvidence(
	model: OllamaLocalModel,
	reason: "inspection-failed" | "not-inspected",
): OllamaInventoryModel {
	return {
		...model,
		capabilities: [],
		compatibilityInspection: { status: "unknown", reason },
		details: { ...model.details, contextLength: null },
	};
}

function enrichedLocalModel(
	model: OllamaLocalModel,
	details: OllamaModelDetails,
	checkedAt: number,
): OllamaInventoryModel {
	return {
		...model,
		capabilities: details.capabilities,
		compatibilityInspection: { status: "verified", checkedAt },
		details: {
			contextLength: details.contextLength,
			families:
				details.details.families.length > 0
					? details.details.families
					: model.details.families,
			family: details.details.family ?? model.details.family,
			format: details.details.format ?? model.details.format,
			parameterSize:
				details.details.parameterSize ?? model.details.parameterSize,
			parentModel: details.details.parentModel ?? model.details.parentModel,
			quantizationLevel:
				details.details.quantizationLevel ?? model.details.quantizationLevel,
		},
	};
}

function assertOpenCodeModelPreflight(
	model: string,
	details: OllamaModelDetails,
): void {
	if (!details.capabilities.includes("tools")) {
		throw new Error(
			`Windows Ollama model ${JSON.stringify(model)} does not advertise tool calling, which OpenCode requires.`,
		);
	}
	if (
		details.contextLength === null ||
		details.contextLength < OPENCODE_LOCAL_MODEL_MIN_CONTEXT
	) {
		throw new Error(
			`Windows Ollama model ${JSON.stringify(model)} advertises ${details.contextLength?.toLocaleString() ?? "an unknown"} context; OpenCode local models require at least ${OPENCODE_LOCAL_MODEL_MIN_CONTEXT.toLocaleString()}.`,
		);
	}
}

function assertOpenCodeModelLoaded(
	displayModel: string,
	runtimeModel: string,
	local: OllamaLocalModel,
	loadedModels: readonly OllamaLoadedModel[],
): OllamaLoadedModel {
	const loaded = loadedModelFor(loadedModels, runtimeModel, local);
	if (!loaded) {
		throw new Error(
			`Windows Ollama model ${JSON.stringify(displayModel)} is not loaded with its verified local digest. Load it in Forge before starting OpenCode.`,
		);
	}
	if (loaded.contextLength < OPENCODE_LOCAL_MODEL_MIN_CONTEXT) {
		throw new Error(
			`Windows Ollama model ${JSON.stringify(displayModel)} is loaded with ${loaded.contextLength.toLocaleString()} context; OpenCode requires an actual allocation of at least ${OPENCODE_LOCAL_MODEL_MIN_CONTEXT.toLocaleString()}. Reload it in Forge.`,
		);
	}
	return loaded;
}

/**
 * Build the production exact-distro relay probe around one injectable spawn
 * boundary. The capability stays off argv and is written only to curl's stdin.
 */
export function createOllamaWslRelayProbe(
	dependencies: OllamaWslRelayProbeDependencies = {},
): OllamaWslRelayProbe {
	const spawnProcess: OllamaWslRelayProbeSpawner =
		dependencies.spawnProcess ??
		((executable, args, options) => spawn(executable, args, options));
	const timeoutMs = dependencies.timeoutMs ?? OLLAMA_WSL_RELAY_PROBE_TIMEOUT_MS;
	return (input) => {
		let url: URL;
		try {
			url = new URL(input.url);
		} catch {
			return Promise.reject(new Error("The WSL Ollama relay URL is invalid."));
		}
		if (
			input.distro.length === 0 ||
			input.distro.length > 128 ||
			!/^[A-Za-z0-9._-]+$/.test(input.distro) ||
			!/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
			url.protocol !== "http:" ||
			url.username ||
			url.password ||
			!isCanonicalIpv4Address(url.hostname) ||
			url.port !== String(OLLAMA_INFERENCE_RELAY_PORT) ||
			url.pathname !== "/v1/models" ||
			url.search ||
			url.hash
		) {
			return Promise.reject(
				new Error("The WSL Ollama relay probe target is invalid."),
			);
		}
		if (input.signal?.aborted) {
			return Promise.reject(
				new Error("The WSL Ollama relay probe was canceled."),
			);
		}
		return new Promise((resolve, reject) => {
			let child: ChildProcessWithoutNullStreams;
			try {
				child = spawnProcess(
					"wsl.exe",
					[
						"-d",
						input.distro,
						"--exec",
						"/usr/bin/curl",
						"--silent",
						"--show-error",
						"--connect-timeout",
						"3",
						"--max-time",
						"5",
						"--header",
						"@-",
						"--output",
						"/dev/null",
						"--write-out",
						"%{http_code}",
						url.toString(),
					],
					{
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
						shell: false,
					},
				);
			} catch {
				reject(new Error("Hlid could not start the WSL Ollama relay probe."));
				return;
			}
			let output = "";
			let settled = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const append = (chunk: Buffer | string) => {
				const remaining =
					OLLAMA_WSL_RELAY_PROBE_MAX_OUTPUT_CHARS - output.length;
				if (remaining > 0) output += chunk.toString().slice(0, remaining);
			};
			const onStdinError = () => {
				terminate(
					new Error("Hlid could not write the WSL Ollama relay probe."),
				);
			};
			const onChildError = () => {
				terminate(
					new Error("Hlid could not start the WSL Ollama relay probe."),
				);
			};
			const onClose = (code: number | null) => {
				if (code === 0 && output.trim() === "200") finish();
				else
					finish(
						new Error(
							"The exact WSL distro could not reach the authenticated Windows Ollama relay.",
						),
					);
			};
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (timeout !== undefined) clearTimeout(timeout);
				input.signal?.removeEventListener("abort", onAbort);
				child.stdout.off("data", append);
				child.stderr.off("data", append);
				child.stdin.off("error", onStdinError);
				child.off("error", onChildError);
				child.off("close", onClose);
				if (error) reject(error);
				else resolve();
			};
			const terminate = (error: Error) => {
				if (settled) return;
				finish(error);
				try {
					child.kill();
				} catch {
					// A failed Windows spawn may have no process left to terminate.
				}
			};
			const onAbort = () => {
				terminate(new Error("The WSL Ollama relay probe was canceled."));
			};
			child.stdout.on("data", append);
			child.stderr.on("data", append);
			child.stdin.once("error", onStdinError);
			child.once("error", onChildError);
			child.once("close", onClose);
			timeout = setTimeout(() => {
				terminate(new Error("The WSL Ollama relay probe timed out."));
			}, timeoutMs);
			timeout.unref?.();
			input.signal?.addEventListener("abort", onAbort, { once: true });
			if (input.signal?.aborted) onAbort();
			else {
				child.stdin.end(
					`Authorization: Bearer ${input.token}\nAccept: application/json\n`,
				);
			}
		});
	};
}

const defaultProbeWslRelay = createOllamaWslRelayProbe();

export class OllamaIntegration {
	readonly manager: OllamaManager;
	readonly resolveOpenCodeEnvironment: AcpWorkspaceEnvironmentResolver;

	private readonly platform: NodeJS.Platform;
	private readonly setup: OllamaWindowsSetupController;
	private readonly now: () => number;
	private readonly onOpenCodeRuntimeInvalidated: () => Promise<void> | void;
	private readonly inventoryInspectionBudgetMs: number;
	private readonly getWindowsFirewallStatus: typeof getOllamaWindowsFirewallStatus;
	private readonly removeWindowsFirewallRule: typeof removeOllamaWindowsFirewallRule;
	private readonly resolveWslNetwork: typeof resolveOllamaWslNetwork;
	private readonly probeWslRelay: OllamaWslRelayProbe;
	private readonly serve: RelayServerFactory;
	private readonly leases: OllamaInferenceLeaseRegistry;
	private readonly activeLeases = new Map<string, ActiveLease>();
	private readonly relayServers = new Map<string, RelayServer>();
	private readonly relayStopPromises = new Map<string, Promise<void>>();
	private readonly targetRelayAddresses = new Map<string, string>();
	private readonly relayAcquisitions = new Map<string, Map<string, number>>();
	private readonly inferenceLaneWaiters: InferenceLaneWaiter[] = [];
	private readonly relayHandler: ReturnType<typeof createOllamaInferenceRelay>;
	private readonly inventoryInspectionCache = new Map<
		string,
		InventoryInspectionCacheEntry
	>();
	private readonly inventoryInspectionsInFlight = new Set<string>();
	private inventoryInspectionCursor = 0;
	private pullState: OllamaPullState = { state: "idle" };
	private pullController: AbortController | null = null;
	private configuredModels: readonly string[] = [];
	private modelMutationAcquisitions = 0;
	private openCodeEnvironmentAcquisitions = 0;
	private wslAccessGeneration = 0;
	private wslAccessRemovalActive = false;
	private inferenceLaneActive = false;
	private closing = false;

	constructor(options: OllamaIntegrationOptions = {}) {
		this.manager = options.manager ?? new OllamaManager();
		this.platform = options.platform ?? process.platform;
		this.setup =
			options.setup ??
			new OllamaWindowsSetupManager({ platform: this.platform });
		this.now = options.now ?? Date.now;
		this.onOpenCodeRuntimeInvalidated =
			options.onOpenCodeRuntimeInvalidated ?? (() => {});
		this.inventoryInspectionBudgetMs = inventoryInspectionBudget(
			options.inventoryInspectionBudgetMs,
		);
		this.leases = new OllamaInferenceLeaseRegistry({ now: this.now });
		this.getWindowsFirewallStatus =
			options.getWindowsFirewallStatus ?? getOllamaWindowsFirewallStatus;
		this.removeWindowsFirewallRule =
			options.removeWindowsFirewallRule ?? removeOllamaWindowsFirewallRule;
		this.resolveWslNetwork =
			options.resolveWslNetwork ?? resolveOllamaWslNetwork;
		this.probeWslRelay = options.probeWslRelay ?? defaultProbeWslRelay;
		this.serve = options.serve ?? serveOllamaInferenceRelay;
		this.relayHandler = createOllamaInferenceRelay({
			leases: this.leases,
			upstreamFetch: options.upstreamFetch,
			validateLocalModels: (input) => this.validateLocalModels(input),
		});
		this.resolveOpenCodeEnvironment = (input) =>
			this.openCodeEnvironment(input);
	}

	private setInventoryInspectionCache(
		digest: string,
		entry: InventoryInspectionCacheEntry,
	): void {
		this.inventoryInspectionCache.delete(digest);
		this.inventoryInspectionCache.set(digest, entry);
		while (
			this.inventoryInspectionCache.size >
			OLLAMA_INVENTORY_INSPECTION_CACHE_LIMIT
		) {
			const oldest = this.inventoryInspectionCache.keys().next().value;
			if (typeof oldest !== "string") break;
			this.inventoryInspectionCache.delete(oldest);
		}
	}

	private pruneInventoryInspectionCache(
		models: readonly OllamaLocalModel[],
	): void {
		const presentDigests = new Set(models.map((model) => model.digest));
		for (const digest of this.inventoryInspectionCache.keys()) {
			if (!presentDigests.has(digest)) {
				this.inventoryInspectionCache.delete(digest);
			}
		}
	}

	private inventorySnapshot(
		models: readonly OllamaLocalModel[],
	): OllamaInventoryModel[] {
		return models.map((model) => {
			const cached = this.inventoryInspectionCache.get(model.digest);
			if (cached?.status === "verified") {
				return enrichedLocalModel(model, cached.details, cached.checkedAt);
			}
			return unknownCompatibilityEvidence(
				model,
				cached?.reason ?? "not-inspected",
			);
		});
	}

	private async inspectLocalModelInventory(
		models: readonly OllamaLocalModel[],
		selectedModels: readonly string[],
	): Promise<OllamaInventoryModel[]> {
		this.pruneInventoryInspectionCache(models);
		const observedAt = this.now();
		const selected = new Set(selectedModels);
		const selectedIndexes: number[] = [];
		const unselectedIndexes: number[] = [];
		for (const [index, model] of models.entries()) {
			(model && (selected.has(model.model) || selected.has(model.name))
				? selectedIndexes
				: unselectedIndexes
			).push(index);
		}
		const cursorStart =
			unselectedIndexes.length > 0
				? this.inventoryInspectionCursor % unselectedIndexes.length
				: 0;
		const rotatedUnselected = [
			...unselectedIndexes.slice(cursorStart),
			...unselectedIndexes.slice(0, cursorStart),
		];
		if (unselectedIndexes.length > 0) {
			this.inventoryInspectionCursor =
				(cursorStart +
					Math.min(
						unselectedIndexes.length,
						OLLAMA_INVENTORY_INSPECTIONS_PER_REFRESH,
					)) %
				unselectedIndexes.length;
		}

		const attemptedDigests = new Set<string>();
		const attemptIndexes: number[] = [];
		const availableInspectionSlots = Math.max(
			0,
			OLLAMA_INVENTORY_INSPECTIONS_PER_REFRESH -
				this.inventoryInspectionsInFlight.size,
		);
		if (availableInspectionSlots === 0) {
			return this.inventorySnapshot(models);
		}
		for (const index of [...selectedIndexes, ...rotatedUnselected]) {
			const model = models[index];
			if (!model || attemptedDigests.has(model.digest)) continue;
			if (this.inventoryInspectionsInFlight.has(model.digest)) continue;
			const cached = this.inventoryInspectionCache.get(model.digest);
			if (cached?.status === "verified") continue;
			if (cached?.status === "unknown" && cached.retryAfter > observedAt) {
				continue;
			}
			attemptedDigests.add(model.digest);
			attemptIndexes.push(index);
			if (attemptIndexes.length >= availableInspectionSlots) {
				break;
			}
		}

		if (attemptIndexes.length === 0) return this.inventorySnapshot(models);
		const controller = new AbortController();
		let budgetExpired = false;
		let budgetTimer: ReturnType<typeof setTimeout> | undefined;
		const budget = new Promise<"budget">((resolve) => {
			budgetTimer = setTimeout(() => {
				budgetExpired = true;
				controller.abort();
				resolve("budget");
			}, this.inventoryInspectionBudgetMs);
		});
		let nextAttempt = 0;
		const inspectNext = async (): Promise<void> => {
			while (!budgetExpired && nextAttempt < attemptIndexes.length) {
				const index = attemptIndexes[nextAttempt];
				nextAttempt += 1;
				const model = index === undefined ? undefined : models[index];
				if (!model) continue;
				this.setInventoryInspectionCache(model.digest, {
					status: "unknown",
					reason: "inspection-failed",
					retryAfter: Math.min(
						Number.MAX_SAFE_INTEGER,
						this.now() + OLLAMA_INVENTORY_INSPECTION_COOLDOWN_MS,
					),
				});
				this.inventoryInspectionsInFlight.add(model.digest);
				try {
					const details = await this.manager.showModel(model.model, {
						signal: controller.signal,
					});
					if (budgetExpired) continue;
					this.setInventoryInspectionCache(model.digest, {
						status: "verified",
						checkedAt: this.now(),
						details,
					});
				} catch {
					if (budgetExpired) continue;
					this.setInventoryInspectionCache(model.digest, {
						status: "unknown",
						reason: "inspection-failed",
						retryAfter: Math.min(
							Number.MAX_SAFE_INTEGER,
							this.now() + OLLAMA_INVENTORY_INSPECTION_COOLDOWN_MS,
						),
					});
				} finally {
					this.inventoryInspectionsInFlight.delete(model.digest);
				}
			}
		};
		const work = Promise.all(
			Array.from(
				{
					length: Math.min(
						attemptIndexes.length,
						OLLAMA_INVENTORY_DETAILS_CONCURRENCY,
					),
				},
				() => inspectNext(),
			),
		).then(() => "complete" as const);
		const outcome = await Promise.race([work, budget]);
		if (outcome === "complete" && budgetTimer) clearTimeout(budgetTimer);
		if (outcome === "budget") void work.catch(() => {});
		return this.inventorySnapshot(models);
	}

	async info(config: HlidConfig): Promise<OllamaIntegrationInfo> {
		const selectedModels = [...selectedOllamaModels(config)];
		this.configuredModels = selectedModels;
		const wslDistros = configuredWslDistros(config);
		if (this.platform !== "win32") {
			const firewall = await this.getWindowsFirewallStatus({
				platform: this.platform,
			});
			return {
				supported: false,
				host: "windows",
				status: unavailableStatus("unavailable"),
				setup: this.setup.status(),
				models: [],
				loadedModels: [],
				preparedModels: [],
				selectedModels,
				pull: this.pullState,
				firewall,
				wsl: wslDistros.map((distro) => ({
					ready: false,
					distro,
					reason: "unsupported_host",
					blockedReason:
						"The Ollama WSL relay requires Hlid to run on Windows.",
				})),
				relay: { port: OLLAMA_INFERENCE_RELAY_PORT, listeners: [] },
			};
		}
		const [status, firewall, wsl] = await Promise.all([
			this.manager.getStatus(),
			this.getWindowsFirewallStatus({ platform: this.platform }),
			Promise.all(
				wslDistros.map((distro) =>
					this.resolveWslNetwork(distro, { platform: this.platform }),
				),
			),
		]);
		if (status.available) await this.setup.markDetected(status.version);
		let models: OllamaInventoryModel[] = [];
		let loadedModels: OllamaLoadedModel[] = [];
		let preparedModels: OllamaLoadedModel[] = [];
		if (status.available) {
			const [allLocalModels, loaded] = await Promise.all([
				this.manager.listLocalModels(),
				this.manager.listLoadedModels(),
			]);
			const localModels = allLocalModels.filter(
				(model) => !isOpenCodeVariant(model.model),
			);
			models = await this.inspectLocalModelInventory(
				localModels,
				selectedModels,
			);
			loadedModels = loaded.filter((model) => !isOpenCodeVariant(model.model));
			preparedModels = selectedModels.flatMap((selected) => {
				const local = localModelFor(localModels, selected);
				if (!local) return [];
				const variant = openCodeVariantName(local.digest);
				const prepared = loaded.find(
					(candidate) =>
						candidate.model === variant || candidate.name === variant,
				);
				return prepared
					? [
							{
								...prepared,
								details: local.details,
								digest: local.digest,
								model: local.model,
								name: local.name,
							},
						]
					: [];
			});
		}
		return {
			supported: true,
			host: "windows",
			status,
			setup: this.setup.status(),
			models,
			loadedModels,
			preparedModels,
			selectedModels,
			pull: this.pullState,
			firewall,
			wsl,
			relay: {
				port: OLLAMA_INFERENCE_RELAY_PORT,
				listeners: [...this.relayServers.entries()].map(
					([address, server]) => ({
						address,
						port: server.port ?? OLLAMA_INFERENCE_RELAY_PORT,
					}),
				),
			},
		};
	}

	async startWindowsSetupDownload(): Promise<OllamaWindowsSetupState> {
		this.assertWindowsHost("setting up Ollama");
		const status = await this.manager.getStatus();
		if (status.available) return this.setup.markDetected(status.version);
		return this.setup.startDownload();
	}

	async windowsSetupInfo(): Promise<OllamaWindowsSetupInfo> {
		if (this.platform !== "win32") {
			return {
				status: unavailableStatus("unavailable"),
				setup: this.setup.status(),
			};
		}
		const status = await this.manager.getStatus();
		if (status.available) await this.setup.markDetected(status.version);
		return { status, setup: this.setup.status() };
	}

	async cancelWindowsSetupDownload(): Promise<OllamaWindowsSetupState> {
		this.assertWindowsHost("canceling Ollama setup");
		return this.setup.cancelDownload();
	}

	async launchWindowsSetup(): Promise<OllamaWindowsSetupState> {
		this.assertWindowsHost("launching Ollama setup");
		const status = await this.manager.getStatus();
		if (status.available) return this.setup.markDetected(status.version);
		return this.setup.launch();
	}

	startPull(model: string): OllamaPullState {
		if (this.platform !== "win32") {
			throw new Error("Ollama model downloads require Hlid to run on Windows.");
		}
		if (this.pullController) {
			throw new Error("Another Ollama model download is already active.");
		}
		if (model.startsWith(OLLAMA_OPEN_CODE_VARIANT_PREFIX)) {
			throw new Error("The hlid-opencode model namespace is reserved by Hlid.");
		}
		if (this.modelMutationAcquisitions > 0) {
			throw new Error(
				"Wait for the active Ollama model change to finish before pulling a model.",
			);
		}
		if (this.openCodeEnvironmentAcquisitions > 0) {
			throw new Error(
				"Wait for the Hlid-managed OpenCode runtime to finish starting before pulling a model.",
			);
		}
		const controller = new AbortController();
		const startedAt = this.now();
		this.pullController = controller;
		this.pullState = { state: "running", model, startedAt };
		void this.manager
			.pullModel(model, {
				signal: controller.signal,
				onProgress: (progress) => {
					if (this.pullController !== controller) return;
					this.pullState = {
						state: controller.signal.aborted ? "canceling" : "running",
						model,
						startedAt,
						progress,
					};
				},
			})
			.then(async () => {
				if (this.pullController !== controller) return;
				const activeModelChanged = await this.activeLeaseEvidenceChanged(
					controller.signal,
				);
				if (activeModelChanged) {
					await this.retireInferenceRuntime();
					try {
						await this.onOpenCodeRuntimeInvalidated();
					} catch (error) {
						console.warn(
							"[ollama] selected model changed, but OpenCode session retirement failed:",
							error instanceof Error ? error.message : String(error),
						);
					}
				}
				try {
					await this.cleanupManagedVariants(this.configuredModels);
				} catch (error) {
					console.warn(
						"[ollama] model pull completed, but managed variant cleanup failed:",
						error instanceof Error ? error.message : String(error),
					);
				}
				this.pullState = {
					state: "complete",
					model,
					startedAt,
					completedAt: this.now(),
				};
			})
			.catch((error) => {
				if (this.pullController !== controller) return;
				this.pullState = {
					state: controller.signal.aborted ? "canceled" : "failed",
					model,
					startedAt,
					completedAt: this.now(),
					reason: pullFailureReason(error),
				};
			})
			.finally(() => {
				if (this.pullController === controller) this.pullController = null;
			});
		return this.pullState;
	}

	cancelPull(): OllamaPullState {
		if (!this.pullController) return this.pullState;
		this.pullController.abort("Canceled by user");
		if (this.pullState.state === "running") {
			this.pullState = { ...this.pullState, state: "canceling" };
		}
		return this.pullState;
	}

	async loadModel(model: string): Promise<void> {
		this.assertWindowsHost("loading an Ollama model");
		this.assertNoActiveOpenCodeRuntime("prepare a model manually");
		await this.runModelMutation("prepare a model", async () => {
			const [localModels, details] = await Promise.all([
				this.manager.listLocalModels(),
				this.manager.showModel(model),
			]);
			const local = localModelFor(localModels, model);
			if (!local) {
				throw new Error(
					`Windows Ollama does not have local model ${JSON.stringify(model)}.`,
				);
			}
			assertOpenCodeModelPreflight(model, details);
			await this.prepareOpenCodeVariant(model, local);
		});
	}

	async unloadModel(model: string): Promise<void> {
		this.assertWindowsHost("unloading an Ollama model");
		this.assertNoActiveOpenCodeRuntime("unload a model");
		await this.runModelMutation("unload a model", async () => {
			const local = localModelFor(await this.manager.listLocalModels(), model);
			if (!local) {
				throw new Error(
					`Windows Ollama does not have local model ${JSON.stringify(model)}.`,
				);
			}
			const variant = openCodeVariantName(local.digest);
			const variants = await this.manager.listLocalModels();
			if (localModelFor(variants, variant)) {
				await this.manager.unloadModel(variant);
			}
		});
	}

	async deleteModel(model: string, config: HlidConfig): Promise<void> {
		this.assertWindowsHost("deleting an Ollama model");
		this.assertNoActiveOpenCodeRuntime("delete a model");
		await this.runModelMutation("delete a model", async () => {
			const selected = new Set(selectedOllamaModels(config));
			const localModels = await this.manager.listLocalModels();
			const local = localModelFor(localModels, model);
			if (
				selected.has(model) ||
				(local !== undefined &&
					(selected.has(local.model) || selected.has(local.name)))
			) {
				throw new Error(
					"Remove this model from the Ollama integration selection before deleting it.",
				);
			}
			if (local) {
				await this.removeManagedVariant(
					localModelFor(localModels, openCodeVariantName(local.digest)),
				);
			}
			await this.manager.deleteModel(model);
			await this.cleanupManagedVariants(this.configuredModels);
		});
	}

	async reconcileManagedVariants(config: HlidConfig): Promise<void> {
		this.configuredModels = [...selectedOllamaModels(config)];
		if (
			this.platform !== "win32" ||
			this.pullController ||
			this.modelMutationAcquisitions > 0 ||
			this.openCodeEnvironmentAcquisitions > 0
		) {
			return;
		}
		try {
			await this.runModelMutation("reconcile managed variants", () =>
				this.cleanupManagedVariants(this.configuredModels),
			);
		} catch (error) {
			if (
				error instanceof OllamaClientError &&
				(error.code === "unavailable" || error.code === "timeout")
			) {
				return;
			}
			throw error;
		}
	}

	async installWslFirewallRule(): Promise<OllamaWindowsFirewallStatus> {
		return installOllamaWindowsFirewallRule({ platform: this.platform });
	}

	async removeWslFirewallRule(): Promise<OllamaWindowsFirewallStatus> {
		if (this.wslAccessRemovalActive) {
			throw new Error("WSL Ollama access removal is already active.");
		}
		this.wslAccessRemovalActive = true;
		this.wslAccessGeneration += 1;
		try {
			const status = await this.removeWindowsFirewallRule({
				platform: this.platform,
			});
			const wslLeases = [...this.activeLeases.values()].filter((active) =>
				active.targetId.startsWith("wsl:"),
			);
			await Promise.all(
				wslLeases.map((active) => this.releaseLease(active.id)),
			);
			for (const [targetId, address] of [...this.targetRelayAddresses]) {
				if (!targetId.startsWith("wsl:")) continue;
				this.targetRelayAddresses.delete(targetId);
				await this.stopUnusedRelayAddress(address);
			}
			if (wslLeases.length > 0) {
				await this.onOpenCodeRuntimeInvalidated();
			}
			return status;
		} finally {
			this.wslAccessRemovalActive = false;
		}
	}

	async close(): Promise<void> {
		this.closing = true;
		this.pullController?.abort("Hlid is shutting down");
		this.pullController = null;
		await Promise.all([this.retireInferenceRuntime(), this.setup.close()]);
	}

	async retireInferenceRuntime(target?: AcpExecutionTarget): Promise<void> {
		const targetId = target ? acpExecutionTargetKey(target) : null;
		await Promise.all(
			[...this.activeLeases.values()]
				.filter((active) => !targetId || active.targetId === targetId)
				.map((active) => this.releaseLease(active.id)),
		);
		if (targetId) {
			const address = this.targetRelayAddresses.get(targetId);
			this.targetRelayAddresses.delete(targetId);
			if (address) await this.stopUnusedRelayAddress(address);
			return;
		}
		const serverStops = [...this.relayServers.entries()].map(
			([address, server]) => this.stopRelayServer(address, server),
		);
		this.targetRelayAddresses.clear();
		this.relayAcquisitions.clear();
		await Promise.allSettled([
			...new Set([...serverStops, ...this.relayStopPromises.values()]),
		]);
	}

	private assertWindowsHost(operation: string): void {
		if (this.platform !== "win32") {
			throw new Error(
				`Windows Ollama integration requires Windows for ${operation}.`,
			);
		}
	}

	private assertNoActiveOpenCodeRuntime(operation: string): void {
		if (
			this.activeLeases.size > 0 ||
			this.openCodeEnvironmentAcquisitions > 0
		) {
			throw new Error(
				`Stop the Hlid-managed OpenCode runtime before asking Ollama to ${operation}.`,
			);
		}
	}

	private async runModelMutation<T>(
		operation: string,
		run: () => Promise<T>,
	): Promise<T> {
		if (this.pullController) {
			throw new Error(
				`Wait for the active Ollama model download to finish before asking Ollama to ${operation}.`,
			);
		}
		if (this.modelMutationAcquisitions > 0) {
			throw new Error(
				`Another Ollama model change is active; retry ${operation} shortly.`,
			);
		}
		this.modelMutationAcquisitions += 1;
		try {
			return await run();
		} finally {
			this.modelMutationAcquisitions -= 1;
		}
	}

	private async removeManagedVariant(
		variant: OllamaLocalModel | undefined,
	): Promise<void> {
		if (!variant) return;
		const loaded = loadedModelFor(
			await this.manager.listLoadedModels(),
			variant.model,
			variant,
		);
		if (loaded) await this.manager.unloadModel(variant.model);
		await this.manager.deleteModel(variant.model);
	}

	private async cleanupManagedVariants(
		selectedModels: readonly string[],
	): Promise<void> {
		const localModels = await this.manager.listLocalModels();
		const baseModels = localModels.filter(
			(model) =>
				!isOpenCodeVariant(model.model) && !isOpenCodeVariant(model.name),
		);
		const retained = new Set(
			selectedModels.flatMap((model) => {
				const local = localModelFor(baseModels, model);
				return local ? [openCodeVariantName(local.digest)] : [];
			}),
		);
		for (const active of this.activeLeases.values()) {
			for (const variant of active.inferenceVariants.values()) {
				retained.add(variant.model);
			}
		}
		const obsolete = localModels.filter(
			(model) =>
				(isOpenCodeVariant(model.model) || isOpenCodeVariant(model.name)) &&
				!retained.has(model.model) &&
				!retained.has(model.name),
		);
		if (obsolete.length > OLLAMA_MANAGED_VARIANT_CLEANUP_LIMIT) {
			throw new Error(
				`Ollama has more than ${OLLAMA_MANAGED_VARIANT_CLEANUP_LIMIT} obsolete Hlid OpenCode variants; cleanup stopped for safety.`,
			);
		}
		for (const variant of obsolete) {
			await this.removeManagedVariant(variant);
		}
	}

	private async prepareOpenCodeVariant(
		model: string,
		local: OllamaLocalModel,
		signal?: AbortSignal,
		active?: ActiveLease,
	): Promise<{ digest: string; model: string }> {
		const variantName = openCodeVariantName(local.digest);
		let variant: OllamaLocalModel | undefined;
		let cached = active?.inferenceVariants.get(model);

		if (cached) {
			const localModels = await this.manager.listLocalModels({ signal });
			variant = localModelFor(localModels, variantName);
			if (
				cached.baseDigest !== local.digest ||
				cached.model !== variantName ||
				variant?.digest !== cached.digest
			) {
				cached = undefined;
			}
		}

		if (!cached) {
			await this.manager.createContextModel(
				variantName,
				local.model,
				OPENCODE_LOCAL_MODEL_MIN_CONTEXT,
				{ signal },
			);
			const localModels = await this.manager.listLocalModels({ signal });
			const currentBase = localModelFor(localModels, model);
			if (!currentBase || currentBase.digest !== local.digest) {
				throw new Error(
					"Ollama model evidence changed while Hlid was preparing it for OpenCode.",
				);
			}
			variant = localModelFor(localModels, variantName);
			if (!variant) {
				throw new Error(
					"Ollama did not publish Hlid's fixed-context OpenCode model variant.",
				);
			}
			const variantDetails = await this.manager.showModel(variantName, {
				signal,
			});
			assertOpenCodeModelPreflight(model, variantDetails);
			cached = {
				baseDigest: local.digest,
				digest: variant.digest,
				model: variantName,
			};
			active?.inferenceVariants.set(model, cached);
		}

		if (!variant) {
			const localModels = await this.manager.listLocalModels({ signal });
			variant = localModelFor(localModels, variantName);
		}
		if (!variant || variant.digest !== cached.digest) {
			throw new Error(
				"Hlid's fixed-context Ollama model evidence changed before OpenCode could use it.",
			);
		}

		let loadedModels = await this.manager.listLoadedModels({ signal });
		let loaded = loadedModelFor(loadedModels, variantName, variant);
		if (!loaded || loaded.contextLength < OPENCODE_LOCAL_MODEL_MIN_CONTEXT) {
			await this.manager.loadModel(variantName, {
				keepAlive: active ? ollamaKeepAliveValue(active.keepWarm) : "5m",
				signal,
			});
			loadedModels = await this.manager.listLoadedModels({ signal });
			loaded = loadedModelFor(loadedModels, variantName, variant);
		}
		assertOpenCodeModelLoaded(model, variantName, variant, loadedModels);
		return cached;
	}

	private async openCodeEnvironment(
		input: Parameters<AcpWorkspaceEnvironmentResolver>[0],
	): Promise<Awaited<ReturnType<AcpWorkspaceEnvironmentResolver>>> {
		if (this.closing)
			throw new Error("Hlid is shutting down its Ollama relay.");
		const configured = input.config.acp_agents?.find(
			(agent) => agent.id === input.item.id,
		);
		const ollama =
			input.item.id === "opencode" && configured
				? input.config.ollama
				: undefined;
		if (!ollama) {
			return { environment: input.environment, release: () => {} };
		}
		this.configuredModels = [...ollama.models];
		if (this.platform !== "win32") {
			throw new Error(
				"Windows Ollama integration requires the Hlid host to run on Windows.",
			);
		}
		if (input.target.kind === "wsl" && this.wslAccessRemovalActive) {
			throw new Error("WSL Ollama access removal is active; retry shortly.");
		}
		const wslAccessGeneration =
			input.target.kind === "wsl" ? this.wslAccessGeneration : null;
		if (this.pullController) {
			throw new Error(
				"Wait for the active Ollama model download to finish before starting OpenCode.",
			);
		}
		this.openCodeEnvironmentAcquisitions += 1;
		try {
			const localModels = (
				await this.manager.listLocalModels({
					signal: input.signal,
				})
			).filter((model) => !isOpenCodeVariant(model.model));
			const byName = new Map(
				localModels.flatMap((model) => [
					[model.model, model] as const,
					[model.name, model] as const,
				]),
			);
			const missing = ollama.models.filter((model) => !byName.has(model));
			if (missing.length > 0) {
				throw new Error(
					`Windows Ollama does not have the selected local model ${JSON.stringify(missing[0])}. Refresh Ollama in Forge.`,
				);
			}
			const selectedLocalModels = ollama.models.map((model) => {
				const selected = byName.get(model);
				if (!selected) {
					throw new Error(
						"Ollama local-model evidence changed during startup.",
					);
				}
				return selected;
			});
			const modelDetails = await Promise.all(
				ollama.models.map((model) =>
					this.manager.showModel(model, { signal: input.signal }),
				),
			);
			const models = modelDetails.map((details, index) => {
				const configuredModel = ollama.models[index] ?? details.model;
				const local = selectedLocalModels[index];
				if (!local) {
					throw new Error(
						"Ollama local-model evidence changed during startup.",
					);
				}
				assertOpenCodeModelPreflight(configuredModel, details);
				return {
					id: configuredModel,
					name: details.model,
					contextLength: OPENCODE_LOCAL_MODEL_MIN_CONTEXT,
					outputLength: OPENCODE_LOCAL_MODEL_OUTPUT_LIMIT,
				};
			});
			if (
				wslAccessGeneration !== null &&
				(this.wslAccessRemovalActive ||
					this.wslAccessGeneration !== wslAccessGeneration)
			) {
				throw new Error(
					"WSL Ollama access changed while OpenCode was starting.",
				);
			}

			let relayAddress = "127.0.0.1";
			if (input.target.kind === "wsl") {
				const network = await this.resolveWslNetwork(input.target.distro, {
					platform: this.platform,
				});
				if (!network.ready) throw new Error(network.blockedReason);
				if (network.mode === "nat") {
					const firewall = await this.getWindowsFirewallStatus({
						platform: this.platform,
					});
					if (!firewall.supported || !firewall.installed || !firewall.exact) {
						throw new Error(
							firewall.blockedReason ??
								`WSL NAT requires Hlid's exact inbound TCP ${OLLAMA_INFERENCE_RELAY_PORT} Hyper-V firewall rule. Set up WSL access in Forge and retry.`,
						);
					}
				}
				relayAddress = network.windowsHostAddress;
			}
			const targetId = acpExecutionTargetKey(input.target);
			this.beginRelayAcquisition(targetId, relayAddress);
			let receipt:
				| Awaited<ReturnType<AcpWorkspaceEnvironmentResolver>>
				| undefined;
			try {
				const relayServer = await this.ensureRelayServer(
					targetId,
					relayAddress,
					input.target.kind === "host",
				);
				const relayPort = resolvedRelayPort(relayServer);
				if (this.closing) {
					throw new Error("Hlid is shutting down its Ollama relay.");
				}
				const baseEnvironment = withOpenCodeOllamaProvider(
					withoutReservedRelayCredential(input.environment),
					{
						baseUrl: `http://${relayAddress}:${relayPort}/v1`,
						models,
						apiKeyEnvironmentVariable: HLID_OLLAMA_RELAY_TOKEN_ENV,
					},
					input.target.kind === "host" ? "win32" : "linux",
				);
				const modelDigests = new Map<string, string>();
				for (const [index, model] of models.entries()) {
					const local = selectedLocalModels[index];
					if (!local) continue;
					modelDigests.set(model.id, local.digest);
					modelDigests.set(local.model, local.digest);
					modelDigests.set(local.name, local.digest);
				}
				const currentModels = (
					await this.manager.listLocalModels({
						signal: input.signal,
					})
				).filter((model) => !isOpenCodeVariant(model.model));
				if (
					models.some((model) => {
						const current = localModelFor(currentModels, model.id);
						return current?.digest !== modelDigests.get(model.id);
					})
				) {
					throw new Error(
						"Ollama model evidence changed while OpenCode was starting. Retry the launch.",
					);
				}
				const capability = this.issueRelayLease(
					input.item.providerId,
					targetId,
					relayAddress,
					models.map((model) => model.id),
					modelDigests,
					ollama.keep_warm,
				);
				try {
					if (input.target.kind === "wsl") {
						await this.probeWslRelay({
							distro: input.target.distro,
							url: `http://${relayAddress}:${relayPort}/v1/models`,
							token: capability.token,
							signal: input.signal,
						});
					}
					if (this.closing) {
						await capability.release();
						throw new Error("Hlid is shutting down its Ollama relay.");
					}
					if (
						wslAccessGeneration !== null &&
						(this.wslAccessRemovalActive ||
							this.wslAccessGeneration !== wslAccessGeneration)
					) {
						await capability.release();
						throw new Error(
							"WSL Ollama access changed while OpenCode was starting.",
						);
					}
				} catch (error) {
					await capability.release();
					throw error;
				}
				receipt = {
					environment: {
						...baseEnvironment,
						[HLID_OLLAMA_RELAY_TOKEN_ENV]: capability.token,
					},
					release: capability.release,
				};
			} finally {
				await this.endRelayAcquisition(targetId, relayAddress);
			}
			if (!receipt) {
				throw new Error("Hlid could not prepare the Ollama relay receipt.");
			}
			if (this.closing) {
				await receipt.release();
				throw new Error("Hlid is shutting down its Ollama relay.");
			}
			if (
				wslAccessGeneration !== null &&
				(this.wslAccessRemovalActive ||
					this.wslAccessGeneration !== wslAccessGeneration)
			) {
				await receipt.release();
				throw new Error(
					"WSL Ollama access changed while OpenCode was starting.",
				);
			}
			return receipt;
		} finally {
			this.openCodeEnvironmentAcquisitions -= 1;
		}
	}

	private async ensureRelayServer(
		targetId: string,
		address: string,
		allowEphemeralPort: boolean,
	): Promise<RelayServer> {
		if (this.closing)
			throw new Error("Hlid is shutting down its Ollama relay.");
		const stopping = this.relayStopPromises.get(address);
		if (stopping) await stopping;
		if (this.closing)
			throw new Error("Hlid is shutting down its Ollama relay.");
		// The factory is synchronous, so this get/create/set block is one event-loop
		// critical section even when concurrent process acquisitions arrive together.
		const existing = this.relayServers.get(address);
		let server = existing;
		if (!server) {
			const options = {
				hostname: address,
				port: OLLAMA_INFERENCE_RELAY_PORT,
				maxRequestBodySize: OLLAMA_INFERENCE_MAX_REQUEST_BYTES,
				fetch: (request: Request) => this.relayHandler(request),
			};
			try {
				server = this.serve(options);
			} catch (error) {
				if (!allowEphemeralPort || !relayAddressInUse(error)) throw error;
				// Host OpenCode only needs an authenticated Windows-loopback endpoint.
				// If a prior relay left the fixed socket half-closed, let Windows choose
				// a fresh port. WSL never takes this path because its firewall contract
				// deliberately remains fixed to TCP 11435.
				server = this.serve({ ...options, port: 0 });
			}
			try {
				resolvedRelayPort(server);
			} catch (error) {
				await server.stop(true).catch(() => {});
				throw error;
			}
		}
		if (!existing) this.relayServers.set(address, server);
		const previousAddress = this.targetRelayAddresses.get(targetId);
		this.targetRelayAddresses.set(targetId, address);
		if (previousAddress && previousAddress !== address) {
			await this.stopUnusedRelayAddress(previousAddress);
		}
		return server;
	}

	private issueRelayLease(
		profileId: string,
		targetId: string,
		relayAddress: string,
		models: readonly string[],
		modelDigests: ReadonlyMap<string, string>,
		keepWarm: OllamaKeepWarmPolicy,
	): { token: string; release: () => Promise<void> } {
		for (const model of models) {
			if (!modelDigests.get(model)) {
				throw new Error("Ollama local-model evidence is incomplete.");
			}
		}
		const processId = `opencode:${randomUUID()}`;
		const issued = this.leases.issue({
			profileId,
			targetId,
			processId,
			allowedModels: models,
			expiresAt: this.now() + OLLAMA_RELAY_LEASE_MS,
		});
		const renewalTimer = setInterval(() => {
			const active = this.activeLeases.get(issued.id);
			if (!active) {
				clearInterval(renewalTimer);
				return;
			}
			if (!this.leases.renew(issued.id, this.now() + OLLAMA_RELAY_LEASE_MS)) {
				this.releaseLease(issued.id);
			}
		}, OLLAMA_RELAY_RENEWAL_INTERVAL_MS);
		renewalTimer.unref?.();
		this.activeLeases.set(issued.id, {
			id: issued.id,
			profileId,
			targetId,
			processId,
			relayAddress,
			modelDigests: new Map(modelDigests),
			selectedModelDigests: new Map(
				models.map((model) => [model, modelDigests.get(model) ?? ""]),
			),
			keepWarm,
			inferenceVariants: new Map(),
			renewalTimer,
		});
		let released = false;
		return {
			token: issued.token,
			release: async () => {
				if (released) return;
				released = true;
				await this.releaseLease(issued.id);
			},
		};
	}

	private async releaseLease(leaseId: string): Promise<void> {
		const active = this.activeLeases.get(leaseId);
		if (active) clearInterval(active.renewalTimer);
		this.activeLeases.delete(leaseId);
		this.leases.revoke(leaseId);
		if (active?.keepWarm === "session") {
			try {
				await this.unloadReleasedSessionVariants(active);
			} catch (error) {
				console.warn(
					"[ollama] OpenCode stopped, but its session-warm model cleanup failed:",
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		if (active) await this.stopUnusedRelayAddress(active.relayAddress);
	}

	private async unloadReleasedSessionVariants(
		active: ActiveLease,
	): Promise<void> {
		const stillUsed = new Set(
			[...this.activeLeases.values()].flatMap((lease) =>
				[...lease.inferenceVariants.values()].map((variant) => variant.model),
			),
		);
		const candidates = [
			...new Set(
				[...active.inferenceVariants.values()]
					.map((variant) => variant.model)
					.filter((model) => !stillUsed.has(model)),
			),
		];
		if (candidates.length === 0) return;

		const releaseLane = await this.acquireInferenceLane(
			new AbortController().signal,
		);
		try {
			const loaded = await this.manager.listLoadedModels();
			for (const model of candidates) {
				if (
					loaded.some(
						(candidate) =>
							candidate.model === model || candidate.name === model,
					)
				) {
					await this.manager.unloadModel(model);
				}
			}
		} finally {
			releaseLane();
		}
	}

	private acquireInferenceLane(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) {
			return Promise.reject(
				signal.reason ??
					new Error("The Ollama inference request was canceled."),
			);
		}
		if (!this.inferenceLaneActive) {
			this.inferenceLaneActive = true;
			return Promise.resolve(this.inferenceLaneRelease());
		}
		return new Promise<() => void>((resolve, reject) => {
			const waiter = {} as InferenceLaneWaiter;
			const onAbort = () => {
				const index = this.inferenceLaneWaiters.indexOf(waiter);
				if (index >= 0) this.inferenceLaneWaiters.splice(index, 1);
				reject(
					signal.reason ??
						new Error("The Ollama inference request was canceled."),
				);
			};
			Object.assign(waiter, { signal, onAbort, resolve, reject });
			this.inferenceLaneWaiters.push(waiter);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
	}

	private inferenceLaneRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			for (;;) {
				const waiter = this.inferenceLaneWaiters.shift();
				if (!waiter) {
					this.inferenceLaneActive = false;
					return;
				}
				waiter.signal.removeEventListener("abort", waiter.onAbort);
				if (waiter.signal.aborted) {
					waiter.reject(
						waiter.signal.reason ??
							new Error("The Ollama inference request was canceled."),
					);
					continue;
				}
				waiter.resolve(this.inferenceLaneRelease());
				return;
			}
		};
	}

	private async activeLeaseEvidenceChanged(
		signal: AbortSignal,
	): Promise<boolean> {
		const active = [...this.activeLeases.values()];
		if (active.length === 0) return false;
		let localModels: OllamaLocalModel[];
		try {
			localModels = await this.manager.listLocalModels({ signal });
		} catch {
			// The pull completed, so retain no capability whose local evidence can no
			// longer be verified. The next OpenCode launch will acquire fresh evidence.
			return true;
		}
		return active.some((lease) =>
			[...lease.selectedModelDigests].some(([model, expectedDigest]) => {
				const current = localModelFor(localModels, model);
				return !current || current.digest !== expectedDigest;
			}),
		);
	}

	private beginRelayAcquisition(targetId: string, address: string): void {
		const addresses = this.relayAcquisitions.get(targetId) ?? new Map();
		addresses.set(address, (addresses.get(address) ?? 0) + 1);
		this.relayAcquisitions.set(targetId, addresses);
	}

	private async endRelayAcquisition(
		targetId: string,
		address: string,
	): Promise<void> {
		const addresses = this.relayAcquisitions.get(targetId);
		if (addresses) {
			const remaining = (addresses.get(address) ?? 1) - 1;
			if (remaining > 0) addresses.set(address, remaining);
			else addresses.delete(address);
			if (addresses.size === 0) this.relayAcquisitions.delete(targetId);
		}
		await this.stopUnusedRelayAddress(address);
	}

	private relayAddressInUse(address: string): boolean {
		if (
			[...this.activeLeases.values()].some(
				(active) => active.relayAddress === address,
			)
		) {
			return true;
		}
		for (const addresses of this.relayAcquisitions.values()) {
			if ((addresses.get(address) ?? 0) > 0) return true;
		}
		return false;
	}

	private targetRelayInUse(targetId: string): boolean {
		return (
			[...this.activeLeases.values()].some(
				(active) => active.targetId === targetId,
			) || this.relayAcquisitions.has(targetId)
		);
	}

	private async stopUnusedRelayAddress(address: string): Promise<void> {
		if (this.relayAddressInUse(address)) return;
		for (const [targetId, targetAddress] of this.targetRelayAddresses) {
			if (targetAddress === address && !this.targetRelayInUse(targetId)) {
				this.targetRelayAddresses.delete(targetId);
			}
		}
		if (this.relayAddressInUse(address)) return;
		const server = this.relayServers.get(address);
		if (!server) return;
		await this.stopRelayServer(address, server);
	}

	private stopRelayServer(address: string, server: RelayServer): Promise<void> {
		const existing = this.relayStopPromises.get(address);
		if (existing) return existing;
		if (this.relayServers.get(address) === server) {
			this.relayServers.delete(address);
		}
		const pending = Promise.resolve()
			.then(() => server.stop(true))
			.then(() => undefined)
			.finally(() => {
				if (this.relayStopPromises.get(address) === pending) {
					this.relayStopPromises.delete(address);
				}
			});
		this.relayStopPromises.set(address, pending);
		return pending;
	}

	private async validateLocalModels(
		input: LocalModelValidationInput,
	): Promise<OllamaLocalModelValidation> {
		if (input.route === "models") {
			return this.validateLocalModelEvidence(input);
		}
		const release = await this.acquireInferenceLane(input.signal);
		try {
			const valid = await this.validateLocalModelEvidence(input);
			const active = this.activeLeases.get(input.lease.id);
			const requestedModel =
				input.models.length === 1 ? input.models[0] : undefined;
			const upstreamModel = requestedModel
				? active?.inferenceVariants.get(requestedModel)?.model
				: undefined;
			const validationRelease =
				valid && upstreamModel !== undefined && requestedModel
					? this.keepWarmRelease(active, requestedModel, upstreamModel, release)
					: release;
			return {
				valid: valid && upstreamModel !== undefined,
				release: validationRelease,
				upstreamModel,
			};
		} catch (error) {
			release();
			throw error;
		}
	}

	private keepWarmRelease(
		active: ActiveLease | undefined,
		requestedModel: string,
		upstreamModel: string,
		releaseLane: () => void,
	): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (
				!active ||
				this.activeLeases.get(active.id) !== active ||
				active.inferenceVariants.get(requestedModel)?.model !== upstreamModel
			) {
				releaseLane();
				return;
			}
			void this.manager
				.loadModel(upstreamModel, {
					keepAlive: ollamaKeepAliveValue(active.keepWarm),
				})
				.catch((error) => {
					console.warn(
						"[ollama] OpenCode inference completed, but Hlid could not refresh the model warm period:",
						error instanceof Error ? error.message : String(error),
					);
				})
				.finally(releaseLane);
		};
	}

	private async validateLocalModelEvidence(
		input: LocalModelValidationInput,
	): Promise<boolean> {
		const active = this.activeLeases.get(input.lease.id);
		if (
			!active ||
			active.profileId !== input.lease.profileId ||
			active.targetId !== input.lease.targetId ||
			active.processId !== input.lease.processId
		) {
			return false;
		}
		const localModels = await this.manager.listLocalModels({
			signal: input.signal,
		});
		if (this.activeLeases.get(input.lease.id) !== active) return false;
		for (const model of input.models) {
			const expectedDigest = active.modelDigests.get(model);
			const local = localModels.find(
				(candidate) =>
					(candidate.model === model || candidate.name === model) &&
					candidate.digest === expectedDigest,
			);
			if (!expectedDigest || !local) {
				return false;
			}
			// The lease was issued only after every selected digest passed the
			// OpenCode compatibility preflight. Discovery revalidates the immutable
			// digest without serially repeating up to 64 /api/show requests; chat
			// rechecks compatibility immediately before inference.
			if (input.route === "models") continue;
			try {
				const details = await this.manager.showModel(model, {
					signal: input.signal,
				});
				if (
					!details.capabilities.includes("tools") ||
					details.contextLength === null ||
					details.contextLength < OPENCODE_LOCAL_MODEL_MIN_CONTEXT
				) {
					return false;
				}
			} catch (error) {
				if (
					error instanceof OllamaClientError &&
					error.code === "remote-model"
				) {
					return false;
				}
				throw error;
			}
			if (this.activeLeases.get(input.lease.id) !== active) return false;

			await this.prepareOpenCodeVariant(model, local, input.signal, active);
			if (this.activeLeases.get(input.lease.id) !== active) return false;
		}
		return true;
	}
}
