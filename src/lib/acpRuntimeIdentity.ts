import type { HlidConfig } from "#/config";

/**
 * Stable identity for the ACP subprocess configuration that can be applied
 * without restarting Hlid. Provider defaults such as model and effort are
 * intentionally excluded because SessionManager consumes those from config at
 * the next turn without replacing the provider runtime.
 */
export function acpRuntimeIdentity(
	agents: NonNullable<HlidConfig["acp_agents"]>,
): string {
	return JSON.stringify(
		agents
			.map((agent) => ({
				id: agent.id,
				executable: agent.executable,
				args: agent.args,
				env: agent.env
					? Object.fromEntries(
							Object.entries(agent.env).sort(([a], [b]) => a.localeCompare(b)),
						)
					: undefined,
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
	);
}
