// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "#/test/utils";
import { useLocalConversationMic } from "./useLocalConversationMic";

class FakeAnalyser {
	static level = 0;
	fftSize = 32;
	smoothingTimeConstant = 0;
	disconnect = vi.fn();

	getFloatTimeDomainData(samples: Float32Array): void {
		samples.fill(FakeAnalyser.level);
	}
}

class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	static decodedInputs: ArrayBuffer[] = [];
	static initialState: AudioContextState = "running";
	static decode = vi.fn(async (_input: ArrayBuffer) => ({
		duration: 3 / 16_000,
	}));
	static resumePending = vi.fn(async () => {});
	state: AudioContextState = FakeAudioContext.initialState;
	currentTime = 0;
	close = vi.fn(async () => {
		this.state = "closed";
	});
	resume = vi.fn(async () => {
		await FakeAudioContext.resumePending();
		this.state = "running";
	});
	decodeAudioData = vi.fn(async (input: ArrayBuffer) => {
		FakeAudioContext.decodedInputs.push(input);
		return FakeAudioContext.decode(input);
	});
	source = {
		connect: vi.fn(),
		disconnect: vi.fn(),
	};
	analyser = new FakeAnalyser();
	createMediaStreamSource = vi.fn(() => this.source);
	createAnalyser = vi.fn(() => this.analyser);

	constructor() {
		FakeAudioContext.instances.push(this);
	}
}

class FakeOfflineAudioContext {
	destination = {};
	createBufferSource = vi.fn(() => ({
		buffer: null,
		connect: vi.fn(),
		start: vi.fn(),
	}));
	startRendering = vi.fn(async () => ({
		getChannelData: () => new Float32Array([-1, 0, 1]),
	}));
}

class FakeMediaRecorder {
	static instances: FakeMediaRecorder[] = [];
	static isTypeSupported = vi.fn(() => true);
	static deferStopEvents = false;
	state: RecordingState = "inactive";
	mimeType = "audio/webm;codecs=opus";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onerror: (() => void) | null = null;
	onstop: (() => void) | null = null;
	private emittedChunks = 0;
	private stopPending = false;
	start = vi.fn(() => {
		this.state = "recording";
	});
	requestData = vi.fn(() => {
		if (this.state !== "recording") throw new Error("inactive recorder");
		this.emit(
			`utterance-${FakeMediaRecorder.instances.indexOf(this)}-${this.emittedChunks}`,
		);
	});
	stop = vi.fn(() => {
		if (this.state === "inactive") return;
		this.state = "inactive";
		if (FakeMediaRecorder.deferStopEvents) {
			this.stopPending = true;
			return;
		}
		this.flushStop();
	});

	emit(text: string): void {
		this.emittedChunks++;
		this.ondataavailable?.({ data: new Blob([text]) });
	}

	flushStop(): void {
		if (this.stopPending) this.stopPending = false;
		this.emit(
			`utterance-${FakeMediaRecorder.instances.indexOf(this)}-${this.emittedChunks}`,
		);
		this.onstop?.();
	}

	constructor(
		readonly stream: MediaStream,
		readonly options?: MediaRecorderOptions,
	) {
		FakeMediaRecorder.instances.push(this);
	}
}

let analysisIntervals: Map<number, TimerHandler>;
let nextAnalysisInterval: number;

function runAnalysisInterval(nowMs: number): void {
	const next = analysisIntervals.entries().next().value as
		| [number, TimerHandler]
		| undefined;
	if (!next || typeof next[1] !== "function") {
		throw new Error("No analysis interval is pending");
	}
	for (const context of FakeAudioContext.instances) {
		context.currentTime = nowMs / 1_000;
	}
	next[1]();
}

function createMicrophone() {
	const track = {
		enabled: true,
		stop: vi.fn(),
	};
	const stream = {
		getTracks: vi.fn(() => [track]),
	} as unknown as MediaStream;
	const getUserMedia = vi.fn(async () => stream);
	Object.defineProperty(navigator, "mediaDevices", {
		value: { getUserMedia },
		configurable: true,
	});
	return { track, stream, getUserMedia };
}

beforeEach(() => {
	FakeAnalyser.level = 0;
	FakeAudioContext.instances = [];
	FakeAudioContext.decodedInputs = [];
	FakeAudioContext.initialState = "running";
	FakeAudioContext.decode.mockReset();
	FakeAudioContext.decode.mockResolvedValue({ duration: 3 / 16_000 });
	FakeAudioContext.resumePending.mockReset();
	FakeAudioContext.resumePending.mockResolvedValue(undefined);
	FakeMediaRecorder.instances = [];
	FakeMediaRecorder.isTypeSupported.mockClear();
	FakeMediaRecorder.deferStopEvents = false;
	analysisIntervals = new Map();
	nextAnalysisInterval = 1;
	vi.stubGlobal("AudioContext", FakeAudioContext);
	vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
	vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
	const nativeSetInterval = window.setInterval.bind(window);
	const nativeClearInterval = window.clearInterval.bind(window);
	vi.spyOn(window, "setInterval").mockImplementation(((
		callback: TimerHandler,
		timeout?: number,
		...args: unknown[]
	) => {
		if (timeout !== 40) {
			return nativeSetInterval(callback, timeout, ...args);
		}
		const id = nextAnalysisInterval++;
		analysisIntervals.set(id, callback);
		return id;
	}) as never);
	vi.spyOn(window, "clearInterval").mockImplementation((id) => {
		if (!analysisIntervals.delete(Number(id))) nativeClearInterval(id);
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("useLocalConversationMic", () => {
	it("keeps one microphone stream and serializes consecutive utterances", async () => {
		const { track, getUserMedia } = createMicrophone();
		const firstResponse = deferred<Response>();
		const secondResponse = deferred<Response>();
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementationOnce(() => firstResponse.promise)
			.mockImplementationOnce(() => secondResponse.promise);
		const onTranscription = vi.fn(async () => {});
		const onSpeechStart = vi.fn();
		const onSpeechEnd = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription,
				onSpeechStart,
				onSpeechEnd,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 50 },
			}),
		);

		await act(() => result.current.start());
		expect(result.current.phase).toBe("listening");
		expect(FakeMediaRecorder.instances).toHaveLength(1);
		expect(getUserMedia).toHaveBeenCalledOnce();
		expect(getUserMedia).toHaveBeenCalledWith({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
			},
		});

		FakeMediaRecorder.instances[0]?.emit("pre-roll-first");
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(0));
		expect(result.current.phase).toBe("capturing");
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(10));
		act(() => runAnalysisInterval(60));
		expect(FakeMediaRecorder.instances[0]?.requestData).not.toHaveBeenCalled();
		expect(FakeMediaRecorder.instances[0]?.stop).toHaveBeenCalledOnce();
		expect(result.current.pendingTranscriptions).toBe(1);
		await waitFor(() => expect(FakeAudioContext.decodedInputs).toHaveLength(1));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		expect(
			new TextDecoder().decode(FakeAudioContext.decodedInputs[0]),
		).toContain("pre-roll-first");

		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(70));
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(80));
		act(() => runAnalysisInterval(130));
		expect(FakeMediaRecorder.instances).toHaveLength(3);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(result.current.pendingTranscriptions).toBe(2);

		firstResponse.resolve(Response.json({ text: " first words " }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(onTranscription).toHaveBeenCalledWith("first words");
		secondResponse.resolve(Response.json({ text: "second words" }));
		await waitFor(() =>
			expect(onTranscription).toHaveBeenNthCalledWith(2, "second words"),
		);
		await waitFor(() => expect(result.current.pendingTranscriptions).toBe(0));

		expect(onSpeechStart).toHaveBeenCalledTimes(2);
		expect(onSpeechEnd).toHaveBeenCalledTimes(2);
		expect(getUserMedia).toHaveBeenCalledOnce();
		expect(track.stop).not.toHaveBeenCalled();
		act(() => result.current.stop());
		expect(track.stop).toHaveBeenCalledOnce();
		for (const recorder of FakeMediaRecorder.instances) {
			expect(recorder.stop).toHaveBeenCalledOnce();
		}
	});

	it("hard-mutes the track and gates VAD and transcription in software", async () => {
		const { track } = createMicrophone();
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const onSpeechStart = vi.fn();
		const onSpeechEnd = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription: vi.fn(),
				onSpeechStart,
				onSpeechEnd,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 50 },
			}),
		);

		await act(() => result.current.start());
		act(() => result.current.setMuted(true));
		expect(track.enabled).toBe(false);
		expect(result.current.phase).toBe("muted");
		expect(result.current.isMuted).toBe(true);

		FakeAnalyser.level = 0.5;
		act(() => runAnalysisInterval(0));
		act(() => runAnalysisInterval(100));
		expect(FakeMediaRecorder.instances).toHaveLength(1);
		expect(onSpeechStart).not.toHaveBeenCalled();

		act(() => result.current.toggleMuted());
		expect(track.enabled).toBe(true);
		act(() => runAnalysisInterval(110));
		expect(FakeMediaRecorder.instances).toHaveLength(2);
		expect(onSpeechStart).toHaveBeenCalledOnce();

		act(() => result.current.setMuted(true));
		expect(FakeMediaRecorder.instances[1]?.requestData).not.toHaveBeenCalled();
		expect(FakeMediaRecorder.instances[1]?.stop).toHaveBeenCalledOnce();
		expect(onSpeechEnd).toHaveBeenCalledOnce();
		await act(async () => Promise.resolve());
		expect(fetchMock).not.toHaveBeenCalled();
		FakeAnalyser.level = 0.5;
		act(() => runAnalysisInterval(200));
		expect(FakeMediaRecorder.instances).toHaveLength(2);

		act(() => result.current.stop());
		expect(track.stop).toHaveBeenCalledOnce();
		expect(FakeMediaRecorder.instances[1]?.stop).toHaveBeenCalledOnce();
		expect(result.current).toMatchObject({
			phase: "idle",
			active: false,
			isMuted: false,
		});
	});

	it("finishes the current utterance before an explicit mute", async () => {
		const { track } = createMicrophone();
		FakeMediaRecorder.deferStopEvents = true;
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ text: "finished by mute" }));
		const onTranscription = vi.fn();
		const onSpeechEnd = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription,
				onSpeechEnd,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 5_000 },
			}),
		);

		await act(() => result.current.start());
		FakeAnalyser.level = 0.5;
		act(() => runAnalysisInterval(0));
		FakeMediaRecorder.instances[0]?.emit("spoken-before-mute");

		act(() => result.current.toggleMuted());
		expect(track.enabled).toBe(false);
		expect(result.current).toMatchObject({
			phase: "muted",
			isMuted: true,
			isCapturing: false,
		});
		expect(onSpeechEnd).toHaveBeenCalledOnce();
		expect(FakeMediaRecorder.instances[0]?.stop).toHaveBeenCalledOnce();
		expect(fetchMock).not.toHaveBeenCalled();

		act(() => FakeMediaRecorder.instances[0]?.flushStop());

		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(onTranscription).toHaveBeenCalledWith("finished by mute"),
		);
		expect(
			new TextDecoder().decode(FakeAudioContext.decodedInputs[0]),
		).toContain("spoken-before-muteutterance-0-1");

		FakeAnalyser.level = 0.5;
		act(() => runAnalysisInterval(100));
		expect(FakeMediaRecorder.instances).toHaveLength(1);
	});

	it("settles speech only after deferred terminal recorder data is finalized", async () => {
		createMicrophone();
		FakeMediaRecorder.deferStopEvents = true;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ text: "settled words" }),
		);
		const onSpeechEnd = vi.fn();
		const onSpeechSettled = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription: vi.fn(),
				onSpeechEnd,
				onSpeechSettled,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 50 },
			}),
		);

		await act(() => result.current.start());
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(0));
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(10));
		act(() => runAnalysisInterval(60));

		expect(onSpeechEnd).toHaveBeenCalledOnce();
		expect(onSpeechSettled).not.toHaveBeenCalled();
		expect(FakeMediaRecorder.instances[0]?.stop).toHaveBeenCalledOnce();

		act(() => FakeMediaRecorder.instances[0]?.flushStop());
		expect(onSpeechSettled).toHaveBeenCalledOnce();
	});

	it("lets an automatic safety mute discard an explicitly closing utterance", async () => {
		createMicrophone();
		FakeMediaRecorder.deferStopEvents = true;
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const onTranscription = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 5_000 },
			}),
		);

		await act(() => result.current.start());
		FakeAnalyser.level = 0.5;
		act(() => runAnalysisInterval(0));
		act(() => result.current.toggleMuted());
		act(() => result.current.setMuted(true));
		act(() => FakeMediaRecorder.instances[0]?.flushStop());
		await act(async () => Promise.resolve());

		expect(fetchMock).not.toHaveBeenCalled();
		expect(onTranscription).not.toHaveBeenCalled();
	});

	it("closes an utterance at the configured duration without waiting for silence", async () => {
		createMicrophone();
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ text: "bounded" }));
		const onTranscription = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription,
				maxUtteranceSeconds: 1,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 5_000 },
			}),
		);

		await act(() => result.current.start());
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(0));
		act(() => runAnalysisInterval(1_000));
		expect(FakeMediaRecorder.instances[0]?.requestData).not.toHaveBeenCalled();
		expect(FakeMediaRecorder.instances[0]?.stop).toHaveBeenCalledOnce();
		expect(FakeMediaRecorder.instances).toHaveLength(2);
		await waitFor(() => expect(FakeAudioContext.decodedInputs).toHaveLength(1));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(onTranscription).toHaveBeenCalledWith("bounded"),
		);
		expect(result.current.phase).toBe("listening");
	});

	it("software-gates VAD and pre-roll while Hlid's own speaker is active", async () => {
		createMicrophone();
		let speakerActive = false;
		const onSpeechStart = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription: vi.fn(),
				onSpeechStart,
				shouldSuppressInput: () => speakerActive,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 50 },
			}),
		);

		await act(() => result.current.start());
		speakerActive = true;
		act(() => result.current.refreshInputSuppression());
		FakeMediaRecorder.instances[0]?.emit("speaker-loopback");
		FakeAnalyser.level = 0.5;
		act(() => runAnalysisInterval(0));
		expect(onSpeechStart).not.toHaveBeenCalled();
		expect(FakeMediaRecorder.instances[0]?.stop).toHaveBeenCalledOnce();

		speakerActive = false;
		act(() => result.current.refreshInputSuppression());
		act(() => runAnalysisInterval(40));
		expect(onSpeechStart).toHaveBeenCalledOnce();
		expect(FakeMediaRecorder.instances[0]?.requestData).not.toHaveBeenCalled();
		expect(FakeMediaRecorder.instances).toHaveLength(2);
	});

	it("drops a backpressured utterance without corrupting the next recorder pre-roll", async () => {
		createMicrophone();
		const firstResponse = deferred<Response>();
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementationOnce(() => firstResponse.promise)
			.mockResolvedValueOnce(Response.json({ text: "accepted next" }));
		const onTranscription = vi.fn();
		const onSpeechStart = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription,
				onSpeechStart,
				maxPendingTranscriptions: 1,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 50 },
			}),
		);

		await act(() => result.current.start());
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(0));
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(10));
		act(() => runAnalysisInterval(60));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

		FakeMediaRecorder.instances[1]?.emit("suppressed-utterance");
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(70));
		expect(onSpeechStart).toHaveBeenCalledOnce();
		expect(result.current.error).toContain("catching up");
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(80));
		expect(FakeMediaRecorder.instances).toHaveLength(3);

		firstResponse.resolve(Response.json({ text: "accepted first" }));
		await waitFor(() =>
			expect(onTranscription).toHaveBeenCalledWith("accepted first"),
		);
		await waitFor(() => expect(result.current.pendingTranscriptions).toBe(0));

		FakeMediaRecorder.instances[2]?.emit("accepted-pre-roll");
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(100));
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(110));
		act(() => runAnalysisInterval(160));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(onTranscription).toHaveBeenCalledWith("accepted next"),
		);
		const decodedNext = new TextDecoder().decode(
			FakeAudioContext.decodedInputs[1],
		);
		expect(decodedNext).toContain("accepted-pre-roll");
		expect(decodedNext).not.toContain("suppressed-utterance");
	});

	it("buffers an adjacent utterance while the previous recorder stop is asynchronous", async () => {
		createMicrophone();
		FakeMediaRecorder.deferStopEvents = true;
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ text: "accepted" }));
		const onSpeechStart = vi.fn();
		const onSpeechSettled = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription: vi.fn(),
				onSpeechStart,
				onSpeechSettled,
				vad: { threshold: 0.1, speechStartMs: 80, silenceMs: 50 },
			}),
		);

		await act(() => result.current.start());
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(0));
		act(() => runAnalysisInterval(80));
		expect(onSpeechStart).toHaveBeenCalledOnce();
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(90));
		act(() => runAnalysisInterval(140));
		expect(FakeMediaRecorder.instances).toHaveLength(2);

		FakeMediaRecorder.instances[1]?.emit("adjacent-utterance-start");
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(150));
		act(() => runAnalysisInterval(230));
		expect(onSpeechStart).toHaveBeenCalledOnce();
		FakeMediaRecorder.instances[0]?.emit("queued-old-tail");
		act(() => FakeMediaRecorder.instances[0]?.flushStop());
		act(() => runAnalysisInterval(240));
		act(() => runAnalysisInterval(320));
		expect(onSpeechStart).toHaveBeenCalledTimes(2);
		expect(onSpeechSettled).not.toHaveBeenCalled();

		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(330));
		act(() => runAnalysisInterval(380));
		act(() => FakeMediaRecorder.instances[1]?.flushStop());
		expect(onSpeechSettled).toHaveBeenCalledOnce();
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(
			new TextDecoder().decode(FakeAudioContext.decodedInputs[0]),
		).toContain("queued-old-tail");
		const secondDecoded = new TextDecoder().decode(
			FakeAudioContext.decodedInputs[1],
		);
		expect(secondDecoded).toContain("adjacent-utterance-start");
	});

	it("does not repeat speech-end when stopped during asynchronous recorder close", async () => {
		createMicrophone();
		FakeMediaRecorder.deferStopEvents = true;
		const onSpeechEnd = vi.fn();
		const onSpeechSettled = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription: vi.fn(),
				onSpeechEnd,
				onSpeechSettled,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 50 },
			}),
		);

		await act(() => result.current.start());
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(0));
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(10));
		act(() => runAnalysisInterval(60));
		expect(onSpeechEnd).toHaveBeenCalledOnce();
		expect(onSpeechSettled).not.toHaveBeenCalled();

		act(() => result.current.stop());
		expect(onSpeechEnd).toHaveBeenCalledOnce();
		expect(onSpeechSettled).toHaveBeenCalledOnce();
		act(() => FakeMediaRecorder.instances[0]?.flushStop());
		expect(onSpeechSettled).toHaveBeenCalledOnce();
	});

	it("submits a short interjection completed during the previous recorder close", async () => {
		createMicrophone();
		FakeMediaRecorder.deferStopEvents = true;
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ text: "accepted" }));
		const onSpeechStart = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription: vi.fn(),
				onSpeechStart,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 50 },
			}),
		);

		await act(() => result.current.start());
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(0));
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(10));
		act(() => runAnalysisInterval(60));

		FakeMediaRecorder.instances[1]?.emit("brief-interjection");
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(70));
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(80));
		act(() => runAnalysisInterval(130));
		expect(onSpeechStart).toHaveBeenCalledOnce();

		act(() => FakeMediaRecorder.instances[0]?.flushStop());
		expect(onSpeechStart).toHaveBeenCalledTimes(2);
		act(() => FakeMediaRecorder.instances[1]?.flushStop());
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		const interjection = new TextDecoder().decode(
			FakeAudioContext.decodedInputs[1],
		);
		expect(interjection).toContain("brief-interjection");
	});

	it("restarts an unexpectedly stopped idle recorder", async () => {
		createMicrophone();
		const onSpeechStart = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription: vi.fn(),
				onSpeechStart,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 50 },
			}),
		);

		await act(() => result.current.start());
		const stopped = FakeMediaRecorder.instances[0];
		if (!stopped) throw new Error("expected recorder");
		stopped.state = "inactive";
		act(() => stopped.onstop?.());
		expect(FakeMediaRecorder.instances).toHaveLength(2);
		expect(result.current.phase).toBe("listening");

		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(0));
		expect(onSpeechStart).toHaveBeenCalledOnce();
	});

	it("releases a stream that resolves after the conversation stops", async () => {
		const streamPending = deferred<MediaStream>();
		const stopTrack = vi.fn();
		Object.defineProperty(navigator, "mediaDevices", {
			value: { getUserMedia: vi.fn(() => streamPending.promise) },
			configurable: true,
		});
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription: vi.fn(),
			}),
		);

		let starting!: Promise<void>;
		act(() => {
			starting = result.current.start();
		});
		act(() => result.current.stop());
		streamPending.resolve({
			getTracks: () => [{ stop: stopTrack }],
		} as unknown as MediaStream);
		await act(() => starting);

		expect(stopTrack).toHaveBeenCalledOnce();
		expect(result.current.phase).toBe("idle");
	});

	it("releases an acquired stream while audio context resume is pending", async () => {
		const { track } = createMicrophone();
		const resumePending = deferred<void>();
		FakeAudioContext.initialState = "suspended";
		FakeAudioContext.resumePending.mockReturnValue(resumePending.promise);
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription: vi.fn(),
			}),
		);

		let starting!: Promise<void>;
		act(() => {
			starting = result.current.start();
		});
		await waitFor(() =>
			expect(FakeAudioContext.resumePending).toHaveBeenCalled(),
		);
		const context = FakeAudioContext.instances[0];
		expect(context).toBeTruthy();

		act(() => result.current.stop());
		expect(track.stop).toHaveBeenCalledOnce();
		expect(context?.close).toHaveBeenCalledOnce();
		resumePending.resolve();
		await act(() => starting);
		expect(track.stop).toHaveBeenCalledOnce();
	});

	it("does not serialize restarted transcription behind stopped audio decoding", async () => {
		createMicrophone();
		const staleDecode = deferred<{ duration: number }>();
		FakeAudioContext.decode
			.mockImplementationOnce(() => staleDecode.promise)
			.mockResolvedValue({ duration: 3 / 16_000 });
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ text: "new turn" }));
		const onTranscription = vi.fn();
		const { result } = renderHook(() =>
			useLocalConversationMic({
				language: "en",
				onTranscription,
				vad: { threshold: 0.1, speechStartMs: 0, silenceMs: 50 },
			}),
		);

		await act(() => result.current.start());
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(0));
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(10));
		act(() => runAnalysisInterval(60));
		await waitFor(() => expect(FakeAudioContext.decodedInputs).toHaveLength(1));

		act(() => result.current.stop());
		await act(() => result.current.start());
		FakeAnalyser.level = 0.2;
		act(() => runAnalysisInterval(100));
		FakeAnalyser.level = 0;
		act(() => runAnalysisInterval(110));
		act(() => runAnalysisInterval(160));

		await waitFor(() => expect(FakeAudioContext.decodedInputs).toHaveLength(2));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(onTranscription).toHaveBeenCalledWith("new turn"),
		);
		staleDecode.resolve({ duration: 3 / 16_000 });
	});
});
