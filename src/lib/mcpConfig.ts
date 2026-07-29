import {
	type ProjectMcpServer,
	readProjectMcpFile,
	readProjectMcpFileAsync,
	toggleProjectMcpFile,
	writeProjectMcpFile,
} from "./projectMcp";

/** Provider-neutral boundary between MCP configuration storage and runtime status. */
export type McpConfigAdapter = {
	id: string;
	read(projectPath: string): { servers: ProjectMcpServer[] };
	readAsync(projectPath: string): Promise<{ servers: ProjectMcpServer[] }>;
	write(projectPath: string, servers: Record<string, unknown>): void;
	toggle(projectPath: string, name: string, disabled: boolean): void;
};

/**
 * Compatibility adapter for Hlid's existing `.mcp.json` plus
 * `.claude/settings.local.json` disabled-server convention. Keeping this
 * adapter intact lets provider-native runtime discovery evolve independently
 * without rewriting or dropping existing project MCP configuration.
 */
export const legacyProjectMcpAdapter: McpConfigAdapter = {
	id: "legacy-project-mcp-json",
	read: readProjectMcpFile,
	readAsync: readProjectMcpFileAsync,
	write: writeProjectMcpFile,
	toggle: toggleProjectMcpFile,
};
