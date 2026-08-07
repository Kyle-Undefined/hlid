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
		const expandedCandidate = expandTilde(agentRealPath);
		const candidateWsl = parseWslUncSyntax(expandedCandidate);
		const matched = (cfg.agents ?? []).find((a) => {
			const expandedAgent = expandTilde(a.path);
			const configuredWsl = parseWslUncSyntax(expandedAgent);
			if (candidateWsl || configuredWsl) {
				return (
					candidateWsl !== null &&
					configuredWsl !== null &&
					declaredPathKey(expandedAgent) === declaredPathKey(expandedCandidate)
				);
			}
			try {
				return samePath(realpathSync(resolve(expandedAgent)), agentRealPath);
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

/** Resolve native agent roots; retain WSL declarations for deferred authorization. */
export function computeAllowedAgentRealPaths(config: HlidConfig): string[] {
	const paths: string[] = [];
	for (const agent of config.agents ?? []) {
		const expanded = expandTilde(agent.path);
		if (parseWslUncSyntax(expanded)) {
			// WSL UNC canonicalization can synchronously wake or wait on the distro.
			// Retain the exact declared root; the requested execution path is still
			// canonicalized before isAllowedAgentPath authorizes it.
			paths.push(expanded);
			continue;
		}
		try {
			paths.push(realpathSync(resolve(expanded)));
		} catch {
			// agent dir missing, skip. Will be rejected at use site.
		}
	}
	return paths;
}

/** Return true if a canonical candidate matches any configured agent root. */
export function isAllowedAgentPath(
	allowed: string[],
	candidate: string,
): boolean {
	const candidateWsl = parseWslUncSyntax(candidate);
	return allowed.some((path) => {
		const allowedWsl = parseWslUncSyntax(path);
		if (candidateWsl || allowedWsl) {
			return (
				candidateWsl !== null &&
				allowedWsl !== null &&
				declaredPathKey(path) === declaredPathKey(candidate)
			);
		}
		return samePath(path, candidate);
	});
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
