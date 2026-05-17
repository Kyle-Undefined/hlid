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

import type { SessionStatusEntry } from "./protocol";
// ── pool mock factory ─────────────────────────────────────────────────────────
// Pool is passed as a parameter, no module mock needed — just a plain object.
import type { SessionPool } from "./sessionPool";

function makePool(
	overrides: Partial<{
		getSessionsStatus: () => SessionStatusEntry[];
		get: (id: string) => unknown;
		close: (id: string) => void;
		isVaultSession: (id: string) => boolean;
	}> = {},
): SessionPool {
	return {
		getSessionsStatus: vi.fn().mockReturnValue([]),
		get: vi.fn().mockReturnValue(undefined),
		close: vi.fn(),
		isVaultSession: vi.fn().mockReturnValue(false),
		...overrides,
	} as unknown as SessionPool;
}

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

// ── live session endpoints ────────────────────────────────────────────────────

const sampleStatus: SessionStatusEntry = {
	session_id: "pool-uuid-1",
	agent_cwd: "/home/kyle/vault",
	agent_name: "Vault",
	state: "idle",
	model: "claude-opus-4-5",
	hasPendingPermissions: false,
	hasDbSession: true,
	db_session_id: "db-session-1",
};

describe("handleDbRoute — GET /db/live-sessions", () => {
	it("returns SessionStatusEntry[] from pool", async () => {
		const pool = makePool({
			getSessionsStatus: vi.fn().mockReturnValue([sampleStatus]),
		});
		const url = makeUrl("/db/live-sessions");
		const req = makeRequest("GET");

		const res = await handleDbRoute(url, req, pool);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual([sampleStatus]);
	});

	it("returns [] when pool has no sessions", async () => {
		const pool = makePool({ getSessionsStatus: vi.fn().mockReturnValue([]) });
		const url = makeUrl("/db/live-sessions");
		const req = makeRequest("GET");

		const res = await handleDbRoute(url, req, pool);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("returns [] when no pool is provided", async () => {
		const url = makeUrl("/db/live-sessions");
		const req = makeRequest("GET");

		const res = await handleDbRoute(url, req, undefined);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});
});

describe("handleDbRoute — POST /db/live-sessions/stop", () => {
	it("returns 400 when session_id is missing", async () => {
		const pool = makePool();
		const url = makeUrl("/db/live-sessions/stop");
		const req = new Request("http://localhost/db/live-sessions/stop", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleDbRoute(url, req, pool);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(400);
		expect(await res.text()).toMatch(/missing session_id/i);
	});

	it("returns 404 when session_id not found in pool", async () => {
		const pool = makePool({ get: vi.fn().mockReturnValue(undefined) });
		const url = makeUrl("/db/live-sessions/stop");
		const req = new Request("http://localhost/db/live-sessions/stop", {
			method: "POST",
			body: JSON.stringify({ session_id: "unknown-uuid" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleDbRoute(url, req, pool);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(404);
		expect(await res.text()).toMatch(/session not found/i);
	});

	it("calls manager.abort() and returns ok for valid session_id", async () => {
		const mockAbort = vi.fn();
		const fakeEntry = { manager: { abort: mockAbort } };
		const pool = makePool({ get: vi.fn().mockReturnValue(fakeEntry) });
		const url = makeUrl("/db/live-sessions/stop");
		const req = new Request("http://localhost/db/live-sessions/stop", {
			method: "POST",
			body: JSON.stringify({ session_id: "pool-uuid-1" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleDbRoute(url, req, pool);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(mockAbort).toHaveBeenCalledTimes(1);
	});

	it("returns null for GET to /db/live-sessions/stop", async () => {
		const pool = makePool();
		const url = makeUrl("/db/live-sessions/stop");
		const req = makeRequest("GET");

		const res = await handleDbRoute(url, req, pool);

		expect(res).toBeNull();
	});
});

describe("handleDbRoute — POST /db/live-sessions/close", () => {
	it("returns 400 when session_id is missing", async () => {
		const pool = makePool();
		const url = makeUrl("/db/live-sessions/close");
		const req = new Request("http://localhost/db/live-sessions/close", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleDbRoute(url, req, pool);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(400);
		expect(await res.text()).toMatch(/missing session_id/i);
	});

	it("returns 404 when session_id not found in pool", async () => {
		const pool = makePool({ get: vi.fn().mockReturnValue(undefined) });
		const url = makeUrl("/db/live-sessions/close");
		const req = new Request("http://localhost/db/live-sessions/close", {
			method: "POST",
			body: JSON.stringify({ session_id: "unknown-uuid" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleDbRoute(url, req, pool);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(404);
		expect(await res.text()).toMatch(/session not found/i);
	});

	it("returns 403 when attempting to close the vault session", async () => {
		const fakeEntry = { manager: { abort: vi.fn() } };
		const mockIsVaultSession = vi.fn().mockReturnValue(true);
		const pool = makePool({
			get: vi.fn().mockReturnValue(fakeEntry),
			isVaultSession: mockIsVaultSession,
		});
		const url = makeUrl("/db/live-sessions/close");
		const req = new Request("http://localhost/db/live-sessions/close", {
			method: "POST",
			body: JSON.stringify({ session_id: "vault-uuid" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleDbRoute(url, req, pool);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(403);
		expect(await res.text()).toMatch(/cannot close vault session/i);
		// isVaultSession must be called — NOT vaultSessionId (which has create side-effect)
		expect(mockIsVaultSession).toHaveBeenCalledWith("vault-uuid");
	});

	it("calls pool.close() and returns ok for valid non-vault session_id", async () => {
		const mockClose = vi.fn();
		const fakeEntry = { manager: { abort: vi.fn() } };
		const pool = makePool({
			get: vi.fn().mockReturnValue(fakeEntry),
			close: mockClose,
			isVaultSession: vi.fn().mockReturnValue(false),
		});
		const url = makeUrl("/db/live-sessions/close");
		const req = new Request("http://localhost/db/live-sessions/close", {
			method: "POST",
			body: JSON.stringify({ session_id: "agent-uuid-1" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleDbRoute(url, req, pool);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(mockClose).toHaveBeenCalledWith("agent-uuid-1");
	});

	it("returns null for GET to /db/live-sessions/close", async () => {
		const pool = makePool();
		const url = makeUrl("/db/live-sessions/close");
		const req = makeRequest("GET");

		const res = await handleDbRoute(url, req, pool);

		expect(res).toBeNull();
	});
});
