import { useEffect, useRef, useSyncExternalStore } from "react";
import { uid } from "#/lib/utils";
import type { RealtimeMode, ServerMessage } from "#/server/protocol";
import {
	type CodexDictationLifecycle,
	createCodexDictationLifecycle,
} from "./codexRealtimeDictation";
import {
	type CorrelatedRealtimeMessage,
	matchRealtimeMessage,
	parseRealtimeDataEvent,
} from "./codexRealtimeProtocol";
import {
	type CodexReadAloudLifecycle,
	createCodexReadAloudLifecycle,
	type ReadAloudCallbacks,
} from "./codexRealtimeReadAloud";
import {
	applyMicrophoneMuted,
	attachInputStream,
	bindCodexRealtimeTransport,
	type CodexRealtimeTransport,
	createCodexRealtimeTransport,
	createRealtimeOfferSdp,
	muteInputTracks,
	prepareReadAloudInput,
	releaseCodexRealtimeTransport,
	stopInputTracks,
} from "./codexRealtimeTransport";
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

type ActiveSession = {
	generation: number;
	requestId: string;
	sessionId: string;
	mode: RealtimeMode;
	transport: CodexRealtimeTransport;
	dataChannelOpen?: boolean;
	remoteDescriptionSet?: boolean;
	appServerReady?: boolean;
	browserSessionReady?: boolean;
	onLiveClosed?: () => void;
	liveClosedNotified?: boolean;
	stopRequested?: boolean;
	negotiationTimer?: ReturnType<typeof setTimeout>;
	dictation?: CodexDictationLifecycle;
	readAloud?: CodexReadAloudLifecycle;
	liveMicrophoneMuted: boolean;
};

const REALTIME_NEGOTIATION_TIMEOUT_MS = 20_000;

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

function applyLiveMicrophoneState(session: ActiveSession): void {
	if (session.mode !== "live") return;
	applyMicrophoneMuted(session.transport, session.liveMicrophoneMuted);
}

function toggleCodexLiveMicrophone(): void {
	const session = active;
	if (
		!session ||
		session.mode !== "live" ||
		session.stopRequested ||
		session.transport.released
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

function releaseSessionTransport(session: ActiveSession): void {
	if (session.transport.released) return;
	session.dictation?.dispose();
	session.readAloud?.dispose();
	if (session.negotiationTimer !== undefined) {
		clearTimeout(session.negotiationTimer);
		session.negotiationTimer = undefined;
	}
	releaseCodexRealtimeTransport(session.transport);
}

function release(session: ActiveSession): void {
	releaseSessionTransport(session);
	if (active === session) active = null;
	notifyLiveClosed(session);
}

function sendStop(session: ActiveSession): void {
	wsStore.send({
		type: "realtime_stop",
		session_id: session.sessionId,
		mode: session.mode,
		request_id: session.requestId,
	});
}

function requestStop(session: ActiveSession): void {
	if (session.stopRequested) return;
	if (session.mode === "dictation") {
		session.dictation?.beforeNativeStop();
		stopInputTracks(session.transport);
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
	session.readAloud?.reportFailure(message);
	// An unsolicited error may not mean Codex tore down the native transport.
	// A correlated stop error is safe because requestStop is idempotent.
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

function markSessionConnected(session: ActiveSession): void {
	if (
		active !== session ||
		session.stopRequested ||
		!session.remoteDescriptionSet
	) {
		return;
	}
	// The app-server can report started before the browser's V3 session opens.
	// Read aloud must wait for that browser boundary before sending its text.
	session.readAloud?.scheduleReadyTimeout();
	const ready =
		session.mode === "read-aloud"
			? session.dataChannelOpen && session.browserSessionReady
			: session.mode === "dictation"
				? session.dataChannelOpen &&
					(session.appServerReady || session.browserSessionReady)
				: session.appServerReady || session.browserSessionReady;
	if (!ready) return;
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
	session.readAloud?.sendPendingSpeech();
}

function handleRealtimeDataOpen(session: ActiveSession): void {
	if (active !== session || session.stopRequested) return;
	session.dataChannelOpen = true;
	markSessionConnected(session);
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
	session.readAloud?.handleDataEvent(message);
}

function bindSessionTransport(session: ActiveSession): void {
	bindCodexRealtimeTransport(session.transport, {
		onDataOpen: () => handleRealtimeDataOpen(session),
		onDataMessage: (event) => handleRealtimeDataMessage(session, event),
		onRemoteTrack: (event) => {
			if (active !== session || session.mode === "dictation") return;
			const stream = event.streams[0] ?? new MediaStream([event.track]);
			if (session.mode === "read-aloud") {
				session.readAloud?.handleRemoteTrack(event.track, stream);
				return;
			}
			session.transport.audio.srcObject = stream;
			void session.transport.audio.play().catch(() => {
				// Live remains provider-driven; transport lifecycle reports its errors.
			});
		},
		onAudioPlaying: () => session.readAloud?.handleAudioPlaying(),
		onAudioError: () => session.readAloud?.handleAudioError(),
		onConnectionLost: () => {
			if (active === session && !session.stopRequested) {
				fail(session, "Codex voice connection was lost.");
			}
		},
	});
}

function handleRemoteSdp(
	session: ActiveSession,
	message: Extract<CorrelatedRealtimeMessage, { type: "realtime_sdp" }>,
): void {
	if (session.stopRequested) return;
	void session.transport.pc
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
}

function handleRealtimeState(
	session: ActiveSession,
	message: Extract<CorrelatedRealtimeMessage, { type: "realtime_state" }>,
): void {
	if (message.state === "connected") {
		session.appServerReady = true;
		markSessionConnected(session);
		return;
	}
	if (message.state !== "closed") return;
	if (session.mode === "dictation") {
		session.dictation?.handleClosed();
		return;
	}
	if (session.readAloud?.handleUnexpectedClose()) return;
	release(session);
	publish(IDLE_STATE);
}

function handleRealtimeTranscript(
	session: ActiveSession,
	message: Extract<CorrelatedRealtimeMessage, { type: "realtime_transcript" }>,
): void {
	if (session.mode === "live") {
		// Raven's chat reducer owns Live transcript bubbles. This store retains a
		// single transcript only for the one-shot voice lifecycles.
		return;
	}
	if (session.mode === "dictation") {
		session.dictation?.handleTranscript(message);
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
	session.readAloud?.markTranscriptDone(message.role);
}

function handleMessage(message: ServerMessage): void {
	const session = active;
	if (!session) return;
	const matched = matchRealtimeMessage(message, {
		sessionId: session.sessionId,
		requestId: session.requestId,
		mode: session.mode,
	});
	if (!matched) return;
	switch (matched.type) {
		case "realtime_error":
			fail(session, matched.message);
			break;
		case "realtime_audio":
			session.readAloud?.markOutputStarted();
			break;
		case "realtime_sdp":
			handleRemoteSdp(session, matched);
			break;
		case "realtime_state":
			handleRealtimeState(session, matched);
			break;
		case "realtime_transcript":
			handleRealtimeTranscript(session, matched);
			break;
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
		if (reconnected && session?.stopRequested) sendStop(session);
	});
}

function installSessionLifecycles(
	session: ActiveSession,
	current: ClientContext,
	readAloud: ReadAloudCallbacks | undefined,
	pendingSpeech: string | undefined,
): void {
	if (session.mode === "dictation") {
		session.dictation = createCodexDictationLifecycle({
			isActive: () => active === session,
			isNativeStopRequested: () => Boolean(session.stopRequested),
			isInputStopped: () => Boolean(session.transport.inputTracksStopped),
			muteInput: () => muteInputTracks(session.transport),
			stopInput: () => stopInputTracks(session.transport),
			requestNativeStop: () => requestStop(session),
			onTranscript: (transcript) => publish({ ...snapshot, transcript }),
			onStopping: () =>
				publish({
					...snapshot,
					phase: "stopping",
					mode: "dictation",
					error: null,
				}),
			onFinished: (text) => {
				release(session);
				publish(IDLE_STATE);
				current.onDictation(text);
			},
			onFail: (message) => fail(session, message, false),
		});
		return;
	}
	if (session.mode !== "read-aloud") return;
	session.readAloud = createCodexReadAloudLifecycle({
		transport: session.transport,
		sessionId: session.sessionId,
		requestId: session.requestId,
		speech: pendingSpeech ?? "",
		callbacks: readAloud ?? {
			onPlaying: () => {},
			onEnded: () => {},
			onError: () => {},
		},
		isActive: () => active === session,
		isStopped: () => Boolean(session.stopRequested),
		send: (message) => wsStore.send(message),
		onFail: (message, requestNativeStop) =>
			fail(session, message, requestNativeStop),
		onFinished: () => stopCodexRealtime(),
	});
}

function validateSessionStart(): ClientContext {
	if (snapshot.unavailableReason) throw new Error(snapshot.unavailableReason);
	const current = context;
	if (!current?.sessionId) throw new Error("No Raven session is active.");
	if (current.providerId !== "codex") {
		throw new Error("Codex voice requires a native Codex session.");
	}
	if (active?.mode === "live") {
		stopCodexRealtime();
		throw new Error("Raven Live is stopping. Wait for it to close.");
	}
	if (active?.mode === "dictation") {
		stopCodexRealtime();
		throw new Error("Codex dictation is stopping. Wait for it to finish.");
	}
	stopCodexRealtime();
	return current;
}

async function prepareSessionInput(
	session: ActiveSession,
	readAloudResume: Promise<boolean> | null,
): Promise<boolean> {
	if (session.mode === "read-aloud") {
		await prepareReadAloudInput(session.transport, readAloudResume);
		return active === session && !session.stopRequested;
	}
	const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	if (active !== session || session.stopRequested) {
		for (const track of stream.getTracks()) track.stop();
		return false;
	}
	attachInputStream(session.transport, stream, () => {
		session.dictation?.onInputReady();
		applyLiveMicrophoneState(session);
	});
	return true;
}

function scheduleNegotiationTimeout(session: ActiveSession): void {
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
}

async function openSession(
	mode: RealtimeMode,
	readAloud?: ReadAloudCallbacks,
	pendingSpeech?: string,
): Promise<void> {
	ensureSubscribed();
	const current = validateSessionStart();
	const currentGeneration = ++generation;
	// Transport creation (and AudioContext.resume for read aloud) must remain
	// before openSession's first await to preserve Chrome Android activation.
	const { transport, readAloudResume } = createCodexRealtimeTransport(mode);
	const session: ActiveSession = {
		generation: currentGeneration,
		requestId: uid(),
		sessionId: current.sessionId,
		mode,
		transport,
		onLiveClosed: current.onLiveClosed,
		liveMicrophoneMuted: false,
	};
	active = session;
	installSessionLifecycles(session, current, readAloud, pendingSpeech);
	publish({ ...IDLE_STATE, phase: "starting", mode });
	try {
		if (!(await prepareSessionInput(session, readAloudResume))) return;
		bindSessionTransport(session);
		const sdp = await createRealtimeOfferSdp(
			transport,
			() => active === session && !session.stopRequested,
		);
		if (!sdp) return;
		if (
			!wsStore.send({
				type: "realtime_start",
				session_id: current.sessionId,
				mode,
				sdp,
				voice: current.voice,
				request_id: session.requestId,
				...(current.agentCwd ? { agent_cwd: current.agentCwd } : {}),
			})
		) {
			fail(session, "Codex voice could not reach Hlid.");
			return;
		}
		scheduleNegotiationTimeout(session);
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
		releaseSessionTransport(session);
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
		session.dictation?.beginDrain();
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
	session.dictation?.cancel();
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
