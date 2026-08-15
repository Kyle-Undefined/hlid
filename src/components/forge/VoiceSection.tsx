import type { HlidConfig } from "#/config";
import {
	codexRealtimeAvailability,
	modelInputAvailability,
	providerAdvertisesInput,
} from "#/lib/providerOptions";
import type { ProviderInfo } from "#/lib/providerTypes";
import type { VoiceInfo } from "#/lib/serverFns/voice";
import { CodexRealtimeSection } from "./CodexRealtimeSection";
import { LocalConversationSection } from "./LocalConversationSection";
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
	const codexAudio = modelInputAvailability(codexProvider, codexModel, "audio");
	const codexAudioCatalog = providerAdvertisesInput(codexProvider, "audio");
	const codexDictation = codexRealtimeAvailability(
		voice.codex_live_mode,
		codexProvider,
		voiceRuntime.info.codexRealtimeBackend,
	);

	return (
		<div className="space-y-6">
			<ReadAloudSection
				voice={voice}
				onChange={onChange}
				ttsInfo={ttsRuntime.info}
			/>
			<LocalConversationSection
				voice={voice}
				onChange={onChange}
				voiceStatus={voiceRuntime.info.status}
				ttsInfo={ttsRuntime.info}
			/>
			<CodexRealtimeSection voice={voice} onChange={onChange} />
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
				codexAudio={codexAudio}
				codexAudioCatalog={codexAudioCatalog}
				codexDictation={codexDictation}
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
