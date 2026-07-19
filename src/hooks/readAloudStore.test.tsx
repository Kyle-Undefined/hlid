// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READ_ALOUD_PREFERENCES_KEY } from "#/lib/readAloud";
import {
	__resetReadAloudForTesting,
	setReadAloudPreferences,
	startReadAloud,
	stopReadAloud,
	toggleReadAloud,
	useLocalReadAloudVoices,
	useReadAloudPreferences,
	useReadAloudState,
} from "./readAloudStore";

class MockUtterance {
	voice: SpeechSynthesisVoice | null = null;
	lang = "";
	rate = 1;
	onend: (() => void) | null = null;
	onerror: ((event: { error: string }) => void) | null = null;
	onboundary: ((event: { charIndex: number }) => void) | null = null;
	onstart: (() => void) | null = null;

	constructor(readonly text: string) {}
}

const localVoice = {
	voiceURI: "local:david",
	name: "David",
	lang: "en-US",
	localService: true,
	default: true,
} as SpeechSynthesisVoice;

const remoteVoice = {
	voiceURI: "remote:natural",
	name: "Remote Natural",
	lang: "en-US",
	localService: false,
	default: false,
} as SpeechSynthesisVoice;

const speech = {
	getVoices: vi.fn(() => [remoteVoice, localVoice]),
	speak: vi.fn(),
	cancel: vi.fn(),
	pause: vi.fn(),
	resume: vi.fn(),
	addEventListener: vi.fn(),
	removeEventListener: vi.fn(),
};

beforeEach(() => {
	__resetReadAloudForTesting();
	localStorage.clear();
	vi.clearAllMocks();
	Object.defineProperty(window, "speechSynthesis", {
		value: speech,
		configurable: true,
	});
	vi.stubGlobal("SpeechSynthesisUtterance", MockUtterance);
});

afterEach(() => {
	stopReadAloud();
	cleanup();
	vi.unstubAllGlobals();
});

describe("readAloudStore", () => {
	it("uses only a device-local voice and applies stored speed", () => {
		const { result } = renderHook(() => useReadAloudState());
		act(() =>
			setReadAloudPreferences({ voiceURI: localVoice.voiceURI, rate: 1.25 }),
		);
		act(() =>
			startReadAloud("message-1", "Read **this**.\n\n```ts\nnotThis()\n```"),
		);

		expect(result.current).toEqual({
			messageId: "message-1",
			phase: "speaking",
			error: null,
		});
		const utterance = speech.speak.mock.calls[0]?.[0] as MockUtterance;
		expect(utterance.text).toBe("Read this.");
		expect(utterance.voice).toBe(localVoice);
		expect(utterance.rate).toBe(1.25);
		expect(speech.speak).toHaveBeenCalledTimes(1);

		act(() => utterance.onend?.());
		expect(result.current.phase).toBe("idle");
	});

	it("resumes through a fresh utterance from Chrome's latest word boundary", () => {
		const { result } = renderHook(() => useReadAloudState());
		act(() => startReadAloud("message-1", "First second third."));
		const first = speech.speak.mock.calls[0]?.[0] as MockUtterance;
		act(() => first.onboundary?.({ charIndex: 6 }));

		act(() => toggleReadAloud("message-1", "First second third."));
		expect(speech.cancel).toHaveBeenCalled();
		expect(speech.pause).not.toHaveBeenCalled();
		expect(result.current.phase).toBe("paused");

		act(() => toggleReadAloud("message-1", "First second third."));
		expect(speech.resume).not.toHaveBeenCalled();
		const resumed = speech.speak.mock.calls[1]?.[0] as MockUtterance;
		expect(resumed.text).toBe("second third.");
		expect(result.current.phase).toBe("speaking");

		act(() => first.onend?.());
		expect(result.current.phase).toBe("speaking");
		act(() => resumed.onend?.());
		expect(result.current.phase).toBe("idle");

		act(stopReadAloud);
		expect(speech.cancel).toHaveBeenCalled();
		expect(result.current.phase).toBe("idle");
	});

	it("uses elapsed progress across repeated resumes when Android omits boundaries", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const text = "One two three four five six seven eight nine ten.";
		const { result } = renderHook(() => useReadAloudState());
		act(() => startReadAloud("message-1", text));
		const first = speech.speak.mock.calls[0]?.[0] as MockUtterance;
		act(() => first.onstart?.());

		now.mockReturnValue(3_200);
		act(() => toggleReadAloud("message-1", text));
		expect(result.current.phase).toBe("paused");
		act(() => toggleReadAloud("message-1", text));
		const second = speech.speak.mock.calls[1]?.[0] as MockUtterance;
		expect(second.text).toBe("four five six seven eight nine ten.");
		act(() => second.onstart?.());

		now.mockReturnValue(4_300);
		act(() => toggleReadAloud("message-1", text));
		expect(result.current.phase).toBe("paused");
		act(() => toggleReadAloud("message-1", text));
		const third = speech.speak.mock.calls[2]?.[0] as MockUtterance;
		expect(third.text).toBe("five six seven eight nine ten.");
		expect(result.current.phase).toBe("speaking");
		now.mockRestore();
	});

	it("lets Chrome invoke its locally reported default for Automatic", () => {
		act(() => startReadAloud("message-1", "Use the default voice."));
		const utterance = speech.speak.mock.calls[0]?.[0] as MockUtterance;
		expect(utterance.voice).toBeNull();
		expect(utterance.lang).toBe("");
	});

	it("exposes and persists per-device preferences", () => {
		const { result } = renderHook(() => useReadAloudPreferences());
		act(() =>
			setReadAloudPreferences({ voiceURI: localVoice.voiceURI, rate: 1.5 }),
		);
		expect(result.current).toEqual({
			voiceURI: localVoice.voiceURI,
			rate: 1.5,
		});
		expect(
			JSON.parse(localStorage.getItem(READ_ALOUD_PREFERENCES_KEY) ?? "{}"),
		).toEqual(result.current);
	});

	it("only lists voices the browser reports as local", () => {
		const { result } = renderHook(() => useLocalReadAloudVoices());
		expect(result.current).toEqual([
			{
				voiceURI: localVoice.voiceURI,
				name: localVoice.name,
				lang: localVoice.lang,
				default: localVoice.default,
			},
		]);
	});
});
