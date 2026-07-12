import { resolve } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { readAgentInstructions } from "#/lib/agentInstructions";
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
	const instructions = readAgentInstructions(resolvedPath);
	return Response.json(instructions ?? { filename: null, content: null });
}

// ─── Route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/api/agents/claudemd")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetClaudeMd(request),
		},
	},
});
