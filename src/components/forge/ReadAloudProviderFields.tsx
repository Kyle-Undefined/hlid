import type { HlidConfig } from "#/config";
import type { LocalReadAloudVoice } from "#/hooks/readAloudStore";
import { setReadAloudPreferences } from "#/hooks/readAloudStore";
import type { ReadAloudPreferences } from "#/lib/readAloud";
import type { TtsInfo } from "#/lib/serverFns/tts";
import { Field } from "./fields";
import type { MicrosoftVoiceInventory } from "./useReadAloudControls";

const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2] as const;
const WINDOWS_VOICE_GUIDE =
	"https://support.microsoft.com/en-us/accessibility/windows/narrator/appendix-a-supported-languages-and-voices";
type VoiceConfig = HlidConfig["voice"];
export type ReadAloudViewPreferences = ReadAloudPreferences;
export type ReadAloudUpdater = (patch: Partial<VoiceConfig>) => void;
type PreviewControls = {
	state: "idle" | "loading" | "playing";
	error: string | null;
	play: () => void;
};

const selectClass =
	"w-48 sm:w-64 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50";

export function SpeechEngineField({
	preferences,
	microsoft,
	update,
}: {
	preferences: ReadAloudViewPreferences;
	microsoft: MicrosoftVoiceInventory | null;
	update: ReadAloudUpdater;
}) {
	return (
		<Field label="Speech engine" hint="saved for every device">
			<select
				value={preferences.provider}
				onChange={(event) =>
					update({
						read_aloud_provider: readAloudProvider(event.target.value),
					})
				}
				aria-label="Read aloud speech engine"
				className={selectClass}
			>
				<option value="device">Device browser</option>
				<option value="microsoft" disabled={microsoft?.available === false}>
					Microsoft host
				</option>
				<option value="neural">Local neural</option>
			</select>
		</Field>
	);
}

function readAloudProvider(value: string): VoiceConfig["read_aloud_provider"] {
	return value === "microsoft" || value === "neural" ? value : "device";
}

function DeviceVoiceField({
	preferences,
	voices,
}: {
	preferences: ReadAloudViewPreferences;
	voices: LocalReadAloudVoice[];
}) {
	const selectedVoiceURI = voices.some(
		(voice) => voice.voiceURI === preferences.voiceURI,
	)
		? preferences.voiceURI
		: "";
	return (
		<Field
			label="Device voice"
			hint="saved only on this device because browser voice lists differ"
		>
			<select
				value={selectedVoiceURI}
				onChange={(event) =>
					setReadAloudPreferences({ voiceURI: event.target.value })
				}
				disabled={voices.length === 0}
				aria-label="Read aloud device voice"
				className={selectClass}
			>
				<option value="">
					{voices.length === 0 ? "No local voices found" : "Automatic"}
				</option>
				{voices.map((voice) => (
					<option key={voice.voiceURI} value={voice.voiceURI}>
						{voice.name} · {voice.lang}
					</option>
				))}
			</select>
		</Field>
	);
}

function MicrosoftVoiceField({
	preferences,
	microsoft,
	update,
}: {
	preferences: ReadAloudViewPreferences;
	microsoft: MicrosoftVoiceInventory | null;
	update: ReadAloudUpdater;
}) {
	const hint =
		microsoft === null
			? "checking voices installed on the Hlid Windows host"
			: microsoft.available
				? "speech is generated on the Hlid host and played as audio on this device"
				: microsoft.error || "Microsoft speech is unavailable";
	return (
		<Field label="Microsoft voice" hint={hint}>
			<select
				value={preferences.microsoftVoiceId}
				onChange={(event) => update({ read_aloud_voice: event.target.value })}
				disabled={!microsoft?.available}
				aria-label="Read aloud Microsoft voice"
				className={selectClass}
			>
				<option value="">Microsoft default</option>
				{microsoft?.voices.map((voice) => (
					<option key={voice.id} value={voice.id}>
						{voice.name} · {voice.language}
						{voice.default ? " · default" : ""}
					</option>
				))}
			</select>
		</Field>
	);
}

function MicrosoftVoiceActions({
	refreshing,
	onRefresh,
}: {
	refreshing: boolean;
	onRefresh: () => void;
}) {
	return (
		<Field
			label="More Windows voices"
			hint="On the Windows host, add natural voices in Narrator settings or language voices in Time & language > Speech. Hlid can use voices Windows exposes to apps."
		>
			<div className="flex max-w-full flex-wrap items-center gap-2 @4xl:justify-end">
				<button
					type="button"
					onClick={() =>
						window.open(WINDOWS_VOICE_GUIDE, "_blank", "noopener,noreferrer")
					}
					className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
				>
					Setup guide
				</button>
				<button
					type="button"
					onClick={onRefresh}
					disabled={refreshing}
					className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase disabled:opacity-40"
				>
					{refreshing ? "Refreshing…" : "Refresh voices"}
				</button>
			</div>
		</Field>
	);
}

function MicrosoftVoiceFields({
	preferences,
	microsoft,
	refreshing,
	onRefresh,
	update,
}: {
	preferences: ReadAloudViewPreferences;
	microsoft: MicrosoftVoiceInventory | null;
	refreshing: boolean;
	onRefresh: () => void;
	update: ReadAloudUpdater;
}) {
	return (
		<>
			<MicrosoftVoiceField
				preferences={preferences}
				microsoft={microsoft}
				update={update}
			/>
			<MicrosoftVoiceActions refreshing={refreshing} onRefresh={onRefresh} />
		</>
	);
}

function NeuralVoiceField({
	model,
	voiceId,
	ready,
	error,
	update,
}: {
	model: TtsInfo["models"][number] | undefined;
	voiceId: string;
	ready: boolean;
	error?: string;
	update: ReadAloudUpdater;
}) {
	return (
		<Field
			label="Neural voice"
			hint={
				ready
					? "generated on the Hlid host with the downloaded local model"
					: error || "download and select the neural voice model below"
			}
		>
			<select
				value={voiceId}
				onChange={(event) => update({ tts_voice: event.target.value })}
				disabled={!model?.installed}
				aria-label="Read aloud neural voice"
				className={selectClass}
			>
				{model?.voices.map((candidate) => (
					<option key={candidate.id} value={candidate.id}>
						{candidate.label}
					</option>
				))}
			</select>
		</Field>
	);
}

function NeuralThreadsField({
	threads,
	update,
}: {
	threads: number;
	update: ReadAloudUpdater;
}) {
	const threadOptions = [1, 2, 4, 8, 16, 32];
	return (
		<Field
			label="Speech threads"
			hint="CPU threads reserved for local neural speech"
		>
			<select
				value={threads}
				onChange={(event) =>
					update({ tts_threads: Number(event.target.value) })
				}
				aria-label="Neural speech threads"
				className="w-32 sm:w-48 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
			>
				{!threadOptions.includes(threads) && (
					<option value={threads}>{threads}</option>
				)}
				{threadOptions.map((value) => (
					<option key={value} value={value}>
						{value}
					</option>
				))}
			</select>
		</Field>
	);
}

function NeuralPreviewField({
	ready,
	preview,
}: {
	ready: boolean;
	preview: PreviewControls;
}) {
	return (
		<Field
			label="Voice preview"
			hint={preview.error || "plays a fixed phrase with the saved voice"}
		>
			<button
				type="button"
				onClick={preview.play}
				disabled={!ready || preview.state !== "idle"}
				className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase disabled:opacity-40"
			>
				{preview.state === "loading"
					? "Loading…"
					: preview.state === "playing"
						? "Playing…"
						: "Play preview"}
			</button>
		</Field>
	);
}

function NeuralVoiceFields({
	voice,
	preferences,
	ttsInfo,
	preview,
	update,
}: {
	voice: VoiceConfig;
	preferences: ReadAloudViewPreferences;
	ttsInfo?: TtsInfo;
	preview: PreviewControls;
	update: ReadAloudUpdater;
}) {
	const model =
		ttsInfo?.models.find((item) => item.id === voice.tts_model) ??
		ttsInfo?.models.find((item) => item.recommended);
	const voiceId =
		model?.voices.find((item) => item.id === preferences.neuralVoiceId)?.id ??
		model?.voices[0]?.id ??
		"";
	const ready = ttsInfo?.status.state === "ready";
	return (
		<>
			<NeuralVoiceField
				model={model}
				voiceId={voiceId}
				ready={ready}
				error={ttsInfo?.status.error}
				update={update}
			/>
			<NeuralThreadsField threads={voice.tts_threads} update={update} />
			<NeuralPreviewField ready={ready} preview={preview} />
		</>
	);
}

export function ReadAloudProviderFields({
	voice,
	preferences,
	voices,
	microsoft,
	refreshingMicrosoft,
	onRefreshMicrosoft,
	ttsInfo,
	preview,
	update,
}: {
	voice: VoiceConfig;
	preferences: ReadAloudViewPreferences;
	voices: LocalReadAloudVoice[];
	microsoft: MicrosoftVoiceInventory | null;
	refreshingMicrosoft: boolean;
	onRefreshMicrosoft: () => void;
	ttsInfo?: TtsInfo;
	preview: PreviewControls;
	update: ReadAloudUpdater;
}) {
	if (preferences.provider === "device") {
		return <DeviceVoiceField preferences={preferences} voices={voices} />;
	}
	if (preferences.provider === "microsoft") {
		return (
			<MicrosoftVoiceFields
				preferences={preferences}
				microsoft={microsoft}
				refreshing={refreshingMicrosoft}
				onRefresh={onRefreshMicrosoft}
				update={update}
			/>
		);
	}
	if (preferences.provider === "neural") {
		return (
			<NeuralVoiceFields
				voice={voice}
				preferences={preferences}
				ttsInfo={ttsInfo}
				preview={preview}
				update={update}
			/>
		);
	}
	return null;
}

export function ReadingSpeedField({
	rate,
	update,
}: {
	rate: number;
	update: ReadAloudUpdater;
}) {
	return (
		<Field
			label="Reading speed"
			hint="applied during playback and saved for every device"
		>
			<select
				value={rate}
				onChange={(event) =>
					update({ read_aloud_rate: Number(event.target.value) })
				}
				aria-label="Read aloud speed"
				className="w-32 sm:w-48 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
			>
				{!RATE_OPTIONS.includes(rate as (typeof RATE_OPTIONS)[number]) && (
					<option value={rate}>{rate}×</option>
				)}
				{RATE_OPTIONS.map((option) => (
					<option key={option} value={option}>
						{option}×
					</option>
				))}
			</select>
		</Field>
	);
}
