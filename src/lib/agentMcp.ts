/**
 * Pure helper functions for per-agent MCP server management.
 * These functions operate on {agentPath}/.mcp.json and
 * {agentPath}/.claude/settings.local.json without referencing
 * any server function infrastructure or config loading.
 *
 * Callers are responsible for authorising the agentPath before calling.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HlidConfig } from "../config";
import { expandTilde, samePath } from "./paths";

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Validate that agentPath refers to a registered agent in config.
 * Throws "Unauthorized" if the path is not in config.agents.
 */
export function validateAgentPath(agentPath: string, config: HlidConfig): void {
	const allowedPaths = (config.agents ?? []).map((a) =>
		resolve(expandTilde(a.path)),
	);
	const requested = resolve(expandTilde(agentPath));
	if (!allowedPaths.some((p) => samePath(p, requested))) {
		throw new Error("Unauthorized");
	}
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
