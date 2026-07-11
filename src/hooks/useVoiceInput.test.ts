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
	state = "inactive";
	mimeType = "audio/webm";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;

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
	vi.mocked(getVoiceInfoFn).mockResolvedValue(readyInfo);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useVoiceInput", () => {
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
