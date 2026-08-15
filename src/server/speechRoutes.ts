import { readRequestBodyLimited } from "./requestLimits";
import type { TtsModelManager, TtsSynthesisResult } from "./tts";
import { MAX_TTS_RUNTIME_TEXT_CHARS } from "./tts-runtime";

export const MAX_SPEECH_SYNTHESIS_BODY_BYTES = 2 * 1024;
const MAX_SPEECH_SYNTHESIS_VOICE_ID_CHARS = 120;

type SpeechRouteOptions = {
	tts: Pick<TtsModelManager, "synthesize">;
	onSynthesisError?: (error: unknown) => void;
	getNeuralSettings: () => {
		voiceId: string;
		rate: number;
		voiceIds: readonly string[];
	};
};

type SpeechSynthesisInput = {
	text: string;
	voiceId: string;
	rate: number;
};

function jsonError(
	error: string,
	status: number,
	headers?: HeadersInit,
): Response {
	return Response.json(
		{ error },
		{
			status,
			headers: {
				"cache-control": "no-store",
				...Object.fromEntries(new Headers(headers)),
			},
		},
	);
}

function wavResponse(result: TtsSynthesisResult): Response {
	const body = new ArrayBuffer(result.audio.byteLength);
	new Uint8Array(body).set(result.audio);
	return new Response(body, {
		headers: {
			"cache-control": "private, no-store",
			"content-length": String(result.audio.byteLength),
			"content-type": "audio/wav",
			...(result.synthesisMs !== undefined
				? { "x-hlid-synthesis-ms": String(result.synthesisMs) }
				: {}),
			...(result.durationMs !== undefined
				? { "x-hlid-audio-duration-ms": String(result.durationMs) }
				: {}),
		},
	});
}

function parseSynthesisInput(
	body: unknown,
	settings: { voiceId: string; rate: number; voiceIds: readonly string[] },
): SpeechSynthesisInput | Response {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return jsonError("invalid JSON body", 400);
	}
	const candidate = body as {
		text?: unknown;
		voice_id?: unknown;
		rate?: unknown;
	};
	const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
	if (!text || text.length > MAX_TTS_RUNTIME_TEXT_CHARS) {
		return jsonError(
			`text must contain 1 to ${MAX_TTS_RUNTIME_TEXT_CHARS} characters`,
			400,
		);
	}

	let voiceId = settings.voiceId;
	if (candidate.voice_id !== undefined) {
		voiceId =
			typeof candidate.voice_id === "string" ? candidate.voice_id.trim() : "";
		if (!voiceId || voiceId.length > MAX_SPEECH_SYNTHESIS_VOICE_ID_CHARS) {
			return jsonError("voice_id must be a valid local neural voice", 400);
		}
		if (!settings.voiceIds.includes(voiceId)) {
			return jsonError("voice_id is not available for the selected model", 400);
		}
	}

	const rate = candidate.rate === undefined ? settings.rate : candidate.rate;
	if (
		typeof rate !== "number" ||
		!Number.isFinite(rate) ||
		rate < 0.5 ||
		rate > 2
	) {
		return jsonError("rate must be between 0.5 and 2", 400);
	}
	return { text, voiceId, rate };
}

async function handleSynthesis(
	request: Request,
	options: SpeechRouteOptions,
): Promise<Response> {
	if (
		request.headers
			.get("content-type")
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase() !== "application/json"
	) {
		return jsonError("application/json body is required", 415);
	}
	const limited = await readRequestBodyLimited(
		request,
		MAX_SPEECH_SYNTHESIS_BODY_BYTES,
	);
	if (!limited.ok) return limited.response;

	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(limited.body));
	} catch {
		return jsonError("invalid JSON body", 400);
	}
	const input = parseSynthesisInput(body, options.getNeuralSettings());
	if (input instanceof Response) return input;

	try {
		return wavResponse(
			await options.tts.synthesize(input.text, input.voiceId, input.rate),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const busy = message.includes("queue is full");
		if (!busy) options.onSynthesisError?.(error);
		return jsonError(
			busy
				? "local neural speech capacity reached"
				: "local neural speech is unavailable",
			busy ? 429 : 503,
			busy ? { "retry-after": "1" } : undefined,
		);
	}
}

export function createSpeechRouteHandler(options: SpeechRouteOptions) {
	return (url: URL, request: Request): Promise<Response | null> => {
		if (url.pathname !== "/speech/synthesize" || request.method !== "POST") {
			return Promise.resolve(null);
		}
		return handleSynthesis(request, options);
	};
}
