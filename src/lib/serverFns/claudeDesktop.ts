/** Registers Hlid's MCP servers into the standalone Claude Desktop app's own config. */
import { createServerFn } from "@tanstack/react-start";

export type ClaudeDesktopMcpStatus = {
	/** False outside Windows or when APPDATA is unset; the action is unavailable. */
	available: boolean;
	configPath: string | null;
	registered: boolean;
	/** Number of Hlid-owned entries present, including partial registration. */
	managedServerCount: number;
	/** Count of mcpServers entries other than Hlid's own, for context only. */
	otherServerCount: number;
};

async function readStatus(): Promise<ClaudeDesktopMcpStatus> {
	const {
		claudeDesktopConfigPath,
		countHlidClaudeDesktopEntries,
		isHlidRegisteredInClaudeDesktop,
		readClaudeDesktopConfig,
		HLID_DESKTOP_MCP_KEY,
		HLID_OBSIDIAN_DESKTOP_MCP_KEY,
	} = await import("#/server/claudeDesktopMcp");
	if (process.platform !== "win32") {
		return {
			available: false,
			configPath: null,
			registered: false,
			managedServerCount: 0,
			otherServerCount: 0,
		};
	}
	const configPath = claudeDesktopConfigPath();
	if (!configPath) {
		return {
			available: false,
			configPath: null,
			registered: false,
			managedServerCount: 0,
			otherServerCount: 0,
		};
	}
	const config = readClaudeDesktopConfig(configPath);
	const servers = config.mcpServers ?? {};
	const otherServerCount = Object.keys(servers).filter(
		(name) =>
			name !== HLID_DESKTOP_MCP_KEY && name !== HLID_OBSIDIAN_DESKTOP_MCP_KEY,
	).length;
	return {
		available: true,
		configPath,
		registered: isHlidRegisteredInClaudeDesktop(config),
		managedServerCount: countHlidClaudeDesktopEntries(config),
		otherServerCount,
	};
}

export const getClaudeDesktopMcpStatusFn = createServerFn({
	method: "GET",
}).handler(() => readStatus());

export const registerHlidInClaudeDesktopFn = createServerFn({
	method: "POST",
}).handler(async () => {
	if (process.platform !== "win32") {
		throw new Error("Claude Desktop registration is Windows-only.");
	}
	const { claudeDesktopConfigPath, registerHlidInClaudeDesktop } = await import(
		"#/server/claudeDesktopMcp"
	);
	const configPath = claudeDesktopConfigPath();
	if (!configPath) {
		throw new Error("Could not resolve the Claude Desktop config path.");
	}
	registerHlidInClaudeDesktop(configPath);
	return readStatus();
});

export const unregisterHlidFromClaudeDesktopFn = createServerFn({
	method: "POST",
}).handler(async () => {
	if (process.platform !== "win32") {
		throw new Error("Claude Desktop unregistration is Windows-only.");
	}
	const { claudeDesktopConfigPath, unregisterHlidFromClaudeDesktop } =
		await import("#/server/claudeDesktopMcp");
	const configPath = claudeDesktopConfigPath();
	if (!configPath) {
		throw new Error("Could not resolve the Claude Desktop config path.");
	}
	unregisterHlidFromClaudeDesktop(configPath);
	return readStatus();
});
