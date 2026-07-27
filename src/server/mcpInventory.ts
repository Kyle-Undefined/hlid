import type { ServerWebSocket } from "bun";
import { readAgentMcpFile } from "../lib/agentMcp";
import { type McpRegistryEntry, mergeMcpRegistry } from "../lib/mcpRegistry";
import { readVaultMcpFile } from "../lib/vaultMcp";
import { resolveAllowedAgentPath } from "./agentPaths";
import {
	waitForAllClaudeWarmupSnapshots,
	waitForClaudeWarmupSnapshot,
} from "./claudeWarmup";
import { loadConfig } from "./config";
import { mapMcpServer } from "./protocol";
import { broadcast, send } from "./runState";
import type { PoolEntry, SessionPool } from "./sessionPool";

function readAgentServers(resolvedAgent: string) {
	try {
		return readAgentMcpFile(resolvedAgent).servers;
	} catch {
		return [];
	}
}

function resolveRegisteredAgent(agentCwd: string): string | undefined {
	return resolveAllowedAgentPath(loadConfig(), agentCwd);
}

export function syncAgentMcpList(
	ws: ServerWebSocket<unknown>,
	entry: PoolEntry,
	agentCwd: string,
): void {
	const resolvedAgent = resolveRegisteredAgent(agentCwd);
	if (!resolvedAgent) return;
	const servers = readAgentServers(resolvedAgent).map(({ name, disabled }) =>
		mapMcpServer({
			name,
			status: disabled ? "disabled" : "pending",
			scope: "project",
		}),
	);
	send(ws, {
		type: "mcp_status",
		...(entry.manager.getProviderId(resolvedAgent)
			? { provider_id: entry.manager.getProviderId(resolvedAgent) }
			: {}),
		servers,
		agent_cwd: agentCwd,
	});
}

function readVaultServers(vaultPath: string) {
	try {
		return readVaultMcpFile(vaultPath).servers;
	} catch {
		return [];
	}
}

export async function syncMcpInventory(
	ws: ServerWebSocket<unknown>,
	pool: SessionPool,
	agentCwd?: string,
): Promise<void> {
	const config = loadConfig();
	const resolvedAgent = agentCwd ? resolveRegisteredAgent(agentCwd) : undefined;
	if (agentCwd && !resolvedAgent) return;

	const inventory: McpRegistryEntry[] = [];
	const configuredProvider = pool
		.vaultEntry()
		.manager.getProviderId(resolvedAgent);
	const configuredServers = resolvedAgent
		? readAgentServers(resolvedAgent)
		: config.vault.path
			? readVaultServers(config.vault.path)
			: [];
	for (const { name, disabled } of configuredServers) {
		inventory.push({
			name,
			providerId: configuredProvider,
			status: disabled ? "disabled" : "pending",
			scope: resolvedAgent ? "agent" : "vault",
			source: resolvedAgent ? "agent" : "vault",
		});
	}

	// Claude metadata is discovered and cached at startup independently of chat
	// sessions. Cockpit is a cross-provider inventory, so include that cache even
	// when no Claude SessionManager has ever been started.
	const claudeSnapshots = resolvedAgent
		? [await waitForClaudeWarmupSnapshot(resolvedAgent)]
		: await waitForAllClaudeWarmupSnapshots();
	for (const snapshot of claudeSnapshots) {
		for (const server of snapshot?.mcpServers ?? []) {
			inventory.push({
				...server,
				providerId: "claude",
				scope: "provider",
				source: "provider",
			});
		}
	}

	for (const entry of pool.getAllEntries()) {
		if (resolvedAgent && entry.agentCwd !== resolvedAgent) continue;
		for (const snapshot of entry.manager.getMcpSnapshots()) {
			for (const server of snapshot.servers) {
				inventory.push({
					...server,
					providerId: snapshot.providerId,
					scope: "provider",
					source: "runtime",
				});
			}
		}
	}

	send(ws, {
		type: "mcp_status",
		inventory: true,
		...(agentCwd ? { agent_cwd: agentCwd } : {}),
		servers: mergeMcpRegistry(inventory).map(mapMcpServer),
	});
}

export function syncVaultMcpList(pool: SessionPool): void {
	const config = loadConfig();
	if (!config.vault.path) return;
	const cached = pool.vaultEntry().manager.getLastMcpStatus() ?? [];
	const cachedByName = new Map(cached.map((server) => [server.name, server]));
	const preserved = cached
		.filter((server) => server.scope !== "project")
		.map(mapMcpServer);
	const vault = readVaultServers(config.vault.path).map(
		({ name, disabled }) => {
			const known = cachedByName.get(name);
			return mapMcpServer({
				name,
				status: disabled ? "disabled" : (known?.status ?? "pending"),
				scope: "project",
				error: disabled ? undefined : known?.error,
			});
		},
	);
	const providerId = pool.vaultEntry().manager.getProviderId();
	broadcast({
		type: "mcp_status",
		...(providerId ? { provider_id: providerId } : {}),
		servers: [...preserved, ...vault],
	});
}
