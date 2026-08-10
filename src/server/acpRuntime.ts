import {
	type ParseError,
	parse as parseJsonc,
	printParseErrorCode,
} from "jsonc-parser";
import type { HlidConfig } from "../config";
import { AcpProvider } from "./acpProvider";
import type { AcpCatalogItem } from "./acpRegistry";
import type { AgentProvider } from "./agentProvider";

const OPENCODE_CONFIG_CONTENT = "OPENCODE_CONFIG_CONTENT";
const MAX_OPENCODE_CONFIG_CONTENT_LENGTH = 24_000;
const PROTOTYPE_SPECIAL_PROVIDER_IDS = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class OpenCodeConfigOverlayError extends Error {
	constructor(detail: string) {
		super(`Cannot apply Hlid's OpenCode model filter: ${detail}`);
		this.name = "OpenCodeConfigOverlayError";
	}
}

function parseOpenCodeConfig(content: string | undefined): JsonObject {
	if (!content?.trim()) return {};
	const errors: ParseError[] = [];
	const parsed = parseJsonc(content, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	const firstError = errors[0];
	if (firstError) {
		throw new OpenCodeConfigOverlayError(
			`${OPENCODE_CONFIG_CONTENT} is invalid JSON or JSONC (${printParseErrorCode(firstError.error)}). Fix or remove that ACP environment override.`,
		);
	}
	if (!isJsonObject(parsed)) {
		throw new OpenCodeConfigOverlayError(
			`${OPENCODE_CONFIG_CONTENT} must contain a JSON object. Fix or remove that ACP environment override.`,
		);
	}
	return parsed;
}

function groupedOpenCodeModels(models: string[]): Map<string, string[]> {
	const grouped = new Map<string, Set<string>>();
	for (const fullId of models) {
		const separator = fullId.indexOf("/");
		if (separator <= 0 || separator === fullId.length - 1) {
			throw new OpenCodeConfigOverlayError(
				`model ID ${JSON.stringify(fullId)} must include a provider and model separated by "/".`,
			);
		}
		const providerId = fullId.slice(0, separator);
		const modelId = fullId.slice(separator + 1);
		if (PROTOTYPE_SPECIAL_PROVIDER_IDS.has(providerId)) {
			throw new OpenCodeConfigOverlayError(
				`provider ID ${JSON.stringify(providerId)} is reserved and cannot be used in a model filter.`,
			);
		}
		const providerModels = grouped.get(providerId) ?? new Set<string>();
		providerModels.add(modelId);
		grouped.set(providerId, providerModels);
	}
	return new Map(
		[...grouped.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([providerId, providerModels]) => [
				providerId,
				[...providerModels].sort((a, b) => a.localeCompare(b)),
			]),
	);
}

function configuredStringList(
	value: unknown,
	path: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new OpenCodeConfigOverlayError(
			`${path} must be an array of strings. Fix or remove that ACP environment override.`,
		);
	}
	return [...new Set(value)].sort((a, b) => a.localeCompare(b));
}

function intersectLists(left: string[], right: string[]): string[] {
	const allowed = new Set(right);
	return left.filter((item) => allowed.has(item));
}

function unionLists(left: string[], right: string[]): string[] {
	return [...new Set([...left, ...right])].sort((a, b) => a.localeCompare(b));
}

function openCodeModelFilterContent(
	content: string | undefined,
	filter: NonNullable<
		NonNullable<HlidConfig["acp_agents"]>[number]["model_filter"]
	>,
): string {
	const grouped = groupedOpenCodeModels(filter.models);
	if (filter.mode === "only" && grouped.size === 0) {
		throw new OpenCodeConfigOverlayError(
			'"Only selected" requires at least one model.',
		);
	}
	if (grouped.size === 0) return content ?? "";

	const base = parseOpenCodeConfig(content);
	const existingProvider = base.provider;
	if (existingProvider !== undefined && !isJsonObject(existingProvider)) {
		throw new OpenCodeConfigOverlayError(
			`${OPENCODE_CONFIG_CONTENT}.provider must be a JSON object. Fix or remove that ACP environment override.`,
		);
	}
	const provider = Object.assign(
		Object.create(null) as JsonObject,
		existingProvider ?? {},
	);
	const desiredProviders = [...grouped.keys()];
	const existingEnabled =
		filter.mode === "only"
			? configuredStringList(
					base.enabled_providers,
					`${OPENCODE_CONFIG_CONTENT}.enabled_providers`,
				)
			: undefined;
	const existingDisabled =
		filter.mode === "only"
			? (configuredStringList(
					base.disabled_providers,
					`${OPENCODE_CONFIG_CONTENT}.disabled_providers`,
				) ?? [])
			: [];
	const enabledProviders = existingEnabled
		? intersectLists(desiredProviders, existingEnabled)
		: desiredProviders;
	const disabledProviders = new Set(existingDisabled);
	let usableOnlyModel = false;
	for (const [providerId, models] of grouped) {
		const existingEntry = provider[providerId];
		if (existingEntry !== undefined && !isJsonObject(existingEntry)) {
			throw new OpenCodeConfigOverlayError(
				`${OPENCODE_CONFIG_CONTENT}.provider.${providerId} must be a JSON object. Fix or remove that ACP environment override.`,
			);
		}
		const entry = Object.assign(
			Object.create(null) as JsonObject,
			existingEntry ?? {},
		);
		const existingBlacklist =
			configuredStringList(
				entry.blacklist,
				`${OPENCODE_CONFIG_CONTENT}.provider.${providerId}.blacklist`,
			) ?? [];
		if (filter.mode === "hide") {
			entry.blacklist = unionLists(existingBlacklist, models);
		} else {
			const existingWhitelist = configuredStringList(
				entry.whitelist,
				`${OPENCODE_CONFIG_CONTENT}.provider.${providerId}.whitelist`,
			);
			const whitelist = existingWhitelist
				? intersectLists(models, existingWhitelist)
				: models;
			entry.whitelist = whitelist;
			if (
				enabledProviders.includes(providerId) &&
				!disabledProviders.has(providerId) &&
				whitelist.some((model) => !existingBlacklist.includes(model))
			) {
				usableOnlyModel = true;
			}
		}
		provider[providerId] = entry;
	}
	if (filter.mode === "only" && !usableOnlyModel) {
		throw new OpenCodeConfigOverlayError(
			`existing inline provider restrictions exclude every selected model. Change the Hlid selection or choose "Use all".`,
		);
	}

	const overlaid: JsonObject = {
		...base,
		...(filter.mode === "only" ? { enabled_providers: enabledProviders } : {}),
		provider,
	};
	const serialized = JSON.stringify(overlaid);
	if (serialized.length > MAX_OPENCODE_CONFIG_CONTENT_LENGTH) {
		throw new OpenCodeConfigOverlayError(
			`the merged ${OPENCODE_CONFIG_CONTENT} is ${serialized.length.toLocaleString()} characters; reduce the selection so it stays at or below ${MAX_OPENCODE_CONFIG_CONTENT_LENGTH.toLocaleString()} characters.`,
		);
	}
	return serialized;
}

/**
 * Compose the registry invocation, Hlid's explicit environment overrides, and
 * the Hlid-only OpenCode model visibility overlay without touching native
 * OpenCode config files.
 */
export function effectiveAcpEnvironment(
	item: AcpCatalogItem,
	config: HlidConfig,
	inheritedEnvironment: Readonly<
		Record<string, string | undefined>
	> = process.env,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	const configured = (config.acp_agents ?? []).find(
		(agent) => agent.id === item.id,
	);
	const environment = { ...item.env, ...configured?.env };
	if (item.id !== "opencode" || !configured?.model_filter) return environment;
	const { environment: normalizedEnvironment, content: existingContent } =
		openCodeBaseEnvironment(
			item.env,
			configured.env,
			inheritedEnvironment,
			platform,
		);
	return {
		...normalizedEnvironment,
		[OPENCODE_CONFIG_CONTENT]: openCodeModelFilterContent(
			existingContent,
			configured.model_filter,
		),
	};
}

function openCodeEnvironmentValue(
	environment: Readonly<Record<string, string | undefined>> | undefined,
	platform: NodeJS.Platform,
): string | undefined {
	if (!environment) return undefined;
	if (platform !== "win32") return environment[OPENCODE_CONFIG_CONTENT];
	if (Object.hasOwn(environment, OPENCODE_CONFIG_CONTENT)) {
		return environment[OPENCODE_CONFIG_CONTENT];
	}
	for (const [key, value] of Object.entries(environment)) {
		if (key.toUpperCase() === OPENCODE_CONFIG_CONTENT) return value;
	}
	return undefined;
}

function openCodeBaseEnvironment(
	itemEnvironment: Readonly<Record<string, string>>,
	configuredEnvironment: Readonly<Record<string, string>> | undefined,
	inheritedEnvironment: Readonly<Record<string, string | undefined>>,
	platform: NodeJS.Platform,
): { environment: Record<string, string>; content: string | undefined } {
	const merged = { ...itemEnvironment, ...configuredEnvironment };
	const content =
		openCodeEnvironmentValue(configuredEnvironment, platform) ??
		openCodeEnvironmentValue(itemEnvironment, platform) ??
		openCodeEnvironmentValue(inheritedEnvironment, platform);
	if (platform !== "win32") return { environment: merged, content };
	return {
		environment: Object.fromEntries(
			Object.entries(merged).filter(
				([key]) => key.toUpperCase() !== OPENCODE_CONFIG_CONTENT,
			),
		),
		content,
	};
}

/** Validate the user-controlled/inherited OpenCode overlay before persistence. */
export function preflightOpenCodeModelFilter(
	config: HlidConfig,
	inheritedEnvironment: Readonly<
		Record<string, string | undefined>
	> = process.env,
	platform: NodeJS.Platform = process.platform,
): void {
	const configured = (config.acp_agents ?? []).find(
		(agent) => agent.id === "opencode",
	);
	if (!configured?.model_filter) return;
	const { content } = openCodeBaseEnvironment(
		{},
		configured.env,
		inheritedEnvironment,
		platform,
	);
	openCodeModelFilterContent(content, configured.model_filter);
}

export function acpRuntimeFingerprint(
	item: AcpCatalogItem,
	config: HlidConfig,
): string {
	const configured = (config.acp_agents ?? []).find(
		(agent) => agent.id === item.id,
	);
	const rawEnvironment = { ...item.env, ...configured?.env };
	const environment = configured?.model_filter
		? openCodeBaseEnvironment(
				item.env,
				configured.env,
				process.env,
				process.platform,
			).environment
		: rawEnvironment;
	if (configured?.model_filter) {
		const content =
			openCodeEnvironmentValue(configured.env, process.platform) ??
			openCodeEnvironmentValue(item.env, process.platform) ??
			openCodeEnvironmentValue(process.env, process.platform);
		if (content !== undefined) environment[OPENCODE_CONFIG_CONTENT] = content;
	}
	return JSON.stringify({
		providerId: item.providerId,
		label: item.name,
		command: item.command,
		args: item.args,
		env: Object.fromEntries(
			Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
		),
		modelFilter: configured?.model_filter
			? {
					mode: configured.model_filter.mode,
					models: [...configured.model_filter.models].sort((a, b) =>
						a.localeCompare(b),
					),
				}
			: undefined,
		discoveryCwd: config.vault.path || process.cwd(),
	});
}

export function createConfiguredAcpProvider(
	item: AcpCatalogItem,
	config: HlidConfig,
): AcpProvider {
	const configured = (config.acp_agents ?? []).find(
		(agent) => agent.id === item.id,
	);
	let overlayError: OpenCodeConfigOverlayError | undefined;
	try {
		effectiveAcpEnvironment(item, config);
	} catch (error) {
		if (!(error instanceof OpenCodeConfigOverlayError)) throw error;
		overlayError = error;
	}
	return new AcpProvider({
		id: item.providerId,
		label: item.name,
		command: item.command,
		args: item.args,
		env: () => effectiveAcpEnvironment(item, config),
		modelFilter: configured?.model_filter,
		initialAvailability: {
			available: overlayError ? false : item.available,
			...(overlayError
				? { reason: overlayError.message }
				: item.unavailableReason
					? { reason: item.unavailableReason }
					: {}),
		},
		discoveryCwd: config.vault.path || process.cwd(),
		metadataCacheIdentity: acpRuntimeFingerprint(item, config),
	});
}

export type AcpRuntimeSyncResult = {
	added: string[];
	removed: string[];
	replaced: string[];
};

/** Reconcile only Hlid-managed registry ACP providers, preserving native providers. */
export async function syncAcpRuntimeProviders(options: {
	config: HlidConfig;
	catalog: AcpCatalogItem[];
	providers: Map<string, AgentProvider>;
	fingerprints: Map<string, string>;
	retireProviderSessions: (
		providerIds: Iterable<string>,
		options?: { preserveSelection?: boolean },
	) => void | Promise<void>;
	registerProvider: (provider: AgentProvider, replaced: boolean) => void;
}): Promise<AcpRuntimeSyncResult> {
	const desired = new Map(
		options.catalog
			.filter((item) => item.enabled)
			.map((item) => [
				item.providerId,
				{
					item,
					fingerprint: acpRuntimeFingerprint(item, options.config),
				},
			]),
	);
	// Validate every replacement before retiring a live provider. A malformed or
	// conflicting inline OpenCode config should produce a save warning while the
	// previous runtime remains available.
	for (const { item } of desired.values()) {
		effectiveAcpEnvironment(item, options.config);
	}
	const removed: string[] = [];
	const replaced: string[] = [];
	for (const [providerId, fingerprint] of options.fingerprints) {
		const next = desired.get(providerId);
		if (!next) removed.push(providerId);
		else if (next.fingerprint !== fingerprint) replaced.push(providerId);
	}
	for (const providerId of [...removed, ...replaced]) {
		options.providers.delete(providerId);
		options.fingerprints.delete(providerId);
	}
	if (removed.length > 0) await options.retireProviderSessions(removed);
	if (replaced.length > 0) {
		await options.retireProviderSessions(replaced, { preserveSelection: true });
	}

	const added: string[] = [];
	for (const [providerId, next] of desired) {
		if (options.fingerprints.has(providerId)) continue;
		const wasReplaced = replaced.includes(providerId);
		const provider = createConfiguredAcpProvider(next.item, options.config);
		options.providers.set(providerId, provider);
		options.fingerprints.set(providerId, next.fingerprint);
		options.registerProvider(provider, wasReplaced);
		if (!wasReplaced) added.push(providerId);
	}
	return { added, removed, replaced };
}
