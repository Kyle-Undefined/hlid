import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";

export async function handleVoiceTranscription(
	request: Request,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	const contentType = request.headers.get("content-type");
	if (!contentType?.startsWith("multipart/form-data")) {
		return Response.json(
			{ error: "multipart audio is required" },
			{ status: 400 },
		);
	}
	return dbFetch("/voice/transcribe", {
		method: "POST",
		headers: { "content-type": contentType },
		body: request.body,
		signal: request.signal,
		duplex: "half",
	} as RequestInit);
}

export const Route = createFileRoute("/api/voice/transcribe")({
	server: {
		handlers: { POST: ({ request }) => handleVoiceTranscription(request) },
	},
});
