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
		const handler = createReadAloudRouteHandler({
			speech: {
				voices: vi.fn().mockResolvedValue([voice]),
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
});
