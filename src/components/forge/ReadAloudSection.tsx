import { useEffect, useState } from "react";
import type { HlidConfig } from "#/config";
import {
	applyReadAloudSharedPreferences,
	setReadAloudPreferences,
	useLocalReadAloudVoices,
	useReadAloudPreferences,
} from "#/hooks/readAloudStore";
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
	"read_aloud_provider" | "read_aloud_voice" | "read_aloud_rate" | "codex_voice"
>;

export function ReadAloudSection({
	voice,
	onChange,
}: {
	voice: VoiceConfig;
	onChange: (patch: Partial<VoiceConfig>) => void;
}) {
	const browserPreferences = useReadAloudPreferences(false);
	const preferences = {
		provider: voice.read_aloud_provider,
		voiceURI: browserPreferences.voiceURI,
		microsoftVoiceId: voice.read_aloud_voice,
		rate: voice.read_aloud_rate,
		codexVoice: voice.codex_voice,
	};
	const voices = useLocalReadAloudVoices();
	const [microsoft, setMicrosoft] = useState<MicrosoftInventory | null>(null);
	const [refreshingMicrosoft, setRefreshingMicrosoft] = useState(false);
	const updateShared = (patch: Partial<SharedPatch>) => {
		const next = { ...voice, ...patch };
		onChange(patch);
		applyReadAloudSharedPreferences({
			provider: next.read_aloud_provider,
			microsoftVoiceId: next.read_aloud_voice,
			rate: next.read_aloud_rate,
		});
	};
	useEffect(() => {
		applyReadAloudSharedPreferences({
			provider: voice.read_aloud_provider,
			microsoftVoiceId: voice.read_aloud_voice,
			rate: voice.read_aloud_rate,
		});
	}, [
		voice.read_aloud_provider,
		voice.read_aloud_rate,
		voice.read_aloud_voice,
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
	return (
		<Section title="Read aloud">
			<Field label="Speech engine" hint="saved for every device">
				<select
					value={preferences.provider}
					onChange={(event) =>
						updateShared({
							read_aloud_provider:
								event.target.value === "microsoft" ||
								event.target.value === "codex"
									? event.target.value
									: "device",
						})
					}
					aria-label="Read aloud speech engine"
					className="w-48 sm:w-64 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
				>
					<option value="device">Device browser</option>
					<option value="microsoft" disabled={microsoft?.available === false}>
						Microsoft host
					</option>
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
						className="w-48 sm:w-64 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
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
							className="w-48 sm:w-64 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
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
						className="w-48 sm:w-64 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
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
						className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
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
