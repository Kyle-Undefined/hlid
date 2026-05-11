import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { deriveAgentName } from "#/lib/agentMcp";
import { forbiddenResponse } from "#/lib/originGate";
import { expandTilde, samePath } from "#/lib/paths";
import { loadConfig } from "#/server/config";

// ─── Handler (exported for unit tests) ───────────────────────────────────────

export async function handleValidateAgentPath(
	request: Request,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const url = new URL(request.url);
	const agentPath = url.searchParams.get("path");
	if (!agentPath) {
		return Response.json({ error: "Missing path param" }, { status: 400 });
	}

	try {
		const config = loadConfig();
		const resolved = resolve(expandTilde(agentPath));
		const vaultPath = config.vault.path
			? resolve(expandTilde(config.vault.path))
			: "";

		let inVault = false;
		if (vaultPath) {
			const rel = relative(vaultPath, resolved);
			inVault =
				samePath(resolved, vaultPath) ||
				(!rel.startsWith("..") && !isAbsolute(rel));
		}

		return Response.json({
			dirExists: existsSync(resolved),
			hasClaudemd: existsSync(join(resolved, "CLAUDE.md")),
			suggestedName: deriveAgentName(resolved),
			inVault,
			externalAllowed: config.server.allow_external_agents,
			resolvedPath: resolved,
		});
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
