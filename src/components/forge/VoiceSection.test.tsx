// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_CONFIG } from "#/config";

const server = vi.hoisted(() => ({
	getInfo: vi.fn(),
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

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("VoiceSection", () => {
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
		const vocabulary = screen.getByLabelText("Voice vocabulary hints");
		fireEvent.change(vocabulary, {
			target: { value: "Claude\nCodex\nKubernetes" },
		});
		fireEvent.blur(vocabulary);
		expect(onChange).toHaveBeenCalledWith({ enabled: true });
		expect(onChange).toHaveBeenCalledWith({ hotkey: "" });
		expect(onChange).toHaveBeenCalledWith({ threads: 8 });
		expect(onChange).toHaveBeenCalledWith({
			vocabulary: ["Claude", "Codex", "Kubernetes"],
		});
	});

	it("keeps microphone actions separate from realtime Developer Preview", () => {
		const onChange = vi.fn();
		render(
			<VoiceSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={onChange}
				initialInfo={baseInfo}
			/>,
		);

		expect(
			(screen.getByLabelText("Microphone action") as HTMLSelectElement).value,
		).toBe("local");
		fireEvent.change(screen.getByLabelText("Microphone action"), {
			target: { value: "codex" },
		});
		expect(onChange).toHaveBeenCalledWith({ input_provider: "codex" });
		fireEvent.click(screen.getByRole("checkbox", { name: "Codex realtime" }));

		expect(onChange).toHaveBeenCalledWith({
			codex_live_mode: true,
		});
	});
});
