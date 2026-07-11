import { createFileRoute } from "@tanstack/react-router";
import { AgentSchema } from "#/config";
import { agentConfigToEntry } from "#/lib/agentMcp";
import { writeConfig } from "#/lib/config-writer";
import { forbiddenResponse } from "#/lib/originGate";
import { loadConfig } from "#/server/config";

// ─── Handlers (exported for unit tests) ──────────────────────────────────────

export async function handleGetAgents(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const config = loadConfig();
	const agents = (config.agents ?? []).map(agentConfigToEntry);

	return Response.json(agents);
}

export async function handlePostAgents(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	try {
		const raw = await request.json();
		const parsed = AgentSchema.array().safeParse(raw);
		if (!parsed.success) {
			return Response.json(
				{ error: "Invalid agents payload", details: parsed.error.issues },
				{ status: 400 },
			);
		}
		const config = loadConfig();
		writeConfig({ ...config, agents: parsed.data });
		return Response.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Bad request";
		return Response.json({ error: msg }, { status: 400 });
	}
}

// ─── Route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/api/agents/")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetAgents(request),
			POST: ({ request }) => handlePostAgents(request),
		},
	},
});
