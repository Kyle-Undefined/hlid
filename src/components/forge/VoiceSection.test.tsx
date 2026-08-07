// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_CONFIG } from "#/config";
import type { ProviderInfo } from "#/lib/providerTypes";

const server = vi.hoisted(() => ({
	getInfo: vi.fn(),
	startDownload: vi.fn(),
	cancelDownload: vi.fn(),
	deleteModel: vi.fn(),
}));
const ttsServer = vi.hoisted(() => ({
	getInfo: vi.fn(),
	sync: vi.fn(),
	startDownload: vi.fn(),
	cancelDownload: vi.fn(),
	deleteModel: vi.fn(),
}));

vi.mock("#/lib/serverFns/voice", () => ({
	getVoiceInfoFn: server.getInfo,
	startVoiceDownloadFn: server.startDownload,
	cancelVoiceDownloadFn: server.cancelDownload,
	deleteVoiceModelFn: server.deleteModel,
}));
vi.mock("#/lib/serverFns/tts", () => ({
	getTtsInfoFn: ttsServer.getInfo,
	syncTtsConfigFn: ttsServer.sync,
	startTtsDownloadFn: ttsServer.startDownload,
	cancelTtsDownloadFn: ttsServer.cancelDownload,
	deleteTtsModelFn: ttsServer.deleteModel,
}));

import type { VoiceInfo } from "#/lib/serverFns/voice";
import { VoiceSection } from "./VoiceSection";

const baseInfo: VoiceInfo = {
	status: { state: "unconfigured", model: "" },
	models: [
		{
			id: "base",
			label: "Base",
			sizeBytes: 142 * 1024 ** 2,
			sha1: "hash",
			multilingual: true,
			quantized: false,
			recommended: true,
			downloadUrl: "https://example.test/base.bin",
			installed: false,
		},
	],
};

const codexProvider: ProviderInfo = {
	id: "codex",
	label: "Codex",
	available: true,
	capabilities: { realtime: true },
	models: [
		{
			value: "text-model",
			label: "Text Model",
			isDefault: true,
			inputModalities: ["text", "image"],
		},
		{
			value: "audio-model",
			label: "Audio Model",
			inputModalities: ["text", "image", "audio"],
		},
	],
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("VoiceSection", () => {
	beforeEach(() => {
		ttsServer.getInfo.mockResolvedValue({
			status: { state: "disabled", model: "" },
			models: [],
		});
		ttsServer.sync.mockResolvedValue({ ok: true });
	});
	it("reports download failure and allows retry", async () => {
		server.startDownload
			.mockRejectedValueOnce(new Error("checksum mismatch"))
			.mockResolvedValueOnce(undefined);
		server.getInfo.mockResolvedValue(baseInfo);
		render(
			<VoiceSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={vi.fn()}
				initialInfo={baseInfo}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "DOWNLOAD" }));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"checksum mismatch",
		);
		fireEvent.click(screen.getByRole("button", { name: "DOWNLOAD" }));
		await waitFor(() => expect(server.startDownload).toHaveBeenCalledTimes(2));
	});

	it("keeps a loaded model protected from deletion", () => {
		const info: VoiceInfo = {
			status: { state: "ready", model: "base", loadedModel: "base" },
			models: [{ ...baseInfo.models[0], installed: true }],
		};
		render(
			<VoiceSection
				voice={{ ...DEFAULT_VOICE_CONFIG, model: "base" }}
				onChange={vi.fn()}
				initialInfo={info}
			/>,
		);
		expect(screen.getByText("142 MiB · multilingual")).toBeTruthy();
		expect(
			(screen.getByRole("button", { name: "DELETE" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			screen.getByRole("img", { name: "Voice runtime ready" }),
		).toBeTruthy();
	});

	it("reports deletion failure without leaving actions busy", async () => {
		server.deleteModel.mockRejectedValue(new Error("model is in use"));
		const info: VoiceInfo = {
			status: { state: "ready", model: "tiny", loadedModel: "tiny" },
			models: [{ ...baseInfo.models[0], installed: true }],
		};
		render(
			<VoiceSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={vi.fn()}
				initialInfo={info}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "DELETE" }));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"model is in use",
		);
		expect(
			(screen.getByRole("button", { name: "DELETE" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});

	it("cancels an active download and refreshes status", async () => {
		server.cancelDownload.mockResolvedValue(undefined);
		server.getInfo.mockResolvedValue(baseInfo);
		const info: VoiceInfo = {
			...baseInfo,
			status: {
				state: "unconfigured",
				model: "",
				download: { model: "base", received: 10, total: 100 },
			},
		};
		render(
			<VoiceSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={vi.fn()}
				initialInfo={info}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "CANCEL" }));
		await waitFor(() => expect(server.cancelDownload).toHaveBeenCalledOnce());
		await waitFor(() => expect(server.getInfo).toHaveBeenCalled());
	});

	it("updates settings and clears the recording hotkey", () => {
		const onChange = vi.fn();
		render(
			<VoiceSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={onChange}
				initialInfo={baseInfo}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "Voice" }));
		fireEvent.keyDown(screen.getByLabelText("Voice recording hotkey"), {
			key: "Escape",
		});
		fireEvent.change(screen.getByLabelText("Whisper threads"), {
			target: { value: "8" },
		});
		fireEvent.change(screen.getByLabelText("Whisper acceleration"), {
			target: { value: "cpu" },
		});
		const vocabulary = screen.getByLabelText("Voice vocabulary hints");
		fireEvent.change(vocabulary, {
			target: { value: "Claude\nCodex\nKubernetes" },
		});
		fireEvent.blur(vocabulary);
		expect(onChange).toHaveBeenCalledWith({ enabled: true });
		expect(onChange).toHaveBeenCalledWith({ hotkey: "" });
		expect(onChange).toHaveBeenCalledWith({ threads: 8 });
		expect(onChange).toHaveBeenCalledWith({ acceleration: "cpu" });
		expect(onChange).toHaveBeenCalledWith({
			vocabulary: ["Claude", "Codex", "Kubernetes"],
		});
	});

	it("shows the actual Vulkan device and a nonfatal CPU fallback reason", () => {
		const info: VoiceInfo = {
			...baseInfo,
			status: {
				state: "ready",
				model: "base",
				loadedModel: "base",
				backend: "vulkan",
				device: "AMD Radeon RX 6700 XT",
			},
		};
		const { unmount } = render(
			<VoiceSection
				voice={{ ...DEFAULT_VOICE_CONFIG, enabled: true, model: "base" }}
				onChange={vi.fn()}
				initialInfo={info}
			/>,
		);
		expect(
			screen.getByText("ready · base · Vulkan · AMD Radeon RX 6700 XT"),
		).toBeTruthy();

		unmount();
		render(
			<VoiceSection
				voice={{ ...DEFAULT_VOICE_CONFIG, enabled: true, model: "base" }}
				onChange={vi.fn()}
				initialInfo={{
					...info,
					status: {
						...info.status,
						backend: "cpu",
						device: undefined,
						fallbackReason: "Vulkan startup failed: no compatible GPU",
					},
				}}
			/>,
		);
		expect(screen.getByText("ready · base · CPU")).toBeTruthy();
		expect(
			screen.getByText("Vulkan startup failed: no compatible GPU"),
		).toBeTruthy();
	});

	it("presents Whisper, Codex dictation, and Talk to Codex separately", () => {
		const onChange = vi.fn();
		render(
			<VoiceSection
				voice={{ ...DEFAULT_VOICE_CONFIG, codex_live_mode: true }}
				onChange={onChange}
				initialInfo={baseInfo}
				codexProvider={codexProvider}
				codexModel="audio-model"
			/>,
		);

		const microphoneAction = screen.getByLabelText(
			"Microphone action",
		) as HTMLSelectElement;
		expect(microphoneAction.value).toBe("local");
		expect(
			screen.getByRole("option", { name: "Dictate with Whisper" }),
		).toBeTruthy();
		expect(
			(
				screen.getByRole("option", {
					name: "Dictate with Codex · Preview",
				}) as HTMLOptionElement
			).disabled,
		).toBe(false);
		expect(
			(
				screen.getByRole("option", {
					name: "Talk to Codex",
				}) as HTMLOptionElement
			).disabled,
		).toBe(false);
		fireEvent.change(microphoneAction, {
			target: { value: "codex_dictation" },
		});
		expect(onChange).toHaveBeenCalledWith({
			input_provider: "codex_dictation",
		});
		fireEvent.change(screen.getByLabelText("Microphone action"), {
			target: { value: "codex" },
		});
		expect(onChange).toHaveBeenCalledWith({ input_provider: "codex" });
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Developer Preview" }),
		);

		expect(onChange).toHaveBeenCalledWith({
			codex_live_mode: false,
		});
		fireEvent.change(screen.getByLabelText("Codex realtime voice"), {
			target: { value: "cedar" },
		});
		expect(onChange).toHaveBeenCalledWith({ codex_voice: "cedar" });
		expect(
			screen.getByText(
				"Shared preview setup for two separate actions: Codex dictation and Raven Live.",
			),
		).toBeTruthy();
	});

	it("explains why Codex dictation is unavailable when preview is off", () => {
		render(
			<VoiceSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={vi.fn()}
				initialInfo={baseInfo}
				codexProvider={codexProvider}
				codexModel="audio-model"
			/>,
		);

		expect(
			(
				screen.getByRole("option", {
					name: "Dictate with Codex · Preview · unavailable",
				}) as HTMLOptionElement
			).disabled,
		).toBe(true);
		expect(
			screen.getByText(
				"Enable Codex realtime Developer Preview to use Codex dictation.",
			),
		).toBeTruthy();
	});

	it("uses a known realtime backend rejection for Codex dictation", () => {
		render(
			<VoiceSection
				voice={{ ...DEFAULT_VOICE_CONFIG, codex_live_mode: true }}
				onChange={vi.fn()}
				initialInfo={{
					...baseInfo,
					codexRealtimeBackend: {
						available: false,
						reason: "Realtime is unavailable for this account",
					},
				}}
				codexProvider={codexProvider}
				codexModel="audio-model"
			/>,
		);

		expect(
			(
				screen.getByRole("option", {
					name: "Dictate with Codex · Preview · unavailable",
				}) as HTMLOptionElement
			).disabled,
		).toBe(true);
		expect(
			screen.getByText("Realtime is unavailable for this account"),
		).toBeTruthy();
	});

	it("keeps draft behavior for Codex dictation without Whisper-only controls", () => {
		render(
			<VoiceSection
				voice={{
					...DEFAULT_VOICE_CONFIG,
					codex_live_mode: true,
					input_provider: "codex_dictation",
				}}
				onChange={vi.fn()}
				initialInfo={baseInfo}
				codexProvider={codexProvider}
				codexModel="audio-model"
			/>,
		);

		expect(screen.getByLabelText("After transcription")).toBeTruthy();
		expect(screen.queryByLabelText("Whisper acceleration")).toBeNull();
		expect(screen.queryByLabelText("Whisper threads")).toBeNull();
	});

	it("retains a disabled legacy Talk to Codex selection without audio models", () => {
		const providerWithoutAudio: ProviderInfo = {
			...codexProvider,
			models: codexProvider.models?.slice(0, 1),
		};
		const { unmount } = render(
			<VoiceSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={vi.fn()}
				initialInfo={baseInfo}
				codexProvider={providerWithoutAudio}
				codexModel="text-model"
			/>,
		);
		expect(screen.queryByRole("option", { name: /Talk to Codex/ })).toBeNull();

		unmount();
		render(
			<VoiceSection
				voice={{ ...DEFAULT_VOICE_CONFIG, input_provider: "codex" }}
				onChange={vi.fn()}
				initialInfo={baseInfo}
				codexProvider={providerWithoutAudio}
				codexModel="text-model"
			/>,
		);

		const microphoneAction = screen.getByLabelText(
			"Microphone action",
		) as HTMLSelectElement;
		expect(microphoneAction.value).toBe("codex");
		expect(
			(
				screen.getByRole("option", {
					name: "Talk to Codex · unavailable",
				}) as HTMLOptionElement
			).disabled,
		).toBe(true);
	});

	it("disabling preview only resets Codex dictation", () => {
		const onChange = vi.fn();
		render(
			<VoiceSection
				voice={{
					...DEFAULT_VOICE_CONFIG,
					codex_live_mode: true,
					input_provider: "codex_dictation",
					read_aloud_provider: "codex",
				}}
				onChange={onChange}
				initialInfo={baseInfo}
			/>,
		);

		fireEvent.click(
			screen.getByRole("checkbox", { name: "Developer Preview" }),
		);

		expect(onChange).toHaveBeenCalledWith({
			codex_live_mode: false,
			input_provider: "local",
		});
	});
});
