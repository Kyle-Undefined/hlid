/** Configured-agent listing server fns. */
import { basename, extname } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { getConfig } from "./config";

export type AgentListItem = {
	path: string;
	name: string;
	model?: string;
	/** Provider this agent runs on, e.g. "claude" or "codex". Defaults to "claude". */
	provider: string;
};

/** Resolves the list of configured agents with display names. */
export const getAgentListFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const config = await getConfig();
		return (config.agents ?? []).map(
			(a): AgentListItem => ({
				path: a.path,
				name:
					a.name ??
					basename(a.path, extname(a.path))
						.split(/[-_\s]+/)
						.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
						.join(" "),
				...(a.model ? { model: a.model } : {}),
				provider: a.provider ?? "claude",
			}),
		);
	},
);
