import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderMcpServerDefinition } from "./agentProvider";

export type PreparedClaudeMcpServers = {
	/** Every name owned by the workspace `.mcp.json`, including disabled/invalid. */
	managedNames: string[];
	/** Enabled definitions safe to hand to the Claude Agent SDK. */
	dynamicServers: Record<string, McpServerConfig>;
	/** Disabled definitions remain visible without being connected. */
	disabledNames: string[];
	/** Invalid definitions are isolated from the provider and reported by name. */
	errors: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		isRecord(value) &&
		Object.values(value).every((item) => typeof item === "string")
	);
}

function invalidOptionalFields(config: Record<string, unknown>): string | null {
	if (
		config.timeout !== undefined &&
		(typeof config.timeout !== "number" || !Number.isFinite(config.timeout))
	) {
		return "timeout must be a finite number";
	}
	if (
		config.alwaysLoad !== undefined &&
		typeof config.alwaysLoad !== "boolean"
	) {
		return "alwaysLoad must be a boolean";
	}
	return null;
}

function normalizeServerConfig(
	config: unknown,
): McpServerConfig | { error: string } {
	if (!isRecord(config)) return { error: "configuration must be an object" };
	const optionalError = invalidOptionalFields(config);
	if (optionalError) return { error: optionalError };

	const type = config.type;
	if (type === undefined || type === "stdio") {
		if (typeof config.command !== "string" || config.command.trim() === "") {
			return { error: "stdio configuration requires a command" };
		}
		if (
			config.args !== undefined &&
			(!Array.isArray(config.args) ||
				!config.args.every((item) => typeof item === "string"))
		) {
			return { error: "stdio args must be an array of strings" };
		}
		if (config.env !== undefined && !isStringRecord(config.env)) {
			return { error: "stdio env must contain only string values" };
		}
		return config as McpServerConfig;
	}

	if (type === "http" || type === "sse") {
		if (typeof config.url !== "string" || config.url.trim() === "") {
			return { error: `${type} configuration requires a URL` };
		}
		if (config.headers !== undefined && !isStringRecord(config.headers)) {
			return { error: `${type} headers must contain only string values` };
		}
		return config as McpServerConfig;
	}

	return { error: "type must be stdio, http, or sse" };
}

/**
 * Convert Hlid's canonical workspace definitions into Claude's dynamic subset.
 * Reserved in-process server names always remain owned by Hlid.
 */
export function prepareClaudeMcpServers(
	definitions: ProviderMcpServerDefinition[],
	reservedNames: ReadonlySet<string> = new Set(),
): PreparedClaudeMcpServers {
	const managedNames: string[] = [];
	const dynamicServers: Record<string, McpServerConfig> = {};
	const disabledNames: string[] = [];
	const errors: Record<string, string> = {};

	for (const definition of definitions) {
		managedNames.push(definition.name);
		if (reservedNames.has(definition.name)) {
			errors[definition.name] = "This MCP server name is reserved by Hlid";
			continue;
		}
		if (definition.disabled) {
			disabledNames.push(definition.name);
			continue;
		}
		const normalized = normalizeServerConfig(definition.config);
		if ("error" in normalized) {
			errors[definition.name] = normalized.error;
			continue;
		}
		dynamicServers[definition.name] = normalized;
	}

	return { managedNames, dynamicServers, disabledNames, errors };
}
