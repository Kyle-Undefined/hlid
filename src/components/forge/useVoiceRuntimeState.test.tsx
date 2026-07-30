// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_CONFIG } from "#/config";

const voiceServer = vi.hoisted(() => ({
	getInfo: vi.fn(),
}));
const ttsServer = vi.hoisted(() => ({
	getInfo: vi.fn(),
	sync: vi.fn(),
}));

vi.mock("#/lib/serverFns/voice", () => ({
	getVoiceInfoFn: voiceServer.getInfo,
}));
vi.mock("#/lib/serverFns/tts", () => ({
	getTtsInfoFn: ttsServer.getInfo,
	syncTtsConfigFn: ttsServer.sync,
}));

import type { VoiceInfo } from "#/lib/serverFns/voice";
import {
	useTtsRuntimeState,
	useVoiceRuntimeState,
} from "./useVoiceRuntimeState";

const idleVoice: VoiceInfo = {
	status: { state: "unconfigured", model: "" },
	models: [],
};
const installedVoice: VoiceInfo = {
	status: { state: "ready", model: "base", loadedModel: "base" },
	models: [
		{
			id: "base",
			label: "Base",
			sizeBytes: 1,
			sha1: "hash",
			multilingual: true,
			quantized: false,
			downloadUrl: "https://example.test/base.bin",
			installed: true,
		},
	],
};
const idleTts = {
	status: { state: "disabled" as const, model: "" },
	models: [],
};

beforeEach(() => {
	vi.useFakeTimers();
	voiceServer.getInfo.mockReset().mockResolvedValue(installedVoice);
	ttsServer.getInfo.mockReset().mockResolvedValue(idleTts);
	ttsServer.sync.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("voice runtime polling", () => {
	it.each([
		[
			"download",
			{
				state: "unconfigured" as const,
				model: "",
				download: { model: "base", received: 1, total: 2 },
			},
		],
		["loading", { state: "loading" as const, model: "base" }],
	])("polls while the runtime reports %s state", async (_label, status) => {
		const view = renderHook(() =>
			useVoiceRuntimeState({ status, models: [] }, DEFAULT_VOICE_CONFIG),
		);

		await act(() => vi.advanceTimersByTimeAsync(750));
		expect(voiceServer.getInfo).toHaveBeenCalledOnce();
		view.unmount();
	});

	it("clears busy after installation and cancels every timer on unmount", async () => {
		const view = renderHook(() =>
			useVoiceRuntimeState(idleVoice, DEFAULT_VOICE_CONFIG),
		);
		act(() => view.result.current.setBusy("base"));
		expect(vi.getTimerCount()).toBe(2);

		await act(() => vi.advanceTimersByTimeAsync(750));
		expect(view.result.current.busy).toBeNull();
		expect(view.result.current.info).toEqual(installedVoice);
		expect(vi.getTimerCount()).toBe(1);

		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("surfaces delayed TTS sync failures and cancels its timer", async () => {
		ttsServer.sync.mockRejectedValue(new Error("TTS runtime unavailable"));
		const view = renderHook(() => useTtsRuntimeState(DEFAULT_VOICE_CONFIG));

		await act(() => vi.advanceTimersByTimeAsync(1_200));
		expect(view.result.current.error).toBe("TTS runtime unavailable");

		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
