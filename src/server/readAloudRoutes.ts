import { readableTextFromMarkdown } from "#/lib/readAloud";
import type { MicrosoftSpeechManager } from "./microsoftSpeech";
import { createConcurrencyGate } from "./requestLimits";

export const MAX_READ_ALOUD_TEXT_CHARS = 50_000;

type ReadAloudRouteOptions = {
	speech: Pick<MicrosoftSpeechManager, "voices" | "synthesize">;
	getAssistantMessageText: (id: number) => Promise<string | null>;
};

export function createReadAloudRouteHandler({
	speech,
	getAssistantMessageText,
}: ReadAloudRouteOptions) {
	const synthesisGate = createConcurrencyGate(1);
	return async (url: URL, request: Request): Promise<Response | null> => {
		if (url.pathname === "/read-aloud/voices" && request.method === "GET") {
			try {
				return Response.json({
					available: true,
					voices: await speech.voices(url.searchParams.get("refresh") === "1"),
				});
			} catch (error) {
				return Response.json({
					available: false,
					voices: [],
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (url.pathname !== "/read-aloud/audio" || request.method !== "GET")
			return null;

		const rawMessageId = url.searchParams.get("message_id") ?? "";
		const messageId = Number(rawMessageId);
		if (!Number.isSafeInteger(messageId) || messageId <= 0)
			return Response.json({ error: "invalid message_id" }, { status: 400 });
		const markdown = await getAssistantMessageText(messageId);
		if (markdown === null)
			return Response.json(
				{ error: "assistant message not found" },
				{ status: 404 },
			);
		const text = readableTextFromMarkdown(markdown);
		if (!text)
			return Response.json(
				{ error: "message has no readable text" },
				{ status: 422 },
			);
		if (text.length > MAX_READ_ALOUD_TEXT_CHARS)
			return Response.json(
				{ error: "message is too long to synthesize" },
				{ status: 413 },
			);
		const release = synthesisGate.tryEnter();
		if (!release)
			return Response.json(
				{ error: "Microsoft speech synthesis is busy" },
				{ status: 429, headers: { "retry-after": "1" } },
			);
		try {
			const audio = await speech.synthesize(
				text,
				url.searchParams.get("voice_id") ?? "",
			);
			const body = new ArrayBuffer(audio.byteLength);
			new Uint8Array(body).set(audio);
			return new Response(body, {
				headers: {
					"cache-control": "private, no-store",
					"content-length": String(audio.byteLength),
					"content-type": "audio/wav",
				},
			});
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: 503 },
			);
		} finally {
			release();
		}
	};
}
