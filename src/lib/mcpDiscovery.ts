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
	readFile: (path: string) => string | Promise<string>;
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

async function readServerNames(
	path: string | undefined,
	readFile: (path: string) => string | Promise<string>,
): Promise<string[]> {
	if (!path) return [];
	try {
		return parseMcpServerNames(await readFile(path));
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

	const [vaultServers, globalServers] = await Promise.all([
		readServerNames(dependencies.vaultMcpPath, dependencies.readFile),
		readServerNames(dependencies.globalSettingsPath, dependencies.readFile),
	]);
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
