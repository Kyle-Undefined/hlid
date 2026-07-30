import { useCallback, useEffect, useRef, useState } from "react";

type MicrosoftVoice = {
	id: string;
	name: string;
	language: string;
	gender: string;
	default: boolean;
};

export type MicrosoftVoiceInventory = {
	available: boolean;
	voices: MicrosoftVoice[];
	error?: string;
};

type NeuralPreviewState = "idle" | "loading" | "playing";

function unavailableMicrosoftInventory(
	cause: unknown,
): MicrosoftVoiceInventory {
	return {
		available: false,
		voices: [],
		error: cause instanceof Error ? cause.message : String(cause),
	};
}

async function requestMicrosoftVoices(
	refresh: boolean,
	signal?: AbortSignal,
): Promise<MicrosoftVoiceInventory> {
	const response = await fetch(
		refresh ? "/api/read-aloud/voices?refresh=1" : "/api/read-aloud/voices",
		{ cache: "no-store", ...(signal ? { signal } : {}) },
	);
	if (!response.ok) {
		throw new Error(
			`voice ${refresh ? "refresh" : "check"} failed (${response.status})`,
		);
	}
	return (await response.json()) as MicrosoftVoiceInventory;
}

export function useMicrosoftVoiceInventory() {
	const [inventory, setInventory] = useState<MicrosoftVoiceInventory | null>(
		null,
	);
	const [refreshing, setRefreshing] = useState(false);
	useEffect(() => {
		const abort = new AbortController();
		void requestMicrosoftVoices(false, abort.signal)
			.then(setInventory)
			.catch((cause) => {
				if (!abort.signal.aborted) {
					setInventory(unavailableMicrosoftInventory(cause));
				}
			});
		return () => abort.abort();
	}, []);
	const refresh = useCallback(async () => {
		setRefreshing(true);
		try {
			setInventory(await requestMicrosoftVoices(true));
		} catch (cause) {
			setInventory(unavailableMicrosoftInventory(cause));
		} finally {
			setRefreshing(false);
		}
	}, []);
	return { inventory, refreshing, refresh };
}

export function useNeuralVoicePreview() {
	const [state, setState] = useState<NeuralPreviewState>("idle");
	const [error, setError] = useState<string | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	useEffect(
		() => () => {
			audioRef.current?.pause();
			audioRef.current = null;
		},
		[],
	);
	const play = useCallback(() => {
		audioRef.current?.pause();
		setError(null);
		setState("loading");
		const audio = new Audio("/api/read-aloud/preview");
		audioRef.current = audio;
		audio.onplaying = () => setState("playing");
		audio.onended = () => finishNeuralPreview(audioRef, audio, setState);
		audio.onerror = () => {
			finishNeuralPreview(audioRef, audio, setState);
			setError("Preview could not be prepared");
		};
		void audio.play().catch((cause) => {
			finishNeuralPreview(audioRef, audio, setState);
			setError(
				cause instanceof Error ? cause.message : "Preview playback failed",
			);
		});
	}, []);
	return { state, error, play };
}

function finishNeuralPreview(
	audioRef: { current: HTMLAudioElement | null },
	audio: HTMLAudioElement,
	setState: (state: NeuralPreviewState) => void,
): void {
	if (audioRef.current === audio) audioRef.current = null;
	setState("idle");
}
