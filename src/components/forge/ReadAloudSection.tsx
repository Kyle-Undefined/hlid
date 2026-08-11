import { useEffect } from "react";
import type { HlidConfig } from "#/config";
import {
	applyReadAloudSharedPreferences,
	useLocalReadAloudVoices,
	useReadAloudPreferences,
} from "#/hooks/readAloudStore";
import type { TtsInfo } from "#/lib/serverFns/tts";
import { Section } from "./fields";
import {
	ReadAloudProviderFields,
	type ReadAloudUpdater,
	type ReadAloudViewPreferences,
	ReadingSpeedField,
	SpeechEngineField,
} from "./ReadAloudProviderFields";
import {
	useMicrosoftVoiceInventory,
	useNeuralVoicePreview,
} from "./useReadAloudControls";

type VoiceConfig = HlidConfig["voice"];

function syncSharedPreferences(voice: VoiceConfig): void {
	applyReadAloudSharedPreferences({
		provider: voice.read_aloud_provider,
		microsoftVoiceId: voice.read_aloud_voice,
		neuralVoiceId: voice.tts_voice,
		rate: voice.read_aloud_rate,
	});
}

function useForgeReadAloudPreferences(
	voice: VoiceConfig,
	onChange: (patch: Partial<VoiceConfig>) => void,
): {
	preferences: ReadAloudViewPreferences;
	update: ReadAloudUpdater;
} {
	const browserPreferences = useReadAloudPreferences(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: these saved fields intentionally trigger a shared runtime sync
	useEffect(
		() => syncSharedPreferences(voice),
		[
			voice.read_aloud_provider,
			voice.read_aloud_rate,
			voice.read_aloud_voice,
			voice.tts_voice,
		],
	);
	const update = (patch: Partial<VoiceConfig>) => {
		const next = { ...voice, ...patch };
		onChange(patch);
		syncSharedPreferences(next);
	};
	return {
		preferences: {
			provider:
				voice.read_aloud_provider === "codex"
					? "device"
					: voice.read_aloud_provider,
			voiceURI: browserPreferences.voiceURI,
			microsoftVoiceId: voice.read_aloud_voice,
			neuralVoiceId: voice.tts_voice,
			rate: voice.read_aloud_rate,
		},
		update,
	};
}

export function ReadAloudSection({
	voice,
	onChange,
	ttsInfo,
}: {
	voice: VoiceConfig;
	onChange: (patch: Partial<VoiceConfig>) => void;
	ttsInfo?: TtsInfo;
}) {
	const { preferences, update } = useForgeReadAloudPreferences(voice, onChange);
	const voices = useLocalReadAloudVoices();
	const microsoft = useMicrosoftVoiceInventory();
	const preview = useNeuralVoicePreview();
	return (
		<Section title="Read aloud" id="forge-section-read-aloud">
			<SpeechEngineField
				preferences={preferences}
				microsoft={microsoft.inventory}
				update={update}
			/>
			<ReadAloudProviderFields
				voice={voice}
				preferences={preferences}
				voices={voices}
				microsoft={microsoft.inventory}
				refreshingMicrosoft={microsoft.refreshing}
				onRefreshMicrosoft={() => void microsoft.refresh()}
				ttsInfo={ttsInfo}
				preview={preview}
				update={update}
			/>
			<ReadingSpeedField rate={preferences.rate} update={update} />
		</Section>
	);
}
