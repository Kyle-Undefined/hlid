/**
 * Pure helper functions for vault-level MCP server management.
 * These functions operate on {vaultPath}/.mcp.json and
 * {vaultPath}/.claude/settings.local.json without referencing
 * any server function infrastructure or config loading.
 */
import { legacyProjectMcpAdapter } from "./mcpConfig";

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
	return legacyProjectMcpAdapter.read(vaultPath);
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
	legacyProjectMcpAdapter.write(vaultPath, servers);
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
	legacyProjectMcpAdapter.toggle(vaultPath, name, disabled);
}
