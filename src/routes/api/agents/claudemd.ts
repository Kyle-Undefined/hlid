import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { validateAgentPath } from "#/lib/agentMcp";
import { expandTilde } from "#/lib/paths";
import { loadConfig } from "#/server/config";
import { getAgentPath } from "./-agentRouteHelpers";

// ─── Handler (exported for unit tests) ───────────────────────────────────────

export async function handleGetClaudeMd(request: Request): Promise<Response> {
	const agentPath = getAgentPath(request);
	if (agentPath instanceof Response) return agentPath;

	const config = loadConfig();
	try {
		validateAgentPath(agentPath, config);
	} catch (e) {
		if (e instanceof Error && e.message === "Unauthorized") {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}
		throw e;
	}

	const resolvedPath = resolve(expandTilde(agentPath));
	const claudemdPath = join(resolvedPath, "CLAUDE.md");
	try {
		return Response.json({ content: readFileSync(claudemdPath, "utf-8") });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			return Response.json({ content: null });
		}
		throw e;
	}
}

// ─── Route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/api/agents/claudemd")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetClaudeMd(request),
		},
	},
});
