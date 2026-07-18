/** MCP server discovery server fn (live status with static-config fallback). */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { dbFetch } from "#/lib/dbClient";
import { discoverMcpServers } from "#/lib/mcpDiscovery";
import { getConfig } from "./config";

const MCP_LIVE_FALLBACK_TIMEOUT_MS = 750;

export const getMcpServersFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const config = await getConfig();
		return discoverMcpServers({
			loadLiveServers: async () => {
				// WebSocket inventory is authoritative once Cockpit mounts. Keep this
				// loader fallback short so a stalled loopback read cannot hold the
				// dashboard recovery batch for the generic five-second DB budget.
				const response = await dbFetch("/mcp-status", {
					signal: AbortSignal.timeout(MCP_LIVE_FALLBACK_TIMEOUT_MS),
				});
				if (!response.ok) return [];
				return response.json();
			},
			readFile: (path) => readFile(path, "utf8"),
			globalSettingsPath: join(homedir(), ".claude", "settings.json"),
			vaultMcpPath: config.vault.path
				? join(config.vault.path, ".mcp.json")
				: undefined,
		});
	},
);
