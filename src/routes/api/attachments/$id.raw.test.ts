import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/dbClient", () => ({ dbFetch: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));

import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { handleRawAttachment } from "./$id.raw";

const mockDbFetch = vi.mocked(dbFetch);
const mockForbidden = vi.mocked(forbiddenResponse);

beforeEach(() => {
	vi.clearAllMocks();
	mockForbidden.mockReturnValue(null);
});

describe("raw attachment route adapter", () => {
	it("uses the authenticated internal client and preserves image headers", async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		mockDbFetch.mockResolvedValue(
			new Response(bytes, {
				headers: {
					"content-type": "image/png",
					"content-disposition": "inline; filename=preview.png",
					"content-length": String(bytes.byteLength),
					"x-content-type-options": "nosniff",
				},
			}),
		);

		const response = await handleRawAttachment(
			new Request("http://localhost/api/attachments/relic-1/raw"),
			"relic-1",
		);

		expect(mockDbFetch).toHaveBeenCalledWith("/api/attachments/relic-1/raw");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("content-length")).toBe("4");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	});

	it("applies the browser-facing origin gate first", async () => {
		mockForbidden.mockReturnValue(new Response("Forbidden", { status: 403 }));

		const response = await handleRawAttachment(
			new Request("http://localhost/api/attachments/relic-1/raw"),
			"relic-1",
		);

		expect(response.status).toBe(403);
		expect(mockDbFetch).not.toHaveBeenCalled();
	});

	it("returns a visible failure when the internal service is unavailable", async () => {
		mockDbFetch.mockRejectedValue(new Error("connection refused"));

		const response = await handleRawAttachment(
			new Request("http://localhost/api/attachments/relic-1/raw"),
			"relic-1",
		);

		expect(response.status).toBe(502);
	});
});
