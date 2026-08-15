import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRequest } from "#/test/routeTestKit";

vi.mock("#/lib/originGate");
vi.mock("#/lib/dbClient");
vi.mock("#/lib/sameOriginRequest");

import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { isExactSameOriginMutation } from "#/lib/sameOriginRequest";
import { MAX_SPEECH_SYNTHESIS_BODY_BYTES } from "#/server/speechRoutes";
import { handleSpeechSynthesis } from "./synthesize";

const mockDbFetch = vi.mocked(dbFetch);
const mockForbidden = vi.mocked(forbiddenResponse);
const mockSameOrigin = vi.mocked(isExactSameOriginMutation);

function request(
	body: BodyInit = JSON.stringify({ text: "Hello from Hlid." }),
	headers: HeadersInit = { "content-type": "application/json" },
): Request {
	return makeRequest("/api/speech/synthesize", {
		method: "POST",
		headers,
		body,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockForbidden.mockReturnValue(null);
	mockSameOrigin.mockReturnValue(true);
	mockDbFetch.mockResolvedValue(
		new Response("RIFF0000WAVEaudio", {
			headers: {
				"cache-control": "private, no-store",
				"content-type": "audio/wav",
				"x-hlid-audio-duration-ms": "1250",
				"x-hlid-synthesis-ms": "425",
			},
		}),
	);
});

describe("speech synthesis route adapter", () => {
	it("applies the origin gate before reading or forwarding the body", async () => {
		mockForbidden.mockReturnValue(new Response("Forbidden", { status: 403 }));

		const response = await handleSpeechSynthesis(request());

		expect(response.status).toBe(403);
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("requires a JSON body", async () => {
		const response = await handleSpeechSynthesis(
			request("speech", { "content-type": "text/plain" }),
		);

		expect(response.status).toBe(415);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("rejects a browser mutation that is not exact same-origin", async () => {
		mockSameOrigin.mockReturnValue(false);

		const response = await handleSpeechSynthesis(request());

		expect(response.status).toBe(403);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("rejects an oversized body before proxying", async () => {
		const response = await handleSpeechSynthesis(
			request("{}", {
				"content-type": "application/json",
				"content-length": String(MAX_SPEECH_SYNTHESIS_BODY_BYTES + 1),
			}),
		);

		expect(response.status).toBe(413);
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("proxies the bounded body and preserves WAV metadata", async () => {
		const body = JSON.stringify({
			text: "Hello from Hlid.",
			voice_id: "expr-voice-5-f",
			rate: 1.25,
		});

		const response = await handleSpeechSynthesis(request(body));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("audio/wav");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-hlid-synthesis-ms")).toBe("425");
		expect(response.headers.get("x-hlid-audio-duration-ms")).toBe("1250");
		expect(await response.text()).toBe("RIFF0000WAVEaudio");
		expect(mockDbFetch).toHaveBeenCalledWith(
			"/speech/synthesize",
			expect.objectContaining({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: expect.any(ArrayBuffer),
				signal: expect.any(AbortSignal),
			}),
		);
		const forwardedBody = mockDbFetch.mock.calls[0]?.[1]?.body;
		expect(forwardedBody).toBeInstanceOf(ArrayBuffer);
		expect(new TextDecoder().decode(forwardedBody as ArrayBuffer)).toBe(body);
	});
});
