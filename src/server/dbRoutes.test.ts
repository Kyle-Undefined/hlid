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
	mockGetCurrentSessionId,
	mockClearCurrentSessionId,
	mockListAttachments,
	mockRenameSession,
	mockSetSessionArchived,
	mockSetSessionPinned,
	mockGetSessionMessages,
	mockGetSessionToolEventSummaries,
	mockGetSessionToolEventDetail,
	mockGetAttachmentsForSession,
	mockGetProviderUsage,
	mockGetLogs,
	mockGetAggregatedStats,
	mockGetRecentSessions,
	mockGetSessionsPaginated,
	mockSyncClaudeProviderHistory,
	mockStartProviderHistorySync,
	mockGetProviderHistorySyncStatus,
	mockGetSessionProviderSession,
	mockCreateForkedSessionRow,
	mockGetMessageForFork,
	mockInsertForkedMessages,
	mockCopyForkedSessionTranscript,
} = vi.hoisted(() => ({
	mockGetSessionById: vi.fn(),
	mockGetCurrentSessionId: vi.fn(),
	mockClearCurrentSessionId: vi.fn(),
	mockListAttachments: vi.fn(),
	mockRenameSession: vi.fn(),
	mockSetSessionArchived: vi.fn(),
	mockSetSessionPinned: vi.fn(),
	mockGetSessionMessages: vi.fn(),
	mockGetSessionToolEventSummaries: vi.fn(),
	mockGetSessionToolEventDetail: vi.fn(),
	mockGetAttachmentsForSession: vi.fn(),
	mockGetProviderUsage: vi.fn(),
	mockGetLogs: vi.fn(),
	mockGetAggregatedStats: vi.fn(),
	mockGetRecentSessions: vi.fn(),
	mockGetSessionsPaginated: vi.fn(),
	mockSyncClaudeProviderHistory: vi.fn(),
	mockStartProviderHistorySync: vi.fn(),
	mockGetProviderHistorySyncStatus: vi.fn(),
	mockGetSessionProviderSession: vi.fn(),
	mockCreateForkedSessionRow: vi.fn(),
	mockGetMessageForFork: vi.fn(),
	mockInsertForkedMessages: vi.fn(),
	mockCopyForkedSessionTranscript: vi.fn(),
}));

vi.mock("../db", () => ({
	getSessionById: mockGetSessionById,
	getCurrentSessionId: mockGetCurrentSessionId,
	clearCurrentSessionId: mockClearCurrentSessionId,
	listAttachments: mockListAttachments,
	renameSession: mockRenameSession,
	setSessionArchived: mockSetSessionArchived,
	setSessionPinned: mockSetSessionPinned,
	getSessionMessages: mockGetSessionMessages,
	getSessionToolEventSummaries: mockGetSessionToolEventSummaries,
	getSessionToolEventDetail: mockGetSessionToolEventDetail,
	getAttachmentsForSession: mockGetAttachmentsForSession,
	getProviderUsage: mockGetProviderUsage,
	getLogs: mockGetLogs,
	getAggregatedStats: mockGetAggregatedStats,
	getRecentSessions: mockGetRecentSessions,
	getSessionsPaginated: mockGetSessionsPaginated,
	getSessionProviderSession: mockGetSessionProviderSession,
	createForkedSessionRow: mockCreateForkedSessionRow,
	getMessageForFork: mockGetMessageForFork,
	insertForkedMessages: mockInsertForkedMessages,
	copyForkedSessionTranscript: mockCopyForkedSessionTranscript,
}));

// dbRoutes also imports from ./attachments and ./proxy — stub them out.
vi.mock("./attachments", () => ({
	unlinkPaths: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./proxy", () => ({
	getWindowMark: vi.fn().mockReturnValue(null),
}));

vi.mock("./providerHistorySync", () => ({
	getProviderHistorySyncStatus: mockGetProviderHistorySyncStatus,
	startProviderHistorySync: mockStartProviderHistorySync,
	syncClaudeProviderHistory: mockSyncClaudeProviderHistory,
}));

import type { SessionStatusEntry } from "./protocol";
// ── pool mock factory ─────────────────────────────────────────────────────────
// Pool is passed as a parameter, no module mock needed — just a plain object.
import type { SessionPool } from "./sessionPool";

function makePool(
	overrides: Partial<{
		getSessionsStatus: () => SessionStatusEntry[];
		get: (id: string) => unknown;
		findByDbSessionId: (id: string) => unknown;
		close: (id: string) => void;
		isVaultSession: (id: string) => boolean;
		getProvider: (id: string) => unknown;
	}> = {},
): SessionPool {
	return {
		getSessionsStatus: vi.fn().mockReturnValue([]),
		get: vi.fn().mockReturnValue(undefined),
		findByDbSessionId: vi.fn().mockReturnValue(undefined),
		close: vi.fn(),
		isVaultSession: vi.fn().mockReturnValue(false),
		getProvider: vi.fn().mockReturnValue(undefined),
		...overrides,
	} as unknown as SessionPool;
}

// ── import after mocks ────────────────────────────────────────────────────────

import {
	markAnalyticsChanged,
	resetAnalyticsRevisionForTest,
} from "../db/analyticsRevision";
import { resetAnalyticsSnapshotsForTest } from "./analyticsSnapshots";
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

function makeRequest(method = "GET", body?: unknown): Request {
	return new Request("http://localhost/", {
		method,
		...(body === undefined
			? {}
			: {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
	});
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

describe("handleDbRoute — POST Claude history import", () => {
	it("returns the provider-history sync result", async () => {
		mockSyncClaudeProviderHistory.mockResolvedValueOnce({
			roots: ["C:\\Users\\Kyle\\.claude\\projects"],
			plannedSessions: 2,
			plannedQueries: 5,
			createdSessions: 2,
			insertedQueries: 5,
			alreadyImportedSessions: 0,
			alreadyImportedQueries: 0,
			skipped: {},
			backupPath: "C:\\Hlid\\backups\\before.db",
		});

		const response = await handleDbRoute(
			makeUrl("/db/provider-history/claude/import"),
			makeRequest("POST"),
		);

		expect(response?.status).toBe(200);
		expect(await response?.json()).toMatchObject({
			createdSessions: 2,
			insertedQueries: 5,
		});
	});
});

describe("handleDbRoute — POST provider history import", () => {
	it("starts the default all-provider import without waiting for it", async () => {
		mockStartProviderHistorySync.mockReturnValueOnce({
			state: "running",
			jobId: "1b8c5a24-a93c-4e7d-8a92-19a43dd4c30e",
			startedAt: 1_700_000_000_000,
		});
		const response = await handleDbRoute(
			makeUrl("/db/provider-history/import"),
			makeRequest("POST"),
		);

		expect(response?.status).toBe(202);
		expect(mockStartProviderHistorySync).toHaveBeenCalledWith();
		expect(await response?.json()).toMatchObject({ state: "running" });
	});

	it("returns the requested import job status", async () => {
		const jobId = "1b8c5a24-a93c-4e7d-8a92-19a43dd4c30e";
		mockGetProviderHistorySyncStatus.mockReturnValueOnce({
			state: "completed",
			jobId,
			startedAt: 1_700_000_000_000,
			completedAt: 1_700_000_001_000,
			result: { insertedQueries: 0, insertedMessages: 0 },
		});
		const response = await handleDbRoute(
			makeUrl("/db/provider-history/import/status", { job_id: jobId }),
			makeRequest(),
		);

		expect(response?.status).toBe(200);
		expect(mockGetProviderHistorySyncStatus).toHaveBeenCalledWith(jobId);
		expect(await response?.json()).toMatchObject({ state: "completed", jobId });
	});
});

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.clearAllMocks();
	resetAnalyticsRevisionForTest();
	resetAnalyticsSnapshotsForTest();
});

describe("handleDbRoute — /db/sessions", () => {
	it("forwards agent and model filters to paginated storage", async () => {
		mockGetSessionsPaginated.mockResolvedValue({
			sessions: [],
			total: 0,
			oldest_started_at: null,
			agent_cwds: [],
			models: [],
		});
		const response = await handleDbRoute(
			makeUrl("/db/sessions", {
				page: "2",
				size: "50",
				agent: "/agents/raven",
				model: "gpt-5.4",
			}),
			makeRequest(),
		);

		expect(response?.status).toBe(200);
		expect(mockGetSessionsPaginated).toHaveBeenCalledWith(2, 50, {
			search: undefined,
			agent: "/agents/raven",
			model: "gpt-5.4",
			provider: undefined,
			stop: undefined,
			range: undefined,
			from: undefined,
			to: undefined,
			sort: undefined,
		});
	});

	it("forwards Stats drill-down dimensions and custom dates together", async () => {
		mockGetSessionsPaginated.mockResolvedValue({
			sessions: [],
			total: 0,
			oldest_started_at: null,
			agent_cwds: [],
			models: [],
		});

		await handleDbRoute(
			makeUrl("/db/sessions", {
				provider: "codex",
				stop: "max_tokens",
				range: "custom",
				from: "2026-07-01",
				to: "2026-07-16",
			}),
			makeRequest(),
		);

		expect(mockGetSessionsPaginated).toHaveBeenCalledWith(
			1,
			20,
			expect.objectContaining({
				provider: "codex",
				stop: "max_tokens",
				range: "custom",
				from: "2026-07-01",
				to: "2026-07-16",
			}),
		);
	});
});

describe("handleDbRoute — analytics snapshots", () => {
	it("reuses /db/stats until an authoritative stats mutation", async () => {
		mockGetAggregatedStats
			.mockResolvedValueOnce({ allTime: { queries: 1 } })
			.mockResolvedValueOnce({ allTime: { queries: 2 } });
		mockGetRecentSessions.mockResolvedValue([]);

		const first = await handleDbRoute(makeUrl("/db/stats"), makeRequest());
		const second = await handleDbRoute(makeUrl("/db/stats"), makeRequest());
		expect(await first?.json()).toMatchObject({
			agg: { allTime: { queries: 1 } },
		});
		expect(await second?.json()).toMatchObject({
			agg: { allTime: { queries: 1 } },
		});
		expect(mockGetAggregatedStats).toHaveBeenCalledTimes(1);
		expect(mockGetRecentSessions).toHaveBeenCalledTimes(1);

		markAnalyticsChanged(["stats"], "query_recorded");
		const refreshed = await handleDbRoute(makeUrl("/db/stats"), makeRequest());
		expect(await refreshed?.json()).toMatchObject({
			agg: { allTime: { queries: 2 } },
		});
		expect(mockGetAggregatedStats).toHaveBeenCalledTimes(2);
	});
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

// ── POST /db/session/fork ─────────────────────────────────────────────────────

describe("handleDbRoute — POST /db/session/fork", () => {
	beforeEach(() => {
		mockGetSessionById.mockReset();
		mockGetSessionProviderSession.mockReset();
		mockCreateForkedSessionRow.mockReset();
		mockGetMessageForFork.mockReset();
		mockInsertForkedMessages.mockReset();
		mockCopyForkedSessionTranscript.mockReset();
		mockCopyForkedSessionTranscript.mockResolvedValue(2);
	});

	function forkRequest(body: unknown): Request {
		return new Request("http://localhost/db/session/fork", {
			method: "POST",
			body: typeof body === "string" ? body : JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
		});
	}

	it("returns 400 when id is missing", async () => {
		const pool = makePool();
		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({}),
			pool,
		);
		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(400);
	});

	it("returns 400 when messageId is not a number", async () => {
		const pool = makePool();
		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123", messageId: "not-a-number" }),
			pool,
		);
		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(400);
	});

	it("returns 404 when messageId belongs to a different session", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "claude",
			agent_cwd: "/work/project",
		});
		mockGetMessageForFork.mockResolvedValue({
			sessionId: "some-other-session",
			seq: 3,
			role: "assistant",
			sdkUuid: "sdk-msg-uuid-1",
			providerTurnId: null,
		});
		const pool = makePool();
		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123", messageId: 42 }),
			pool,
		);
		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(404);
	});

	it("returns 422 when the message has no captured transcript id", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "claude",
			agent_cwd: "/work/project",
		});
		mockGetMessageForFork.mockResolvedValue({
			sessionId: "abc-123",
			seq: 3,
			role: "assistant",
			sdkUuid: null,
			providerTurnId: null,
		});
		const pool = makePool();
		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123", messageId: 42 }),
			pool,
		);
		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(422);
	});

	it("resolves messageId to a native uuid and forwards a typed message cutoff", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "claude",
			agent_cwd: "/work/project",
			history_resume_mode: "none",
		});
		mockGetMessageForFork.mockResolvedValue({
			sessionId: "abc-123",
			seq: 3,
			role: "assistant",
			sdkUuid: "sdk-msg-uuid-1",
			providerTurnId: null,
		});
		mockGetSessionProviderSession.mockResolvedValue("native-source-id");
		const mockForkSession = vi
			.fn()
			.mockResolvedValue({ sessionId: "native-forked-id" });
		const pool = makePool({
			getProvider: vi.fn().mockReturnValue({
				providerId: "claude",
				forkCapability: {
					kind: "exact",
					cutoff: "message",
					wholeSession: true,
					throughMessage: true,
				},
				forkSession: mockForkSession,
			}),
		});

		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123", messageId: 42 }),
			pool,
		);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		expect(mockGetMessageForFork).toHaveBeenCalledWith(42);
		expect(mockForkSession).toHaveBeenCalledWith({
			sessionId: "native-source-id",
			cwd: "/work/project",
			historyResumeMode: "none",
			cutoff: { kind: "message", id: "sdk-msg-uuid-1" },
		});
		expect(mockCopyForkedSessionTranscript).toHaveBeenCalledWith(
			"abc-123",
			expect.any(String),
			3,
		);
	});

	it("rejects per-message forks when negotiated ACP support is whole-session only", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "acp:test",
			agent_cwd: "/work/project",
		});
		mockGetMessageForFork.mockResolvedValue({
			sessionId: "abc-123",
			seq: 3,
			role: "assistant",
			sdkUuid: "sdk-msg-uuid-1",
			providerTurnId: null,
		});
		mockGetSessionProviderSession.mockResolvedValue("native-source-id");
		const forkSession = vi.fn();
		const pool = makePool({
			getProvider: vi.fn().mockReturnValue({
				providerId: "acp:test",
				resolveForkCapability: vi.fn().mockResolvedValue({
					kind: "exact",
					wholeSession: true,
					throughMessage: false,
				}),
				forkSession,
			}),
		});

		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123", messageId: 42 }),
			pool,
		);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("whole-session");
		expect(forkSession).not.toHaveBeenCalled();
	});

	it("returns 409 when the source session has a running turn", async () => {
		const pool = makePool({
			findByDbSessionId: vi.fn().mockReturnValue({
				manager: { getStatus: () => ({ state: "running" }) },
			}),
		});
		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "live-session" }),
			pool,
		);
		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(409);
		expect(mockGetSessionById).not.toHaveBeenCalled();
	});

	it("allows an idle live session to fork without a reload", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "claude",
			agent_cwd: "/work/project",
			history_resume_mode: "none",
		});
		mockGetSessionProviderSession.mockResolvedValue("native-source-id");
		const mockForkSession = vi
			.fn()
			.mockResolvedValue({ sessionId: "native-forked-id" });
		const pool = makePool({
			findByDbSessionId: vi.fn().mockReturnValue({
				manager: { getStatus: () => ({ state: "idle" }) },
			}),
			getProvider: vi.fn().mockReturnValue({
				providerId: "claude",
				forkCapability: {
					kind: "exact",
					cutoff: "message",
					wholeSession: true,
					throughMessage: true,
				},
				forkSession: mockForkSession,
			}),
		});

		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123" }),
			pool,
		);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		expect(mockForkSession).toHaveBeenCalledOnce();
	});

	it("returns 404 when the source session doesn't exist", async () => {
		mockGetSessionById.mockResolvedValue(null);
		const pool = makePool();
		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "missing" }),
			pool,
		);
		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(404);
	});

	it("returns 422 when the provider doesn't support forkSession", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "codex",
			agent_cwd: "/work/project",
		});
		mockGetSessionProviderSession.mockResolvedValue("native-id");
		const pool = makePool({
			getProvider: vi.fn().mockReturnValue({ providerId: "codex" }), // no forkSession()
		});
		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123" }),
			pool,
		);
		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(422);
	});

	it("forks via the provider and creates a new row on success", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "claude",
			agent_cwd: "/work/project",
			history_resume_mode: "none",
		});
		mockGetSessionProviderSession.mockResolvedValue("native-source-id");
		const mockForkSession = vi
			.fn()
			.mockResolvedValue({ sessionId: "native-forked-id" });
		const pool = makePool({
			getProvider: vi.fn().mockReturnValue({
				providerId: "claude",
				forkCapability: {
					kind: "exact",
					cutoff: "message",
					wholeSession: true,
					throughMessage: true,
				},
				forkSession: mockForkSession,
			}),
		});

		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123" }),
			pool,
		);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: true; id: string };
		expect(json.ok).toBe(true);
		expect(typeof json.id).toBe("string");
		expect(json.id).not.toBe("abc-123");

		expect(mockForkSession).toHaveBeenCalledWith({
			sessionId: "native-source-id",
			cwd: "/work/project",
			historyResumeMode: "none",
		});
		expect(mockCreateForkedSessionRow).toHaveBeenCalledWith(
			"abc-123",
			json.id,
			"native-forked-id",
			{ forkKind: "exact" },
		);
		expect(mockCopyForkedSessionTranscript).toHaveBeenCalledWith(
			"abc-123",
			json.id,
			undefined,
		);
		expect(mockInsertForkedMessages).not.toHaveBeenCalled();
	});

	it("hydrates hlid's messages table when the provider's fork result includes a transcript read-back", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "claude",
			agent_cwd: "/work/project",
			history_resume_mode: "none",
		});
		mockGetSessionProviderSession.mockResolvedValue("native-source-id");
		const forkedMessages = [
			{ role: "user" as const, text: "Hello", uuid: "u1" },
			{ role: "assistant" as const, text: "Hi there", uuid: "u2" },
		];
		const mockForkSession = vi.fn().mockResolvedValue({
			sessionId: "native-forked-id",
			messages: forkedMessages,
		});
		const pool = makePool({
			getProvider: vi.fn().mockReturnValue({
				providerId: "claude",
				forkCapability: {
					kind: "exact",
					cutoff: "message",
					wholeSession: true,
					throughMessage: true,
				},
				forkSession: mockForkSession,
			}),
		});

		mockCopyForkedSessionTranscript.mockResolvedValueOnce(0);
		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123" }),
			pool,
		);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: true; id: string };
		expect(mockInsertForkedMessages).toHaveBeenCalledWith(
			json.id,
			forkedMessages,
		);
	});

	it("uses a captured Codex turn id for a per-message exact fork", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "codex",
			agent_cwd: "/work/project",
			history_resume_mode: "none",
		});
		mockGetMessageForFork.mockResolvedValue({
			sessionId: "abc-123",
			seq: 5,
			role: "assistant",
			sdkUuid: null,
			providerTurnId: "turn-5",
		});
		mockGetSessionProviderSession.mockResolvedValue("thread-source");
		const mockForkSession = vi
			.fn()
			.mockResolvedValue({ sessionId: "thread-fork" });
		const pool = makePool({
			getProvider: vi.fn().mockReturnValue({
				providerId: "codex",
				forkCapability: {
					kind: "exact",
					cutoff: "turn",
					wholeSession: true,
					throughMessage: true,
				},
				forkSession: mockForkSession,
			}),
		});

		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123", messageId: 42 }),
			pool,
		);

		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(200);
		const json = (await res.json()) as { id: string };
		expect(mockForkSession).toHaveBeenCalledWith({
			sessionId: "thread-source",
			cwd: "/work/project",
			historyResumeMode: "none",
			cutoff: { kind: "turn", id: "turn-5" },
		});
		expect(mockCreateForkedSessionRow).toHaveBeenCalledWith(
			"abc-123",
			json.id,
			"thread-fork",
			{ parentMessageId: 42, forkKind: "exact" },
		);
		expect(mockCopyForkedSessionTranscript).toHaveBeenCalledWith(
			"abc-123",
			json.id,
			5,
		);
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

	it("persists pin state without rewriting live session labels", async () => {
		mockSetSessionPinned.mockResolvedValue(undefined);
		const pool = makePool();
		const res = await handleDbRoute(
			makeUrl("/db/session", { id: "s1" }),
			patchRequest({ pinned: true }),
			pool,
		);

		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ ok: true });
		expect(mockSetSessionPinned).toHaveBeenCalledWith("s1", true);
		expect(mockRenameSession).not.toHaveBeenCalled();
	});

	it("archives an idle session and rejects a running one", async () => {
		mockSetSessionArchived.mockResolvedValue(undefined);
		mockGetCurrentSessionId.mockResolvedValue("s1");
		const idle = makePool({
			findByDbSessionId: vi.fn().mockReturnValue({
				sessionId: "pool-s1",
				manager: { getStatus: () => ({ state: "idle" }) },
			}),
		});
		const archived = await handleDbRoute(
			makeUrl("/db/session", { id: "s1" }),
			patchRequest({ archived: true }),
			idle,
		);
		expect(archived?.status).toBe(200);
		expect(mockSetSessionArchived).toHaveBeenCalledWith("s1", true);
		expect(mockClearCurrentSessionId).toHaveBeenCalledOnce();
		expect(idle.close).toHaveBeenCalledWith("pool-s1");

		mockSetSessionArchived.mockClear();
		const running = makePool({
			findByDbSessionId: vi.fn().mockReturnValue({
				manager: { getStatus: () => ({ state: "running" }) },
			}),
		});
		const blocked = await handleDbRoute(
			makeUrl("/db/session", { id: "s1" }),
			patchRequest({ archived: true }),
			running,
		);
		expect(blocked?.status).toBe(409);
		expect(await blocked?.text()).toMatch(/stop it first/i);
		expect(mockSetSessionArchived).not.toHaveBeenCalled();
	});

	it("restores an archived session even when its provider is running", async () => {
		mockSetSessionArchived.mockResolvedValue(undefined);
		const running = makePool({
			findByDbSessionId: vi.fn().mockReturnValue({
				manager: { getStatus: () => ({ state: "running" }) },
			}),
		});
		const restored = await handleDbRoute(
			makeUrl("/db/session", { id: "s1" }),
			patchRequest({ archived: false }),
			running,
		);
		expect(restored?.status).toBe(200);
		expect(mockSetSessionArchived).toHaveBeenCalledWith("s1", false);
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
		mockGetSessionToolEventSummaries.mockResolvedValue([
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

	it("passes the backwards cursor and page sequence window to transcript queries", async () => {
		mockGetSessionMessages.mockResolvedValue([
			{ id: 10, seq: 10, role: "user", text: "older" },
			// A compound cursor may include lower-id rows at before_seq itself.
			{ id: 49, seq: 50, role: "assistant", text: "newer" },
		]);
		mockGetSessionToolEventSummaries.mockResolvedValue([]);
		mockGetAttachmentsForSession.mockResolvedValue([]);

		const res = await handleDbRoute(
			makeUrl("/db/session-messages", {
				session_id: "s1",
				before_seq: "50",
				before_id: "500",
				limit: "201",
			}),
			makeRequest(),
		);

		expect(res?.status).toBe(200);
		expect(mockGetSessionMessages).toHaveBeenCalledWith(
			"s1",
			50,
			201,
			undefined,
			500,
			undefined,
		);
		expect(mockGetSessionToolEventSummaries).toHaveBeenCalledWith(
			"s1",
			10,
			undefined,
			50,
		);
		expect(mockGetAttachmentsForSession).toHaveBeenCalledWith(
			"s1",
			10,
			undefined,
			50,
		);
	});
});

// ── GET /db/session-tool-event ────────────────────────────────────────────────

describe("handleDbRoute — GET /db/session-tool-event", () => {
	it("requires both session and tool ids", async () => {
		const missingSession = await handleDbRoute(
			makeUrl("/db/session-tool-event", { tool_id: "tool-1" }),
			makeRequest(),
		);
		const missingTool = await handleDbRoute(
			makeUrl("/db/session-tool-event", { session_id: "s1" }),
			makeRequest(),
		);
		expect(missingSession?.status).toBe(400);
		expect(missingTool?.status).toBe(400);
	});

	it("returns a complete session-scoped result", async () => {
		mockGetSessionToolEventDetail.mockResolvedValue({
			tool_id: "tool-1",
			result_text: "complete result",
			is_error: 0,
		});
		const res = await handleDbRoute(
			makeUrl("/db/session-tool-event", {
				session_id: "s1",
				tool_id: "tool-1",
			}),
			makeRequest(),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({
			tool_id: "tool-1",
			result_text: "complete result",
			is_error: 0,
		});
		expect(mockGetSessionToolEventDetail).toHaveBeenCalledWith("s1", "tool-1");
	});

	it("returns 404 when the scoped tool event does not exist", async () => {
		mockGetSessionToolEventDetail.mockResolvedValue(null);
		const res = await handleDbRoute(
			makeUrl("/db/session-tool-event", {
				session_id: "s1",
				tool_id: "missing",
			}),
			makeRequest(),
		);
		expect(res?.status).toBe(404);
		expect(await res?.json()).toBeNull();
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

		vi.mocked(getWindowMark).mockImplementation(((provider: string) =>
			provider === "codex"
				? { utilization: 75, remaining: 25, resetsAt: 100 }
				: null) as never);
		const secondRes = await handleDbRoute(
			makeUrl("/db/provider-usage", { providers: "claude, codex," }),
			makeRequest(),
		);
		const secondBody = (await secondRes?.json()) as Array<{
			windows: Array<{ utilization: number; resetsAt: number }>;
		}>;
		expect(secondBody[1].windows[0].utilization).toBe(75);
		expect(secondBody[1].windows[0].resetsAt).toBe(100);
		expect(mockGetProviderUsage).toHaveBeenCalledTimes(2);
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
