import { useCallback, useEffect, useRef, useState } from "react";
import type { HlidConfig } from "#/config";
import { getVoiceInfoFn, type VoiceInfo } from "#/lib/serverFns/voice";
import { matchesVoiceHotkey } from "#/lib/voiceHotkey";

type VoicePhase = "idle" | "recording" | "transcribing" | "error";

function writeAscii(view: DataView, offset: number, value: string): void {
	for (let i = 0; i < value.length; i++)
		view.setUint8(offset + i, value.charCodeAt(i));
}

async function toWav(blob: Blob): Promise<Blob> {
	const context = new AudioContext();
	try {
		const decoded = await context.decodeAudioData(await blob.arrayBuffer());
		const targetRate = 16_000;
		const frames = Math.ceil(decoded.duration * targetRate);
		const offline = new OfflineAudioContext(1, frames, targetRate);
		const source = offline.createBufferSource();
		source.buffer = decoded;
		source.connect(offline.destination);
		source.start();
		const rendered = await offline.startRendering();
		const samples = rendered.getChannelData(0);
		const buffer = new ArrayBuffer(44 + samples.length * 2);
		const view = new DataView(buffer);
		writeAscii(view, 0, "RIFF");
		view.setUint32(4, 36 + samples.length * 2, true);
		writeAscii(view, 8, "WAVEfmt ");
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, targetRate, true);
		view.setUint32(28, targetRate * 2, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		writeAscii(view, 36, "data");
		view.setUint32(40, samples.length * 2, true);
		for (let i = 0; i < samples.length; i++) {
			const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
			view.setInt16(
				44 + i * 2,
				value < 0 ? value * 0x8000 : value * 0x7fff,
				true,
			);
		}
		return new Blob([buffer], { type: "audio/wav" });
	} finally {
		void context.close();
	}
}

async function transcribe(
	blob: Blob,
	language: string,
): Promise<{ text: string }> {
	const form = new FormData();
	form.set("audio", blob, "recording.wav");
	form.set("language", language);
	const response = await fetch("/api/voice/transcribe", {
		method: "POST",
		body: form,
		signal: AbortSignal.timeout(65_000),
	});
	const raw = await response.text();
	let result: { text?: string; error?: string } = {};
	try {
		result = JSON.parse(raw) as typeof result;
	} catch {
		if (!response.ok) result.error = raw || "voice service did not respond";
	}
	if (!response.ok) throw new Error(result.error ?? "transcription failed");
	return { text: result.text ?? "" };
}

export function useVoiceInput({
	config,
	initialInfo,
	onTranscription,
}: {
	config: HlidConfig["voice"];
	initialInfo: VoiceInfo;
	onTranscription: (text: string) => void;
}) {
	const [info, setInfo] = useState(initialInfo);
	const [phase, setPhase] = useState<VoicePhase>("idle");
	const [seconds, setSeconds] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const cancelRef = useRef(false);
	const startGenerationRef = useRef(0);
	const startingRef = useRef(false);
	const mountedRef = useRef(true);
	const callbackRef = useRef(onTranscription);
	callbackRef.current = onTranscription;
	useEffect(() => setInfo(initialInfo), [initialInfo]);

	useEffect(() => {
		if (info.status.state !== "loading") return;
		const timer = setInterval(() => void getVoiceInfoFn().then(setInfo), 1000);
		return () => clearInterval(timer);
	}, [info.status.state]);

	useEffect(() => {
		if (phase !== "recording") return;
		const started = Date.now();
		const timer = setInterval(() => {
			const elapsed = Math.floor((Date.now() - started) / 1000);
			setSeconds(elapsed);
			if (elapsed >= config.max_recording_seconds) recorderRef.current?.stop();
		}, 250);
		return () => clearInterval(timer);
	}, [phase, config.max_recording_seconds]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			startGenerationRef.current++;
			startingRef.current = false;
			recorderRef.current?.stop();
			streamRef.current?.getTracks().forEach((track) => {
				track.stop();
			});
		};
	}, []);

	const start = useCallback(async () => {
		if (startingRef.current || recorderRef.current?.state === "recording")
			return;
		startingRef.current = true;
		const generation = ++startGenerationRef.current;
		setError(null);
		cancelRef.current = false;
		try {
			if (!navigator.mediaDevices?.getUserMedia)
				throw new Error("microphone access requires HTTPS or localhost");
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
				},
			});
			if (!mountedRef.current || generation !== startGenerationRef.current) {
				stream.getTracks().forEach((track) => {
					track.stop();
				});
				return;
			}
			streamRef.current = stream;
			chunksRef.current = [];
			const recorder = new MediaRecorder(stream);
			recorderRef.current = recorder;
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunksRef.current.push(event.data);
			};
			recorder.onstop = () => {
				stream.getTracks().forEach((track) => {
					track.stop();
				});
				streamRef.current = null;
				if (cancelRef.current) {
					setPhase("idle");
					setSeconds(0);
					return;
				}
				setPhase("transcribing");
				const recorded = new Blob(chunksRef.current, {
					type: recorder.mimeType,
				});
				void toWav(recorded)
					.then((audio) => transcribe(audio, config.language))
					.then((result) => {
						if (result.text) callbackRef.current(result.text);
						setPhase("idle");
						setSeconds(0);
					})
					.catch((e) => {
						setError(e instanceof Error ? e.message : "transcription failed");
						setPhase("error");
					});
			};
			recorder.start(250);
			setSeconds(0);
			setPhase("recording");
		} catch (e) {
			if (!mountedRef.current || generation !== startGenerationRef.current)
				return;
			setError(e instanceof Error ? e.message : "microphone unavailable");
			setPhase("error");
		} finally {
			if (generation === startGenerationRef.current)
				startingRef.current = false;
		}
	}, [config.language]);

	const stop = useCallback(
		() =>
			recorderRef.current?.state === "recording" && recorderRef.current.stop(),
		[],
	);

	useEffect(() => {
		if (!config.enabled || !config.hotkey) return;
		const handleHotkey = (event: KeyboardEvent) => {
			if (event.repeat || !matchesVoiceHotkey(event, config.hotkey)) return;
			event.preventDefault();
			event.stopPropagation();
			if (phase === "recording") {
				stop();
				return;
			}
			if (phase !== "transcribing" && info.status.state === "ready") {
				void start();
			}
		};
		window.addEventListener("keydown", handleHotkey, { capture: true });
		return () =>
			window.removeEventListener("keydown", handleHotkey, { capture: true });
	}, [config.enabled, config.hotkey, info.status.state, phase, start, stop]);

	const cancel = useCallback(() => {
		cancelRef.current = true;
		startGenerationRef.current++;
		startingRef.current = false;
		recorderRef.current?.stop();
	}, []);
	const refresh = useCallback(() => void getVoiceInfoFn().then(setInfo), []);
	const clearError = useCallback(() => {
		setError(null);
		setPhase("idle");
	}, []);

	return {
		phase,
		seconds,
		error,
		ready: config.enabled && info.status.state === "ready",
		status: info.status,
		start,
		stop,
		cancel,
		refresh,
		clearError,
	};
}
