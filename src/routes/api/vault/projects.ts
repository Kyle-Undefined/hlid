import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { scanProjects } from "#/lib/vault";
import { loadConfig } from "#/server/config";

export async function handleGetProjects(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const config = loadConfig();
	if (!config.vault.path || !config.vault.projects) {
		return Response.json(
			{ error: "No vault or projects folder configured" },
			{ status: 400 },
		);
	}

	const projects = scanProjects(
		config.vault.path,
		config.vault.projects,
		config.status_vocabulary,
	);
	return Response.json(projects);
}

export const Route = createFileRoute("/api/vault/projects")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetProjects(request),
		},
	},
});
