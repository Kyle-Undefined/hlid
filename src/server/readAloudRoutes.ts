import {
	chunkNeuralReadAloudText,
	isValidNeuralReadingId,
	readableTextFromMarkdown,
} from "#/lib/readAloud";
import {
	applySpeechPronunciations,
	type SpeechPronunciation,
} from "#/lib/speechPronunciations";
import type { MicrosoftSpeechManager } from "./microsoftSpeech";
import { createConcurrencyGate } from "./requestLimits";
import { type TtsModelManager, TtsModelMismatchError } from "./tts";

export const MAX_READ_ALOUD_TEXT_CHARS = 50_000;
export const MAX_NEURAL_READING_SNAPSHOTS = 32;
export const NEURAL_READING_SNAPSHOT_TTL_MS = 60 * 60 * 1_000;
export const NEURAL_READ_ALOUD_PREVIEW_TEXT =
	"Hlid is ready to read replies aloud.";

type NeuralReadAloudSettings = { voiceId: string; rate: number };

type NeuralReadAloudSnapshot = {
	messageId: number;
	chunks: string[];
	settings: NeuralReadAloudSettings;
	modelId?: string;
	expiresAt: number;
};

type ReadAloudRouteOptions = {
	speech: Pick<MicrosoftSpeechManager, "voices" | "synthesize">;
	tts?: Pick<TtsModelManager, "status" | "synthesize">;
	getAssistantMessageText: (id: number) => Promise<string | null>;
	getNeuralSettings?: () => { voiceId: string; rate: number };
	getPronunciations?: () => readonly SpeechPronunciation[];
};

type ReadAloudRouteDependencies = {
	speech: Pick<MicrosoftSpeechManager, "voices" | "synthesize">;
	neuralTts: Pick<TtsModelManager, "status" | "synthesize">;
	getAssistantMessageText: (id: number) => Promise<string | null>;
	neuralSettings: () => { voiceId: string; rate: number };
	pronunciations: () => readonly SpeechPronunciation[];
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
	pronunciations: ReadAloudRouteDependencies["pronunciations"],
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
	const readableText = readableTextFromMarkdown(markdown);
	const text =
		url.searchParams.get("provider") === "neural"
			? applySpeechPronunciations(readableText, pronunciations())
			: readableText;
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

function neuralSnapshotUnavailableResponse(): Response {
	return Response.json(
		{ error: "neural reading snapshot is unavailable" },
		{
			status: 410,
			headers: { "cache-control": "private, no-store" },
		},
	);
}

function neuralRuntimeUnavailableResponse(): Response {
	return Response.json(
		{ error: "local neural voice is not ready" },
		{
			status: 503,
			headers: { "cache-control": "private, no-store" },
		},
	);
}

function loadedTtsModel(
	tts: ReadAloudRouteDependencies["neuralTts"],
): string | null {
	const status = tts.status();
	return status.state === "ready" ? (status.loadedModel ?? null) : null;
}

function pruneNeuralReadAloudSnapshots(
	snapshots: Map<string, NeuralReadAloudSnapshot>,
	now: number,
): void {
	for (const [readingId, snapshot] of snapshots) {
		if (snapshot.expiresAt <= now) snapshots.delete(readingId);
	}
}

function storeNeuralReadAloudSnapshot(
	snapshots: Map<string, NeuralReadAloudSnapshot>,
	readingId: string,
	snapshot: NeuralReadAloudSnapshot,
): void {
	if (snapshots.has(readingId)) snapshots.delete(readingId);
	while (snapshots.size >= MAX_NEURAL_READING_SNAPSHOTS) {
		const oldestReadingId = snapshots.keys().next().value;
		if (oldestReadingId === undefined) break;
		snapshots.delete(oldestReadingId);
	}
	snapshots.set(readingId, snapshot);
}

async function synthesizeNeuralChunk(
	chunk: string,
	chunkIndex: number,
	chunkCount: number,
	settings: NeuralReadAloudSettings,
	dependencies: ReadAloudRouteDependencies,
	expectedModel?: string,
): Promise<Response> {
	try {
		const text = /[.!?]$/u.test(chunk) ? chunk : `${chunk}.`;
		const result = expectedModel
			? await dependencies.neuralTts.synthesize(
					text,
					settings.voiceId,
					settings.rate,
					expectedModel,
				)
			: await dependencies.neuralTts.synthesize(
					text,
					settings.voiceId,
					settings.rate,
				);
		return wavResponse(result.audio, {
			"x-hlid-chunk-count": String(chunkCount),
			"x-hlid-chunk-index": String(chunkIndex),
			"x-hlid-has-next-chunk": chunkIndex + 1 < chunkCount ? "1" : "0",
			...(result.synthesisMs
				? { "x-hlid-synthesis-ms": String(result.synthesisMs) }
				: {}),
			...(result.durationMs
				? { "x-hlid-audio-duration-ms": String(result.durationMs) }
				: {}),
		});
	} catch (error) {
		if (error instanceof TtsModelMismatchError) {
			return neuralSnapshotUnavailableResponse();
		}
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

async function handleNeuralSynthesisRoute(
	url: URL,
	dependencies: ReadAloudRouteDependencies,
	snapshots: Map<string, NeuralReadAloudSnapshot>,
): Promise<Response> {
	const rawChunkIndex = url.searchParams.get("chunk_index") ?? "";
	const chunkIndex = Number(rawChunkIndex);
	if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
		return Response.json({ error: "invalid chunk_index" }, { status: 400 });
	}
	const readingId = url.searchParams.get("reading_id");
	if (readingId !== null && !isValidNeuralReadingId(readingId)) {
		return Response.json({ error: "invalid reading_id" }, { status: 400 });
	}
	const rawMessageId = url.searchParams.get("message_id") ?? "";
	const messageId = Number(rawMessageId);
	if (!Number.isSafeInteger(messageId) || messageId <= 0) {
		return Response.json({ error: "invalid message_id" }, { status: 400 });
	}

	const now = Date.now();
	pruneNeuralReadAloudSnapshots(snapshots, now);
	let snapshot = readingId === null ? undefined : snapshots.get(readingId);
	if (snapshot && snapshot.messageId !== messageId) {
		return neuralSnapshotUnavailableResponse();
	}
	if (snapshot && readingId !== null) {
		if (
			!snapshot.modelId ||
			loadedTtsModel(dependencies.neuralTts) !== snapshot.modelId
		) {
			return neuralSnapshotUnavailableResponse();
		}
		snapshot.expiresAt = now + NEURAL_READING_SNAPSHOT_TTL_MS;
		storeNeuralReadAloudSnapshot(snapshots, readingId, snapshot);
	}
	if (!snapshot && readingId !== null && chunkIndex > 0) {
		return neuralSnapshotUnavailableResponse();
	}

	if (!snapshot) {
		const message = await readAssistantMessage(
			url,
			dependencies.getAssistantMessageText,
			dependencies.pronunciations,
		);
		if (!message.ok) return message.response;
		const chunks = chunkNeuralReadAloudText(message.text);
		if (!chunks[chunkIndex]) {
			return Response.json(
				{ error: "read-aloud chunk not found" },
				{ status: 416 },
			);
		}
		const settings = dependencies.neuralSettings();
		const modelId =
			readingId === null ? undefined : loadedTtsModel(dependencies.neuralTts);
		if (readingId !== null && modelId === null) {
			return neuralRuntimeUnavailableResponse();
		}
		snapshot = {
			messageId,
			chunks,
			settings: { voiceId: settings.voiceId, rate: settings.rate },
			modelId: modelId ?? undefined,
			expiresAt: now + NEURAL_READING_SNAPSHOT_TTL_MS,
		};
		if (readingId !== null) {
			storeNeuralReadAloudSnapshot(snapshots, readingId, snapshot);
		}
	}

	const chunks = snapshot.chunks;
	const chunk = chunks[chunkIndex];
	if (!chunk) {
		return Response.json(
			{ error: "read-aloud chunk not found" },
			{ status: 416 },
		);
	}
	return synthesizeNeuralChunk(
		chunk,
		chunkIndex,
		chunks.length,
		snapshot.settings,
		dependencies,
		snapshot.modelId,
	);
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
	getPronunciations,
}: ReadAloudRouteOptions) {
	const neuralTts = tts ?? {
		synthesize: () =>
			Promise.reject(new Error("local neural speech unavailable")),
		status: () => ({ state: "unavailable" as const, model: "" }),
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
		pronunciations: getPronunciations ?? (() => []),
		synthesisGate: createConcurrencyGate(1),
	};
	const neuralReadAloudSnapshots = new Map<string, NeuralReadAloudSnapshot>();
	return async (url: URL, request: Request): Promise<Response | null> => {
		if (url.pathname === "/read-aloud/voices" && request.method === "GET") {
			return handleVoicesRoute(url, dependencies.speech);
		}
		if (url.pathname === "/read-aloud/preview" && request.method === "GET") {
			return handlePreviewRoute(dependencies);
		}
		if (url.pathname !== "/read-aloud/audio" || request.method !== "GET")
			return null;

		if (url.searchParams.get("provider") === "neural") {
			return handleNeuralSynthesisRoute(
				url,
				dependencies,
				neuralReadAloudSnapshots,
			);
		}
		const message = await readAssistantMessage(
			url,
			dependencies.getAssistantMessageText,
			dependencies.pronunciations,
		);
		if (!message.ok) return message.response;
		return handleMicrosoftSynthesisRoute(url, message.text, dependencies);
	};
}
