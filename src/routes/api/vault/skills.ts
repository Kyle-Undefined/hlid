import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { scanSkills } from "#/lib/vault";
import { loadConfig } from "#/server/config";

export async function handleGetSkills(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const config = loadConfig();
	if (!config.vault.path || !config.vault.skills) {
		return Response.json(
			{ error: "No vault or skills folder configured" },
			{ status: 400 },
		);
	}

	const result = scanSkills(
		config.vault.path,
		config.vault.skills,
		config.ui.hide_skills_index,
	);
	return Response.json(result);
}

export const Route = createFileRoute("/api/vault/skills")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetSkills(request),
		},
	},
});
