import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";

export async function handleMicrosoftVoices(
	request: Request,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	return dbFetch("/read-aloud/voices", {
		signal: request.signal,
	});
}

export const Route = createFileRoute("/api/read-aloud/voices")({
	server: {
		handlers: { GET: ({ request }) => handleMicrosoftVoices(request) },
	},
});
