import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { loadConfig } from "#/server/config";
import { getVaultSnapshot } from "#/server/vaultSnapshot";

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

	const snapshot = (await getVaultSnapshot()).vault;
	return Response.json({
		skills: snapshot.skills,
		sectionOrder: snapshot.sectionOrder,
	});
}

export const Route = createFileRoute("/api/vault/skills")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetSkills(request),
		},
	},
});
