import type { VoiceInfo } from "#/lib/serverFns/voice";
import { displayVoiceHotkey, voiceHotkeyFromEvent } from "#/lib/voiceHotkey";
import { Field, Section, StatusIndicator } from "./fields";
import type { VoiceForm } from "./VoiceSection";

const LANGUAGES = [
	["auto", "Automatic"],
	["en", "English"],
	["es", "Spanish"],
	["fr", "French"],
	["de", "German"],
	["it", "Italian"],
	["pt", "Portuguese"],
	["ja", "Japanese"],
	["zh", "Chinese"],
] as const;

/** Enable toggle, runtime status, language, auto-send, and hotkey capture. */
export function VoiceInputFields({
	voice,
	onChange,
	status,
}: {
	voice: VoiceForm;
	onChange: (patch: Partial<VoiceForm>) => void;
	status: VoiceInfo["status"];
}) {
	const runtimeOk =
		status.state === "ready"
			? true
			: status.state === "error" || status.state === "unavailable"
				? false
				: null;
	return (
		<Section title="Voice input">
			<Field
				label="Voice"
				hint="transcribe microphone audio locally on this machine"
			>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={voice.enabled}
						onChange={(e) => onChange({ enabled: e.target.checked })}
						className="w-3.5 h-3.5 accent-primary"
					/>
					<span className="text-xs text-muted-foreground">enabled</span>
				</label>
			</Field>
			<Field label="Runtime status" hint={status.error}>
				<StatusIndicator ok={runtimeOk} label={`Voice runtime ${status.state}`}>
					<span aria-live="polite">
						{status.state}
						{status.loadedModel ? ` · ${status.loadedModel}` : ""}
					</span>
				</StatusIndicator>
			</Field>
			<Field
				label="Language"
				hint="automatic detection works with multilingual models"
			>
				<select
					value={voice.language}
					onChange={(e) => onChange({ language: e.target.value })}
					className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
				>
					{LANGUAGES.map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</Field>
			<Field
				label="After transcription"
				hint="reviewing first reduces accidental submissions"
			>
				<select
					value={voice.auto_send ? "send" : "review"}
					onChange={(e) => onChange({ auto_send: e.target.value === "send" })}
					className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
				>
					<option value="review">Review draft</option>
					<option value="send">Send immediately</option>
				</select>
			</Field>
			<Field
				label="Recording hotkey"
				hint="desktop shortcut; press once to start and again to stop"
			>
				<input
					type="text"
					readOnly
					value={voice.hotkey ? displayVoiceHotkey(voice.hotkey) : ""}
					placeholder="Click and press shortcut"
					onKeyDown={(event) => {
						event.preventDefault();
						if (event.key === "Escape" || event.key === "Backspace") {
							onChange({ hotkey: "" });
							return;
						}
						const hotkey = voiceHotkeyFromEvent(event.nativeEvent);
						if (hotkey) onChange({ hotkey });
					}}
					aria-label="Voice recording hotkey"
					className="w-40 sm:w-52 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 cursor-pointer"
				/>
			</Field>
		</Section>
	);
}
