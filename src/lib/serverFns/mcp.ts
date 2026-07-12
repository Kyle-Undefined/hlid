/** MCP server discovery server fn (live status with static-config fallback). */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { getConfig } from "#/config";
import { dbFetch } from "#/lib/dbClient";
import { discoverMcpServers } from "#/lib/mcpDiscovery";

export const getMcpServersFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const config = await getConfig();
		return discoverMcpServers({
			loadLiveServers: async () => {
				const response = await dbFetch("/mcp-status");
				if (!response.ok) return [];
				return response.json();
			},
			readFile: (path) => readFileSync(path, "utf8"),
			globalSettingsPath: join(homedir(), ".claude", "settings.json"),
			vaultMcpPath: config.vault.path
				? join(config.vault.path, ".mcp.json")
				: undefined,
		});
	},
);
