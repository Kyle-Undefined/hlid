import {
	chunkNeuralReadAloudText,
	readableTextFromMarkdown,
} from "#/lib/readAloud";
import type { MicrosoftSpeechManager } from "./microsoftSpeech";
import { createConcurrencyGate } from "./requestLimits";
import type { TtsModelManager } from "./tts";

export const MAX_READ_ALOUD_TEXT_CHARS = 50_000;
export const NEURAL_READ_ALOUD_PREVIEW_TEXT =
	"Hlid is ready to read replies aloud.";

type ReadAloudRouteOptions = {
	speech: Pick<MicrosoftSpeechManager, "voices" | "synthesize">;
	tts?: Pick<TtsModelManager, "synthesize">;
	getAssistantMessageText: (id: number) => Promise<string | null>;
	getNeuralSettings?: () => { voiceId: string; rate: number };
};

type ReadAloudRouteDependencies = {
	speech: Pick<MicrosoftSpeechManager, "voices" | "synthesize">;
	neuralTts: Pick<TtsModelManager, "synthesize">;
	getAssistantMessageText: (id: number) => Promise<string | null>;
	neuralSettings: () => { voiceId: string; rate: number };
	synthesisGate: ReturnType<typeof createConcurrencyGate>;
};

function wavResponse(
	audio: Uint8Array,
	additionalHeaders: Record<string, string> = {},
): Response {
	const body = new ArrayBuffer(audio.byteLength);
	new Uint8Array(body).set(audio);
	return new Response(body, {
		headers: {
			"cache-control": "private, no-store",
			"content-length": String(audio.byteLength),
			"content-type": "audio/wav",
			...additionalHeaders,
		},
	});
}

async function handleVoicesRoute(
	url: URL,
	speech: ReadAloudRouteDependencies["speech"],
): Promise<Response> {
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

async function handlePreviewRoute({
	neuralTts,
	neuralSettings,
}: ReadAloudRouteDependencies): Promise<Response> {
	const settings = neuralSettings();
	try {
		const result = await neuralTts.synthesize(
			NEURAL_READ_ALOUD_PREVIEW_TEXT,
			settings.voiceId,
			settings.rate,
		);
		return wavResponse(result.audio);
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 503 },
		);
	}
}

async function readAssistantMessage(
	url: URL,
	getAssistantMessageText: ReadAloudRouteDependencies["getAssistantMessageText"],
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
	const rawMessageId = url.searchParams.get("message_id") ?? "";
	const messageId = Number(rawMessageId);
	if (!Number.isSafeInteger(messageId) || messageId <= 0) {
		return {
			ok: false,
			response: Response.json({ error: "invalid message_id" }, { status: 400 }),
		};
	}
	const markdown = await getAssistantMessageText(messageId);
	if (markdown === null) {
		return {
			ok: false,
			response: Response.json(
				{ error: "assistant message not found" },
				{ status: 404 },
			),
		};
	}
	const text = readableTextFromMarkdown(markdown);
	if (!text) {
		return {
			ok: false,
			response: Response.json(
				{ error: "message has no readable text" },
				{ status: 422 },
			),
		};
	}
	if (text.length > MAX_READ_ALOUD_TEXT_CHARS) {
		return {
			ok: false,
			response: Response.json(
				{ error: "message is too long to synthesize" },
				{ status: 413 },
			),
		};
	}
	return { ok: true, text };
}

async function handleNeuralSynthesisRoute(
	url: URL,
	text: string,
	dependencies: ReadAloudRouteDependencies,
): Promise<Response> {
	const rawChunkIndex = url.searchParams.get("chunk_index") ?? "";
	const chunkIndex = Number(rawChunkIndex);
	if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
		return Response.json({ error: "invalid chunk_index" }, { status: 400 });
	}
	const chunks = chunkNeuralReadAloudText(text);
	const chunk = chunks[chunkIndex];
	if (!chunk) {
		return Response.json(
			{ error: "read-aloud chunk not found" },
			{ status: 416 },
		);
	}
	const settings = dependencies.neuralSettings();
	try {
		const result = await dependencies.neuralTts.synthesize(
			/[.!?]$/u.test(chunk) ? chunk : `${chunk}.`,
			settings.voiceId,
			settings.rate,
		);
		return wavResponse(result.audio, {
			"x-hlid-chunk-count": String(chunks.length),
			"x-hlid-chunk-index": String(chunkIndex),
			"x-hlid-has-next-chunk": chunkIndex + 1 < chunks.length ? "1" : "0",
			...(result.synthesisMs
				? { "x-hlid-synthesis-ms": String(result.synthesisMs) }
				: {}),
			...(result.durationMs
				? { "x-hlid-audio-duration-ms": String(result.durationMs) }
				: {}),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const busy = message.includes("queue is full");
		return Response.json(
			{ error: message },
			{
				status: busy ? 429 : 503,
				headers: busy ? { "retry-after": "1" } : undefined,
			},
		);
	}
}

async function handleMicrosoftSynthesisRoute(
	url: URL,
	text: string,
	{ speech, synthesisGate }: ReadAloudRouteDependencies,
): Promise<Response> {
	const release = synthesisGate.tryEnter();
	if (!release) {
		return Response.json(
			{ error: "Microsoft speech synthesis is busy" },
			{ status: 429, headers: { "retry-after": "1" } },
		);
	}
	try {
		const audio = await speech.synthesize(
			text,
			url.searchParams.get("voice_id") ?? "",
		);
		return wavResponse(audio);
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 503 },
		);
	} finally {
		release();
	}
}

export function createReadAloudRouteHandler({
	speech,
	tts,
	getAssistantMessageText,
	getNeuralSettings,
}: ReadAloudRouteOptions) {
	const neuralTts = tts ?? {
		synthesize: () =>
			Promise.reject(new Error("local neural speech unavailable")),
	};
	const neuralSettings =
		getNeuralSettings ??
		(() => ({
			voiceId: "",
			rate: 1,
		}));
	const dependencies: ReadAloudRouteDependencies = {
		speech,
		neuralTts,
		getAssistantMessageText,
		neuralSettings,
		synthesisGate: createConcurrencyGate(1),
	};
	return async (url: URL, request: Request): Promise<Response | null> => {
		if (url.pathname === "/read-aloud/voices" && request.method === "GET") {
			return handleVoicesRoute(url, dependencies.speech);
		}
		if (url.pathname === "/read-aloud/preview" && request.method === "GET") {
			return handlePreviewRoute(dependencies);
		}
		if (url.pathname !== "/read-aloud/audio" || request.method !== "GET")
			return null;

		const message = await readAssistantMessage(
			url,
			dependencies.getAssistantMessageText,
		);
		if (!message.ok) return message.response;
		if (url.searchParams.get("provider") === "neural") {
			return handleNeuralSynthesisRoute(url, message.text, dependencies);
		}
		return handleMicrosoftSynthesisRoute(url, message.text, dependencies);
	};
}
