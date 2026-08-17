import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { MAX_TTS_RUNTIME_INSTALL_BODY_BYTES } from "#/server/ttsRuntimeInstall";
import { makeRequest } from "#/test/routeTestKit";
import { handleTtsRuntimeInstall } from "./install";

vi.mock("#/lib/originGate");
vi.mock("#/lib/dbClient");

const mockDbFetch = vi.mocked(dbFetch);
const mockForbidden = vi.mocked(forbiddenResponse);

function request(body: BodyInit = "runtime", headers: HeadersInit = {}) {
	return makeRequest("/api/tts/runtime/install", {
		method: "POST",
		headers: {
			"content-type": "multipart/form-data; boundary=test",
			...headers,
		},
		body,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockForbidden.mockReturnValue(null);
	mockDbFetch.mockResolvedValue(Response.json({ ok: true }));
});

describe("DirectML runtime install route adapter", () => {
	it("applies the origin gate before reading the artifact", async () => {
		mockForbidden.mockReturnValue(new Response("Forbidden", { status: 403 }));
		expect((await handleTtsRuntimeInstall(request())).status).toBe(403);
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("rejects a declared oversized artifact", async () => {
		const response = await handleTtsRuntimeInstall(
			request("runtime", {
				"content-length": String(MAX_TTS_RUNTIME_INSTALL_BODY_BYTES + 1),
			}),
		);
		expect(response.status).toBe(413);
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("proxies only a bounded multipart artifact", async () => {
		const response = await handleTtsRuntimeInstall(request("bounded runtime"));
		expect(response.status).toBe(200);
		expect(mockDbFetch).toHaveBeenCalledWith(
			"/tts/runtime/install",
			expect.objectContaining({
				method: "POST",
				body: expect.any(ArrayBuffer),
			}),
		);
	});
});
