/** Configured-agent listing server fns. */

import { basename, extname, resolve } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { expandTilde } from "#/lib/paths";
import { getConfig } from "./config";

export type AgentListItem = {
	path: string;
	/** Canonical path persisted with session rows when it can be resolved. */
	resolvedPath?: string;
	name: string;
	model?: string;
	effort?: string;
	/** Provider this agent runs on, e.g. "claude" or "codex". Defaults to "claude". */
	provider: string;
};

/** Resolves the list of configured agents with display names. */
export const getAgentListFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const config = await getConfig();
		return (config.agents ?? []).map((a): AgentListItem => {
			// Route inventory only needs a stable display path. Canonical filesystem
			// resolution can block for tens of seconds on an unavailable Windows/WSL
			// mount, so leave authoritative realpath validation to session start.
			const resolvedPath = resolve(expandTilde(a.path));
			return {
				path: a.path,
				resolvedPath,
				name:
					a.name ??
					basename(a.path, extname(a.path))
						.split(/[-_\s]+/)
						.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
						.join(" "),
				...(a.model ? { model: a.model } : {}),
				...(a.effort ? { effort: a.effort } : {}),
				provider: a.provider ?? "claude",
			};
		});
	},
);
