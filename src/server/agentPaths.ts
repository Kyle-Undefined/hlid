import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { HlidConfig } from "../config";
import { expandTilde, samePath } from "../lib/paths";
import { loadConfig } from "./config";

/** Look up agent mode ("context" | "cwd") for a resolved agent path. */
export function resolveAgentMode(agentRealPath: string): "context" | "cwd" {
	try {
		const cfg = loadConfig();
		const matched = (cfg.agents ?? []).find((a) => {
			try {
				return samePath(
					realpathSync(resolve(expandTilde(a.path))),
					agentRealPath,
				);
			} catch {
				return false;
			}
		});
		return matched?.mode === "context" ? "context" : "cwd";
	} catch (err) {
		console.error(
			"[agentPaths] resolveAgentMode failed, defaulting to 'cwd':",
			err,
		);
		return "cwd";
	}
}

/** Resolve all configured agent paths to their real filesystem paths. */
export function computeAllowedAgentRealPaths(config: HlidConfig): string[] {
	const paths: string[] = [];
	for (const agent of config.agents ?? []) {
		try {
			paths.push(realpathSync(resolve(expandTilde(agent.path))));
		} catch {
			// agent dir missing, skip. Will be rejected at use site.
		}
	}
	return paths;
}

/** Return true if candidate matches any of the allowed agent real paths. */
export function isAllowedAgentPath(
	allowed: string[],
	candidate: string,
): boolean {
	return allowed.some((p) => samePath(p, candidate));
}
