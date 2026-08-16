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

function readyPronunciationTtsInfo(): TtsInfo {
	return {
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
				voices: [
					{
						id: "expr-voice-5-f",
						label: "Expressive 5",
						language: "en-US",
						speaker: 7,
					},
				],
			},
		],
	};
}

function coriPronunciationModel(): TtsInfo["models"][number] {
	return {
		id: "piper-cori-medium-int8",
		label: "Piper Cori",
		description: "Local speech",
		tier: "balanced",
		sizeBytes: 1,
		runtimeSizeBytes: 1,
		installed: true,
		recommended: false,
		quantized: true,
		language: "English",
		license: "MIT",
		voices: [
			{
				id: "piper-cori",
				label: "Cori",
				language: "en-GB",
				speaker: 0,
			},
		],
	};
}

function installPronunciationAudioMock(objectUrl: string) {
	const audio = {
		onended: null as (() => void) | null,
		onerror: null as (() => void) | null,
		onplaying: null as (() => void) | null,
		pause: vi.fn(),
		play: vi.fn().mockResolvedValue(undefined),
	};
	const Audio = vi.fn(function AudioMock() {
		return audio;
	});
	vi.stubGlobal("Audio", Audio);
	const createObjectURL = vi.fn(() => objectUrl);
	const revokeObjectURL = vi.fn();
	class PreviewURL extends URL {
		static createObjectURL = createObjectURL;
		static revokeObjectURL = revokeObjectURL;
	}
	vi.stubGlobal("URL", PreviewURL);
	return { audio, Audio, createObjectURL, revokeObjectURL };
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

	it("adds, saves, and removes local neural pronunciations", () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(Response.json({ available: false, voices: [] })),
		);
		const onChange = vi.fn();
		render(
			<Harness
				onChange={onChange}
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					pronunciations: [{ written: "Hlið", spoken: "hleeth" }],
				}}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Say as pronunciation 1"), {
			target: { value: "hleeth skiyahlf" },
		});
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.blur(screen.getByLabelText("Say as pronunciation 1"));
		expect(onChange).toHaveBeenLastCalledWith({
			pronunciations: [{ written: "Hlið", spoken: "hleeth skiyahlf" }],
		});

		fireEvent.click(screen.getByRole("button", { name: "Add pronunciation" }));
		expect(screen.getAllByLabelText(/Written pronunciation/)).toHaveLength(2);
		expect(
			(
				screen.getByRole("button", {
					name: "Add pronunciation",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		onChange.mockClear();
		fireEvent.change(screen.getByLabelText("Written pronunciation 2"), {
			target: { value: "Raven" },
		});
		fireEvent.blur(screen.getByLabelText("Written pronunciation 2"));
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Say as pronunciation 2"), {
			target: { value: "ray ven" },
		});
		fireEvent.blur(screen.getByLabelText("Say as pronunciation 2"));
		expect(onChange).toHaveBeenLastCalledWith({
			pronunciations: [
				{ written: "Hlið", spoken: "hleeth skiyahlf" },
				{ written: "Raven", spoken: "ray ven" },
			],
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Remove pronunciation 1" }),
		);
		expect(onChange).toHaveBeenLastCalledWith({
			pronunciations: [{ written: "Raven", spoken: "ray ven" }],
		});
	});

	it("disables pronunciation previews when the selected model failed over to another runtime", () => {
		const fetch = vi.fn().mockResolvedValue(
			Response.json({
				available: false,
				voices: [],
			}),
		);
		vi.stubGlobal("fetch", fetch);
		render(
			<Harness
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					read_aloud_provider: "neural",
					tts_model: "piper-cori-medium-int8",
					tts_voice: "piper-cori",
					pronunciations: [{ written: "Hlið", spoken: "hleeth" }],
				}}
				ttsInfo={{
					status: {
						state: "ready",
						model: "piper-cori-medium-int8",
						loadedModel: "kitten",
						error: "Cori failed to load",
					},
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
							voices: [
								{
									id: "expr-voice-5-f",
									label: "Expressive 5",
									language: "en-US",
									speaker: 7,
								},
							],
						},
						coriPronunciationModel(),
					],
				}}
			/>,
		);

		expect(
			screen.getByText(
				"The selected local neural model is not loaded. Resolve its model error before playing pronunciation previews.",
			),
		).toBeTruthy();
		expect(
			(
				screen.getByRole("button", {
					name: "Preview pronunciation 1",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			(
				screen.getByRole("button", {
					name: "Play preview",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		fireEvent.change(screen.getByLabelText("Pronunciation test sentence"), {
			target: { value: "The live logs are ready." },
		});
		expect(
			(
				screen.getByRole("button", {
					name: "Play pronunciation test",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(fetch).not.toHaveBeenCalledWith(
			"/api/speech/synthesize",
			expect.anything(),
		);
	});

	it("tests the exact user pronunciation library with the selected neural voice", async () => {
		const fetch = vi.fn((input: RequestInfo | URL) => {
			if (input === "/api/read-aloud/voices") {
				return Promise.resolve(Response.json({ available: false, voices: [] }));
			}
			return Promise.resolve(
				new Response(new Blob(["RIFF0000WAVEaudio"]), {
					status: 200,
					headers: { "content-type": "audio/wav" },
				}),
			);
		});
		vi.stubGlobal("fetch", fetch);
		const preview = installPronunciationAudioMock(
			"blob:user-pronunciation-test",
		);
		render(
			<Harness
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					read_aloud_provider: "neural",
					read_aloud_rate: 1.25,
					tts_model: "kitten",
					tts_voice: "expr-voice-5-f",
					pronunciations: [
						{ written: "live logs", spoken: "custom live logs" },
					],
				}}
				ttsInfo={readyPronunciationTtsInfo()}
			/>,
		);

		const sentence = screen.getByLabelText(
			"Pronunciation test sentence",
		) as HTMLInputElement;
		expect(sentence.maxLength).toBe(300);
		fireEvent.change(sentence, {
			target: { value: "Live logs are ready. The live preview is ready." },
		});
		expect(
			screen.getByText(
				"custom live logs are ready. The live preview is ready.",
			),
		).toBeTruthy();
		expect(screen.getByText("Text sent to voice:")).toBeTruthy();
		expect(
			screen.getByText(
				"Uses the selected local neural voice, speed, and your pronunciations. The transcript is unchanged.",
			),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Play pronunciation test" }),
		);

		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				"/api/speech/synthesize",
				expect.objectContaining({
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						text: "custom live logs are ready. The live preview is ready.",
						voice_id: "expr-voice-5-f",
						rate: 1.25,
					}),
				}),
			),
		);
		await waitFor(() => expect(preview.audio.play).toHaveBeenCalledOnce());
		act(() => preview.audio.onplaying?.());
		const stop = screen.getByRole("button", {
			name: "Stop pronunciation test",
		});
		expect(stop.textContent).toBe("Playing…");
		fireEvent.click(stop);

		expect(preview.audio.pause).toHaveBeenCalledOnce();
		expect(preview.revokeObjectURL).toHaveBeenCalledWith(
			"blob:user-pronunciation-test",
		);
		expect(
			screen.getByRole("button", { name: "Play pronunciation test" }),
		).toBeTruthy();
	});

	it("aborts a sentence test while local synthesis is still loading", async () => {
		const synthesisRequest: {
			signal?: AbortSignal;
			resolve?: (response: Response) => void;
		} = {};
		const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (input === "/api/read-aloud/voices") {
				return Promise.resolve(Response.json({ available: false, voices: [] }));
			}
			synthesisRequest.signal = init?.signal as AbortSignal;
			return new Promise<Response>((resolve) => {
				synthesisRequest.resolve = resolve;
			});
		});
		vi.stubGlobal("fetch", fetch);
		const preview = installPronunciationAudioMock(
			"blob:aborted-pronunciation-test",
		);
		render(
			<Harness
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					read_aloud_provider: "neural",
					tts_model: "kitten",
					tts_voice: "expr-voice-5-f",
				}}
				ttsInfo={readyPronunciationTtsInfo()}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Pronunciation test sentence"), {
			target: { value: "Open the live logs." },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Play pronunciation test" }),
		);
		await waitFor(() => expect(synthesisRequest.signal).toBeDefined());
		const stop = screen.getByRole("button", {
			name: "Stop pronunciation test",
		});
		expect(stop.textContent).toBe("Loading…");
		fireEvent.click(stop);

		expect(synthesisRequest.signal?.aborted).toBe(true);
		expect(
			screen.getByRole("button", { name: "Play pronunciation test" }),
		).toBeTruthy();
		await act(async () => {
			synthesisRequest.resolve?.(
				new Response(new Blob(["RIFF0000WAVEaudio"]), { status: 200 }),
			);
		});
		await waitFor(() =>
			expect(preview.revokeObjectURL).toHaveBeenCalledWith(
				"blob:aborted-pronunciation-test",
			),
		);
		expect(preview.Audio).not.toHaveBeenCalled();
	});

	it("stops a pronunciation preview when the selected speech settings change", async () => {
		const fetch = vi.fn((input: RequestInfo | URL) => {
			if (input === "/api/read-aloud/voices") {
				return Promise.resolve(Response.json({ available: false, voices: [] }));
			}
			return Promise.resolve(
				new Response(new Blob(["RIFF0000WAVEaudio"]), { status: 200 }),
			);
		});
		vi.stubGlobal("fetch", fetch);
		const preview = installPronunciationAudioMock(
			"blob:changed-pronunciation-settings",
		);
		render(
			<Harness
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					read_aloud_provider: "neural",
					tts_model: "kitten",
					tts_voice: "expr-voice-5-f",
				}}
				ttsInfo={readyPronunciationTtsInfo()}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Pronunciation test sentence"), {
			target: { value: "Open the live logs." },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Play pronunciation test" }),
		);
		await waitFor(() => expect(preview.audio.play).toHaveBeenCalledOnce());
		act(() => preview.audio.onplaying?.());

		fireEvent.change(screen.getByLabelText("Read aloud speed"), {
			target: { value: "1.25" },
		});

		await waitFor(() => expect(preview.audio.pause).toHaveBeenCalledOnce());
		expect(preview.revokeObjectURL).toHaveBeenCalledWith(
			"blob:changed-pronunciation-settings",
		);
		expect(
			screen.getByRole("button", { name: "Play pronunciation test" }),
		).toBeTruthy();
	});

	it("blocks expanded pronunciation tests above the synthesis limit", () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(Response.json({ available: false, voices: [] })),
		);
		render(
			<Harness
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					read_aloud_provider: "neural",
					tts_model: "kitten",
					tts_voice: "expr-voice-5-f",
					pronunciations: [{ written: "x", spoken: "z".repeat(80) }],
				}}
				ttsInfo={readyPronunciationTtsInfo()}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Pronunciation test sentence"), {
			target: { value: "x x x x" },
		});
		const play = screen.getByRole("button", {
			name: "Play pronunciation test",
		}) as HTMLButtonElement;
		expect(play.disabled).toBe(true);
		expect(
			screen.getByText(
				"The effective sentence is 323 characters. Shorten it to 300 or fewer before playing.",
			),
		).toBeTruthy();
	});

	it("flags case-equivalent written forms and keeps them local", () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(Response.json({ available: false, voices: [] })),
		);
		const onChange = vi.fn();
		render(
			<Harness
				onChange={onChange}
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					tts_model: "kitten",
					tts_voice: "expr-voice-5-f",
					pronunciations: [
						{ written: "Hlið", spoken: "hleeth" },
						{ written: "Raven", spoken: "ray ven" },
					],
				}}
				ttsInfo={readyPronunciationTtsInfo()}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Written pronunciation 2"), {
			target: { value: "hLIÐ" },
		});
		fireEvent.blur(screen.getByLabelText("Written pronunciation 2"));

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getAllByText("Duplicate written form")).toHaveLength(2);
		expect(
			screen.getByText(
				"Written forms must be unique, ignoring capitalization.",
			),
		).toBeTruthy();
		for (const input of screen.getAllByLabelText(/Written pronunciation/)) {
			expect(input.getAttribute("aria-invalid")).toBe("true");
		}
		expect(
			(
				screen.getByRole("button", {
					name: "Add pronunciation",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		for (const button of screen.getAllByRole("button", {
			name: /Preview pronunciation/,
		})) {
			expect((button as HTMLButtonElement).disabled).toBe(true);
		}

		fireEvent.change(screen.getByLabelText("Written pronunciation 2"), {
			target: { value: "Raven" },
		});
		fireEvent.blur(screen.getByLabelText("Written pronunciation 2"));
		expect(onChange).toHaveBeenLastCalledWith({
			pronunciations: [
				{ written: "Hlið", spoken: "hleeth" },
				{ written: "Raven", spoken: "ray ven" },
			],
		});
		expect(screen.queryByText("Duplicate written form")).toBeNull();
		for (const button of screen.getAllByRole("button", {
			name: /Preview pronunciation/,
		})) {
			expect((button as HTMLButtonElement).disabled).toBe(false);
		}
	});

	it("aborts a loading pronunciation preview when its row is removed", async () => {
		const previewRequest: {
			signal?: AbortSignal;
			resolve?: (response: Response) => void;
		} = {};
		const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (input === "/api/read-aloud/voices") {
				return Promise.resolve(Response.json({ available: false, voices: [] }));
			}
			previewRequest.signal = init?.signal as AbortSignal;
			return new Promise<Response>((resolve) => {
				previewRequest.resolve = resolve;
			});
		});
		vi.stubGlobal("fetch", fetch);
		const Audio = vi.fn();
		vi.stubGlobal("Audio", Audio);
		const createObjectURL = vi.fn(() => "blob:late-pronunciation-preview");
		const revokeObjectURL = vi.fn();
		class PreviewURL extends URL {
			static createObjectURL = createObjectURL;
			static revokeObjectURL = revokeObjectURL;
		}
		vi.stubGlobal("URL", PreviewURL);
		render(
			<Harness
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					tts_model: "kitten",
					tts_voice: "expr-voice-5-f",
					pronunciations: [
						{ written: "Hlið", spoken: "hleeth" },
						{ written: "Raven", spoken: "ray ven" },
					],
				}}
				ttsInfo={readyPronunciationTtsInfo()}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Preview pronunciation 2" }),
		);
		await waitFor(() => expect(previewRequest.signal).toBeDefined());
		expect(screen.getByText("Loading…")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Remove pronunciation 2" }),
		);
		expect(previewRequest.signal?.aborted).toBe(true);
		expect(screen.queryByText("Loading…")).toBeNull();

		await act(async () => {
			previewRequest.resolve?.(
				new Response(new Blob(["RIFF0000WAVEaudio"]), {
					status: 200,
				}),
			);
		});
		await waitFor(() =>
			expect(revokeObjectURL).toHaveBeenCalledWith(
				"blob:late-pronunciation-preview",
			),
		);
		expect(Audio).not.toHaveBeenCalled();
	});

	it("stops a playing pronunciation preview before row labels shift", async () => {
		const fetch = vi.fn((input: RequestInfo | URL) => {
			if (input === "/api/read-aloud/voices") {
				return Promise.resolve(Response.json({ available: false, voices: [] }));
			}
			return Promise.resolve(
				new Response(new Blob(["RIFF0000WAVEaudio"]), { status: 200 }),
			);
		});
		vi.stubGlobal("fetch", fetch);
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
		const revokeObjectURL = vi.fn();
		class PreviewURL extends URL {
			static createObjectURL = vi.fn(() => "blob:playing-preview");
			static revokeObjectURL = revokeObjectURL;
		}
		vi.stubGlobal("URL", PreviewURL);
		render(
			<Harness
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					tts_model: "kitten",
					tts_voice: "expr-voice-5-f",
					pronunciations: [
						{ written: "Hlið", spoken: "hleeth" },
						{ written: "Raven", spoken: "ray ven" },
					],
				}}
				ttsInfo={readyPronunciationTtsInfo()}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Preview pronunciation 2" }),
		);
		await waitFor(() => expect(previewAudio.play).toHaveBeenCalledOnce());
		act(() => previewAudio.onplaying?.());
		expect(screen.getByText("Playing…")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Remove pronunciation 1" }),
		);

		expect(previewAudio.pause).toHaveBeenCalledOnce();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:playing-preview");
		expect(screen.queryByText("Playing…")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Preview pronunciation 1" })
				.textContent,
		).toBe("Play");
	});

	it("previews a say-as value with the selected neural voice and speed", async () => {
		const fetch = vi.fn((input: RequestInfo | URL) => {
			if (input === "/api/read-aloud/voices") {
				return Promise.resolve(Response.json({ available: false, voices: [] }));
			}
			return Promise.resolve(
				new Response(new Blob(["RIFF0000WAVEaudio"]), {
					status: 200,
					headers: { "content-type": "audio/wav" },
				}),
			);
		});
		vi.stubGlobal("fetch", fetch);
		const previewAudio = {
			onended: null as (() => void) | null,
			onerror: null as (() => void) | null,
			onplaying: null as (() => void) | null,
			pause: vi.fn(),
			play: vi.fn().mockResolvedValue(undefined),
		};
		const Audio = vi.fn(function AudioMock() {
			return previewAudio;
		});
		vi.stubGlobal("Audio", Audio);
		const createObjectURL = vi.fn(() => "blob:pronunciation-preview");
		const revokeObjectURL = vi.fn();
		class PreviewURL extends URL {
			static createObjectURL = createObjectURL;
			static revokeObjectURL = revokeObjectURL;
		}
		vi.stubGlobal("URL", PreviewURL);
		render(
			<Harness
				initialVoice={{
					...DEFAULT_VOICE_CONFIG,
					read_aloud_provider: "neural",
					read_aloud_rate: 1.25,
					tts_model: "kitten",
					tts_voice: "expr-voice-5-f",
					pronunciations: [{ written: "Hlið", spoken: "hleeth" }],
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
							voices: [
								{
									id: "expr-voice-5-f",
									label: "Expressive 5",
									language: "en-US",
									speaker: 7,
								},
							],
						},
					],
				}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Preview pronunciation 1" }),
		);
		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				"/api/speech/synthesize",
				expect.objectContaining({
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						text: "hleeth",
						voice_id: "expr-voice-5-f",
						rate: 1.25,
					}),
				}),
			),
		);
		await waitFor(() =>
			expect(Audio).toHaveBeenCalledWith("blob:pronunciation-preview"),
		);
		expect(previewAudio.play).toHaveBeenCalledOnce();
		act(() => previewAudio.onplaying?.());
		expect(screen.getByText("Playing…")).toBeTruthy();
		act(() => previewAudio.onended?.());
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:pronunciation-preview");
	});
});
