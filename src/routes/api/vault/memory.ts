import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { scanMemory } from "#/lib/vault";
import { loadConfig } from "#/server/config";

export async function handleGetMemory(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const config = loadConfig();
	if (!config.vault.path || !config.vault.memory) {
		return Response.json(
			{ error: "No vault or memory folder configured" },
			{ status: 400 },
		);
	}

	const files = scanMemory(config.vault.path, config.vault.memory);
	return Response.json(files);
}

export const Route = createFileRoute("/api/vault/memory")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetMemory(request),
		},
	},
});
