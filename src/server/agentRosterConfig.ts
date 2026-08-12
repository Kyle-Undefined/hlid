import { type Agent, HlidConfigSchema } from "#/config";
import { writeConfig } from "#/lib/config-writer";
import { dbFetch } from "#/lib/dbClient";
import { loadConfig } from "./config";

type AgentRosterConfigDependencies = {
	load: typeof loadConfig;
	write: typeof writeConfig;
	syncAcp: () => Promise<Response>;
	warn: (message: string) => void;
};

const defaultDependencies: AgentRosterConfigDependencies = {
	load: loadConfig,
	write: writeConfig,
	syncAcp: () => dbFetch("/acp/sync", { method: "POST" }),
	warn: console.warn,
};

/** Persist an agent roster through the full private config and resync ACP cwd. */
export async function saveAgentRosterConfig(
	agents: Agent[],
	dependencies: AgentRosterConfigDependencies = defaultDependencies,
): Promise<void> {
	const current = dependencies.load();
	const next = HlidConfigSchema.parse({ ...current, agents });
	dependencies.write(next);
	if ((next.acp_agents ?? []).length === 0) return;
	try {
		const response = await dependencies.syncAcp();
		if (!response.ok) {
			dependencies.warn(
				`[agents] ACP runtime synchronization returned ${response.status}.`,
			);
		}
	} catch (error) {
		dependencies.warn(
			`[agents] ACP runtime synchronization failed: ${error instanceof Error ? error.message : String(error)}.`,
		);
	}
}
