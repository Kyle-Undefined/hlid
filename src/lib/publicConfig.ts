import type { HlidConfig } from "#/config";

/** Round-trips through Forge without disclosing an existing external secret. */
export const CONFIG_SECRET_SENTINEL = "__HLID_SECRET_SET__";

export function publicConfig(config: HlidConfig): HlidConfig {
	if (!config.cliproxy.api_key) return config;
	return {
		...config,
		cliproxy: {
			...config.cliproxy,
			api_key: CONFIG_SECRET_SENTINEL,
		},
	};
}

export function restoreConfigSecrets(
	raw: unknown,
	current: HlidConfig,
): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const record = raw as Record<string, unknown>;
	const cliProxy = record.cliproxy;
	if (!cliProxy || typeof cliProxy !== "object") return raw;
	const proxyRecord = cliProxy as Record<string, unknown>;
	if (proxyRecord.api_key !== CONFIG_SECRET_SENTINEL) return raw;
	return {
		...record,
		cliproxy: { ...proxyRecord, api_key: current.cliproxy.api_key },
	};
}
