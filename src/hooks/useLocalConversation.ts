import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "#/components/chat/chatReducer";
import {
	type LocalConversationMicPhase,
	useLocalConversationMic,
} from "#/hooks/useLocalConversationMic";
import {
	createProgressiveSpeechSegmenter,
	type ProgressiveSpeechSegment,
	type ProgressiveSpeechSegmenter,
	type ProgressiveSpeechUpdate,
} from "#/lib/progressiveSpeech";
import type { SpeechPronunciation } from "#/lib/speechPronunciations";

export type LocalConversationSpeakerPhase =
	| "idle"
	| "synthesizing"
	| "speaking"
	| "paused";

export type UseLocalConversationOptions = {
	enabled: boolean;
	available: boolean;
	unavailableReason: string | null;
	language: string;
	rate: number;
	pronunciations: readonly SpeechPronunciation[];
	messages: ChatMessage[];
	onTranscription: (text: string) => void | Promise<void>;
};

export type LocalConversationController = {
	active: boolean;
	phase: LocalConversationMicPhase;
	speakerPhase: LocalConversationSpeakerPhase;
	isMuted: boolean;
	isCapturing: boolean;
	pendingTranscriptions: number;
	attentionRequired: boolean;
	error: string | null;
	unavailableReason: string | null;
	start: () => Promise<void>;
	stop: () => void;
	setMuted: (muted: boolean) => void;
	toggleMuted: () => void;
	pauseSpeech: () => void;
	resumeSpeech: () => void;
	stopSpeech: () => void;
	clearError: () => void;
};

type AssistantSnapshot = {
	id: string;
	dbId?: number;
	transcriptSeq?: number;
	turnId?: string;
	text: string;
	toolCount: number;
	streaming: boolean;
};

type QueuedSpeech = {
	token: number;
	invalidated: boolean;
	segment: ProgressiveSpeechSegment;
	segmenter: ProgressiveSpeechSegmenter;
};

type PreparedSpeech = {
	item: QueuedSpeech;
	generation: number;
	controller: AbortController;
	result: Promise<{ ok: true; blob: Blob } | { ok: false; error: unknown }>;
};

type CurrentSpeech = {
	item: QueuedSpeech;
	started: boolean;
	url: string;
	cancel: () => void;
	released: boolean;
};

const MAX_QUEUE_PRESSURE_RETRIES = 8;

// A zero-length PCM WAV used only to unlock one persistent audio element from
// the user's Start gesture. Actual speech is always returned by Hlid's local
// neural synthesis endpoint.
const SILENT_WAV_DATA_URL =
	"data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

function assistantSnapshots(messages: ChatMessage[]): AssistantSnapshot[] {
	const snapshots: AssistantSnapshot[] = [];
	for (const message of messages) {
		if (message?.role !== "assistant" || message.source === "codex_realtime") {
			continue;
		}
		snapshots.push({
			id: message.id,
			...(message.dbId !== undefined ? { dbId: message.dbId } : {}),
			...(message.transcriptSeq !== undefined
				? { transcriptSeq: message.transcriptSeq }
				: {}),
			...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
			text: message.text,
			toolCount: message.toolEvents.length,
			streaming: message.streaming,
		});
	}
	return snapshots;
}

function sameAssistantIdentity(
	left: AssistantSnapshot,
	right: AssistantSnapshot,
): boolean {
	if (left.id === right.id) return true;
	if (left.dbId !== undefined && left.dbId === right.dbId) return true;
	if (
		left.transcriptSeq !== undefined &&
		left.transcriptSeq === right.transcriptSeq
	) {
		return true;
	}
	return left.turnId !== undefined && left.turnId === right.turnId;
}

export function hasPendingLocalConversationAttention(
	messages: ChatMessage[],
): boolean {
	return messages.some((message) => {
		if (message.role === "permission") {
			return (
				message.decision === "pending" && message.providerOutcome !== "blocked"
			);
		}
		if (message.role === "ask_user_question") return message.answers === null;
		return message.role === "plan_proposal" && message.decision === "pending";
	});
}

async function speechError(response: Response): Promise<Error> {
	let detail = "";
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string") detail = body.error;
	} catch {}
	return new Error(
		detail ||
			`local neural speech returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
	);
}

function waitForSpeechRetry(milliseconds: number, signal: AbortSignal) {
	if (signal.aborted) {
		return Promise.reject(new DOMException("Aborted", "AbortError"));
	}
	if (milliseconds <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		const onAbort = () => {
			window.clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function synthesizeSpeech(
	text: string,
	rate: number,
	signal: AbortSignal,
): Promise<Blob> {
	for (let attempt = 0; ; attempt += 1) {
		const response = await fetch("/api/speech/synthesize", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text, rate }),
			signal,
		});
		if (
			response.status === 429 &&
			attempt < MAX_QUEUE_PRESSURE_RETRIES &&
			!signal.aborted
		) {
			const retrySeconds = Number(response.headers.get("retry-after") ?? "1");
			const retryMs = Number.isFinite(retrySeconds)
				? Math.min(2_000, Math.max(0, retrySeconds * 1_000))
				: 1_000;
			await response.body?.cancel().catch(() => {});
			await waitForSpeechRetry(retryMs, signal);
			continue;
		}
		if (!response.ok) throw await speechError(response);
		const blob = await response.blob();
		if (!blob.size) throw new Error("local neural speech returned empty audio");
		return blob;
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

export function useLocalConversation({
	enabled,
	available,
	unavailableReason,
	language,
	rate,
	pronunciations,
	messages,
	onTranscription,
}: UseLocalConversationOptions): LocalConversationController {
	const [requestedActive, setRequestedActive] = useState(false);
	const [speakerPhase, setSpeakerPhase] =
		useState<LocalConversationSpeakerPhase>("idle");
	const [outputError, setOutputError] = useState<string | null>(null);
	const mountedRef = useRef(true);
	const activeRef = useRef(false);
	const outputFaultedRef = useRef(false);
	const transcriptionRef = useRef(onTranscription);
	const rateRef = useRef(rate);
	const pronunciationsRef = useRef(pronunciations);
	const attentionRequired = useMemo(
		() => hasPendingLocalConversationAttention(messages),
		[messages],
	);
	const attentionRef = useRef(attentionRequired);
	const assistants = useMemo(() => assistantSnapshots(messages), [messages]);
	const latestAssistant = assistants.at(-1) ?? null;
	const latestAssistantRef = useRef(latestAssistant);
	transcriptionRef.current = onTranscription;
	rateRef.current = rate;
	pronunciationsRef.current = pronunciations;
	attentionRef.current = attentionRequired;
	latestAssistantRef.current = latestAssistant;

	const audioRef = useRef<HTMLAudioElement | null>(null);
	const audioPrimeRef = useRef<Promise<void> | null>(null);
	const speakerOutputActiveRef = useRef(false);
	const speakerPausedRef = useRef(false);
	const inputSpeechHoldRef = useRef(false);
	const refreshInputSuppressionRef = useRef<() => void>(() => {});
	const queueRef = useRef<QueuedSpeech[]>([]);
	const nextQueueTokenRef = useRef(0);
	const activeItemsRef = useRef(new Map<number, QueuedSpeech>());
	const preparedRef = useRef<PreparedSpeech | null>(null);
	const currentSpeechRef = useRef<CurrentSpeech | null>(null);
	const playbackGenerationRef = useRef(0);
	const pumpingGenerationRef = useRef<number | null>(null);
	const segmenterRef = useRef<ProgressiveSpeechSegmenter | null>(null);
	const currentAssistantRef = useRef<AssistantSnapshot | null>(null);
	const suppressedAssistantIdRef = useRef<string | null>(null);

	const isInvalidated = useCallback(
		(item: QueuedSpeech) => item.invalidated,
		[],
	);
	const forgetItem = useCallback((item: QueuedSpeech) => {
		activeItemsRef.current.delete(item.token);
	}, []);

	const reportOutputError = useCallback((error: unknown) => {
		if (!mountedRef.current || isAbortError(error)) return;
		speakerPausedRef.current = false;
		outputFaultedRef.current = true;
		queueRef.current = [];
		activeItemsRef.current.clear();
		const prepared = preparedRef.current;
		preparedRef.current = null;
		prepared?.controller.abort();
		setOutputError(
			error instanceof Error ? error.message : "Local neural speech failed",
		);
		setSpeakerPhase("idle");
	}, []);

	const disposeCurrentSpeech = useCallback(
		(current: CurrentSpeech, stopAudio: boolean) => {
			if (current.released) return;
			current.released = true;
			current.cancel();
			if (currentSpeechRef.current === current) {
				currentSpeechRef.current = null;
				speakerOutputActiveRef.current = false;
				refreshInputSuppressionRef.current();
				const audio = audioRef.current;
				if (audio) {
					audio.onended = null;
					audio.onerror = null;
					if (stopAudio) audio.pause();
					audio.removeAttribute("src");
					audio.load();
				}
			}
			if (current.url.startsWith("blob:")) URL.revokeObjectURL(current.url);
			if (mountedRef.current && !speakerOutputActiveRef.current) {
				setSpeakerPhase(
					speakerPausedRef.current
						? "paused"
						: preparedRef.current
							? "synthesizing"
							: "idle",
				);
			}
		},
		[],
	);

	const releaseAudio = useCallback(() => {
		const current = currentSpeechRef.current;
		if (current) disposeCurrentSpeech(current, true);
		else {
			speakerOutputActiveRef.current = false;
			refreshInputSuppressionRef.current();
		}
	}, [disposeCurrentSpeech]);

	const clearPlayback = useCallback(
		(resetSegmenter: boolean) => {
			speakerPausedRef.current = false;
			playbackGenerationRef.current += 1;
			queueRef.current = [];
			activeItemsRef.current.clear();
			const prepared = preparedRef.current;
			preparedRef.current = null;
			prepared?.controller.abort();
			pumpingGenerationRef.current = null;
			releaseAudio();
			if (resetSegmenter) segmenterRef.current?.reset();
			if (mountedRef.current) setSpeakerPhase("idle");
		},
		[releaseAudio],
	);

	const primeAudio = useCallback(() => {
		if (audioPrimeRef.current) return;
		const audio = audioRef.current ?? new Audio();
		audioRef.current = audio;
		audio.preload = "auto";
		audio.volume = 0;
		audio.src = SILENT_WAV_DATA_URL;
		const attempt = audio.play();
		audioPrimeRef.current = attempt
			.then(() => {
				audio.pause();
				audio.removeAttribute("src");
				audio.load();
				audio.volume = 1;
			})
			.catch(() => {
				// Some browsers decline silent priming but still allow later playback
				// after the same trusted Start gesture has granted media permission.
				audio.volume = 1;
			});
	}, []);

	const prepareNext = useCallback(
		(generation: number) => {
			if (
				preparedRef.current ||
				generation !== playbackGenerationRef.current ||
				!activeRef.current ||
				outputFaultedRef.current
			) {
				return;
			}
			let item = queueRef.current.shift();
			while (item && isInvalidated(item)) {
				forgetItem(item);
				item = queueRef.current.shift();
			}
			if (!item) return;
			const controller = new AbortController();
			const result = synthesizeSpeech(
				item.segment.text,
				rateRef.current,
				controller.signal,
			).then(
				(blob) => ({ ok: true as const, blob }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			preparedRef.current = { item, generation, controller, result };
			if (
				mountedRef.current &&
				!speakerOutputActiveRef.current &&
				!speakerPausedRef.current
			) {
				setSpeakerPhase("synthesizing");
			}
		},
		[forgetItem, isInvalidated],
	);

	const playPrepared = useCallback(
		async (prepared: PreparedSpeech): Promise<void> => {
			let current: CurrentSpeech | null = null;
			let retainPrepared = false;
			try {
				const result = await prepared.result;
				if (
					prepared.generation !== playbackGenerationRef.current ||
					!activeRef.current ||
					isInvalidated(prepared.item)
				) {
					if (preparedRef.current === prepared) preparedRef.current = null;
					return;
				}
				if (!result.ok) {
					if (preparedRef.current === prepared) preparedRef.current = null;
					if (!isAbortError(result.error)) reportOutputError(result.error);
					return;
				}

				await audioPrimeRef.current?.catch(() => {});
				if (
					prepared.generation !== playbackGenerationRef.current ||
					!activeRef.current ||
					isInvalidated(prepared.item)
				) {
					if (preparedRef.current === prepared) preparedRef.current = null;
					return;
				}
				if (speakerPausedRef.current || inputSpeechHoldRef.current) {
					retainPrepared = preparedRef.current === prepared;
					if (mountedRef.current && speakerPausedRef.current) {
						setSpeakerPhase("paused");
					}
					return;
				}
				if (preparedRef.current !== prepared) return;
				preparedRef.current = null;
				const audio = audioRef.current ?? new Audio();
				audioRef.current = audio;
				const url = URL.createObjectURL(result.blob);
				let cancelPlayback = () => {};
				const cancelled = new Promise<"cancelled">((resolve) => {
					cancelPlayback = () => resolve("cancelled");
				});
				current = {
					item: prepared.item,
					started: false,
					url,
					cancel: cancelPlayback,
					released: false,
				};
				currentSpeechRef.current = current;
				audio.src = url;
				audio.volume = 1;
				const playbackEnded = new Promise<"ended" | "error">((resolve) => {
					audio.onended = () => resolve("ended");
					audio.onerror = () => resolve("error");
				});
				speakerOutputActiveRef.current = true;
				refreshInputSuppressionRef.current();
				const started = await Promise.race([
					audio.play().then(
						() => "started" as const,
						(error: unknown) => {
							throw error;
						},
					),
					cancelled,
				]);
				if (started !== "started") return;
				if (
					prepared.generation !== playbackGenerationRef.current ||
					currentSpeechRef.current !== current
				) {
					return;
				}
				current.started = true;
				prepared.item.segmenter.markStarted(prepared.item.segment.id);
				if (speakerPausedRef.current || inputSpeechHoldRef.current) {
					audio.pause();
					speakerOutputActiveRef.current = false;
					refreshInputSuppressionRef.current();
					if (mountedRef.current) {
						setSpeakerPhase(
							speakerPausedRef.current ? "paused" : "synthesizing",
						);
					}
				} else {
					if (mountedRef.current) setSpeakerPhase("speaking");
					prepareNext(prepared.generation);
				}
				const ended = await Promise.race([playbackEnded, cancelled]);
				if (ended === "error") {
					throw new Error("Local neural speech playback failed");
				}
			} finally {
				if (current) disposeCurrentSpeech(current, false);
				if (!retainPrepared) forgetItem(prepared.item);
			}
		},
		[
			disposeCurrentSpeech,
			forgetItem,
			isInvalidated,
			prepareNext,
			reportOutputError,
		],
	);

	const pump = useCallback(
		async (generation: number): Promise<void> => {
			if (pumpingGenerationRef.current === generation) return;
			pumpingGenerationRef.current = generation;
			try {
				while (
					generation === playbackGenerationRef.current &&
					activeRef.current &&
					!outputFaultedRef.current &&
					!speakerPausedRef.current &&
					!inputSpeechHoldRef.current
				) {
					prepareNext(generation);
					const prepared = preparedRef.current;
					if (!prepared || prepared.generation !== generation) break;
					try {
						await playPrepared(prepared);
					} catch (error) {
						reportOutputError(error);
					}
				}
			} finally {
				if (pumpingGenerationRef.current === generation) {
					pumpingGenerationRef.current = null;
				}
				if (
					mountedRef.current &&
					generation === playbackGenerationRef.current &&
					!preparedRef.current &&
					queueRef.current.length === 0 &&
					!speakerPausedRef.current &&
					!inputSpeechHoldRef.current
				) {
					setSpeakerPhase("idle");
				}
			}
		},
		[playPrepared, prepareNext, reportOutputError],
	);

	const applySpeechUpdate = useCallback(
		(
			update: ProgressiveSpeechUpdate,
			segmenter: ProgressiveSpeechSegmenter,
		) => {
			if (update.invalidate.length > 0) {
				const invalidatedIds = new Set(update.invalidate);
				for (const item of activeItemsRef.current.values()) {
					if (invalidatedIds.has(item.segment.id)) {
						item.invalidated = true;
					}
				}
				queueRef.current = queueRef.current.filter((item) => {
					if (!isInvalidated(item)) return true;
					forgetItem(item);
					return false;
				});
				const prepared = preparedRef.current;
				if (prepared && isInvalidated(prepared.item)) {
					preparedRef.current = null;
					prepared.controller.abort();
					forgetItem(prepared.item);
				}
				const current = currentSpeechRef.current;
				if (current && !current.started && isInvalidated(current.item)) {
					releaseAudio();
				}
			}

			for (const segment of update.enqueue) {
				if (outputFaultedRef.current) {
					segmenter.markStarted(segment.id);
					continue;
				}
				const item: QueuedSpeech = {
					token: ++nextQueueTokenRef.current,
					invalidated: false,
					segment,
					segmenter,
				};
				activeItemsRef.current.set(item.token, item);
				queueRef.current.push(item);
			}
			const generation = playbackGenerationRef.current;
			prepareNext(generation);
			void pump(generation);
		},
		[forgetItem, isInvalidated, prepareNext, pump, releaseAudio],
	);

	const suppressCurrentAssistant = useCallback(() => {
		const current = currentAssistantRef.current;
		if (current) suppressedAssistantIdRef.current = current.id;
		clearPlayback(true);
	}, [clearPlayback]);

	const pauseSpeech = useCallback(() => {
		if (!activeRef.current) return;
		const current = currentSpeechRef.current;
		const audio = audioRef.current;
		if (speakerPausedRef.current) return;
		const hasSpeech =
			(current !== null && !current.released) ||
			preparedRef.current !== null ||
			queueRef.current.length > 0;
		if (!hasSpeech) return;
		speakerPausedRef.current = true;
		if (current?.started && !current.released && audio) audio.pause();
		speakerOutputActiveRef.current = false;
		refreshInputSuppressionRef.current();
		if (mountedRef.current) setSpeakerPhase("paused");
	}, []);

	const continueSpeechPlayback = useCallback(() => {
		if (
			!activeRef.current ||
			outputFaultedRef.current ||
			speakerPausedRef.current ||
			inputSpeechHoldRef.current
		) {
			return;
		}
		const current = currentSpeechRef.current;
		const audio = audioRef.current;
		if (!current || current.released || !audio) {
			const generation = playbackGenerationRef.current;
			if (mountedRef.current) {
				setSpeakerPhase(
					preparedRef.current || queueRef.current.length > 0
						? "synthesizing"
						: "idle",
				);
			}
			prepareNext(generation);
			void pump(generation);
			return;
		}
		// playPrepared owns the initial play() promise. If the input hold was
		// released while that promise was pending, let it complete that start.
		if (!current.started) return;

		speakerOutputActiveRef.current = true;
		refreshInputSuppressionRef.current();
		if (mountedRef.current) setSpeakerPhase("speaking");
		try {
			void audio.play().catch((error: unknown) => {
				if (
					currentSpeechRef.current !== current ||
					current.released ||
					speakerPausedRef.current
				) {
					return;
				}
				disposeCurrentSpeech(current, true);
				reportOutputError(error);
			});
		} catch (error) {
			disposeCurrentSpeech(current, true);
			reportOutputError(error);
		}
	}, [disposeCurrentSpeech, prepareNext, pump, reportOutputError]);

	const resumeSpeech = useCallback(() => {
		if (!speakerPausedRef.current) return;
		speakerPausedRef.current = false;
		continueSpeechPlayback();
	}, [continueSpeechPlayback]);

	const holdSpeechForInput = useCallback(() => {
		inputSpeechHoldRef.current = true;
	}, []);

	const releaseSpeechAfterInput = useCallback(() => {
		if (!inputSpeechHoldRef.current) return;
		inputSpeechHoldRef.current = false;
		if (!activeRef.current) return;
		continueSpeechPlayback();
	}, [continueSpeechPlayback]);

	const stopSpeech = useCallback(() => {
		suppressCurrentAssistant();
	}, [suppressCurrentAssistant]);

	const handleTranscription = useCallback(async (text: string) => {
		if (!activeRef.current || attentionRef.current) return;
		await transcriptionRef.current(text);
	}, []);

	const mic = useLocalConversationMic({
		language,
		onTranscription: handleTranscription,
		onSpeechStart: holdSpeechForInput,
		onSpeechSettled: releaseSpeechAfterInput,
		shouldSuppressInput: () => speakerOutputActiveRef.current,
	});
	refreshInputSuppressionRef.current = mic.refreshInputSuppression;

	const seedCurrentAssistant = useCallback(() => {
		const snapshot = latestAssistantRef.current;
		currentAssistantRef.current = snapshot;
		suppressedAssistantIdRef.current = null;
		if (!snapshot) {
			segmenterRef.current = null;
			return;
		}
		const segmenter = createProgressiveSpeechSegmenter(
			snapshot.id,
			pronunciationsRef.current,
		);
		segmenterRef.current = segmenter;
		const existing = segmenter.pushChunk({
			text: snapshot.text,
			replace: true,
		});
		for (const segment of existing.enqueue) segmenter.markStarted(segment.id);
		if (!snapshot.streaming) {
			const tail = segmenter.flush("done");
			for (const segment of tail.enqueue) segmenter.markStarted(segment.id);
		}
	}, []);

	const stop = useCallback(() => {
		activeRef.current = false;
		inputSpeechHoldRef.current = false;
		setRequestedActive(false);
		mic.stop();
		clearPlayback(true);
		segmenterRef.current = null;
		currentAssistantRef.current = null;
		suppressedAssistantIdRef.current = null;
		outputFaultedRef.current = false;
		setOutputError(null);
	}, [clearPlayback, mic.stop]);

	const start = useCallback(async () => {
		if (activeRef.current) return;
		if (!enabled || !available) {
			setOutputError(
				unavailableReason ?? "Local Conversation is not available",
			);
			return;
		}
		if (attentionRef.current) {
			setOutputError("Resolve the pending Raven request before listening");
			return;
		}
		primeAudio();
		outputFaultedRef.current = false;
		setOutputError(null);
		activeRef.current = true;
		setRequestedActive(true);
		seedCurrentAssistant();
		await mic.start();
	}, [
		available,
		enabled,
		mic.start,
		primeAudio,
		seedCurrentAssistant,
		unavailableReason,
	]);

	const setMuted = useCallback(
		(muted: boolean) => {
			if (!muted && attentionRef.current) return;
			mic.setMuted(muted);
		},
		[mic.setMuted],
	);
	const toggleMuted = useCallback(() => {
		const muted = !mic.isMuted;
		if (!muted && attentionRef.current) return;
		mic.setMuted(muted, { finishCurrentUtterance: muted });
	}, [mic.isMuted, mic.setMuted]);
	const clearError = useCallback(() => {
		mic.clearError();
		outputFaultedRef.current = false;
		setOutputError(null);
	}, [mic.clearError]);

	useEffect(() => {
		if (!requestedActive) return;
		if (attentionRequired && !mic.isMuted) mic.setMuted(true);
	}, [attentionRequired, mic.isMuted, mic.setMuted, requestedActive]);

	useEffect(() => {
		if (enabled || !requestedActive) return;
		stop();
	}, [enabled, requestedActive, stop]);

	useEffect(() => {
		if (!requestedActive || mic.phase !== "error") return;
		activeRef.current = false;
		inputSpeechHoldRef.current = false;
		setRequestedActive(false);
		clearPlayback(true);
	}, [clearPlayback, mic.phase, requestedActive]);

	useEffect(() => {
		if (!requestedActive) return;
		if (assistants.length === 0) {
			if (currentAssistantRef.current) {
				clearPlayback(true);
				segmenterRef.current = null;
				currentAssistantRef.current = null;
				suppressedAssistantIdRef.current = null;
			}
			return;
		}
		const trackedAssistant = currentAssistantRef.current;
		const trackedIndex = trackedAssistant
			? assistants.findIndex((assistant) =>
					sameAssistantIdentity(assistant, trackedAssistant),
				)
			: -1;
		// A replay envelope can settle the old response and open the queued turn's
		// blank assistant in one React batch. Walk from the tracked response through
		// every later assistant so the old final tail is observed before switching.
		const pendingAssistants =
			trackedIndex >= 0
				? assistants.slice(trackedIndex)
				: [assistants[assistants.length - 1]];

		for (const assistant of pendingAssistants) {
			if (!assistant) continue;
			const previous = currentAssistantRef.current;
			if (!previous || !sameAssistantIdentity(previous, assistant)) {
				if (previous && suppressedAssistantIdRef.current !== previous.id) {
					const previousSegmenter = segmenterRef.current;
					if (previousSegmenter) {
						applySpeechUpdate(
							previousSegmenter.flush("message"),
							previousSegmenter,
						);
					}
				}
				suppressedAssistantIdRef.current = null;
				const segmenter = createProgressiveSpeechSegmenter(
					assistant.id,
					pronunciationsRef.current,
				);
				segmenterRef.current = segmenter;
				currentAssistantRef.current = assistant;
				applySpeechUpdate(
					segmenter.pushChunk({ text: assistant.text, replace: true }),
					segmenter,
				);
				if (assistant.toolCount > 0) {
					applySpeechUpdate(segmenter.flush("tool"), segmenter);
				}
				if (!assistant.streaming) {
					applySpeechUpdate(segmenter.flush("done"), segmenter);
				}
				continue;
			}

			const wasSuppressed = suppressedAssistantIdRef.current === previous.id;
			currentAssistantRef.current = assistant;
			if (wasSuppressed) {
				suppressedAssistantIdRef.current = assistant.id;
				continue;
			}
			if (suppressedAssistantIdRef.current === assistant.id) continue;
			const segmenter = segmenterRef.current;
			if (!segmenter) continue;
			applySpeechUpdate(
				segmenter.pushChunk({ text: assistant.text, replace: true }),
				segmenter,
			);
			if (assistant.toolCount > previous.toolCount) {
				applySpeechUpdate(segmenter.flush("tool"), segmenter);
			}
			if (previous.streaming && !assistant.streaming) {
				applySpeechUpdate(segmenter.flush("done"), segmenter);
			}
		}
	}, [applySpeechUpdate, assistants, clearPlayback, requestedActive]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			activeRef.current = false;
			inputSpeechHoldRef.current = false;
			mic.stop();
			clearPlayback(true);
			audioRef.current = null;
		};
	}, [clearPlayback, mic.stop]);

	return {
		active: requestedActive,
		phase: mic.phase,
		speakerPhase,
		isMuted: mic.isMuted,
		isCapturing: mic.isCapturing,
		pendingTranscriptions: mic.pendingTranscriptions,
		attentionRequired,
		error: mic.error ?? outputError,
		unavailableReason: enabled
			? unavailableReason
			: "Enable Local Conversation in Forge",
		start,
		stop,
		setMuted,
		toggleMuted,
		pauseSpeech,
		resumeSpeech,
		stopSpeech,
		clearError,
	};
}
