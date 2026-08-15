import { afterEach, describe, expect, it, vi } from "vitest";
import {
	calculateAudioRms,
	LocalConversationVadDetector,
	localConversationAudioToWav,
	transcribeLocalConversationAudio,
} from "./localConversationAudio";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("LocalConversationVadDetector", () => {
	it("opens after sustained speech and closes after sustained silence", () => {
		const detector = new LocalConversationVadDetector({
			threshold: 0.1,
			speechStartMs: 100,
			silenceMs: 300,
		});

		expect(detector.observe(0.2, 0)).toBeNull();
		expect(detector.observe(0.2, 99)).toBeNull();
		expect(detector.observe(0.2, 100)).toBe("start");
		expect(detector.observe(0.01, 200)).toBeNull();
		expect(detector.observe(0.01, 499)).toBeNull();
		expect(detector.observe(0.01, 500)).toBe("stop");
	});

	it("resets a speech candidate when the level drops before activation", () => {
		const detector = new LocalConversationVadDetector({
			threshold: 0.1,
			speechStartMs: 100,
			silenceMs: 300,
		});

		expect(detector.observe(0.2, 0)).toBeNull();
		expect(detector.observe(0.01, 50)).toBeNull();
		expect(detector.observe(0.2, 100)).toBeNull();
		expect(detector.observe(0.2, 199)).toBeNull();
		expect(detector.observe(0.2, 200)).toBe("start");
	});
});

describe("local conversation audio helpers", () => {
	it("calculates root-mean-square energy", () => {
		expect(calculateAudioRms(new Float32Array([1, -1, 1, -1]))).toBe(1);
		expect(calculateAudioRms(new Float32Array())).toBe(0);
	});

	it("normalizes decoded audio to a mono 16 kHz PCM WAV", async () => {
		const close = vi.fn(async () => {});
		vi.stubGlobal(
			"AudioContext",
			class {
				decodeAudioData = vi.fn(async () => ({ duration: 3 / 16_000 }));
				close = close;
			},
		);
		vi.stubGlobal(
			"OfflineAudioContext",
			class {
				destination = {};
				createBufferSource = vi.fn(() => ({
					buffer: null,
					connect: vi.fn(),
					start: vi.fn(),
				}));
				startRendering = vi.fn(async () => ({
					getChannelData: () => new Float32Array([-1, 0, 1]),
				}));
			},
		);

		const wav = await localConversationAudioToWav(new Blob(["recording"]));
		const view = new DataView(await wav.arrayBuffer());
		expect(wav.type).toBe("audio/wav");
		expect(view.getUint32(0, false)).toBe(0x52494646);
		expect(view.getUint32(8, false)).toBe(0x57415645);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(24, true)).toBe(16_000);
		expect(close).toHaveBeenCalledOnce();
	});

	it("posts WAV input to the existing local transcription route", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ text: " Spoken text " }));
		const controller = new AbortController();
		const audio = new Blob(["wav"], { type: "audio/wav" });

		await expect(
			transcribeLocalConversationAudio(audio, "en", controller.signal),
		).resolves.toBe(" Spoken text ");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/voice/transcribe");
		const request = fetchMock.mock.calls[0]?.[1];
		expect(request?.method).toBe("POST");
		expect(request?.signal).toBe(controller.signal);
		expect((request?.body as FormData).get("language")).toBe("en");
		expect(((request?.body as FormData).get("audio") as File).type).toBe(
			"audio/wav",
		);
	});
});
