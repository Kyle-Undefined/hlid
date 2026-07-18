/** MCP server discovery server fn (live status with static-config fallback). */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { dbFetch } from "#/lib/dbClient";
import { discoverMcpServers } from "#/lib/mcpDiscovery";
import { getConfig } from "./config";

export const getMcpServersFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const config = await getConfig();
		return discoverMcpServers({
			loadLiveServers: async () => {
				const response = await dbFetch("/mcp-status");
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
