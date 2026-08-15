import type { HlidConfig } from "#/config";
import type { TtsInfo } from "#/lib/serverFns/tts";
import type { VoiceInfo } from "#/lib/serverFns/voice";
import { Field, Section, StatusIndicator } from "./fields";

type VoiceConfig = HlidConfig["voice"];

function requirementSummary(
	voice: VoiceConfig,
	voiceStatus: VoiceInfo["status"],
	ttsInfo?: TtsInfo,
): { ok: boolean | null; label: string; detail: string } {
	if (!voice.enabled) {
		return {
			ok: false,
			label: "Local conversation unavailable",
			detail: "turn Voice on",
		};
	}
	if (voice.input_provider !== "local") {
		return {
			ok: false,
			label: "Local conversation unavailable",
			detail: "choose Dictate with Whisper",
		};
	}
	if (voice.read_aloud_provider !== "neural") {
		return {
			ok: false,
			label: "Local conversation unavailable",
			detail: "choose Local neural read aloud",
		};
	}
	if (voiceStatus.state !== "ready") {
		return {
			ok:
				voiceStatus.state === "error" || voiceStatus.state === "unavailable"
					? false
					: null,
			label: "Local conversation input is not ready",
			detail: `Whisper ${voiceStatus.state}`,
		};
	}
	const ttsState = ttsInfo?.status.state;
	if (ttsState !== "ready") {
		return {
			ok: ttsState === "error" || ttsState === "unavailable" ? false : null,
			label: "Local conversation output is not ready",
			detail: `neural speech ${ttsState ?? "checking"}`,
		};
	}
	return {
		ok: true,
		label: "Local conversation is ready",
		detail: "Whisper input · local neural output",
	};
}

export function LocalConversationSection({
	voice,
	onChange,
	voiceStatus,
	ttsInfo,
}: {
	voice: VoiceConfig;
	onChange: (patch: Partial<VoiceConfig>) => void;
	voiceStatus: VoiceInfo["status"];
	ttsInfo?: TtsInfo;
}) {
	const requirements = requirementSummary(voice, voiceStatus, ttsInfo);
	return (
		<Section
			title="Local conversation"
			id="forge-section-local-conversation"
			description="Hands-free local speech around Raven providers. Hlid listens with Whisper, reads stable assistant sections with the selected neural voice, and keeps provider-native Live modes separate."
		>
			<Field
				label="Hands-free mode"
				hint="shows a Local Conversation control in Raven; spoken follow-ups queue normally while OpenCode is working"
			>
				<label className="flex min-h-11 items-center gap-2 cursor-pointer @lg:min-h-0">
					<input
						type="checkbox"
						aria-label="Hands-free mode"
						checked={voice.local_conversation_mode}
						onChange={(event) =>
							onChange({ local_conversation_mode: event.target.checked })
						}
						className="w-3.5 h-3.5 accent-primary"
					/>
					<span className="text-xs text-muted-foreground">enabled</span>
				</label>
			</Field>
			<Field
				label="Requirements"
				hint="Local Conversation requires ready local Whisper input and a ready local neural speech model"
			>
				<StatusIndicator ok={requirements.ok} label={requirements.label}>
					<span aria-live="polite">{requirements.detail}</span>
				</StatusIndicator>
			</Field>
		</Section>
	);
}
