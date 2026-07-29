import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { HlidConfig } from "../config";
import {
	declaredPathKey,
	expandTilde,
	parseWslUncSyntax,
	samePath,
} from "../lib/paths";
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

/** Resolve a candidate only when it still matches a configured agent path. */
export function resolveAllowedAgentPath(
	config: HlidConfig,
	candidate: string,
): string | undefined {
	try {
		const resolved = realpathSync(resolve(expandTilde(candidate)));
		return isAllowedAgentPath(computeAllowedAgentRealPaths(config), resolved)
			? resolved
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a registered agent for read-only metadata without probing a WSL UNC
 * share. Non-WSL paths retain canonical filesystem validation. Execution and
 * mutation paths must continue to use resolveAllowedAgentPath or stricter.
 */
export function resolveAgentMetadataPath(
	config: HlidConfig,
	candidate: string,
): string | undefined {
	const expandedCandidate = expandTilde(candidate);
	if (!parseWslUncSyntax(expandedCandidate)) {
		return resolveAllowedAgentPath(config, candidate);
	}
	const candidateKey = declaredPathKey(expandedCandidate);
	const configured = (config.agents ?? []).find((agent) => {
		const expandedAgent = expandTilde(agent.path);
		return (
			parseWslUncSyntax(expandedAgent) !== null &&
			declaredPathKey(expandedAgent) === candidateKey
		);
	});
	return configured ? expandTilde(configured.path) : undefined;
}
