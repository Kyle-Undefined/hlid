import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/dbClient", () => ({ dbFetch: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));

import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { handleDeleteAttachment } from "./$id";

const mockDbFetch = vi.mocked(dbFetch);
const mockForbidden = vi.mocked(forbiddenResponse);

beforeEach(() => {
	vi.clearAllMocks();
	mockForbidden.mockReturnValue(null);
});

describe("delete attachment route adapter", () => {
	it("uses the authenticated internal client and keeps query parameters", async () => {
		mockDbFetch.mockResolvedValue(Response.json({ ok: true }));

		const response = await handleDeleteAttachment(
			new Request("http://localhost/api/attachments/relic-1?delete_file=true", {
				method: "DELETE",
			}),
			"relic-1",
		);

		expect(mockDbFetch).toHaveBeenCalledWith(
			"/api/attachments/relic-1?delete_file=true",
			{ method: "DELETE" },
		);
		expect(response.status).toBe(200);
	});

	it("applies the browser-facing origin gate first", async () => {
		mockForbidden.mockReturnValue(new Response("Forbidden", { status: 403 }));

		const response = await handleDeleteAttachment(
			new Request("http://localhost/api/attachments/relic-1", {
				method: "DELETE",
			}),
			"relic-1",
		);

		expect(response.status).toBe(403);
		expect(mockDbFetch).not.toHaveBeenCalled();
	});
});
