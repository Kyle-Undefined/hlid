import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechPronunciation } from "#/lib/speechPronunciations";
import {
	createReadAloudRouteHandler,
	MAX_NEURAL_READING_SNAPSHOTS,
	MAX_READ_ALOUD_TEXT_CHARS,
	NEURAL_READING_SNAPSHOT_TTL_MS,
} from "./readAloudRoutes";
import {
	type TtsModelManager,
	TtsModelMismatchError,
	type TtsStatus,
} from "./tts";

const DEFAULT_TTS_MODEL_ID = "kitten-nano-v0.8-int8";

function readyTtsStatus(modelId = DEFAULT_TTS_MODEL_ID): TtsStatus {
	return { state: "ready", model: modelId, loadedModel: modelId };
}

function neuralTts(
	synthesize: TtsModelManager["synthesize"],
	status: () => TtsStatus = () => readyTtsStatus(),
): Pick<TtsModelManager, "status" | "synthesize"> {
	return { synthesize, status };
}

const voice = {
	id: "windows:mark",
	name: "Microsoft Mark",
	language: "en-US",
	gender: "Male",
	default: true,
};

function request(path: string): Request {
	return new Request(`http://localhost${path}`);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("read aloud internal routes", () => {
	it("reports Microsoft voice availability", async () => {
		const voices = vi.fn().mockResolvedValue([voice]);
		const handler = createReadAloudRouteHandler({
			speech: {
				voices,
				synthesize: vi.fn(),
			},
			getAssistantMessageText: vi.fn(),
		});
		const response = await handler(
			new URL("http://localhost/read-aloud/voices"),
			request("/read-aloud/voices"),
		);
		expect(await response?.json()).toEqual({
			available: true,
			voices: [voice],
		});
		expect(voices).toHaveBeenCalledWith(false);
	});

	it("refreshes the Microsoft voice inventory on request", async () => {
		const voices = vi.fn().mockResolvedValue([voice]);
		const handler = createReadAloudRouteHandler({
			speech: { voices, synthesize: vi.fn() },
			getAssistantMessageText: vi.fn(),
		});
		await handler(
			new URL("http://localhost/read-aloud/voices?refresh=1"),
			request("/read-aloud/voices?refresh=1"),
		);
		expect(voices).toHaveBeenCalledWith(true);
	});

	it("returns unavailable inventory without exposing an endpoint failure", async () => {
		const handler = createReadAloudRouteHandler({
			speech: {
				voices: vi.fn().mockRejectedValue(new Error("PowerShell missing")),
				synthesize: vi.fn(),
			},
			getAssistantMessageText: vi.fn(),
		});
		const response = await handler(
			new URL("http://localhost/read-aloud/voices"),
			request("/read-aloud/voices"),
		);
		expect(await response?.json()).toEqual({
			available: false,
			voices: [],
			error: "PowerShell missing",
		});
	});

	it("loads persisted assistant text, strips Markdown, and returns WAV", async () => {
		const synthesize = vi
			.fn()
			.mockResolvedValue(new TextEncoder().encode("RIFF0000WAVEaudio"));
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize },
			getAssistantMessageText: vi
				.fn()
				.mockResolvedValue("Read **this**.\n\n```ts\ndoNotRead()\n```"),
		});
		const url = new URL(
			"http://localhost/read-aloud/audio?message_id=42&voice_id=windows%3Amark",
		);
		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toBe("audio/wav");
		expect(response?.headers.get("cache-control")).toBe("private, no-store");
		expect(response?.headers.get("content-length")).toBe("17");
		expect(synthesize).toHaveBeenCalledWith("Read this.", "windows:mark");
	});

	it("applies pronunciation mappings only to local neural speech", async () => {
		const microsoftSynthesize = vi
			.fn()
			.mockResolvedValue(new TextEncoder().encode("RIFF0000WAVEaudio"));
		const neuralSynthesize = vi.fn().mockResolvedValue({
			audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
		});
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: microsoftSynthesize },
			tts: neuralTts(neuralSynthesize),
			getAssistantMessageText: vi.fn().mockResolvedValue("Hlið works."),
			getNeuralSettings: () => ({
				voiceId: "expr-voice-5-f",
				rate: 1,
			}),
			getPronunciations: () => [{ written: "Hlið", spoken: "hleeth" }],
		});
		const neuralUrl = new URL(
			"http://localhost/read-aloud/audio?message_id=42&provider=neural&chunk_index=0",
		);
		const microsoftUrl = new URL(
			"http://localhost/read-aloud/audio?message_id=42&voice_id=windows%3Amark",
		);

		await handler(
			neuralUrl,
			request(`${neuralUrl.pathname}${neuralUrl.search}`),
		);
		await handler(
			microsoftUrl,
			request(`${microsoftUrl.pathname}${microsoftUrl.search}`),
		);

		expect(neuralSynthesize).toHaveBeenCalledWith(
			"hleeth works.",
			"expr-voice-5-f",
			1,
		);
		expect(microsoftSynthesize).toHaveBeenCalledWith(
			"Hlið works.",
			"windows:mark",
		);
	});

	it("requires a persisted assistant message", async () => {
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			getAssistantMessageText: vi.fn().mockResolvedValue(null),
		});
		const url = new URL("http://localhost/read-aloud/audio?message_id=42");
		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);
		expect(response?.status).toBe(404);
	});

	it.each([
		["missing", null, 404, "assistant message not found"],
		["empty", "", 422, "message has no readable text"],
		[
			"oversized",
			"x".repeat(MAX_READ_ALOUD_TEXT_CHARS + 1),
			413,
			"message is too long to synthesize",
		],
	] as const)("validates %s message text before selecting the neural provider", async (_name, markdown, status, error) => {
		const synthesize = vi.fn();
		const getNeuralSettings = vi.fn(() => ({
			voiceId: "expr-voice-5-f",
			rate: 1,
		}));
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize),
			getAssistantMessageText: vi.fn().mockResolvedValue(markdown),
			getNeuralSettings,
		});
		const url = new URL(
			"http://localhost/read-aloud/audio?message_id=42&provider=neural&chunk_index=0",
		);

		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);

		expect(response?.status).toBe(status);
		expect(await response?.json()).toEqual({ error });
		expect(getNeuralSettings).not.toHaveBeenCalled();
		expect(synthesize).not.toHaveBeenCalled();
	});

	it("admits only one synthesis at a time", async () => {
		let resolveAudio: ((value: Uint8Array) => void) | undefined;
		const pending = new Promise<Uint8Array>((resolve) => {
			resolveAudio = resolve;
		});
		const synthesize = vi.fn().mockReturnValue(pending);
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize },
			getAssistantMessageText: vi.fn().mockResolvedValue("Read this"),
		});
		const url = new URL("http://localhost/read-aloud/audio?message_id=42");
		const first = handler(url, request(`${url.pathname}${url.search}`));
		await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());
		const second = await handler(url, request(`${url.pathname}${url.search}`));
		expect(second?.status).toBe(429);
		expect(second?.headers.get("retry-after")).toBe("1");
		resolveAudio?.(new TextEncoder().encode("RIFF0000WAVEaudio"));
		expect((await first)?.status).toBe(200);
	});

	it("releases the Microsoft synthesis gate after a provider failure", async () => {
		const synthesize = vi
			.fn()
			.mockRejectedValueOnce(new Error("Microsoft speech failed"))
			.mockResolvedValueOnce(new TextEncoder().encode("RIFF0000WAVEaudio"));
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize },
			getAssistantMessageText: vi.fn().mockResolvedValue("Read this"),
		});
		const url = new URL("http://localhost/read-aloud/audio?message_id=42");

		const failed = await handler(url, request(`${url.pathname}${url.search}`));
		const retried = await handler(url, request(`${url.pathname}${url.search}`));

		expect(failed?.status).toBe(503);
		expect(await failed?.json()).toEqual({ error: "Microsoft speech failed" });
		expect(retried?.status).toBe(200);
		expect(synthesize).toHaveBeenCalledTimes(2);
	});

	it("synthesizes a bounded neural chunk with server-owned settings", async () => {
		const synthesize = vi.fn().mockResolvedValue({
			audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
			synthesisMs: 640,
			durationMs: 1_800,
		});
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize),
			getAssistantMessageText: vi
				.fn()
				.mockResolvedValue(
					"Hlid reads a short first chunk and prepares the remainder.",
				),
			getNeuralSettings: () => ({
				voiceId: "expr-voice-5-f",
				rate: 1.25,
			}),
		});
		const url = new URL(
			"http://localhost/read-aloud/audio?message_id=42&provider=neural&chunk_index=0&voice_id=ignored",
		);
		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("x-hlid-has-next-chunk")).toBe("1");
		expect(response?.headers.get("x-hlid-synthesis-ms")).toBe("640");
		expect(synthesize).toHaveBeenCalledWith(
			expect.stringMatching(/^Hlid reads.*\.$/),
			"expr-voice-5-f",
			1.25,
		);
	});

	it("chunks neural speech after expanding pronunciation mappings", async () => {
		const synthesize = vi.fn().mockResolvedValue({
			audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
		});
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize),
			getAssistantMessageText: vi.fn().mockResolvedValue("Hlid ends here."),
			getNeuralSettings: () => ({
				voiceId: "expr-voice-5-f",
				rate: 1,
			}),
			getPronunciations: () => [
				{
					written: "Hlid",
					spoken: "Hlid with an intentionally extended spoken pronunciation",
				},
			],
		});
		const url = new URL(
			"http://localhost/read-aloud/audio?message_id=42&provider=neural&chunk_index=0",
		);

		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);

		expect(response?.status).toBe(200);
		expect(response?.headers.get("x-hlid-chunk-count")).toBe("2");
		expect(response?.headers.get("x-hlid-has-next-chunk")).toBe("1");
		expect(synthesize).toHaveBeenCalledWith(
			"Hlid with an.",
			"expr-voice-5-f",
			1,
		);
	});

	it("keeps transformed chunks and neural settings stable for one reading", async () => {
		let pronunciations: SpeechPronunciation[] = [
			{
				written: "Hlid",
				spoken: "Hlid with an intentionally extended spoken pronunciation",
			},
		];
		const settings = { voiceId: "expr-voice-5-f", rate: 1 };
		const getAssistantMessageText = vi
			.fn()
			.mockResolvedValue("Hlid ends here.");
		const getPronunciations = vi.fn(() => pronunciations);
		const getNeuralSettings = vi.fn(() => settings);
		const synthesize = vi.fn().mockResolvedValue({
			audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
		});
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize),
			getAssistantMessageText,
			getPronunciations,
			getNeuralSettings,
		});
		const readingId = "11111111-2222-4333-8444-555555555555";
		const firstPath = `/read-aloud/audio?message_id=42&provider=neural&chunk_index=0&reading_id=${readingId}`;

		const first = await handler(
			new URL(`http://localhost${firstPath}`),
			request(firstPath),
		);
		expect(first?.status).toBe(200);
		expect(first?.headers.get("x-hlid-has-next-chunk")).toBe("1");

		pronunciations = [{ written: "Hlid", spoken: "short" }];
		settings.voiceId = "expr-voice-2-f";
		settings.rate = 1.5;
		const secondPath = `/read-aloud/audio?message_id=42&provider=neural&chunk_index=1&reading_id=${readingId}`;
		const second = await handler(
			new URL(`http://localhost${secondPath}`),
			request(secondPath),
		);

		expect(second?.status).toBe(200);
		expect(getAssistantMessageText).toHaveBeenCalledOnce();
		expect(getPronunciations).toHaveBeenCalledOnce();
		expect(getNeuralSettings).toHaveBeenCalledOnce();
		expect(synthesize).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("intentionally extended spoken pronunciation"),
			"expr-voice-5-f",
			1,
			DEFAULT_TTS_MODEL_ID,
		);
	});

	it("ends a reading before a later chunk can use a switched TTS model", async () => {
		let loadedModel = DEFAULT_TTS_MODEL_ID;
		const synthesize = vi.fn().mockResolvedValue({
			audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
		});
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize, () => readyTtsStatus(loadedModel)),
			getAssistantMessageText: vi
				.fn()
				.mockResolvedValue(
					"A deliberately long opening that creates another chunk.",
				),
			getNeuralSettings: () => ({
				voiceId: "expr-voice-5-f",
				rate: 1,
			}),
		});
		const readingId = "77777777-7777-4777-8777-777777777777";
		const firstPath = `/read-aloud/audio?message_id=42&provider=neural&chunk_index=0&reading_id=${readingId}`;
		expect(
			(
				await handler(
					new URL(`http://localhost${firstPath}`),
					request(firstPath),
				)
			)?.status,
		).toBe(200);

		loadedModel = "piper-kristin-medium-int8";
		const laterPath = `/read-aloud/audio?message_id=42&provider=neural&chunk_index=1&reading_id=${readingId}`;
		const later = await handler(
			new URL(`http://localhost${laterPath}`),
			request(laterPath),
		);

		expect(later?.status).toBe(410);
		expect(later?.headers.get("cache-control")).toBe("private, no-store");
		expect(await later?.json()).toEqual({
			error: "neural reading snapshot is unavailable",
		});
		expect(synthesize).toHaveBeenCalledOnce();
	});

	it("maps a queued TTS runtime switch to the snapshot's gone response", async () => {
		const synthesize = vi
			.fn()
			.mockResolvedValueOnce({
				audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
			})
			.mockRejectedValueOnce(new TtsModelMismatchError());
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize),
			getAssistantMessageText: vi
				.fn()
				.mockResolvedValue(
					"A deliberately long opening that creates another chunk.",
				),
		});
		const readingId = "88888888-8888-4888-8888-888888888888";
		const firstPath = `/read-aloud/audio?message_id=42&provider=neural&chunk_index=0&reading_id=${readingId}`;
		expect(
			(
				await handler(
					new URL(`http://localhost${firstPath}`),
					request(firstPath),
				)
			)?.status,
		).toBe(200);

		const laterPath = `/read-aloud/audio?message_id=42&provider=neural&chunk_index=1&reading_id=${readingId}`;
		const later = await handler(
			new URL(`http://localhost${laterPath}`),
			request(laterPath),
		);

		expect(later?.status).toBe(410);
		expect(later?.headers.get("cache-control")).toBe("private, no-store");
		expect(await later?.json()).toEqual({
			error: "neural reading snapshot is unavailable",
		});
		expect(synthesize).toHaveBeenCalledTimes(2);
	});

	it("returns the same gone response for unknown and message-mismatched later chunks", async () => {
		const getAssistantMessageText = vi.fn().mockResolvedValue("Read this");
		const synthesize = vi.fn().mockResolvedValue({
			audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
		});
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize),
			getAssistantMessageText,
		});
		const readingId = "22222222-2222-4222-8222-222222222222";
		const unknownPath = `/read-aloud/audio?message_id=42&provider=neural&chunk_index=1&reading_id=${readingId}`;
		const unknown = await handler(
			new URL(`http://localhost${unknownPath}`),
			request(unknownPath),
		);
		expect(unknown?.status).toBe(410);
		expect(unknown?.headers.get("cache-control")).toBe("private, no-store");
		expect(await unknown?.json()).toEqual({
			error: "neural reading snapshot is unavailable",
		});
		expect(getAssistantMessageText).not.toHaveBeenCalled();
		expect(synthesize).not.toHaveBeenCalled();

		const firstPath = `/read-aloud/audio?message_id=42&provider=neural&chunk_index=0&reading_id=${readingId}`;
		expect(
			(
				await handler(
					new URL(`http://localhost${firstPath}`),
					request(firstPath),
				)
			)?.status,
		).toBe(200);
		const mismatchPath = `/read-aloud/audio?message_id=43&provider=neural&chunk_index=1&reading_id=${readingId}`;
		const mismatch = await handler(
			new URL(`http://localhost${mismatchPath}`),
			request(mismatchPath),
		);
		expect(mismatch?.status).toBe(410);
		expect(await mismatch?.json()).toEqual({
			error: "neural reading snapshot is unavailable",
		});
		expect(getAssistantMessageText).toHaveBeenCalledOnce();
		expect(synthesize).toHaveBeenCalledOnce();
	});

	it("expires reading snapshots and does not recreate a later chunk", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const getAssistantMessageText = vi
			.fn()
			.mockResolvedValue(
				"A deliberately long opening that creates another chunk.",
			);
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(
				vi.fn().mockResolvedValue({
					audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
				}),
			),
			getAssistantMessageText,
		});
		const readingId = "33333333-3333-4333-8333-333333333333";
		const firstPath = `/read-aloud/audio?message_id=42&provider=neural&chunk_index=0&reading_id=${readingId}`;
		expect(
			(
				await handler(
					new URL(`http://localhost${firstPath}`),
					request(firstPath),
				)
			)?.status,
		).toBe(200);

		now.mockReturnValue(1_000 + NEURAL_READING_SNAPSHOT_TTL_MS + 1);
		const laterPath = `/read-aloud/audio?message_id=42&provider=neural&chunk_index=1&reading_id=${readingId}`;
		const later = await handler(
			new URL(`http://localhost${laterPath}`),
			request(laterPath),
		);
		expect(later?.status).toBe(410);
		expect(getAssistantMessageText).toHaveBeenCalledOnce();
	});

	it("evicts the oldest reading when the bounded snapshot store is full", async () => {
		const synthesize = vi.fn().mockResolvedValue({
			audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
		});
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize),
			getAssistantMessageText: vi
				.fn()
				.mockResolvedValue(
					"A deliberately long opening that creates another chunk.",
				),
		});
		for (let index = 0; index <= MAX_NEURAL_READING_SNAPSHOTS; index += 1) {
			const path = `/read-aloud/audio?message_id=${index + 1}&provider=neural&chunk_index=0&reading_id=reading-${index}`;
			expect(
				(await handler(new URL(`http://localhost${path}`), request(path)))
					?.status,
			).toBe(200);
		}

		const oldestPath =
			"/read-aloud/audio?message_id=1&provider=neural&chunk_index=1&reading_id=reading-0";
		const newestPath = `/read-aloud/audio?message_id=${MAX_NEURAL_READING_SNAPSHOTS + 1}&provider=neural&chunk_index=1&reading_id=reading-${MAX_NEURAL_READING_SNAPSHOTS}`;
		expect(
			(
				await handler(
					new URL(`http://localhost${oldestPath}`),
					request(oldestPath),
				)
			)?.status,
		).toBe(410);
		expect(
			(
				await handler(
					new URL(`http://localhost${newestPath}`),
					request(newestPath),
				)
			)?.status,
		).toBe(200);
	});

	it("checks the expanded neural text against the synthesis limit", async () => {
		const synthesize = vi.fn();
		const getNeuralSettings = vi.fn(() => ({
			voiceId: "expr-voice-5-f",
			rate: 1,
		}));
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize),
			getAssistantMessageText: vi
				.fn()
				.mockResolvedValue(Array.from({ length: 2_500 }, () => "x").join(" ")),
			getNeuralSettings,
			getPronunciations: () => [
				{ written: "x", spoken: "pronunciation-expands" },
			],
		});
		const url = new URL(
			"http://localhost/read-aloud/audio?message_id=42&provider=neural&chunk_index=0",
		);

		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);

		expect(response?.status).toBe(413);
		expect(await response?.json()).toEqual({
			error: "message is too long to synthesize",
		});
		expect(getNeuralSettings).not.toHaveBeenCalled();
		expect(synthesize).not.toHaveBeenCalled();
	});

	it.each([
		["non-numeric", "bad", 400, "invalid chunk_index"],
		["fractional", "1.5", 400, "invalid chunk_index"],
		["negative", "-1", 400, "invalid chunk_index"],
		["past the end", "99", 416, "read-aloud chunk not found"],
	] as const)("rejects a %s neural chunk before synthesis", async (_name, chunkIndex, status, error) => {
		const synthesize = vi.fn();
		const getNeuralSettings = vi.fn(() => ({
			voiceId: "expr-voice-5-f",
			rate: 1,
		}));
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize),
			getAssistantMessageText: vi.fn().mockResolvedValue("Read this"),
			getNeuralSettings,
		});
		const url = new URL(
			`http://localhost/read-aloud/audio?message_id=42&provider=neural&chunk_index=${chunkIndex}`,
		);

		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);

		expect(response?.status).toBe(status);
		expect(await response?.json()).toEqual({ error });
		expect(getNeuralSettings).not.toHaveBeenCalled();
		expect(synthesize).not.toHaveBeenCalled();
	});

	it("maps neural queue pressure to 429 and other failures to 503", async () => {
		const synthesize = vi
			.fn()
			.mockRejectedValueOnce(new Error("neural queue is full"))
			.mockRejectedValueOnce(new Error("neural runtime unavailable"));
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize),
			getAssistantMessageText: vi.fn().mockResolvedValue("Read this"),
		});
		const url = new URL(
			"http://localhost/read-aloud/audio?message_id=42&provider=neural&chunk_index=0",
		);

		const busy = await handler(url, request(`${url.pathname}${url.search}`));
		const unavailable = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);

		expect(busy?.status).toBe(429);
		expect(busy?.headers.get("retry-after")).toBe("1");
		expect(await busy?.json()).toEqual({ error: "neural queue is full" });
		expect(unavailable?.status).toBe(503);
		expect(unavailable?.headers.get("retry-after")).toBeNull();
		expect(await unavailable?.json()).toEqual({
			error: "neural runtime unavailable",
		});
	});

	it("uses fixed text for neural voice preview", async () => {
		const synthesize = vi.fn().mockResolvedValue({
			audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
		});
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(synthesize),
			getAssistantMessageText: vi.fn(),
			getNeuralSettings: () => ({
				voiceId: "expr-voice-2-f",
				rate: 1,
			}),
		});
		const response = await handler(
			new URL("http://localhost/read-aloud/preview"),
			request("/read-aloud/preview"),
		);
		expect(response?.status).toBe(200);
		expect(synthesize).toHaveBeenCalledWith(
			"Hlid is ready to read replies aloud.",
			"expr-voice-2-f",
			1,
		);
	});

	it("maps neural preview failures to service unavailable", async () => {
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: neuralTts(
				vi.fn().mockRejectedValue(new Error("preview model unavailable")),
			),
			getAssistantMessageText: vi.fn(),
		});
		const response = await handler(
			new URL("http://localhost/read-aloud/preview"),
			request("/read-aloud/preview"),
		);

		expect(response?.status).toBe(503);
		expect(await response?.json()).toEqual({
			error: "preview model unavailable",
		});
	});
});
