import type { HlidConfig } from "#/config";
import { modelInputAvailability } from "#/lib/providerOptions";
import type { ProviderInfo } from "#/lib/providerTypes";
import type { VoiceInfo } from "#/lib/serverFns/voice";
import { ReadAloudSection } from "./ReadAloudSection";
import { TtsModelsSection } from "./TtsModelsSection";
import {
	useTtsRuntimeState,
	useVoiceRuntimeState,
} from "./useVoiceRuntimeState";
import { VoiceInputFields } from "./VoiceInputFields";
import { WhisperModelsSection } from "./WhisperModelsSection";

export type VoiceForm = HlidConfig["voice"];

export function VoiceSection({
	voice,
	onChange,
	initialInfo,
	codexProvider,
	codexModel,
}: {
	voice: VoiceForm;
	onChange: (patch: Partial<VoiceForm>) => void;
	initialInfo: VoiceInfo;
	codexProvider?: ProviderInfo;
	codexModel?: string;
}) {
	const voiceRuntime = useVoiceRuntimeState(initialInfo, voice);
	const ttsRuntime = useTtsRuntimeState(voice);

	return (
		<div className="space-y-6">
			<ReadAloudSection
				voice={voice}
				onChange={onChange}
				ttsInfo={ttsRuntime.info}
			/>
			<TtsModelsSection
				voice={voice}
				onChange={onChange}
				info={ttsRuntime.info}
				onInfoChange={ttsRuntime.setInfo}
				busy={ttsRuntime.busy}
				onBusyChange={ttsRuntime.setBusy}
				error={ttsRuntime.error}
				onError={ttsRuntime.setError}
			/>
			<VoiceInputFields
				voice={voice}
				onChange={onChange}
				status={voiceRuntime.info.status}
				codexAudio={modelInputAvailability(codexProvider, codexModel, "audio")}
			/>
			<WhisperModelsSection
				voice={voice}
				onChange={onChange}
				info={voiceRuntime.info}
				onInfoChange={voiceRuntime.setInfo}
				busy={voiceRuntime.busy}
				onBusyChange={voiceRuntime.setBusy}
				error={voiceRuntime.error}
				onError={voiceRuntime.setError}
			/>
		</div>
	);
}
