/**
 * Registers Hlid's internal MCP servers — agent tools and Obsidian vault
 * tools — into the standalone Claude Desktop app's own config file, so
 * Claude Desktop can reach the same tools Claude Code sessions already use
 * through Hlid.
 *
 * Functions here take an explicit config path so callers control path
 * resolution and tests can use a real temp file instead of the live
 * `%APPDATA%` location. Desktop's config format is Windows/macOS-shared:
 * `{ mcpServers: { <name>: { command, args, env? } } }`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "#/lib/atomicFile";
import { hlidMcpProcessCommand } from "./hlidMcpServer";
import { obsidianMcpProcessCommand } from "./obsidianMcpServer";

export const HLID_DESKTOP_MCP_KEY = "hlid";
export const HLID_OBSIDIAN_DESKTOP_MCP_KEY = "hlid_obsidian";

type DesktopMcpServerEntry = {
	command: string;
	args: string[];
	env?: Record<string, string>;
};

export type ClaudeDesktopConfig = {
	mcpServers?: Record<string, unknown>;
	[key: string]: unknown;
};

/**
 * `%APPDATA%\Claude\claude_desktop_config.json`, or null when APPDATA is
 * unavailable. Mirrors the `join(appData, "Claude")` convention already
 * used for Cowork history discovery in `providerHistoryImport.ts`.
 */
export function claudeDesktopConfigPath(
	appData: string | null | undefined = process.env.APPDATA,
): string | null {
	if (!appData) return null;
	return join(appData, "Claude", "claude_desktop_config.json");
}

function toEnvObject(
	env: Array<{ name: string; value: string }>,
): Record<string, string> | undefined {
	if (env.length === 0) return undefined;
	return Object.fromEntries(env.map(({ name, value }) => [name, value]));
}

function hlidDesktopEntries(): Record<string, DesktopMcpServerEntry> {
	const hlid = hlidMcpProcessCommand();
	const obsidian = obsidianMcpProcessCommand();
	const hlidEnv = toEnvObject(hlid.env);
	const obsidianEnv = toEnvObject(obsidian.env);
	return {
		[HLID_DESKTOP_MCP_KEY]: {
			command: hlid.command,
			args: hlid.args,
			...(hlidEnv ? { env: hlidEnv } : {}),
		},
		[HLID_OBSIDIAN_DESKTOP_MCP_KEY]: {
			command: obsidian.command,
			args: obsidian.args,
			...(obsidianEnv ? { env: obsidianEnv } : {}),
		},
	};
}

/**
 * Read the Claude Desktop config. A missing file reads as an empty config.
 * Throws on unparsable JSON rather than treating it as empty — Hlid must
 * never blindly overwrite a config file it could not understand, since it
 * may already hold the user's other MCP servers.
 */
export function readClaudeDesktopConfig(path: string): ClaudeDesktopConfig {
	if (!existsSync(path)) return {};
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(
			`Could not read Claude Desktop config at ${path}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (raw.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`Claude Desktop config at ${path} is not valid JSON. Fix or back it up before registering Hlid: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`Claude Desktop config at ${path} was not a JSON object. Fix or back it up before registering Hlid.`,
		);
	}
	return parsed as ClaudeDesktopConfig;
}

/** True when both Hlid MCP entries are already present in the config. */
export function isHlidRegisteredInClaudeDesktop(
	config: ClaudeDesktopConfig,
): boolean {
	const servers = config.mcpServers;
	if (!servers || typeof servers !== "object") return false;
	return (
		HLID_DESKTOP_MCP_KEY in servers && HLID_OBSIDIAN_DESKTOP_MCP_KEY in servers
	);
}

/**
 * Merge Hlid's MCP server entries into the Claude Desktop config and write
 * it back atomically. Every other server entry, and every other top-level
 * key in the file, is preserved untouched. Re-running this is safe and
 * picks up a moved Hlid install path.
 */
export function registerHlidInClaudeDesktop(path: string): ClaudeDesktopConfig {
	const current = readClaudeDesktopConfig(path);
	const next: ClaudeDesktopConfig = {
		...current,
		mcpServers: {
			...(current.mcpServers ?? {}),
			...hlidDesktopEntries(),
		},
	};
	writeFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`, {
		createParent: true,
	});
	return next;
}
