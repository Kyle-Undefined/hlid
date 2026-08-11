import type { HlidConfig } from "#/config";
import { Field, Section } from "./fields";

type VoiceConfig = HlidConfig["voice"];

const CODEX_VOICES: readonly VoiceConfig["codex_voice"][] = [
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
];

export function CodexRealtimeSection({
	voice,
	onChange,
}: {
	voice: VoiceConfig;
	onChange: (patch: Partial<VoiceConfig>) => void;
}) {
	return (
		<Section
			title="Codex realtime"
			id="forge-section-realtime-voice"
			description="Shared preview setup for two separate actions: Codex dictation and Raven Live."
		>
			<Field
				label="Developer Preview"
				hint="enables Codex dictation and shows Raven Live in native Codex chats when the account and backend support it"
			>
				<label className="flex min-h-11 cursor-pointer items-center gap-2 @lg:min-h-0">
					<input
						type="checkbox"
						checked={voice.codex_live_mode}
						onChange={(event) =>
							onChange({
								codex_live_mode: event.target.checked,
								...(!event.target.checked &&
								voice.input_provider === "codex_dictation"
									? { input_provider: "local" as const }
									: {}),
							})
						}
						className="h-3.5 w-3.5 accent-primary"
					/>
					<span className="text-xs text-muted-foreground">enabled</span>
				</label>
			</Field>
			<Field label="Shared voice" hint="used by Codex dictation and Raven Live">
				<select
					value={voice.codex_voice}
					onChange={(event) =>
						onChange({
							codex_voice: event.target.value as VoiceConfig["codex_voice"],
						})
					}
					aria-label="Codex realtime voice"
					className="min-h-11 w-full max-w-64 border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-foreground focus:border-primary/50 focus:outline-none @lg:min-h-0"
				>
					{CODEX_VOICES.map((option) => (
						<option key={option} value={option}>
							{option}
						</option>
					))}
				</select>
			</Field>
		</Section>
	);
}
