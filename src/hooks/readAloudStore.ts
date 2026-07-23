import { useEffect, useSyncExternalStore } from "react";
import {
	chunkReadAloudText,
	DEFAULT_READ_ALOUD_PREFERENCES,
	estimateReadAloudResumeIndex,
	normalizeReadAloudPreferences,
	READ_ALOUD_PREFERENCES_KEY,
	type ReadAloudPreferences,
	type ReadAloudProvider,
	readableTextFromMarkdown,
} from "#/lib/readAloud";
import { startCodexReadAloud, stopCodexReadAloud } from "./codexRealtimeStore";

export type ReadAloudPhase =
	| "idle"
	| "loading"
	| "speaking"
	| "paused"
	| "error";

export type ReadAloudState = {
	messageId: string | null;
	phase: ReadAloudPhase;
	error: string | null;
};

export type LocalReadAloudVoice = {
	voiceURI: string;
	name: string;
	lang: string;
	default: boolean;
};

const IDLE_STATE: ReadAloudState = {
	messageId: null,
	phase: "idle",
	error: null,
};
const EMPTY_VOICES: LocalReadAloudVoice[] = [];
const VOICE_DISCOVERY_TIMEOUT_MS = 2_000;
const VOICE_DISCOVERY_POLL_MS = 100;

let stateSnapshot = IDLE_STATE;
let preferencesSnapshot = DEFAULT_READ_ALOUD_PREFERENCES;
let voicesSnapshot: LocalReadAloudVoice[] = [];
let preferencesInitialized = false;
let generation = 0;
let utteranceGeneration = 0;
let activeUtterance: SpeechSynthesisUtterance | null = null;
let activeAudio: HTMLAudioElement | null = null;
let sharedPreferencesRequest: Promise<void> | null = null;
let pendingVoiceDiscoveryCleanup: (() => void) | null = null;

type ActiveReading = {
	messageId: string;
	chunks: string[];
	chunkIndex: number;
	charIndex: number;
	voice: SpeechSynthesisVoice | null;
	rate: number;
	generation: number;
	utteranceStartIndex: number;
	utteranceStartedAt: number | null;
	boundaryObserved: boolean;
};

let activeReading: ActiveReading | null = null;

const stateSubscribers = new Set<() => void>();
const preferenceSubscribers = new Set<() => void>();
const voiceSubscribers = new Set<() => void>();

function subscribe(set: Set<() => void>, subscriber: () => void): () => void {
	set.add(subscriber);
	return () => set.delete(subscriber);
}

function emit(set: Set<() => void>): void {
	for (const subscriber of set) subscriber();
}

function updateState(next: ReadAloudState): void {
	stateSnapshot = next;
	emit(stateSubscribers);
}

function releaseActiveUtterance(): void {
	const utterance = activeUtterance;
	activeUtterance = null;
	if (!utterance) return;
	utterance.onboundary = null;
	utterance.onstart = null;
	utterance.onend = null;
	utterance.onerror = null;
}

function releaseActiveAudio(): void {
	const audio = activeAudio;
	activeAudio = null;
	if (!audio) return;
	audio.onplaying = null;
	audio.onended = null;
	audio.onerror = null;
	audio.pause();
	if (audio.src) audio.removeAttribute("src");
}

function releasePendingVoiceDiscovery(): void {
	const cleanup = pendingVoiceDiscoveryCleanup;
	pendingVoiceDiscoveryCleanup = null;
	cleanup?.();
}

function speechController(): SpeechSynthesis | null {
	return typeof window !== "undefined" && "speechSynthesis" in window
		? window.speechSynthesis
		: null;
}

function browserLocalVoices(): SpeechSynthesisVoice[] {
	return (
		speechController()
			?.getVoices()
			.filter((voice) => voice.localService === true) ?? []
	);
}

function refreshVoices(): void {
	voicesSnapshot = browserLocalVoices().map((voice) => ({
		voiceURI: voice.voiceURI,
		name: voice.name,
		lang: voice.lang,
		default: voice.default,
	}));
	emit(voiceSubscribers);
}

function initializePreferences(): void {
	if (preferencesInitialized || typeof localStorage === "undefined") return;
	preferencesInitialized = true;
	try {
		const stored = localStorage.getItem(READ_ALOUD_PREFERENCES_KEY);
		if (stored) {
			const local = normalizeReadAloudPreferences(JSON.parse(stored));
			preferencesSnapshot = {
				...preferencesSnapshot,
				voiceURI: local.voiceURI,
			};
			localStorage.setItem(
				READ_ALOUD_PREFERENCES_KEY,
				JSON.stringify({ voiceURI: local.voiceURI }),
			);
		}
	} catch {}
	emit(preferenceSubscribers);
}

function preferencesEqual(
	left: ReadAloudPreferences,
	right: ReadAloudPreferences,
): boolean {
	return (
		left.provider === right.provider &&
		left.voiceURI === right.voiceURI &&
		left.microsoftVoiceId === right.microsoftVoiceId &&
		left.rate === right.rate
	);
}

export function applyReadAloudSharedPreferences(
	preferences: Pick<
		ReadAloudPreferences,
		"provider" | "microsoftVoiceId" | "rate"
	>,
): void {
	initializePreferences();
	const next = normalizeReadAloudPreferences({
		...preferencesSnapshot,
		...preferences,
		voiceURI: preferencesSnapshot.voiceURI,
	});
	if (preferencesEqual(next, preferencesSnapshot)) return;
	preferencesSnapshot = next;
	emit(preferenceSubscribers);
	if (
		stateSnapshot.phase === "loading" ||
		stateSnapshot.phase === "speaking" ||
		stateSnapshot.phase === "paused"
	)
		stopReadAloud();
}

export function refreshReadAloudPreferences(): Promise<void> {
	if (sharedPreferencesRequest) return sharedPreferencesRequest;
	sharedPreferencesRequest = (async () => {
		const response = await fetch("/api/config", { cache: "no-store" });
		if (!response.ok)
			throw new Error(`read-aloud settings failed (${response.status})`);
		const config = (await response.json()) as {
			voice?: {
				read_aloud_provider?: unknown;
				read_aloud_voice?: unknown;
				read_aloud_rate?: unknown;
				codex_live_mode?: unknown;
			};
		};
		const voice = config.voice;
		applyReadAloudSharedPreferences({
			provider:
				voice?.read_aloud_provider === "microsoft" ||
				(voice?.read_aloud_provider === "codex" &&
					voice.codex_live_mode === true)
					? voice.read_aloud_provider
					: "device",
			microsoftVoiceId:
				typeof voice?.read_aloud_voice === "string"
					? voice.read_aloud_voice
					: "",
			rate:
				typeof voice?.read_aloud_rate === "number"
					? voice.read_aloud_rate
					: DEFAULT_READ_ALOUD_PREFERENCES.rate,
		});
	})().finally(() => {
		sharedPreferencesRequest = null;
	});
	return sharedPreferencesRequest;
}

function selectedVoice(
	voices: SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
	const fallback = voices[0];
	if (!fallback) throw new Error("No local speech voices are available");
	const selected = voices.find(
		(voice) => voice.voiceURI === preferencesSnapshot.voiceURI,
	);
	if (selected) return selected;
	// Leaving `voice` unset is the most reliable way to invoke Chrome's device
	// default on Android. Only do that when the browser reports its default as
	// local; otherwise keep the local-only promise by choosing a local voice.
	if (voices.some((voice) => voice.default)) return null;
	const language =
		typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
	return (
		voices.find((voice) =>
			voice.lang.toLowerCase().startsWith(language.split("-")[0] ?? ""),
		) ?? fallback
	);
}

function finishReading(reading: ActiveReading): void {
	if (activeReading !== reading || reading.generation !== generation) return;
	releaseActiveUtterance();
	activeReading = null;
	updateState(IDLE_STATE);
}

function checkpointEstimatedProgress(reading: ActiveReading): void {
	if (reading.boundaryObserved || reading.utteranceStartedAt === null) return;
	const chunk = reading.chunks[reading.chunkIndex];
	if (!chunk) return;
	reading.charIndex = estimateReadAloudResumeIndex(
		chunk,
		reading.utteranceStartIndex,
		Date.now() - reading.utteranceStartedAt,
		reading.rate,
	);
}

function speakCurrentChunk(reading: ActiveReading): void {
	const speech = speechController();
	if (
		!speech ||
		typeof SpeechSynthesisUtterance === "undefined" ||
		activeReading !== reading ||
		reading.generation !== generation ||
		stateSnapshot.phase !== "speaking"
	)
		return;

	if (reading.chunkIndex >= reading.chunks.length) {
		finishReading(reading);
		return;
	}

	const chunk = reading.chunks[reading.chunkIndex] ?? "";
	const startIndex = Math.min(reading.charIndex, chunk.length);
	const remaining = chunk.slice(startIndex);
	if (!remaining) {
		reading.chunkIndex++;
		reading.charIndex = 0;
		speakCurrentChunk(reading);
		return;
	}

	const currentUtteranceGeneration = ++utteranceGeneration;
	const utterance = new SpeechSynthesisUtterance(remaining);
	reading.utteranceStartIndex = startIndex;
	reading.utteranceStartedAt = null;
	reading.boundaryObserved = false;
	if (reading.voice) {
		utterance.voice = reading.voice;
		utterance.lang = reading.voice.lang;
	}
	utterance.rate = reading.rate;
	utterance.onstart = () => {
		if (
			activeReading === reading &&
			reading.generation === generation &&
			currentUtteranceGeneration === utteranceGeneration
		)
			reading.utteranceStartedAt = Date.now();
	};
	utterance.onboundary = (event) => {
		if (
			activeReading !== reading ||
			reading.generation !== generation ||
			currentUtteranceGeneration !== utteranceGeneration
		)
			return;
		// Word boundaries arrive before the word is spoken. Resuming from that
		// boundary may repeat one word, but it never skips unheard text.
		if (Number.isFinite(event.charIndex) && event.charIndex >= 0) {
			reading.charIndex = startIndex + event.charIndex;
			if (event.charIndex > 0) reading.boundaryObserved = true;
		}
	};
	utterance.onend = () => {
		if (
			activeReading !== reading ||
			reading.generation !== generation ||
			currentUtteranceGeneration !== utteranceGeneration
		)
			return;
		releaseActiveUtterance();
		reading.chunkIndex++;
		reading.charIndex = 0;
		speakCurrentChunk(reading);
	};
	utterance.onerror = (event) => {
		if (
			activeReading !== reading ||
			reading.generation !== generation ||
			currentUtteranceGeneration !== utteranceGeneration ||
			event.error === "canceled" ||
			event.error === "interrupted"
		)
			return;
		generation++;
		utteranceGeneration++;
		releaseActiveUtterance();
		activeReading = null;
		speech.cancel();
		updateState({
			messageId: reading.messageId,
			phase: "error",
			error: `Read aloud failed: ${event.error}`,
		});
	};
	activeUtterance = utterance;
	speech.speak(utterance);
}

export function readAloudSupported(provider?: ReadAloudProvider): boolean {
	initializePreferences();
	if ((provider ?? preferencesSnapshot.provider) === "codex")
		return typeof RTCPeerConnection !== "undefined";
	if ((provider ?? preferencesSnapshot.provider) === "microsoft")
		return typeof Audio !== "undefined";
	return (
		speechController() !== null &&
		typeof SpeechSynthesisUtterance !== "undefined"
	);
}

function beginDeviceReadAloud(
	messageId: string,
	chunks: string[],
	voices: SpeechSynthesisVoice[],
	currentGeneration: number,
): void {
	if (currentGeneration !== generation) return;
	const voice = selectedVoice(voices);
	const reading: ActiveReading = {
		messageId,
		chunks,
		chunkIndex: 0,
		charIndex: 0,
		voice,
		rate: preferencesSnapshot.rate,
		generation: currentGeneration,
		utteranceStartIndex: 0,
		utteranceStartedAt: null,
		boundaryObserved: false,
	};
	activeReading = reading;
	releaseActiveUtterance();
	updateState({ messageId, phase: "speaking", error: null });
	speakCurrentChunk(reading);
}

function waitForDeviceVoices(
	messageId: string,
	chunks: string[],
	speech: SpeechSynthesis,
	currentGeneration: number,
): void {
	let settled = false;
	let pollId: ReturnType<typeof setInterval> | undefined;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const cleanup = () => {
		if (settled) return;
		settled = true;
		speech.removeEventListener("voiceschanged", checkVoices);
		if (pollId !== undefined) clearInterval(pollId);
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		if (pendingVoiceDiscoveryCleanup === cleanup)
			pendingVoiceDiscoveryCleanup = null;
	};
	const checkVoices = () => {
		if (currentGeneration !== generation) {
			cleanup();
			return;
		}
		const voices = browserLocalVoices();
		if (voices.length === 0) return;
		cleanup();
		beginDeviceReadAloud(messageId, chunks, voices, currentGeneration);
	};
	pendingVoiceDiscoveryCleanup = cleanup;
	speech.addEventListener("voiceschanged", checkVoices);
	pollId = setInterval(checkVoices, VOICE_DISCOVERY_POLL_MS);
	timeoutId = setTimeout(() => {
		if (currentGeneration !== generation) {
			cleanup();
			return;
		}
		cleanup();
		updateState({
			messageId,
			phase: "error",
			error: "No local speech voices are available on this device",
		});
	}, VOICE_DISCOVERY_TIMEOUT_MS);
}

function startDeviceReadAloud(messageId: string, markdown: string): void {
	const speech = speechController();
	if (!speech || typeof SpeechSynthesisUtterance === "undefined") {
		updateState({
			messageId,
			phase: "error",
			error: "Read aloud is not supported by this browser",
		});
		return;
	}
	initializePreferences();
	const chunks = chunkReadAloudText(readableTextFromMarkdown(markdown));
	if (chunks.length === 0) {
		updateState({
			messageId,
			phase: "error",
			error: "This response has no readable text",
		});
		return;
	}

	const replacingDeviceReading =
		activeReading !== null || activeUtterance !== null;
	const currentGeneration = ++generation;
	utteranceGeneration++;
	releasePendingVoiceDiscovery();
	releaseActiveAudio();
	releaseActiveUtterance();
	activeReading = null;
	// Calling cancel immediately before Chrome's first speak() can cause that
	// first utterance to be dropped. Only cancel when replacing speech we own.
	if (replacingDeviceReading) speech.cancel();
	const voices = browserLocalVoices();
	if (voices.length > 0) {
		beginDeviceReadAloud(messageId, chunks, voices, currentGeneration);
		return;
	}
	updateState({ messageId, phase: "loading", error: null });
	waitForDeviceVoices(messageId, chunks, speech, currentGeneration);
}

function startMicrosoftReadAloud(messageId: string, dbId?: number): void {
	if (typeof Audio === "undefined") {
		updateState({
			messageId,
			phase: "error",
			error: "Audio playback is not supported by this browser",
		});
		return;
	}
	if (!dbId) {
		updateState({
			messageId,
			phase: "error",
			error: "This response is not ready for Microsoft speech yet",
		});
		return;
	}

	const currentGeneration = ++generation;
	utteranceGeneration++;
	releasePendingVoiceDiscovery();
	releaseActiveUtterance();
	activeReading = null;
	speechController()?.cancel();
	releaseActiveAudio();
	const query = new URLSearchParams({ message_id: String(dbId) });
	if (preferencesSnapshot.microsoftVoiceId)
		query.set("voice_id", preferencesSnapshot.microsoftVoiceId);
	const audio = new Audio(`/api/read-aloud/audio?${query}`);
	audio.preload = "auto";
	audio.playbackRate = preferencesSnapshot.rate;
	audio.onplaying = () => {
		if (activeAudio !== audio || currentGeneration !== generation) return;
		updateState({ messageId, phase: "speaking", error: null });
	};
	audio.onended = () => {
		if (activeAudio !== audio || currentGeneration !== generation) return;
		releaseActiveAudio();
		updateState(IDLE_STATE);
	};
	audio.onerror = () => {
		if (activeAudio !== audio || currentGeneration !== generation) return;
		generation++;
		releaseActiveAudio();
		updateState({
			messageId,
			phase: "error",
			error: "Microsoft speech could not prepare this response",
		});
	};
	activeAudio = audio;
	updateState({ messageId, phase: "loading", error: null });
	void audio.play().catch((error) => {
		if (activeAudio !== audio || currentGeneration !== generation) return;
		generation++;
		releaseActiveAudio();
		updateState({
			messageId,
			phase: "error",
			error:
				error instanceof Error
					? `Microsoft speech playback failed: ${error.message}`
					: "Microsoft speech playback failed",
		});
	});
}

function startCodexProviderReadAloud(
	messageId: string,
	markdown: string,
): void {
	if (typeof RTCPeerConnection === "undefined") {
		updateState({
			messageId,
			phase: "error",
			error: "Codex read aloud is not supported by this browser",
		});
		return;
	}
	const text = readableTextFromMarkdown(markdown);
	if (!text) {
		updateState({
			messageId,
			phase: "error",
			error: "This response has no readable text",
		});
		return;
	}
	const currentGeneration = ++generation;
	utteranceGeneration++;
	releasePendingVoiceDiscovery();
	releaseActiveUtterance();
	activeReading = null;
	speechController()?.cancel();
	releaseActiveAudio();
	updateState({ messageId, phase: "loading", error: null });
	startCodexReadAloud(text, {
		onPlaying: () => {
			if (currentGeneration !== generation) return;
			updateState({ messageId, phase: "speaking", error: null });
		},
		onEnded: () => {
			if (currentGeneration !== generation) return;
			updateState(IDLE_STATE);
		},
		onError: (message) => {
			if (currentGeneration !== generation) return;
			updateState({
				messageId,
				phase: "error",
				error: `Codex read aloud failed: ${message}`,
			});
		},
	});
}

export function startReadAloud(
	messageId: string,
	markdown: string,
	dbId?: number,
): void {
	initializePreferences();
	if (preferencesSnapshot.provider === "microsoft") {
		startMicrosoftReadAloud(messageId, dbId);
		return;
	}
	if (preferencesSnapshot.provider === "codex") {
		startCodexProviderReadAloud(messageId, markdown);
		return;
	}
	startDeviceReadAloud(messageId, markdown);
}

export function toggleReadAloud(
	messageId: string,
	markdown: string,
	dbId?: number,
): void {
	const speech = speechController();
	if (stateSnapshot.messageId !== messageId) {
		startReadAloud(messageId, markdown, dbId);
		return;
	}
	if (
		preferencesSnapshot.provider === "codex" &&
		(stateSnapshot.phase === "loading" || stateSnapshot.phase === "speaking")
	) {
		stopReadAloud();
		return;
	}
	if (stateSnapshot.phase === "loading") {
		stopReadAloud();
		return;
	}
	if (stateSnapshot.phase === "speaking" && activeAudio) {
		activeAudio.pause();
		updateState({ ...stateSnapshot, phase: "paused" });
		return;
	}
	if (stateSnapshot.phase === "paused" && activeAudio) {
		const audio = activeAudio;
		updateState({ ...stateSnapshot, phase: "speaking" });
		void audio.play().catch((error) => {
			if (activeAudio !== audio) return;
			generation++;
			releaseActiveAudio();
			updateState({
				messageId,
				phase: "error",
				error:
					error instanceof Error
						? `Microsoft speech playback failed: ${error.message}`
						: "Microsoft speech playback failed",
			});
		});
		return;
	}
	if (stateSnapshot.phase === "speaking" && speech) {
		// Chrome on Android frequently pauses successfully but never resumes the
		// native utterance. Cancel it while retaining the latest word boundary,
		// then create a fresh utterance when the user resumes.
		if (activeReading) checkpointEstimatedProgress(activeReading);
		utteranceGeneration++;
		releaseActiveUtterance();
		speech.cancel();
		updateState({ ...stateSnapshot, phase: "paused" });
		return;
	}
	if (stateSnapshot.phase === "paused" && speech && activeReading) {
		updateState({ ...stateSnapshot, phase: "speaking" });
		speakCurrentChunk(activeReading);
		return;
	}
	startReadAloud(messageId, markdown, dbId);
}

export function stopReadAloud(): void {
	generation++;
	utteranceGeneration++;
	releasePendingVoiceDiscovery();
	releaseActiveUtterance();
	activeReading = null;
	speechController()?.cancel();
	releaseActiveAudio();
	stopCodexReadAloud();
	updateState(IDLE_STATE);
}

export function stopReadAloudMessage(messageId: string): void {
	if (stateSnapshot.messageId === messageId) stopReadAloud();
}

export function setReadAloudPreferences(
	patch: Partial<ReadAloudPreferences>,
): void {
	initializePreferences();
	const next = normalizeReadAloudPreferences({
		...preferencesSnapshot,
		...patch,
	});
	if (preferencesEqual(next, preferencesSnapshot)) return;
	preferencesSnapshot = next;
	if (patch.voiceURI !== undefined)
		try {
			localStorage.setItem(
				READ_ALOUD_PREFERENCES_KEY,
				JSON.stringify({ voiceURI: preferencesSnapshot.voiceURI }),
			);
		} catch {}
	emit(preferenceSubscribers);
	if (
		stateSnapshot.phase === "loading" ||
		stateSnapshot.phase === "speaking" ||
		stateSnapshot.phase === "paused"
	)
		stopReadAloud();
}

export function useReadAloudState(): ReadAloudState {
	return useSyncExternalStore(
		(subscriber) => subscribe(stateSubscribers, subscriber),
		() => stateSnapshot,
		() => IDLE_STATE,
	);
}

export function useReadAloudPreferences(
	refreshSharedPreferences = true,
): ReadAloudPreferences {
	useEffect(() => {
		initializePreferences();
		if (!refreshSharedPreferences || typeof fetch !== "function") return;
		const refresh = () => void refreshReadAloudPreferences().catch(() => {});
		refresh();
		if (typeof document === "undefined") return;
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") refresh();
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [refreshSharedPreferences]);
	return useSyncExternalStore(
		(subscriber) => subscribe(preferenceSubscribers, subscriber),
		() => preferencesSnapshot,
		() => DEFAULT_READ_ALOUD_PREFERENCES,
	);
}

export function useLocalReadAloudVoices(): LocalReadAloudVoice[] {
	useEffect(() => {
		const speech = speechController();
		if (!speech) return;
		refreshVoices();
		speech.addEventListener("voiceschanged", refreshVoices);
		return () => speech.removeEventListener("voiceschanged", refreshVoices);
	}, []);
	return useSyncExternalStore(
		(subscriber) => subscribe(voiceSubscribers, subscriber),
		() => voicesSnapshot,
		() => EMPTY_VOICES,
	);
}

/** @internal Reset singleton browser state between tests. */
export function __resetReadAloudForTesting(): void {
	generation++;
	utteranceGeneration++;
	releasePendingVoiceDiscovery();
	releaseActiveUtterance();
	activeReading = null;
	releaseActiveAudio();
	stateSnapshot = IDLE_STATE;
	preferencesSnapshot = DEFAULT_READ_ALOUD_PREFERENCES;
	voicesSnapshot = [];
	preferencesInitialized = false;
	sharedPreferencesRequest = null;
	stateSubscribers.clear();
	preferenceSubscribers.clear();
	voiceSubscribers.clear();
}
