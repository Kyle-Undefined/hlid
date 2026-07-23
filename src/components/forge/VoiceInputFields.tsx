import { useEffect, useState } from "react";
import type { ModelInputAvailability } from "#/lib/providerOptions";
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

const THREAD_OPTIONS = [
	[1, "Single core"],
	[2, "Minimal"],
	[4, "Low impact"],
	[6, "Moderate"],
	[8, "Balanced"],
	[12, "Fast"],
	[16, "Heavy"],
	[24, "Very heavy"],
	[32, "Maximum setting"],
] as const;

function parseVocabulary(value: string): string[] {
	return value
		.split("\n")
		.map((term) => term.trim().slice(0, 80))
		.filter(Boolean)
		.slice(0, 50);
}

/** Enable toggle, runtime status, language, auto-send, and hotkey capture. */
export function VoiceInputFields({
	voice,
	onChange,
	status,
	codexAudio,
}: {
	voice: VoiceForm;
	onChange: (patch: Partial<VoiceForm>) => void;
	status: VoiceInfo["status"];
	codexAudio: ModelInputAvailability;
}) {
	const [vocabularyText, setVocabularyText] = useState(
		voice.vocabulary.join("\n"),
	);
	useEffect(() => {
		setVocabularyText(voice.vocabulary.join("\n"));
	}, [voice.vocabulary]);
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
				hint="enable microphone controls in Raven and Cockpit"
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
			<Field
				label="Microphone action"
				hint="dictation creates editable text; Talk to Codex sends the full recording as a normal Codex turn"
			>
				<select
					value={voice.input_provider}
					onChange={(event) =>
						onChange({
							input_provider: event.target.value as "local" | "codex",
						})
					}
					aria-label="Microphone action"
					className="w-44 sm:w-56 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
				>
					<option value="local">Dictate with Whisper</option>
					<option
						value="codex"
						disabled={!codexAudio.available && voice.input_provider !== "codex"}
					>
						Talk to Codex
						{codexAudio.available ? "" : " · unavailable"}
					</option>
				</select>
			</Field>
			<Field
				label="Codex realtime"
				hint="developer preview; exposes Raven Live only when the signed-in account and Codex backend support realtime voice"
			>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={voice.codex_live_mode}
						onChange={(event) =>
							onChange({
								codex_live_mode: event.target.checked,
								...(!event.target.checked &&
								voice.read_aloud_provider === "codex"
									? { read_aloud_provider: "device" as const }
									: {}),
							})
						}
						className="w-3.5 h-3.5 accent-primary"
					/>
					<span className="text-xs text-muted-foreground">
						Developer Preview
					</span>
				</label>
			</Field>
			<Field
				label="Runtime status"
				hint={
					voice.input_provider === "local" ? status.error : codexAudio.reason
				}
			>
				{voice.input_provider === "local" ? (
					<StatusIndicator
						ok={runtimeOk}
						label={`Voice runtime ${status.state}`}
					>
						<span aria-live="polite">
							{status.state}
							{status.loadedModel ? ` · ${status.loadedModel}` : ""}
						</span>
					</StatusIndicator>
				) : (
					<StatusIndicator
						ok={codexAudio.available}
						label={
							codexAudio.available
								? "Codex audio input available"
								: "Codex audio input unavailable"
						}
					>
						<span aria-live="polite">selected</span>
					</StatusIndicator>
				)}
			</Field>
			{voice.input_provider === "local" && (
				<>
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
							onChange={(e) =>
								onChange({ auto_send: e.target.value === "send" })
							}
							className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
						>
							<option value="review">Review draft</option>
							<option value="send">Send immediately</option>
						</select>
					</Field>
					<Field
						label="Whisper threads"
						hint="higher values use more CPU while transcribing and reload the voice model"
					>
						<select
							value={voice.threads}
							onChange={(e) => onChange({ threads: Number(e.target.value) })}
							aria-label="Whisper threads"
							className="w-40 sm:w-52 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
						>
							{!THREAD_OPTIONS.some(([value]) => value === voice.threads) && (
								<option value={voice.threads}>{voice.threads} · Custom</option>
							)}
							{THREAD_OPTIONS.map(([value, label]) => (
								<option key={value} value={value}>
									{value} · {label}
								</option>
							))}
						</select>
					</Field>
					<Field
						label="Vocabulary hints"
						hint="one preferred spelling per line, up to 50; short lists work best"
					>
						<textarea
							value={vocabularyText}
							onChange={(event) => setVocabularyText(event.target.value)}
							onBlur={() =>
								onChange({ vocabulary: parseVocabulary(vocabularyText) })
							}
							rows={5}
							maxLength={4_000}
							aria-label="Voice vocabulary hints"
							className="w-56 sm:w-80 resize-y bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
						/>
					</Field>
				</>
			)}
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
