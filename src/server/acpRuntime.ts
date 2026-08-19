import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import {
	type ParseError,
	parse as parseJsonc,
	printParseErrorCode,
} from "jsonc-parser";
import type { HlidConfig } from "../config";
import {
	type AcpExecutionTarget,
	acpExecutionTargetKey,
	acpExecutionTargetLabel,
	HOST_ACP_EXECUTION_TARGET,
} from "../lib/acpExecutionTarget";
import {
	OLLAMA_INFERENCE_RELAY_PORT,
	OLLAMA_MAX_CONTEXT_LENGTH,
	OLLAMA_OPENCODE_ACP_INSPECTION_TIMEOUT_MS,
	OLLAMA_OPENCODE_ACP_PREPARATION_TIMEOUT_MS,
	OPENCODE_LOCAL_MODEL_OUTPUT_LIMIT,
	ollamaModelNameHasWhitespaceOrControl,
} from "../lib/ollama";
import { declaredPathKey, parseWslUncSyntax } from "../lib/paths";
import { type AcpProcessEnvironment, AcpProvider } from "./acpProvider";
import type { AcpCatalogItem, AcpCatalogTargetStatus } from "./acpRegistry";
import type {
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	ForkSessionParams,
	ForkSessionResult,
	ProviderForkCapability,
	ProviderModelInfo,
} from "./agentProvider";
import {
	createOpenCodeGoUsageReader,
	OPENCODE_GO_USAGE_WINDOWS,
	type OpenCodeGoUsageReader,
	unavailableOpenCodeGoUsageReadings,
} from "./openCodeGoUsage";

const OPENCODE_CONFIG_CONTENT = "OPENCODE_CONFIG_CONTENT";
export const HLID_OLLAMA_OPEN_CODE_PROVIDER_ID = "hlid-ollama";
export const HLID_OLLAMA_RELAY_TOKEN_ENV = "HLID_OLLAMA_RELAY_TOKEN";
const MAX_OPENCODE_CONFIG_CONTENT_LENGTH = 24_000;
const RUNTIME_ROOT_ENVIRONMENT_KEYS = [
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"APPDATA",
	"LOCALAPPDATA",
	"OPENCODE_CONFIG",
	"OPENCODE_CONFIG_DIR",
] as const;
const OPENCODE_RUNTIME_FLAG_KEYS = [
	"OPENCODE_DISABLE_PROJECT_CONFIG",
	"OPENCODE_PURE",
] as const;
const PROTOTYPE_SPECIAL_PROVIDER_IDS = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

type JsonObject = Record<string, unknown>;

type ConfiguredAcpAgent = NonNullable<HlidConfig["acp_agents"]>[number];

export type AcpWorkspaceEnvironmentResolver = (input: {
	item: AcpCatalogItem;
	config: HlidConfig;
	target: AcpExecutionTarget;
	cwd: string;
	environment: Record<string, string>;
	signal?: AbortSignal;
}) => AcpProcessEnvironment | Promise<AcpProcessEnvironment>;

export type ConfiguredAcpProviderOptions = {
	resolveEnvironment?: AcpWorkspaceEnvironmentResolver;
};

type AcpRuntimeTarget = Pick<
	AcpCatalogTargetStatus,
	| "targetId"
	| "target"
	| "label"
	| "selected"
	| "available"
	| "resolvedExecutable"
	| "command"
	| "args"
	| "env"
	| "platformTarget"
	| "blockedReason"
	| "cleanupOnly"
>;

export type AcpWorkspaceRuntime = {
	target: AcpExecutionTarget;
	targetId: string;
	label: string;
	available: boolean;
	reason?: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	discoveryCwd: string;
	metadataCacheIdentity: string;
	sessionContinuityIdentity: string;
};

export class AcpWorkspaceRuntimeError extends Error {
	constructor(detail: string) {
		super(detail);
		this.name = "AcpWorkspaceRuntimeError";
	}
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class OpenCodeConfigOverlayError extends Error {
	constructor(detail: string) {
		super(`Cannot apply Hlid's OpenCode configuration overlay: ${detail}`);
		this.name = "OpenCodeConfigOverlayError";
	}
}

export type OpenCodeOllamaModel = {
	id: string;
	name?: string;
	contextLength?: number | null;
	outputLength?: number | null;
};

export type OpenCodeOllamaProviderInput = {
	baseUrl: string;
	models: readonly OpenCodeOllamaModel[];
	/** Name only. The credential value remains launch-scoped subprocess state. */
	apiKeyEnvironmentVariable?: string;
};

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

function openCodeProviderConfig(content: string | undefined): {
	base: JsonObject;
	provider: JsonObject;
} {
	const base = parseOpenCodeConfig(content);
	const existingProvider = base.provider;
	if (existingProvider !== undefined && !isJsonObject(existingProvider)) {
		throw new OpenCodeConfigOverlayError(
			`${OPENCODE_CONFIG_CONTENT}.provider must be a JSON object. Fix or remove that ACP environment override.`,
		);
	}
	return {
		base,
		provider: Object.assign(
			Object.create(null) as JsonObject,
			existingProvider ?? {},
		),
	};
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

function openCodeWildcardMatches(pattern: string, value: string): boolean {
	let patternIndex = 0;
	let valueIndex = 0;
	let starIndex = -1;
	let starValueIndex = -1;
	while (valueIndex < value.length) {
		const patternCharacter = pattern[patternIndex];
		if (
			patternCharacter === "?" ||
			(patternCharacter !== undefined && patternCharacter === value[valueIndex])
		) {
			patternIndex += 1;
			valueIndex += 1;
			continue;
		}
		if (patternCharacter === "*") {
			starIndex = patternIndex;
			starValueIndex = valueIndex;
			patternIndex += 1;
			continue;
		}
		if (starIndex >= 0) {
			patternIndex = starIndex + 1;
			starValueIndex += 1;
			valueIndex = starValueIndex;
			continue;
		}
		return false;
	}
	while (pattern[patternIndex] === "*") patternIndex += 1;
	return patternIndex === pattern.length;
}

function openCodeInlinePolicyAllowsProvider(
	base: JsonObject,
	providerId: string,
): boolean {
	const experimental = base.experimental;
	if (experimental === undefined) return true;
	if (!isJsonObject(experimental)) {
		throw new OpenCodeConfigOverlayError(
			`${OPENCODE_CONFIG_CONTENT}.experimental must be a JSON object. Fix or remove that ACP environment override.`,
		);
	}
	const policies = experimental.policies;
	if (policies === undefined) return true;
	if (!Array.isArray(policies)) {
		throw new OpenCodeConfigOverlayError(
			`${OPENCODE_CONFIG_CONTENT}.experimental.policies must be an array. Fix or remove that ACP environment override.`,
		);
	}

	let allowed = true;
	for (const [index, value] of policies.entries()) {
		const path = `${OPENCODE_CONFIG_CONTENT}.experimental.policies[${index}]`;
		if (!isJsonObject(value)) {
			throw new OpenCodeConfigOverlayError(
				`${path} must be a JSON object. Fix or remove that ACP environment override.`,
			);
		}
		if (value.effect !== "allow" && value.effect !== "deny") {
			throw new OpenCodeConfigOverlayError(
				`${path}.effect must be "allow" or "deny". Fix or remove that ACP environment override.`,
			);
		}
		if (value.action !== "provider.use") {
			throw new OpenCodeConfigOverlayError(
				`${path}.action must be "provider.use". Fix or remove that ACP environment override.`,
			);
		}
		if (typeof value.resource !== "string") {
			throw new OpenCodeConfigOverlayError(
				`${path}.resource must be a string. Fix or remove that ACP environment override.`,
			);
		}
		if (openCodeWildcardMatches(value.resource, providerId)) {
			allowed = value.effect === "allow";
		}
	}
	return allowed;
}

function intersectLists(left: string[], right: string[]): string[] {
	const allowed = new Set(right);
	return left.filter((item) => allowed.has(item));
}

function unionLists(left: string[], right: string[]): string[] {
	return [...new Set([...left, ...right])].sort((a, b) => a.localeCompare(b));
}

function configuredAcpAgent(config: HlidConfig, id: string) {
	return (config.acp_agents ?? []).find((agent) => agent.id === id);
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

	const { base, provider } = openCodeProviderConfig(content);
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

function openCodeModelLimit(
	value: number | null | undefined,
): number | undefined {
	return Number.isSafeInteger(value) && Number(value) > 0
		? Number(value)
		: undefined;
}

/**
 * Add Hlid's reserved Windows Ollama provider to a launch-scoped OpenCode
 * overlay. This never edits OpenCode's native configuration and never embeds a
 * relay credential in the JSON payload.
 */
export function withOpenCodeOllamaProvider(
	environment: Readonly<Record<string, string>>,
	input: OpenCodeOllamaProviderInput,
	platform: NodeJS.Platform,
): Record<string, string> {
	let baseUrl: URL;
	try {
		baseUrl = new URL(input.baseUrl);
	} catch {
		throw new OpenCodeConfigOverlayError(
			"the Hlid Ollama endpoint is not a valid URL.",
		);
	}
	if (
		baseUrl.protocol !== "http:" ||
		baseUrl.username ||
		baseUrl.password ||
		baseUrl.search ||
		baseUrl.hash ||
		!baseUrl.hostname ||
		baseUrl.pathname.replace(/\/$/, "") !== "/v1"
	) {
		throw new OpenCodeConfigOverlayError(
			"the Hlid Ollama endpoint must be an HTTP /v1 base URL without credentials, query parameters, or a fragment.",
		);
	}
	if (input.models.length === 0) {
		throw new OpenCodeConfigOverlayError(
			"at least one Windows Ollama model must be selected.",
		);
	}
	if (
		input.apiKeyEnvironmentVariable !== undefined &&
		!/^[A-Z_][A-Z0-9_]*$/.test(input.apiKeyEnvironmentVariable)
	) {
		throw new OpenCodeConfigOverlayError(
			"the Hlid Ollama relay credential environment name is invalid.",
		);
	}

	const { environment: normalizedEnvironment, content } =
		openCodeBaseEnvironment(environment, undefined, {}, platform);
	const { base, provider } = openCodeProviderConfig(content);
	const existingReserved = provider[HLID_OLLAMA_OPEN_CODE_PROVIDER_ID];
	if (existingReserved !== undefined && !isJsonObject(existingReserved)) {
		throw new OpenCodeConfigOverlayError(
			`${OPENCODE_CONFIG_CONTENT}.provider.${HLID_OLLAMA_OPEN_CODE_PROVIDER_ID} is reserved by Hlid and must not be configured manually.`,
		);
	}
	const preservedRestrictions = Object.create(null) as JsonObject;
	if (existingReserved) {
		for (const [key, value] of Object.entries(existingReserved)) {
			if (key !== "whitelist" && key !== "blacklist") {
				throw new OpenCodeConfigOverlayError(
					`${OPENCODE_CONFIG_CONTENT}.provider.${HLID_OLLAMA_OPEN_CODE_PROVIDER_ID} is reserved by Hlid; remove its manually configured ${JSON.stringify(key)} field.`,
				);
			}
			preservedRestrictions[key] = configuredStringList(
				value,
				`${OPENCODE_CONFIG_CONTENT}.provider.${HLID_OLLAMA_OPEN_CODE_PROVIDER_ID}.${key}`,
			);
		}
	}

	const modelEntries = Object.create(null) as JsonObject;
	for (const model of [...input.models].sort((a, b) =>
		a.id.localeCompare(b.id),
	)) {
		if (
			!model.id ||
			model.id !== model.id.trim() ||
			model.id.length > 256 ||
			ollamaModelNameHasWhitespaceOrControl(model.id)
		) {
			throw new OpenCodeConfigOverlayError(
				"a selected Windows Ollama model name is invalid.",
			);
		}
		if (Object.hasOwn(modelEntries, model.id)) {
			throw new OpenCodeConfigOverlayError(
				`Windows Ollama model ${JSON.stringify(model.id)} was selected more than once.`,
			);
		}
		const context = openCodeModelLimit(model.contextLength);
		const output =
			openCodeModelLimit(model.outputLength) ??
			(context ? OPENCODE_LOCAL_MODEL_OUTPUT_LIMIT : undefined);
		if (output && !context) {
			throw new OpenCodeConfigOverlayError(
				`Windows Ollama model ${JSON.stringify(model.id)} cannot declare an OpenCode output limit without a context limit.`,
			);
		}
		modelEntries[model.id] = {
			name: model.name?.trim() || model.id,
			...(context || output
				? {
						limit: {
							...(context ? { context } : {}),
							...(output ? { output } : {}),
						},
					}
				: {}),
		};
	}
	const enabledProviders = configuredStringList(
		base.enabled_providers,
		`${OPENCODE_CONFIG_CONTENT}.enabled_providers`,
	);
	const disabledProviders =
		configuredStringList(
			base.disabled_providers,
			`${OPENCODE_CONFIG_CONTENT}.disabled_providers`,
		) ?? [];
	const inlinePolicyAllowsProvider = openCodeInlinePolicyAllowsProvider(
		base,
		HLID_OLLAMA_OPEN_CODE_PROVIDER_ID,
	);
	if (
		(enabledProviders &&
			!enabledProviders.includes(HLID_OLLAMA_OPEN_CODE_PROVIDER_ID)) ||
		disabledProviders.includes(HLID_OLLAMA_OPEN_CODE_PROVIDER_ID) ||
		!inlinePolicyAllowsProvider
	) {
		throw new OpenCodeConfigOverlayError(
			"existing inline provider restrictions disable Hlid's Ollama provider. Change the OpenCode configuration before connecting Ollama models.",
		);
	}
	const reservedWhitelist = configuredStringList(
		preservedRestrictions.whitelist,
		`${OPENCODE_CONFIG_CONTENT}.provider.${HLID_OLLAMA_OPEN_CODE_PROVIDER_ID}.whitelist`,
	);
	const reservedBlacklist =
		configuredStringList(
			preservedRestrictions.blacklist,
			`${OPENCODE_CONFIG_CONTENT}.provider.${HLID_OLLAMA_OPEN_CODE_PROVIDER_ID}.blacklist`,
		) ?? [];
	if (
		Object.keys(modelEntries).some(
			(model) =>
				(reservedWhitelist && !reservedWhitelist.includes(model)) ||
				reservedBlacklist.includes(model),
		)
	) {
		throw new OpenCodeConfigOverlayError(
			"existing inline model restrictions exclude one or more connected Ollama models. Change the OpenCode configuration or disconnect those models.",
		);
	}

	provider[HLID_OLLAMA_OPEN_CODE_PROVIDER_ID] = {
		...preservedRestrictions,
		npm: "@ai-sdk/openai-compatible",
		name: "Ollama on Windows",
		options: {
			baseURL: baseUrl.toString().replace(/\/$/, ""),
			...(input.apiKeyEnvironmentVariable
				? { apiKey: `{env:${input.apiKeyEnvironmentVariable}}` }
				: {}),
		},
		models: modelEntries,
	};
	const serialized = JSON.stringify({ ...base, provider });
	if (serialized.length > MAX_OPENCODE_CONFIG_CONTENT_LENGTH) {
		throw new OpenCodeConfigOverlayError(
			`the merged ${OPENCODE_CONFIG_CONTENT} is ${serialized.length.toLocaleString()} characters; reduce the selected Ollama models so it stays at or below ${MAX_OPENCODE_CONFIG_CONTENT_LENGTH.toLocaleString()} characters.`,
		);
	}
	return {
		...normalizedEnvironment,
		[OPENCODE_CONFIG_CONTENT]: serialized,
	};
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
	platform?: NodeJS.Platform,
	applyModelFilter = true,
	applyConfiguredEnvironment = true,
	useInheritedEnvironment = true,
): Record<string, string> {
	const configured = configuredAcpAgent(config, item.id);
	const ollama =
		item.id === "opencode" && configured ? config.ollama : undefined;
	const targetPlatform = platform ?? acpTargetPlatform(configured?.target);
	const configuredEnvironment = applyConfiguredEnvironment
		? configured?.env
		: undefined;
	const environment = { ...item.env, ...configuredEnvironment };
	if (
		!applyModelFilter ||
		item.id !== "opencode" ||
		!configured ||
		(!configured?.model_filter && !ollama)
	)
		return environment;
	const { environment: normalizedEnvironment, content: existingContent } =
		openCodeBaseEnvironment(
			item.env,
			configuredEnvironment,
			useInheritedEnvironment ? inheritedEnvironment : {},
			targetPlatform,
		);
	return {
		...normalizedEnvironment,
		...(configured.model_filter
			? {
					[OPENCODE_CONFIG_CONTENT]: openCodeModelFilterContent(
						existingContent,
						configured.model_filter,
					),
				}
			: existingContent !== undefined
				? { [OPENCODE_CONFIG_CONTENT]: existingContent }
				: {}),
	};
}

function acpTargetPlatform(
	target: AcpExecutionTarget | undefined,
): NodeJS.Platform {
	return target?.kind === "wsl" ? "linux" : process.platform;
}

function configuredWorkspacePaths(config: HlidConfig): string[] {
	return [
		config.vault.path,
		...config.agents.map((agent) => agent.path),
	].filter(Boolean);
}

/** Resolve an exact execution environment from workspace syntax without fallback. */
export function acpExecutionTargetForWorkspace(
	cwd: string,
	_config: HlidConfig,
	hostPlatform: NodeJS.Platform = process.platform,
): AcpExecutionTarget {
	const wsl = parseWslUncSyntax(cwd);
	if (wsl) return { kind: "wsl", distro: wsl.distro };
	if (/^(?:\\\\|\/\/)(?:wsl\$|wsl\.localhost)(?:[\\/]|$)/i.test(cwd)) {
		throw new AcpWorkspaceRuntimeError(
			`ACP workspace ${JSON.stringify(cwd)} is not a valid WSL UNC path. Use its exact \\wsl.localhost\\<distro>\\<path> workspace path.`,
		);
	}
	if (/^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\")) {
		return HOST_ACP_EXECUTION_TARGET;
	}
	if (posix.isAbsolute(cwd) && !cwd.startsWith("//")) {
		if (hostPlatform !== "win32") return HOST_ACP_EXECUTION_TARGET;
		throw new AcpWorkspaceRuntimeError(
			`ACP workspace ${JSON.stringify(cwd)} is a bare POSIX path on Windows. Use its exact \\wsl.localhost\\<distro>\\<path> workspace path.`,
		);
	}
	throw new AcpWorkspaceRuntimeError(
		`ACP workspace ${JSON.stringify(cwd)} is not an absolute Windows or WSL path.`,
	);
}

function acpTargetDiscoveryCwd(
	config: HlidConfig,
	target: AcpExecutionTarget,
): string {
	const paths = configuredWorkspacePaths(config);
	if (target.kind === "wsl") {
		const distro = target.distro.toLowerCase();
		const workspace = paths.find(
			(path) => parseWslUncSyntax(path)?.distro.toLowerCase() === distro,
		);
		if (workspace) return workspace;
		throw new AcpWorkspaceRuntimeError(
			`ACP has no configured workspace in ${acpExecutionTargetLabel(target)}.`,
		);
	}
	const workspace = paths.find((path) => {
		if (parseWslUncSyntax(path)) return false;
		return process.platform === "win32"
			? /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\")
			: posix.isAbsolute(path) && !path.startsWith("//");
	});
	// A same-environment host directory is valid for registry metadata when all
	// configured workspaces belong to WSL. Never borrow one of those WSL roots.
	return workspace ?? homedir();
}

export function acpDiscoveryCwd(
	config: HlidConfig,
	configured: ConfiguredAcpAgent | undefined,
): string {
	return acpTargetDiscoveryCwd(
		config,
		configured?.target ?? HOST_ACP_EXECUTION_TARGET,
	);
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

function runtimeEnvironmentValue(
	environment: Readonly<Record<string, string | undefined>>,
	key: string,
): string | undefined {
	if (process.platform !== "win32") return environment[key];
	return Object.entries(environment).find(
		([candidate]) => candidate.toUpperCase() === key.toUpperCase(),
	)?.[1];
}

function runtimeRootIdentity(
	environment: Readonly<Record<string, string | undefined>>,
	includeOpenCode: boolean,
): { paths: Record<string, string>; flags?: Record<string, string> } {
	const values = Object.fromEntries(
		RUNTIME_ROOT_ENVIRONMENT_KEYS.flatMap((key) => {
			const value = runtimeEnvironmentValue(environment, key)?.trim();
			return value ? [[key, value] as const] : [];
		}),
	);
	const driveHome =
		values.HOMEDRIVE && values.HOMEPATH
			? `${values.HOMEDRIVE}${values.HOMEPATH}`
			: undefined;
	const home = values.HOME ?? values.USERPROFILE ?? driveHome ?? homedir();
	const roots = {
		home,
		config: values.XDG_CONFIG_HOME ?? join(home, ".config"),
		data: values.XDG_DATA_HOME ?? join(home, ".local", "share"),
		state: values.XDG_STATE_HOME ?? join(home, ".local", "state"),
		cache: values.XDG_CACHE_HOME ?? join(home, ".cache"),
		...(values.APPDATA ? { appData: values.APPDATA } : {}),
		...(values.LOCALAPPDATA ? { localAppData: values.LOCALAPPDATA } : {}),
		...(includeOpenCode && values.OPENCODE_CONFIG
			? { openCodeConfig: values.OPENCODE_CONFIG }
			: {}),
		...(includeOpenCode && values.OPENCODE_CONFIG_DIR
			? { openCodeConfigDir: values.OPENCODE_CONFIG_DIR }
			: {}),
	};
	const paths = Object.fromEntries(
		Object.entries(roots).map(([key, value]) => [key, declaredPathKey(value)]),
	);
	const flags = includeOpenCode
		? Object.fromEntries(
				OPENCODE_RUNTIME_FLAG_KEYS.flatMap((key) => {
					const value = runtimeEnvironmentValue(environment, key)?.trim();
					return value ? [[key, value.toLowerCase()] as const] : [];
				}),
			)
		: {};
	return {
		paths,
		...(Object.keys(flags).length > 0 ? { flags } : {}),
	};
}

function digestRuntimeValue(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function preflightOpenCodeOllamaProvider(
	environment: Readonly<Record<string, string>>,
	config: HlidConfig,
	platform: NodeJS.Platform,
): void {
	const configured = configuredAcpAgent(config, "opencode");
	const ollama = configured ? config.ollama : undefined;
	if (!ollama) return;
	withOpenCodeOllamaProvider(
		environment,
		{
			baseUrl: `http://127.0.0.1:${OLLAMA_INFERENCE_RELAY_PORT}/v1`,
			models: ollama.models.map((id) => ({
				id,
				contextLength: OLLAMA_MAX_CONTEXT_LENGTH,
				outputLength: OPENCODE_LOCAL_MODEL_OUTPUT_LIMIT,
			})),
			apiKeyEnvironmentVariable: HLID_OLLAMA_RELAY_TOKEN_ENV,
		},
		platform,
	);
}

/** Validate the user-controlled/inherited OpenCode overlay before persistence. */
export function preflightOpenCodeConfiguration(
	config: HlidConfig,
	inheritedEnvironment: Readonly<
		Record<string, string | undefined>
	> = process.env,
	platform?: NodeJS.Platform,
): void {
	const configured = configuredAcpAgent(config, "opencode");
	if (!configured) return;
	const ollama = config.ollama;
	if (!configured?.model_filter && !ollama) return;
	const targetPlatform = platform ?? acpTargetPlatform(configured?.target);
	const { environment, content } = openCodeBaseEnvironment(
		{},
		configured.env,
		configured.target?.kind === "wsl" ? {} : inheritedEnvironment,
		targetPlatform,
	);
	const filteredContent = configured.model_filter
		? openCodeModelFilterContent(content, configured.model_filter)
		: content;
	if (!ollama) return;
	preflightOpenCodeOllamaProvider(
		{
			...environment,
			...(filteredContent !== undefined
				? { [OPENCODE_CONFIG_CONTENT]: filteredContent }
				: {}),
		},
		config,
		targetPlatform,
	);
}

function validateSelectedAcpEnvironment(
	item: AcpCatalogItem,
	config: HlidConfig,
): void {
	const target = selectedTargetStatus(item);
	effectiveAcpEnvironment(
		{ ...item, env: target.env },
		config,
		process.env,
		acpTargetPlatform(target.target),
		true,
		target.selected,
		target.target.kind !== "wsl",
	);
}

function targetStatusFor(
	item: AcpCatalogItem,
	target: AcpExecutionTarget,
): AcpRuntimeTarget | undefined {
	const key = acpExecutionTargetKey(target);
	const status = item.targets.find(
		(candidate) => acpExecutionTargetKey(candidate.target) === key,
	);
	if (status) return status;
	if (item.targets.length > 0) return undefined;
	const fallback = selectedTargetStatus(item);
	return acpExecutionTargetKey(fallback.target) === key ? fallback : undefined;
}

function selectedTargetStatus(item: AcpCatalogItem): AcpRuntimeTarget {
	const selected = item.targets.find((target) => target.selected);
	if (selected) return selected;
	const configuredFallback = item.targets.find(
		(target) =>
			acpExecutionTargetKey(target.target) ===
			acpExecutionTargetKey(HOST_ACP_EXECUTION_TARGET),
	);
	return (
		configuredFallback ?? {
			targetId: "host",
			target: HOST_ACP_EXECUTION_TARGET,
			label: "Windows",
			selected: true,
			available: item.available,
			resolvedExecutable: item.resolvedExecutable,
			command: item.command,
			args: item.args,
			env: item.env,
			platformTarget: `${process.platform}-${process.arch}`,
			blockedReason: item.unavailableReason,
		}
	);
}

function runtimeTargetFingerprint(
	item: AcpCatalogItem,
	config: HlidConfig,
	target: AcpRuntimeTarget,
	discoveryCwd: string,
): string {
	const configured = configuredAcpAgent(config, item.id);
	const ollama =
		item.id === "opencode" && configured ? config.ollama : undefined;
	const targetPlatform = acpTargetPlatform(target.target);
	const applyConfiguredEnvironment = target.selected;
	const configuredEnvironment = applyConfiguredEnvironment
		? configured?.env
		: undefined;
	const inheritedEnvironment = target.target.kind === "wsl" ? {} : process.env;
	const rawEnvironment = { ...target.env, ...configuredEnvironment };
	const environment =
		configured?.model_filter || ollama
			? openCodeBaseEnvironment(
					target.env,
					configuredEnvironment,
					inheritedEnvironment,
					targetPlatform,
				).environment
			: rawEnvironment;
	if (configured?.model_filter || ollama) {
		const content =
			openCodeEnvironmentValue(configuredEnvironment, targetPlatform) ??
			openCodeEnvironmentValue(target.env, targetPlatform) ??
			openCodeEnvironmentValue(inheritedEnvironment, targetPlatform);
		if (content !== undefined) environment[OPENCODE_CONFIG_CONTENT] = content;
	}
	const inheritedRuntimeEnvironment = {
		...inheritedEnvironment,
		...environment,
	};
	const inlineConfig = runtimeEnvironmentValue(
		inheritedRuntimeEnvironment,
		OPENCODE_CONFIG_CONTENT,
	);
	return JSON.stringify({
		providerId: item.providerId,
		target: acpExecutionTargetKey(target.target),
		targetId: target.targetId,
		platform: targetPlatform,
		platformTarget: target.platformTarget,
		architecture: process.arch,
		command: target.command,
		args: target.args,
		executable: {
			resolved: target.resolvedExecutable,
			selectedRuntimeEvidence:
				target.target.kind === "host" && target.selected
					? item.runtimeExecutableEvidence
					: undefined,
		},
		env: Object.fromEntries(
			Object.entries(environment)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, value]) => [key, digestRuntimeValue(value)]),
		),
		runtimeRoots: runtimeRootIdentity(
			inheritedRuntimeEnvironment,
			item.id === "opencode",
		),
		inlineConfigDigest: inlineConfig
			? digestRuntimeValue(inlineConfig)
			: undefined,
		modelFilter: configured?.model_filter
			? {
					mode: configured.model_filter.mode,
					models: [...configured.model_filter.models].sort((a, b) =>
						a.localeCompare(b),
					),
				}
			: undefined,
		ollamaModels: ollama
			? [...new Set(ollama.models)].sort((a, b) => a.localeCompare(b))
			: undefined,
		ollamaKeepWarm: ollama?.keep_warm,
		discoveryCwd: declaredPathKey(discoveryCwd),
	});
}

/** Build one exact target invocation for a concrete ACP workspace. */
export function resolveAcpWorkspaceRuntime(
	item: AcpCatalogItem,
	config: HlidConfig,
	cwd: string,
	hostPlatform: NodeJS.Platform = process.platform,
	applyModelFilter = true,
): AcpWorkspaceRuntime {
	const target = acpExecutionTargetForWorkspace(cwd, config, hostPlatform);
	const status = targetStatusFor(item, target);
	const label = acpExecutionTargetLabel(target);
	if (!status) {
		throw new AcpWorkspaceRuntimeError(
			`${item.name} has no ${label} runtime configured for workspace ${JSON.stringify(cwd)}. Install or configure ${item.name} for ${label}.`,
		);
	}
	const discoveryCwd = cwd || acpTargetDiscoveryCwd(config, target);
	const fingerprint = runtimeTargetFingerprint(
		item,
		config,
		status,
		discoveryCwd,
	);
	const reason = status.available
		? undefined
		: (status.blockedReason ??
			(status.command
				? `${status.command} is not installed in ${status.label}`
				: `No distribution for ${status.platformTarget}`));
	return {
		target: status.target,
		targetId: status.targetId,
		label: status.label,
		available: status.available,
		...(reason ? { reason } : {}),
		command: status.command,
		args: [...status.args],
		env: effectiveAcpEnvironment(
			{ ...item, env: status.env },
			config,
			process.env,
			acpTargetPlatform(status.target),
			applyModelFilter,
			status.selected,
			status.target.kind !== "wsl",
		),
		discoveryCwd,
		metadataCacheIdentity: fingerprint,
		sessionContinuityIdentity: createHash("sha256")
			.update(fingerprint)
			.digest("hex"),
	};
}

export function acpRuntimeFingerprint(
	item: AcpCatalogItem,
	config: HlidConfig,
): string {
	const targets =
		item.targets.length > 0 ? item.targets : [selectedTargetStatus(item)];
	return JSON.stringify({
		providerId: item.providerId,
		runtimes: targets
			.filter((target) => !target.cleanupOnly)
			.map((target) => ({
				key: acpExecutionTargetKey(target.target),
				fingerprint: runtimeTargetFingerprint(
					item,
					config,
					target,
					acpTargetDiscoveryCwd(config, target.target),
				),
			}))
			.sort((left, right) => left.key.localeCompare(right.key)),
	});
}

function workspaceRuntimeUnavailableMessage(
	item: AcpCatalogItem,
	runtime: AcpWorkspaceRuntime,
	cwd: string,
): string {
	return `${item.name} is unavailable in ${runtime.label} for workspace ${JSON.stringify(cwd)}${runtime.reason ? `: ${runtime.reason}` : ""}`;
}

/** One provider identity that dispatches each exact workspace to its own runtime. */
export class WorkspaceRoutedAcpProvider implements AgentProvider {
	readonly providerId: string;
	label: string;
	readonly modelCatalogScope = "workspace" as const;
	readonly effortScope = "model" as const;
	readonly liveModelDiscoveryValidatesAvailability = true;
	readonly permissionModes = [
		{
			value: "default",
			label: "Review requested approvals",
			desc: "Hlid asks when the ACP agent sends an approval request",
		},
		{
			value: "bypassPermissions",
			label: "Allow requested approvals",
			desc: "automatically accepts approval requests sent by the ACP agent",
		},
	] as const;
	private catalogItem: AcpCatalogItem;
	private readonly children = new Map<
		string,
		{
			fingerprint: string;
			provider: AcpProvider;
			target: AcpExecutionTarget;
			cwd: string;
		}
	>();
	private retirementError: AcpWorkspaceRuntimeError | null = null;
	private retirementPromise: Promise<void> | null = null;
	private openCodeGoUsage: OpenCodeGoUsageReader | null = null;
	private openCodeGoUsageKey: string | null = null;

	constructor(
		item: AcpCatalogItem,
		private config: HlidConfig,
		private readonly providerOptions: ConfiguredAcpProviderOptions = {},
	) {
		this.catalogItem = item;
		this.providerId = item.providerId;
		this.label = item.name;
		this.updateOpenCodeGoUsage(config);
	}

	get usageWindows(): AgentProvider["usageWindows"] {
		return this.openCodeGoUsage ? OPENCODE_GO_USAGE_WINDOWS : undefined;
	}

	get usageLabel(): string | undefined {
		return this.openCodeGoUsage ? "OpenCode Go" : undefined;
	}

	updateOpenCodeGoUsage(config: HlidConfig): boolean {
		const configured = configuredAcpAgent(config, this.catalogItem.id);
		const nextKey =
			this.catalogItem.id === "opencode"
				? (configured?.opencode_go_usage?.api_key.trim() ?? null)
				: null;
		if (nextKey === this.openCodeGoUsageKey) return false;
		this.openCodeGoUsageKey = nextKey;
		this.openCodeGoUsage = nextKey
			? createOpenCodeGoUsageReader({ apiKey: nextKey })
			: null;
		return true;
	}

	async readUsageWindows() {
		const client = this.openCodeGoUsage;
		if (!client) return [];
		const readings = await client();
		if (client === this.openCodeGoUsage) return readings;

		// A config save may replace the account key while the old request is in
		// flight. Retry the current client once, and never allow the old account's
		// result to escape into the shared display cache.
		const current = this.openCodeGoUsage;
		if (!current) return unavailableOpenCodeGoUsageReadings();
		const currentReadings = await current();
		return current === this.openCodeGoUsage
			? currentReadings
			: unavailableOpenCodeGoUsageReadings();
	}

	get metadataCacheIdentity(): string {
		return acpRuntimeFingerprint(this.catalogItem, this.config);
	}

	get sessionContinuityIdentity(): undefined {
		return undefined;
	}

	metadataCacheIdentityFor(cwd: string): string {
		return resolveAcpWorkspaceRuntime(this.catalogItem, this.config, cwd)
			.metadataCacheIdentity;
	}

	sessionContinuityIdentityFor(cwd: string): string {
		return resolveAcpWorkspaceRuntime(this.catalogItem, this.config, cwd)
			.sessionContinuityIdentity;
	}

	runtimeIdentityFor(cwd: string): string {
		return resolveAcpWorkspaceRuntime(this.catalogItem, this.config, cwd)
			.sessionContinuityIdentity;
	}

	reconcileCatalog(
		item: AcpCatalogItem,
		config: HlidConfig,
	): {
		availabilityChanged: boolean;
		changedTargets: AcpExecutionTarget[];
		cleanup: Promise<void>;
	} {
		const priorTargets =
			this.catalogItem.targets.length > 0
				? this.catalogItem.targets
				: [selectedTargetStatus(this.catalogItem)];
		const nextTargets =
			item.targets.length > 0 ? item.targets : [selectedTargetStatus(item)];
		const before = new Map(
			priorTargets.map((target) => [
				acpExecutionTargetKey(target.target),
				{ available: target.available, reason: target.blockedReason },
			]),
		);
		let availabilityChanged = before.size !== nextTargets.length;
		for (const target of nextTargets) {
			const key = acpExecutionTargetKey(target.target);
			const prior = before.get(key);
			if (
				prior?.available !== target.available ||
				prior?.reason !== target.blockedReason
			) {
				availabilityChanged = true;
			}
		}

		const changedTargets = new Map<string, AcpExecutionTarget>();
		const retirements: Promise<void>[] = [];
		for (const [key, child] of this.children) {
			let runtime: AcpWorkspaceRuntime | null = null;
			try {
				runtime = resolveAcpWorkspaceRuntime(item, config, child.cwd);
			} catch {
				// Removing a configured workspace/target retires only its exact child.
			}
			const targetKey = acpExecutionTargetKey(child.target);
			if (
				!runtime ||
				acpExecutionTargetKey(runtime.target) !== targetKey ||
				runtime.metadataCacheIdentity !== child.fingerprint
			) {
				this.children.delete(key);
				changedTargets.set(targetKey, child.target);
				retirements.push(
					child.provider.retireRuntime(
						`${this.label} runtime is updating in ${acpExecutionTargetLabel(child.target)}; try again shortly.`,
					),
				);
				continue;
			}
			child.provider.updateAvailabilitySnapshot(
				runtime.available
					? { available: true }
					: { available: false, reason: runtime.reason },
			);
		}
		this.catalogItem = item;
		this.config = config;
		this.label = item.name;
		return {
			availabilityChanged,
			changedTargets: [...changedTargets.values()],
			cleanup: Promise.allSettled(retirements).then(() => undefined),
		};
	}

	/**
	 * Close admission before runtime replacement and drain every Windows/WSL child
	 * that this routed provider has materialized. The provider remains registered
	 * until the caller atomically swaps it after this promise settles.
	 */
	retireRuntime(reason?: string): Promise<void> {
		if (this.retirementPromise) return this.retirementPromise;
		this.retirementError = new AcpWorkspaceRuntimeError(
			reason ?? `${this.label} runtime is updating; try again shortly.`,
		);
		const cleanups = [...this.children.values()].map(({ provider }) =>
			provider.retireRuntime(this.retirementError?.message),
		);
		this.retirementPromise = Promise.allSettled(cleanups).then(() => undefined);
		return this.retirementPromise;
	}

	private assertAcceptingWork(): void {
		if (this.retirementError) throw this.retirementError;
	}

	private runtime(cwd: string): AcpWorkspaceRuntime {
		return resolveAcpWorkspaceRuntime(this.catalogItem, this.config, cwd);
	}

	private child(cwd: string, requireAvailable = true): AcpProvider {
		this.assertAcceptingWork();
		const runtime = this.runtime(cwd);
		if (requireAvailable && !runtime.available) {
			throw new AcpWorkspaceRuntimeError(
				workspaceRuntimeUnavailableMessage(this.catalogItem, runtime, cwd),
			);
		}
		const key = `${acpExecutionTargetKey(runtime.target)}\0${declaredPathKey(cwd)}`;
		const existing = this.children.get(key);
		if (existing?.fingerprint === runtime.metadataCacheIdentity) {
			return existing.provider;
		}
		const configured = configuredAcpAgent(this.config, this.catalogItem.id);
		const ollamaOpenCodeTimeouts =
			this.catalogItem.id === "opencode" && configured && this.config.ollama
				? {
						preparationMs: OLLAMA_OPENCODE_ACP_PREPARATION_TIMEOUT_MS,
						inspectionMs: OLLAMA_OPENCODE_ACP_INSPECTION_TIMEOUT_MS,
					}
				: undefined;
		const provider = new AcpProvider({
			id: this.providerId,
			label: this.label,
			command: runtime.command,
			args: runtime.args,
			target: runtime.target,
			env: runtime.env,
			...(this.providerOptions.resolveEnvironment
				? {
						processEnvironment: ({ environment, signal }) =>
							this.providerOptions.resolveEnvironment?.({
								item: this.catalogItem,
								config: this.config,
								target: runtime.target,
								cwd,
								environment: { ...environment },
								signal,
							}) ?? {
								environment: { ...environment },
								release: () => {},
							},
					}
				: {}),
			modelFilter: configured?.model_filter,
			discoveryCwd: cwd,
			metadataCacheIdentity: runtime.metadataCacheIdentity,
			...(ollamaOpenCodeTimeouts ? { timeouts: ollamaOpenCodeTimeouts } : {}),
			initialAvailability: {
				available: runtime.available,
				...(runtime.reason ? { reason: runtime.reason } : {}),
			},
		});
		this.children.set(key, {
			fingerprint: runtime.metadataCacheIdentity,
			provider,
			target: runtime.target,
			cwd,
		});
		return provider;
	}

	async hlidToolLoading(context?: { cwd: string }) {
		return this.child(this.requiredCwd(context), false).hlidToolLoading();
	}

	private requiredCwd(context?: { cwd: string }): string {
		if (context?.cwd.trim()) return context.cwd;
		throw new AcpWorkspaceRuntimeError(
			`${this.label} requires an exact workspace cwd to select its Windows or WSL runtime.`,
		);
	}

	private workspaceAvailability(context?: {
		cwd: string;
	}): { available: true; cwd: string } | { available: false; reason: string } {
		if (this.retirementError) {
			return { available: false, reason: this.retirementError.message };
		}
		try {
			const cwd = this.requiredCwd(context);
			const runtime = this.runtime(cwd);
			return runtime.available
				? { available: true, cwd }
				: {
						available: false,
						reason: workspaceRuntimeUnavailableMessage(
							this.catalogItem,
							runtime,
							cwd,
						),
					};
		} catch (error) {
			return {
				available: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async check(context?: { cwd: string }) {
		const availability = this.workspaceAvailability(context);
		if (!availability.available) return availability;
		return this.child(availability.cwd).check();
	}

	cachedAvailability(context?: { cwd: string }) {
		const availability = this.workspaceAvailability(context);
		if (!availability.available) return availability;
		return (
			this.child(availability.cwd, false).cachedAvailability() ?? {
				available: true,
			}
		);
	}

	async listModels(context?: { cwd: string }): Promise<ProviderModelInfo[]> {
		const cwd = this.requiredCwd(context);
		return this.child(cwd).listModels({ cwd });
	}

	discoverCapabilities(context: { cwd: string }) {
		return this.child(context.cwd).discoverCapabilities(context);
	}

	resolveForkCapability(context?: {
		cwd: string;
	}): Promise<ProviderForkCapability | undefined> {
		const cwd = this.requiredCwd(context);
		return this.child(cwd).resolveForkCapability({ cwd });
	}

	forkSession(params: ForkSessionParams): Promise<ForkSessionResult> {
		const cwd = this.requiredCwd(params.cwd ? { cwd: params.cwd } : undefined);
		return this.child(cwd).forkSession({ ...params, cwd });
	}

	query(params: AgentQueryParams): AgentSession {
		return this.child(params.cwd).query(params);
	}
}

export function createConfiguredAcpProvider(
	item: AcpCatalogItem,
	config: HlidConfig,
	options: ConfiguredAcpProviderOptions = {},
): WorkspaceRoutedAcpProvider {
	return new WorkspaceRoutedAcpProvider(item, config, options);
}

export type AcpRuntimeSyncResult = {
	added: string[];
	removed: string[];
	replaced: string[];
	availabilityUpdated: string[];
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
	retireProviderTargetSessions: (
		providerId: string,
		target: AcpExecutionTarget,
	) => void | Promise<void>;
	registerProvider: (provider: AgentProvider, replaced: boolean) => void;
	providerFactory?: (
		item: AcpCatalogItem,
		config: HlidConfig,
	) => WorkspaceRoutedAcpProvider;
}): Promise<AcpRuntimeSyncResult> {
	const providerFactory =
		options.providerFactory ??
		((item: AcpCatalogItem, config: HlidConfig) =>
			createConfiguredAcpProvider(item, config));
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
		validateSelectedAcpEnvironment(item, options.config);
	}
	const removed: string[] = [];
	const replaced: string[] = [];
	const availabilityUpdated: string[] = [];
	const routedCleanup: Promise<void>[] = [];
	const routedSessionCleanup: Promise<void>[] = [];
	for (const [providerId, fingerprint] of options.fingerprints) {
		const next = desired.get(providerId);
		if (!next) {
			removed.push(providerId);
			continue;
		}
		const provider = options.providers.get(providerId);
		if (provider instanceof WorkspaceRoutedAcpProvider) {
			const runtimeMetadataChanged = next.fingerprint !== fingerprint;
			const usageChanged = provider.updateOpenCodeGoUsage(options.config);
			const reconciliation = provider.reconcileCatalog(
				next.item,
				options.config,
			);
			options.fingerprints.set(providerId, next.fingerprint);
			if (
				runtimeMetadataChanged ||
				reconciliation.availabilityChanged ||
				usageChanged
			) {
				availabilityUpdated.push(providerId);
			}
			if (runtimeMetadataChanged || usageChanged) {
				options.registerProvider(provider, runtimeMetadataChanged);
			}
			routedCleanup.push(reconciliation.cleanup);
			for (const target of reconciliation.changedTargets) {
				routedSessionCleanup.push(
					Promise.resolve(
						options.retireProviderTargetSessions(providerId, target),
					),
				);
			}
			continue;
		}
		if (next.fingerprint !== fingerprint) {
			replaced.push(providerId);
		} else {
			const nextAvailability = {
				available: next.item.available,
				...(next.item.unavailableReason
					? { reason: next.item.unavailableReason }
					: {}),
			};
			const currentAvailability = provider?.cachedAvailability?.();
			if (
				provider?.updateAvailabilitySnapshot &&
				(currentAvailability?.available !== nextAvailability.available ||
					currentAvailability?.reason !== nextAvailability.reason)
			) {
				provider.updateAvailabilitySnapshot(nextAvailability);
				availabilityUpdated.push(providerId);
			}
		}
	}
	const retiringIds = [...removed, ...replaced];
	const retiringProviders = new Map(
		retiringIds.flatMap((providerId) => {
			const provider = options.providers.get(providerId);
			return provider ? ([[providerId, provider]] as const) : [];
		}),
	);
	const replacementProviders = new Map(
		replaced.flatMap((providerId) => {
			const next = desired.get(providerId);
			return next
				? ([[providerId, providerFactory(next.item, options.config)]] as const)
				: [];
		}),
	);

	// Transition every old runtime synchronously while it is still the registered
	// provider. New explicit selections now fail closed on that exact provider
	// instead of observing a missing map entry and falling through elsewhere.
	const providerCleanup = [...retiringProviders.entries()].map(
		([providerId, provider]) =>
			provider.retireRuntime?.(
				replaced.includes(providerId)
					? `${provider.label ?? providerId} runtime is updating; try again shortly.`
					: `${provider.label ?? providerId} runtime is being removed.`,
			) ?? Promise.resolve(),
	);
	const sessionCleanup: Promise<void>[] = [];
	if (removed.length > 0) {
		sessionCleanup.push(
			Promise.resolve(options.retireProviderSessions(removed)),
		);
	}
	if (replaced.length > 0) {
		sessionCleanup.push(
			Promise.resolve(
				options.retireProviderSessions(replaced, { preserveSelection: true }),
			),
		);
	}
	await Promise.all([
		...providerCleanup,
		...sessionCleanup,
		...routedCleanup,
		...routedSessionCleanup,
	]);

	// No await occurs between these mutations: consumers see either the retired
	// provider or its replacement, never a transient missing provider identity.
	for (const providerId of removed) {
		if (
			options.providers.get(providerId) === retiringProviders.get(providerId)
		) {
			options.providers.delete(providerId);
		}
		options.fingerprints.delete(providerId);
	}
	for (const providerId of replaced) {
		const provider = replacementProviders.get(providerId);
		const next = desired.get(providerId);
		if (!provider || !next) continue;
		options.providers.set(providerId, provider);
		options.fingerprints.set(providerId, next.fingerprint);
		options.registerProvider(provider, true);
	}

	const added: string[] = [];
	for (const [providerId, next] of desired) {
		if (options.fingerprints.has(providerId)) continue;
		const provider = providerFactory(next.item, options.config);
		options.providers.set(providerId, provider);
		options.fingerprints.set(providerId, next.fingerprint);
		options.registerProvider(provider, false);
		added.push(providerId);
	}
	return { added, removed, replaced, availabilityUpdated };
}
