import { describe, expect, it } from "vitest";
import {
	displayVoiceHotkey,
	matchesVoiceHotkey,
	voiceHotkeyFromEvent,
} from "./voiceHotkey";

const event = (patch: Partial<KeyboardEvent> = {}) => ({
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	code: "KeyV",
	...patch,
});

describe("voice hotkeys", () => {
	it("captures a canonical modifier chord", () => {
		expect(voiceHotkeyFromEvent(event({ altKey: true, shiftKey: true }))).toBe(
			"Alt+Shift+KeyV",
		);
	});

	it("rejects plain typing and modifier-only presses", () => {
		expect(voiceHotkeyFromEvent(event())).toBeNull();
		expect(
			voiceHotkeyFromEvent(event({ altKey: true, code: "AltLeft" })),
		).toBeNull();
	});

	it("matches exact modifiers and physical key", () => {
		expect(
			matchesVoiceHotkey(
				event({ altKey: true, shiftKey: true }),
				"Alt+Shift+KeyV",
			),
		).toBe(true);
		expect(matchesVoiceHotkey(event({ altKey: true }), "Alt+Shift+KeyV")).toBe(
			false,
		);
	});

	it("formats stored key codes for display", () => {
		expect(displayVoiceHotkey("Ctrl+Alt+Digit1")).toBe("Ctrl + Alt + 1");
	});
});
