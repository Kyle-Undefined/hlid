import type { ServerWebSocket } from "bun";
import { readAgentMcpFileAsync } from "../lib/agentMcp";
import { type McpRegistryEntry, mergeMcpRegistry } from "../lib/mcpRegistry";
import { samePath } from "../lib/paths";
import { readVaultMcpFileAsync } from "../lib/vaultMcp";
import { resolveAgentMetadataPath } from "./agentPaths";
import {
	waitForAllClaudeWarmupSnapshots,
	waitForClaudeWarmupSnapshot,
} from "./claudeWarmup";
import { loadConfig } from "./config";
import { mapMcpServer } from "./protocol";
import { broadcast, send } from "./runState";
import type { PoolEntry, SessionPool } from "./sessionPool";

async function applyLiveClaudeMcpConfig(
	pool: SessionPool,
	workspacePath: string,
	servers: Awaited<ReturnType<typeof readAgentServers>>,
): Promise<
	Array<
		Extract<
			Awaited<ReturnType<PoolEntry["manager"]["applyProviderMcpServers"]>>,
			{ status: "applied" }
		>
	>
> {
	const candidates = [...pool.getAllEntries()].filter(
		(entry) =>
			samePath(entry.agentCwd, workspacePath) &&
			entry.manager.getProviderId() === "claude",
	);
	const settled = await Promise.allSettled(
		candidates.map((entry) =>
			entry.manager.applyProviderMcpServers(servers, (message) =>
				entry.runState.broadcast(message),
			),
		),
	);
	for (const result of settled) {
		if (result.status === "rejected") {
			console.error(
				"[mcp] Failed to apply live Claude MCP configuration:",
				result.reason,
			);
		}
	}
	return settled.flatMap((result) =>
		result.status === "fulfilled" && result.value.status === "applied"
			? [result.value]
			: [],
	);
}

async function readAgentServers(resolvedAgent: string) {
	try {
		return (await readAgentMcpFileAsync(resolvedAgent)).servers;
	} catch {
		return [];
	}
}

function resolveRegisteredAgent(agentCwd: string): string | undefined {
	return resolveAgentMetadataPath(loadConfig(), agentCwd);
}

export async function syncAgentMcpList(
	ws: ServerWebSocket<unknown>,
	pool: SessionPool,
	entry: PoolEntry,
	agentCwd: string,
): Promise<void> {
	const resolvedAgent = resolveRegisteredAgent(agentCwd);
	if (!resolvedAgent) return;
	const definitions = await readAgentServers(resolvedAgent);
	const applied = await applyLiveClaudeMcpConfig(
		pool,
		resolvedAgent,
		definitions,
	);
	const liveByName = new Map(
		(applied[0]?.statuses ?? []).map((status) => [status.name, status]),
	);
	const servers = definitions.map(({ name, disabled }) =>
		mapMcpServer({
			name,
			status: disabled
				? "disabled"
				: (liveByName.get(name)?.status ?? "pending"),
			scope: "project",
			error: disabled ? undefined : liveByName.get(name)?.error,
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

async function readVaultServers(vaultPath: string) {
	try {
		return (await readVaultMcpFileAsync(vaultPath)).servers;
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
		? await readAgentServers(resolvedAgent)
		: config.vault.path
			? await readVaultServers(config.vault.path)
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

export async function syncVaultMcpList(pool: SessionPool): Promise<void> {
	const config = loadConfig();
	if (!config.vault.path) return;
	const definitions = await readVaultServers(config.vault.path);
	await applyLiveClaudeMcpConfig(pool, config.vault.path, definitions);
	const cached = pool.vaultEntry().manager.getLastMcpStatus() ?? [];
	const cachedByName = new Map(cached.map((server) => [server.name, server]));
	const preserved = cached
		.filter((server) => server.scope !== "project")
		.map(mapMcpServer);
	const vault = definitions.map(({ name, disabled }) => {
		const known = cachedByName.get(name);
		return mapMcpServer({
			name,
			status: disabled ? "disabled" : (known?.status ?? "pending"),
			scope: "project",
			error: disabled ? undefined : known?.error,
		});
	});
	const providerId = pool.vaultEntry().manager.getProviderId();
	broadcast({
		type: "mcp_status",
		...(providerId ? { provider_id: providerId } : {}),
		servers: [...preserved, ...vault],
	});
}
