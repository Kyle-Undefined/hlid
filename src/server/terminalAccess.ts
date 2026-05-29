import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { HlidConfig } from "../config";
import { expandTilde, samePath } from "../lib/paths";
import { computeAllowedAgentRealPaths, isAllowedAgentPath } from "./agentPaths";

/**
 * Resolve and authorize the cwd requested for a terminal session.
 * Terminal PTYs may run in the vault or in one of the configured agent roots.
 */
export function resolveAllowedTerminalCwd(
	config: HlidConfig,
	requestedCwd: string,
): string | null {
	try {
		const requestedReal = realpathSync(resolve(expandTilde(requestedCwd)));
		const vaultReal = realpathSync(resolve(expandTilde(config.vault.path)));
		if (samePath(vaultReal, requestedReal)) return requestedReal;

		const allowedAgents = computeAllowedAgentRealPaths(config);
		if (isAllowedAgentPath(allowedAgents, requestedReal)) return requestedReal;
	} catch {
		return null;
	}

	return null;
}
