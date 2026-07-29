import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRequest } from "#/test/routeTestKit";

vi.mock("#/lib/originGate");
vi.mock("#/lib/dbClient");

import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { MAX_VOICE_BODY_BYTES } from "#/server/requestLimits";
import { handleVoiceTranscription } from "./transcribe";

const mockDbFetch = vi.mocked(dbFetch);
const mockForbidden = vi.mocked(forbiddenResponse);

const request = (body: BodyInit = "audio", headers: HeadersInit = {}) =>
	makeRequest("/api/voice/transcribe", {
		method: "POST",
		headers: {
			"content-type": "multipart/form-data; boundary=test",
			...headers,
		},
		body,
	});

beforeEach(() => {
	vi.clearAllMocks();
	mockForbidden.mockReturnValue(null);
	mockDbFetch.mockResolvedValue(Response.json({ text: "hello" }));
});

describe("voice transcription route adapter", () => {
	it("applies the origin gate before reading the body", async () => {
		mockForbidden.mockReturnValue(new Response("Forbidden", { status: 403 }));
		expect((await handleVoiceTranscription(request())).status).toBe(403);
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("requires multipart audio", async () => {
		const response = await handleVoiceTranscription(
			request("audio", { "content-type": "audio/wav" }),
		);
		expect(response.status).toBe(400);
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("rejects a declared oversized body before proxying", async () => {
		const response = await handleVoiceTranscription(
			request("audio", {
				"content-length": String(MAX_VOICE_BODY_BYTES + 1),
			}),
		);
		expect(response.status).toBe(413);
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("proxies a bounded body and preserves the internal response", async () => {
		const response = await handleVoiceTranscription(request("bounded audio"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ text: "hello" });
		expect(mockDbFetch).toHaveBeenCalledWith(
			"/voice/transcribe",
			expect.objectContaining({
				method: "POST",
				body: expect.any(ArrayBuffer),
			}),
		);
	});
});
