import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";

export async function handleMicrosoftAudio(
	request: Request,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	const source = new URL(request.url);
	const query = new URLSearchParams();
	query.set("message_id", source.searchParams.get("message_id") ?? "");
	const voiceId = source.searchParams.get("voice_id");
	if (voiceId) query.set("voice_id", voiceId);
	return dbFetch(`/read-aloud/audio?${query}`, {
		signal: request.signal,
	});
}

export const Route = createFileRoute("/api/read-aloud/audio")({
	server: {
		handlers: { GET: ({ request }) => handleMicrosoftAudio(request) },
	},
});
