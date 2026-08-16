import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { isValidNeuralReadingId } from "#/lib/readAloud";

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
	if (source.searchParams.get("provider") === "neural") {
		query.set("provider", "neural");
		query.set("chunk_index", source.searchParams.get("chunk_index") ?? "");
		const readingId = source.searchParams.get("reading_id");
		if (readingId !== null) {
			if (!isValidNeuralReadingId(readingId)) {
				return Response.json(
					{ error: "invalid reading_id" },
					{
						status: 400,
						headers: { "cache-control": "private, no-store" },
					},
				);
			}
			query.set("reading_id", readingId);
		}
	}
	return dbFetch(`/read-aloud/audio?${query}`, {
		signal: request.signal,
	});
}

export const Route = createFileRoute("/api/read-aloud/audio")({
	server: {
		handlers: { GET: ({ request }) => handleMicrosoftAudio(request) },
	},
});
