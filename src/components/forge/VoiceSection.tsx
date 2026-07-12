import { useEffect, useState } from "react";
import type { HlidConfig } from "#/config";
import { getVoiceInfoFn, type VoiceInfo } from "#/lib/serverFns/voice";
import { VoiceInputFields } from "./VoiceInputFields";
import { WhisperModelsSection } from "./WhisperModelsSection";

export type VoiceForm = HlidConfig["voice"];

export function VoiceSection({
	voice,
	onChange,
	initialInfo,
}: {
	voice: VoiceForm;
	onChange: (patch: Partial<VoiceForm>) => void;
	initialInfo: VoiceInfo;
}) {
	const [info, setInfo] = useState(initialInfo);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

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

	// Refresh after the auto-saved config reaches the server and starts a model swap.
	// biome-ignore lint/correctness/useExhaustiveDependencies: voice selection intentionally triggers this status refresh
	useEffect(() => {
		const timer = setTimeout(() => void getVoiceInfoFn().then(setInfo), 1200);
		return () => clearTimeout(timer);
	}, [voice.enabled, voice.model]);

	return (
		<div className="space-y-6">
			<VoiceInputFields
				voice={voice}
				onChange={onChange}
				status={info.status}
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
