/**
 * Unit tests for the /db/session-row endpoint in dbRoutes.ts.
 * DB is mocked; only the routing logic inside handleDbRoute is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../db";

// ── mocks ─────────────────────────────────────────────────────────────────────

// vi.mock factories are hoisted before module-level code, so vars referenced
// inside them must also be hoisted via vi.hoisted().
const { mockGetSessionById } = vi.hoisted(() => ({
	mockGetSessionById: vi.fn(),
}));

vi.mock("../db", () => ({
	getSessionById: mockGetSessionById,
}));

// dbRoutes also imports from ./attachments and ./proxy — stub them out.
vi.mock("./attachments", () => ({
	unlinkPaths: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./proxy", () => ({
	getWindowMark: vi.fn().mockReturnValue(null),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import { handleDbRoute } from "./dbRoutes";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeUrl(pathname: string, params?: Record<string, string>): URL {
	const url = new URL(`http://localhost${pathname}`);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, v);
		}
	}
	return url;
}

function makeRequest(method = "GET"): Request {
	return new Request("http://localhost/", { method });
}

const sampleRow: SessionRow = {
	id: "abc-123",
	label: "test session",
	model: "claude-3-opus",
	started_at: 1700000000000,
	ended_at: 1700000060000,
	query_count: 5,
	total_cost: 0.0123,
	total_input_tokens: 1000,
	total_output_tokens: 500,
	total_cache_read_tokens: 200,
	total_cache_creation_tokens: 100,
	total_turns: 3,
};

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.clearAllMocks();
});

describe("handleDbRoute — /db/session-row", () => {
	it("returns 400 when id param is missing", async () => {
		const url = makeUrl("/db/session-row");
		const req = makeRequest("GET");

		const res = await handleDbRoute(url, req);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).toMatch(/missing id/i);
	});

	it("returns JSON null body for unknown id", async () => {
		mockGetSessionById.mockResolvedValue(null);

		const url = makeUrl("/db/session-row", { id: "unknown-id" });
		const req = makeRequest("GET");

		const res = await handleDbRoute(url, req);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toBeNull();
	});

	it("returns the SessionRow as JSON for a known id", async () => {
		mockGetSessionById.mockResolvedValue(sampleRow);

		const url = makeUrl("/db/session-row", { id: "abc-123" });
		const req = makeRequest("GET");

		const res = await handleDbRoute(url, req);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual(sampleRow);
		expect(mockGetSessionById).toHaveBeenCalledWith("abc-123");
	});

	it("returns null (no match) for a POST request to /db/session-row", async () => {
		const url = makeUrl("/db/session-row", { id: "abc-123" });
		const req = makeRequest("POST");

		const res = await handleDbRoute(url, req);

		expect(res).toBeNull();
		expect(mockGetSessionById).not.toHaveBeenCalled();
	});
});
