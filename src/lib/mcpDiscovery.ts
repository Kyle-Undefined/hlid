import type { McpServerEntry } from "#/lib/mcp";
import { mapMcpServer } from "#/lib/mcp";

type LiveMcpServer = {
	name: string;
	status: string;
	scope?: string;
	error?: string;
};

type McpDiscoveryDependencies = {
	loadLiveServers: () => Promise<LiveMcpServer[]>;
	readFile: (path: string) => string;
	globalSettingsPath: string;
	vaultMcpPath?: string;
};

export function parseMcpServerNames(contents: string): string[] {
	try {
		const parsed = JSON.parse(contents) as {
			mcpServers?: Record<string, unknown>;
		};
		return Object.keys(parsed.mcpServers ?? {});
	} catch {
		return [];
	}
}

function readServerNames(
	path: string | undefined,
	readFile: (path: string) => string,
): string[] {
	if (!path) return [];
	try {
		return parseMcpServerNames(readFile(path));
	} catch {
		return [];
	}
}

export async function discoverMcpServers(
	dependencies: McpDiscoveryDependencies,
): Promise<McpServerEntry[]> {
	try {
		const live = await dependencies.loadLiveServers();
		if (live.length > 0) return live.map(mapMcpServer);
	} catch {
		// The internal server may not be running yet; use static configuration.
	}

	const vaultServers = readServerNames(
		dependencies.vaultMcpPath,
		dependencies.readFile,
	);
	const globalServers = readServerNames(
		dependencies.globalSettingsPath,
		dependencies.readFile,
	);
	const seen = new Set(vaultServers);
	return [
		...vaultServers.map((name) => ({
			name,
			displayName: name,
			source: "vault" as const,
			status: "unknown" as const,
		})),
		...globalServers
			.filter((name) => !seen.has(name))
			.map((name) => ({
				name,
				displayName: name,
				source: "global" as const,
				status: "unknown" as const,
			})),
	];
}
