// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const socket = vi.hoisted(() => ({
	send: vi.fn(),
	subscribeMessage: vi.fn(),
}));

vi.mock("./wsStore", () => socket);

import {
	__resetCodexRealtimeForTesting,
	isCodexRealtimeUnavailable,
	useCodexRealtime,
} from "./codexRealtimeStore";

class FakePeerConnection {
	static instances: FakePeerConnection[] = [];
	iceGatheringState = "complete";
	connectionState = "new";
	localDescription: RTCSessionDescription | null = null;
	ontrack: ((event: RTCTrackEvent) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	addTrack = vi.fn();
	addTransceiver = vi.fn();
	createDataChannel = vi.fn();
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

beforeEach(() => {
	vi.clearAllMocks();
	FakePeerConnection.instances = [];
	socket.subscribeMessage.mockImplementation(() => vi.fn());
	vi.stubGlobal(
		"RTCPeerConnection",
		FakePeerConnection as unknown as typeof RTCPeerConnection,
	);
	Object.defineProperty(navigator, "mediaDevices", {
		value: {
			getUserMedia: vi.fn().mockResolvedValue({
				getTracks: () => [{ stop: vi.fn() }],
			}),
		},
		configurable: true,
	});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
	cleanup();
	__resetCodexRealtimeForTesting();
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

	it("negotiates dictation and returns the final user transcript", async () => {
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
		await waitFor(() => expect(result.current.phase).toBe("connected"));
		act(() =>
			receive({
				type: "realtime_transcript",
				session_id: "session-1",
				mode: "dictation",
				role: "user",
				text: "Ship the voice update",
				done: true,
			}),
		);
		expect(onDictation).toHaveBeenCalledWith("Ship the voice update");
		expect(socket.send).toHaveBeenLastCalledWith({
			type: "realtime_stop",
			session_id: "session-1",
		});
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
		});
		expect(FakePeerConnection.instances[0]?.close).toHaveBeenCalledOnce();
	});
});
