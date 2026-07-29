import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/originGate");
vi.mock("#/lib/dbClient");

import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { handleMicrosoftAudio } from "./audio";
import { handleNeuralPreview } from "./preview";
import { handleMicrosoftVoices } from "./voices";

const mockDbFetch = vi.mocked(dbFetch);
const mockForbidden = vi.mocked(forbiddenResponse);

beforeEach(() => {
	vi.clearAllMocks();
	mockForbidden.mockReturnValue(null);
	mockDbFetch.mockResolvedValue(Response.json({ ok: true }));
});

describe("read aloud route adapters", () => {
	it("applies the request gate before proxying", async () => {
		mockForbidden.mockReturnValue(new Response("Forbidden", { status: 403 }));
		const response = await handleMicrosoftVoices(
			new Request("http://localhost/api/read-aloud/voices"),
		);
		expect(response.status).toBe(403);
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("proxies Microsoft voice inventory", async () => {
		await handleMicrosoftVoices(
			new Request("http://localhost/api/read-aloud/voices"),
		);
		expect(mockDbFetch).toHaveBeenCalledWith(
			"/read-aloud/voices",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("forwards an explicit Microsoft voice refresh", async () => {
		await handleMicrosoftVoices(
			new Request("http://localhost/api/read-aloud/voices?refresh=1"),
		);
		expect(mockDbFetch).toHaveBeenCalledWith(
			"/read-aloud/voices?refresh=1",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("forwards only the bounded audio lookup parameters", async () => {
		await handleMicrosoftAudio(
			new Request(
				"http://localhost/api/read-aloud/audio?message_id=42&voice_id=windows%3Amark&ignored=1",
			),
		);
		expect(mockDbFetch).toHaveBeenCalledWith(
			"/read-aloud/audio?message_id=42&voice_id=windows%3Amark",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("forwards only the bounded neural chunk parameters", async () => {
		await handleMicrosoftAudio(
			new Request(
				"http://localhost/api/read-aloud/audio?message_id=42&provider=neural&chunk_index=3&voice_id=ignored",
			),
		);
		expect(mockDbFetch).toHaveBeenCalledWith(
			"/read-aloud/audio?message_id=42&voice_id=ignored&provider=neural&chunk_index=3",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("proxies the fixed neural voice preview", async () => {
		await handleNeuralPreview(
			new Request("http://localhost/api/read-aloud/preview"),
		);
		expect(mockDbFetch).toHaveBeenCalledWith(
			"/read-aloud/preview",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});
});
