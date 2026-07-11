import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import {
	contentLengthExceeds,
	createConcurrencyGate,
	MAX_VOICE_BODY_BYTES,
	payloadTooLarge,
	readRequestBodyLimited,
} from "#/server/requestLimits";

const transcriptionGate = createConcurrencyGate(2);

export async function handleVoiceTranscription(
	request: Request,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	const release = transcriptionGate.tryEnter();
	if (!release) {
		return Response.json(
			{ error: "voice transcription capacity reached" },
			{ status: 429, headers: { "retry-after": "1" } },
		);
	}
	try {
		if (contentLengthExceeds(request, MAX_VOICE_BODY_BYTES)) {
			return payloadTooLarge(MAX_VOICE_BODY_BYTES);
		}
		const contentType = request.headers.get("content-type");
		if (!contentType?.startsWith("multipart/form-data")) {
			return Response.json(
				{ error: "multipart audio is required" },
				{ status: 400 },
			);
		}
		const limited = await readRequestBodyLimited(request, MAX_VOICE_BODY_BYTES);
		if (!limited.ok) return limited.response;
		return dbFetch("/voice/transcribe", {
			method: "POST",
			headers: { "content-type": contentType },
			body: limited.body,
			signal: request.signal,
			duplex: "half",
		} as RequestInit);
	} finally {
		release();
	}
}

export const Route = createFileRoute("/api/voice/transcribe")({
	server: {
		handlers: { POST: ({ request }) => handleVoiceTranscription(request) },
	},
});
