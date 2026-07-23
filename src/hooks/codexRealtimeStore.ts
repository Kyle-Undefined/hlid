import { useEffect, useRef, useSyncExternalStore } from "react";
import type { RealtimeMode, ServerMessage } from "#/server/protocol";
import * as wsStore from "./wsStore";

export type CodexRealtimePhase = "idle" | "starting" | "connected" | "error";

export type CodexRealtimeState = {
	phase: CodexRealtimePhase;
	mode: RealtimeMode | null;
	transcript: string;
	error: string | null;
	unavailableReason: string | null;
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
};

type ReadAloudCallbacks = {
	onPlaying: () => void;
	onEnded: () => void;
	onError: (message: string) => void;
};

type ActiveSession = {
	generation: number;
	sessionId: string;
	mode: RealtimeMode;
	pc: RTCPeerConnection;
	stream: MediaStream | null;
	audio: HTMLAudioElement;
	readAloud?: ReadAloudCallbacks;
	pendingSpeech?: string;
};

const IDLE_STATE: CodexRealtimeState = {
	phase: "idle",
	mode: null,
	transcript: "",
	error: null,
	unavailableReason: null,
};

let snapshot = IDLE_STATE;
let context: ClientContext | null = null;
let active: ActiveSession | null = null;
let generation = 0;
let unavailableReason: string | null = null;
let subscribed = false;
let unsubscribeMessage: (() => void) | null = null;
const subscribers = new Set<() => void>();

function publish(next: CodexRealtimeState): void {
	snapshot = next;
	for (const subscriber of subscribers) subscriber();
}

function release(session: ActiveSession): void {
	for (const track of session.stream?.getTracks() ?? []) track.stop();
	session.audio.pause();
	session.audio.srcObject = null;
	session.pc.close();
	if (active === session) active = null;
}

function requestStop(session: ActiveSession): void {
	wsStore.send({ type: "realtime_stop", session_id: session.sessionId });
}

function fail(session: ActiveSession, message: string): void {
	if (active !== session || session.generation !== generation) return;
	if (isCodexRealtimeUnavailable(message)) {
		unavailableReason =
			"Codex realtime voice is unavailable for this account or backend. Restart Hlid after changing Codex authentication or version to check again.";
	}
	session.readAloud?.onError(message);
	// Realtime errors do not guarantee that Codex has torn down the native
	// transport. Always send the idempotent stop before dropping local state.
	requestStop(session);
	release(session);
	publish({
		phase: "error",
		mode: session.mode,
		transcript: "",
		error: message,
		unavailableReason,
	});
}

function messageMatches(
	message: Extract<
		ServerMessage,
		{
			type:
				| "realtime_state"
				| "realtime_sdp"
				| "realtime_transcript"
				| "realtime_error";
		}
	>,
	session: ActiveSession,
): boolean {
	return (
		message.session_id === session.sessionId && message.mode === session.mode
	);
}

function handleMessage(message: ServerMessage): void {
	const session = active;
	if (!session) return;
	if (
		message.type !== "realtime_state" &&
		message.type !== "realtime_sdp" &&
		message.type !== "realtime_transcript" &&
		message.type !== "realtime_error"
	)
		return;
	if (!messageMatches(message, session)) return;

	if (message.type === "realtime_error") {
		fail(session, message.message);
		return;
	}
	if (message.type === "realtime_sdp") {
		void session.pc
			.setRemoteDescription({ type: "answer", sdp: message.sdp })
			.then(() => {
				if (active !== session) return;
				publish({
					...snapshot,
					phase: "connected",
					mode: session.mode,
					error: null,
				});
				if (session.pendingSpeech) {
					wsStore.send({
						type: "realtime_speak",
						session_id: session.sessionId,
						text: session.pendingSpeech,
					});
					session.pendingSpeech = undefined;
				}
			})
			.catch((error) =>
				fail(
					session,
					error instanceof Error
						? `Codex voice negotiation failed: ${error.message}`
						: "Codex voice negotiation failed",
				),
			);
		return;
	}
	if (message.type === "realtime_state") {
		if (message.state === "closed") {
			session.readAloud?.onEnded();
			release(session);
			publish(IDLE_STATE);
		}
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
	if (session.mode === "dictation" && message.role !== "assistant") {
		context?.onDictation(message.text.trim());
		stopCodexRealtime();
		return;
	}
	if (session.mode === "read-aloud" && message.role === "assistant") {
		session.readAloud?.onEnded();
		stopCodexRealtime();
	}
}

function ensureSubscribed(): void {
	if (subscribed || typeof window === "undefined") return;
	subscribed = true;
	unsubscribeMessage = wsStore.subscribeMessage(handleMessage);
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
	stopCodexRealtime();

	const currentGeneration = ++generation;
	const pc = new RTCPeerConnection();
	const audio = document.createElement("audio");
	audio.autoplay = true;
	audio.setAttribute("playsinline", "");
	let stream: MediaStream | null = null;
	const session: ActiveSession = {
		generation: currentGeneration,
		sessionId: current.sessionId,
		mode,
		pc,
		stream,
		audio,
		readAloud,
		pendingSpeech,
	};
	active = session;
	publish({ ...IDLE_STATE, phase: "starting", mode });
	try {
		if (mode === "read-aloud") {
			pc.addTransceiver("audio", { direction: "recvonly" });
		} else {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			session.stream = stream;
			for (const track of stream.getTracks()) pc.addTrack(track, stream);
		}
		pc.createDataChannel("oai-events");
		pc.ontrack = (event) => {
			if (active !== session || session.mode === "dictation") return;
			audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
			void audio.play().catch(() => {});
		};
		audio.onplaying = () => {
			if (active === session) session.readAloud?.onPlaying();
		};
		pc.onconnectionstatechange = () => {
			if (
				active === session &&
				(pc.connectionState === "failed" ||
					pc.connectionState === "disconnected")
			)
				fail(session, "Codex voice connection was lost.");
		};
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		await waitForIceGathering(pc);
		if (active !== session) return;
		const sdp = pc.localDescription?.sdp;
		if (!sdp) throw new Error("The browser did not create a voice offer.");
		wsStore.send({
			type: "realtime_start",
			session_id: current.sessionId,
			mode,
			sdp,
			voice: current.voice,
			...(current.agentCwd ? { agent_cwd: current.agentCwd } : {}),
		});
	} catch (error) {
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
	void openSession("read-aloud", callbacks, text).catch((error) =>
		callbacks.onError(
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
		if (changedSession) stopCodexRealtime();
	}, [options]);
	useEffect(
		() => () => {
			const sessionId = ownedSessionId.current;
			if (active?.sessionId === sessionId) stopCodexRealtime();
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
	subscribed = false;
	publish(IDLE_STATE);
}
