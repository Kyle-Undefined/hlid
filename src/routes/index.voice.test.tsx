// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	voiceOptions: null as null | {
		onTranscription: (text: string) => void;
		onAudioTurn: (audio: Blob) => void | Promise<void>;
		codexTurnAvailable: boolean;
		codexTurnUnavailableReason?: string;
		codexDictation: {
			available: boolean;
			unavailableReason?: string;
			phase: "idle" | "starting" | "connected" | "stopping" | "error";
			error: string | null;
			start: () => Promise<void>;
			stop: () => void;
			cancel: () => void;
			clearError: () => void;
		};
	},
	realtimeOptions: null as null | {
		sessionId: string;
		agentCwd?: string;
		providerId: string;
		voice?: string;
		onDictation: (text: string) => void;
	},
	realtimeMode: null as "dictation" | "read-aloud" | "live" | null,
	realtimePhase: "idle" as
		| "idle"
		| "starting"
		| "connected"
		| "stopping"
		| "error",
	realtimeError: null as string | null,
	realtimeUnavailableReason: null as string | null,
	realtimeStart: vi.fn(),
	realtimeStop: vi.fn(),
	realtimeCancel: vi.fn(),
	realtimeClearError: vi.fn(),
	uploadVoiceRecording: vi.fn(),
}));

vi.mock("#/hooks/codexRealtimeStore", () => ({
	useCodexRealtime: (options: typeof state.realtimeOptions) => {
		state.realtimeOptions = options;
		return {
			mode: state.realtimeMode,
			phase: state.realtimePhase,
			error: state.realtimeError,
			unavailableReason: state.realtimeUnavailableReason,
			start: state.realtimeStart,
			stop: state.realtimeStop,
			cancel: state.realtimeCancel,
			clearError: state.realtimeClearError,
		};
	},
}));

vi.mock("#/hooks/useVoiceInput", () => ({
	uploadVoiceRecording: state.uploadVoiceRecording,
	useVoiceInput: (options: typeof state.voiceOptions) => {
		state.voiceOptions = options;
		return { options };
	},
}));

import { useCockpitVoice } from "#/hooks/useCockpitVoice";

const voiceInfo = {
	status: { state: "unavailable", model: "" },
	models: [],
	codexRealtimeBackend: { available: true },
} as never;
const codexProvider = {
	id: "codex",
	label: "Codex",
	available: true,
	capabilities: { realtime: true },
} as never;

function voiceConfig(autoSend = false) {
	return {
		voice: {
			auto_send: autoSend,
			codex_live_mode: true,
			codex_voice: "marin",
		},
	} as never;
}

function composer(prompt = "", agentPath = "/work/project") {
	const textarea = document.createElement("textarea");
	textarea.value = prompt;
	return {
		value: {
			prompt,
			setPrompt: vi.fn(),
			textareaRef: { current: textarea },
			selectedAgentPath: agentPath,
		},
		textarea,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	state.voiceOptions = null;
	state.realtimeOptions = null;
	state.realtimeMode = null;
	state.realtimePhase = "idle";
	state.realtimeError = null;
	state.realtimeUnavailableReason = null;
	state.realtimeStart.mockResolvedValue(undefined);
	state.uploadVoiceRecording.mockResolvedValue({
		id: "voice-1",
		path: "/library/voice-1/voice-message.wav",
		filename: "voice-message.wav",
		mime: "audio/wav",
		kind: "ephemeral",
	});
});

afterEach(cleanup);

describe("useCockpitVoice", () => {
	it("inserts dictation at the active Cockpit selection and restores focus", () => {
		const prompt = composer("draft ending");
		prompt.textarea.setSelectionRange(6, 12);
		const focus = vi.spyOn(prompt.textarea, "focus");
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				callback(0);
				return 1;
			});
		try {
			renderHook(() =>
				useCockpitVoice(
					voiceConfig(),
					voiceInfo,
					prompt.value as never,
					{ uploadSessionIdRef: { current: null } } as never,
					"codex",
					codexProvider,
					{ available: true },
					vi.fn(),
				),
			);

			act(() => state.voiceOptions?.onTranscription("spoken"));

			expect(prompt.value.setPrompt).toHaveBeenCalledWith("draft spoken");
			expect(focus).toHaveBeenCalledOnce();
		} finally {
			requestFrame.mockRestore();
		}
	});

	it("auto-sends Cockpit dictation instead of changing the prompt", () => {
		const prompt = composer("existing draft");
		const handleRun = vi.fn().mockResolvedValue(undefined);
		renderHook(() =>
			useCockpitVoice(
				voiceConfig(true),
				voiceInfo,
				prompt.value as never,
				{ uploadSessionIdRef: { current: null } } as never,
				"codex",
				codexProvider,
				{ available: true },
				handleRun,
			),
		);

		act(() => state.voiceOptions?.onTranscription("send this"));

		expect(handleRun).toHaveBeenCalledWith("send this");
		expect(prompt.value.setPrompt).not.toHaveBeenCalled();
	});

	it("gates both Codex voice paths on the native Codex provider", async () => {
		const prompt = composer();
		renderHook(() =>
			useCockpitVoice(
				voiceConfig(),
				voiceInfo,
				prompt.value as never,
				{ uploadSessionIdRef: { current: null } } as never,
				"claude",
				codexProvider,
				{ available: true },
				vi.fn(),
			),
		);

		expect(state.voiceOptions).toMatchObject({
			codexTurnAvailable: false,
			codexDictation: {
				available: false,
				unavailableReason:
					"Dictate with Codex requires the native Codex provider.",
			},
		});
		await expect(
			state.voiceOptions?.onAudioTurn(
				new Blob(["recording"], { type: "audio/wav" }),
			),
		).rejects.toThrow("Talk to Codex requires the native Codex provider");
		expect(state.uploadVoiceRecording).not.toHaveBeenCalled();
	});

	it("uploads Codex audio once and hands the attachment to the run", async () => {
		const prompt = composer("", "/work/audio-agent");
		const uploadSessionIdRef = { current: null as string | null };
		const handleRun = vi.fn().mockResolvedValue(undefined);
		renderHook(() =>
			useCockpitVoice(
				voiceConfig(),
				voiceInfo,
				prompt.value as never,
				{ uploadSessionIdRef } as never,
				"codex",
				codexProvider,
				{ available: true, modelLabel: "GPT Audio" },
				handleRun,
			),
		);

		await act(async () => {
			await state.voiceOptions?.onAudioTurn(
				new Blob(["recording"], { type: "audio/wav" }),
			);
		});

		expect(uploadSessionIdRef.current).toEqual(expect.any(String));
		expect(state.uploadVoiceRecording).toHaveBeenCalledWith(expect.any(Blob), {
			sessionId: uploadSessionIdRef.current,
			agentCwd: "/work/audio-agent",
		});
		expect(handleRun).toHaveBeenCalledWith("Voice message", [
			expect.objectContaining({ id: "voice-1", mime: "audio/wav" }),
		]);
	});

	it("maps realtime dictation state and controls into the voice controller", async () => {
		state.realtimeMode = "dictation";
		state.realtimePhase = "error";
		state.realtimeError = "backend closed";
		const prompt = composer();
		renderHook(() =>
			useCockpitVoice(
				voiceConfig(),
				voiceInfo,
				prompt.value as never,
				{ uploadSessionIdRef: { current: null } } as never,
				"codex",
				codexProvider,
				{ available: false, reason: "model has no audio input" },
				vi.fn(),
			),
		);

		expect(state.voiceOptions).toMatchObject({
			codexTurnAvailable: false,
			codexTurnUnavailableReason: "model has no audio input",
			codexDictation: {
				available: true,
				phase: "error",
				error: "backend closed",
			},
		});
		await act(async () => state.voiceOptions?.codexDictation.start());
		expect(state.realtimeStart).toHaveBeenCalledWith("dictation");

		act(() => {
			state.voiceOptions?.codexDictation.stop();
			state.voiceOptions?.codexDictation.cancel();
			state.voiceOptions?.codexDictation.clearError();
		});
		expect(state.realtimeStop).toHaveBeenCalledOnce();
		expect(state.realtimeCancel).toHaveBeenCalledOnce();
		expect(state.realtimeClearError).toHaveBeenCalledOnce();
		expect(state.realtimeOptions).toMatchObject({
			agentCwd: "/work/project",
			providerId: "codex",
			voice: "marin",
		});
	});

	it("rotates the ephemeral dictation session when its Cockpit context changes", () => {
		const uploadSessionIdRef = { current: null as string | null };
		const handleRun = vi.fn().mockResolvedValue(undefined);
		const { rerender } = renderHook(
			({ agentPath }: { agentPath: string }) =>
				useCockpitVoice(
					voiceConfig(),
					voiceInfo,
					composer("", agentPath).value as never,
					{ uploadSessionIdRef } as never,
					"codex",
					codexProvider,
					{ available: false },
					handleRun,
				),
			{ initialProps: { agentPath: "/work/first" } },
		);
		const firstSessionId = state.realtimeOptions?.sessionId;

		rerender({ agentPath: "/work/second" });

		expect(state.realtimeOptions?.sessionId).toEqual(expect.any(String));
		expect(state.realtimeOptions?.sessionId).not.toBe(firstSessionId);
		expect(state.realtimeOptions?.agentCwd).toBe("/work/second");
	});
});
