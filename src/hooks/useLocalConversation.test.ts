// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "#/components/chat/chatReducer";

const micState = vi.hoisted(() => ({
	options: null as null | {
		onTranscription: (text: string) => void | Promise<void>;
		onSpeechStart?: () => void;
		onSpeechSettled?: () => void;
		shouldSuppressInput?: () => boolean;
	},
	phase: "idle" as
		| "idle"
		| "starting"
		| "listening"
		| "capturing"
		| "muted"
		| "error",
	isMuted: false,
	isCapturing: false,
	pendingTranscriptions: 0,
	error: null as string | null,
	start: vi.fn(async () => {}),
	stop: vi.fn(),
	setMuted: vi.fn(),
	toggleMuted: vi.fn(),
	refreshInputSuppression: vi.fn(),
	clearError: vi.fn(),
}));

vi.mock("#/hooks/useLocalConversationMic", () => ({
	useLocalConversationMic: (options: typeof micState.options) => {
		micState.options = options;
		return {
			phase: micState.phase,
			error: micState.error,
			active: micState.phase !== "idle" && micState.phase !== "error",
			isListening:
				micState.phase === "listening" || micState.phase === "capturing",
			isCapturing: micState.isCapturing,
			isMuted: micState.isMuted,
			pendingTranscriptions: micState.pendingTranscriptions,
			start: micState.start,
			stop: micState.stop,
			setMuted: micState.setMuted,
			toggleMuted: micState.toggleMuted,
			refreshInputSuppression: micState.refreshInputSuppression,
			clearError: micState.clearError,
		};
	},
}));

import {
	hasPendingLocalConversationAttention,
	useLocalConversation,
} from "./useLocalConversation";

class FakeAudio {
	static instances: FakeAudio[] = [];
	src = "";
	volume = 1;
	preload = "";
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	play = vi.fn(async () => {});
	pause = vi.fn();
	load = vi.fn();
	removeAttribute = vi.fn((name: string) => {
		if (name === "src") this.src = "";
	});

	constructor() {
		FakeAudio.instances.push(this);
	}
}

function assistant(
	text: string,
	options: {
		id?: string;
		dbId?: number;
		transcriptSeq?: number;
		turnId?: string;
		streaming?: boolean;
		toolCount?: number;
	} = {},
): ChatMessage {
	return {
		id: options.id ?? "assistant-1",
		role: "assistant",
		...(options.dbId !== undefined ? { dbId: options.dbId } : {}),
		...(options.transcriptSeq !== undefined
			? { transcriptSeq: options.transcriptSeq }
			: {}),
		...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
		text,
		toolEvents: Array.from(
			{ length: options.toolCount ?? 0 },
			() => ({}),
		) as never[],
		streaming: options.streaming ?? true,
		cost: null,
	};
}

const baseOptions = {
	enabled: true,
	available: true,
	unavailableReason: null,
	language: "auto",
	rate: 1,
	pronunciations: [],
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.clearAllMocks();
	micState.options = null;
	micState.phase = "idle";
	micState.isMuted = false;
	micState.isCapturing = false;
	micState.pendingTranscriptions = 0;
	micState.error = null;
	FakeAudio.instances = [];
	vi.stubGlobal("Audio", FakeAudio);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(new Uint8Array([1]))),
	);
	vi.stubGlobal("URL", {
		...URL,
		createObjectURL: vi.fn(() => "blob:local-speech"),
		revokeObjectURL: vi.fn(),
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("useLocalConversation", () => {
	it("reads a stable sentence before the assistant turn is done", async () => {
		const onTranscription = vi.fn();
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription,
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());

		rerender({ messages: [assistant("I'll inspect that. ")] });
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		const request = vi.mocked(fetch).mock.calls[0]?.[1];
		expect(JSON.parse(String(request?.body))).toEqual({
			text: "I'll inspect that.",
			rate: 1,
		});
		await waitFor(() =>
			expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(2),
		);
		await waitFor(() => expect(result.current.speakerPhase).toBe("speaking"));
		expect(micState.options?.shouldSuppressInput?.()).toBe(true);
		act(() => FakeAudio.instances[0]?.onended?.());
		await waitFor(() => expect(result.current.speakerPhase).toBe("idle"));
		expect(micState.options?.shouldSuppressInput?.()).toBe(false);
	});

	it("reads list items separately while the assistant is still streaming", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());

		rerender({
			messages: [assistant("- First item\n- Second item")],
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		expect(
			JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).text,
		).toBe("First item.");

		rerender({
			messages: [
				assistant("- First item\n- Second item", { streaming: false }),
			],
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(
			vi
				.mocked(fetch)
				.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).text),
		).toEqual(["First item.", "Second item."]);
	});

	it("sends only the pronounced copy to local neural speech", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					pronunciations: [
						{ written: "Hlið", spoken: "hleeth" },
						{ written: "OpenCode", spoken: "open code" },
					],
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());

		rerender({ messages: [assistant("Hlið checked OpenCode. ")] });
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		const request = vi.mocked(fetch).mock.calls[0]?.[1];
		expect(JSON.parse(String(request?.body))).toMatchObject({
			text: "hleeth checked open code.",
		});
	});

	it("synthesizes cleaned shell metadata from a live response", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({
			messages: [
				assistant(
					[
						"Live shell check:",
						"",
						"- Time: `2026-08-15T11:31:48-04:00`",
						"- Working folder: `C:\\Users\\kyleu\\Documents\\Obsidian\\Fornbok`",
					].join("\n"),
					{ streaming: false },
				),
			],
		});

		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(
			vi
				.mocked(fetch)
				.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).text),
		).toEqual(["Live shell check:", "Working folder: Fornbok."]);
	});

	it("pauses and resumes the current speech without refetching or stopping the conversation", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({ messages: [assistant("Pause this sentence. ")] });
		await waitFor(() => expect(result.current.speakerPhase).toBe("speaking"));

		const audio = FakeAudio.instances[0];
		expect(audio).toBeDefined();
		if (!audio) return;
		const source = audio.src;
		const playsBeforePause = audio.play.mock.calls.length;
		const pausesBeforePause = audio.pause.mock.calls.length;
		const requestsBeforePause = vi.mocked(fetch).mock.calls.length;

		act(() => result.current.pauseSpeech());
		expect(result.current.speakerPhase).toBe("paused");
		expect(audio.pause).toHaveBeenCalledTimes(pausesBeforePause + 1);
		expect(audio.src).toBe(source);
		expect(micState.options?.shouldSuppressInput?.()).toBe(false);
		expect(result.current.active).toBe(true);
		expect(micState.stop).not.toHaveBeenCalled();

		act(() => micState.options?.onSpeechStart?.());
		act(() => result.current.resumeSpeech());
		expect(result.current.speakerPhase).toBe("paused");
		expect(audio.play).toHaveBeenCalledTimes(playsBeforePause);
		act(() => micState.options?.onSpeechSettled?.());

		expect(result.current.speakerPhase).toBe("speaking");
		expect(audio.play).toHaveBeenCalledTimes(playsBeforePause + 1);
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(requestsBeforePause);
		expect(audio.src).toBe(source);
		expect(micState.options?.shouldSuppressInput?.()).toBe(true);

		act(() => audio.onended?.());
		await waitFor(() => expect(result.current.speakerPhase).toBe("idle"));
	});

	it("does not advance to prefetched speech across a pause-boundary race", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({
			messages: [assistant("First sentence. Second sentence. ")],
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(result.current.speakerPhase).toBe("speaking"));
		const audio = FakeAudio.instances[0];
		expect(audio).toBeDefined();
		if (!audio) return;
		const playsBeforePause = audio.play.mock.calls.length;

		act(() => result.current.pauseSpeech());
		act(() => audio.onended?.());
		await waitFor(() => expect(result.current.speakerPhase).toBe("paused"));
		expect(audio.play).toHaveBeenCalledTimes(playsBeforePause);
		expect(micState.options?.shouldSuppressInput?.()).toBe(false);

		act(() => result.current.resumeSpeech());
		await waitFor(() =>
			expect(audio.play).toHaveBeenCalledTimes(playsBeforePause + 1),
		);
		await waitFor(() => expect(result.current.speakerPhase).toBe("speaking"));
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("latches pause while the next segment is still synthesizing", async () => {
		const secondSynthesis = deferred<Response>();
		vi.mocked(fetch)
			.mockResolvedValueOnce(new Response(new Uint8Array([1])))
			.mockReturnValueOnce(secondSynthesis.promise);
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({ messages: [assistant("First sentence. Second sentence.")] });
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(result.current.speakerPhase).toBe("speaking"));
		const audio = FakeAudio.instances[0];
		expect(audio).toBeDefined();
		if (!audio) return;
		const playsBeforeGap = audio.play.mock.calls.length;

		act(() => audio.onended?.());
		await waitFor(() =>
			expect(result.current.speakerPhase).toBe("synthesizing"),
		);
		act(() => result.current.pauseSpeech());
		expect(result.current.speakerPhase).toBe("paused");

		secondSynthesis.resolve(new Response(new Uint8Array([1])));
		await act(async () => {
			await secondSynthesis.promise;
			await Promise.resolve();
		});
		expect(result.current.speakerPhase).toBe("paused");
		expect(audio.play).toHaveBeenCalledTimes(playsBeforeGap);

		act(() => result.current.resumeSpeech());
		await waitFor(() =>
			expect(audio.play).toHaveBeenCalledTimes(playsBeforeGap + 1),
		);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(result.current.speakerPhase).toBe("speaking");
	});

	it("keeps a pause clicked while audio playback is still starting", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		const audio = FakeAudio.instances[0];
		expect(audio).toBeDefined();
		if (!audio) return;
		const startingPlayback = deferred<void>();
		audio.play.mockReturnValueOnce(startingPlayback.promise);

		rerender({ messages: [assistant("Playback is starting. ")] });
		await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
		act(() => result.current.pauseSpeech());
		expect(result.current.speakerPhase).toBe("paused");

		startingPlayback.resolve();
		await act(async () => {
			await startingPlayback.promise;
			await Promise.resolve();
		});
		expect(result.current.speakerPhase).toBe("paused");
		expect(micState.options?.shouldSuppressInput?.()).toBe(false);

		act(() => result.current.resumeSpeech());
		expect(audio.play).toHaveBeenCalledTimes(3);
		expect(result.current.speakerPhase).toBe("speaking");
	});

	it("cleans up and reports a resume playback failure", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({ messages: [assistant("Playback can be retried later. ")] });
		await waitFor(() => expect(result.current.speakerPhase).toBe("speaking"));
		const audio = FakeAudio.instances[0];
		expect(audio).toBeDefined();
		if (!audio) return;

		act(() => result.current.pauseSpeech());
		audio.play.mockRejectedValueOnce(new Error("speaker unavailable"));
		act(() => result.current.resumeSpeech());

		await waitFor(() =>
			expect(result.current.error).toContain("speaker unavailable"),
		);
		expect(result.current.speakerPhase).toBe("idle");
		expect(micState.options?.shouldSuppressInput?.()).toBe(false);
		expect(audio.src).toBe("");
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-speech");
	});

	it("stops speech for only the current assistant response", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({
			messages: [assistant("Current response starts here. ")],
		});
		await waitFor(() => expect(result.current.speakerPhase).toBe("speaking"));
		expect(fetch).toHaveBeenCalledOnce();

		act(() => result.current.stopSpeech());
		expect(result.current).toMatchObject({
			active: true,
			speakerPhase: "idle",
		});
		expect(micState.stop).not.toHaveBeenCalled();
		expect(micState.options?.shouldSuppressInput?.()).toBe(false);

		rerender({
			messages: [
				assistant("Current response starts here. More should stay silent. "),
			],
		});
		await act(async () => Promise.resolve());
		expect(fetch).toHaveBeenCalledOnce();

		rerender({
			messages: [
				assistant("A later response speaks normally. ", {
					id: "assistant-2",
				}),
			],
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(result.current.speakerPhase).toBe("speaking"));
	});

	it("keeps a deferred synthesis silent after stopping speech", async () => {
		const synthesis = deferred<Response>();
		vi.mocked(fetch).mockReturnValueOnce(synthesis.promise);
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({ messages: [assistant("Deferred speech must stay silent. ")] });
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		expect(result.current.speakerPhase).toBe("synthesizing");
		const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;

		act(() => result.current.stopSpeech());
		expect(signal?.aborted).toBe(true);
		expect(result.current).toMatchObject({
			active: true,
			speakerPhase: "idle",
		});

		await act(async () => {
			synthesis.resolve(new Response(new Uint8Array([1])));
			await synthesis.promise;
			await Promise.resolve();
		});
		expect(FakeAudio.instances[0]?.play).toHaveBeenCalledOnce();
		expect(result.current.speakerPhase).toBe("idle");
		expect(micState.stop).not.toHaveBeenCalled();
	});

	it("keeps speaking status while prefetching the next segment", async () => {
		const secondSynthesis = deferred<Response>();
		vi.mocked(fetch)
			.mockResolvedValueOnce(new Response(new Uint8Array([1])))
			.mockReturnValueOnce(secondSynthesis.promise);
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());

		rerender({ messages: [assistant("First sentence. Second sentence.")] });
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(result.current.speakerPhase).toBe("speaking"));
		expect(micState.options?.shouldSuppressInput?.()).toBe(true);

		act(() => FakeAudio.instances[0]?.onended?.());
		await waitFor(() =>
			expect(result.current.speakerPhase).toBe("synthesizing"),
		);
		expect(micState.options?.shouldSuppressInput?.()).toBe(false);

		secondSynthesis.resolve(new Response(new Uint8Array([1])));
		await waitFor(() => expect(result.current.speakerPhase).toBe("speaking"));
		act(() => FakeAudio.instances[0]?.onended?.());
		await waitFor(() => expect(result.current.speakerPhase).toBe("idle"));
	});

	it("seeds a mid-stream response without speaking a word fragment", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{
				initialProps: {
					messages: [assistant("I'll ins", { streaming: true })],
				},
			},
		);
		await act(async () => result.current.start());

		rerender({
			messages: [assistant("I'll inspect that.", { streaming: false })],
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		expect(
			JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).text,
		).toBe("I'll inspect that.");

		act(() => FakeAudio.instances[0]?.onended?.());
		rerender({
			messages: [
				assistant("Fresh response.", {
					id: "assistant-2",
					streaming: true,
				}),
			],
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		const request = vi.mocked(fetch).mock.calls[1]?.[1];
		expect(JSON.parse(String(request?.body)).text).toBe("Fresh response.");
	});

	it("allows revised speech to return from A to B to A with fresh queue tokens", async () => {
		let requestIndex = 0;
		vi.mocked(fetch).mockImplementation((_input, init) => {
			const index = requestIndex++;
			if (index >= 2) {
				return Promise.resolve(new Response(new Uint8Array([1])));
			}
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
			});
		});
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());

		rerender({ messages: [assistant("Original answer.")] });
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		rerender({ messages: [assistant("Replacement answer.")] });
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		rerender({ messages: [assistant("Original answer.")] });
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));

		expect(
			vi
				.mocked(fetch)
				.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).text),
		).toEqual(["Original answer.", "Replacement answer.", "Original answer."]);
		await waitFor(() =>
			expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(2),
		);
		expect(result.current.error).toBeNull();
	});

	it("lets an old pump clean only its own playback", async () => {
		const oldSynthesis = deferred<Response>();
		let requestIndex = 0;
		vi.mocked(fetch).mockImplementation(() => {
			if (requestIndex++ === 0) return oldSynthesis.promise;
			return Promise.resolve(new Response(new Uint8Array([1])));
		});
		vi.mocked(URL.createObjectURL).mockReturnValue("blob:new-speech");
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({ messages: [assistant("Old response.")] });
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());

		act(() => result.current.stopSpeech());
		rerender({
			messages: [
				assistant("New response.", {
					id: "assistant-2",
					streaming: true,
				}),
			],
		});
		await waitFor(() => expect(result.current.speakerPhase).toBe("speaking"));
		expect(micState.options?.shouldSuppressInput?.()).toBe(true);

		await act(async () => {
			oldSynthesis.resolve(new Response(new Uint8Array([1])));
			await oldSynthesis.promise;
			await Promise.resolve();
		});
		expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:new-speech");
		expect(micState.options?.shouldSuppressInput?.()).toBe(true);

		act(() => FakeAudio.instances[0]?.onended?.());
		await waitFor(() =>
			expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:new-speech"),
		);
		expect(micState.options?.shouldSuppressInput?.()).toBe(false);
	});

	it("retries transient local speech queue pressure", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "speech queue is full" }), {
					status: 429,
					headers: { "retry-after": "0" },
				}),
			)
			.mockResolvedValueOnce(new Response(new Uint8Array([1])));
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({ messages: [assistant("Queue pressure is temporary. ")] });

		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(2),
		);
		expect(result.current.error).toBeNull();
	});

	it("force-flushes prose when tool activity begins", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({
			messages: [assistant("I'll inspect that", { toolCount: 0 })],
		});
		expect(fetch).not.toHaveBeenCalled();

		rerender({
			messages: [assistant("I'll inspect that", { toolCount: 1 })],
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		const request = vi.mocked(fetch).mock.calls[0]?.[1];
		expect(JSON.parse(String(request?.body)).text).toBe("I'll inspect that.");
	});

	it("observes an old response's final tail before a queued turn opens", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({
			messages: [assistant("I'll ins", { id: "assistant-1", streaming: true })],
		});
		expect(fetch).not.toHaveBeenCalled();

		// session_replay can settle the old response and open the queued turn's
		// blank assistant in the same React render.
		rerender({
			messages: [
				assistant("I'll inspect that.", {
					id: "assistant-1",
					streaming: false,
					toolCount: 1,
				}),
				{ id: "queued-user", role: "user", text: "Also check this." },
				assistant("", { id: "assistant-2", streaming: true }),
			],
		});

		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		expect(
			JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).text,
		).toBe("I'll inspect that.");
	});

	it("does not replay speech when history hydration replaces the live id", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({
			messages: [
				assistant("Hydration should not repeat this sentence.", {
					id: "live-assistant",
					dbId: 42,
					streaming: false,
				}),
			],
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());

		rerender({
			messages: [
				assistant("Hydration should not repeat this sentence.", {
					id: "persisted-message:42",
					dbId: 42,
					transcriptSeq: 3,
					streaming: false,
				}),
			],
		});
		await act(async () => Promise.resolve());
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("keeps Stop speech suppression across a hydrated assistant id", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({
			messages: [
				assistant("Stop this response.", {
					id: "live-assistant",
					dbId: 43,
					streaming: true,
				}),
			],
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		act(() => result.current.stopSpeech());

		rerender({
			messages: [
				assistant("Stop this response. Hydrated text stays silent.", {
					id: "persisted-message:43",
					dbId: 43,
					transcriptSeq: 5,
					streaming: false,
				}),
			],
		});
		await act(async () => Promise.resolve());
		expect(fetch).toHaveBeenCalledOnce();
		expect(result.current.speakerPhase).toBe("idle");
	});

	it("hard-mutes for structured attention and never submits casual speech as an answer", async () => {
		const onTranscription = vi.fn();
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription,
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		await act(async () => micState.options?.onTranscription("also do this"));
		expect(onTranscription).toHaveBeenCalledWith("also do this");

		rerender({
			messages: [
				{
					id: "permission-1",
					role: "permission",
					toolName: "write",
					title: "Write file",
					decision: "pending",
				},
			],
		});
		await waitFor(() => expect(micState.setMuted).toHaveBeenCalledWith(true));
		await act(async () => micState.options?.onTranscription("yes"));
		expect(onTranscription).toHaveBeenCalledTimes(1);

		act(() => result.current.setMuted(false));
		expect(micState.setMuted).not.toHaveBeenCalledWith(false);
	});

	it("keeps hard mute across assistant completion", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{
				initialProps: {
					messages: [assistant("Working", { streaming: true })],
				},
			},
		);
		await act(async () => result.current.start());
		act(() => result.current.setMuted(true));
		expect(micState.setMuted).toHaveBeenCalledWith(true);

		rerender({
			messages: [assistant("Working complete", { streaming: false })],
		});
		expect(micState.setMuted).not.toHaveBeenCalledWith(false);
	});

	it("finishes the current utterance when the user toggles mute", async () => {
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());

		act(() => result.current.toggleMuted());
		expect(micState.setMuted).toHaveBeenCalledWith(true, {
			finishCurrentUtterance: true,
		});

		micState.isMuted = true;
		rerender({ messages: [] });
		act(() => result.current.toggleMuted());
		expect(micState.setMuted).toHaveBeenCalledWith(false, {
			finishCurrentUtterance: false,
		});
	});

	it("holds unread progress while a spoken follow-up is being queued", async () => {
		const synthesis = deferred<Response>();
		vi.mocked(fetch).mockReturnValueOnce(synthesis.promise);
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useLocalConversation({
					...baseOptions,
					messages,
					onTranscription: vi.fn(),
				}),
			{ initialProps: { messages: [] as ChatMessage[] } },
		);
		await act(async () => result.current.start());
		rerender({
			messages: [assistant("I'll inspect that", { toolCount: 1 })],
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		expect(result.current.speakerPhase).toBe("synthesizing");
		const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;

		act(() => micState.options?.onSpeechStart?.());
		synthesis.resolve(new Response(new Uint8Array([1])));
		await act(async () => {
			await synthesis.promise;
			await Promise.resolve();
		});
		expect(signal?.aborted).toBe(false);
		expect(FakeAudio.instances[0]?.play).toHaveBeenCalledOnce();

		act(() => micState.options?.onSpeechSettled?.());
		await waitFor(() =>
			expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(2),
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(result.current.speakerPhase).toBe("speaking");
	});
});

describe("hasPendingLocalConversationAttention", () => {
	it("recognizes every structured Raven interaction", () => {
		const messages: ChatMessage[] = [
			{
				id: "question-1",
				role: "ask_user_question",
				questions: [],
				answers: null,
			},
			{
				id: "plan-1",
				role: "plan_proposal",
				plan: "Review this plan",
				decision: "pending",
			},
		];
		expect(hasPendingLocalConversationAttention(messages)).toBe(true);
	});
});
