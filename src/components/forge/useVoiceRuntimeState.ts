import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { HlidConfig } from "#/config";
import {
	getTtsInfoFn,
	syncTtsConfigFn,
	type TtsInfo,
} from "#/lib/serverFns/tts";
import { getVoiceInfoFn, type VoiceInfo } from "#/lib/serverFns/voice";

const UNAVAILABLE_TTS_INFO: TtsInfo = {
	status: {
		state: "unavailable",
		model: "",
		error: "local neural speech service unavailable",
	},
	models: [],
};

type RuntimeInfo = {
	status: {
		state: string;
		error?: unknown;
		download?: unknown;
	};
	models: Array<{ id: string; installed: boolean }>;
};

function useRuntimePolling<T extends RuntimeInfo>(
	info: T,
	busy: string | null,
	load: () => Promise<T>,
	setInfo: Dispatch<SetStateAction<T>>,
	setBusy: Dispatch<SetStateAction<string | null>>,
): void {
	useEffect(() => {
		if (!busy && !info.status.download && info.status.state !== "loading")
			return;
		const timer = setInterval(
			() =>
				void load().then((next) => {
					setInfo(next);
					if (
						busy &&
						!next.status.download &&
						(next.status.error ||
							next.models.some((model) => model.id === busy && model.installed))
					) {
						setBusy(null);
					}
				}),
			750,
		);
		return () => clearInterval(timer);
	}, [busy, info.status.download, info.status.state, load, setBusy, setInfo]);
}

export function useVoiceRuntimeState(
	initialInfo: VoiceInfo,
	voice: HlidConfig["voice"],
) {
	const [info, setInfo] = useState(initialInfo);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useRuntimePolling(info, busy, getVoiceInfoFn, setInfo, setBusy);
	// Refresh after the auto-saved config reaches the server and starts a model swap.
	// biome-ignore lint/correctness/useExhaustiveDependencies: voice selection intentionally triggers this status refresh
	useEffect(() => {
		const timer = setTimeout(() => void getVoiceInfoFn().then(setInfo), 1200);
		return () => clearTimeout(timer);
	}, [voice.enabled, voice.model, voice.threads, voice.acceleration]);
	return { info, setInfo, busy, setBusy, error, setError };
}

export function useTtsRuntimeState(voice: HlidConfig["voice"]) {
	const [info, setInfo] = useState<TtsInfo>(UNAVAILABLE_TTS_INFO);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		void getTtsInfoFn().then(setInfo);
	}, []);
	useRuntimePolling(info, busy, getTtsInfoFn, setInfo, setBusy);
	// Refresh after the auto-saved TTS settings reach the server.
	// biome-ignore lint/correctness/useExhaustiveDependencies: these saved fields intentionally trigger a runtime sync
	useEffect(() => {
		const timer = setTimeout(
			() =>
				void syncTtsConfigFn()
					.then(() => getTtsInfoFn())
					.then(setInfo)
					.catch((cause) =>
						setError(cause instanceof Error ? cause.message : String(cause)),
					),
			1200,
		);
		return () => clearTimeout(timer);
	}, [voice.read_aloud_provider, voice.tts_model, voice.tts_threads]);
	return { info, setInfo, busy, setBusy, error, setError };
}
