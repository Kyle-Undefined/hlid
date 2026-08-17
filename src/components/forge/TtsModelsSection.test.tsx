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

vi.mock("#/lib/serverFns/tts", () => ({
	getTtsInfoFn: server.getInfo,
	startTtsDownloadFn: server.startDownload,
	cancelTtsDownloadFn: server.cancelDownload,
	deleteTtsModelFn: server.deleteModel,
}));

import type { TtsInfo } from "#/lib/serverFns/tts";
import { TtsModelsSection } from "./TtsModelsSection";

const model: TtsInfo["models"][number] = {
	id: "kitten-nano-v0.8-int8",
	label: "Kitten Nano v0.8 (Int8)",
	description: "Fast English speech with eight expressive voices",
	tier: "fast" as const,
	sizeBytes: 31_220_690,
	runtimeSizeBytes: 8_661_664,
	installed: false,
	recommended: true,
	quantized: true,
	language: "English",
	license: "Apache-2.0 model and sherpa-onnx · eSpeak-ng GPL-3.0-or-later",
	backends: ["cpu"],
	voices: [
		{
			id: "expr-voice-2-m",
			label: "Expressive 2 · masculine",
			language: "en-US",
			speaker: 0,
		},
	],
};

const info: TtsInfo = {
	status: { state: "unconfigured", model: "" },
	models: [model],
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("TtsModelsSection", () => {
	it("shows licensing and starts the explicit checked download", async () => {
		server.startDownload.mockResolvedValue({ ok: true });
		server.getInfo.mockResolvedValue(info);
		const onInfoChange = vi.fn();
		render(
			<TtsModelsSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={vi.fn()}
				info={info}
				onInfoChange={onInfoChange}
				busy={null}
				onBusyChange={vi.fn()}
				error={null}
				onError={vi.fn()}
			/>,
		);
		expect(screen.getByText(/eSpeak-ng GPL-3.0-or-later/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "DOWNLOAD" }));
		await waitFor(() =>
			expect(server.startDownload).toHaveBeenCalledWith({
				data: "kitten-nano-v0.8-int8",
			}),
		);
		await waitFor(() => expect(onInfoChange).toHaveBeenCalledWith(info));
	});

	it("keeps model and progress sizes in rounded MiB and GiB", () => {
		render(
			<TtsModelsSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={vi.fn()}
				info={{
					status: {
						state: "unconfigured",
						model: "",
						download: {
							model: model.id,
							item: "model",
							received: 31_220_690,
							total: 1.5 * 1024 ** 3,
						},
					},
					models: [
						{
							...model,
							sizeBytes: 1.5 * 1024 ** 3,
						},
					],
				}}
				onInfoChange={vi.fn()}
				busy={null}
				onBusyChange={vi.fn()}
				error={null}
				onError={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(
				"1.5 GiB model · 8 MiB runtime · English · quantized · CPU",
			),
		).toBeTruthy();
		expect(screen.getByText("Model: 30 MiB / 1.5 GiB")).toBeTruthy();
	});

	it("selects an installed model and protects a loaded model", () => {
		const onChange = vi.fn();
		render(
			<TtsModelsSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={onChange}
				info={{
					status: {
						state: "ready",
						model: model.id,
						loadedModel: model.id,
					},
					models: [{ ...model, installed: true }],
				}}
				onInfoChange={vi.fn()}
				busy={null}
				onBusyChange={vi.fn()}
				error={null}
				onError={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "SELECT" }));
		expect(onChange).toHaveBeenCalledWith({
			tts_model: model.id,
			tts_voice: "expr-voice-2-m",
		});
		expect(
			(screen.getByRole("button", { name: "DELETE" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("reports a failed download and releases the busy action", async () => {
		server.startDownload.mockRejectedValue(new Error("checksum mismatch"));
		const onBusyChange = vi.fn();
		const onError = vi.fn();
		render(
			<TtsModelsSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={vi.fn()}
				info={info}
				onInfoChange={vi.fn()}
				busy={null}
				onBusyChange={onBusyChange}
				error={null}
				onError={onError}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "DOWNLOAD" }));
		await waitFor(() =>
			expect(onError).toHaveBeenCalledWith("checksum mismatch"),
		);
		expect(onBusyChange.mock.calls).toEqual([[model.id], [null]]);
	});

	it("reports a failed deletion and releases the busy action", async () => {
		server.deleteModel.mockRejectedValue(new Error("model is in use"));
		const onBusyChange = vi.fn();
		const onError = vi.fn();
		render(
			<TtsModelsSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={vi.fn()}
				info={{
					status: { state: "ready", model: "" },
					models: [{ ...model, installed: true }],
				}}
				onInfoChange={vi.fn()}
				busy={null}
				onBusyChange={onBusyChange}
				error={null}
				onError={onError}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "DELETE" }));
		await waitFor(() =>
			expect(onError).toHaveBeenCalledWith("model is in use"),
		);
		expect(onBusyChange.mock.calls).toEqual([[model.id], [null]]);
	});

	it("cancels an active download and refreshes the model inventory", async () => {
		server.cancelDownload.mockResolvedValue(undefined);
		server.getInfo.mockResolvedValue(info);
		const onInfoChange = vi.fn();
		const onBusyChange = vi.fn();
		render(
			<TtsModelsSection
				voice={DEFAULT_VOICE_CONFIG}
				onChange={vi.fn()}
				info={{
					status: {
						state: "unconfigured",
						model: "",
						download: {
							model: model.id,
							item: "model",
							received: 10,
							total: 100,
						},
					},
					models: [model],
				}}
				onInfoChange={onInfoChange}
				busy={model.id}
				onBusyChange={onBusyChange}
				error={null}
				onError={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "CANCEL" }));
		await waitFor(() => expect(server.cancelDownload).toHaveBeenCalledOnce());
		await waitFor(() => expect(onInfoChange).toHaveBeenCalledWith(info));
		expect(onBusyChange).toHaveBeenCalledWith(null);
	});
});
