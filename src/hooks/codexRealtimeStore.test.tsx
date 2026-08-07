// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const socket = vi.hoisted(() => ({
	send: vi.fn(),
	subscribeMessage: vi.fn(),
	subscribeStatus: vi.fn(),
	getSnapshot: vi.fn(),
	wsStatus: "connected" as "connecting" | "connected" | "disconnected",
	onStatus: null as (() => void) | null,
	statusUnsubscribe: vi.fn(),
}));

vi.mock("./wsStore", () => socket);

import {
	__resetCodexRealtimeForTesting,
	isCodexRealtimeUnavailable,
	startCodexReadAloud,
	useCodexRealtime,
} from "./codexRealtimeStore";

class FakeDataChannel {
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	readyState: RTCDataChannelState = "connecting";
	send = vi.fn();
	close = vi.fn();

	constructor(readonly label: string) {}

	open(): void {
		this.readyState = "open";
		this.onopen?.(new Event("open"));
	}

	receive(data: unknown): void {
		this.onmessage?.({ data } as MessageEvent);
	}
}

class FakeReceiver {
	jitterBufferEmittedCount: number | null = 0;
	getStats = vi.fn(async () => {
		const report = new Map<string, Record<string, unknown>>();
		if (this.jitterBufferEmittedCount !== null) {
			report.set("inbound-audio", {
				type: "inbound-rtp",
				kind: "audio",
				jitterBufferEmittedCount: this.jitterBufferEmittedCount,
			});
		}
		return report as unknown as RTCStatsReport;
	});
}

class FakePeerConnection {
	static instances: FakePeerConnection[] = [];
	dataChannels: FakeDataChannel[] = [];
	receivers = [new FakeReceiver()];
	iceGatheringState = "complete";
	connectionState = "new";
	localDescription: RTCSessionDescription | null = null;
	ontrack: ((event: RTCTrackEvent) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	addTrack = vi.fn();
	addTransceiver = vi.fn();
	createDataChannel = vi.fn((label: string) => {
		const channel = new FakeDataChannel(label);
		this.dataChannels.push(channel);
		return channel as unknown as RTCDataChannel;
	});
	getReceivers = vi.fn(() => this.receivers as unknown as RTCRtpReceiver[]);
	close = vi.fn();
	setRemoteDescription = vi.fn().mockResolvedValue(undefined);

	constructor() {
		FakePeerConnection.instances.push(this);
	}

	createOffer(): Promise<RTCSessionDescriptionInit> {
		return Promise.resolve({ type: "offer", sdp: "v=0\r\no=hlid" });
	}

	setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
		this.localDescription = description as RTCSessionDescription;
		return Promise.resolve();
	}

	addEventListener(): void {}
	removeEventListener(): void {}
}

class FakeMediaStreamAudioSourceNode {
	connect = vi.fn();
	disconnect = vi.fn();
}

class FakeOscillatorNode {
	frequency = { value: 0 };
	connect = vi.fn();
	disconnect = vi.fn();
	start = vi.fn();
	stop = vi.fn();
}

class FakeGainNode {
	gain = { value: 1 };
	connect = vi.fn();
	disconnect = vi.fn();
}

class FakeSilentAudioTrack {
	enabled = true;
	stop = vi.fn();
}

class FakeRemoteAudioTrack {
	muted = true;
	private unmuteListener: (() => void) | null = null;
	addEventListener = vi.fn(
		(type: string, listener: EventListenerOrEventListenerObject) => {
			if (type !== "unmute") return;
			this.unmuteListener =
				typeof listener === "function"
					? () => listener(new Event("unmute"))
					: () => listener.handleEvent(new Event("unmute"));
		},
	);
	removeEventListener = vi.fn((type: string) => {
		if (type === "unmute") this.unmuteListener = null;
	});

	unmute(): void {
		this.muted = false;
		this.unmuteListener?.();
	}
}

class FakeMediaStreamAudioDestinationNode {
	readonly track = new FakeSilentAudioTrack();
	readonly stream = {
		getTracks: () => [this.track],
		getAudioTracks: () => [this.track],
	} as unknown as MediaStream;
}

class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	static resumeImplementation = (audioContext: FakeAudioContext) => {
		audioContext.state = "running";
		return Promise.resolve();
	};
	state: AudioContextState = "suspended";
	destination = {} as AudioDestinationNode;
	sources: FakeMediaStreamAudioSourceNode[] = [];
	oscillators: FakeOscillatorNode[] = [];
	gains: FakeGainNode[] = [];
	mediaDestinations: FakeMediaStreamAudioDestinationNode[] = [];
	resume = vi.fn(() => FakeAudioContext.resumeImplementation(this));
	close = vi.fn(() => {
		this.state = "closed";
		return Promise.resolve();
	});
	createMediaStreamSource = vi.fn((_stream: MediaStream) => {
		const source = new FakeMediaStreamAudioSourceNode();
		this.sources.push(source);
		return source as unknown as MediaStreamAudioSourceNode;
	});
	createOscillator = vi.fn(() => {
		const oscillator = new FakeOscillatorNode();
		this.oscillators.push(oscillator);
		return oscillator as unknown as OscillatorNode;
	});
	createGain = vi.fn(() => {
		const gain = new FakeGainNode();
		this.gains.push(gain);
		return gain as unknown as GainNode;
	});
	createMediaStreamDestination = vi.fn(() => {
		const destination = new FakeMediaStreamAudioDestinationNode();
		this.mediaDestinations.push(destination);
		return destination as unknown as MediaStreamAudioDestinationNode;
	});

	constructor() {
		FakeAudioContext.instances.push(this);
	}
}

let createdAudio: HTMLAudioElement | null = null;
let microphoneTrackStop = vi.fn();
let microphoneTrack = { enabled: true, stop: microphoneTrackStop };

function receiverFor(peer: FakePeerConnection | undefined): FakeReceiver {
	const receiver = peer?.receivers[0];
	if (!receiver) throw new Error("Expected a fake audio receiver");
	return receiver;
}

function readAloudDataChannelFor(
	peer: FakePeerConnection | undefined,
): FakeDataChannel {
	const dataChannel = peer?.dataChannels[0];
	if (!dataChannel) throw new Error("Expected a fake realtime data channel");
	return dataChannel;
}

beforeEach(() => {
	vi.clearAllMocks();
	FakePeerConnection.instances = [];
	FakeAudioContext.instances = [];
	FakeAudioContext.resumeImplementation = (audioContext) => {
		audioContext.state = "running";
		return Promise.resolve();
	};
	createdAudio = null;
	microphoneTrackStop = vi.fn();
	microphoneTrack = { enabled: true, stop: microphoneTrackStop };
	socket.send.mockReturnValue(true);
	socket.subscribeMessage.mockImplementation(() => vi.fn());
	socket.wsStatus = "connected";
	socket.onStatus = null;
	socket.getSnapshot.mockImplementation(() => ({
		wsStatus: socket.wsStatus,
	}));
	socket.subscribeStatus.mockImplementation((subscriber: () => void) => {
		socket.onStatus = subscriber;
		return socket.statusUnsubscribe;
	});
	vi.stubGlobal(
		"RTCPeerConnection",
		FakePeerConnection as unknown as typeof RTCPeerConnection,
	);
	vi.stubGlobal(
		"AudioContext",
		FakeAudioContext as unknown as typeof AudioContext,
	);
	Object.defineProperty(navigator, "mediaDevices", {
		value: {
			getUserMedia: vi.fn().mockResolvedValue({
				getTracks: () => [microphoneTrack],
			}),
		},
		configurable: true,
	});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	const createElement = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation(((
		tagName: string,
		options?: ElementCreationOptions,
	) => {
		const element = createElement(tagName, options);
		if (tagName === "audio") createdAudio = element as HTMLAudioElement;
		return element;
	}) as typeof document.createElement);
});

afterEach(() => {
	cleanup();
	__resetCodexRealtimeForTesting();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Codex realtime voice client", () => {
	it("recognizes account availability errors for preview suppression", () => {
		expect(
			isCodexRealtimeUnavailable(
				"Codex realtime voice is not available for this ChatGPT account yet.",
			),
		).toBe(true);
		expect(
			isCodexRealtimeUnavailable(
				'unexpected status 404 Not Found: {"detail":"Not Found"}, url: https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
			),
		).toBe(true);
		expect(isCodexRealtimeUnavailable("Voice connection failed.")).toBe(false);
	});

	it("drains and combines final dictation segments after explicit stop", async () => {
		const onDictation = vi.fn();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-1",
				providerId: "codex",
				voice: "marin",
				onDictation,
			}),
		);

		await act(() => result.current.start("dictation"));
		expect(socket.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "realtime_start",
				session_id: "session-1",
				mode: "dictation",
				voice: "marin",
				sdp: expect.stringContaining("v=0"),
				request_id: expect.any(String),
			}),
		);
		FakePeerConnection.instances[0]?.ontrack?.({} as RTCTrackEvent);
		expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		expect(receive).toBeTypeOf("function");
		act(() =>
			receive({
				type: "realtime_sdp",
				session_id: "session-1",
				mode: "dictation",
				sdp: "v=0\r\no=codex",
			}),
		);
		const dataChannel = FakePeerConnection.instances[0]?.dataChannels[0];
		await waitFor(() => expect(result.current.phase).toBe("starting"));
		act(() => dataChannel?.open());
		expect(result.current.phase).toBe("starting");
		act(() =>
			dataChannel?.receive(
				JSON.stringify({ type: "session.started", session: {} }),
			),
		);
		expect(result.current.phase).toBe("starting");
		act(() =>
			dataChannel?.receive(
				JSON.stringify({
					type: "session.started",
					session: { id: "realtime-dictation-1" },
				}),
			),
		);
		await waitFor(() => expect(result.current.phase).toBe("connected"));
		act(() =>
			receive({
				type: "realtime_transcript",
				session_id: "session-1",
				mode: "dictation",
				role: "user",
				text: "  Ship   the voice  ",
				done: true,
			}),
		);
		expect(onDictation).not.toHaveBeenCalled();
		expect(result.current.transcript).toBe("Ship the voice");

		act(() => {
			result.current.stop();
			result.current.stop();
		});
		expect(result.current.phase).toBe("stopping");
		expect(microphoneTrack.enabled).toBe(false);
		expect(microphoneTrackStop).not.toHaveBeenCalled();
		expect(FakePeerConnection.instances[0]?.close).not.toHaveBeenCalled();
		expect(
			socket.send.mock.calls.filter(
				([message]) =>
					message.type === "realtime_stop" &&
					message.session_id === "session-1",
			),
		).toHaveLength(0);

		act(() =>
			receive({
				type: "realtime_transcript",
				session_id: "session-1",
				mode: "dictation",
				role: "user",
				text: " update\nnow ",
				done: true,
			}),
		);
		expect(result.current.phase).toBe("stopping");
		expect(result.current.transcript).toBe("Ship the voice update now");
		expect(onDictation).not.toHaveBeenCalled();
		expect(microphoneTrackStop).toHaveBeenCalledOnce();
		expect(
			socket.send.mock.calls.filter(
				([message]) =>
					message.type === "realtime_stop" &&
					message.session_id === "session-1",
			),
		).toHaveLength(1);

		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-1",
				mode: "dictation",
				state: "closed",
			}),
		);
		expect(onDictation).toHaveBeenCalledOnce();
		expect(onDictation).toHaveBeenCalledWith("Ship the voice update now");
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
		expect(socket.send).toHaveBeenLastCalledWith({
			type: "realtime_stop",
			session_id: "session-1",
			mode: "dictation",
			request_id: expect.any(String),
		});
		expect(result.current.phase).toBe("idle");

		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-1",
				mode: "dictation",
				state: "closed",
			}),
		);
		expect(onDictation).toHaveBeenCalledOnce();
	});

	it("fails if dictation SDP never becomes a ready v3 data session", async () => {
		vi.useFakeTimers();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-not-ready",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		await act(() => result.current.start("dictation"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		await act(async () => {
			receive({
				type: "realtime_sdp",
				session_id: "session-not-ready",
				mode: "dictation",
				sdp: "v=0\r\no=codex",
			});
			await Promise.resolve();
		});
		expect(result.current.phase).toBe("starting");

		await act(async () => vi.advanceTimersByTimeAsync(20_000));
		expect(result.current.phase).toBe("error");
		expect(result.current.error).toBe("Codex dictation did not become ready.");
	});

	it("stops microphone capture before the bounded native-stop fallback", async () => {
		vi.useFakeTimers();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-stop-drain",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		await act(() => result.current.start("dictation"));
		const stops = () =>
			socket.send.mock.calls.filter(
				([message]) =>
					message.type === "realtime_stop" &&
					message.session_id === "session-stop-drain",
			);
		act(() => result.current.stop());

		expect(result.current.phase).toBe("stopping");
		expect(microphoneTrack.enabled).toBe(false);
		expect(microphoneTrackStop).not.toHaveBeenCalled();
		expect(stops()).toHaveLength(0);
		await act(async () => vi.advanceTimersByTimeAsync(749));
		expect(stops()).toHaveLength(0);
		expect(microphoneTrackStop).not.toHaveBeenCalled();

		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(stops()).toHaveLength(0);
		expect(microphoneTrackStop).toHaveBeenCalledOnce();
		expect(FakePeerConnection.instances[0]?.close).not.toHaveBeenCalled();

		await act(async () => vi.advanceTimersByTimeAsync(7_249));
		expect(stops()).toHaveLength(0);
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(stops()).toHaveLength(1);
		expect(microphoneTrackStop).toHaveBeenCalledOnce();
	});

	it("sends native stop once when a final transcript arrives during drain", async () => {
		vi.useFakeTimers();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-final-drain",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		await act(() => result.current.start("dictation"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		const stops = () =>
			socket.send.mock.calls.filter(
				([message]) =>
					message.type === "realtime_stop" &&
					message.session_id === "session-final-drain",
			);
		act(() => result.current.stop());
		expect(stops()).toHaveLength(0);
		expect(microphoneTrack.enabled).toBe(false);
		expect(microphoneTrackStop).not.toHaveBeenCalled();

		act(() =>
			receive({
				type: "realtime_transcript",
				session_id: "session-final-drain",
				mode: "dictation",
				role: "user",
				text: "Final during drain",
				done: true,
			}),
		);
		expect(stops()).toHaveLength(1);
		expect(microphoneTrackStop).toHaveBeenCalledOnce();
		expect(FakePeerConnection.instances[0]?.close).not.toHaveBeenCalled();

		await act(async () => vi.advanceTimersByTimeAsync(8_000));
		expect(stops()).toHaveLength(1);
	});

	it("promotes a provisional dictation tail when close arrives without done", async () => {
		const onDictation = vi.fn();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-provisional-close",
				providerId: "codex",
				voice: "marin",
				onDictation,
			}),
		);

		await act(() => result.current.start("dictation"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() =>
			receive({
				type: "realtime_transcript",
				session_id: "session-provisional-close",
				mode: "dictation",
				role: "user",
				text: "  Draft   from Codex ",
				done: false,
			}),
		);
		expect(result.current.transcript).toBe("Draft from Codex");

		act(() => result.current.stop());
		expect(microphoneTrack.enabled).toBe(false);
		expect(microphoneTrackStop).not.toHaveBeenCalled();
		expect(FakePeerConnection.instances[0]?.close).not.toHaveBeenCalled();
		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-provisional-close",
				mode: "dictation",
				state: "closed",
			}),
		);

		expect(onDictation).toHaveBeenCalledOnce();
		expect(onDictation).toHaveBeenCalledWith("Draft from Codex");
		expect(microphoneTrackStop).toHaveBeenCalledOnce();
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
		expect(result.current.phase).toBe("idle");
	});

	it("accepts a matching final transcript that arrives just after close", async () => {
		vi.useFakeTimers();
		const onDictation = vi.fn();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-late-final",
				providerId: "codex",
				voice: "marin",
				onDictation,
			}),
		);

		await act(() => result.current.start("dictation"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		const requestId = socket.send.mock.calls.find(
			([message]) => message.type === "realtime_start",
		)?.[0].request_id;
		act(() => {
			result.current.stop();
			receive({
				type: "realtime_state",
				session_id: "session-late-final",
				request_id: requestId,
				mode: "dictation",
				state: "closed",
			});
		});
		expect(result.current.phase).toBe("stopping");
		expect(result.current.error).toBeNull();
		expect(FakePeerConnection.instances[0]?.close).not.toHaveBeenCalled();

		act(() =>
			receive({
				type: "realtime_transcript",
				session_id: "session-late-final",
				request_id: requestId,
				mode: "dictation",
				role: "user",
				text: "Tail arrived",
				done: true,
			}),
		);

		expect(onDictation).toHaveBeenCalledOnce();
		expect(onDictation).toHaveBeenCalledWith("Tail arrived");
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
		expect(result.current.phase).toBe("idle");
	});

	it("fails once after the closed-session transcript tail grace expires", async () => {
		vi.useFakeTimers();
		const onDictation = vi.fn();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-empty-close",
				providerId: "codex",
				voice: "marin",
				onDictation,
			}),
		);

		await act(() => result.current.start("dictation"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() => {
			result.current.stop();
			receive({
				type: "realtime_state",
				session_id: "session-empty-close",
				mode: "dictation",
				state: "closed",
			});
		});
		await act(async () => vi.advanceTimersByTimeAsync(999));
		expect(result.current.phase).toBe("stopping");
		expect(result.current.error).toBeNull();
		expect(FakePeerConnection.instances[0]?.close).not.toHaveBeenCalled();

		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(result.current.phase).toBe("error");
		expect(result.current.error).toBe(
			"Codex dictation ended without a transcript.",
		);
		expect(onDictation).not.toHaveBeenCalled();
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-empty-close",
				mode: "dictation",
				state: "closed",
			}),
		);
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
	});

	it("ignores assistant and foreign dictation transcript events while draining", async () => {
		vi.useFakeTimers();
		const onDictation = vi.fn();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-filtered-tail",
				providerId: "codex",
				voice: "marin",
				onDictation,
			}),
		);

		await act(() => result.current.start("dictation"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		const requestId = socket.send.mock.calls.find(
			([message]) => message.type === "realtime_start",
		)?.[0].request_id;
		act(() => {
			result.current.stop();
			receive({
				type: "realtime_transcript",
				session_id: "session-filtered-tail",
				request_id: requestId,
				mode: "dictation",
				role: "assistant",
				text: "Assistant text",
				done: true,
			});
			receive({
				type: "realtime_transcript",
				session_id: "session-filtered-tail",
				request_id: requestId,
				mode: "live",
				role: "user",
				text: "Wrong mode",
				done: true,
			});
			receive({
				type: "realtime_transcript",
				session_id: "session-filtered-tail",
				request_id: "different-request",
				mode: "dictation",
				role: "user",
				text: "Stale request",
				done: true,
			});
			receive({
				type: "realtime_state",
				session_id: "session-filtered-tail",
				request_id: requestId,
				mode: "dictation",
				state: "closed",
			});
		});

		expect(result.current.transcript).toBe("");
		expect(result.current.phase).toBe("stopping");
		expect(onDictation).not.toHaveBeenCalled();
		act(() =>
			receive({
				type: "realtime_transcript",
				session_id: "session-filtered-tail",
				request_id: requestId,
				mode: "dictation",
				role: "user",
				text: "Matching tail",
				done: true,
			}),
		);
		expect(onDictation).toHaveBeenCalledOnce();
		expect(onDictation).toHaveBeenCalledWith("Matching tail");
	});

	it("cancels dictation immediately without delivering accumulated or late text", async () => {
		vi.useFakeTimers();
		const onDictation = vi.fn();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-cancel",
				providerId: "codex",
				voice: "marin",
				onDictation,
			}),
		);

		await act(() => result.current.start("dictation"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() =>
			receive({
				type: "realtime_transcript",
				session_id: "session-cancel",
				mode: "dictation",
				role: "user",
				text: "Do not deliver this",
				done: true,
			}),
		);

		act(() => result.current.stop());
		expect(microphoneTrack.enabled).toBe(false);
		expect(microphoneTrackStop).not.toHaveBeenCalled();
		expect(
			socket.send.mock.calls.filter(
				([message]) =>
					message.type === "realtime_stop" &&
					message.session_id === "session-cancel",
			),
		).toHaveLength(0);
		act(() => {
			result.current.cancel();
			result.current.cancel();
		});
		expect(result.current.phase).toBe("idle");
		expect(onDictation).not.toHaveBeenCalled();
		expect(microphoneTrackStop).toHaveBeenCalledOnce();
		expect(
			socket.send.mock.calls.filter(
				([message]) =>
					message.type === "realtime_stop" &&
					message.session_id === "session-cancel",
			),
		).toHaveLength(1);
		await act(async () => vi.advanceTimersByTimeAsync(2_000));
		expect(
			socket.send.mock.calls.filter(
				([message]) =>
					message.type === "realtime_stop" &&
					message.session_id === "session-cancel",
			),
		).toHaveLength(1);

		act(() => {
			receive({
				type: "realtime_transcript",
				session_id: "session-cancel",
				mode: "dictation",
				role: "user",
				text: "Late text",
				done: true,
			});
			receive({
				type: "realtime_state",
				session_id: "session-cancel",
				mode: "dictation",
				state: "closed",
			});
		});
		expect(onDictation).not.toHaveBeenCalled();
	});

	it("fails bounded dictation finalization when no transcript or close arrives", async () => {
		vi.useFakeTimers();
		const onDictation = vi.fn();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-timeout",
				providerId: "codex",
				voice: "marin",
				onDictation,
			}),
		);

		await act(() => result.current.start("dictation"));
		act(() => result.current.stop());
		expect(result.current.phase).toBe("stopping");
		await act(async () => vi.advanceTimersByTimeAsync(15_000));

		expect(result.current.phase).toBe("error");
		expect(result.current.error).toBe(
			"Codex dictation did not return a transcript before timing out.",
		);
		expect(onDictation).not.toHaveBeenCalled();
	});

	it("does not deliver a transcript when dictation never closes", async () => {
		vi.useFakeTimers();
		const onDictation = vi.fn();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-no-close",
				providerId: "codex",
				voice: "marin",
				onDictation,
			}),
		);

		await act(() => result.current.start("dictation"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() => {
			receive({
				type: "realtime_transcript",
				session_id: "session-no-close",
				mode: "dictation",
				role: "user",
				text: "Transcript without closure",
				done: true,
			});
			result.current.stop();
		});
		await act(async () => vi.advanceTimersByTimeAsync(15_000));

		expect(result.current.phase).toBe("error");
		expect(result.current.error).toBe(
			"Codex dictation did not finish closing after transcription.",
		);
		expect(onDictation).not.toHaveBeenCalled();
	});

	it("toggles the active Live microphone without stopping its transport", async () => {
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-live-microphone",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		await act(() => result.current.start("live"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() => {
			receive({
				type: "realtime_state",
				session_id: "session-live-microphone",
				mode: "live",
				state: "connected",
			});
			receive({
				type: "realtime_sdp",
				session_id: "session-live-microphone",
				mode: "live",
				sdp: "v=0\r\no=codex",
			});
		});
		await waitFor(() => expect(result.current.phase).toBe("connected"));

		expect(result.current.liveMicrophoneMuted).toBe(false);
		act(() => result.current.toggleLiveMicrophone());
		expect(result.current.liveMicrophoneMuted).toBe(true);
		expect(microphoneTrack.enabled).toBe(false);
		expect(microphoneTrackStop).not.toHaveBeenCalled();
		expect(FakePeerConnection.instances[0]?.close).not.toHaveBeenCalled();
		expect(
			socket.send.mock.calls.filter(
				([message]) => message.type === "realtime_stop",
			),
		).toHaveLength(0);

		act(() => result.current.toggleLiveMicrophone());
		expect(result.current.liveMicrophoneMuted).toBe(false);
		expect(microphoneTrack.enabled).toBe(true);
		expect(microphoneTrackStop).not.toHaveBeenCalled();
		expect(FakePeerConnection.instances[0]?.close).not.toHaveBeenCalled();
	});

	it("resets the Live microphone mute state when the session closes", async () => {
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-live-muted-close",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		await act(() => result.current.start("live"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() => result.current.toggleLiveMicrophone());
		expect(result.current.liveMicrophoneMuted).toBe(true);
		expect(microphoneTrack.enabled).toBe(false);

		act(() => result.current.stop());
		expect(result.current.phase).toBe("stopping");
		expect(microphoneTrackStop).toHaveBeenCalledOnce();
		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-live-muted-close",
				mode: "live",
				state: "closed",
			}),
		);

		expect(result.current.phase).toBe("idle");
		expect(result.current.liveMicrophoneMuted).toBe(false);
		expect(microphoneTrackStop).toHaveBeenCalledOnce();
	});

	it("ignores the Live microphone toggle during dictation", async () => {
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-dictation-live-toggle",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		await act(() => result.current.start("dictation"));
		act(() => result.current.toggleLiveMicrophone());

		expect(result.current.liveMicrophoneMuted).toBe(false);
		expect(microphoneTrack.enabled).toBe(true);
		expect(microphoneTrackStop).not.toHaveBeenCalled();
		expect(
			socket.send.mock.calls.filter(
				([message]) => message.type === "realtime_stop",
			),
		).toHaveLength(0);
	});

	it("keeps Live stopping until the server acknowledges teardown", async () => {
		const onLiveClosed = vi.fn();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-live",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
				onLiveClosed,
			}),
		);

		await act(() => result.current.start("live"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() =>
			receive({
				type: "realtime_transcript",
				session_id: "session-live",
				mode: "live",
				role: "user",
				text: "Visible in chat",
				done: false,
				utterance_id: "utterance-live-1",
				realtime_session_id: "realtime-live-1",
				transcript_seq: 1,
				source: "codex_realtime",
				fork_supported: false,
			}),
		);
		expect(result.current.transcript).toBe("");

		act(() => result.current.stop());
		expect(result.current.phase).toBe("stopping");
		expect(onLiveClosed).not.toHaveBeenCalled();
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
		expect(socket.send).toHaveBeenLastCalledWith({
			type: "realtime_stop",
			session_id: "session-live",
			mode: "live",
			request_id: expect.any(String),
		});
		act(() =>
			receive({
				type: "realtime_sdp",
				session_id: "session-live",
				mode: "live",
				sdp: "v=0\r\no=late-codex",
			}),
		);
		expect(result.current.phase).toBe("stopping");
		expect(
			FakePeerConnection.instances[0]?.setRemoteDescription,
		).not.toHaveBeenCalled();

		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-live",
				mode: "live",
				state: "closed",
			}),
		);
		expect(onLiveClosed).toHaveBeenCalledOnce();
		expect(result.current.phase).toBe("idle");
	});

	it("resends a mode-bearing Live stop after websocket reconnect", async () => {
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-live-reconnect",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		await act(() => result.current.start("live"));
		const startRequestId = socket.send.mock.calls.find(
			([message]) =>
				message.type === "realtime_start" &&
				message.session_id === "session-live-reconnect",
		)?.[0].request_id;
		act(() => result.current.stop());
		const liveStops = () =>
			socket.send.mock.calls.filter(
				([message]) =>
					message.type === "realtime_stop" &&
					message.session_id === "session-live-reconnect",
			);
		expect(liveStops()).toHaveLength(1);

		socket.wsStatus = "disconnected";
		act(() => socket.onStatus?.());
		expect(liveStops()).toHaveLength(1);

		socket.wsStatus = "connected";
		act(() => socket.onStatus?.());
		expect(liveStops()).toHaveLength(2);
		expect(socket.send).toHaveBeenLastCalledWith({
			type: "realtime_stop",
			session_id: "session-live-reconnect",
			mode: "live",
			request_id: startRequestId,
		});
		expect(
			liveStops().every(([message]) => message.request_id === startRequestId),
		).toBe(true);
		expect(result.current.phase).toBe("stopping");

		act(() => socket.onStatus?.());
		expect(liveStops()).toHaveLength(2);
	});

	it("resends a draining dictation stop after websocket reconnect", async () => {
		vi.useFakeTimers();
		const onDictation = vi.fn();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-dictation-reconnect",
				providerId: "codex",
				voice: "marin",
				onDictation,
			}),
		);

		await act(() => result.current.start("dictation"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		const requestId = socket.send.mock.calls.find(
			([message]) =>
				message.type === "realtime_start" &&
				message.session_id === "session-dictation-reconnect",
		)?.[0].request_id;
		act(() => result.current.stop());
		const stops = () =>
			socket.send.mock.calls.filter(
				([message]) =>
					message.type === "realtime_stop" &&
					message.session_id === "session-dictation-reconnect",
			);
		expect(stops()).toHaveLength(0);
		await act(async () => vi.advanceTimersByTimeAsync(8_000));
		expect(stops()).toHaveLength(1);

		socket.wsStatus = "disconnected";
		act(() => socket.onStatus?.());
		socket.wsStatus = "connected";
		act(() => socket.onStatus?.());
		expect(stops()).toHaveLength(2);
		expect(socket.send).toHaveBeenLastCalledWith({
			type: "realtime_stop",
			session_id: "session-dictation-reconnect",
			mode: "dictation",
			request_id: requestId,
		});

		act(() => {
			receive({
				type: "realtime_transcript",
				session_id: "session-dictation-reconnect",
				request_id: requestId,
				mode: "dictation",
				role: "user",
				text: "Recovered text",
				done: true,
			});
			receive({
				type: "realtime_state",
				session_id: "session-dictation-reconnect",
				request_id: requestId,
				mode: "dictation",
				state: "closed",
			});
		});
		expect(onDictation).toHaveBeenCalledWith("Recovered text");
		expect(result.current.phase).toBe("idle");
	});

	it("ignores a stale request-scoped close after restarting the same session", async () => {
		const first = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-restarted",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);
		await act(() => first.result.current.start("live"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		const requestA = socket.send.mock.calls.find(
			([message]) =>
				message.type === "realtime_start" &&
				message.session_id === "session-restarted",
		)?.[0].request_id;
		first.unmount();
		expect(socket.send).toHaveBeenLastCalledWith({
			type: "realtime_stop",
			session_id: "session-restarted",
			mode: "live",
			request_id: requestA,
		});

		const second = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-restarted",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);
		await act(() => second.result.current.start("live"));
		const requestB = socket.send.mock.calls
			.filter(
				([message]) =>
					message.type === "realtime_start" &&
					message.session_id === "session-restarted",
			)
			.at(-1)?.[0].request_id;
		expect(requestA).toEqual(expect.any(String));
		expect(requestB).toEqual(expect.any(String));
		expect(requestB).not.toBe(requestA);

		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-restarted",
				mode: "live",
				state: "connected",
				request_id: requestB,
			}),
		);
		act(() =>
			receive({
				type: "realtime_sdp",
				session_id: "session-restarted",
				mode: "live",
				sdp: "v=0\r\no=request-b",
				request_id: requestB,
			}),
		);
		await waitFor(() => expect(second.result.current.phase).toBe("connected"));

		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-restarted",
				mode: "live",
				state: "closed",
				request_id: requestA,
			}),
		);
		expect(second.result.current.phase).toBe("connected");

		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-restarted",
				mode: "live",
				state: "closed",
				request_id: requestB,
			}),
		);
		expect(second.result.current.phase).toBe("idle");
	});

	it("cleans up the websocket status subscription in the test reset", () => {
		renderHook(() =>
			useCodexRealtime({
				sessionId: "session-status-reset",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);
		expect(socket.subscribeStatus).toHaveBeenCalledOnce();

		act(() => __resetCodexRealtimeForTesting());
		expect(socket.statusUnsubscribe).toHaveBeenCalledOnce();
	});

	it("treats an error as the acknowledgement for a requested Live stop", async () => {
		const onLiveClosed = vi.fn();
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-live-error",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
				onLiveClosed,
			}),
		);

		await act(() => result.current.start("live"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() => result.current.stop());
		act(() =>
			receive({
				type: "realtime_error",
				session_id: "session-live-error",
				mode: "live",
				message: "Realtime stopped with an error",
			}),
		);

		expect(result.current.phase).toBe("error");
		expect(onLiveClosed).toHaveBeenCalledOnce();
		expect(
			socket.send.mock.calls.filter(
				([message]) =>
					message.type === "realtime_stop" &&
					message.session_id === "session-live-error",
			),
		).toHaveLength(1);
	});

	it("primes read-aloud media during the tap and waits for remote playback", async () => {
		vi.stubGlobal(
			"AudioContext",
			FakeAudioContext as unknown as typeof AudioContext,
		);
		let resolveOffer: ((offer: RTCSessionDescriptionInit) => void) | undefined;
		const offer = new Promise<RTCSessionDescriptionInit>((resolve) => {
			resolveOffer = resolve;
		});
		vi.spyOn(FakePeerConnection.prototype, "createOffer").mockReturnValueOnce(
			offer,
		);
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-web-audio",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read this", callbacks));
		const audioContext = FakeAudioContext.instances[0];
		expect(audioContext).toBeDefined();
		expect(audioContext?.resume).toHaveBeenCalledOnce();
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
		act(() =>
			createdAudio?.onplaying?.call(
				createdAudio,
				new Event("playing") as Event,
			),
		);
		expect(callbacks.onPlaying).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(FakePeerConnection.prototype.createOffer).toHaveBeenCalledOnce(),
		);
		expect(socket.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "realtime_start" }),
		);

		await act(async () => {
			resolveOffer?.({ type: "offer", sdp: "v=0\r\no=hlid" });
			await offer;
		});
		await waitFor(() =>
			expect(socket.send).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "realtime_start",
					session_id: "session-read-aloud-web-audio",
				}),
			),
		);
		const peer = FakePeerConnection.instances[0];
		const silentDestination = audioContext?.mediaDestinations[0];
		expect(audioContext?.createOscillator).toHaveBeenCalledOnce();
		expect(audioContext?.createGain).toHaveBeenCalledOnce();
		expect(audioContext?.createMediaStreamDestination).toHaveBeenCalledOnce();
		expect(audioContext?.oscillators[0]?.frequency.value).toBe(440);
		expect(audioContext?.gains[0]?.gain.value).toBe(0);
		expect(audioContext?.oscillators[0]?.start).toHaveBeenCalledOnce();
		expect(peer?.addTrack).toHaveBeenCalledWith(
			silentDestination?.track,
			silentDestination?.stream,
		);
		expect(peer?.addTransceiver).not.toHaveBeenCalled();
		expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		const requestId = socket.send.mock.calls.find(
			([message]) => message.type === "realtime_start",
		)?.[0].request_id;
		act(() => {
			receive({
				type: "realtime_state",
				session_id: "session-read-aloud-web-audio",
				request_id: requestId,
				mode: "read-aloud",
				state: "connected",
			});
			receive({
				type: "realtime_sdp",
				session_id: "session-read-aloud-web-audio",
				request_id: requestId,
				mode: "read-aloud",
				sdp: "v=0\r\no=codex",
			});
		});
		await waitFor(() =>
			expect(peer?.setRemoteDescription).toHaveBeenCalledOnce(),
		);
		act(() => {
			const dataChannel = readAloudDataChannelFor(peer);
			dataChannel.open();
			dataChannel.receive(JSON.stringify({ type: "session.started" }));
		});
		await waitFor(() =>
			expect(socket.send).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "realtime_speak",
					request_id: requestId,
				}),
			),
		);

		const remoteStream = {} as MediaStream;
		const remoteTrack = new FakeRemoteAudioTrack();
		await act(async () => {
			peer?.ontrack?.({
				streams: [remoteStream],
				track: remoteTrack as unknown as MediaStreamTrack,
			} as unknown as RTCTrackEvent);
			await Promise.resolve();
		});
		expect(audioContext?.createMediaStreamSource).not.toHaveBeenCalled();
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
		expect(createdAudio?.srcObject).toBe(remoteStream);
		expect(callbacks.onPlaying).not.toHaveBeenCalled();

		act(() =>
			createdAudio?.onplaying?.call(
				createdAudio,
				new Event("playing") as Event,
			),
		);
		expect(callbacks.onPlaying).not.toHaveBeenCalled();
		act(() => remoteTrack.unmute());
		expect(callbacks.onPlaying).toHaveBeenCalledOnce();

		act(() => result.current.stop());
		expect(audioContext?.oscillators[0]?.stop).toHaveBeenCalledOnce();
		expect(audioContext?.oscillators[0]?.disconnect).toHaveBeenCalledOnce();
		expect(audioContext?.gains[0]?.disconnect).toHaveBeenCalledOnce();
		expect(silentDestination?.track.stop).toHaveBeenCalledOnce();
		expect(remoteTrack.removeEventListener).toHaveBeenCalledWith(
			"unmute",
			expect.any(Function),
		);
		expect(audioContext?.close).toHaveBeenCalledOnce();
		expect(peer?.close).toHaveBeenCalledOnce();
	});

	it("withholds read-aloud speech until the browser data session is ready", async () => {
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-readiness-race",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read once", callbacks));
		await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
		const peer = FakePeerConnection.instances[0];
		const dataChannel = readAloudDataChannelFor(peer);
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		const startMessage = socket.send.mock.calls.find(
			([message]) => message.type === "realtime_start",
		)?.[0];
		const requestId = startMessage?.request_id;
		const speechMessages = () =>
			socket.send.mock.calls.filter(
				([message]) => message.type === "realtime_speak",
			);

		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-read-aloud-readiness-race",
				request_id: requestId,
				mode: "read-aloud",
				state: "connected",
			}),
		);
		expect(speechMessages()).toHaveLength(0);

		act(() =>
			receive({
				type: "realtime_sdp",
				session_id: "session-read-aloud-readiness-race",
				request_id: requestId,
				mode: "read-aloud",
				sdp: "v=0\r\no=codex",
			}),
		);
		await waitFor(() =>
			expect(peer?.setRemoteDescription).toHaveBeenCalledOnce(),
		);
		expect(speechMessages()).toHaveLength(0);

		act(() => dataChannel.open());
		expect(speechMessages()).toHaveLength(0);

		act(() => dataChannel.receive(JSON.stringify({ type: "session.started" })));
		await waitFor(() => expect(speechMessages()).toHaveLength(1));
		expect(speechMessages()[0]?.[0]).toEqual({
			type: "realtime_speak",
			session_id: "session-read-aloud-readiness-race",
			request_id: requestId,
			mode: "read-aloud",
			text: "Read once",
		});

		act(() => {
			dataChannel.receive(JSON.stringify({ type: "session.updated" }));
			dataChannel.receive(JSON.stringify({ type: "session.started" }));
		});
		expect(speechMessages()).toHaveLength(1);
	});

	it("fails before negotiation when the silent audio track cannot start", async () => {
		vi.stubGlobal(
			"AudioContext",
			FakeAudioContext as unknown as typeof AudioContext,
		);
		FakeAudioContext.resumeImplementation = () =>
			Promise.reject(new Error("activation expired"));
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-web-audio-fallback",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read this", callbacks));
		const peer = FakePeerConnection.instances[0];
		const audioContext = FakeAudioContext.instances[0];
		await waitFor(() => expect(callbacks.onError).toHaveBeenCalledOnce());
		expect(audioContext?.resume).toHaveBeenCalledOnce();
		expect(callbacks.onError).toHaveBeenCalledWith(
			"Codex read aloud could not start browser audio.",
		);
		expect(peer?.addTrack).toHaveBeenCalledOnce();
		expect(peer?.createDataChannel).not.toHaveBeenCalled();
		expect(socket.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "realtime_start" }),
		);
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
		expect(audioContext?.oscillators[0]?.stop).toHaveBeenCalledOnce();
		expect(audioContext?.close).toHaveBeenCalledOnce();
		expect(peer?.close).toHaveBeenCalledOnce();
		expect(result.current.phase).toBe("error");
	});

	it("does not revive replaced read aloud after a pending unlock resolves", async () => {
		vi.stubGlobal(
			"AudioContext",
			FakeAudioContext as unknown as typeof AudioContext,
		);
		const resumeResolvers: Array<() => void> = [];
		FakeAudioContext.resumeImplementation = () =>
			new Promise<void>((resolve) => resumeResolvers.push(resolve));
		const firstCallbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const replacementCallbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-pending-unlock",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("First response", firstCallbacks));
		const firstPeer = FakePeerConnection.instances[0];
		const firstAudioContext = FakeAudioContext.instances[0];
		expect(firstAudioContext?.createOscillator).toHaveBeenCalledOnce();
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
		expect(firstCallbacks.onPlaying).not.toHaveBeenCalled();

		act(() =>
			startCodexReadAloud("Replacement response", replacementCallbacks),
		);
		expect(FakeAudioContext.instances).toHaveLength(2);
		expect(firstAudioContext?.close).toHaveBeenCalledOnce();
		expect(firstPeer?.close).toHaveBeenCalledOnce();

		await act(async () => {
			resumeResolvers[0]?.();
			await Promise.resolve();
		});
		expect(firstCallbacks.onPlaying).not.toHaveBeenCalled();
		expect(firstCallbacks.onEnded).not.toHaveBeenCalled();
		expect(firstCallbacks.onError).not.toHaveBeenCalled();
		expect(replacementCallbacks.onPlaying).not.toHaveBeenCalled();
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
		expect(result.current.phase).toBe("starting");

		act(() => result.current.stop());
		await act(async () => {
			resumeResolvers[1]?.();
			await Promise.resolve();
		});
		expect(result.current.phase).toBe("idle");
		expect(replacementCallbacks.onPlaying).not.toHaveBeenCalled();
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
	});

	it("plays and drains a correlated v3 read-aloud turn without buffer events", async () => {
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read this", callbacks));
		await waitFor(() =>
			expect(socket.send).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "realtime_start",
					mode: "read-aloud",
					session_id: "session-read-aloud",
				}),
			),
		);
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		const peer = FakePeerConnection.instances[0];
		const dataChannel = peer?.dataChannels[0];
		expect(dataChannel?.label).toBe("oai-events");
		const startMessage = socket.send.mock.calls.find(
			([message]) => message.type === "realtime_start",
		)?.[0];
		const requestId = startMessage?.request_id;
		expect(requestId).toEqual(expect.any(String));
		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-read-aloud",
				request_id: requestId,
				mode: "read-aloud",
				state: "connected",
			}),
		);
		act(() =>
			receive({
				type: "realtime_sdp",
				session_id: "session-read-aloud",
				request_id: requestId,
				mode: "read-aloud",
				sdp: "v=0\r\no=codex",
			}),
		);
		await waitFor(() =>
			expect(peer?.setRemoteDescription).toHaveBeenCalledOnce(),
		);
		vi.useFakeTimers();
		act(() => {
			const channel = readAloudDataChannelFor(peer);
			channel.open();
			channel.receive(JSON.stringify({ type: "session.started" }));
		});
		expect(socket.send).toHaveBeenCalledWith({
			type: "realtime_speak",
			session_id: "session-read-aloud",
			request_id: requestId,
			mode: "read-aloud",
			text: "Read this",
		});
		const remoteStream = {} as MediaStream;
		const remoteTrack = new FakeRemoteAudioTrack();
		remoteTrack.unmute();
		act(() =>
			peer?.ontrack?.({
				streams: [remoteStream],
				track: remoteTrack as unknown as MediaStreamTrack,
			} as unknown as RTCTrackEvent),
		);
		expect(createdAudio?.srcObject).toBe(remoteStream);
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
		act(() =>
			createdAudio?.onplaying?.call(
				createdAudio,
				new Event("playing") as Event,
			),
		);
		expect(callbacks.onPlaying).toHaveBeenCalledOnce();

		receiverFor(peer).jitterBufferEmittedCount = 120;
		act(() =>
			dataChannel?.receive(
				JSON.stringify({
					type: "turn.done",
					role: "user",
					turn: { role: "assistant", transcript: "Read this" },
				}),
			),
		);
		act(() =>
			receive({
				type: "realtime_transcript",
				session_id: "session-read-aloud",
				request_id: requestId,
				mode: "read-aloud",
				role: "assistant",
				text: "Read this",
				done: true,
			}),
		);

		expect(callbacks.onEnded).not.toHaveBeenCalled();
		expect(result.current.phase).toBe("connected");
		expect(peer?.close).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTimeAsync(999));
		expect(callbacks.onEnded).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(callbacks.onEnded).toHaveBeenCalledOnce();
		expect(result.current.phase).toBe("idle");
		expect(peer?.close).toHaveBeenCalledOnce();
		expect(socket.send).toHaveBeenLastCalledWith({
			type: "realtime_stop",
			session_id: "session-read-aloud",
			mode: "read-aloud",
			request_id: expect.any(String),
		});
	});

	it("surfaces a correlated read-aloud speech failure", async () => {
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-error",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read this", callbacks));
		await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		const requestId = socket.send.mock.calls.find(
			([message]) =>
				message.type === "realtime_start" &&
				message.session_id === "session-read-aloud-error",
		)?.[0].request_id;
		expect(requestId).toEqual(expect.any(String));

		act(() => {
			receive({
				type: "realtime_state",
				session_id: "session-read-aloud-error",
				request_id: requestId,
				mode: "read-aloud",
				state: "connected",
			});
			receive({
				type: "realtime_sdp",
				session_id: "session-read-aloud-error",
				request_id: requestId,
				mode: "read-aloud",
				sdp: "v=0\r\no=codex",
			});
		});
		await waitFor(() =>
			expect(
				FakePeerConnection.instances[0]?.setRemoteDescription,
			).toHaveBeenCalledOnce(),
		);
		act(() => {
			const dataChannel = readAloudDataChannelFor(
				FakePeerConnection.instances[0],
			);
			dataChannel.open();
			dataChannel.receive(JSON.stringify({ type: "session.started" }));
		});
		await waitFor(() =>
			expect(socket.send).toHaveBeenCalledWith({
				type: "realtime_speak",
				session_id: "session-read-aloud-error",
				request_id: requestId,
				mode: "read-aloud",
				text: "Read this",
			}),
		);

		act(() =>
			receive({
				type: "realtime_error",
				session_id: "session-read-aloud-error",
				request_id: requestId,
				mode: "read-aloud",
				message: "Codex read aloud could not append speech.",
			}),
		);

		expect(callbacks.onError).toHaveBeenCalledWith(
			"Codex read aloud could not append speech.",
		);
		expect(callbacks.onPlaying).not.toHaveBeenCalled();
		expect(callbacks.onEnded).not.toHaveBeenCalled();
		expect(result.current).toMatchObject({
			phase: "error",
			error: "Codex read aloud could not append speech.",
		});
	});

	it("waits for local playback when the sideband final arrives first", async () => {
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-late-playback",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Short response", callbacks));
		await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
		const peer = FakePeerConnection.instances[0];
		const dataChannel = peer?.dataChannels[0];
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() =>
			receive({
				type: "realtime_sdp",
				session_id: "session-read-aloud-late-playback",
				mode: "read-aloud",
				sdp: "v=0\r\no=codex",
			}),
		);
		await waitFor(() =>
			expect(peer?.setRemoteDescription).toHaveBeenCalledOnce(),
		);
		vi.useFakeTimers();
		act(() => {
			dataChannel?.open();
			dataChannel?.receive(JSON.stringify({ type: "session.started" }));
		});
		expect(socket.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: "realtime_speak" }),
		);
		act(() =>
			receive({
				type: "realtime_transcript",
				session_id: "session-read-aloud-late-playback",
				mode: "read-aloud",
				role: "assistant",
				text: "Short response",
				done: true,
			}),
		);
		expect(callbacks.onEnded).not.toHaveBeenCalled();
		expect(peer?.close).not.toHaveBeenCalled();

		const remoteStream = {} as MediaStream;
		const remoteTrack = new FakeRemoteAudioTrack();
		act(() =>
			dataChannel?.receive(
				JSON.stringify({ type: "output_audio_buffer.started" }),
			),
		);
		act(() =>
			peer?.ontrack?.({
				streams: [remoteStream],
				track: remoteTrack as unknown as MediaStreamTrack,
			} as unknown as RTCTrackEvent),
		);
		act(() => remoteTrack.unmute());
		act(() =>
			createdAudio?.onplaying?.call(
				createdAudio,
				new Event("playing") as Event,
			),
		);
		expect(callbacks.onPlaying).toHaveBeenCalledOnce();
		expect(callbacks.onEnded).not.toHaveBeenCalled();
		receiverFor(peer).jitterBufferEmittedCount = 60;
		await act(async () => vi.advanceTimersByTimeAsync(999));
		expect(callbacks.onEnded).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTimeAsync(1));

		expect(callbacks.onEnded).toHaveBeenCalledOnce();
		expect(peer?.close).toHaveBeenCalledOnce();
	});

	it("fails when speech is sent but the server never starts audio output", async () => {
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-no-output",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read this", callbacks));
		await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
		const peer = FakePeerConnection.instances[0];
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() =>
			receive({
				type: "realtime_sdp",
				session_id: "session-read-aloud-no-output",
				mode: "read-aloud",
				sdp: "v=0\r\no=codex",
			}),
		);
		await waitFor(() =>
			expect(peer?.setRemoteDescription).toHaveBeenCalledOnce(),
		);
		vi.useFakeTimers();
		act(() => {
			const dataChannel = readAloudDataChannelFor(peer);
			dataChannel.open();
			dataChannel.receive(JSON.stringify({ type: "session.started" }));
		});
		act(() =>
			peer?.ontrack?.({
				streams: [{} as MediaStream],
				track: new FakeRemoteAudioTrack() as unknown as MediaStreamTrack,
			} as unknown as RTCTrackEvent),
		);
		act(() =>
			createdAudio?.onplaying?.call(
				createdAudio,
				new Event("playing") as Event,
			),
		);
		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-read-aloud-no-output",
				mode: "read-aloud",
				state: "connected",
			}),
		);
		expect(result.current.phase).toBe("connected");

		expect(callbacks.onPlaying).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTimeAsync(12_000));

		expect(callbacks.onError).toHaveBeenCalledWith(
			"Codex read aloud did not start producing audio.",
		);
		expect(callbacks.onEnded).not.toHaveBeenCalled();
		expect(result.current.phase).toBe("error");
		expect(peer?.close).toHaveBeenCalledOnce();
	});

	it("finishes after the output buffer stops while silent samples continue", async () => {
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-local-drain",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("A deliberately longer response", callbacks));
		await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
		const peer = FakePeerConnection.instances[0];
		if (!peer) throw new Error("Expected a fake peer connection");
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() =>
			receive({
				type: "realtime_sdp",
				session_id: "session-read-aloud-local-drain",
				mode: "read-aloud",
				sdp: "v=0\r\no=codex",
			}),
		);
		await waitFor(() =>
			expect(peer.setRemoteDescription).toHaveBeenCalledOnce(),
		);
		vi.useFakeTimers();
		const remoteTrack = new FakeRemoteAudioTrack();
		act(() => {
			peer.dataChannels[0]?.open();
			peer.dataChannels[0]?.receive(
				JSON.stringify({ type: "session.started" }),
			);
			peer.ontrack?.({
				streams: [{} as MediaStream],
				track: remoteTrack as unknown as MediaStreamTrack,
			} as unknown as RTCTrackEvent);
			remoteTrack.unmute();
			createdAudio?.onplaying?.call(
				createdAudio,
				new Event("playing") as Event,
			);
			peer.dataChannels[0]?.receive(
				JSON.stringify({ type: "output_audio_buffer.started" }),
			);
			receiverFor(peer).jitterBufferEmittedCount = 10;
			peer.dataChannels[0]?.receive(
				JSON.stringify({ type: "output_audio_buffer.stopped" }),
			);
		});

		await act(async () => vi.advanceTimersByTimeAsync(400));
		receiverFor(peer).jitterBufferEmittedCount = 20;
		await act(async () => vi.advanceTimersByTimeAsync(400));
		receiverFor(peer).jitterBufferEmittedCount = 30;
		await act(async () => vi.advanceTimersByTimeAsync(199));
		expect(callbacks.onEnded).not.toHaveBeenCalled();

		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(callbacks.onEnded).toHaveBeenCalledOnce();
		expect(callbacks.onError).not.toHaveBeenCalled();
		expect(peer.close).toHaveBeenCalledOnce();
	});

	it("finishes at a bounded fallback deadline without a terminal event", async () => {
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const sessionId = "session-read-aloud-beyond-fallback";
		const response = "one two three four";
		renderHook(() =>
			useCodexRealtime({
				sessionId,
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud(response, callbacks));
		await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
		const peer = FakePeerConnection.instances[0];
		if (!peer) throw new Error("Expected a fake peer connection");
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		const requestId = socket.send.mock.calls.find(
			([message]) =>
				message.type === "realtime_start" && message.session_id === sessionId,
		)?.[0].request_id;
		expect(requestId).toEqual(expect.any(String));
		act(() => {
			receive({
				type: "realtime_state",
				session_id: sessionId,
				request_id: requestId,
				mode: "read-aloud",
				state: "connected",
			});
			receive({
				type: "realtime_sdp",
				session_id: sessionId,
				request_id: requestId,
				mode: "read-aloud",
				sdp: "v=0\r\no=codex",
			});
		});
		await waitFor(() =>
			expect(peer.setRemoteDescription).toHaveBeenCalledOnce(),
		);
		vi.useFakeTimers();
		act(() => {
			const dataChannel = readAloudDataChannelFor(peer);
			dataChannel.open();
			dataChannel.receive(JSON.stringify({ type: "session.started" }));
		});
		expect(socket.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "realtime_speak",
				request_id: requestId,
			}),
		);
		const remoteTrack = new FakeRemoteAudioTrack();
		act(() => {
			peer.ontrack?.({
				streams: [{} as MediaStream],
				track: remoteTrack as unknown as MediaStreamTrack,
			} as unknown as RTCTrackEvent);
			remoteTrack.unmute();
			createdAudio?.onplaying?.call(
				createdAudio,
				new Event("playing") as Event,
			);
			receive({
				type: "realtime_audio",
				session_id: sessionId,
				request_id: requestId,
				mode: "read-aloud",
				state: "started",
			});
		});

		const receiver = receiverFor(peer);
		for (let step = 1; step <= 6; step += 1) {
			receiver.jitterBufferEmittedCount = step * 10;
			await act(async () => vi.advanceTimersByTimeAsync(600));
		}

		expect(callbacks.onEnded).not.toHaveBeenCalled();
		expect(peer.close).not.toHaveBeenCalled();
		receiver.jitterBufferEmittedCount = 70;
		await act(async () => vi.advanceTimersByTimeAsync(399));
		expect(callbacks.onEnded).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(callbacks.onEnded).toHaveBeenCalledOnce();
		expect(callbacks.onError).not.toHaveBeenCalled();
		expect(peer.close).toHaveBeenCalledOnce();
		expect(socket.send).toHaveBeenLastCalledWith({
			type: "realtime_stop",
			session_id: sessionId,
			mode: "read-aloud",
			request_id: requestId,
		});
	});

	it("reports an unexpected close before local playback completes", async () => {
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-early-close",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read this", callbacks));
		await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
		const peer = FakePeerConnection.instances[0];
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() =>
			receive({
				type: "realtime_state",
				session_id: "session-read-aloud-early-close",
				mode: "read-aloud",
				state: "closed",
			}),
		);

		expect(callbacks.onError).toHaveBeenCalledWith(
			"Codex read aloud ended before playback completed.",
		);
		expect(callbacks.onEnded).not.toHaveBeenCalled();
		expect(result.current.phase).toBe("error");
		expect(peer?.close).toHaveBeenCalledOnce();
		expect(
			socket.send.mock.calls.filter(
				([message]) =>
					message.type === "realtime_stop" &&
					message.session_id === "session-read-aloud-early-close",
			),
		).toHaveLength(0);
	});

	it("fails visibly when the realtime backend never becomes ready to speak", async () => {
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-not-ready",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read this", callbacks));
		await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		vi.useFakeTimers();
		await act(async () => {
			receive({
				type: "realtime_sdp",
				session_id: "session-read-aloud-not-ready",
				mode: "read-aloud",
				sdp: "v=0\r\no=codex",
			});
			await Promise.resolve();
		});
		expect(socket.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "realtime_speak" }),
		);

		act(() => vi.advanceTimersByTime(8_000));

		expect(callbacks.onError).toHaveBeenCalledWith(
			"Codex read aloud did not become ready.",
		);
		expect(result.current.phase).toBe("error");
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
	});

	it("reports a disconnected Hlid socket before waiting for voice negotiation", async () => {
		socket.send.mockReturnValueOnce(false);
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-disconnected",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read this", callbacks));
		await waitFor(() =>
			expect(callbacks.onError).toHaveBeenCalledWith(
				"Codex voice could not reach Hlid.",
			),
		);

		expect(result.current.phase).toBe("error");
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
	});

	it("fails visibly when voice negotiation never returns an SDP answer", async () => {
		vi.useFakeTimers();
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-no-sdp",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		await act(async () => {
			startCodexReadAloud("Read this", callbacks);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(socket.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "realtime_start",
				session_id: "session-read-aloud-no-sdp",
			}),
		);

		act(() => vi.advanceTimersByTime(20_000));

		expect(callbacks.onError).toHaveBeenCalledWith(
			"Codex voice negotiation timed out.",
		);
		expect(result.current.phase).toBe("error");
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
	});

	it("reports a rejected read-aloud media play instead of failing silently", async () => {
		vi.mocked(HTMLMediaElement.prototype.play)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("autoplay blocked"));
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-play-error",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read this", callbacks));
		await waitFor(() =>
			expect(
				FakePeerConnection.instances[0]?.createDataChannel,
			).toHaveBeenCalledOnce(),
		);
		act(() =>
			FakePeerConnection.instances[0]?.ontrack?.({
				streams: [{} as MediaStream],
				track: new FakeRemoteAudioTrack() as unknown as MediaStreamTrack,
			} as unknown as RTCTrackEvent),
		);

		await waitFor(() =>
			expect(callbacks.onError).toHaveBeenCalledWith(
				"Codex read aloud playback failed: autoplay blocked",
			),
		);
		expect(result.current.phase).toBe("error");
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
	});

	it("reports a read-aloud media element error", async () => {
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-media-error",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read this", callbacks));
		await waitFor(() =>
			expect(
				FakePeerConnection.instances[0]?.createDataChannel,
			).toHaveBeenCalledOnce(),
		);
		act(() =>
			FakePeerConnection.instances[0]?.ontrack?.({
				streams: [{} as MediaStream],
				track: new FakeRemoteAudioTrack() as unknown as MediaStreamTrack,
			} as unknown as RTCTrackEvent),
		);
		act(() =>
			createdAudio?.onerror?.call(createdAudio, new Event("error") as Event),
		);

		expect(callbacks.onError).toHaveBeenCalledWith(
			"Codex read aloud playback failed.",
		);
		expect(result.current.phase).toBe("error");
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
	});

	it("reports a read-aloud setup failure only once", async () => {
		vi.spyOn(FakePeerConnection.prototype, "createOffer").mockRejectedValueOnce(
			new Error("offer failed"),
		);
		const callbacks = {
			onPlaying: vi.fn(),
			onEnded: vi.fn(),
			onError: vi.fn(),
		};
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-read-aloud-offer-error",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		act(() => startCodexReadAloud("Read this", callbacks));
		await waitFor(() => expect(callbacks.onError).toHaveBeenCalledOnce());

		expect(callbacks.onError).toHaveBeenCalledWith("offer failed");
		expect(result.current.phase).toBe("error");
	});

	it("requests native teardown when realtime reports an error", async () => {
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-error",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		await act(() => result.current.start("dictation"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() =>
			receive({
				type: "realtime_error",
				session_id: "session-error",
				mode: "dictation",
				message: "Realtime failed",
			}),
		);

		expect(socket.send).toHaveBeenLastCalledWith({
			type: "realtime_stop",
			session_id: "session-error",
			mode: "dictation",
			request_id: expect.any(String),
		});
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
	});

	it("caches a backend 404 and disables repeated realtime attempts", async () => {
		const { result } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-unavailable",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		await act(() => result.current.start("live"));
		await waitFor(() => expect(result.current.phase).toBe("starting"));
		const receive = socket.subscribeMessage.mock.calls[0]?.[0];
		act(() =>
			receive({
				type: "realtime_error",
				session_id: "session-unavailable",
				mode: "live",
				message:
					'unexpected status 404 Not Found: {"detail":"Not Found"}, url: https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
			}),
		);

		await waitFor(() =>
			expect(result.current).toMatchObject({
				phase: "error",
				error: expect.stringContaining("404 Not Found"),
				unavailableReason: expect.stringContaining(
					"unavailable for this account or backend",
				),
			}),
		);
		await expect(result.current.start("live")).rejects.toThrow(
			"unavailable for this account or backend",
		);
		expect(FakePeerConnection.instances).toHaveLength(1);
	});

	it("stops native realtime when Raven unmounts", async () => {
		const { result, unmount } = renderHook(() =>
			useCodexRealtime({
				sessionId: "session-unmount",
				providerId: "codex",
				voice: "marin",
				onDictation: vi.fn(),
			}),
		);

		await act(() => result.current.start("dictation"));
		unmount();

		expect(socket.send).toHaveBeenLastCalledWith({
			type: "realtime_stop",
			session_id: "session-unmount",
			mode: "dictation",
			request_id: expect.any(String),
		});
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
	});
});
