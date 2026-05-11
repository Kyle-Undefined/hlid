/**
 * Pure helper functions for vault-level MCP server management.
 * These functions operate on {vaultPath}/.mcp.json and
 * {vaultPath}/.claude/settings.local.json without referencing
 * any server function infrastructure or config loading.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VaultMcpServer {
	name: string;
	config: unknown;
	disabled: boolean;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read MCP server list from {vaultPath}/.mcp.json merged with the
 * disabledMcpjsonServers list in {vaultPath}/.claude/settings.local.json.
 * ENOENT on either file is treated as empty.
 */
export function readVaultMcpFile(vaultPath: string): {
	servers: VaultMcpServer[];
} {
	let mcpMap: Record<string, unknown> = {};
	try {
		const raw = readFileSync(join(vaultPath, ".mcp.json"), "utf8");
		mcpMap =
			(JSON.parse(raw) as { mcpServers?: Record<string, unknown> })
				.mcpServers ?? {};
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}

	let disabled: string[] = [];
	try {
		const raw = readFileSync(
			join(vaultPath, ".claude", "settings.local.json"),
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

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Persist a full mcpServers map to {vaultPath}/.mcp.json.
 * Overwrites any existing file.
 */
export function writeVaultMcpFile(
	vaultPath: string,
	servers: Record<string, unknown>,
): void {
	writeFileSync(
		join(vaultPath, ".mcp.json"),
		JSON.stringify({ mcpServers: servers }, null, 2),
		"utf8",
	);
}

// ─── Toggle ───────────────────────────────────────────────────────────────────

/**
 * Add or remove a server name from the disabledMcpjsonServers list in
 * {vaultPath}/.claude/settings.local.json.
 * Creates the .claude/ directory and file if they do not exist.
 * Preserves all other keys in settings.local.json.
 */
export function toggleVaultMcpFile(
	vaultPath: string,
	name: string,
	disabled: boolean,
): void {
	const settingsPath = join(vaultPath, ".claude", "settings.local.json");
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

	mkdirSync(join(vaultPath, ".claude"), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}
