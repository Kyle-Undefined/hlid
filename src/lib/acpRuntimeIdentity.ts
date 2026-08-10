import type { HlidConfig } from "#/config";

/**
 * Stable identity for the ACP subprocess configuration that can be applied
 * without restarting Hlid. Provider defaults such as model and effort are
 * intentionally excluded because SessionManager consumes those from config at
 * the next turn without replacing the provider runtime. OpenCode model filters
 * are included because Hlid applies them to the subprocess environment.
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
				modelFilter: agent.model_filter
					? {
							mode: agent.model_filter.mode,
							models: [...new Set(agent.model_filter.models)].sort((a, b) =>
								a.localeCompare(b),
							),
						}
					: undefined,
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
	);
}
