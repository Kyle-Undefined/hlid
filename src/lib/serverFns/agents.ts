/** Configured-agent listing server fns. */

import { realpathSync } from "node:fs";
import { basename, extname } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { expandTilde } from "#/lib/paths";
import { getConfig } from "./config";

export type AgentListItem = {
	path: string;
	/** Canonical path persisted with session rows when it can be resolved. */
	resolvedPath?: string;
	name: string;
	model?: string;
	/** Provider this agent runs on, e.g. "claude" or "codex". Defaults to "claude". */
	provider: string;
};

/** Resolves the list of configured agents with display names. */
export const getAgentListFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const config = await getConfig();
		return (config.agents ?? []).map((a): AgentListItem => {
			let resolvedPath: string | undefined;
			try {
				resolvedPath = realpathSync(expandTilde(a.path));
			} catch {
				// Keep a configured-but-not-currently-mounted agent selectable.
			}
			return {
				path: a.path,
				...(resolvedPath ? { resolvedPath } : {}),
				name:
					a.name ??
					basename(a.path, extname(a.path))
						.split(/[-_\s]+/)
						.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
						.join(" "),
				...(a.model ? { model: a.model } : {}),
				provider: a.provider ?? "claude",
			};
		});
	},
);
