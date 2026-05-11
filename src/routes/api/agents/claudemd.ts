import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { validateAgentPath } from "#/lib/agentMcp";
import { forbiddenResponse } from "#/lib/originGate";
import { expandTilde } from "#/lib/paths";
import { loadConfig } from "#/server/config";

// ─── Handler (exported for unit tests) ───────────────────────────────────────

export async function handleGetClaudeMd(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const url = new URL(request.url);
	const agentPath = url.searchParams.get("path");
	if (!agentPath) {
		return Response.json({ error: "Missing path param" }, { status: 400 });
	}

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
