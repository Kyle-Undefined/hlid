import { describe, expect, it } from "vitest";
import { voiceInputPresentation } from "./voiceInputPresentation";

describe("voiceInputPresentation", () => {
	it("describes ready local dictation with its configured hotkey", () => {
		expect(
			voiceInputPresentation({
				enabled: true,
				engine: "local",
				ready: true,
				localState: "ready",
				hotkey: "Ctrl+Alt+Digit1",
			}),
		).toEqual({
			actionLabel: "Dictate with Whisper",
			title: "Dictate with Whisper (Ctrl + Alt + 1)",
		});
	});

	it("keeps disabled and unavailable states ahead of the hotkey", () => {
		expect(
			voiceInputPresentation({
				enabled: false,
				engine: "codex",
				ready: false,
				unavailableReason: "Realtime unavailable",
				localState: "unavailable",
				hotkey: "Alt+KeyV",
			}).title,
		).toBe("Enable voice in Forge");
		expect(
			voiceInputPresentation({
				enabled: true,
				engine: "codex",
				ready: false,
				unavailableReason: "Realtime unavailable",
				localState: "unavailable",
			}).title,
		).toBe("Realtime unavailable");
	});

	it("presents Codex realtime dictation as editable dictation", () => {
		expect(
			voiceInputPresentation({
				enabled: true,
				engine: "codex_dictation",
				ready: true,
				localState: "unavailable",
				hotkey: "Alt+Shift+KeyV",
			}),
		).toEqual({
			actionLabel: "Dictate with Codex",
			title: "Dictate with Codex (Alt + Shift + V)",
		});
	});

	it("uses a truthful fallback for unavailable Codex dictation", () => {
		expect(
			voiceInputPresentation({
				enabled: true,
				engine: "codex_dictation",
				ready: false,
				localState: "ready",
			}).title,
		).toBe("Dictate with Codex is unavailable");
	});
});
