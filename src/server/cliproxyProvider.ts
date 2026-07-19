import type { HlidConfig } from "../config";
import { resolveClaudeExecutable } from "../lib/claudePath";
import { CLIPROXY_CODEX_PROVIDER_ID } from "../lib/providerIds";
import type { ProviderModelInfo } from "./agentProvider";
import { ClaudeProvider } from "./claudeProvider";

const CLIPROXY_MODELS = [
	{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
	{ value: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
	{ value: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
	{ value: "gpt-5.5", label: "GPT-5.5" },
	{ value: "gpt-5.4", label: "GPT-5.4" },
] as const;

const CLIPROXY_EFFORT_LEVELS = [
	{ value: "low", label: "Low", desc: "quick and light" },
	{ value: "medium", label: "Medium", desc: "balanced default" },
	{ value: "high", label: "High", desc: "deeper reasoning" },
	{ value: "xhigh", label: "X-High", desc: "deepest Codex reasoning" },
] as const;

const THINKING_SUFFIX = /\((?:none|auto|minimal|low|medium|high|xhigh|\d+)\)$/i;

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

type CliProxyModelResponse = {
	data?: Array<{ id?: unknown }>;
};

export class CliProxyCodexProvider extends ClaudeProvider {
	private readonly baseUrl: string;
	private readonly apiKey: string;

	constructor(config: Pick<HlidConfig["cliproxy"], "base_url" | "api_key">) {
		const baseUrl = normalizeCliProxyBaseUrl(config.base_url);
		const apiKey = config.api_key.trim();
		const sdkEnv = { ...process.env };
		delete sdkEnv.CLAUDE_CODE_OAUTH_TOKEN;
		delete sdkEnv.ANTHROPIC_API_KEY;
		super({
			providerId: CLIPROXY_CODEX_PROVIDER_ID,
			label: "Claude Code · Codex",
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
		this.baseUrl = baseUrl;
		this.apiKey = apiKey;
	}

	private async fetchModels(): Promise<ProviderModelInfo[]> {
		const response = await fetch(`${this.baseUrl}/v1/models`, {
			headers: { Authorization: `Bearer ${this.apiKey}` },
			signal: AbortSignal.timeout(3_000),
		});
		if (!response.ok) {
			throw new Error(`CLIProxy returned HTTP ${response.status}`);
		}
		const body = (await response.json()) as CliProxyModelResponse;
		const ids = (body.data ?? [])
			.map((entry) => entry.id)
			.filter((id): id is string => typeof id === "string")
			.map(stripCliProxyThinkingSuffix)
			.filter((id) => id.toLowerCase().startsWith("gpt-"));
		return [...new Set(ids)].map((value) => ({
			value,
			label: modelLabel(value),
		}));
	}

	override async check(): Promise<{ available: boolean; reason?: string }> {
		if (!resolveClaudeExecutable()) {
			return { available: false, reason: "Claude Code CLI not found" };
		}
		try {
			await this.fetchModels();
			return { available: true };
		} catch (error) {
			return {
				available: false,
				reason:
					error instanceof Error
						? `CLIProxy unavailable: ${error.message}`
						: "CLIProxy unavailable",
			};
		}
	}

	override async listModels(): Promise<ProviderModelInfo[]> {
		const models = await this.fetchModels();
		return models.length > 0 ? models : [...CLIPROXY_MODELS];
	}
}
