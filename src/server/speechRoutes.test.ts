import { describe, expect, it, vi } from "vitest";
import {
	createSpeechRouteHandler,
	MAX_SPEECH_SYNTHESIS_BODY_BYTES,
} from "./speechRoutes";
import { MAX_TTS_RUNTIME_TEXT_CHARS } from "./tts-runtime";

function request(
	body: BodyInit = JSON.stringify({ text: "Hello from Hlid." }),
	headers: HeadersInit = { "content-type": "application/json" },
): Request {
	return new Request("http://localhost/speech/synthesize", {
		method: "POST",
		headers,
		body,
	});
}

function handler(synthesize = vi.fn()) {
	return {
		synthesize,
		handle: createSpeechRouteHandler({
			tts: { synthesize },
			getNeuralSettings: () => ({
				voiceId: "expr-voice-2-f",
				rate: 1.1,
				voiceIds: ["expr-voice-2-f", "expr-voice-5-f"],
			}),
		}),
	};
}

describe("local speech synthesis route", () => {
	it("synthesizes one bounded utterance with server defaults", async () => {
		const synthesize = vi.fn().mockResolvedValue({
			audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
			synthesisMs: 425,
			durationMs: 1_250,
		});
		const { handle } = handler(synthesize);

		const response = await handle(
			new URL("http://localhost/speech/synthesize"),
			request(JSON.stringify({ text: "  Hello from Hlid.  " }), {
				"content-type": "application/json; charset=utf-8",
			}),
		);

		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toBe("audio/wav");
		expect(response?.headers.get("cache-control")).toBe("private, no-store");
		expect(response?.headers.get("content-length")).toBe("17");
		expect(response?.headers.get("x-hlid-synthesis-ms")).toBe("425");
		expect(response?.headers.get("x-hlid-audio-duration-ms")).toBe("1250");
		expect(await response?.text()).toBe("RIFF0000WAVEaudio");
		expect(synthesize).toHaveBeenCalledWith(
			"Hello from Hlid.",
			"expr-voice-2-f",
			1.1,
		);
	});

	it("accepts an explicit local voice and rate", async () => {
		const synthesize = vi
			.fn()
			.mockResolvedValue({ audio: new Uint8Array([1]) });
		const { handle } = handler(synthesize);

		const response = await handle(
			new URL("http://localhost/speech/synthesize"),
			request(
				JSON.stringify({
					text: "Read this.",
					voice_id: "expr-voice-5-f",
					rate: 1.25,
				}),
			),
		);

		expect(response?.status).toBe(200);
		expect(synthesize).toHaveBeenCalledWith(
			"Read this.",
			"expr-voice-5-f",
			1.25,
		);
	});

	it("requires a JSON content type and valid JSON", async () => {
		const { handle, synthesize } = handler();
		const url = new URL("http://localhost/speech/synthesize");

		const unsupported = await handle(
			url,
			request("text", { "content-type": "text/plain" }),
		);
		const malformed = await handle(url, request("{"));

		expect(unsupported?.status).toBe(415);
		expect(malformed?.status).toBe(400);
		expect(synthesize).not.toHaveBeenCalled();
	});

	it("rejects a declared or streamed oversized body", async () => {
		const { handle, synthesize } = handler();
		const url = new URL("http://localhost/speech/synthesize");
		const declared = await handle(
			url,
			request("{}", {
				"content-type": "application/json",
				"content-length": String(MAX_SPEECH_SYNTHESIS_BODY_BYTES + 1),
			}),
		);
		const streamed = await handle(
			url,
			request("x".repeat(MAX_SPEECH_SYNTHESIS_BODY_BYTES + 1)),
		);

		expect(declared?.status).toBe(413);
		expect(streamed?.status).toBe(413);
		expect(synthesize).not.toHaveBeenCalled();
	});

	it.each([
		["missing text", {}, "text must contain"],
		["empty text", { text: "  " }, "text must contain"],
		[
			"long text",
			{ text: "x".repeat(MAX_TTS_RUNTIME_TEXT_CHARS + 1) },
			"text must contain",
		],
		["invalid voice", { text: "Hello", voice_id: null }, "voice_id must be"],
		[
			"unknown voice",
			{ text: "Hello", voice_id: "not-a-real-voice" },
			"voice_id is not available",
		],
		["low rate", { text: "Hello", rate: 0.49 }, "rate must be"],
		["high rate", { text: "Hello", rate: 2.01 }, "rate must be"],
		["invalid rate", { text: "Hello", rate: "1" }, "rate must be"],
	] as const)("rejects %s before synthesis", async (_name, body, error) => {
		const { handle, synthesize } = handler();
		const response = await handle(
			new URL("http://localhost/speech/synthesize"),
			request(JSON.stringify(body)),
		);

		expect(response?.status).toBe(400);
		expect(await response?.json()).toEqual({
			error: expect.stringContaining(error),
		});
		expect(synthesize).not.toHaveBeenCalled();
	});

	it("maps queue pressure to 429 and other runtime failures to 503", async () => {
		const synthesize = vi
			.fn()
			.mockRejectedValueOnce(new Error("local neural synthesis queue is full"))
			.mockRejectedValueOnce(new Error("local neural voice is not ready"));
		const { handle } = handler(synthesize);
		const url = new URL("http://localhost/speech/synthesize");

		const busy = await handle(url, request());
		const unavailable = await handle(url, request());

		expect(busy?.status).toBe(429);
		expect(busy?.headers.get("retry-after")).toBe("1");
		expect(busy?.headers.get("cache-control")).toBe("no-store");
		expect(await busy?.json()).toEqual({
			error: "local neural speech capacity reached",
		});
		expect(unavailable?.status).toBe(503);
		expect(unavailable?.headers.get("retry-after")).toBeNull();
		expect(await unavailable?.json()).toEqual({
			error: "local neural speech is unavailable",
		});
	});

	it("reports runtime detail internally while keeping the response stable", async () => {
		const onSynthesisError = vi.fn();
		const synthesize = vi
			.fn()
			.mockRejectedValue(new Error("native addon failed at C:\\private\\tts"));
		const handle = createSpeechRouteHandler({
			tts: { synthesize },
			getNeuralSettings: () => ({
				voiceId: "expr-voice-2-f",
				rate: 1,
				voiceIds: ["expr-voice-2-f"],
			}),
			onSynthesisError,
		});

		const response = await handle(
			new URL("http://localhost/speech/synthesize"),
			request(),
		);

		expect(onSynthesisError).toHaveBeenCalledWith(expect.any(Error));
		expect(await response?.json()).toEqual({
			error: "local neural speech is unavailable",
		});
	});

	it("ignores unrelated paths and methods", async () => {
		const { handle, synthesize } = handler();
		expect(
			await handle(
				new URL("http://localhost/tts"),
				new Request("http://localhost/tts"),
			),
		).toBeNull();
		expect(
			await handle(
				new URL("http://localhost/speech/synthesize"),
				new Request("http://localhost/speech/synthesize"),
			),
		).toBeNull();
		expect(synthesize).not.toHaveBeenCalled();
	});
});
