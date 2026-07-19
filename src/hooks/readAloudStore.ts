import { useEffect, useSyncExternalStore } from "react";
import {
	chunkReadAloudText,
	DEFAULT_READ_ALOUD_PREFERENCES,
	estimateReadAloudResumeIndex,
	normalizeReadAloudPreferences,
	READ_ALOUD_PREFERENCES_KEY,
	type ReadAloudPreferences,
	readableTextFromMarkdown,
} from "#/lib/readAloud";

export type ReadAloudPhase = "idle" | "speaking" | "paused" | "error";

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

let stateSnapshot = IDLE_STATE;
let preferencesSnapshot = DEFAULT_READ_ALOUD_PREFERENCES;
let voicesSnapshot: LocalReadAloudVoice[] = [];
let preferencesInitialized = false;
let generation = 0;
let utteranceGeneration = 0;
let activeUtterance: SpeechSynthesisUtterance | null = null;

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
		if (stored)
			preferencesSnapshot = normalizeReadAloudPreferences(JSON.parse(stored));
	} catch {}
	emit(preferenceSubscribers);
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

export function readAloudSupported(): boolean {
	return (
		speechController() !== null &&
		typeof SpeechSynthesisUtterance !== "undefined"
	);
}

export function startReadAloud(messageId: string, markdown: string): void {
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
	const voices = browserLocalVoices();
	if (voices.length === 0) {
		updateState({
			messageId,
			phase: "error",
			error: "No local speech voices are available on this device",
		});
		return;
	}
	const chunks = chunkReadAloudText(readableTextFromMarkdown(markdown));
	if (chunks.length === 0) {
		updateState({
			messageId,
			phase: "error",
			error: "This response has no readable text",
		});
		return;
	}

	const currentGeneration = ++generation;
	utteranceGeneration++;
	speech.cancel();
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

export function toggleReadAloud(messageId: string, markdown: string): void {
	const speech = speechController();
	if (stateSnapshot.messageId !== messageId) {
		startReadAloud(messageId, markdown);
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
	startReadAloud(messageId, markdown);
}

export function stopReadAloud(): void {
	generation++;
	utteranceGeneration++;
	releaseActiveUtterance();
	activeReading = null;
	speechController()?.cancel();
	updateState(IDLE_STATE);
}

export function stopReadAloudMessage(messageId: string): void {
	if (stateSnapshot.messageId === messageId) stopReadAloud();
}

export function setReadAloudPreferences(
	patch: Partial<ReadAloudPreferences>,
): void {
	initializePreferences();
	preferencesSnapshot = normalizeReadAloudPreferences({
		...preferencesSnapshot,
		...patch,
	});
	try {
		localStorage.setItem(
			READ_ALOUD_PREFERENCES_KEY,
			JSON.stringify(preferencesSnapshot),
		);
	} catch {}
	emit(preferenceSubscribers);
	if (stateSnapshot.phase === "speaking" || stateSnapshot.phase === "paused")
		stopReadAloud();
}

export function useReadAloudState(): ReadAloudState {
	return useSyncExternalStore(
		(subscriber) => subscribe(stateSubscribers, subscriber),
		() => stateSnapshot,
		() => IDLE_STATE,
	);
}

export function useReadAloudPreferences(): ReadAloudPreferences {
	useEffect(initializePreferences, []);
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
	releaseActiveUtterance();
	activeReading = null;
	stateSnapshot = IDLE_STATE;
	preferencesSnapshot = DEFAULT_READ_ALOUD_PREFERENCES;
	voicesSnapshot = [];
	preferencesInitialized = false;
	stateSubscribers.clear();
	preferenceSubscribers.clear();
	voiceSubscribers.clear();
}
