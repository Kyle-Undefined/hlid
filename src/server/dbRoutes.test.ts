/**
 * Unit tests for the /db/session-row endpoint in dbRoutes.ts.
 * DB is mocked; only the routing logic inside handleDbRoute is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../db";

// ── mocks ─────────────────────────────────────────────────────────────────────

// vi.mock factories are hoisted before module-level code, so vars referenced
// inside them must also be hoisted via vi.hoisted().
const {
	mockGetSessionById,
	mockListAttachments,
	mockRenameSession,
	mockGetSessionMessages,
	mockGetSessionToolEvents,
	mockGetAttachmentsForSession,
	mockGetProviderUsage,
	mockGetLogs,
} = vi.hoisted(() => ({
	mockGetSessionById: vi.fn(),
	mockListAttachments: vi.fn(),
	mockRenameSession: vi.fn(),
	mockGetSessionMessages: vi.fn(),
	mockGetSessionToolEvents: vi.fn(),
	mockGetAttachmentsForSession: vi.fn(),
	mockGetProviderUsage: vi.fn(),
	mockGetLogs: vi.fn(),
}));

vi.mock("../db", () => ({
	getSessionById: mockGetSessionById,
	listAttachments: mockListAttachments,
	renameSession: mockRenameSession,
	getSessionMessages: mockGetSessionMessages,
	getSessionToolEvents: mockGetSessionToolEvents,
	getAttachmentsForSession: mockGetAttachmentsForSession,
	getProviderUsage: mockGetProviderUsage,
	getLogs: mockGetLogs,
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

import { handleDbRoute, parseAttachmentListFilter } from "./dbRoutes";

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

describe("handleDbRoute — GET /db/attachments", () => {
	it.each([
		"ephemeral",
		"vault",
	] as const)("accepts the %s attachment kind", (kind) => {
		expect(
			parseAttachmentListFilter(makeUrl("/db/attachments", { kind })),
		).toMatchObject({ kind });
	});

	it.each([
		"image",
		"pdf",
		"text",
		"other",
	] as const)("accepts the %s type filter", (type) => {
		expect(
			parseAttachmentListFilter(makeUrl("/db/attachments", { type })),
		).toMatchObject({ type });
	});

	it("accepts whitelisted sort columns and directions", () => {
		expect(
			parseAttachmentListFilter(
				makeUrl("/db/attachments", { sort: "size_bytes", dir: "asc" }),
			),
		).toMatchObject({ sort: "size_bytes", dir: "asc" });
	});

	it("ignores unknown type, sort, and dir values", () => {
		expect(
			parseAttachmentListFilter(
				makeUrl("/db/attachments", {
					type: "archive",
					sort: "filename; DROP TABLE attachments",
					dir: "sideways",
				}),
			),
		).toMatchObject({ type: undefined, sort: undefined, dir: undefined });
	});

	it("maps valid filters and bounds pagination before querying the database", async () => {
		mockListAttachments.mockResolvedValue({
			rows: [],
			total: 0,
			total_bytes: 0,
		});
		const url = makeUrl("/db/attachments", {
			kind: "vault",
			session_id: "session-1",
			search: "report_100%",
			since: "100",
			until: "200",
			limit: "9999",
			offset: "-4",
		});

		const response = await handleDbRoute(url, makeRequest());

		expect(response?.status).toBe(200);
		expect(mockListAttachments).toHaveBeenCalledWith({
			kind: "vault",
			sessionId: "session-1",
			search: "report_100%",
			since: 100,
			until: 200,
			limit: 100,
			offset: 0,
		});
		expect(await response?.json()).toEqual({
			rows: [],
			total: 0,
			total_bytes: 0,
		});
	});

	it("ignores unknown kinds and invalid timestamps while applying defaults", () => {
		expect(
			parseAttachmentListFilter(
				makeUrl("/db/attachments", {
					kind: "external",
					since: "not-a-number",
					until: "NaN",
					limit: "invalid",
					offset: "invalid",
				}),
			),
		).toEqual({
			kind: undefined,
			sessionId: undefined,
			search: undefined,
			since: undefined,
			until: undefined,
			limit: 100,
			offset: 0,
		});
	});

	it("does not convert a database failure into an empty result", async () => {
		const failure = new Error("attachment database unavailable");
		mockListAttachments.mockRejectedValue(failure);
		await expect(
			handleDbRoute(makeUrl("/db/attachments"), makeRequest()),
		).rejects.toThrow(failure);
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

// ── PATCH /db/session ─────────────────────────────────────────────────────────

function patchRequest(body: unknown): Request {
	return new Request("http://localhost/db/session", {
		method: "PATCH",
		body: typeof body === "string" ? body : JSON.stringify(body),
		headers: { "Content-Type": "application/json" },
	});
}

describe("handleDbRoute — PATCH /db/session", () => {
	it("returns null for unknown PATCH path", async () => {
		const res = await handleDbRoute(makeUrl("/db/nope"), patchRequest({}));
		expect(res).toBeNull();
	});

	it("returns 400 when id is missing", async () => {
		const res = await handleDbRoute(
			makeUrl("/db/session"),
			patchRequest({ label: "x" }),
		);
		expect(res?.status).toBe(400);
		expect(await res?.text()).toMatch(/missing id/i);
	});

	it("returns 400 when label is missing or body is not JSON", async () => {
		const noLabel = await handleDbRoute(
			makeUrl("/db/session", { id: "s1" }),
			patchRequest({}),
		);
		expect(noLabel?.status).toBe(400);

		const badJson = await handleDbRoute(
			makeUrl("/db/session", { id: "s1" }),
			patchRequest("not json"),
		);
		expect(badJson?.status).toBe(400);
	});

	it("renames the session and syncs matching live pool entries", async () => {
		mockRenameSession.mockResolvedValue(undefined);
		const matching = {
			getCurrentSessionId: vi.fn().mockReturnValue("s1"),
			setSessionLabel: vi.fn(),
		};
		const other = {
			getCurrentSessionId: vi.fn().mockReturnValue("s2"),
			setSessionLabel: vi.fn(),
		};
		const pool = makePool();
		(pool as unknown as { getAllEntries: () => unknown[] }).getAllEntries =
			() => [{ manager: matching }, { manager: other }];
		const setSessionLabel = vi.fn();
		const terminalPool = {
			setSessionLabel,
			getSessionsStatus: () => [],
		} as never;

		const res = await handleDbRoute(
			makeUrl("/db/session", { id: "s1" }),
			patchRequest({ label: "renamed" }),
			pool,
			terminalPool,
		);

		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ ok: true });
		expect(mockRenameSession).toHaveBeenCalledWith("s1", "renamed");
		expect(setSessionLabel).toHaveBeenCalledWith("s1", "renamed");
		expect(matching.setSessionLabel).toHaveBeenCalledWith("renamed");
		expect(other.setSessionLabel).not.toHaveBeenCalled();
	});
});

// ── GET /db/session-messages ──────────────────────────────────────────────────

describe("handleDbRoute — GET /db/session-messages", () => {
	it("returns 400 when session_id is missing", async () => {
		const res = await handleDbRoute(
			makeUrl("/db/session-messages"),
			makeRequest(),
		);
		expect(res?.status).toBe(400);
	});

	it("attaches tool events to assistant rows and attachments to user rows", async () => {
		mockGetSessionMessages.mockResolvedValue([
			{ seq: 1, role: "user", text: "hi" },
			{ seq: 2, role: "assistant", text: "yo" },
		]);
		mockGetSessionToolEvents.mockResolvedValue([
			{ assistant_seq: 2, tool: "Bash" },
			{ assistant_seq: 2, tool: "Read" },
			{ assistant_seq: null, tool: "orphan" },
		]);
		mockGetAttachmentsForSession.mockResolvedValue([
			{ message_seq: 1, name: "a.png" },
			{ message_seq: null, name: "orphan.png" },
		]);

		const res = await handleDbRoute(
			makeUrl("/db/session-messages", { session_id: "s1" }),
			makeRequest(),
		);

		const rows = (await res?.json()) as Array<{
			toolEvents?: unknown[];
			attachments?: unknown[];
		}>;
		expect(rows[0].attachments).toHaveLength(1);
		expect(rows[0].toolEvents).toBeUndefined();
		expect(rows[1].toolEvents).toHaveLength(2);
		expect(rows[1].attachments).toBeUndefined();
	});
});

// ── GET /db/provider-usage ────────────────────────────────────────────────────

import { getWindowMark } from "./proxy";

describe("handleDbRoute — GET /db/provider-usage", () => {
	function makeSnapshot(providerId: string) {
		return {
			providerId,
			windows: [
				{ windowId: "five_hour", utilization: 10, remaining: 90, resetsAt: 1 },
			],
		};
	}

	it("defaults to the claude provider", async () => {
		mockGetProviderUsage.mockImplementation(async (id: string) =>
			makeSnapshot(id),
		);
		const res = await handleDbRoute(
			makeUrl("/db/provider-usage"),
			makeRequest(),
		);
		const body = (await res?.json()) as Array<{ providerId: string }>;
		expect(body.map((s) => s.providerId)).toEqual(["claude"]);
	});

	it("parses the provider list and overlays live window marks", async () => {
		mockGetProviderUsage.mockImplementation(async (id: string) =>
			makeSnapshot(id),
		);
		vi.mocked(getWindowMark).mockImplementation(((provider: string) =>
			provider === "codex"
				? { utilization: 55, remaining: 45, resetsAt: 99 }
				: null) as never);

		const res = await handleDbRoute(
			makeUrl("/db/provider-usage", { providers: "claude, codex," }),
			makeRequest(),
		);

		const body = (await res?.json()) as Array<{
			providerId: string;
			windows: Array<{ utilization: number; resetsAt: number }>;
		}>;
		expect(body.map((s) => s.providerId)).toEqual(["claude", "codex"]);
		expect(body[0].windows[0].utilization).toBe(10);
		expect(body[1].windows[0].utilization).toBe(55);
		expect(body[1].windows[0].resetsAt).toBe(99);
	});
});

// ── GET /db/logs ──────────────────────────────────────────────────────────────

describe("handleDbRoute — GET /db/logs", () => {
	it("passes a valid level filter and falls back to default size when out of range", async () => {
		mockGetLogs.mockResolvedValue({ rows: [], total: 0 });
		await handleDbRoute(
			makeUrl("/db/logs", { page: "3", size: "999", level: "error" }),
			makeRequest(),
		);
		expect(mockGetLogs).toHaveBeenCalledWith(3, 50, "error");
	});

	it("ignores an invalid level", async () => {
		mockGetLogs.mockResolvedValue({ rows: [], total: 0 });
		await handleDbRoute(
			makeUrl("/db/logs", { level: "verbose" }),
			makeRequest(),
		);
		expect(mockGetLogs).toHaveBeenCalledWith(1, 50, undefined);
	});
});
