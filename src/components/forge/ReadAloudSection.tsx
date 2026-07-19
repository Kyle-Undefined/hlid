import {
	setReadAloudPreferences,
	useLocalReadAloudVoices,
	useReadAloudPreferences,
} from "#/hooks/readAloudStore";
import { Field, Section } from "./fields";

const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2] as const;

export function ReadAloudSection() {
	const preferences = useReadAloudPreferences();
	const voices = useLocalReadAloudVoices();
	const selectedVoiceURI = voices.some(
		(voice) => voice.voiceURI === preferences.voiceURI,
	)
		? preferences.voiceURI
		: "";
	return (
		<Section title="Read aloud">
			<Field
				label="Device voice"
				hint="Automatic uses the browser's locally reported default; only local alternatives are shown"
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
			<Field
				label="Reading speed"
				hint="saved only in this browser, alongside the selected voice"
			>
				<select
					value={preferences.rate}
					onChange={(event) =>
						setReadAloudPreferences({ rate: Number(event.target.value) })
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
		</Section>
	);
}
