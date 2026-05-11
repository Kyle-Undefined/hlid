import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { AgentSchema } from "#/config";
import { deriveAgentName } from "#/lib/agentMcp";
import { writeConfig } from "#/lib/config-writer";
import { forbiddenResponse } from "#/lib/originGate";
import { expandTilde } from "#/lib/paths";
import { loadConfig } from "#/server/config";

// ─── Handlers (exported for unit tests) ──────────────────────────────────────

export async function handleGetAgents(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const config = loadConfig();
	const agents = (config.agents ?? []).map((agent) => {
		const resolved = expandTilde(agent.path);
		return {
			path: agent.path,
			name: agent.name ?? deriveAgentName(resolved),
			mode: agent.mode ?? "cwd",
			provider: agent.provider ?? "claude",
			hasClaudemd: existsSync(join(resolved, "CLAUDE.md")),
			dirExists: existsSync(resolved),
			model: agent.model,
			effort: agent.effort,
			maxTurns:
				agent.max_turns !== undefined ? String(agent.max_turns) : undefined,
			permissionMode: agent.permission_mode,
			recapModel: agent.recap_model,
		};
	});

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
