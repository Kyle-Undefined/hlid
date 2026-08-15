import { useCallback, useEffect, useRef, useState } from "react";
import type { HlidConfig } from "#/config";
import { getVoiceInfoFn, type VoiceInfo } from "#/lib/serverFns/voice";
import { voiceAudioToWav } from "#/lib/voiceAudio";
import { matchesVoiceHotkey } from "#/lib/voiceHotkey";
import { readVoiceTranscriptionResponse } from "#/lib/voiceTranscription";
import type { ChatAttachment } from "#/server/protocol";

type VoicePhase =
	| "idle"
	| "starting"
	| "recording"
	| "transcribing"
	| "submitting"
	| "error";

export type CodexDictationController = {
	available: boolean;
	unavailableReason?: string;
	phase: "idle" | "starting" | "connected" | "stopping" | "error";
	error: string | null;
	start: () => Promise<void>;
	stop: () => void;
	cancel: () => void;
	clearError: () => void;
};

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
	return readVoiceTranscriptionResponse(response);
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
	codexDictation,
}: {
	config: HlidConfig["voice"];
	initialInfo: VoiceInfo;
	onTranscription: (text: string) => void;
	onAudioTurn?: (audio: Blob) => void | Promise<void>;
	codexTurnAvailable?: boolean;
	codexTurnUnavailableReason?: string;
	codexDictation?: CodexDictationController;
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
	const codexDictationRef = useRef(codexDictation);
	codexDictationRef.current = codexDictation;
	const realtimeDictation = config.input_provider === "codex_dictation";
	const presentedPhase: VoicePhase = realtimeDictation
		? codexDictation?.phase === "starting"
			? "starting"
			: codexDictation?.phase === "connected"
				? "recording"
				: codexDictation?.phase === "stopping"
					? "transcribing"
					: codexDictation?.phase === "error"
						? "error"
						: phase
		: phase;
	useEffect(() => setInfo(initialInfo), [initialInfo]);

	useEffect(() => {
		if (!config.enabled || config.input_provider !== "local") return;
		const transientUnavailable =
			info.status.state === "unavailable" &&
			(!info.status.error || info.status.error === "voice service unavailable");
		if (info.status.state !== "loading" && !transientUnavailable) return;

		let cancelled = false;
		let refreshInFlight = false;
		const refresh = () => {
			if (refreshInFlight) return;
			refreshInFlight = true;
			void getVoiceInfoFn()
				.then((next) => {
					if (!cancelled) setInfo(next);
				})
				.catch(() => {
					// Keep the transient state and retry while Hlid finishes restarting.
				})
				.finally(() => {
					refreshInFlight = false;
				});
		};
		refresh();
		const timer = setInterval(refresh, 1000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [
		config.enabled,
		config.input_provider,
		info.status.error,
		info.status.state,
	]);

	useEffect(() => {
		if (presentedPhase !== "recording") return;
		const started = Date.now();
		let stoppedAtLimit = false;
		const timer = setInterval(() => {
			const elapsed = Math.floor((Date.now() - started) / 1000);
			setSeconds(elapsed);
			if (elapsed >= config.max_recording_seconds && !stoppedAtLimit) {
				stoppedAtLimit = true;
				if (realtimeDictation) codexDictationRef.current?.stop();
				else recorderRef.current?.stop();
			}
		}, 250);
		return () => clearInterval(timer);
	}, [presentedPhase, config.max_recording_seconds, realtimeDictation]);

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
			if (realtimeDictation) {
				const controller = codexDictationRef.current;
				if (!controller?.available) {
					throw new Error(
						controller?.unavailableReason ??
							"Dictate with Codex is unavailable here",
					);
				}
				setSeconds(0);
				await controller.start();
				return;
			}
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
				void voiceAudioToWav(recorded)
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
		realtimeDictation,
	]);

	const stop = useCallback(() => {
		if (realtimeDictation) {
			codexDictationRef.current?.stop();
			return;
		}
		if (recorderRef.current?.state === "recording") recorderRef.current.stop();
	}, [realtimeDictation]);

	useEffect(() => {
		if (!config.enabled || !config.hotkey) return;
		const handleHotkey = (event: KeyboardEvent) => {
			if (event.repeat || !matchesVoiceHotkey(event, config.hotkey)) return;
			event.preventDefault();
			event.stopPropagation();
			if (presentedPhase === "starting") {
				codexDictationRef.current?.cancel();
				setSeconds(0);
				return;
			}
			if (presentedPhase === "recording") {
				stop();
				return;
			}
			const ready =
				config.input_provider === "codex_dictation"
					? Boolean(codexDictation?.available)
					: config.input_provider === "codex"
						? codexTurnAvailable &&
							!codexTurnUnavailableReason &&
							Boolean(audioCallbackRef.current)
						: info.status.state === "ready";
			if (
				presentedPhase !== "transcribing" &&
				presentedPhase !== "submitting" &&
				ready
			) {
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
		codexDictation?.available,
		codexTurnAvailable,
		codexTurnUnavailableReason,
		info.status.state,
		presentedPhase,
		start,
		stop,
	]);

	const cancel = useCallback(() => {
		if (realtimeDictation) {
			codexDictationRef.current?.cancel();
			setSeconds(0);
			return;
		}
		cancelRef.current = true;
		startGenerationRef.current++;
		startingRef.current = false;
		recorderRef.current?.stop();
	}, [realtimeDictation]);
	const refresh = useCallback(() => void getVoiceInfoFn().then(setInfo), []);
	const clearError = useCallback(() => {
		setError(null);
		setPhase("idle");
		if (realtimeDictation) codexDictationRef.current?.clearError();
	}, [realtimeDictation]);
	const unavailableReason = realtimeDictation
		? codexDictation?.unavailableReason
		: config.input_provider === "codex"
			? codexTurnUnavailableReason
			: undefined;
	const ready =
		config.enabled &&
		(realtimeDictation
			? Boolean(codexDictation?.available)
			: config.input_provider === "codex"
				? codexTurnAvailable &&
					!codexTurnUnavailableReason &&
					Boolean(onAudioTurn)
				: info.status.state === "ready");

	return {
		phase: presentedPhase,
		seconds,
		error: realtimeDictation ? (codexDictation?.error ?? error) : error,
		engine: config.input_provider,
		unavailableReason,
		ready,
		status: info.status,
		start,
		stop,
		cancel,
		refresh,
		clearError,
	};
}
