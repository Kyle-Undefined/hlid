/**
 * Claude Code CLI launch warm-up.
 *
 * Counterpart of prewarmCodexAppServer for the Claude side. Claude Code has no
 * shared app-server to keep alive — every session is its own CLI process — so
 * the warm-up spawns one throwaway SDK query (never-yielding streaming prompt,
 * deny-all tools), waits for the CLI's initialize handshake over the control
 * protocol, snapshots the metadata it returns (slash commands/skills, agents,
 * models, MCP server status), and aborts the process.
 *
 * The snapshot is the product value: Raven can show Claude skills, commands,
 * and MCP availability before a chat process exists. The OS file cache may
 * also make the first real chat spawn faster, but chat lifecycle is deliberately
 * independent from this metadata scan. The control protocol never triggers
 * model inference, so discovery costs zero tokens.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { expandTilde } from "../lib/paths";
import type { McpServerStatus, SlashCommand } from "./agentProvider";

export type ClaudeWarmupSnapshot = {
	/** Slash commands / skills discovered by the CLI at initialize. */
	commands: SlashCommand[];
	/** Subagent definitions available to sessions started from this cwd. */
	agents: Array<{ name: string }>;
	/** MCP server connectivity at initialize (may still be "pending"). */
	mcpServers: McpServerStatus[];
	/** Models the CLI reports as available. */
	modelCount: number;
	/** Provider scope this metadata belongs to. */
	cwd: string;
	warmedAt: number;
	durationMs: number;
};

export type ClaudeWarmupOptions = {
	executable: string | undefined;
	/** Actual cwd passed to the Claude CLI. */
	cwd: string;
	/** Provider scope used for cache lookup; defaults to cwd. */
	cacheCwd?: string;
	additionalDirectories?: string[];
	waitTimeoutMs?: number;
};

const snapshots = new Map<string, ClaudeWarmupSnapshot>();
const inFlight = new Map<string, Promise<void>>();
let latestKey: string | null = null;
const DISCOVERY_TIMEOUT_MS = 30_000;
const MCP_SETTLE_TIMEOUT_MS = 10_000;
const MCP_POLL_INTERVAL_MS = 500;
const PROVIDER_WIDE_MCP_SCOPES = new Set(["claudeai", "user", "managed"]);

function cacheKey(cwd: string): string {
	const expanded = expandTilde(cwd);
	try {
		return realpathSync(expanded);
	} catch {
		return resolve(expanded);
	}
}

function mapMcpStatus(status: string): McpServerStatus["status"] {
	if (status === "notLoggedIn") return "needs-auth";
	if (
		status === "failed" ||
		status === "disabled" ||
		status === "pending" ||
		status === "needs-auth"
	)
		return status;
	return "connected";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Claude can report remote claude.ai connectors as pending immediately after
 * initialize, then connected a moment later. Keep the metadata-only process
 * around briefly so the startup cache records the settled state instead of a
 * transient first frame. The bounded wait never sends a user turn.
 */
async function readSettledMcpStatus(
	q: Pick<ReturnType<typeof query>, "mcpServerStatus">,
): Promise<Awaited<ReturnType<typeof q.mcpServerStatus>>> {
	let latest = await q.mcpServerStatus().catch(() => []);
	const deadline = Date.now() + MCP_SETTLE_TIMEOUT_MS;
	while (
		latest.some((server) => server.status === "pending") &&
		Date.now() < deadline
	) {
		await delay(Math.min(MCP_POLL_INTERVAL_MS, deadline - Date.now()));
		latest = await q.mcpServerStatus().catch(() => latest);
	}
	return latest;
}

/** Cached provider metadata for a cwd, or the latest startup snapshot. */
export function getClaudeWarmupSnapshot(
	cwd?: string,
): ClaudeWarmupSnapshot | null {
	const key = cwd ? cacheKey(cwd) : latestKey;
	return key ? (snapshots.get(key) ?? null) : null;
}

/**
 * Read cached metadata, waiting for the startup scan already running for this
 * scope when necessary. This never starts a process itself.
 */
export async function waitForClaudeWarmupSnapshot(
	cwd: string,
): Promise<ClaudeWarmupSnapshot | null> {
	const key = cacheKey(cwd);
	if (!snapshots.has(key)) await inFlight.get(key);
	const scoped = snapshots.get(key);
	const providerWide = new Map<string, McpServerStatus>();
	for (const snapshot of snapshots.values()) {
		for (const server of snapshot.mcpServers) {
			if (server.scope && PROVIDER_WIDE_MCP_SCOPES.has(server.scope)) {
				providerWide.set(server.name, server);
			}
		}
	}
	if (scoped) {
		const mcpServers = new Map(
			scoped.mcpServers.map((server) => [server.name, server]),
		);
		for (const [name, server] of providerWide) {
			if (!mcpServers.has(name)) mcpServers.set(name, server);
		}
		return { ...scoped, mcpServers: [...mcpServers.values()] };
	}
	if (providerWide.size === 0) return null;
	const latest = [...snapshots.values()].sort(
		(a, b) => b.warmedAt - a.warmedAt,
	)[0];
	return {
		commands: [],
		agents: [],
		mcpServers: [...providerWide.values()],
		modelCount: 0,
		cwd,
		warmedAt: latest?.warmedAt ?? Date.now(),
		durationMs: 0,
	};
}

/**
 * Wait for every startup metadata scan and return the provider-wide inventory.
 * Cockpit uses this unscoped view to aggregate Claude MCPs across the vault and
 * configured agents without starting any chat process.
 */
export async function waitForAllClaudeWarmupSnapshots(): Promise<
	ClaudeWarmupSnapshot[]
> {
	await Promise.all([...inFlight.values()]);
	return [...snapshots.values()];
}

async function runWarmup(options: ClaudeWarmupOptions): Promise<void> {
	const { executable, cwd, additionalDirectories } = options;
	const scopedCwd = options.cacheCwd ?? cwd;
	const started = Date.now();
	const ac = new AbortController();
	// biome-ignore lint/suspicious/noExplicitAny: SDK canUseTool type changed between versions
	const denyAllCanUseTool: any = async () => ({
		behavior: "deny",
		message: "warmup probe",
	});
	const q = query({
		prompt: (async function* () {
			// Never yields — the warm-up never sends a user turn.
			await new Promise<never>(() => {});
		})(),
		options: {
			cwd,
			abortController: ac,
			persistSession: false,
			settingSources: ["user", "project", "local"],
			maxTurns: 1,
			...(additionalDirectories?.length ? { additionalDirectories } : {}),
			...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
			canUseTool: denyAllCanUseTool,
		},
	});
	try {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const init = await Promise.race([
			q.initializationResult(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					ac.abort();
					reject(new Error("Claude metadata discovery timed out"));
				}, DISCOVERY_TIMEOUT_MS);
				timeout.unref?.();
			}),
		]).finally(() => {
			if (timeout !== undefined) clearTimeout(timeout);
		});
		const mcp = await readSettledMcpStatus(q);
		const key = cacheKey(scopedCwd);
		const snapshot: ClaudeWarmupSnapshot = {
			commands: (init.commands ?? []).map((c) => ({
				name: c.name,
				description: c.description,
				argumentHint: c.argumentHint ?? "",
			})),
			agents: (init.agents ?? []).map((a) => ({ name: a.name })),
			mcpServers: mcp.map((server) => {
				const item = server as {
					name: string;
					status: string;
					error?: string;
					scope?: string;
				};
				return {
					name: item.name,
					status: mapMcpStatus(item.status),
					...(item.error ? { error: item.error } : {}),
					...(item.scope ? { scope: item.scope } : {}),
				};
			}),
			modelCount: (init.models ?? []).length,
			cwd: scopedCwd,
			warmedAt: Date.now(),
			durationMs: Date.now() - started,
		};
		snapshots.set(key, snapshot);
		latestKey = key;
	} finally {
		ac.abort();
	}
}

/**
 * Spawn and initialize a throwaway Claude CLI without sending a turn. When
 * `waitTimeoutMs` is set, return false after that bounded wait while the
 * warm-up continues in the background (mirrors prewarmCodexAppServer).
 */
export async function prewarmClaudeCli(
	options: ClaudeWarmupOptions,
): Promise<boolean> {
	const key = cacheKey(options.cacheCwd ?? options.cwd);
	let warm = inFlight.get(key);
	if (!warm) {
		const started = runWarmup(options)
			.catch(() => {
				// Discovery is opportunistic; a failed spawn must never affect startup.
			})
			.finally(() => {
				if (inFlight.get(key) === started) inFlight.delete(key);
			});
		warm = started;
		inFlight.set(key, warm);
	}
	if (options.waitTimeoutMs === undefined) {
		await warm;
		return true;
	}
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			warm.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(
					() => resolve(false),
					Math.max(0, options.waitTimeoutMs ?? 0),
				);
				timeout.unref?.();
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}
