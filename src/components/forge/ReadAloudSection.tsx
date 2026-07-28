import { useEffect, useRef, useState } from "react";
import type { HlidConfig } from "#/config";
import {
	applyReadAloudSharedPreferences,
	setReadAloudPreferences,
	useLocalReadAloudVoices,
	useReadAloudPreferences,
} from "#/hooks/readAloudStore";
import type { TtsInfo } from "#/lib/serverFns/tts";
import { Field, Section } from "./fields";

const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2] as const;
const WINDOWS_VOICE_GUIDE =
	"https://support.microsoft.com/en-us/accessibility/windows/narrator/appendix-a-supported-languages-and-voices";
const CODEX_VOICES = [
	"alloy",
	"arbor",
	"ash",
	"ballad",
	"breeze",
	"cedar",
	"coral",
	"cove",
	"echo",
	"ember",
	"juniper",
	"maple",
	"marin",
	"sage",
	"shimmer",
	"sol",
	"spruce",
	"vale",
	"verse",
] as const;

type MicrosoftVoice = {
	id: string;
	name: string;
	language: string;
	gender: string;
	default: boolean;
};

type MicrosoftInventory = {
	available: boolean;
	voices: MicrosoftVoice[];
	error?: string;
};

type VoiceConfig = HlidConfig["voice"];
type SharedPatch = Pick<
	VoiceConfig,
	| "read_aloud_provider"
	| "read_aloud_voice"
	| "read_aloud_rate"
	| "codex_voice"
	| "tts_voice"
	| "tts_threads"
>;

export function ReadAloudSection({
	voice,
	onChange,
	ttsInfo,
}: {
	voice: VoiceConfig;
	onChange: (patch: Partial<VoiceConfig>) => void;
	ttsInfo?: TtsInfo;
}) {
	const browserPreferences = useReadAloudPreferences(false);
	const preferences = {
		provider: voice.read_aloud_provider,
		voiceURI: browserPreferences.voiceURI,
		microsoftVoiceId: voice.read_aloud_voice,
		neuralVoiceId: voice.tts_voice,
		rate: voice.read_aloud_rate,
		codexVoice: voice.codex_voice,
	};
	const voices = useLocalReadAloudVoices();
	const [microsoft, setMicrosoft] = useState<MicrosoftInventory | null>(null);
	const [refreshingMicrosoft, setRefreshingMicrosoft] = useState(false);
	const [previewState, setPreviewState] = useState<
		"idle" | "loading" | "playing"
	>("idle");
	const [previewError, setPreviewError] = useState<string | null>(null);
	const previewAudio = useRef<HTMLAudioElement | null>(null);
	const updateShared = (patch: Partial<SharedPatch>) => {
		const next = { ...voice, ...patch };
		onChange(patch);
		applyReadAloudSharedPreferences({
			provider: next.read_aloud_provider,
			microsoftVoiceId: next.read_aloud_voice,
			neuralVoiceId: next.tts_voice,
			rate: next.read_aloud_rate,
		});
	};
	useEffect(() => {
		applyReadAloudSharedPreferences({
			provider: voice.read_aloud_provider,
			microsoftVoiceId: voice.read_aloud_voice,
			neuralVoiceId: voice.tts_voice,
			rate: voice.read_aloud_rate,
		});
	}, [
		voice.read_aloud_provider,
		voice.read_aloud_rate,
		voice.read_aloud_voice,
		voice.tts_voice,
	]);
	useEffect(() => {
		const abort = new AbortController();
		fetch("/api/read-aloud/voices", {
			cache: "no-store",
			signal: abort.signal,
		})
			.then(async (response) => {
				if (!response.ok)
					throw new Error(`voice check failed (${response.status})`);
				return (await response.json()) as MicrosoftInventory;
			})
			.then(setMicrosoft)
			.catch((error) => {
				if (abort.signal.aborted) return;
				setMicrosoft({
					available: false,
					voices: [],
					error: error instanceof Error ? error.message : String(error),
				});
			});
		return () => abort.abort();
	}, []);
	useEffect(
		() => () => {
			previewAudio.current?.pause();
			previewAudio.current = null;
		},
		[],
	);
	const playNeuralPreview = () => {
		previewAudio.current?.pause();
		setPreviewError(null);
		setPreviewState("loading");
		const audio = new Audio("/api/read-aloud/preview");
		previewAudio.current = audio;
		audio.onplaying = () => setPreviewState("playing");
		audio.onended = () => {
			if (previewAudio.current === audio) previewAudio.current = null;
			setPreviewState("idle");
		};
		audio.onerror = () => {
			if (previewAudio.current === audio) previewAudio.current = null;
			setPreviewState("idle");
			setPreviewError("Preview could not be prepared");
		};
		void audio.play().catch((cause) => {
			if (previewAudio.current === audio) previewAudio.current = null;
			setPreviewState("idle");
			setPreviewError(
				cause instanceof Error ? cause.message : "Preview playback failed",
			);
		});
	};
	const refreshMicrosoftVoices = async () => {
		setRefreshingMicrosoft(true);
		try {
			const response = await fetch("/api/read-aloud/voices?refresh=1", {
				cache: "no-store",
			});
			if (!response.ok)
				throw new Error(`voice refresh failed (${response.status})`);
			setMicrosoft((await response.json()) as MicrosoftInventory);
		} catch (error) {
			setMicrosoft({
				available: false,
				voices: [],
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setRefreshingMicrosoft(false);
		}
	};
	const selectedVoiceURI = voices.some(
		(voice) => voice.voiceURI === preferences.voiceURI,
	)
		? preferences.voiceURI
		: "";
	const neuralModel =
		ttsInfo?.models.find((model) => model.id === voice.tts_model) ??
		ttsInfo?.models.find((model) => model.recommended);
	const neuralVoiceId =
		neuralModel?.voices.find(
			(candidate) => candidate.id === preferences.neuralVoiceId,
		)?.id ??
		neuralModel?.voices[0]?.id ??
		"";
	const neuralReady = ttsInfo?.status.state === "ready";
	return (
		<Section title="Read aloud">
			<Field label="Speech engine" hint="saved for every device">
				<select
					value={preferences.provider}
					onChange={(event) =>
						updateShared({
							read_aloud_provider:
								event.target.value === "microsoft" ||
								event.target.value === "neural" ||
								event.target.value === "codex"
									? event.target.value
									: "device",
						})
					}
					aria-label="Read aloud speech engine"
					className="w-48 sm:w-64 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
				>
					<option value="device">Device browser</option>
					<option value="microsoft" disabled={microsoft?.available === false}>
						Microsoft host
					</option>
					<option value="neural">Local neural</option>
					{(voice.codex_live_mode || preferences.provider === "codex") && (
						<option value="codex">Codex realtime · Developer Preview</option>
					)}
				</select>
			</Field>
			{preferences.provider === "device" ? (
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
						className="w-48 sm:w-64 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
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
			) : preferences.provider === "microsoft" ? (
				<>
					<Field
						label="Microsoft voice"
						hint={
							microsoft === null
								? "checking voices installed on the Hlid Windows host"
								: microsoft.available
									? "speech is generated on the Hlid host and played as audio on this device"
									: microsoft.error || "Microsoft speech is unavailable"
						}
					>
						<select
							value={preferences.microsoftVoiceId}
							onChange={(event) =>
								updateShared({ read_aloud_voice: event.target.value })
							}
							disabled={!microsoft?.available}
							aria-label="Read aloud Microsoft voice"
							className="w-48 sm:w-64 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
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
					<Field
						label="More Windows voices"
						hint="On the Windows host, add natural voices in Narrator settings or language voices in Time & language > Speech. Hlid can use voices Windows exposes to apps."
					>
						<div className="flex items-center justify-end gap-2">
							<button
								type="button"
								onClick={() =>
									window.open(
										WINDOWS_VOICE_GUIDE,
										"_blank",
										"noopener,noreferrer",
									)
								}
								className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
							>
								Setup guide
							</button>
							<button
								type="button"
								onClick={() => void refreshMicrosoftVoices()}
								disabled={refreshingMicrosoft}
								className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase disabled:opacity-40"
							>
								{refreshingMicrosoft ? "Refreshing…" : "Refresh voices"}
							</button>
						</div>
					</Field>
				</>
			) : preferences.provider === "neural" ? (
				<>
					<Field
						label="Neural voice"
						hint={
							neuralReady
								? "generated on the Hlid host with the downloaded local model"
								: ttsInfo?.status.error ||
									"download and select the neural voice model below"
						}
					>
						<select
							value={neuralVoiceId}
							onChange={(event) =>
								updateShared({ tts_voice: event.target.value })
							}
							disabled={!neuralModel?.installed}
							aria-label="Read aloud neural voice"
							className="w-48 sm:w-64 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
						>
							{neuralModel?.voices.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									{candidate.label}
								</option>
							))}
						</select>
					</Field>
					<Field
						label="Speech threads"
						hint="CPU threads reserved for local neural speech"
					>
						<select
							value={voice.tts_threads}
							onChange={(event) =>
								updateShared({ tts_threads: Number(event.target.value) })
							}
							aria-label="Neural speech threads"
							className="w-32 sm:w-48 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
						>
							{![1, 2, 4, 8, 16, 32].includes(voice.tts_threads) && (
								<option value={voice.tts_threads}>{voice.tts_threads}</option>
							)}
							{[1, 2, 4, 8, 16, 32].map((threads) => (
								<option key={threads} value={threads}>
									{threads}
								</option>
							))}
						</select>
					</Field>
					<Field
						label="Voice preview"
						hint={previewError || "plays a fixed phrase with the saved voice"}
					>
						<button
							type="button"
							onClick={playNeuralPreview}
							disabled={!neuralReady || previewState !== "idle"}
							className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase disabled:opacity-40"
						>
							{previewState === "loading"
								? "Loading…"
								: previewState === "playing"
									? "Playing…"
									: "Play preview"}
						</button>
					</Field>
				</>
			) : (
				<Field
					label="Codex voice"
					hint="used for experimental Codex read aloud and Raven Live"
				>
					<select
						value={preferences.codexVoice}
						onChange={(event) =>
							updateShared({
								codex_voice: event.target.value as VoiceConfig["codex_voice"],
							})
						}
						aria-label="Codex realtime voice"
						className="w-48 sm:w-64 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
					>
						{CODEX_VOICES.map((voice) => (
							<option key={voice} value={voice}>
								{voice}
							</option>
						))}
					</select>
				</Field>
			)}
			{preferences.provider !== "codex" && (
				<Field
					label="Reading speed"
					hint="applied during playback and saved for every device"
				>
					<select
						value={preferences.rate}
						onChange={(event) =>
							updateShared({ read_aloud_rate: Number(event.target.value) })
						}
						aria-label="Read aloud speed"
						className="w-32 sm:w-48 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
					>
						{!RATE_OPTIONS.includes(
							preferences.rate as (typeof RATE_OPTIONS)[number],
						) && <option value={preferences.rate}>{preferences.rate}×</option>}
						{RATE_OPTIONS.map((rate) => (
							<option key={rate} value={rate}>
								{rate}×
							</option>
						))}
					</select>
				</Field>
			)}
		</Section>
	);
}
