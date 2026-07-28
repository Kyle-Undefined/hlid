import { useEffect, useState } from "react";
import type { HlidConfig } from "#/config";
import { modelInputAvailability } from "#/lib/providerOptions";
import type { ProviderInfo } from "#/lib/providerTypes";
import {
	getTtsInfoFn,
	syncTtsConfigFn,
	type TtsInfo,
} from "#/lib/serverFns/tts";
import { getVoiceInfoFn, type VoiceInfo } from "#/lib/serverFns/voice";
import { ReadAloudSection } from "./ReadAloudSection";
import { TtsModelsSection } from "./TtsModelsSection";
import { VoiceInputFields } from "./VoiceInputFields";
import { WhisperModelsSection } from "./WhisperModelsSection";

export type VoiceForm = HlidConfig["voice"];

const UNAVAILABLE_TTS_INFO: TtsInfo = {
	status: {
		state: "unavailable",
		model: "",
		error: "local neural speech service unavailable",
	},
	models: [],
};

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
	const [info, setInfo] = useState(initialInfo);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [ttsInfo, setTtsInfo] = useState<TtsInfo>(UNAVAILABLE_TTS_INFO);
	const [ttsBusy, setTtsBusy] = useState<string | null>(null);
	const [ttsError, setTtsError] = useState<string | null>(null);

	useEffect(() => {
		void getTtsInfoFn().then(setTtsInfo);
	}, []);

	useEffect(() => {
		if (!busy && !info.status.download && info.status.state !== "loading")
			return;
		const timer = setInterval(
			() =>
				void getVoiceInfoFn().then((next) => {
					setInfo(next);
					if (
						busy &&
						!next.status.download &&
						(next.status.error ||
							next.models.some((model) => model.id === busy && model.installed))
					)
						setBusy(null);
				}),
			750,
		);
		return () => clearInterval(timer);
	}, [busy, info.status.download, info.status.state]);

	useEffect(() => {
		if (
			!ttsBusy &&
			!ttsInfo.status.download &&
			ttsInfo.status.state !== "loading"
		)
			return;
		const timer = setInterval(
			() =>
				void getTtsInfoFn().then((next) => {
					setTtsInfo(next);
					if (
						ttsBusy &&
						!next.status.download &&
						(next.status.error ||
							next.models.some(
								(model) => model.id === ttsBusy && model.installed,
							))
					)
						setTtsBusy(null);
				}),
			750,
		);
		return () => clearInterval(timer);
	}, [ttsBusy, ttsInfo.status.download, ttsInfo.status.state]);

	// Refresh after the auto-saved config reaches the server and starts a model swap.
	// biome-ignore lint/correctness/useExhaustiveDependencies: voice selection intentionally triggers this status refresh
	useEffect(() => {
		const timer = setTimeout(() => void getVoiceInfoFn().then(setInfo), 1200);
		return () => clearTimeout(timer);
	}, [voice.enabled, voice.model, voice.threads, voice.acceleration]);

	// Refresh after the auto-saved TTS settings reach the server.
	// biome-ignore lint/correctness/useExhaustiveDependencies: these saved fields intentionally trigger a runtime sync
	useEffect(() => {
		const timer = setTimeout(
			() =>
				void syncTtsConfigFn()
					.then(() => getTtsInfoFn())
					.then(setTtsInfo)
					.catch((cause) =>
						setTtsError(cause instanceof Error ? cause.message : String(cause)),
					),
			1200,
		);
		return () => clearTimeout(timer);
	}, [voice.read_aloud_provider, voice.tts_model, voice.tts_threads]);

	return (
		<div className="space-y-6">
			<ReadAloudSection voice={voice} onChange={onChange} ttsInfo={ttsInfo} />
			<TtsModelsSection
				voice={voice}
				onChange={onChange}
				info={ttsInfo}
				onInfoChange={setTtsInfo}
				busy={ttsBusy}
				onBusyChange={setTtsBusy}
				error={ttsError}
				onError={setTtsError}
			/>
			<VoiceInputFields
				voice={voice}
				onChange={onChange}
				status={info.status}
				codexAudio={modelInputAvailability(codexProvider, codexModel, "audio")}
			/>
			<WhisperModelsSection
				voice={voice}
				onChange={onChange}
				info={info}
				onInfoChange={setInfo}
				busy={busy}
				onBusyChange={setBusy}
				error={error}
				onError={setError}
			/>
		</div>
	);
}
