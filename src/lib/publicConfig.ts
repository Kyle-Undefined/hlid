import type { HlidConfig } from "#/config";

/** Round-trips through Forge without disclosing an existing external secret. */
export const CONFIG_SECRET_SENTINEL = "__HLID_SECRET_SET__";

export function publicConfig(config: HlidConfig): HlidConfig {
	const acpAgents = config.acp_agents?.map((agent) =>
		agent.env
			? {
					...agent,
					env: Object.fromEntries(
						Object.keys(agent.env).map((key) => [key, CONFIG_SECRET_SENTINEL]),
					),
				}
			: agent,
	);
	if (!config.cliproxy.api_key && acpAgents === undefined) return config;
	return {
		...config,
		...(config.cliproxy.api_key
			? {
					cliproxy: {
						...config.cliproxy,
						api_key: CONFIG_SECRET_SENTINEL,
					},
				}
			: {}),
		...(acpAgents ? { acp_agents: acpAgents } : {}),
	};
}

export function restoreConfigSecrets(
	raw: unknown,
	current: HlidConfig,
): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const record = raw as Record<string, unknown>;
	let restored: Record<string, unknown> = record;
	const cliProxy = record.cliproxy;
	if (cliProxy && typeof cliProxy === "object") {
		const proxyRecord = cliProxy as Record<string, unknown>;
		if (proxyRecord.api_key === CONFIG_SECRET_SENTINEL) {
			restored = {
				...restored,
				cliproxy: { ...proxyRecord, api_key: current.cliproxy.api_key },
			};
		}
	}
	const rawAgents = record.acp_agents;
	if (!Array.isArray(rawAgents)) return restored;
	return {
		...restored,
		acp_agents: rawAgents.map((rawAgent) => {
			if (!rawAgent || typeof rawAgent !== "object") return rawAgent;
			const agent = rawAgent as Record<string, unknown>;
			const env = agent.env;
			if (!env || typeof env !== "object" || Array.isArray(env)) return agent;
			const id = typeof agent.id === "string" ? agent.id : "";
			const currentEnv = current.acp_agents?.find(
				(candidate) => candidate.id === id,
			)?.env;
			return {
				...agent,
				env: Object.fromEntries(
					Object.entries(env as Record<string, unknown>).map(([key, value]) => [
						key,
						value === CONFIG_SECRET_SENTINEL && currentEnv?.[key] !== undefined
							? currentEnv[key]
							: value,
					]),
				),
			};
		}),
	};
}
