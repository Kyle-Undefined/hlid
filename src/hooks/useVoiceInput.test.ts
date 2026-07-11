// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/serverFns", () => ({ getVoiceInfoFn: vi.fn() }));

import { getVoiceInfoFn } from "#/lib/serverFns";
import { useVoiceInput } from "./useVoiceInput";

const readyInfo = {
	status: { state: "ready" as const, model: "tiny" },
	models: [],
};
const config = {
	enabled: true,
	model: "tiny",
	language: "auto",
	auto_send: false,
	hotkey: "Alt+Shift+KeyV",
	max_recording_seconds: 300,
};

class FakeMediaRecorder {
	static instances: FakeMediaRecorder[] = [];
	state = "inactive";
	mimeType = "audio/webm";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;

	constructor() {
		FakeMediaRecorder.instances.push(this);
	}

	start(): void {
		this.state = "recording";
	}

	stop(): void {
		this.state = "inactive";
		this.onstop?.();
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	FakeMediaRecorder.instances = [];
	vi.mocked(getVoiceInfoFn).mockResolvedValue(readyInfo);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useVoiceInput", () => {
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((done) => {
			resolve = done;
		});
		return { promise, resolve };
	}

	it("surfaces insecure/unavailable microphone access and can recover", async () => {
		Object.defineProperty(navigator, "mediaDevices", {
			value: undefined,
			configurable: true,
		});
		const onTranscription = vi.fn();
		const { result } = renderHook(() =>
			useVoiceInput({ config, initialInfo: readyInfo, onTranscription }),
		);
		await act(() => result.current.start());
		expect(result.current.phase).toBe("error");
		expect(result.current.error).toContain("HTTPS or localhost");
		act(() => result.current.clearError());
		expect(result.current.phase).toBe("idle");
		expect(result.current.error).toBeNull();
	});

	it("starts and cancels recording while releasing microphone tracks", async () => {
		const stopTrack = vi.fn();
		const stream = {
			getTracks: () => [{ stop: stopTrack }],
		} as unknown as MediaStream;
		Object.defineProperty(navigator, "mediaDevices", {
			value: { getUserMedia: vi.fn(async () => stream) },
			configurable: true,
		});
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		const { result } = renderHook(() =>
			useVoiceInput({
				config,
				initialInfo: readyInfo,
				onTranscription: vi.fn(),
			}),
		);
		await act(() => result.current.start());
		expect(result.current.phase).toBe("recording");
		act(() => result.current.cancel());
		await waitFor(() => expect(result.current.phase).toBe("idle"));
		expect(stopTrack).toHaveBeenCalled();
		expect(result.current.seconds).toBe(0);
	});

	it("deduplicates pending starts and disposes a late stream after cancellation", async () => {
		const pending = deferred<MediaStream>();
		const getUserMedia = vi.fn(() => pending.promise);
		const stopTrack = vi.fn();
		const stream = {
			getTracks: () => [{ stop: stopTrack }],
		} as unknown as MediaStream;
		Object.defineProperty(navigator, "mediaDevices", {
			value: { getUserMedia },
			configurable: true,
		});
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		const { result } = renderHook(() =>
			useVoiceInput({
				config,
				initialInfo: readyInfo,
				onTranscription: vi.fn(),
			}),
		);

		let firstStart!: Promise<void>;
		await act(async () => {
			firstStart = result.current.start();
			await result.current.start();
		});
		expect(getUserMedia).toHaveBeenCalledOnce();
		act(() => result.current.cancel());
		pending.resolve(stream);
		await act(() => firstStart);

		expect(stopTrack).toHaveBeenCalledOnce();
		expect(FakeMediaRecorder.instances).toHaveLength(0);
		expect(result.current.phase).toBe("idle");
	});

	it("disposes a stream that resolves after unmount", async () => {
		const pending = deferred<MediaStream>();
		const stopTrack = vi.fn();
		Object.defineProperty(navigator, "mediaDevices", {
			value: { getUserMedia: vi.fn(() => pending.promise) },
			configurable: true,
		});
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		const { result, unmount } = renderHook(() =>
			useVoiceInput({
				config,
				initialInfo: readyInfo,
				onTranscription: vi.fn(),
			}),
		);

		const starting = result.current.start();
		unmount();
		pending.resolve({
			getTracks: () => [{ stop: stopTrack }],
		} as unknown as MediaStream);
		await starting;

		expect(stopTrack).toHaveBeenCalledOnce();
		expect(FakeMediaRecorder.instances).toHaveLength(0);
	});

	it("converts a completed recording to WAV and delivers the transcription", async () => {
		const stopTrack = vi.fn();
		const stream = {
			getTracks: () => [{ stop: stopTrack }],
		} as unknown as MediaStream;
		Object.defineProperty(navigator, "mediaDevices", {
			value: { getUserMedia: vi.fn(async () => stream) },
			configurable: true,
		});
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		vi.stubGlobal(
			"AudioContext",
			class {
				decodeAudioData = vi.fn(async () => ({ duration: 3 / 16_000 }));
				close = vi.fn();
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
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ text: "transcribed words" }));
		const onTranscription = vi.fn();
		const { result } = renderHook(() =>
			useVoiceInput({ config, initialInfo: readyInfo, onTranscription }),
		);

		await act(() => result.current.start());
		const recorder = FakeMediaRecorder.instances[0];
		recorder?.ondataavailable?.({ data: new Blob(["recorded audio"]) });
		act(() => recorder?.stop());
		await waitFor(() =>
			expect(onTranscription).toHaveBeenCalledWith("transcribed words"),
		);

		expect(result.current.phase).toBe("idle");
		expect(stopTrack).toHaveBeenCalled();
		const request = fetchMock.mock.calls[0]?.[1];
		const wav = (request?.body as FormData).get("audio") as File;
		expect(wav.type).toBe("audio/wav");
		const header = new DataView(await wav.arrayBuffer());
		expect(header.getUint32(0, false)).toBe(0x52494646);
		expect(header.getUint32(8, false)).toBe(0x57415645);
	});

	it("refreshes the model status through the real hook boundary", async () => {
		vi.mocked(getVoiceInfoFn).mockResolvedValue({
			status: { state: "unavailable", model: "", error: "missing runtime" },
			models: [],
		});
		const { result } = renderHook(() =>
			useVoiceInput({
				config,
				initialInfo: readyInfo,
				onTranscription: vi.fn(),
			}),
		);
		act(() => result.current.refresh());
		await waitFor(() =>
			expect(result.current.status.state).toBe("unavailable"),
		);
	});
});
