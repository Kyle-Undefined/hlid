import { useCallback, useEffect, useRef, useState } from "react";
import {
	calculateAudioRms,
	type LocalConversationVadConfig,
	LocalConversationVadDetector,
	localConversationAudioToWav,
	transcribeLocalConversationAudio,
} from "#/lib/localConversationAudio";

export type LocalConversationMicPhase =
	| "idle"
	| "starting"
	| "listening"
	| "capturing"
	| "muted"
	| "error";

export type UseLocalConversationMicOptions = {
	language: string;
	onTranscription: (text: string) => void | Promise<void>;
	/** Fires when VAD opens an utterance, before its first transcription. */
	onSpeechStart?: () => void;
	/** Fires whenever the current VAD utterance closes or is discarded. */
	onSpeechEnd?: () => void;
	/**
	 * Fires after terminal recorder data is finalized and no adjacent utterance
	 * remains. Teardown also settles any active capture after discarding it.
	 */
	onSpeechSettled?: () => void;
	/** Software gate used while Hlid's own speaker audio is playing. */
	shouldSuppressInput?: () => boolean;
	maxUtteranceSeconds?: number;
	maxPendingTranscriptions?: number;
	vad?: Partial<LocalConversationVadConfig>;
};

export type LocalConversationMicController = {
	phase: LocalConversationMicPhase;
	error: string | null;
	active: boolean;
	isListening: boolean;
	isCapturing: boolean;
	isMuted: boolean;
	pendingTranscriptions: number;
	start: () => Promise<void>;
	stop: () => void;
	setMuted: (
		muted: boolean,
		options?: { finishCurrentUtterance?: boolean },
	) => void;
	toggleMuted: () => void;
	/** Re-evaluate shouldSuppressInput immediately instead of waiting for VAD. */
	refreshInputSuppression: () => void;
	clearError: () => void;
};

type ActiveCapture = {
	recorder: MediaRecorder;
	chunks: Blob[];
	startedAt: number;
	generation: number;
	discard: boolean;
	/** Preserve the recorder's final buffered chunk after an explicit user mute. */
	finishOnMute: boolean;
	closing: boolean;
	finalizeTimer: number | null;
	maxTimer: number | null;
};

type ClosingSpeechState = "none" | "active" | "complete";

const DEFAULT_MAX_UTTERANCE_SECONDS = 45;
const DEFAULT_MAX_PENDING_TRANSCRIPTIONS = 3;
const TRANSCRIPTION_TIMEOUT_MS = 65_000;
const RECORDER_TIMESLICE_MS = 250;
const IDLE_RECORDER_ROTATION_MS = 10_000;
const ANALYSIS_INTERVAL_MS = 40;

function asErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function closeAudioContext(context: AudioContext | null): void {
	if (!context || context.state === "closed") return;
	try {
		void context.close().catch(() => {});
	} catch {}
}

function preferredRecorderOptions(): MediaRecorderOptions | undefined {
	const supported = MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus");
	return supported ? { mimeType: "audio/webm;codecs=opus" } : undefined;
}

export function useLocalConversationMic({
	language,
	onTranscription,
	onSpeechStart,
	onSpeechEnd,
	onSpeechSettled,
	shouldSuppressInput,
	maxUtteranceSeconds = DEFAULT_MAX_UTTERANCE_SECONDS,
	maxPendingTranscriptions = DEFAULT_MAX_PENDING_TRANSCRIPTIONS,
	vad,
}: UseLocalConversationMicOptions): LocalConversationMicController {
	const [phase, setPhase] = useState<LocalConversationMicPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [isMuted, setIsMuted] = useState(false);
	const [pendingTranscriptions, setPendingTranscriptions] = useState(0);
	const mountedRef = useRef(true);
	const generationRef = useRef(0);
	const startingRef = useRef<Promise<void> | null>(null);
	const activeRef = useRef(false);
	const mutedRef = useRef(false);
	const streamRef = useRef<MediaStream | null>(null);
	const contextRef = useRef<AudioContext | null>(null);
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const samplesRef = useRef<Float32Array<ArrayBuffer> | null>(null);
	const analysisTimerRef = useRef<number | null>(null);
	const detectorRef = useRef<LocalConversationVadDetector | null>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const restartRecorderRef = useRef<(generation: number) => void>(() => {});
	const startSuccessorRecorderRef = useRef<(generation: number) => void>(
		() => {},
	);
	const recorderRotationTimerRef = useRef<number | null>(null);
	const captureRef = useRef<ActiveCapture | null>(null);
	const closingSpeechStateRef = useRef<ClosingSpeechState>("none");
	const promoteClosingSpeechRef = useRef<
		(generation: number, state: ClosingSpeechState) => boolean
	>(() => false);
	const preRollRef = useRef<Blob[]>([]);
	const lastLevelRef = useRef(0);
	const inputSuppressedRef = useRef(false);
	const pendingRef = useRef(0);
	const transcriptionTailRef = useRef<Promise<void>>(Promise.resolve());
	const transcriptionAbortRef = useRef(new Set<AbortController>());
	const suppressedUntilSilenceRef = useRef(false);
	const callbackRef = useRef(onTranscription);
	const speechStartRef = useRef(onSpeechStart);
	const speechEndRef = useRef(onSpeechEnd);
	const speechSettledRef = useRef(onSpeechSettled);
	const shouldSuppressInputRef = useRef(shouldSuppressInput);
	const languageRef = useRef(language);
	const maxUtteranceMsRef = useRef(Math.max(1, maxUtteranceSeconds) * 1_000);
	const maxPendingRef = useRef(Math.max(1, maxPendingTranscriptions));
	callbackRef.current = onTranscription;
	speechStartRef.current = onSpeechStart;
	speechEndRef.current = onSpeechEnd;
	speechSettledRef.current = onSpeechSettled;
	shouldSuppressInputRef.current = shouldSuppressInput;
	languageRef.current = language;
	maxUtteranceMsRef.current = Math.max(1, maxUtteranceSeconds) * 1_000;
	maxPendingRef.current = Math.max(1, maxPendingTranscriptions);

	const reportRuntimeError = useCallback((message: string) => {
		if (!mountedRef.current) return;
		setError(message);
	}, []);
	const notifySpeechSettled = useCallback(() => {
		try {
			speechSettledRef.current?.();
		} catch (caught) {
			reportRuntimeError(
				asErrorMessage(caught, "Voice speech-settled callback failed"),
			);
		}
	}, [reportRuntimeError]);

	const enqueueTranscription = useCallback(
		(blob: Blob, generation: number) => {
			if (generation !== generationRef.current || !activeRef.current) return;
			pendingRef.current++;
			if (mountedRef.current) setPendingTranscriptions(pendingRef.current);
			const run = async () => {
				if (generation !== generationRef.current || !activeRef.current) return;
				const controller = new AbortController();
				transcriptionAbortRef.current.add(controller);
				const timeout = window.setTimeout(
					() => controller.abort(),
					TRANSCRIPTION_TIMEOUT_MS,
				);
				try {
					const wav = await localConversationAudioToWav(blob);
					if (generation !== generationRef.current || !activeRef.current)
						return;
					const text = await transcribeLocalConversationAudio(
						wav,
						languageRef.current,
						controller.signal,
					);
					if (
						text.trim() &&
						generation === generationRef.current &&
						activeRef.current
					) {
						await callbackRef.current(text.trim());
					}
				} catch (caught) {
					if (
						generation === generationRef.current &&
						activeRef.current &&
						!controller.signal.aborted
					) {
						reportRuntimeError(
							asErrorMessage(caught, "Voice transcription failed"),
						);
					}
				} finally {
					window.clearTimeout(timeout);
					transcriptionAbortRef.current.delete(controller);
				}
			};
			const queued = transcriptionTailRef.current.then(run, run);
			transcriptionTailRef.current = queued.finally(() => {
				if (generation !== generationRef.current) return;
				pendingRef.current = Math.max(0, pendingRef.current - 1);
				if (mountedRef.current) {
					setPendingTranscriptions(pendingRef.current);
				}
			});
		},
		[reportRuntimeError],
	);

	const finalizeCapture = useCallback(
		(capture: ActiveCapture) => {
			if (captureRef.current !== capture) return;
			const closingSpeechState = closingSpeechStateRef.current;
			closingSpeechStateRef.current = "none";
			captureRef.current = null;
			if (closingSpeechState === "none") detectorRef.current?.reset();
			if (capture.finalizeTimer !== null) {
				window.clearTimeout(capture.finalizeTimer);
				capture.finalizeTimer = null;
			}
			if (capture.maxTimer !== null) {
				window.clearTimeout(capture.maxTimer);
				capture.maxTimer = null;
			}
			if (
				!capture.discard &&
				capture.chunks.length > 0 &&
				capture.generation === generationRef.current &&
				activeRef.current
			) {
				enqueueTranscription(
					new Blob(capture.chunks, {
						type: capture.recorder.mimeType || "audio/webm",
					}),
					capture.generation,
				);
			}
			if (
				mountedRef.current &&
				capture.generation === generationRef.current &&
				activeRef.current
			) {
				setPhase(mutedRef.current ? "muted" : "listening");
			}
			if (
				capture.generation === generationRef.current &&
				activeRef.current &&
				recorderRef.current?.state !== "recording"
			) {
				restartRecorderRef.current(capture.generation);
			}
			let promotedAdjacentSpeech = false;
			if (
				closingSpeechState !== "none" &&
				capture.generation === generationRef.current &&
				activeRef.current
			) {
				promotedAdjacentSpeech = promoteClosingSpeechRef.current(
					capture.generation,
					closingSpeechState,
				);
			}
			if (!promotedAdjacentSpeech) notifySpeechSettled();
		},
		[enqueueTranscription, notifySpeechSettled],
	);

	const finishCapture = useCallback(
		(discard: boolean) => {
			const capture = captureRef.current;
			if (!capture) return;
			capture.discard ||= discard;
			if (capture.closing) return;
			capture.closing = true;
			closingSpeechStateRef.current = "none";
			if (capture.maxTimer !== null) {
				window.clearTimeout(capture.maxTimer);
				capture.maxTimer = null;
			}
			try {
				speechEndRef.current?.();
			} catch (caught) {
				reportRuntimeError(
					asErrorMessage(caught, "Voice speech-end callback failed"),
				);
			}
			const recorder = capture.recorder;
			if (!recorder || recorder.state === "inactive") {
				finalizeCapture(capture);
				return;
			}
			try {
				startSuccessorRecorderRef.current(capture.generation);
			} catch (caught) {
				reportRuntimeError(
					asErrorMessage(caught, "Microphone pre-roll could not continue"),
				);
			}
			capture.finalizeTimer = window.setTimeout(
				() => finalizeCapture(capture),
				RECORDER_TIMESLICE_MS * 2,
			);
			try {
				recorder.stop();
			} catch (caught) {
				capture.discard = true;
				finalizeCapture(capture);
				reportRuntimeError(
					asErrorMessage(caught, "Microphone recording could not stop"),
				);
			}
		},
		[finalizeCapture, reportRuntimeError],
	);

	const beginCapture = useCallback(
		(nowMs: number, generation: number) => {
			const recorder = recorderRef.current;
			if (
				recorder?.state !== "recording" ||
				mutedRef.current ||
				captureRef.current ||
				generation !== generationRef.current
			) {
				return;
			}
			if (pendingRef.current >= maxPendingRef.current) {
				suppressedUntilSilenceRef.current = true;
				preRollRef.current = [];
				detectorRef.current?.reset();
				try {
					restartRecorderRef.current(generation);
				} catch (caught) {
					reportRuntimeError(
						asErrorMessage(caught, "Microphone recording could not pause"),
					);
				}
				reportRuntimeError(
					"Voice transcription is still catching up. Wait for a quiet moment and try again.",
				);
				return;
			}
			const activeCapture: ActiveCapture = {
				recorder,
				chunks: preRollRef.current,
				startedAt: nowMs,
				generation,
				discard: false,
				finishOnMute: false,
				closing: false,
				finalizeTimer: null,
				maxTimer: null,
			};
			preRollRef.current = [];
			captureRef.current = activeCapture;
			activeCapture.maxTimer = window.setTimeout(() => {
				if (captureRef.current !== activeCapture) return;
				detectorRef.current?.reset();
				finishCapture(false);
			}, maxUtteranceMsRef.current);
			if (mountedRef.current) {
				setError(null);
				setPhase("capturing");
			}
			try {
				speechStartRef.current?.();
			} catch (caught) {
				reportRuntimeError(
					asErrorMessage(caught, "Voice speech-start callback failed"),
				);
			}
		},
		[finishCapture, reportRuntimeError],
	);
	promoteClosingSpeechRef.current = (generation, state) => {
		const context = contextRef.current;
		const nowMs = context ? context.currentTime * 1_000 : performance.now();
		beginCapture(nowMs, generation);
		const promoted = captureRef.current !== null;
		if (state === "complete" && promoted) finishCapture(false);
		return promoted;
	};

	const startContinuousRecorder = useCallback(
		(generation: number, preservePrevious = false) => {
			if (recorderRotationTimerRef.current !== null) {
				window.clearTimeout(recorderRotationTimerRef.current);
				recorderRotationTimerRef.current = null;
			}
			const previous = recorderRef.current;
			recorderRef.current = null;
			if (previous && !preservePrevious) {
				previous.ondataavailable = null;
				previous.onerror = null;
				previous.onstop = null;
				try {
					if (previous.state !== "inactive") previous.stop();
				} catch {}
			}
			preRollRef.current = [];
			let suppressInput = false;
			try {
				suppressInput = shouldSuppressInputRef.current?.() ?? false;
			} catch {}
			const stream = streamRef.current;
			if (
				!stream ||
				!activeRef.current ||
				generation !== generationRef.current ||
				mutedRef.current ||
				suppressedUntilSilenceRef.current ||
				suppressInput
			) {
				return;
			}

			const recorderOptions = preferredRecorderOptions();
			const recorder = recorderOptions
				? new MediaRecorder(stream, recorderOptions)
				: new MediaRecorder(stream);
			recorderRef.current = recorder;
			recorder.ondataavailable = (event) => {
				const capture = captureRef.current;
				const finishingExplicitMute =
					capture?.recorder === recorder &&
					capture.closing &&
					capture.finishOnMute;
				let suppressInput = false;
				try {
					suppressInput = shouldSuppressInputRef.current?.() ?? false;
				} catch {}
				if ((mutedRef.current && !finishingExplicitMute) || suppressInput) {
					preRollRef.current = [];
					if (capture) capture.discard = true;
					return;
				}
				if (
					capture &&
					capture.recorder === recorder &&
					capture.generation === generationRef.current
				) {
					if (event.data.size > 0) capture.chunks.push(event.data);
					return;
				}
				if (
					recorderRef.current === recorder &&
					event.data.size > 0 &&
					activeRef.current
				) {
					preRollRef.current.push(event.data);
				}
			};
			recorder.onerror = () => {
				if (captureRef.current?.recorder === recorder) finishCapture(true);
				else {
					try {
						restartRecorderRef.current(generation);
					} catch {}
				}
				reportRuntimeError("Microphone recording failed");
			};
			recorder.onstop = () => {
				const capture = captureRef.current;
				if (capture?.recorder === recorder) {
					if (capture.closing) finalizeCapture(capture);
					else finishCapture(true);
					return;
				}
				if (
					recorderRef.current !== recorder ||
					!activeRef.current ||
					generation !== generationRef.current
				) {
					return;
				}
				try {
					restartRecorderRef.current(generation);
				} catch {}
				reportRuntimeError("Microphone recording stopped unexpectedly");
			};
			try {
				recorder.start(RECORDER_TIMESLICE_MS);
			} catch (caught) {
				recorderRef.current = null;
				recorder.ondataavailable = null;
				recorder.onerror = null;
				recorder.onstop = null;
				throw caught;
			}
			const scheduleIdleRotation = () => {
				recorderRotationTimerRef.current = window.setTimeout(() => {
					if (
						recorderRef.current !== recorder ||
						generation !== generationRef.current ||
						!activeRef.current
					) {
						return;
					}
					const threshold = detectorRef.current?.config.threshold ?? 0;
					if (captureRef.current || lastLevelRef.current >= threshold) {
						scheduleIdleRotation();
						return;
					}
					restartRecorderRef.current(generation);
				}, IDLE_RECORDER_ROTATION_MS);
			};
			scheduleIdleRotation();
		},
		[finalizeCapture, finishCapture, reportRuntimeError],
	);
	restartRecorderRef.current = (generation) =>
		startContinuousRecorder(generation, false);
	startSuccessorRecorderRef.current = (generation) =>
		startContinuousRecorder(generation, true);

	const stopAnalysisTimer = useCallback(() => {
		if (analysisTimerRef.current === null) return;
		window.clearInterval(analysisTimerRef.current);
		analysisTimerRef.current = null;
	}, []);

	const teardown = useCallback(
		(updateState: boolean) => {
			generationRef.current++;
			startingRef.current = null;
			activeRef.current = false;
			stopAnalysisTimer();
			if (recorderRotationTimerRef.current !== null) {
				window.clearTimeout(recorderRotationTimerRef.current);
				recorderRotationTimerRef.current = null;
			}
			detectorRef.current?.reset();
			detectorRef.current = null;
			const capture = captureRef.current;
			if (capture) {
				capture.discard = true;
				if (capture.finalizeTimer !== null) {
					window.clearTimeout(capture.finalizeTimer);
				}
				if (capture.maxTimer !== null) window.clearTimeout(capture.maxTimer);
				captureRef.current = null;
				if (!capture.closing) {
					try {
						speechEndRef.current?.();
					} catch {}
				}
			}
			closingSpeechStateRef.current = "none";
			const recorder = recorderRef.current;
			recorderRef.current = null;
			if (recorder) {
				recorder.ondataavailable = null;
				recorder.onerror = null;
				recorder.onstop = null;
				try {
					if (recorder.state !== "inactive") recorder.stop();
				} catch {}
			}
			if (capture) notifySpeechSettled();
			for (const controller of transcriptionAbortRef.current) {
				controller.abort();
			}
			transcriptionAbortRef.current.clear();
			transcriptionTailRef.current = Promise.resolve();
			pendingRef.current = 0;
			for (const track of streamRef.current?.getTracks() ?? []) track.stop();
			streamRef.current = null;
			try {
				sourceRef.current?.disconnect();
			} catch {}
			try {
				analyserRef.current?.disconnect();
			} catch {}
			sourceRef.current = null;
			analyserRef.current = null;
			samplesRef.current = null;
			closeAudioContext(contextRef.current);
			contextRef.current = null;
			suppressedUntilSilenceRef.current = false;
			preRollRef.current = [];
			lastLevelRef.current = 0;
			inputSuppressedRef.current = false;
			mutedRef.current = false;
			if (updateState && mountedRef.current) {
				setIsMuted(false);
				setPendingTranscriptions(0);
				setError(null);
				setPhase("idle");
			}
		},
		[notifySpeechSettled, stopAnalysisTimer],
	);

	const refreshInputSuppression = useCallback(() => {
		let suppressed = false;
		try {
			suppressed = shouldSuppressInputRef.current?.() ?? false;
		} catch {}
		if (suppressed === inputSuppressedRef.current) return;
		inputSuppressedRef.current = suppressed;
		detectorRef.current?.reset();
		preRollRef.current = [];
		if (suppressed) {
			const hadCapture = captureRef.current !== null;
			finishCapture(true);
			if (!hadCapture) restartRecorderRef.current(generationRef.current);
			return;
		}
		try {
			restartRecorderRef.current(generationRef.current);
		} catch (caught) {
			reportRuntimeError(
				asErrorMessage(caught, "Microphone recording could not resume"),
			);
		}
	}, [finishCapture, reportRuntimeError]);

	const start = useCallback((): Promise<void> => {
		if (activeRef.current) return Promise.resolve();
		if (startingRef.current) return startingRef.current;
		const generation = ++generationRef.current;
		if (mountedRef.current) {
			setError(null);
			setPhase("starting");
		}
		const starting = (async () => {
			let acquiredStream: MediaStream | null = null;
			let acquiredContext: AudioContext | null = null;
			let acquiredSource: MediaStreamAudioSourceNode | null = null;
			let acquiredRecorder: MediaRecorder | null = null;
			try {
				if (!navigator.mediaDevices?.getUserMedia) {
					throw new Error("Microphone access requires HTTPS or localhost");
				}
				if (typeof MediaRecorder === "undefined") {
					throw new Error("This browser cannot record microphone audio");
				}
				const AudioContextConstructor =
					window.AudioContext ??
					(
						window as Window & {
							webkitAudioContext?: typeof AudioContext;
						}
					).webkitAudioContext;
				if (!AudioContextConstructor) {
					throw new Error("This browser cannot analyze microphone audio");
				}
				const stream = await navigator.mediaDevices.getUserMedia({
					audio: {
						channelCount: 1,
						echoCancellation: true,
						noiseSuppression: true,
					},
				});
				acquiredStream = stream;
				if (!mountedRef.current || generation !== generationRef.current) {
					for (const track of stream.getTracks()) track.stop();
					return;
				}
				streamRef.current = stream;
				const context = new AudioContextConstructor();
				acquiredContext = context;
				contextRef.current = context;
				const source = context.createMediaStreamSource(stream);
				acquiredSource = source;
				sourceRef.current = source;
				const analyser = context.createAnalyser();
				analyserRef.current = analyser;
				analyser.fftSize = 512;
				analyser.smoothingTimeConstant = 0.15;
				source.connect(analyser);
				if (context.state === "suspended") await context.resume();
				if (!mountedRef.current || generation !== generationRef.current) return;
				samplesRef.current = new Float32Array(analyser.fftSize);
				detectorRef.current = new LocalConversationVadDetector(vad);
				activeRef.current = true;
				startContinuousRecorder(generation);
				acquiredRecorder = recorderRef.current;
				for (const track of stream.getTracks()) {
					track.enabled = !mutedRef.current;
				}

				const analyze = () => {
					if (generation !== generationRef.current || !activeRef.current) {
						return;
					}
					const currentAnalyser = analyserRef.current;
					const samples = samplesRef.current;
					const detector = detectorRef.current;
					if (!currentAnalyser || !samples || !detector) {
						return;
					}
					let suppressInput = false;
					try {
						suppressInput = shouldSuppressInputRef.current?.() ?? false;
					} catch {}
					if (suppressInput !== inputSuppressedRef.current) {
						refreshInputSuppression();
					}
					if (mutedRef.current || suppressInput) {
						detector.reset();
						preRollRef.current = [];
						return;
					}
					currentAnalyser.getFloatTimeDomainData(samples);
					const level = calculateAudioRms(samples);
					lastLevelRef.current = level;
					const nowMs = Number.isFinite(context.currentTime)
						? context.currentTime * 1_000
						: performance.now();
					if (captureRef.current?.closing) {
						const boundary = detector.observe(level, nowMs);
						if (boundary === "start") closingSpeechStateRef.current = "active";
						else if (boundary === "stop")
							closingSpeechStateRef.current = "complete";
						return;
					}
					if (suppressedUntilSilenceRef.current) {
						if (level < detector.config.threshold) {
							suppressedUntilSilenceRef.current = false;
							try {
								restartRecorderRef.current(generation);
							} catch (caught) {
								reportRuntimeError(
									asErrorMessage(
										caught,
										"Microphone recording could not resume",
									),
								);
							}
						}
						return;
					}
					const boundary = detector.observe(level, nowMs);
					if (boundary === "start") beginCapture(nowMs, generation);
					else if (boundary === "stop") finishCapture(false);
					const capture = captureRef.current;
					if (
						capture &&
						nowMs - capture.startedAt >= maxUtteranceMsRef.current
					) {
						detector.reset();
						finishCapture(false);
					}
				};
				analysisTimerRef.current = window.setInterval(
					analyze,
					ANALYSIS_INTERVAL_MS,
				);
				if (mountedRef.current) {
					setPhase(mutedRef.current ? "muted" : "listening");
				}
			} catch (caught) {
				if (!mountedRef.current || generation !== generationRef.current) return;
				if (acquiredRecorder) {
					acquiredRecorder.ondataavailable = null;
					acquiredRecorder.onerror = null;
					acquiredRecorder.onstop = null;
					try {
						if (acquiredRecorder.state !== "inactive") acquiredRecorder.stop();
					} catch {}
				}
				try {
					acquiredSource?.disconnect();
				} catch {}
				for (const track of acquiredStream?.getTracks() ?? []) track.stop();
				closeAudioContext(acquiredContext);
				if (streamRef.current === acquiredStream) streamRef.current = null;
				if (contextRef.current === acquiredContext) contextRef.current = null;
				if (sourceRef.current === acquiredSource) sourceRef.current = null;
				if (recorderRef.current === acquiredRecorder)
					recorderRef.current = null;
				analyserRef.current = null;
				samplesRef.current = null;
				detectorRef.current?.reset();
				detectorRef.current = null;
				if (!mountedRef.current || generation !== generationRef.current) return;
				activeRef.current = false;
				setError(asErrorMessage(caught, "Microphone unavailable"));
				setPhase("error");
			}
		})().finally(() => {
			if (generation === generationRef.current) startingRef.current = null;
		});
		startingRef.current = starting;
		return starting;
	}, [
		beginCapture,
		finishCapture,
		refreshInputSuppression,
		reportRuntimeError,
		startContinuousRecorder,
		vad,
	]);

	const stop = useCallback(() => teardown(true), [teardown]);

	const setMuted = useCallback(
		(muted: boolean, options?: { finishCurrentUtterance?: boolean }) => {
			const finishCurrentUtterance =
				muted && options?.finishCurrentUtterance === true;
			const capture = captureRef.current;
			if (finishCurrentUtterance && capture && !capture.discard) {
				capture.finishOnMute = true;
			}
			mutedRef.current = muted;
			if (mountedRef.current) setIsMuted(muted);
			for (const track of streamRef.current?.getTracks() ?? []) {
				track.enabled = !muted;
			}
			if (muted) {
				detectorRef.current?.reset();
				suppressedUntilSilenceRef.current = false;
				preRollRef.current = [];
				const hadCapture = capture !== null;
				finishCapture(!finishCurrentUtterance);
				if (!hadCapture) restartRecorderRef.current(generationRef.current);
			} else {
				preRollRef.current = [];
				try {
					restartRecorderRef.current(generationRef.current);
				} catch (caught) {
					reportRuntimeError(
						asErrorMessage(caught, "Microphone recording could not resume"),
					);
				}
			}
			if (mountedRef.current && activeRef.current) {
				setPhase(muted ? "muted" : "listening");
			}
		},
		[finishCapture, reportRuntimeError],
	);

	const toggleMuted = useCallback(() => {
		const muted = !mutedRef.current;
		setMuted(muted, { finishCurrentUtterance: muted });
	}, [setMuted]);
	const clearError = useCallback(() => {
		if (!mountedRef.current) return;
		setError(null);
		if (phase === "error") setPhase("idle");
	}, [phase]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			teardown(false);
		};
	}, [teardown]);

	const active =
		phase === "starting" ||
		phase === "listening" ||
		phase === "capturing" ||
		phase === "muted";
	return {
		phase,
		error,
		active,
		isListening: phase === "listening" || phase === "capturing",
		isCapturing: phase === "capturing",
		isMuted,
		pendingTranscriptions,
		start,
		stop,
		setMuted,
		toggleMuted,
		refreshInputSuppression,
		clearError,
	};
}
