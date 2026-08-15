import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { isExactSameOriginMutation } from "#/lib/sameOriginRequest";
import { readRequestBodyLimited } from "#/server/requestLimits";
import { MAX_SPEECH_SYNTHESIS_BODY_BYTES } from "#/server/speechRoutes";

export async function handleSpeechSynthesis(
	request: Request,
	backendPath = "/speech/synthesize",
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	if (
		request.headers
			.get("content-type")
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase() !== "application/json"
	) {
		return Response.json(
			{ error: "application/json body is required" },
			{ status: 415, headers: { "cache-control": "no-store" } },
		);
	}
	if (!isExactSameOriginMutation(request)) {
		return Response.json(
			{ error: "Forbidden" },
			{ status: 403, headers: { "cache-control": "no-store" } },
		);
	}
	const limited = await readRequestBodyLimited(
		request,
		MAX_SPEECH_SYNTHESIS_BODY_BYTES,
	);
	if (!limited.ok) return limited.response;
	return dbFetch(backendPath, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: limited.body,
		signal: request.signal,
	});
}

export const Route = createFileRoute("/api/speech/synthesize")({
	server: {
		handlers: { POST: ({ request }) => handleSpeechSynthesis(request) },
	},
});
