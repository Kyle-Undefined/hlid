/**
 * Pure helper functions for per-agent MCP server management.
 * These functions operate on {agentPath}/.mcp.json and
 * {agentPath}/.claude/settings.local.json without referencing
 * any server function infrastructure or config loading.
 *
 * Callers are responsible for authorising the agentPath before calling.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { Agent, HlidConfig } from "../config";
import { findAgentInstructionFile } from "./agentInstructions";
import { expandTilde, samePath } from "./paths";
import {
	readProjectMcpFile,
	toggleProjectMcpFile,
	writeProjectMcpFile,
} from "./projectMcp";

// ─── Name helper ─────────────────────────────────────────────────────────────

/**
 * Derive a human-readable display name from an agent directory path.
 * e.g. "/projects/my-cool_agent" → "My Cool Agent"
 */
function deriveAgentName(p: string): string {
	return basename(p)
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

export function agentConfigToEntry(agent: Agent) {
	const resolved = expandTilde(agent.path);
	return {
		path: agent.path,
		name: agent.name ?? deriveAgentName(resolved),
		mode: agent.mode ?? "cwd",
		provider: agent.provider ?? "claude",
		instructionFile: findAgentInstructionFile(resolved),
		dirExists: existsSync(resolved),
		model: agent.model,
		effort: agent.effort,
		maxTurns:
			agent.max_turns !== undefined ? String(agent.max_turns) : undefined,
		permissionMode: agent.permission_mode,
		recapModel: agent.recap_model,
		interactiveMode: agent.interactive_mode,
	};
}

export function inspectAgentPath(agentPath: string, config: HlidConfig) {
	const resolvedPath = resolve(expandTilde(agentPath));
	const vaultPath = config.vault.path
		? resolve(expandTilde(config.vault.path))
		: "";
	const relativeToVault = vaultPath ? relative(vaultPath, resolvedPath) : "";
	const inVault = Boolean(
		vaultPath &&
			(samePath(resolvedPath, vaultPath) ||
				(!relativeToVault.startsWith("..") && !isAbsolute(relativeToVault))),
	);

	return {
		dirExists: existsSync(resolvedPath),
		instructionFile: findAgentInstructionFile(resolvedPath),
		suggestedName: deriveAgentName(resolvedPath),
		inVault,
		externalAllowed: config.server.allow_external_agents,
		resolvedPath,
	};
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Validate that agentPath refers to a registered agent in config.
 * Throws "Unauthorized" if the path is not in config.agents.
 */
export function resolveAuthorizedAgentPath(
	agentPath: string,
	config: HlidConfig,
): string {
	let requested: string;
	try {
		requested = realpathSync(resolve(expandTilde(agentPath)));
	} catch {
		throw new Error("Unauthorized");
	}
	const allowedPaths = (config.agents ?? []).flatMap((agent) => {
		try {
			return [realpathSync(resolve(expandTilde(agent.path)))];
		} catch {
			return [];
		}
	});
	if (!allowedPaths.some((p) => samePath(p, requested))) {
		throw new Error("Unauthorized");
	}
	return requested;
}

export function validateAgentPath(agentPath: string, config: HlidConfig): void {
	resolveAuthorizedAgentPath(agentPath, config);
}

// ─── Read helper ─────────────────────────────────────────────────────────────

/**
 * Read MCP server list from {resolvedPath}/.mcp.json merged with the
 * disabledMcpjsonServers list in {resolvedPath}/.claude/settings.local.json.
 * ENOENT on either file is treated as empty. Caller must have already
 * validated that resolvedPath is an authorised agent path.
 */
export function readAgentMcpFile(resolvedPath: string): {
	servers: Array<{ name: string; config: unknown; disabled: boolean }>;
} {
	return readProjectMcpFile(resolvedPath);
}

// ─── Write helpers ────────────────────────────────────────────────────────────

/**
 * Persist a full mcpServers map to {agentPath}/.mcp.json.
 * Overwrites any existing file.
 */
export function writeAgentMcpFile(
	agentPath: string,
	servers: Record<string, unknown>,
): void {
	writeProjectMcpFile(agentPath, servers);
}

/**
 * Add or remove a server name from the disabledMcpjsonServers list in
 * {agentPath}/.claude/settings.local.json.
 * Creates the .claude/ directory and file if they do not exist.
 * Preserves all other keys in settings.local.json.
 */
export function toggleAgentMcpFile(
	agentPath: string,
	name: string,
	disabled: boolean,
): void {
	toggleProjectMcpFile(agentPath, name, disabled);
}
