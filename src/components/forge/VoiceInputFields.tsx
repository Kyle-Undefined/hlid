import { useEffect, useState } from "react";
import type {
	CodexRealtimeAvailability,
	ModelInputAvailability,
} from "#/lib/providerOptions";
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

function runtimeStatusLabel(status: VoiceInfo["status"]): string {
	const parts: string[] = [status.state];
	if (status.loadedModel) parts.push(status.loadedModel);
	if (status.backend)
		parts.push(status.backend === "vulkan" ? "Vulkan" : "CPU");
	if (status.device) parts.push(status.device);
	return parts.join(" · ");
}

/** Enable toggle, runtime status, language, auto-send, and hotkey capture. */
export function VoiceInputFields({
	voice,
	onChange,
	status,
	codexAudio,
	codexAudioCatalog,
	codexDictation,
}: {
	voice: VoiceForm;
	onChange: (patch: Partial<VoiceForm>) => void;
	status: VoiceInfo["status"];
	codexAudio: ModelInputAvailability;
	codexAudioCatalog: ModelInputAvailability;
	codexDictation: CodexRealtimeAvailability;
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
	const showTalkToCodex =
		codexAudioCatalog.available || voice.input_provider === "codex";
	const selectedCodexAvailability =
		voice.input_provider === "codex_dictation" ? codexDictation : codexAudio;
	const selectedCodexLabel =
		voice.input_provider === "codex_dictation"
			? "Codex realtime dictation"
			: "Codex audio input";
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
				<div className="flex min-w-0 max-w-full flex-col items-start gap-1.5">
					<select
						value={voice.input_provider}
						onChange={(event) =>
							onChange({
								input_provider: event.target
									.value as VoiceForm["input_provider"],
							})
						}
						aria-label="Microphone action"
						className="w-56 max-w-full border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-foreground focus:border-primary/50 focus:outline-none sm:w-72"
					>
						<option value="local">Dictate with Whisper</option>
						<option
							value="codex_dictation"
							disabled={!codexDictation.available}
						>
							Dictate with Codex · Preview
							{codexDictation.available ? "" : " · unavailable"}
						</option>
						{showTalkToCodex && (
							<option value="codex" disabled={!codexAudio.available}>
								Talk to Codex
								{codexAudio.available ? "" : " · unavailable"}
							</option>
						)}
					</select>
					{!codexDictation.available && codexDictation.reason && (
						<span className="max-w-72 break-words text-[10px] text-muted-foreground [overflow-wrap:anywhere]">
							{codexDictation.reason}
						</span>
					)}
				</div>
			</Field>
			<Field
				label="Runtime status"
				hint={
					voice.input_provider === "local"
						? (status.error ?? status.fallbackReason)
						: selectedCodexAvailability.reason
				}
			>
				{voice.input_provider === "local" ? (
					<StatusIndicator
						ok={runtimeOk}
						label={`Voice runtime ${status.state}`}
					>
						<span aria-live="polite">{runtimeStatusLabel(status)}</span>
					</StatusIndicator>
				) : (
					<StatusIndicator
						ok={selectedCodexAvailability.available}
						label={
							selectedCodexAvailability.available
								? `${selectedCodexLabel} available`
								: `${selectedCodexLabel} unavailable`
						}
					>
						<span aria-live="polite">selected</span>
					</StatusIndicator>
				)}
			</Field>
			{voice.input_provider === "local" && (
				<Field
					label="Language"
					hint="automatic detection works with multilingual models"
				>
					<select
						value={voice.language}
						onChange={(e) => onChange({ language: e.target.value })}
						className="w-32 sm:w-48 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
					>
						{LANGUAGES.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</Field>
			)}
			{voice.input_provider !== "codex" && (
				<Field
					label="After transcription"
					hint="reviewing first reduces accidental submissions"
				>
					<select
						value={voice.auto_send ? "send" : "review"}
						onChange={(e) => onChange({ auto_send: e.target.value === "send" })}
						className="w-32 sm:w-48 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
					>
						<option value="review">Review draft</option>
						<option value="send">Send immediately</option>
					</select>
				</Field>
			)}
			{voice.input_provider === "local" && (
				<>
					<Field
						label="Acceleration"
						hint="Auto uses a compatible GPU through Vulkan and falls back to CPU. Hlid does not install GPU drivers."
					>
						<select
							value={voice.acceleration}
							onChange={(event) =>
								onChange({
									acceleration: event.target.value as "auto" | "cpu",
								})
							}
							aria-label="Whisper acceleration"
							className="w-40 sm:w-52 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
						>
							<option value="auto">Auto · GPU when available</option>
							<option value="cpu">CPU only</option>
						</select>
					</Field>
					<Field
						label="Whisper threads"
						hint="controls CPU fallback and CPU-only performance; changing it reloads the voice model"
					>
						<select
							value={voice.threads}
							onChange={(e) => onChange({ threads: Number(e.target.value) })}
							aria-label="Whisper threads"
							className="w-40 sm:w-52 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
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
							className="w-56 sm:w-80 resize-y bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
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
					className="w-40 sm:w-52 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 cursor-pointer"
				/>
			</Field>
		</Section>
	);
}
