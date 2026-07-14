import { loadConfig } from "#/server/config";
import { loadToken } from "./token";

export type CliRuntimeDrainResult = {
	sessions: number;
	appServers: number;
};

/** Ask the owner server to release provider CLI children while leaving terminals up. */
export async function drainCliRuntime(): Promise<CliRuntimeDrainResult> {
	const config = loadConfig();
	const response = await fetch(
		`http://127.0.0.1:${config.server.port + 1}/internal/cli-updates/drain`,
		{
			method: "POST",
			headers: { "x-hlid-internal": loadToken() },
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok) {
		throw new Error(`failed to stop CLI sessions (HTTP ${response.status})`);
	}
	const body = (await response.json()) as {
		ok?: unknown;
		data?: Partial<CliRuntimeDrainResult>;
	};
	if (body.ok !== true) throw new Error("failed to stop CLI sessions");
	return {
		sessions: Number(body.data?.sessions ?? 0),
		appServers: Number(body.data?.appServers ?? 0),
	};
}
