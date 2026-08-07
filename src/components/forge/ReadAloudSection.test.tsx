// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_CONFIG, type HlidConfig } from "#/config";
import { __resetReadAloudForTesting } from "#/hooks/readAloudStore";
import { READ_ALOUD_PREFERENCES_KEY } from "#/lib/readAloud";
import type { TtsInfo } from "#/lib/serverFns/tts";
import { ReadAloudSection } from "./ReadAloudSection";

function Harness({
	onChange = vi.fn(),
	initialVoice = DEFAULT_VOICE_CONFIG,
	ttsInfo,
}: {
	onChange?: (patch: Partial<HlidConfig["voice"]>) => void;
	initialVoice?: HlidConfig["voice"];
	ttsInfo?: TtsInfo;
}) {
	const [voice, setVoice] = useState<HlidConfig["voice"]>(initialVoice);
	return (
		<ReadAloudSection
			voice={voice}
			ttsInfo={ttsInfo}
			onChange={(patch) => {
				onChange(patch);
				setVoice((current) => ({ ...current, ...patch }));
			}}
		/>
	);
}

afterEach(() => {
	cleanup();
	__resetReadAloudForTesting();
	localStorage.clear();
	vi.unstubAllGlobals();
});

describe("ReadAloudSection", () => {
	it("offers Microsoft host voices and saves shared choices through Forge", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					available: true,
					voices: [
						{
							id: "voice-mark",
							name: "Microsoft Mark",
							language: "en-US",
							gender: "Male",
							default: false,
						},
					],
				}),
			),
		);

		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		const engine = screen.getByLabelText("Read aloud speech engine");
		await waitFor(() =>
			expect(
				engine
					.querySelector('option[value="microsoft"]')
					?.hasAttribute("disabled"),
			).toBe(false),
		);
		fireEvent.change(engine, { target: { value: "microsoft" } });

		const voice = await screen.findByLabelText("Read aloud Microsoft voice");
		expect(voice.textContent).toContain("Microsoft Mark");
		fireEvent.change(voice, { target: { value: "voice-mark" } });

		expect(onChange).toHaveBeenCalledWith({
			read_aloud_provider: "microsoft",
		});
		expect(onChange).toHaveBeenCalledWith({
			read_aloud_voice: "voice-mark",
		});
		expect(localStorage.getItem(READ_ALOUD_PREFERENCES_KEY)).toBeNull();
	});

	it("disables Microsoft host when Windows speech is unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					available: false,
					voices: [],
					error: "Windows speech is unavailable",
				}),
			),
		);

		render(<Harness />);
		const engine = screen.getByLabelText("Read aloud speech engine");
		await waitFor(() =>
			expect(
				engine
					.querySelector('option[value="microsoft"]')
					?.hasAttribute("disabled"),
			).toBe(true),
		);
	});

	it("keeps Codex read aloud hidden when the realtime preview is enabled", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					available: false,
					voices: [],
				}),
			),
		);
		render(
			<Harness
				initialVoice={{ ...DEFAULT_VOICE_CONFIG, codex_live_mode: true }}
			/>,
		);
		expect(
			screen
				.getByLabelText("Read aloud speech engine")
				.querySelector('option[value="codex"]'),
		).toBeNull();
		expect(screen.getByLabelText("Read aloud speed")).toBeTruthy();
	});

	it("keeps Codex realtime read aloud hidden outside Developer Preview", () => {
		render(<Harness />);
		expect(
			screen
				.getByLabelText("Read aloud speech engine")
				.querySelector('option[value="codex"]'),
		).toBeNull();
	});

	it("refreshes the Windows voice inventory from Forge", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ available: true, voices: [] }))
			.mockResolvedValueOnce(
				Response.json({
					available: true,
					voices: [
						{
							id: "voice-zira",
							name: "Microsoft Zira",
							language: "en-US",
							gender: "Female",
							default: false,
						},
					],
				}),
			);
		vi.stubGlobal("fetch", fetch);

		render(<Harness />);
		const engine = screen.getByLabelText("Read aloud speech engine");
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		fireEvent.change(engine, { target: { value: "microsoft" } });
		fireEvent.click(screen.getByRole("button", { name: "Refresh voices" }));

		await waitFor(() =>
			expect(fetch).toHaveBeenLastCalledWith(
				"/api/read-aloud/voices?refresh=1",
				{ cache: "no-store" },
			),
		);
		expect(
			await screen.findByRole("option", { name: "Microsoft Zira · en-US" }),
		).toBeTruthy();
	});

	it("offers installed local neural voices and CPU thread control", async () => {
		const previewAudio = {
			onended: null,
			onerror: null,
			onplaying: null,
			pause: vi.fn(),
			play: vi.fn(() => new Promise<void>(() => {})),
		};
		const Audio = vi.fn(function AudioMock() {
			return previewAudio;
		});
		vi.stubGlobal("Audio", Audio);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					available: true,
					voices: [],
				}),
			),
		);
		const onChange = vi.fn();
		render(
			<Harness
				onChange={onChange}
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					tts_model: "kitten-nano-v0.8-int8",
				}}
				ttsInfo={{
					status: {
						state: "ready",
						model: "kitten-nano-v0.8-int8",
						loadedModel: "kitten-nano-v0.8-int8",
					},
					models: [
						{
							id: "kitten-nano-v0.8-int8",
							label: "Kitten Nano v0.8",
							description: "Fast English speech",
							tier: "fast",
							sizeBytes: 25_000_000,
							runtimeSizeBytes: 9_000_000,
							installed: true,
							recommended: true,
							quantized: true,
							language: "English",
							license: "Apache-2.0",
							voices: [
								{
									id: "expr-voice-2-f",
									label: "Expressive 2 · feminine",
									language: "en-US",
									speaker: 1,
								},
								{
									id: "expr-voice-5-f",
									label: "Expressive 5 · feminine",
									language: "en-US",
									speaker: 7,
								},
							],
						},
					],
				}}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Read aloud speech engine"), {
			target: { value: "neural" },
		});
		fireEvent.change(screen.getByLabelText("Read aloud neural voice"), {
			target: { value: "expr-voice-5-f" },
		});
		fireEvent.change(screen.getByLabelText("Neural speech threads"), {
			target: { value: "8" },
		});
		expect(onChange).toHaveBeenCalledWith({
			read_aloud_provider: "neural",
		});
		expect(onChange).toHaveBeenCalledWith({ tts_voice: "expr-voice-5-f" });
		expect(onChange).toHaveBeenCalledWith({ tts_threads: 8 });
		const previewButton = screen.getByRole("button", {
			name: "Play preview",
		}) as HTMLButtonElement;
		expect(previewButton.disabled).toBe(false);
		fireEvent.click(previewButton);
		expect(Audio).toHaveBeenCalledWith("/api/read-aloud/preview");
		expect(screen.getByRole("button", { name: "Loading…" })).toBeTruthy();
	});

	it("keeps device voice local while saving shared reading speed", async () => {
		const speechSynthesis = {
			getVoices: vi.fn(() => [
				{
					voiceURI: "local-test",
					name: "Local Test",
					lang: "en-US",
					default: true,
					localService: true,
				},
			]),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		};
		vi.stubGlobal("speechSynthesis", speechSynthesis);
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(Response.json({ available: false, voices: [] })),
		);
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);

		const deviceVoice = await screen.findByLabelText("Read aloud device voice");
		fireEvent.change(deviceVoice, { target: { value: "local-test" } });
		fireEvent.change(screen.getByLabelText("Read aloud speed"), {
			target: { value: "1.5" },
		});

		expect(onChange).toHaveBeenCalledWith({ read_aloud_rate: 1.5 });
		expect(localStorage.getItem(READ_ALOUD_PREFERENCES_KEY)).toBe(
			'{"voiceURI":"local-test"}',
		);
	});

	it("reports a Microsoft voice refresh failure without throwing", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ available: true, voices: [] }))
			.mockRejectedValueOnce(new Error("Windows host is offline"));
		vi.stubGlobal("fetch", fetch);
		render(<Harness />);
		const engine = screen.getByLabelText("Read aloud speech engine");
		await waitFor(() =>
			expect(
				engine
					.querySelector('option[value="microsoft"]')
					?.hasAttribute("disabled"),
			).toBe(false),
		);
		fireEvent.change(engine, { target: { value: "microsoft" } });
		fireEvent.click(screen.getByRole("button", { name: "Refresh voices" }));

		expect(await screen.findByText("Windows host is offline")).toBeTruthy();
		expect(
			engine
				.querySelector('option[value="microsoft"]')
				?.hasAttribute("disabled"),
		).toBe(true);
	});

	it("returns neural preview controls to idle after playback ends", async () => {
		const previewAudio = {
			onended: null as (() => void) | null,
			onerror: null as (() => void) | null,
			onplaying: null as (() => void) | null,
			pause: vi.fn(),
			play: vi.fn().mockResolvedValue(undefined),
		};
		vi.stubGlobal(
			"Audio",
			vi.fn(function AudioMock() {
				return previewAudio;
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ available: true, voices: [] })),
		);
		render(
			<Harness
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					read_aloud_provider: "neural",
					tts_model: "kitten",
				}}
				ttsInfo={{
					status: { state: "ready", model: "kitten" },
					models: [
						{
							id: "kitten",
							label: "Kitten",
							description: "Local speech",
							tier: "fast",
							sizeBytes: 1,
							runtimeSizeBytes: 1,
							installed: true,
							recommended: true,
							quantized: true,
							language: "English",
							license: "Apache-2.0",
							voices: [],
						},
					],
				}}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Play preview" }));
		act(() => previewAudio.onplaying?.());
		expect(screen.getByRole("button", { name: "Playing…" })).toBeTruthy();
		act(() => previewAudio.onended?.());
		expect(screen.getByRole("button", { name: "Play preview" })).toBeTruthy();
	});
});
