import { describe, expect, it, vi } from "vitest";
import {
	createReadAloudRouteHandler,
	MAX_READ_ALOUD_TEXT_CHARS,
} from "./readAloudRoutes";

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
		expect(response?.headers.get("cache-control")).toBe("private, no-store");
		expect(response?.headers.get("content-length")).toBe("17");
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

	it.each([
		["missing", null, 404, "assistant message not found"],
		["empty", "", 422, "message has no readable text"],
		[
			"oversized",
			"x".repeat(MAX_READ_ALOUD_TEXT_CHARS + 1),
			413,
			"message is too long to synthesize",
		],
	] as const)("validates %s message text before selecting the neural provider", async (_name, markdown, status, error) => {
		const synthesize = vi.fn();
		const getNeuralSettings = vi.fn(() => ({
			voiceId: "expr-voice-5-f",
			rate: 1,
		}));
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: { synthesize },
			getAssistantMessageText: vi.fn().mockResolvedValue(markdown),
			getNeuralSettings,
		});
		const url = new URL(
			"http://localhost/read-aloud/audio?message_id=42&provider=neural&chunk_index=0",
		);

		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);

		expect(response?.status).toBe(status);
		expect(await response?.json()).toEqual({ error });
		expect(getNeuralSettings).not.toHaveBeenCalled();
		expect(synthesize).not.toHaveBeenCalled();
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
		expect(second?.headers.get("retry-after")).toBe("1");
		resolveAudio?.(new TextEncoder().encode("RIFF0000WAVEaudio"));
		expect((await first)?.status).toBe(200);
	});

	it("releases the Microsoft synthesis gate after a provider failure", async () => {
		const synthesize = vi
			.fn()
			.mockRejectedValueOnce(new Error("Microsoft speech failed"))
			.mockResolvedValueOnce(new TextEncoder().encode("RIFF0000WAVEaudio"));
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize },
			getAssistantMessageText: vi.fn().mockResolvedValue("Read this"),
		});
		const url = new URL("http://localhost/read-aloud/audio?message_id=42");

		const failed = await handler(url, request(`${url.pathname}${url.search}`));
		const retried = await handler(url, request(`${url.pathname}${url.search}`));

		expect(failed?.status).toBe(503);
		expect(await failed?.json()).toEqual({ error: "Microsoft speech failed" });
		expect(retried?.status).toBe(200);
		expect(synthesize).toHaveBeenCalledTimes(2);
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

	it.each([
		["non-numeric", "bad", 400, "invalid chunk_index"],
		["fractional", "1.5", 400, "invalid chunk_index"],
		["negative", "-1", 400, "invalid chunk_index"],
		["past the end", "99", 416, "read-aloud chunk not found"],
	] as const)("rejects a %s neural chunk before synthesis", async (_name, chunkIndex, status, error) => {
		const synthesize = vi.fn();
		const getNeuralSettings = vi.fn(() => ({
			voiceId: "expr-voice-5-f",
			rate: 1,
		}));
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: { synthesize },
			getAssistantMessageText: vi.fn().mockResolvedValue("Read this"),
			getNeuralSettings,
		});
		const url = new URL(
			`http://localhost/read-aloud/audio?message_id=42&provider=neural&chunk_index=${chunkIndex}`,
		);

		const response = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);

		expect(response?.status).toBe(status);
		expect(await response?.json()).toEqual({ error });
		expect(getNeuralSettings).not.toHaveBeenCalled();
		expect(synthesize).not.toHaveBeenCalled();
	});

	it("maps neural queue pressure to 429 and other failures to 503", async () => {
		const synthesize = vi
			.fn()
			.mockRejectedValueOnce(new Error("neural queue is full"))
			.mockRejectedValueOnce(new Error("neural runtime unavailable"));
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: { synthesize },
			getAssistantMessageText: vi.fn().mockResolvedValue("Read this"),
		});
		const url = new URL(
			"http://localhost/read-aloud/audio?message_id=42&provider=neural&chunk_index=0",
		);

		const busy = await handler(url, request(`${url.pathname}${url.search}`));
		const unavailable = await handler(
			url,
			request(`${url.pathname}${url.search}`),
		);

		expect(busy?.status).toBe(429);
		expect(busy?.headers.get("retry-after")).toBe("1");
		expect(await busy?.json()).toEqual({ error: "neural queue is full" });
		expect(unavailable?.status).toBe(503);
		expect(unavailable?.headers.get("retry-after")).toBeNull();
		expect(await unavailable?.json()).toEqual({
			error: "neural runtime unavailable",
		});
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

	it("maps neural preview failures to service unavailable", async () => {
		const handler = createReadAloudRouteHandler({
			speech: { voices: vi.fn(), synthesize: vi.fn() },
			tts: {
				synthesize: vi
					.fn()
					.mockRejectedValue(new Error("preview model unavailable")),
			},
			getAssistantMessageText: vi.fn(),
		});
		const response = await handler(
			new URL("http://localhost/read-aloud/preview"),
			request("/read-aloud/preview"),
		);

		expect(response?.status).toBe(503);
		expect(await response?.json()).toEqual({
			error: "preview model unavailable",
		});
	});
});
