import { describe, expect, it, vi } from "vitest";
import { createReadAloudRouteHandler } from "./readAloudRoutes";

const voice = {
	id: "windows:mark",
	name: "Microsoft Mark",
	language: "en-US",
	gender: "Male",
	default: true,
};

function request(path: string): Request {
	return new Request(`http://localhost${path}`);
}

describe("read aloud internal routes", () => {
	it("reports Microsoft voice availability", async () => {
		const voices = vi.fn().mockResolvedValue([voice]);
		const handler = createReadAloudRouteHandler({
			speech: {
				voices,
				synthesize: vi.fn(),
			},
			getAssistantMessageText: vi.fn(),
		});
		const response = await handler(
			new URL("http://localhost/read-aloud/voices"),
			request("/read-aloud/voices"),
		);
		expect(await response?.json()).toEqual({
			available: true,
			voices: [voice],
		});
		expect(voices).toHaveBeenCalledWith(false);
	});

	it("refreshes the Microsoft voice inventory on request", async () => {
		const voices = vi.fn().mockResolvedValue([voice]);
		const handler = createReadAloudRouteHandler({
			speech: { voices, synthesize: vi.fn() },
			getAssistantMessageText: vi.fn(),
		});
		await handler(
			new URL("http://localhost/read-aloud/voices?refresh=1"),
			request("/read-aloud/voices?refresh=1"),
		);
		expect(voices).toHaveBeenCalledWith(true);
	});

	it("returns unavailable inventory without exposing an endpoint failure", async () => {
		const handler = createReadAloudRouteHandler({
			speech: {
				voices: vi.fn().mockRejectedValue(new Error("PowerShell missing")),
				synthesize: vi.fn(),
			},
			getAssistantMessageText: vi.fn(),
		});
		const response = await handler(
			new URL("http://localhost/read-aloud/voices"),
			request("/read-aloud/voices"),
		);
		expect(await response?.json()).toEqual({
			available: false,
			voices: [],
			error: "PowerShell missing",
		});
	});

	it("loads persisted assistant text, strips Markdown, and returns WAV", async () => {
		const synthesize = vi
			.fn()
			.mockResolvedValue(new TextEncoder().encode("RIFF0000WAVEaudio"));
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize },
			getAssistantMessageText: vi
				.fn()
				.mockResolvedValue("Read **this**.\n\n```ts\ndoNotRead()\n```"),
		});
		const url = new URL(
			"http://localhost/read-aloud/audio?message_id=42&voice_id=windows%3Amark",
		);
		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toBe("audio/wav");
		expect(synthesize).toHaveBeenCalledWith("Read this.", "windows:mark");
	});

	it("requires a persisted assistant message", async () => {
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			getAssistantMessageText: vi.fn().mockResolvedValue(null),
		});
		const url = new URL("http://localhost/read-aloud/audio?message_id=42");
		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);
		expect(response?.status).toBe(404);
	});

	it("admits only one synthesis at a time", async () => {
		let resolveAudio: ((value: Uint8Array) => void) | undefined;
		const pending = new Promise<Uint8Array>((resolve) => {
			resolveAudio = resolve;
		});
		const synthesize = vi.fn().mockReturnValue(pending);
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize },
			getAssistantMessageText: vi.fn().mockResolvedValue("Read this"),
		});
		const url = new URL("http://localhost/read-aloud/audio?message_id=42");
		const first = handler(url, request(`${url.pathname}${url.search}`));
		await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());
		const second = await handler(url, request(`${url.pathname}${url.search}`));
		expect(second?.status).toBe(429);
		resolveAudio?.(new TextEncoder().encode("RIFF0000WAVEaudio"));
		expect((await first)?.status).toBe(200);
	});

	it("synthesizes a bounded neural chunk with server-owned settings", async () => {
		const synthesize = vi.fn().mockResolvedValue({
			audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
			synthesisMs: 640,
			durationMs: 1_800,
		});
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: { synthesize },
			getAssistantMessageText: vi
				.fn()
				.mockResolvedValue(
					"Hlid reads a short first chunk and prepares the remainder.",
				),
			getNeuralSettings: () => ({
				voiceId: "expr-voice-5-f",
				rate: 1.25,
			}),
		});
		const url = new URL(
			"http://localhost/read-aloud/audio?message_id=42&provider=neural&chunk_index=0&voice_id=ignored",
		);
		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("x-hlid-has-next-chunk")).toBe("1");
		expect(response?.headers.get("x-hlid-synthesis-ms")).toBe("640");
		expect(synthesize).toHaveBeenCalledWith(
			expect.stringMatching(/^Hlid reads.*\.$/),
			"expr-voice-5-f",
			1.25,
		);
	});

	it("uses fixed text for neural voice preview", async () => {
		const synthesize = vi.fn().mockResolvedValue({
			audio: new TextEncoder().encode("RIFF0000WAVEaudio"),
		});
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: { synthesize },
			getAssistantMessageText: vi.fn(),
			getNeuralSettings: () => ({
				voiceId: "expr-voice-2-f",
				rate: 1,
			}),
		});
		const response = await handler(
			new URL("http://localhost/read-aloud/preview"),
			request("/read-aloud/preview"),
		);
		expect(response?.status).toBe(200);
		expect(synthesize).toHaveBeenCalledWith(
			"Hlid is ready to read replies aloud.",
			"expr-voice-2-f",
			1,
		);
	});
});
