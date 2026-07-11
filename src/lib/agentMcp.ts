/**
 * Pure helper functions for per-agent MCP server management.
 * These functions operate on {agentPath}/.mcp.json and
 * {agentPath}/.claude/settings.local.json without referencing
 * any server function infrastructure or config loading.
 *
 * Callers are responsible for authorising the agentPath before calling.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { HlidConfig } from "../config";
import { expandTilde, samePath } from "./paths";

// ─── Name helper ─────────────────────────────────────────────────────────────

/**
 * Derive a human-readable display name from an agent directory path.
 * e.g. "/projects/my-cool_agent" → "My Cool Agent"
 */
export function deriveAgentName(p: string): string {
	return basename(p)
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Validate that agentPath refers to a registered agent in config.
 * Throws "Unauthorized" if the path is not in config.agents.
 */
export function resolveAuthorizedAgentPath(
	agentPath: string,
	config: HlidConfig,
): string {
	let requested: string;
	try {
		requested = realpathSync(resolve(expandTilde(agentPath)));
	} catch {
		throw new Error("Unauthorized");
	}
	const allowedPaths = (config.agents ?? []).flatMap((agent) => {
		try {
			return [realpathSync(resolve(expandTilde(agent.path)))];
		} catch {
			return [];
		}
	});
	if (!allowedPaths.some((p) => samePath(p, requested))) {
		throw new Error("Unauthorized");
	}
	return requested;
}

export function validateAgentPath(agentPath: string, config: HlidConfig): void {
	resolveAuthorizedAgentPath(agentPath, config);
}

// ─── Read helper ─────────────────────────────────────────────────────────────

/**
 * Read MCP server list from {resolvedPath}/.mcp.json merged with the
 * disabledMcpjsonServers list in {resolvedPath}/.claude/settings.local.json.
 * ENOENT on either file is treated as empty. Caller must have already
 * validated that resolvedPath is an authorised agent path.
 */
export function readAgentMcpFile(resolvedPath: string): {
	servers: Array<{ name: string; config: unknown; disabled: boolean }>;
} {
	let mcpMap: Record<string, unknown> = {};
	try {
		const raw = readFileSync(join(resolvedPath, ".mcp.json"), "utf8");
		mcpMap =
			(JSON.parse(raw) as { mcpServers?: Record<string, unknown> })
				.mcpServers ?? {};
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}

	let disabled: string[] = [];
	try {
		const raw = readFileSync(
			join(resolvedPath, ".claude", "settings.local.json"),
			"utf8",
		);
		disabled =
			(JSON.parse(raw) as { disabledMcpjsonServers?: string[] })
				.disabledMcpjsonServers ?? [];
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}

	return {
		servers: Object.entries(mcpMap).map(([name, config]) => ({
			name,
			config,
			disabled: disabled.includes(name),
		})),
	};
}

// ─── Write helpers ────────────────────────────────────────────────────────────

/**
 * Persist a full mcpServers map to {agentPath}/.mcp.json.
 * Overwrites any existing file.
 */
export function writeAgentMcpFile(
	agentPath: string,
	servers: Record<string, unknown>,
): void {
	writeFileSync(
		join(agentPath, ".mcp.json"),
		JSON.stringify({ mcpServers: servers }, null, 2),
		"utf8",
	);
}

/**
 * Add or remove a server name from the disabledMcpjsonServers list in
 * {agentPath}/.claude/settings.local.json.
 * Creates the .claude/ directory and file if they do not exist.
 * Preserves all other keys in settings.local.json.
 */
export function toggleAgentMcpFile(
	agentPath: string,
	name: string,
	disabled: boolean,
): void {
	const settingsPath = join(agentPath, ".claude", "settings.local.json");
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
			string,
			unknown
		>;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}

	const disabledSet = new Set<string>(
		(settings.disabledMcpjsonServers as string[] | undefined) ?? [],
	);
	if (disabled) disabledSet.add(name);
	else disabledSet.delete(name);
	settings.disabledMcpjsonServers = [...disabledSet];

	mkdirSync(join(agentPath, ".claude"), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}
