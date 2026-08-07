import { useEffect, useRef, useSyncExternalStore } from "react";
import { uid } from "#/lib/utils";
import type { RealtimeMode, ServerMessage } from "#/server/protocol";
import * as wsStore from "./wsStore";

export type CodexRealtimePhase =
	| "idle"
	| "starting"
	| "connected"
	| "stopping"
	| "error";

export type CodexRealtimeState = {
	phase: CodexRealtimePhase;
	mode: RealtimeMode | null;
	transcript: string;
	error: string | null;
	unavailableReason: string | null;
	liveMicrophoneMuted: boolean;
};

export function isCodexRealtimeUnavailable(message: string | null): boolean {
	return (
		(message?.includes(
			"Codex realtime voice is not available for this ChatGPT account",
		) ??
			false) ||
		Boolean(
			message &&
				/unexpected status 404 Not Found/i.test(message) &&
				/backend-api\/codex\/realtime\/calls/i.test(message),
		)
	);
}

type ClientContext = {
	sessionId: string;
	agentCwd?: string;
	providerId: string;
	voice: string;
	onDictation: (text: string) => void;
	onLiveClosed?: () => void;
};

type ReadAloudCallbacks = {
	onPlaying: () => void;
	onEnded: () => void;
	onError: (message: string) => void;
};

type ReadAloudAudioOutput = {
	context: AudioContext;
	resume: Promise<boolean>;
};

type ActiveSession = {
	generation: number;
	requestId: string;
	sessionId: string;
	mode: RealtimeMode;
	pc: RTCPeerConnection;
	dataChannel: RTCDataChannel | null;
	dataChannelOpen?: boolean;
	stream: MediaStream | null;
	audio: HTMLAudioElement;
	audioContext?: AudioContext;
	readAloudInputSource?: OscillatorNode;
	readAloudInputGain?: GainNode;
	readAloudInputDestination?: MediaStreamAudioDestinationNode;
	remoteAudioTrack?: MediaStreamTrack;
	remoteAudioUnmuteHandler?: () => void;
	remoteAudioUnmuted?: boolean;
	readAloudRemoteStream?: MediaStream;
	readAloud?: ReadAloudCallbacks;
	pendingSpeech?: string;
	readAloudWordCount?: number;
	remoteDescriptionSet?: boolean;
	appServerReady?: boolean;
	browserSessionReady?: boolean;
	speechSent?: boolean;
	readAloudPlayingNotified?: boolean;
	readAloudSettled?: boolean;
	onLiveClosed?: () => void;
	liveClosedNotified?: boolean;
	stopRequested?: boolean;
	transportReleased?: boolean;
	audioPlaying?: boolean;
	audioDrained?: boolean;
	outputAudioStarted?: boolean;
	outputAudioStopped?: boolean;
	outputAudioStartedAt?: number;
	outputStartTimer?: ReturnType<typeof setTimeout>;
	playbackCompletionTimer?: ReturnType<typeof setTimeout>;
	outputStoppedTimer?: ReturnType<typeof setTimeout>;
	playbackStartTimer?: ReturnType<typeof setTimeout>;
	playoutStatsTimer?: ReturnType<typeof setTimeout>;
	playoutStatsPolling?: boolean;
	playoutStatsLastEmittedCount?: number;
	playoutStatsStableSince?: number;
	readAloudReadyTimer?: ReturnType<typeof setTimeout>;
	negotiationTimer?: ReturnType<typeof setTimeout>;
	onDictation?: (text: string) => void;
	dictationSegments?: string[];
	dictationDraft?: string;
	dictationSettled?: boolean;
	dictationClosed?: boolean;
	dictationStopTimer?: ReturnType<typeof setTimeout>;
	dictationStopDelayTimer?: ReturnType<typeof setTimeout>;
	dictationInputStopTimer?: ReturnType<typeof setTimeout>;
	dictationDraining?: boolean;
	inputTracksMuted?: boolean;
	inputTracksStopped?: boolean;
	liveMicrophoneMuted: boolean;
};

const READ_ALOUD_OUTPUT_START_TIMEOUT_MS = 12_000;
const READ_ALOUD_PLAYBACK_START_TIMEOUT_MS = 5_000;
const READ_ALOUD_PLAYOUT_STATS_POLL_MS = 200;
const READ_ALOUD_PLAYOUT_STATS_STABLE_MS = 800;
const READ_ALOUD_OUTPUT_STOP_GRACE_MS = 1_000;
const READ_ALOUD_PLAYOUT_FALLBACK_MIN_MS = 3_000;
const READ_ALOUD_PLAYOUT_FALLBACK_MAX_MS = 60_000;
const READ_ALOUD_READY_TIMEOUT_MS = 8_000;
const REALTIME_NEGOTIATION_TIMEOUT_MS = 20_000;
const DICTATION_STOP_TIMEOUT_MS = 15_000;
const DICTATION_INPUT_DRAIN_GRACE_MS = 750;
const DICTATION_NATIVE_STOP_FALLBACK_MS = 8_000;
const DICTATION_CLOSE_TAIL_GRACE_MS = 1_000;

const IDLE_STATE: CodexRealtimeState = {
	phase: "idle",
	mode: null,
	transcript: "",
	error: null,
	unavailableReason: null,
	liveMicrophoneMuted: false,
};

let snapshot = IDLE_STATE;
let context: ClientContext | null = null;
let active: ActiveSession | null = null;
let generation = 0;
let unavailableReason: string | null = null;
let subscribed = false;
let unsubscribeMessage: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;
let lastWsStatus: ReturnType<typeof wsStore.getSnapshot>["wsStatus"] | null =
	null;
const subscribers = new Set<() => void>();

function publish(next: CodexRealtimeState): void {
	snapshot = next;
	for (const subscriber of subscribers) subscriber();
}

function notifyLiveClosed(session: ActiveSession): void {
	if (session.mode !== "live" || session.liveClosedNotified) return;
	session.liveClosedNotified = true;
	session.onLiveClosed?.();
}

function muteInputTracks(session: ActiveSession): void {
	session.inputTracksMuted = true;
	for (const track of session.stream?.getTracks() ?? []) track.enabled = false;
}

function applyLiveMicrophoneState(session: ActiveSession): void {
	if (session.mode !== "live") return;
	for (const track of session.stream?.getTracks() ?? []) {
		track.enabled = !session.liveMicrophoneMuted;
	}
}

function toggleCodexLiveMicrophone(): void {
	const session = active;
	if (
		!session ||
		session.mode !== "live" ||
		session.stopRequested ||
		session.transportReleased
	) {
		return;
	}
	session.liveMicrophoneMuted = !session.liveMicrophoneMuted;
	applyLiveMicrophoneState(session);
	publish({
		...snapshot,
		liveMicrophoneMuted: session.liveMicrophoneMuted,
	});
}

function stopInputTracks(session: ActiveSession): void {
	if (session.inputTracksStopped) return;
	session.inputTracksStopped = true;
	for (const track of session.stream?.getTracks() ?? []) track.stop();
}

function closeAudioContext(audioContext: AudioContext): void {
	if (audioContext.state === "closed") return;
	try {
		void audioContext.close().catch(() => {
			// The context is already detached from the session. A browser rejecting
			// close during teardown must not become an unhandled promise rejection.
		});
	} catch {
		// Older WebViews can throw synchronously while their audio service exits.
	}
}

function releaseReadAloudInput(session: ActiveSession): void {
	if (session.remoteAudioTrack && session.remoteAudioUnmuteHandler) {
		session.remoteAudioTrack.removeEventListener(
			"unmute",
			session.remoteAudioUnmuteHandler,
		);
	}
	session.remoteAudioTrack = undefined;
	session.remoteAudioUnmuteHandler = undefined;
	session.remoteAudioUnmuted = undefined;
	session.readAloudRemoteStream = undefined;
	try {
		session.readAloudInputSource?.stop();
	} catch {
		// The source may not have reached start if setup failed partway through.
	}
	try {
		session.readAloudInputSource?.disconnect();
	} catch {}
	try {
		session.readAloudInputGain?.disconnect();
	} catch {}
	session.readAloudInputSource = undefined;
	session.readAloudInputGain = undefined;
	session.readAloudInputDestination = undefined;
}

function attachSilentReadAloudInput(session: ActiveSession): void {
	const audioContext = session.audioContext;
	if (!audioContext) {
		throw new Error("Codex read aloud requires browser audio support.");
	}
	const source = audioContext.createOscillator();
	const gain = audioContext.createGain();
	const destination = audioContext.createMediaStreamDestination();
	const track = destination.stream.getAudioTracks()[0];
	if (!track) {
		source.disconnect();
		gain.disconnect();
		throw new Error("Codex read aloud could not create its audio connection.");
	}

	// AVAS acknowledges standalone speakable text but does not create an output
	// turn for a receive-only or trackless peer. A live zero-gain track keeps the
	// connection bidirectional without opening the microphone or making sound.
	source.frequency.value = 440;
	gain.gain.value = 0;
	source.connect(gain);
	gain.connect(destination);
	session.readAloudInputSource = source;
	session.readAloudInputGain = gain;
	session.readAloudInputDestination = destination;
	session.stream = destination.stream;
	source.start();
	session.pc.addTrack(track, destination.stream);
}

function primeReadAloudMediaElement(session: ActiveSession): void {
	const stream = session.readAloudInputDestination?.stream;
	if (!stream) return;
	// Start this exact element while the user's tap still owns transient activation.
	// Its source is zero-gain, so priming is inaudible. The negotiated remote stream
	// replaces it later without relying on a second autoplay-gated interaction.
	session.audio.muted = false;
	session.audio.volume = 1;
	session.audio.srcObject = stream;
	try {
		void session.audio.play().catch(() => {
			// Some browsers do not need priming and reject the silent source. The
			// remote play attempt remains authoritative and reports a useful error.
		});
	} catch {
		// Older WebViews can throw synchronously for a not-yet-live MediaStream.
	}
}

function createReadAloudAudioOutput(): ReadAloudAudioOutput | null {
	if (typeof window === "undefined") return null;
	const AudioContextConstructor =
		window.AudioContext ??
		(window as Window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;
	if (!AudioContextConstructor) return null;
	try {
		const audioContext = new AudioContextConstructor();
		let resume: Promise<boolean>;
		try {
			// Calling resume before openSession reaches its first await preserves the
			// tap's transient activation on Chrome Android. This context only produces
			// the zero-gain outbound track; the remote stream uses an audio element.
			resume = Promise.resolve(audioContext.resume()).then(
				() => audioContext.state === "running",
				() => audioContext.state === "running",
			);
		} catch {
			resume = Promise.resolve(audioContext.state === "running");
		}
		return { context: audioContext, resume };
	} catch {
		return null;
	}
}

function releaseTransport(session: ActiveSession): void {
	if (session.transportReleased) return;
	session.transportReleased = true;
	if (session.dictationStopDelayTimer !== undefined) {
		clearTimeout(session.dictationStopDelayTimer);
		session.dictationStopDelayTimer = undefined;
	}
	if (session.dictationInputStopTimer !== undefined) {
		clearTimeout(session.dictationInputStopTimer);
		session.dictationInputStopTimer = undefined;
	}
	if (session.playbackCompletionTimer !== undefined)
		clearTimeout(session.playbackCompletionTimer);
	if (session.outputStoppedTimer !== undefined)
		clearTimeout(session.outputStoppedTimer);
	if (session.playbackStartTimer !== undefined)
		clearTimeout(session.playbackStartTimer);
	if (session.outputStartTimer !== undefined)
		clearTimeout(session.outputStartTimer);
	if (session.playoutStatsTimer !== undefined)
		clearTimeout(session.playoutStatsTimer);
	if (session.readAloudReadyTimer !== undefined)
		clearTimeout(session.readAloudReadyTimer);
	if (session.negotiationTimer !== undefined)
		clearTimeout(session.negotiationTimer);
	releaseReadAloudInput(session);
	stopInputTracks(session);
	if (session.dataChannel) {
		session.dataChannel.onopen = null;
		session.dataChannel.onmessage = null;
	}
	if (session.audioContext) {
		closeAudioContext(session.audioContext);
		session.audioContext = undefined;
	}
	session.audio.onplaying = null;
	session.audio.onerror = null;
	session.audio.pause();
	session.audio.srcObject = null;
	session.pc.close();
}

function finishDrainedReadAloud(session: ActiveSession): void {
	if (
		active !== session ||
		session.mode !== "read-aloud" ||
		session.stopRequested
	)
		return;
	if (session.readAloudSettled) return;
	session.readAloudSettled = true;
	session.readAloud?.onEnded();
	stopCodexRealtime();
}

function fallbackPlayoutWaitMs(session: ActiveSession): number {
	const estimatedSpeechMs =
		Math.max(1, session.readAloudWordCount ?? 0) * 500 + 2_000;
	const elapsed = session.outputAudioStartedAt
		? Date.now() - session.outputAudioStartedAt
		: 0;
	return Math.min(
		READ_ALOUD_PLAYOUT_FALLBACK_MAX_MS,
		Math.max(READ_ALOUD_PLAYOUT_FALLBACK_MIN_MS, estimatedSpeechMs - elapsed),
	);
}

function schedulePlaybackCompletionFallback(session: ActiveSession): void {
	if (active !== session || session.stopRequested) return;
	if (session.playbackCompletionTimer !== undefined) return;
	session.playbackCompletionTimer = setTimeout(() => {
		session.playbackCompletionTimer = undefined;
		finishDrainedReadAloud(session);
	}, fallbackPlayoutWaitMs(session));
}

function scheduleOutputStoppedCompletion(session: ActiveSession): void {
	if (
		active !== session ||
		session.stopRequested ||
		session.outputStoppedTimer !== undefined
	)
		return;
	session.outputStoppedTimer = setTimeout(() => {
		session.outputStoppedTimer = undefined;
		finishDrainedReadAloud(session);
	}, READ_ALOUD_OUTPUT_STOP_GRACE_MS);
}

async function readJitterBufferEmittedCount(
	session: ActiveSession,
): Promise<number | null> {
	let found = false;
	let total = 0;
	for (const receiver of session.pc.getReceivers?.() ?? []) {
		try {
			const report = await receiver.getStats();
			report.forEach((stat) => {
				const row = stat as unknown as Record<string, unknown>;
				if (row.type !== "inbound-rtp" || row.isRemote === true) return;
				const kind = row.kind ?? row.mediaType;
				if (kind !== undefined && kind !== "audio") return;
				const count = row.jitterBufferEmittedCount;
				if (typeof count !== "number" || !Number.isFinite(count)) return;
				found = true;
				total += count;
			});
		} catch {
			// Some browser/WebView builds expose getStats but reject after a track
			// transition. The bounded duration fallback remains authoritative there.
		}
	}
	return found ? total : null;
}

function schedulePlayoutStatsPoll(session: ActiveSession): void {
	if (
		active !== session ||
		session.stopRequested ||
		session.playoutStatsTimer !== undefined ||
		session.playoutStatsPolling
	)
		return;
	session.playoutStatsTimer = setTimeout(() => {
		session.playoutStatsTimer = undefined;
		if (active !== session || session.stopRequested) return;
		session.playoutStatsPolling = true;
		void readJitterBufferEmittedCount(session)
			.then((count) => {
				if (active !== session || session.stopRequested || count === null)
					return;
				const now = Date.now();
				if (count <= 0) {
					session.playoutStatsStableSince = undefined;
				} else if (session.playoutStatsLastEmittedCount === count) {
					session.playoutStatsStableSince ??= now;
					if (
						now - session.playoutStatsStableSince >=
						READ_ALOUD_PLAYOUT_STATS_STABLE_MS
					) {
						finishDrainedReadAloud(session);
						return;
					}
				} else {
					session.playoutStatsStableSince = undefined;
				}
				session.playoutStatsLastEmittedCount = count;
			})
			.finally(() => {
				session.playoutStatsPolling = false;
				if (active === session && !session.stopRequested) {
					schedulePlayoutStatsPoll(session);
				}
			});
	}, READ_ALOUD_PLAYOUT_STATS_POLL_MS);
}

function scheduleDrainedReadAloud(session: ActiveSession): void {
	if (
		active !== session ||
		session.mode !== "read-aloud" ||
		!session.audioDrained ||
		!session.outputAudioStarted ||
		!session.remoteAudioUnmuted ||
		session.stopRequested
	)
		return;
	if (!session.audioPlaying) {
		if (session.playbackStartTimer !== undefined) return;
		session.playbackStartTimer = setTimeout(() => {
			session.playbackStartTimer = undefined;
			if (active === session && !session.audioPlaying)
				fail(session, "Codex read aloud did not start playing.");
		}, READ_ALOUD_PLAYBACK_START_TIMEOUT_MS);
		return;
	}
	if (session.playbackStartTimer !== undefined) {
		clearTimeout(session.playbackStartTimer);
		session.playbackStartTimer = undefined;
	}
	if (session.outputAudioStopped) {
		scheduleOutputStoppedCompletion(session);
		return;
	}
	schedulePlaybackCompletionFallback(session);
	schedulePlayoutStatsPoll(session);
}

type RealtimeDataEvent = {
	type: string;
	sessionId: string | null;
	role: "user" | "assistant" | null;
};

function parseRealtimeDataEvent(data: unknown): RealtimeDataEvent | null {
	if (typeof data !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(data);
		if (!parsed || typeof parsed !== "object") return null;
		const message = parsed as {
			type?: unknown;
			session?: { id?: unknown };
			role?: unknown;
			turn?: { role?: unknown };
		};
		if (typeof message.type !== "string") return null;
		const candidateRole =
			message.type === "turn.done"
				? (message.turn?.role ?? message.role)
				: (message.role ?? message.turn?.role);
		return {
			type: message.type,
			sessionId:
				typeof message.session?.id === "string" && message.session.id
					? message.session.id
					: null,
			role:
				candidateRole === "user" || candidateRole === "assistant"
					? candidateRole
					: null,
		};
	} catch {
		return null;
	}
}

function markSessionConnected(session: ActiveSession): void {
	if (
		active !== session ||
		session.stopRequested ||
		!session.remoteDescriptionSet
	) {
		return;
	}
	// The app-server can report thread/realtime/started before the browser's V3
	// realtime session has finished opening. Read aloud must wait for the latter;
	// sending speech at the app-server boundary races and silently drops the turn.
	scheduleReadAloudReadyTimeout(session);
	const ready =
		session.mode === "read-aloud"
			? session.dataChannelOpen && session.browserSessionReady
			: session.mode === "dictation"
				? session.dataChannelOpen &&
					(session.appServerReady || session.browserSessionReady)
				: session.appServerReady || session.browserSessionReady;
	if (!ready) {
		return;
	}
	if (session.negotiationTimer !== undefined) {
		clearTimeout(session.negotiationTimer);
		session.negotiationTimer = undefined;
	}
	if (snapshot.phase === "starting") {
		publish({
			...snapshot,
			phase: "connected",
			mode: session.mode,
			error: null,
		});
	}
	sendPendingReadAloudSpeech(session);
}

function handleRealtimeDataOpen(session: ActiveSession): void {
	if (active !== session || session.stopRequested) return;
	session.dataChannelOpen = true;
	markSessionConnected(session);
}

function notifyReadAloudPlaying(session: ActiveSession): void {
	if (
		active !== session ||
		session.mode !== "read-aloud" ||
		!session.audioPlaying ||
		!session.remoteAudioUnmuted ||
		!session.speechSent ||
		!session.outputAudioStarted ||
		session.readAloudPlayingNotified
	) {
		return;
	}
	session.readAloudPlayingNotified = true;
	session.readAloud?.onPlaying();
	// V3 normally supplies turn.done, but a lost terminal event must not leave
	// the message control in Stop forever after real playback has begun.
	schedulePlaybackCompletionFallback(session);
}

function markLocalAudioPlaying(session: ActiveSession): void {
	if (
		active !== session ||
		session.mode !== "read-aloud" ||
		!session.readAloudRemoteStream ||
		session.audio.srcObject !== session.readAloudRemoteStream
	)
		return;
	session.audioPlaying = true;
	notifyReadAloudPlaying(session);
	scheduleDrainedReadAloud(session);
}

function playReadAloudWithMediaElement(
	session: ActiveSession,
	stream: MediaStream,
): void {
	if (active !== session || session.mode !== "read-aloud") return;
	session.audio.pause();
	session.audioPlaying = false;
	session.readAloudRemoteStream = stream;
	session.audio.muted = false;
	session.audio.volume = 1;
	session.audio.srcObject = stream;
	void session.audio.play().catch((error) => {
		if (active !== session || session.mode !== "read-aloud") return;
		fail(
			session,
			error instanceof Error
				? `Codex read aloud playback failed: ${error.message}`
				: "Codex read aloud playback failed.",
		);
	});
}

function markReadAloudOutputStarted(session: ActiveSession): void {
	if (
		active !== session ||
		session.mode !== "read-aloud" ||
		!session.speechSent
	) {
		return;
	}
	session.outputAudioStarted = true;
	session.outputAudioStartedAt ??= Date.now();
	if (session.outputStartTimer !== undefined) {
		clearTimeout(session.outputStartTimer);
		session.outputStartTimer = undefined;
	}
	notifyReadAloudPlaying(session);
	if (
		(!session.audioPlaying || !session.remoteAudioUnmuted) &&
		session.playbackStartTimer === undefined
	) {
		session.playbackStartTimer = setTimeout(() => {
			session.playbackStartTimer = undefined;
			if (
				active === session &&
				(!session.audioPlaying || !session.remoteAudioUnmuted)
			) {
				fail(session, "Codex read aloud did not start playing.");
			}
		}, READ_ALOUD_PLAYBACK_START_TIMEOUT_MS);
	}
	scheduleDrainedReadAloud(session);
}

function sendPendingReadAloudSpeech(session: ActiveSession): void {
	if (
		active !== session ||
		session.mode !== "read-aloud" ||
		session.stopRequested ||
		!session.remoteDescriptionSet ||
		!session.dataChannelOpen ||
		!session.browserSessionReady ||
		!session.pendingSpeech
	) {
		return;
	}
	const accepted = wsStore.send({
		type: "realtime_speak",
		session_id: session.sessionId,
		request_id: session.requestId,
		mode: "read-aloud",
		text: session.pendingSpeech,
	});
	if (!accepted) {
		fail(session, "Codex read aloud lost its Hlid connection.");
		return;
	}
	session.pendingSpeech = undefined;
	session.speechSent = true;
	session.audioDrained = false;
	session.outputAudioStarted = false;
	session.outputAudioStopped = false;
	notifyReadAloudPlaying(session);
	session.outputStartTimer = setTimeout(() => {
		session.outputStartTimer = undefined;
		if (active === session && !session.outputAudioStarted) {
			fail(session, "Codex read aloud did not start producing audio.");
		}
	}, READ_ALOUD_OUTPUT_START_TIMEOUT_MS);
	if (session.readAloudReadyTimer !== undefined) {
		clearTimeout(session.readAloudReadyTimer);
		session.readAloudReadyTimer = undefined;
	}
}

function scheduleReadAloudReadyTimeout(session: ActiveSession): void {
	if (
		active !== session ||
		session.mode !== "read-aloud" ||
		session.stopRequested ||
		session.speechSent ||
		session.readAloudReadyTimer !== undefined
	) {
		return;
	}
	session.readAloudReadyTimer = setTimeout(() => {
		session.readAloudReadyTimer = undefined;
		if (active === session && !session.speechSent) {
			fail(session, "Codex read aloud did not become ready.");
		}
	}, READ_ALOUD_READY_TIMEOUT_MS);
}

function handleRealtimeDataMessage(
	session: ActiveSession,
	event: MessageEvent,
): void {
	if (active !== session) return;
	const message = parseRealtimeDataEvent(event.data);
	const type = message?.type ?? null;
	if (type === "session.started" || type === "session.updated") {
		if (session.mode !== "dictation" || message?.sessionId) {
			session.browserSessionReady = true;
			markSessionConnected(session);
		}
		return;
	}
	if (session.mode === "dictation") return;
	if (session.mode !== "read-aloud") return;
	if (
		(type === "output_audio.delta" || type === "output_audio_buffer.started") &&
		session.speechSent
	) {
		// Older realtime transports expose output-buffer events on the browser
		// data channel. V3 exposes output_audio.delta here as well as the
		// correlated app-server realtime_audio fallback.
		markReadAloudOutputStarted(session);
		return;
	}
	if (
		type === "turn.done" &&
		message?.role === "assistant" &&
		session.speechSent
	) {
		session.audioDrained = true;
		session.outputAudioStopped = true;
		scheduleDrainedReadAloud(session);
		return;
	}
	if (type !== "output_audio_buffer.stopped" || !session.speechSent) return;
	session.audioDrained = true;
	session.outputAudioStopped = true;
	scheduleDrainedReadAloud(session);
}

function release(session: ActiveSession): void {
	if (session.dictationStopTimer !== undefined) {
		clearTimeout(session.dictationStopTimer);
		session.dictationStopTimer = undefined;
	}
	releaseTransport(session);
	if (active === session) active = null;
	notifyLiveClosed(session);
}

function normalizeDictationText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function finalizedDictationText(session: ActiveSession): string {
	return normalizeDictationText((session.dictationSegments ?? []).join(" "));
}

function visibleDictationText(session: ActiveSession): string {
	return normalizeDictationText(
		[finalizedDictationText(session), session.dictationDraft ?? ""]
			.filter(Boolean)
			.join(" "),
	);
}

function promoteDictationDraft(session: ActiveSession): void {
	const draft = normalizeDictationText(session.dictationDraft ?? "");
	session.dictationDraft = "";
	if (draft) session.dictationSegments?.push(draft);
}

function finishDictation(session: ActiveSession): void {
	if (
		active !== session ||
		session.mode !== "dictation" ||
		session.dictationSettled
	) {
		return;
	}
	const text = finalizedDictationText(session);
	if (!text) {
		fail(session, "Codex dictation ended without a transcript.", false);
		return;
	}
	session.dictationSettled = true;
	const onDictation = session.onDictation;
	release(session);
	publish(IDLE_STATE);
	onDictation?.(text);
}

function scheduleDictationStopTimeout(session: ActiveSession): void {
	if (
		active !== session ||
		session.mode !== "dictation" ||
		session.dictationStopTimer !== undefined
	) {
		return;
	}
	session.dictationStopTimer = setTimeout(() => {
		session.dictationStopTimer = undefined;
		if (active !== session || session.dictationSettled) return;
		const message = visibleDictationText(session)
			? "Codex dictation did not finish closing after transcription."
			: "Codex dictation did not return a transcript before timing out.";
		fail(session, message, false);
	}, DICTATION_STOP_TIMEOUT_MS);
}

function scheduleDictationCloseTailGrace(session: ActiveSession): void {
	if (active !== session || session.mode !== "dictation") return;
	if (session.dictationStopTimer !== undefined) {
		clearTimeout(session.dictationStopTimer);
	}
	session.dictationStopTimer = setTimeout(() => {
		session.dictationStopTimer = undefined;
		if (active !== session || session.dictationSettled) return;
		promoteDictationDraft(session);
		if (finalizedDictationText(session)) {
			finishDictation(session);
			return;
		}
		fail(session, "Codex dictation ended without a transcript.", false);
	}, DICTATION_CLOSE_TAIL_GRACE_MS);
}

function scheduleDictationNativeStop(session: ActiveSession): void {
	if (
		active !== session ||
		session.mode !== "dictation" ||
		session.stopRequested ||
		session.dictationStopDelayTimer !== undefined
	) {
		return;
	}
	session.dictationStopDelayTimer = setTimeout(() => {
		session.dictationStopDelayTimer = undefined;
		if (active !== session || session.dictationSettled) return;
		requestStop(session);
	}, DICTATION_NATIVE_STOP_FALLBACK_MS);
}

function scheduleDictationInputStop(session: ActiveSession): void {
	if (
		active !== session ||
		session.mode !== "dictation" ||
		session.inputTracksStopped ||
		session.dictationInputStopTimer !== undefined
	) {
		return;
	}
	session.dictationInputStopTimer = setTimeout(() => {
		session.dictationInputStopTimer = undefined;
		if (active === session && !session.dictationSettled)
			stopInputTracks(session);
	}, DICTATION_INPUT_DRAIN_GRACE_MS);
}

function sendStop(session: ActiveSession): void {
	const message = {
		type: "realtime_stop" as const,
		session_id: session.sessionId,
		mode: session.mode,
		request_id: session.requestId,
	};
	wsStore.send(message);
}

function requestStop(session: ActiveSession): void {
	if (session.stopRequested) return;
	if (session.mode === "dictation") {
		if (session.dictationStopDelayTimer !== undefined) {
			clearTimeout(session.dictationStopDelayTimer);
			session.dictationStopDelayTimer = undefined;
		}
		stopInputTracks(session);
	}
	session.stopRequested = true;
	sendStop(session);
}

function fail(
	session: ActiveSession,
	message: string,
	requestNativeStop = true,
): void {
	if (active !== session || session.generation !== generation) return;
	if (isCodexRealtimeUnavailable(message)) {
		unavailableReason =
			"Codex realtime voice is unavailable for this account or backend. Restart Hlid after changing Codex authentication or version to check again.";
	}
	if (!session.readAloudSettled) {
		session.readAloudSettled = true;
		session.readAloud?.onError(message);
	}
	// An unsolicited error may not mean Codex tore down the native transport.
	// A stop acknowledgement error is already correlated by the active session,
	// so requestStop remains safely idempotent in both cases.
	if (requestNativeStop) requestStop(session);
	release(session);
	publish({
		phase: "error",
		mode: session.mode,
		transcript: "",
		error: message,
		unavailableReason,
		liveMicrophoneMuted: false,
	});
}

function messageMatches(
	message: Extract<
		ServerMessage,
		{
			type:
				| "realtime_state"
				| "realtime_sdp"
				| "realtime_audio"
				| "realtime_transcript"
				| "realtime_error";
		}
	>,
	session: ActiveSession,
): boolean {
	const requestId = (message as typeof message & { request_id?: string })
		.request_id;
	return (
		message.session_id === session.sessionId &&
		message.mode === session.mode &&
		(requestId === undefined || requestId === session.requestId)
	);
}

function handleMessage(message: ServerMessage): void {
	const session = active;
	if (!session) return;
	if (
		message.type !== "realtime_state" &&
		message.type !== "realtime_sdp" &&
		message.type !== "realtime_audio" &&
		message.type !== "realtime_transcript" &&
		message.type !== "realtime_error"
	)
		return;
	if (!messageMatches(message, session)) return;

	if (message.type === "realtime_error") {
		fail(session, message.message);
		return;
	}
	if (message.type === "realtime_audio") {
		if (message.state === "started") markReadAloudOutputStarted(session);
		return;
	}
	if (message.type === "realtime_sdp") {
		if (session.stopRequested) return;
		void session.pc
			.setRemoteDescription({ type: "answer", sdp: message.sdp })
			.then(() => {
				if (active !== session || session.stopRequested) return;
				session.remoteDescriptionSet = true;
				markSessionConnected(session);
			})
			.catch((error) => {
				if (session.stopRequested) return;
				fail(
					session,
					error instanceof Error
						? `Codex voice negotiation failed: ${error.message}`
						: "Codex voice negotiation failed",
				);
			});
		return;
	}
	if (message.type === "realtime_state") {
		if (message.state === "connected") {
			session.appServerReady = true;
			markSessionConnected(session);
			return;
		}
		if (message.state === "closed") {
			if (session.mode === "dictation") {
				session.dictationClosed = true;
				promoteDictationDraft(session);
				if (finalizedDictationText(session)) {
					finishDictation(session);
				} else {
					publish({
						...snapshot,
						phase: "stopping",
						mode: "dictation",
						error: null,
					});
					scheduleDictationCloseTailGrace(session);
				}
				return;
			}
			if (
				session.mode === "read-aloud" &&
				!session.stopRequested &&
				!session.readAloudSettled
			) {
				fail(
					session,
					"Codex read aloud ended before playback completed.",
					false,
				);
				return;
			}
			release(session);
			publish(IDLE_STATE);
		}
		return;
	}
	if (session.mode === "live") {
		// Raven's chat reducer owns Live transcript bubbles. This store retains a
		// single transcript only for one-shot dictation/read-aloud lifecycles.
		return;
	}
	if (session.mode === "dictation") {
		if (message.role === "assistant") return;
		if (!message.done) {
			session.dictationDraft = `${session.dictationDraft ?? ""}${message.text}`;
			publish({ ...snapshot, transcript: visibleDictationText(session) });
			return;
		}
		const segment = normalizeDictationText(
			message.text || session.dictationDraft || "",
		);
		session.dictationDraft = "";
		if (segment) session.dictationSegments?.push(segment);
		publish({ ...snapshot, transcript: finalizedDictationText(session) });
		if (session.dictationDraining) requestStop(session);
		if (session.dictationClosed && segment) finishDictation(session);
		return;
	}

	if (!message.done) {
		publish({
			...snapshot,
			transcript: `${snapshot.transcript}${message.text}`,
		});
		return;
	}
	publish({ ...snapshot, transcript: message.text });
	if (session.mode === "read-aloud" && message.role === "assistant") {
		// V3 turn.done becomes the assistant transcript final. Generation has
		// drained at this point, but the browser jitter buffer may still be playing.
		session.audioDrained = true;
		session.outputAudioStopped = true;
		scheduleDrainedReadAloud(session);
		return;
	}
}

function ensureSubscribed(): void {
	if (subscribed || typeof window === "undefined") return;
	subscribed = true;
	lastWsStatus = wsStore.getSnapshot().wsStatus;
	unsubscribeMessage = wsStore.subscribeMessage(handleMessage);
	unsubscribeStatus = wsStore.subscribeStatus(() => {
		const nextStatus = wsStore.getSnapshot().wsStatus;
		const reconnected =
			nextStatus === "connected" && lastWsStatus !== "connected";
		lastWsStatus = nextStatus;
		const session = active;
		if (reconnected && session?.stopRequested) {
			sendStop(session);
		}
	});
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
	if (pc.iceGatheringState === "complete") return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			pc.removeEventListener("icegatheringstatechange", check);
			resolve();
		};
		const check = () => {
			if (pc.iceGatheringState === "complete") finish();
		};
		pc.addEventListener("icegatheringstatechange", check);
		setTimeout(finish, 2_000);
	});
}

async function openSession(
	mode: RealtimeMode,
	readAloud?: ReadAloudCallbacks,
	pendingSpeech?: string,
): Promise<void> {
	ensureSubscribed();
	if (snapshot.unavailableReason) throw new Error(snapshot.unavailableReason);
	const current = context;
	if (!current?.sessionId) throw new Error("No Raven session is active.");
	if (current.providerId !== "codex")
		throw new Error("Codex voice requires a native Codex session.");
	if (active?.mode === "live") {
		stopCodexRealtime();
		throw new Error("Raven Live is stopping. Wait for it to close.");
	}
	if (active?.mode === "dictation") {
		stopCodexRealtime();
		throw new Error("Codex dictation is stopping. Wait for it to finish.");
	}
	stopCodexRealtime();

	const currentGeneration = ++generation;
	const pc = new RTCPeerConnection();
	const audio = document.createElement("audio");
	audio.autoplay = true;
	audio.setAttribute("playsinline", "");
	// This must remain before openSession's first await. Chrome Android consumes
	// transient user activation before the asynchronously negotiated track arrives.
	const audioOutput =
		mode === "read-aloud" ? createReadAloudAudioOutput() : null;
	let stream: MediaStream | null = null;
	const session: ActiveSession = {
		generation: currentGeneration,
		requestId: uid(),
		sessionId: current.sessionId,
		mode,
		pc,
		dataChannel: null,
		stream,
		audio,
		...(audioOutput
			? {
					audioContext: audioOutput.context,
				}
			: {}),
		readAloud,
		pendingSpeech,
		liveMicrophoneMuted: false,
		...(mode === "dictation"
			? {
					onDictation: current.onDictation,
					dictationSegments: [],
					dictationDraft: "",
				}
			: {}),
		...(pendingSpeech
			? {
					readAloudWordCount: pendingSpeech.trim().split(/\s+/).filter(Boolean)
						.length,
				}
			: {}),
		onLiveClosed: current.onLiveClosed,
	};
	active = session;
	publish({ ...IDLE_STATE, phase: "starting", mode });
	try {
		if (mode === "read-aloud") {
			if (!audioOutput) {
				throw new Error("Codex read aloud could not start browser audio.");
			}
			attachSilentReadAloudInput(session);
			primeReadAloudMediaElement(session);
			if (!(await audioOutput.resume)) {
				throw new Error("Codex read aloud could not start browser audio.");
			}
			if (active !== session || session.stopRequested) return;
		} else {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (active !== session || session.stopRequested) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			session.stream = stream;
			if (session.dictationDraining) muteInputTracks(session);
			applyLiveMicrophoneState(session);
			for (const track of stream.getTracks()) pc.addTrack(track, stream);
		}
		const dataChannel = pc.createDataChannel("oai-events");
		session.dataChannel = dataChannel;
		dataChannel.onopen = () => handleRealtimeDataOpen(session);
		dataChannel.onmessage = (event) =>
			handleRealtimeDataMessage(session, event);
		if (dataChannel.readyState === "open") handleRealtimeDataOpen(session);
		pc.ontrack = (event) => {
			if (active !== session || session.mode === "dictation") return;
			const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
			if (session.mode === "read-aloud") {
				if (session.remoteAudioTrack && session.remoteAudioUnmuteHandler) {
					session.remoteAudioTrack.removeEventListener(
						"unmute",
						session.remoteAudioUnmuteHandler,
					);
				}
				const onUnmute = () => {
					session.remoteAudioUnmuted = true;
					markReadAloudOutputStarted(session);
				};
				session.remoteAudioTrack = event.track;
				session.remoteAudioUnmuteHandler = onUnmute;
				session.remoteAudioUnmuted = !event.track.muted;
				event.track.addEventListener("unmute", onUnmute);
				playReadAloudWithMediaElement(session, remoteStream);
				if (session.remoteAudioUnmuted) markReadAloudOutputStarted(session);
				return;
			}
			audio.srcObject = remoteStream;
			void audio.play().catch(() => {
				// Live remains provider-driven; failure here is handled by its transport
				// lifecycle rather than by read-aloud's one-shot error callbacks.
			});
		};
		audio.onplaying = () => {
			markLocalAudioPlaying(session);
		};
		audio.onerror = () => {
			if (active === session && session.mode === "read-aloud") {
				fail(session, "Codex read aloud playback failed.");
			}
		};
		pc.onconnectionstatechange = () => {
			if (
				active === session &&
				!session.stopRequested &&
				(pc.connectionState === "failed" ||
					pc.connectionState === "disconnected")
			)
				fail(session, "Codex voice connection was lost.");
		};
		const offer = await pc.createOffer();
		if (active !== session || session.stopRequested) return;
		await pc.setLocalDescription(offer);
		await waitForIceGathering(pc);
		if (active !== session || session.stopRequested) return;
		const sdp = pc.localDescription?.sdp;
		if (!sdp) throw new Error("The browser did not create a voice offer.");
		const message = {
			type: "realtime_start",
			session_id: current.sessionId,
			mode,
			sdp,
			voice: current.voice,
			request_id: session.requestId,
			...(current.agentCwd ? { agent_cwd: current.agentCwd } : {}),
		} as const;
		if (!wsStore.send(message)) {
			fail(session, "Codex voice could not reach Hlid.");
			return;
		}
		session.negotiationTimer = setTimeout(() => {
			session.negotiationTimer = undefined;
			if (active !== session || session.stopRequested) return;
			if (!session.remoteDescriptionSet) {
				fail(session, "Codex voice negotiation timed out.");
				return;
			}
			if (
				session.mode === "dictation" &&
				!session.appServerReady &&
				!session.browserSessionReady
			) {
				fail(session, "Codex dictation did not become ready.");
			}
		}, REALTIME_NEGOTIATION_TIMEOUT_MS);
	} catch (error) {
		if (active !== session || session.stopRequested) return;
		fail(
			session,
			error instanceof Error ? error.message : "Codex voice could not start.",
		);
		throw error;
	}
}

export function stopCodexRealtime(): void {
	const session = active;
	if (!session) return;
	if (session.mode === "live") {
		requestStop(session);
		releaseTransport(session);
		publish({
			...snapshot,
			phase: "stopping",
			mode: "live",
			transcript: "",
			error: null,
		});
		return;
	}
	if (session.mode === "dictation") {
		if (session.dictationDraining) return;
		session.dictationDraining = true;
		muteInputTracks(session);
		publish({
			...snapshot,
			phase: "stopping",
			mode: "dictation",
			error: null,
		});
		scheduleDictationStopTimeout(session);
		scheduleDictationInputStop(session);
		scheduleDictationNativeStop(session);
		return;
	}
	generation++;
	requestStop(session);
	release(session);
	publish(IDLE_STATE);
}

export function cancelCodexRealtime(): void {
	const session = active;
	if (!session) return;
	if (session.mode === "live") {
		stopCodexRealtime();
		return;
	}
	if (session.mode !== "dictation") return;
	session.dictationSettled = true;
	generation++;
	requestStop(session);
	release(session);
	publish(IDLE_STATE);
}

function forceStopCodexRealtime(): void {
	const session = active;
	if (!session) return;
	generation++;
	requestStop(session);
	release(session);
	publish(IDLE_STATE);
}

export function stopCodexReadAloud(): void {
	if (active?.mode === "read-aloud") stopCodexRealtime();
}

export function clearCodexRealtimeError(): void {
	if (!active && snapshot.phase === "error") {
		publish({ ...IDLE_STATE, unavailableReason });
	}
}

export function startCodexReadAloud(
	text: string,
	callbacks: ReadAloudCallbacks,
): void {
	let errorReported = false;
	const reportError = (message: string) => {
		if (errorReported) return;
		errorReported = true;
		callbacks.onError(message);
	};
	void openSession(
		"read-aloud",
		{ ...callbacks, onError: reportError },
		text,
	).catch((error) =>
		reportError(
			error instanceof Error ? error.message : "Codex read aloud failed.",
		),
	);
}

export function useCodexRealtime(options: ClientContext) {
	const ownedSessionId = useRef(options.sessionId);
	ownedSessionId.current = options.sessionId;
	useEffect(() => {
		const changedSession =
			context !== null && context.sessionId !== options.sessionId;
		context = options;
		ensureSubscribed();
		if (changedSession) forceStopCodexRealtime();
	}, [options]);
	useEffect(
		() => () => {
			const sessionId = ownedSessionId.current;
			if (active?.sessionId === sessionId) forceStopCodexRealtime();
			if (context?.sessionId === sessionId) context = null;
		},
		[],
	);
	const state = useSyncExternalStore(
		(subscriber) => {
			subscribers.add(subscriber);
			return () => subscribers.delete(subscriber);
		},
		() => snapshot,
		() => IDLE_STATE,
	);
	return {
		...state,
		start: (mode: "dictation" | "live") => openSession(mode),
		stop: stopCodexRealtime,
		cancel: cancelCodexRealtime,
		toggleLiveMicrophone: toggleCodexLiveMicrophone,
		clearError: clearCodexRealtimeError,
	};
}

// fallow-ignore-next-line unused-export -- Vitest imports this explicit global-store reset.
export function __resetCodexRealtimeForTesting(): void {
	if (active) release(active);
	context = null;
	generation++;
	unavailableReason = null;
	unsubscribeMessage?.();
	unsubscribeMessage = null;
	unsubscribeStatus?.();
	unsubscribeStatus = null;
	lastWsStatus = null;
	subscribed = false;
	publish(IDLE_STATE);
}
