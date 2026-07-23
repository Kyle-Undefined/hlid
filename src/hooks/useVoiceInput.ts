import { useCallback, useEffect, useRef, useState } from "react";
import type { HlidConfig } from "#/config";
import { getVoiceInfoFn, type VoiceInfo } from "#/lib/serverFns/voice";
import { matchesVoiceHotkey } from "#/lib/voiceHotkey";
import type { ChatAttachment } from "#/server/protocol";

type VoicePhase =
	| "idle"
	| "recording"
	| "transcribing"
	| "submitting"
	| "error";

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
	return readTranscriptionResponse(response);
}

export async function readTranscriptionResponse(
	response: Response,
): Promise<{ text: string }> {
	const raw = await response.text();
	let result: { text?: string; error?: string } = {};
	try {
		result = JSON.parse(raw) as typeof result;
	} catch {}
	if (!response.ok) {
		if (result.error) throw new Error(result.error);
		if (response.status === 404) {
			throw new Error(
				"Voice transcription is unavailable in this Hlid build. Restart Hlid after installing the latest build.",
			);
		}
		throw new Error(
			`voice service returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
		);
	}
	if (!raw || typeof result.text !== "string") {
		throw new Error("voice service returned an invalid response");
	}
	return { text: result.text ?? "" };
}

export async function uploadVoiceRecording(
	blob: Blob,
	{
		sessionId,
		agentCwd,
	}: {
		sessionId: string;
		agentCwd?: string | null;
	},
): Promise<ChatAttachment> {
	const form = new FormData();
	form.set("file", blob, "voice-message.wav");
	form.set("kind", "ephemeral");
	form.set("purpose", "voice");
	form.set("session_id", sessionId);
	if (agentCwd) form.set("agent_cwd", agentCwd);
	const response = await fetch("/api/attachments/upload", {
		method: "POST",
		body: form,
		signal: AbortSignal.timeout(65_000),
	});
	const raw = await response.text();
	let result: Partial<ChatAttachment> & { error?: string; mime?: string } = {};
	try {
		result = JSON.parse(raw) as typeof result;
	} catch {}
	if (!response.ok) {
		throw new Error(
			(result.error
				? `${result.error}${result.mime ? ` (${result.mime})` : ""}`
				: undefined) ??
				`voice upload returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
		);
	}
	if (
		typeof result.id !== "string" ||
		typeof result.path !== "string" ||
		typeof result.filename !== "string" ||
		typeof result.mime !== "string" ||
		typeof result.kind !== "string"
	) {
		throw new Error("voice upload returned an invalid response");
	}
	return {
		id: result.id,
		path: result.path,
		filename: result.filename,
		mime: result.mime,
		kind: result.kind,
	};
}

export function useVoiceInput({
	config,
	initialInfo,
	onTranscription,
	onAudioTurn,
	codexTurnAvailable = false,
	codexTurnUnavailableReason,
}: {
	config: HlidConfig["voice"];
	initialInfo: VoiceInfo;
	onTranscription: (text: string) => void;
	onAudioTurn?: (audio: Blob) => void | Promise<void>;
	codexTurnAvailable?: boolean;
	codexTurnUnavailableReason?: string;
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
	const audioCallbackRef = useRef(onAudioTurn);
	audioCallbackRef.current = onAudioTurn;
	useEffect(() => setInfo(initialInfo), [initialInfo]);

	useEffect(() => {
		if (config.input_provider !== "local") return;
		if (info.status.state !== "loading") return;
		const timer = setInterval(() => void getVoiceInfoFn().then(setInfo), 1000);
		return () => clearInterval(timer);
	}, [config.input_provider, info.status.state]);

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
			if (
				config.input_provider === "codex" &&
				(!codexTurnAvailable || codexTurnUnavailableReason)
			) {
				throw new Error(
					codexTurnUnavailableReason ?? "Talk to Codex is unavailable here",
				);
			}
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
				const inputProvider = config.input_provider;
				setPhase(inputProvider === "local" ? "transcribing" : "submitting");
				const recorded = new Blob(chunksRef.current, {
					type: recorder.mimeType,
				});
				void toWav(recorded)
					.then(async (audio) => {
						if (inputProvider === "local") {
							const result = await transcribe(audio, config.language);
							if (result.text) callbackRef.current(result.text);
							return;
						}
						if (!audioCallbackRef.current) {
							throw new Error("Talk to Codex is unavailable here");
						}
						await audioCallbackRef.current(audio);
					})
					.then(() => {
						if (
							!mountedRef.current ||
							generation !== startGenerationRef.current
						)
							return;
						setPhase("idle");
						setSeconds(0);
					})
					.catch((e) => {
						if (
							!mountedRef.current ||
							generation !== startGenerationRef.current
						)
							return;
						setError(
							e instanceof Error
								? e.message
								: inputProvider === "local"
									? "transcription failed"
									: "voice message failed",
						);
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
	}, [
		codexTurnAvailable,
		codexTurnUnavailableReason,
		config.input_provider,
		config.language,
	]);

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
			const ready =
				config.input_provider === "codex"
					? codexTurnAvailable &&
						!codexTurnUnavailableReason &&
						Boolean(audioCallbackRef.current)
					: info.status.state === "ready";
			if (phase !== "transcribing" && phase !== "submitting" && ready) {
				void start();
			}
		};
		window.addEventListener("keydown", handleHotkey, { capture: true });
		return () =>
			window.removeEventListener("keydown", handleHotkey, { capture: true });
	}, [
		config.enabled,
		config.hotkey,
		config.input_provider,
		codexTurnAvailable,
		codexTurnUnavailableReason,
		info.status.state,
		phase,
		start,
		stop,
	]);

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
		engine: config.input_provider,
		unavailableReason:
			config.input_provider === "codex"
				? codexTurnUnavailableReason
				: undefined,
		ready:
			config.enabled &&
			(config.input_provider === "codex"
				? codexTurnAvailable &&
					!codexTurnUnavailableReason &&
					Boolean(onAudioTurn)
				: info.status.state === "ready"),
		status: info.status,
		start,
		stop,
		cancel,
		refresh,
		clearError,
	};
}
