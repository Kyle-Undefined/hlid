import { createHash } from "node:crypto";
import type { HlidConfig } from "../config";
import { resolveClaudeExecutable } from "../lib/claudePath";
import { resolveCodexExecutable } from "../lib/codexPath";
import {
	CLIPROXY_CODEX_HARNESS_PROVIDER_ID,
	CLIPROXY_CODEX_PROVIDER_ID,
	CLIPROXY_OPENCODE_PROVIDER_ID,
} from "../lib/providerIds";
import { AcpProvider } from "./acpProvider";
import type { ProviderModelInfo } from "./agentProvider";
import { ClaudeProvider } from "./claudeProvider";
import type { CodexProviderProfile } from "./codexProvider";
import { CodexProvider } from "./codexProvider";

const CLIPROXY_MODELS = [
	{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol · OpenAI" },
	{ value: "gpt-5.6-terra", label: "GPT-5.6-Terra · OpenAI" },
	{ value: "gpt-5.6-luna", label: "GPT-5.6-Luna · OpenAI" },
	{ value: "gpt-5.5", label: "GPT-5.5 · OpenAI" },
	{ value: "gpt-5.4", label: "GPT-5.4 · OpenAI" },
] as const;

const CLIPROXY_EFFORT_LEVELS = [
	{ value: "low", label: "Low", desc: "quick and light" },
	{ value: "medium", label: "Medium", desc: "balanced default" },
	{ value: "high", label: "High", desc: "deeper reasoning" },
	{ value: "xhigh", label: "X-High", desc: "deepest reasoning" },
] as const;

const THINKING_SUFFIX = /\((?:none|auto|minimal|low|medium|high|xhigh|\d+)\)$/i;

export type CliProxyConnection = Pick<
	HlidConfig["cliproxy"],
	"base_url" | "api_key"
>;

export function normalizeCliProxyBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function stripCliProxyThinkingSuffix(model: string): string {
	return model.trim().replace(THINKING_SUFFIX, "");
}

export function cliProxyModelWithEffort(
	model: string,
	effort: string | undefined,
): string {
	const base = stripCliProxyThinkingSuffix(model);
	return effort ? `${base}(${effort})` : base;
}

function modelLabel(id: string): string {
	return id
		.split("-")
		.map((part) =>
			part.toLowerCase() === "gpt"
				? "GPT"
				: /^\d/.test(part)
					? part
					: part.charAt(0).toUpperCase() + part.slice(1),
		)
		.join("-");
}

function ownerLabel(owner: string): string {
	const normalized = owner.trim().toLowerCase();
	if (normalized === "openai") return "OpenAI";
	if (normalized === "anthropic") return "Anthropic";
	if (normalized === "moonshot") return "Moonshot";
	if (normalized === "xai") return "xAI";
	if (normalized === "antigravity") return "Antigravity";
	if (normalized === "google") return "Google";
	return owner.trim() || "CLIProxy";
}

type CliProxyModelResponse = {
	data?: Array<{ id?: unknown; owned_by?: unknown }>;
};

export async function fetchCliProxyModels(
	config: CliProxyConnection,
): Promise<ProviderModelInfo[]> {
	const baseUrl = normalizeCliProxyBaseUrl(config.base_url);
	const response = await fetch(`${baseUrl}/v1/models`, {
		headers: { Authorization: `Bearer ${config.api_key.trim()}` },
		signal: AbortSignal.timeout(3_000),
	});
	if (!response.ok) {
		throw new Error(`CLIProxy returned HTTP ${response.status}`);
	}
	const body = (await response.json()) as CliProxyModelResponse;
	const byId = new Map<string, ProviderModelInfo>();
	for (const entry of body.data ?? []) {
		if (typeof entry.id !== "string") continue;
		const value = stripCliProxyThinkingSuffix(entry.id);
		if (!value) continue;
		const owner =
			typeof entry.owned_by === "string"
				? ownerLabel(entry.owned_by)
				: "CLIProxy";
		byId.set(value, {
			value,
			label: `${modelLabel(value)} · ${owner}`,
		});
	}
	return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function cliProxyError(error: unknown): string {
	return error instanceof Error
		? `CLIProxy unavailable: ${error.message}`
		: "CLIProxy unavailable";
}

/** Backward-compatible provider id; now exposes every model CLIProxy reports. */
export class CliProxyCodexProvider extends ClaudeProvider {
	private readonly connection: CliProxyConnection;

	constructor(config: CliProxyConnection) {
		const baseUrl = normalizeCliProxyBaseUrl(config.base_url);
		const apiKey = config.api_key.trim();
		const sdkEnv = { ...process.env };
		delete sdkEnv.CLAUDE_CODE_OAUTH_TOKEN;
		delete sdkEnv.ANTHROPIC_API_KEY;
		super({
			providerId: CLIPROXY_CODEX_PROVIDER_ID,
			label: "Claude Code · CLIProxy",
			models: CLIPROXY_MODELS,
			effortLevels: CLIPROXY_EFFORT_LEVELS,
			usageWindows: [],
			sdkEnv: {
				...sdkEnv,
				ANTHROPIC_BASE_URL: baseUrl,
				ANTHROPIC_AUTH_TOKEN: apiKey,
			},
			includeSdkEstimatedCost: false,
			requestModel: cliProxyModelWithEffort,
			normalizeModel: stripCliProxyThinkingSuffix,
			passSdkEffort: false,
			exposeUsageWindows: false,
			exposeAccountInfo: false,
			proxyConfig: null,
		});
		this.connection = { base_url: baseUrl, api_key: apiKey };
	}

	override async check(): Promise<{ available: boolean; reason?: string }> {
		if (!resolveClaudeExecutable()) {
			return { available: false, reason: "Claude Code CLI not found" };
		}
		try {
			await fetchCliProxyModels(this.connection);
			return { available: true };
		} catch (error) {
			return { available: false, reason: cliProxyError(error) };
		}
	}

	override async listModels(): Promise<ProviderModelInfo[]> {
		const models = await fetchCliProxyModels(this.connection);
		return models.length > 0 ? models : [...CLIPROXY_MODELS];
	}
}

export class CliProxyNativeCodexProvider extends CodexProvider {
	override readonly usageWindows = [] as const;
	private readonly connection: CliProxyConnection;

	constructor(config: CliProxyConnection) {
		const baseUrl = normalizeCliProxyBaseUrl(config.base_url);
		const apiKey = config.api_key.trim();
		super({
			providerId: CLIPROXY_CODEX_HARNESS_PROVIDER_ID,
			label: "Codex · CLIProxy",
			profile: cliProxyCodexProfile({ base_url: baseUrl, api_key: apiKey }),
		});
		this.connection = { base_url: baseUrl, api_key: apiKey };
	}

	override async check(): Promise<{ available: boolean; reason?: string }> {
		if (!resolveCodexExecutable()) {
			return { available: false, reason: "Codex CLI not found" };
		}
		try {
			await fetchCliProxyModels(this.connection);
			return { available: true };
		} catch (error) {
			return { available: false, reason: cliProxyError(error) };
		}
	}

	override async listModels(): Promise<ProviderModelInfo[]> {
		const models = await fetchCliProxyModels(this.connection);
		return models.length > 0 ? models : [...CLIPROXY_MODELS];
	}
}

export function cliProxyCodexProfile(
	config: CliProxyConnection,
): CodexProviderProfile {
	const baseUrl = normalizeCliProxyBaseUrl(config.base_url);
	const keyId = createHash("sha256")
		.update(config.api_key.trim())
		.digest("hex")
		.slice(0, 12);
	return {
		registryKey: `cliproxy:${baseUrl}:${keyId}`,
		args: [
			"-c",
			'model_provider="hlid_cliproxy"',
			"-c",
			'model_providers.hlid_cliproxy.name="Hlid CLIProxy"',
			"-c",
			`model_providers.hlid_cliproxy.base_url=${JSON.stringify(`${baseUrl}/v1`)}`,
			"-c",
			'model_providers.hlid_cliproxy.env_key="HLID_CLIPROXY_API_KEY"',
			"-c",
			'model_providers.hlid_cliproxy.wire_api="responses"',
		],
		env: { HLID_CLIPROXY_API_KEY: config.api_key.trim() },
	};
}

export function cliProxyOpenCodeConfig(
	baseUrl: string,
	models: ProviderModelInfo[],
): string {
	return JSON.stringify({
		provider: {
			"hlid-cliproxy": {
				npm: "@ai-sdk/openai-compatible",
				name: "Hlid CLIProxy",
				options: {
					baseURL: `${normalizeCliProxyBaseUrl(baseUrl)}/v1`,
					apiKey: "{env:HLID_CLIPROXY_API_KEY}",
				},
				models: Object.fromEntries(
					models.map((model) => [model.value, { name: model.label }]),
				),
			},
		},
	});
}

export class CliProxyOpenCodeProvider extends AcpProvider {
	private readonly connection: CliProxyConnection;

	constructor(
		config: CliProxyConnection,
		invocation: {
			command: string;
			args?: string[];
			env?: Record<string, string>;
		},
	) {
		const connection = {
			base_url: normalizeCliProxyBaseUrl(config.base_url),
			api_key: config.api_key.trim(),
		};
		super({
			id: CLIPROXY_OPENCODE_PROVIDER_ID,
			label: "OpenCode · CLIProxy",
			command: invocation.command,
			args: invocation.args,
			env: async () => {
				const models = await fetchCliProxyModels(connection);
				return {
					...invocation.env,
					HLID_CLIPROXY_API_KEY: connection.api_key,
					OPENCODE_CONFIG_CONTENT: cliProxyOpenCodeConfig(
						connection.base_url,
						models,
					),
				};
			},
			requestModel: (model) =>
				model.startsWith("hlid-cliproxy/") ? model : `hlid-cliproxy/${model}`,
		});
		this.connection = connection;
	}

	override async check(): Promise<{ available: boolean; reason?: string }> {
		const harness = await super.check();
		if (!harness.available) return harness;
		try {
			await fetchCliProxyModels(this.connection);
			return { available: true };
		} catch (error) {
			return { available: false, reason: cliProxyError(error) };
		}
	}

	override async listModels(): Promise<ProviderModelInfo[]> {
		return fetchCliProxyModels(this.connection);
	}
}
