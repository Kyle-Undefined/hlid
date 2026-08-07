import type { RealtimeMode } from "#/server/protocol";

export type CodexRealtimeTransport = {
	pc: RTCPeerConnection;
	dataChannel: RTCDataChannel | null;
	stream: MediaStream | null;
	audio: HTMLAudioElement;
	audioContext?: AudioContext;
	readAloudInputSource?: OscillatorNode;
	readAloudInputGain?: GainNode;
	readAloudInputDestination?: MediaStreamAudioDestinationNode;
	released?: boolean;
	inputTracksStopped?: boolean;
};

type ReadAloudAudioOutput = {
	context: AudioContext;
	resume: Promise<boolean>;
};

export type NewCodexRealtimeTransport = {
	transport: CodexRealtimeTransport;
	readAloudResume: Promise<boolean> | null;
};

type TransportHandlers = {
	onDataOpen: () => void;
	onDataMessage: (event: MessageEvent) => void;
	onRemoteTrack: (event: RTCTrackEvent) => void;
	onAudioPlaying: () => void;
	onAudioError: () => void;
	onConnectionLost: () => void;
};

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
			// This call deliberately happens synchronously during transport creation so
			// Chrome Android still associates it with the user's transient activation.
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

export function createCodexRealtimeTransport(
	mode: RealtimeMode,
): NewCodexRealtimeTransport {
	const pc = new RTCPeerConnection();
	const audio = document.createElement("audio");
	audio.autoplay = true;
	audio.setAttribute("playsinline", "");
	// Keep read-aloud output creation before this function's first await. The
	// caller invokes this from the original user gesture before negotiation.
	const audioOutput =
		mode === "read-aloud" ? createReadAloudAudioOutput() : null;
	return {
		transport: {
			pc,
			dataChannel: null,
			stream: null,
			audio,
			...(audioOutput ? { audioContext: audioOutput.context } : {}),
		},
		readAloudResume: audioOutput?.resume ?? null,
	};
}

export async function prepareReadAloudInput(
	transport: CodexRealtimeTransport,
	resume: Promise<boolean> | null,
): Promise<void> {
	const audioContext = transport.audioContext;
	if (!audioContext || !resume) {
		throw new Error("Codex read aloud could not start browser audio.");
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
	transport.readAloudInputSource = source;
	transport.readAloudInputGain = gain;
	transport.readAloudInputDestination = destination;
	transport.stream = destination.stream;
	source.start();
	transport.pc.addTrack(track, destination.stream);

	// Prime this exact element while the user gesture still owns activation. The
	// zero-gain source is replaced by the negotiated remote stream later.
	transport.audio.muted = false;
	transport.audio.volume = 1;
	transport.audio.srcObject = destination.stream;
	try {
		void transport.audio.play().catch(() => {
			// The remote play attempt remains authoritative on browsers that reject
			// priming an inaudible stream.
		});
	} catch {
		// Older WebViews can throw synchronously for a not-yet-live MediaStream.
	}
	if (!(await resume)) {
		throw new Error("Codex read aloud could not start browser audio.");
	}
}

export function attachInputStream(
	transport: CodexRealtimeTransport,
	stream: MediaStream,
	prepareTracks?: () => void,
): void {
	transport.stream = stream;
	prepareTracks?.();
	for (const track of stream.getTracks()) transport.pc.addTrack(track, stream);
}

export function muteInputTracks(transport: CodexRealtimeTransport): void {
	for (const track of transport.stream?.getTracks() ?? [])
		track.enabled = false;
}

export function applyMicrophoneMuted(
	transport: CodexRealtimeTransport,
	muted: boolean,
): void {
	for (const track of transport.stream?.getTracks() ?? []) {
		track.enabled = !muted;
	}
}

export function stopInputTracks(transport: CodexRealtimeTransport): void {
	if (transport.inputTracksStopped) return;
	transport.inputTracksStopped = true;
	for (const track of transport.stream?.getTracks() ?? []) track.stop();
}

export function bindCodexRealtimeTransport(
	transport: CodexRealtimeTransport,
	handlers: TransportHandlers,
): void {
	const dataChannel = transport.pc.createDataChannel("oai-events");
	transport.dataChannel = dataChannel;
	dataChannel.onopen = handlers.onDataOpen;
	dataChannel.onmessage = handlers.onDataMessage;
	if (dataChannel.readyState === "open") handlers.onDataOpen();
	transport.pc.ontrack = handlers.onRemoteTrack;
	transport.audio.onplaying = handlers.onAudioPlaying;
	transport.audio.onerror = handlers.onAudioError;
	transport.pc.onconnectionstatechange = () => {
		if (
			transport.pc.connectionState === "failed" ||
			transport.pc.connectionState === "disconnected"
		) {
			handlers.onConnectionLost();
		}
	};
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

export async function createRealtimeOfferSdp(
	transport: CodexRealtimeTransport,
	shouldContinue: () => boolean,
): Promise<string | null> {
	const offer = await transport.pc.createOffer();
	if (!shouldContinue()) return null;
	await transport.pc.setLocalDescription(offer);
	await waitForIceGathering(transport.pc);
	if (!shouldContinue()) return null;
	const sdp = transport.pc.localDescription?.sdp;
	if (!sdp) throw new Error("The browser did not create a voice offer.");
	return sdp;
}

function closeAudioContext(audioContext: AudioContext): void {
	if (audioContext.state === "closed") return;
	try {
		void audioContext.close().catch(() => {
			// Teardown has already detached the context from the session.
		});
	} catch {
		// Older WebViews can throw synchronously while their audio service exits.
	}
}

function releaseSilentInput(transport: CodexRealtimeTransport): void {
	try {
		transport.readAloudInputSource?.stop();
	} catch {
		// The source may not have reached start if setup failed partway through.
	}
	try {
		transport.readAloudInputSource?.disconnect();
	} catch {}
	try {
		transport.readAloudInputGain?.disconnect();
	} catch {}
	transport.readAloudInputSource = undefined;
	transport.readAloudInputGain = undefined;
	transport.readAloudInputDestination = undefined;
}

export function releaseCodexRealtimeTransport(
	transport: CodexRealtimeTransport,
): void {
	if (transport.released) return;
	transport.released = true;
	releaseSilentInput(transport);
	stopInputTracks(transport);
	if (transport.dataChannel) {
		transport.dataChannel.onopen = null;
		transport.dataChannel.onmessage = null;
	}
	if (transport.audioContext) {
		closeAudioContext(transport.audioContext);
		transport.audioContext = undefined;
	}
	transport.audio.onplaying = null;
	transport.audio.onerror = null;
	transport.audio.pause();
	transport.audio.srcObject = null;
	transport.pc.close();
}
