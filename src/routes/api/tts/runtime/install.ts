import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import {
	contentLengthExceeds,
	createConcurrencyGate,
	payloadTooLarge,
	readRequestBodyLimited,
} from "#/server/requestLimits";
import { MAX_TTS_RUNTIME_INSTALL_BODY_BYTES } from "#/server/ttsRuntimeInstall";

const installGate = createConcurrencyGate(1);

export async function handleTtsRuntimeInstall(
	request: Request,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	const release = installGate.tryEnter();
	if (!release) {
		return Response.json(
			{ error: "A DirectML runtime install is already in progress." },
			{ status: 429, headers: { "retry-after": "1" } },
		);
	}
	try {
		if (contentLengthExceeds(request, MAX_TTS_RUNTIME_INSTALL_BODY_BYTES)) {
			return payloadTooLarge(MAX_TTS_RUNTIME_INSTALL_BODY_BYTES);
		}
		const contentType = request.headers.get("content-type");
		if (!contentType?.startsWith("multipart/form-data")) {
			return Response.json(
				{
					error:
						"A multipart DirectML runtime archive and manifest are required.",
				},
				{ status: 400 },
			);
		}
		const limited = await readRequestBodyLimited(
			request,
			MAX_TTS_RUNTIME_INSTALL_BODY_BYTES,
		);
		if (!limited.ok) return limited.response;
		return dbFetch("/tts/runtime/install", {
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

export const Route = createFileRoute("/api/tts/runtime/install")({
	server: {
		handlers: { POST: ({ request }) => handleTtsRuntimeInstall(request) },
	},
});
