import { createFileRoute } from "@tanstack/react-router";
import { inspectAgentPath } from "#/lib/agentMcp";
import { loadConfig } from "#/server/config";
import { getAgentPath } from "./-agentRouteHelpers";

// ─── Handler (exported for unit tests) ───────────────────────────────────────

export async function handleValidateAgentPath(
	request: Request,
): Promise<Response> {
	const agentPath = getAgentPath(request);
	if (agentPath instanceof Response) return agentPath;

	try {
		const config = loadConfig();
		return Response.json(inspectAgentPath(agentPath, config));
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Internal error";
		return Response.json({ error: msg }, { status: 500 });
	}
}

// ─── Route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/api/agents/validate")({
	server: {
		handlers: {
			GET: ({ request }) => handleValidateAgentPath(request),
		},
	},
});
