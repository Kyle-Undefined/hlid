// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_CONFIG, type HlidConfig } from "#/config";

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

const voiceConfig = (
	patch: Partial<HlidConfig["voice"]> = {},
): HlidConfig["voice"] => ({
	...DEFAULT_VOICE_CONFIG,
	...patch,
});

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

	it("does not sync local neural TTS on an ordinary non-neural mount", async () => {
		const view = renderHook(() => useTtsRuntimeState(DEFAULT_VOICE_CONFIG));

		await act(() => vi.advanceTimersByTimeAsync(1_200));
		expect(ttsServer.getInfo).toHaveBeenCalledOnce();
		expect(ttsServer.sync).not.toHaveBeenCalled();

		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ignores non-neural provider and dormant runtime-setting changes", async () => {
		const view = renderHook(({ voice }) => useTtsRuntimeState(voice), {
			initialProps: { voice: voiceConfig() },
		});

		view.rerender({
			voice: voiceConfig({
				read_aloud_provider: "microsoft",
				tts_model: "dormant-model",
				tts_threads: 12,
			}),
		});
		view.rerender({
			voice: voiceConfig({
				read_aloud_provider: "codex",
				tts_model: "another-dormant-model",
				tts_threads: 16,
			}),
		});

		await act(() => vi.advanceTimersByTimeAsync(1_200));
		expect(ttsServer.sync).not.toHaveBeenCalled();
	});

	it("syncs when neural TTS becomes effective, changes, and is disabled", async () => {
		const view = renderHook(({ voice }) => useTtsRuntimeState(voice), {
			initialProps: { voice: voiceConfig() },
		});

		view.rerender({
			voice: voiceConfig({
				read_aloud_provider: "neural",
				tts_model: "neural-a",
				tts_threads: 4,
			}),
		});
		await act(() => vi.advanceTimersByTimeAsync(1_200));
		expect(ttsServer.sync).toHaveBeenCalledTimes(1);

		view.rerender({
			voice: voiceConfig({
				read_aloud_provider: "neural",
				tts_model: "neural-b",
				tts_threads: 8,
			}),
		});
		await act(() => vi.advanceTimersByTimeAsync(1_200));
		expect(ttsServer.sync).toHaveBeenCalledTimes(2);

		view.rerender({
			voice: voiceConfig({
				read_aloud_provider: "neural",
				tts_model: "neural-b",
				tts_acceleration: "cpu",
				tts_threads: 8,
			}),
		});
		await act(() => vi.advanceTimersByTimeAsync(1_200));
		expect(ttsServer.sync).toHaveBeenCalledTimes(3);

		view.rerender({
			voice: voiceConfig({
				read_aloud_provider: "device",
				tts_model: "neural-b",
				tts_acceleration: "cpu",
				tts_threads: 8,
			}),
		});
		await act(() => vi.advanceTimersByTimeAsync(1_200));
		expect(ttsServer.sync).toHaveBeenCalledTimes(4);
	});

	it("keeps a pending neural shutdown across rapid non-neural changes", async () => {
		const view = renderHook(({ voice }) => useTtsRuntimeState(voice), {
			initialProps: {
				voice: voiceConfig({ read_aloud_provider: "neural" }),
			},
		});

		await act(() => vi.advanceTimersByTimeAsync(1_200));
		expect(ttsServer.sync).toHaveBeenCalledTimes(1);

		view.rerender({
			voice: voiceConfig({ read_aloud_provider: "device" }),
		});
		await act(() => vi.advanceTimersByTimeAsync(600));
		view.rerender({
			voice: voiceConfig({ read_aloud_provider: "codex" }),
		});
		await act(() => vi.advanceTimersByTimeAsync(600));

		// device and Codex have the same effective null runtime key, so the second
		// transition must not cancel the shutdown scheduled when neural was left.
		expect(ttsServer.sync).toHaveBeenCalledTimes(2);
	});

	it("syncs local neural TTS on a neural mount", async () => {
		const view = renderHook(() =>
			useTtsRuntimeState(
				voiceConfig({
					read_aloud_provider: "neural",
					tts_model: "neural-a",
				}),
			),
		);

		await act(() => vi.advanceTimersByTimeAsync(1_200));
		expect(ttsServer.sync).toHaveBeenCalledOnce();
		expect(ttsServer.getInfo).toHaveBeenCalledTimes(2);

		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("refreshes a ready neural backend so synthesis fallback stays truthful", async () => {
		const directMl = {
			status: {
				state: "ready" as const,
				model: "piper-cori-medium-int8",
				loadedModel: "piper-cori-medium-int8",
				backend: "directml" as const,
			},
			models: [],
		};
		const cpuFallback = {
			...directMl,
			status: {
				...directMl.status,
				backend: "cpu" as const,
				fallbackReason: "DirectML synthesis failed",
			},
		};
		ttsServer.getInfo.mockResolvedValue(directMl);
		const view = renderHook(() =>
			useTtsRuntimeState(
				voiceConfig({
					read_aloud_provider: "neural",
					tts_model: "piper-cori-medium-int8",
				}),
			),
		);
		await act(async () => await Promise.resolve());
		await act(() => vi.advanceTimersByTimeAsync(1_200));
		ttsServer.getInfo.mockClear().mockResolvedValue(cpuFallback);

		await act(() => vi.advanceTimersByTimeAsync(2_000));

		expect(ttsServer.getInfo).toHaveBeenCalled();
		expect(view.result.current.info.status).toMatchObject({
			backend: "cpu",
			fallbackReason: "DirectML synthesis failed",
		});
		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("surfaces delayed neural TTS sync failures and cancels its timer", async () => {
		ttsServer.sync.mockRejectedValue(new Error("TTS runtime unavailable"));
		const view = renderHook(() =>
			useTtsRuntimeState(
				voiceConfig({
					read_aloud_provider: "neural",
					tts_model: "neural-a",
				}),
			),
		);

		await act(() => vi.advanceTimersByTimeAsync(1_200));
		expect(view.result.current.error).toBe("TTS runtime unavailable");

		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
