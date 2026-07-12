import { describe, expect, it, vi } from "vitest";
import { discoverMcpServers, parseMcpServerNames } from "./mcpDiscovery";

describe("MCP discovery", () => {
	it("uses live status when it is available", async () => {
		const readFile = vi.fn();
		const result = await discoverMcpServers({
			loadLiveServers: async () => [
				{ name: "claude.ai GitHub", status: "connected", scope: "claudeai" },
			],
			readFile,
			globalSettingsPath: "/global/settings.json",
		});

		expect(result).toEqual([
			{
				name: "claude.ai GitHub",
				displayName: "GitHub",
				source: "cloud",
				status: "connected",
			},
		]);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("falls back to static files with vault precedence", async () => {
		const files = new Map([
			[
				"/vault/.mcp.json",
				JSON.stringify({ mcpServers: { shared: {}, vault: {} } }),
			],
			[
				"/global/settings.json",
				JSON.stringify({ mcpServers: { shared: {}, global: {} } }),
			],
		]);
		const result = await discoverMcpServers({
			loadLiveServers: async () => [],
			readFile: (path) => files.get(path) ?? "",
			globalSettingsPath: "/global/settings.json",
			vaultMcpPath: "/vault/.mcp.json",
		});

		expect(result.map(({ name, source }) => [name, source])).toEqual([
			["shared", "vault"],
			["vault", "vault"],
			["global", "global"],
		]);
	});

	it("contains live and file parsing failures", async () => {
		const result = await discoverMcpServers({
			loadLiveServers: async () => {
				throw new Error("offline");
			},
			readFile: () => {
				throw new Error("unreadable");
			},
			globalSettingsPath: "/global/settings.json",
			vaultMcpPath: "/vault/.mcp.json",
		});

		expect(result).toEqual([]);
		expect(parseMcpServerNames("not json")).toEqual([]);
	});
});
