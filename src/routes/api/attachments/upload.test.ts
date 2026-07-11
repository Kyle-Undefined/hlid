import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/config", () => ({ getConfig: vi.fn() }));
vi.mock("#/lib/dbClient", () => ({ dbFetch: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));

import { getConfig } from "#/config";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { MULTIPART_OVERHEAD_BYTES } from "#/server/requestLimits";
import { handleAttachmentUpload } from "./upload";

const mockGetConfig = vi.mocked(getConfig);
const mockDbFetch = vi.mocked(dbFetch);
const mockForbidden = vi.mocked(forbiddenResponse);

function request(
	body: BodyInit = "upload",
	headers: HeadersInit = {},
): Request {
	return new Request("http://localhost/api/attachments/upload", {
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
	mockDbFetch.mockResolvedValue(Response.json({ id: "a1" }));
	mockForbidden.mockReturnValue(null);
	mockGetConfig.mockResolvedValue({
		server: { port: 3000 },
		attachments: { max_bytes: 100, allowed_mimes: [] },
	} as unknown as Awaited<ReturnType<typeof getConfig>>);
});

describe("attachment upload route adapter", () => {
	it("applies the origin gate before loading config", async () => {
		mockForbidden.mockReturnValue(new Response("Forbidden", { status: 403 }));
		expect((await handleAttachmentUpload(request())).status).toBe(403);
		expect(mockGetConfig).not.toHaveBeenCalled();
	});

	it("rejects a declared oversized upload", async () => {
		const response = await handleAttachmentUpload(
			request("upload", {
				"content-length": String(100 + MULTIPART_OVERHEAD_BYTES + 1),
			}),
		);
		expect(response.status).toBe(413);
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("proxies bounded bytes to the configured internal port", async () => {
		const response = await handleAttachmentUpload(request("bounded upload"));
		expect(response.status).toBe(200);
		expect(mockDbFetch).toHaveBeenCalledWith(
			"/api/attachments/upload",
			expect.objectContaining({
				method: "POST",
				body: expect.any(ArrayBuffer),
			}),
		);
	});

	it("returns a visible proxy failure", async () => {
		mockDbFetch.mockRejectedValueOnce(new Error("connection refused"));
		const response = await handleAttachmentUpload(request());
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual(
			expect.objectContaining({ error: "proxy_failed" }),
		);
	});
});
