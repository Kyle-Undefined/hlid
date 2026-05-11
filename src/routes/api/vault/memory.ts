import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { scanMemory } from "#/lib/vault";
import { loadConfig } from "#/server/config";

export async function handleGetMemory(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const config = loadConfig();
	if (!config.vault.path) {
		return Response.json({ error: "No vault configured" }, { status: 400 });
	}

	const url = new URL(request.url);
	const folder =
		url.searchParams.get("folder") ?? config.vault.memory ?? "memory";

	if (!folder) {
		return Response.json(
			{ error: "No memory folder configured" },
			{ status: 400 },
		);
	}

	try {
		const files = scanMemory(config.vault.path, folder);
		return Response.json(files);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Internal error";
		return Response.json({ error: msg }, { status: 500 });
	}
}

export const Route = createFileRoute("/api/vault/memory")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetMemory(request),
		},
	},
});
