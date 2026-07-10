const MODIFIER_CODES = new Set([
	"AltLeft",
	"AltRight",
	"ControlLeft",
	"ControlRight",
	"MetaLeft",
	"MetaRight",
	"ShiftLeft",
	"ShiftRight",
]);

export function voiceHotkeyFromEvent(
	event: Pick<
		KeyboardEvent,
		"altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "code"
	>,
): string | null {
	if (MODIFIER_CODES.has(event.code)) return null;
	if (!event.altKey && !event.ctrlKey && !event.metaKey) return null;
	const parts: string[] = [];
	if (event.ctrlKey) parts.push("Ctrl");
	if (event.metaKey) parts.push("Meta");
	if (event.altKey) parts.push("Alt");
	if (event.shiftKey) parts.push("Shift");
	parts.push(event.code);
	return parts.join("+");
}

export function matchesVoiceHotkey(
	event: Pick<
		KeyboardEvent,
		"altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "code"
	>,
	hotkey: string,
): boolean {
	return voiceHotkeyFromEvent(event) === hotkey;
}

export function displayVoiceHotkey(hotkey: string): string {
	return hotkey
		.split("+")
		.map((part) =>
			part.startsWith("Key")
				? part.slice(3)
				: part.startsWith("Digit")
					? part.slice(5)
					: part,
		)
		.join(" + ");
}
