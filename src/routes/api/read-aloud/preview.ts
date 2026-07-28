import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";

export async function handleNeuralPreview(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	return dbFetch("/read-aloud/preview", {
		signal: request.signal,
	});
}

export const Route = createFileRoute("/api/read-aloud/preview")({
	server: {
		handlers: { GET: ({ request }) => handleNeuralPreview(request) },
	},
});
