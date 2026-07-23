// @vitest-environment jsdom
import {
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
import { ReadAloudSection } from "./ReadAloudSection";

function Harness({
	onChange = vi.fn(),
	initialVoice = DEFAULT_VOICE_CONFIG,
}: {
	onChange?: (patch: Partial<HlidConfig["voice"]>) => void;
	initialVoice?: HlidConfig["voice"];
}) {
	const [voice, setVoice] = useState<HlidConfig["voice"]>(initialVoice);
	return (
		<ReadAloudSection
			voice={voice}
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

	it("offers Codex read aloud and its native voices", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					available: false,
					voices: [],
				}),
			),
		);
		const onChange = vi.fn();
		render(
			<Harness
				onChange={onChange}
				initialVoice={{ ...DEFAULT_VOICE_CONFIG, codex_live_mode: true }}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Read aloud speech engine"), {
			target: { value: "codex" },
		});
		fireEvent.change(screen.getByLabelText("Codex realtime voice"), {
			target: { value: "cedar" },
		});
		expect(onChange).toHaveBeenCalledWith({
			read_aloud_provider: "codex",
		});
		expect(onChange).toHaveBeenCalledWith({ codex_voice: "cedar" });
		expect(screen.queryByLabelText("Read aloud speed")).toBeNull();
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
});
