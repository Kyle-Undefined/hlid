import { describe, expect, it, vi } from "vitest";
import {
	MicrosoftSpeechManager,
	type PowerShellRunner,
} from "./microsoftSpeech";

const voices = [
	{
		id: "windows:mark",
		name: "Microsoft Mark",
		language: "en-US",
		gender: "Male",
		default: true,
	},
];

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function wave(): Uint8Array {
	return bytes("RIFF0000WAVEaudio");
}

describe("MicrosoftSpeechManager", () => {
	it("loads and caches the installed Microsoft voice inventory", async () => {
		const runner = vi
			.fn<PowerShellRunner>()
			.mockResolvedValue(bytes(JSON.stringify(voices)));
		const manager = new MicrosoftSpeechManager(runner);
		expect(await manager.voices()).toEqual(voices);
		expect(await manager.voices()).toEqual(voices);
		expect(runner).toHaveBeenCalledOnce();
	});

	it("validates a selected voice and returns WAV audio", async () => {
		const runner = vi
			.fn<PowerShellRunner>()
			.mockResolvedValueOnce(bytes(JSON.stringify(voices)))
			.mockResolvedValueOnce(wave());
		const manager = new MicrosoftSpeechManager(runner);
		expect(await manager.synthesize("Read this", "windows:mark")).toEqual(
			wave(),
		);
		expect(runner.mock.calls[1]?.[1]).toBe(
			JSON.stringify({ text: "Read this", voiceId: "windows:mark" }),
		);
	});

	it("rejects an unavailable selected voice before synthesis", async () => {
		const runner = vi
			.fn<PowerShellRunner>()
			.mockResolvedValue(bytes(JSON.stringify(voices)));
		const manager = new MicrosoftSpeechManager(runner);
		await expect(manager.synthesize("Read this", "missing")).rejects.toThrow(
			"unavailable",
		);
		expect(runner).toHaveBeenCalledOnce();
	});

	it("rejects non-WAV output", async () => {
		const runner = vi
			.fn<PowerShellRunner>()
			.mockResolvedValue(bytes("not audio"));
		const manager = new MicrosoftSpeechManager(runner);
		await expect(manager.synthesize("Read this", "")).rejects.toThrow(
			"invalid audio",
		);
	});
});
