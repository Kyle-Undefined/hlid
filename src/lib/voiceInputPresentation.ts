import { displayVoiceHotkey } from "./voiceHotkey";

export type VoiceInputPresentationOptions = {
	enabled: boolean;
	engine: "codex" | "codex_dictation" | "local";
	ready: boolean;
	unavailableReason?: string;
	localState: string;
	hotkey?: string;
};

export function voiceInputPresentation({
	enabled,
	engine,
	ready,
	unavailableReason,
	localState,
	hotkey,
}: VoiceInputPresentationOptions): {
	actionLabel: string;
	title: string;
} {
	const actionLabel =
		engine === "codex"
			? "Talk to Codex"
			: engine === "codex_dictation"
				? "Dictate with Codex"
				: "Dictate with Whisper";
	const title = !enabled
		? "Enable voice in Forge"
		: engine !== "local" && !ready
			? (unavailableReason ?? `${actionLabel} is unavailable`)
			: engine === "local" && localState !== "ready"
				? `Voice ${localState}`
				: hotkey
					? `${actionLabel} (${displayVoiceHotkey(hotkey)})`
					: actionLabel;
	return { actionLabel, title };
}
