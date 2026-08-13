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
	mockGetSessionToolEventTranscriptWindow,
	mockGetSessionToolEventPage,
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
	mockGetSessionLastQueryContext,
	mockGetSessionActualModel,
	mockGetSessionContextManifests,
	mockCreateForkedSessionRow,
	mockDeleteSession,
	mockDeleteSessionsOlderThan,
	mockGetSessionCleanupPlan,
	mockDeleteProjectPreviewsForSessions,
	mockGetStorageStats,
	mockOptimizeStorage,
	mockReclaimStorage,
	mockListPendingFileDeletions,
	mockGetMessageForFork,
	mockInsertForkedMessages,
	mockCopyForkedSessionTranscript,
	mockCopyForkedSessionAttachments,
	mockGetHlidDelegationByChildSession,
	mockAbandonInterruptedHlidDelegation,
	mockCloseProjectPreviewSession,
	mockUnlinkPaths,
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
	mockGetSessionToolEventTranscriptWindow: vi.fn(),
	mockGetSessionToolEventPage: vi.fn(),
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
	mockGetSessionLastQueryContext: vi.fn(),
	mockGetSessionActualModel: vi.fn(),
	mockGetSessionContextManifests: vi.fn(),
	mockCreateForkedSessionRow: vi.fn(),
	mockDeleteSession: vi.fn(),
	mockDeleteSessionsOlderThan: vi.fn(),
	mockGetSessionCleanupPlan: vi.fn(),
	mockDeleteProjectPreviewsForSessions: vi.fn(),
	mockGetStorageStats: vi.fn(),
	mockOptimizeStorage: vi.fn(),
	mockReclaimStorage: vi.fn(),
	mockListPendingFileDeletions: vi.fn(),
	mockGetMessageForFork: vi.fn(),
	mockInsertForkedMessages: vi.fn(),
	mockCopyForkedSessionTranscript: vi.fn(),
	mockCopyForkedSessionAttachments: vi.fn(),
	mockGetHlidDelegationByChildSession: vi.fn(),
	mockAbandonInterruptedHlidDelegation: vi.fn(),
	mockCloseProjectPreviewSession: vi.fn(),
	mockUnlinkPaths: vi.fn().mockResolvedValue(undefined),
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
	getSessionToolEventTranscriptWindow: mockGetSessionToolEventTranscriptWindow,
	getSessionToolEventPage: mockGetSessionToolEventPage,
	getSessionToolEventDetail: mockGetSessionToolEventDetail,
	getAttachmentsForSession: mockGetAttachmentsForSession,
	getProviderUsage: mockGetProviderUsage,
	getLogs: mockGetLogs,
	getAggregatedStats: mockGetAggregatedStats,
	getRecentSessions: mockGetRecentSessions,
	getSessionsPaginated: mockGetSessionsPaginated,
	getSessionProviderSession: mockGetSessionProviderSession,
	getSessionLastQueryContext: mockGetSessionLastQueryContext,
	getSessionActualModel: mockGetSessionActualModel,
	getSessionContextManifests: mockGetSessionContextManifests,
	createForkedSessionRow: mockCreateForkedSessionRow,
	deleteSession: mockDeleteSession,
	deleteSessionsOlderThan: mockDeleteSessionsOlderThan,
	getSessionCleanupPlan: mockGetSessionCleanupPlan,
	deleteProjectPreviewsForSessions: mockDeleteProjectPreviewsForSessions,
	getStorageStats: mockGetStorageStats,
	optimizeStorage: mockOptimizeStorage,
	reclaimStorage: mockReclaimStorage,
	listPendingFileDeletions: mockListPendingFileDeletions,
	getMessageForFork: mockGetMessageForFork,
	insertForkedMessages: mockInsertForkedMessages,
	copyForkedSessionTranscript: mockCopyForkedSessionTranscript,
	getHlidDelegationByChildSession: mockGetHlidDelegationByChildSession,
	abandonInterruptedHlidDelegation: mockAbandonInterruptedHlidDelegation,
}));

// dbRoutes also imports from ./attachments and ./proxy — stub them out.
vi.mock("./attachments", () => ({
	unlinkPaths: mockUnlinkPaths,
}));

vi.mock("./sessionForkAttachments", () => ({
	copyForkedSessionAttachments: mockCopyForkedSessionAttachments,
}));

vi.mock("./proxy", () => ({
	getWindowMark: vi.fn().mockReturnValue(null),
}));

vi.mock("./providerHistorySync", () => ({
	getProviderHistorySyncStatus: mockGetProviderHistorySyncStatus,
	startProviderHistorySync: mockStartProviderHistorySync,
	syncClaudeProviderHistory: mockSyncClaudeProviderHistory,
}));

vi.mock("./projectPreview", () => ({
	projectPreviewManager: {
		closeSession: mockCloseProjectPreviewSession,
	},
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
		getAllEntries: () => IterableIterator<unknown>;
		close: (id: string) => void;
		isVaultSession: (id: string) => boolean;
		getProvider: (id: string) => unknown;
		providerRuntimeCwd: (agentCwd: string | null | undefined) => string | null;
		refreshDurableDelegationAttention: () => Promise<void>;
	}> = {},
): SessionPool {
	return {
		getSessionsStatus: vi.fn().mockReturnValue([]),
		get: vi.fn().mockReturnValue(undefined),
		findByDbSessionId: vi.fn().mockReturnValue(undefined),
		getAllEntries: vi.fn().mockReturnValue([].values()),
		close: vi.fn(),
		isVaultSession: vi.fn().mockReturnValue(false),
		getProvider: vi.fn().mockReturnValue(undefined),
		providerRuntimeCwd: vi.fn((agentCwd) => agentCwd ?? "/work/vault"),
		refreshDurableDelegationAttention: vi.fn().mockResolvedValue(undefined),
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
	mockGetSessionToolEventTranscriptWindow.mockResolvedValue({
		items: [],
		pages: [],
	});
	mockGetHlidDelegationByChildSession.mockReset();
	mockGetHlidDelegationByChildSession.mockResolvedValue(null);
	mockAbandonInterruptedHlidDelegation.mockReset();
	mockAbandonInterruptedHlidDelegation.mockResolvedValue(null);
	mockListPendingFileDeletions.mockResolvedValue([]);
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

describe("handleDbRoute — /db/session-context", () => {
	it("returns the persisted Hlid manifest with provider context usage", async () => {
		mockGetSessionLastQueryContext.mockResolvedValue({
			context_window: 200_000,
			last_context_used: 12_345,
		});
		mockGetSessionActualModel.mockResolvedValue("gpt-5.6-sol");
		const manifest = JSON.stringify({
			contractVersion: 1,
			recordedAt: 1_700_000_000_000,
			delivery: "chat",
			providerId: "codex",
			userMessageChars: 5,
			promptChars: 15,
			hlidAddedChars: 10,
			estimatedHlidTokens: 3,
			blocks: [],
			agentMode: "cwd",
			skills: [],
			attachments: [],
			vaultReferences: [],
			workspaceReferences: [],
			planHtml: false,
			providerPromptChars: 15,
			providerHandoffChars: 0,
			toolLoading: [],
		});
		mockGetSessionContextManifests.mockResolvedValue({
			rows: [
				{
					seq: 8,
					timestamp: 1_700_000_000,
					turn_number: 4,
					turn_id: "turn-4",
					message_preview: "  inspect\nthis context  ",
					context_manifest_json: manifest,
				},
			],
			hasMore: true,
		});

		const response = await handleDbRoute(
			makeUrl("/db/session-context", {
				session_id: "abc-123",
				limit: "12",
				before_seq: "10",
			}),
			makeRequest(),
		);

		expect(response?.status).toBe(200);
		expect(await response?.json()).toMatchObject({
			context_window: 200_000,
			last_context_used: 12_345,
			actual_model: "gpt-5.6-sol",
			hlid_context: {
				contractVersion: 1,
				delivery: "chat",
				hlidAddedChars: 10,
			},
			hlid_contexts: [
				{
					seq: 8,
					timestamp: 1_700_000_000,
					turnNumber: 4,
					turnId: "turn-4",
					messagePreview: "inspect this context",
					context: { contractVersion: 1, hlidAddedChars: 10 },
				},
			],
			has_more_contexts: true,
			next_context_before_seq: 8,
		});
		expect(mockGetSessionContextManifests).toHaveBeenCalledWith(
			"abc-123",
			12,
			10,
		);
	});

	it("treats malformed or unsupported manifests as unavailable", async () => {
		mockGetSessionLastQueryContext.mockResolvedValue(null);
		mockGetSessionActualModel.mockResolvedValue(null);
		mockGetSessionContextManifests.mockResolvedValue({
			rows: [
				{
					seq: 2,
					timestamp: 1_700_000_000,
					turn_number: 2,
					turn_id: null,
					message_preview: "old turn",
					context_manifest_json: '{"contractVersion":999}',
				},
			],
			hasMore: false,
		});

		const response = await handleDbRoute(
			makeUrl("/db/session-context", { session_id: "abc-123" }),
			makeRequest(),
		);

		expect(await response?.json()).toEqual({
			actual_model: null,
			hlid_context: null,
			hlid_contexts: [],
			has_more_contexts: false,
			next_context_before_seq: 2,
		});
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

	it.each([
		"upload",
		"plan",
		"report",
		"media",
		"visualization",
		"other",
	] as const)("accepts the %s attachment category", (category) => {
		expect(
			parseAttachmentListFilter(makeUrl("/db/attachments", { category })),
		).toMatchObject({ category });
	});

	it.each([
		"upload",
		"generated",
		"imported",
		"vault",
		"legacy",
	] as const)("accepts the %s attachment origin", (origin) => {
		expect(
			parseAttachmentListFilter(makeUrl("/db/attachments", { origin })),
		).toMatchObject({ origin });
	});

	it("omits filesystem and integrity fields from the HTTP projection", async () => {
		mockListAttachments.mockResolvedValue({
			rows: [
				{
					id: "relic-1",
					session_id: null,
					message_seq: null,
					kind: "ephemeral",
					filename: "report.md",
					path: "/private/report.md",
					mime: "text/markdown",
					size_bytes: 10,
					sha256: "private-hash",
					created_at: 100,
					storage_key: "artifacts/relic-1/report.md",
					agent_cwd: "/private/workspace",
				},
			],
			total: 1,
			total_bytes: 10,
		});

		const response = await handleDbRoute(
			makeUrl("/db/attachments"),
			makeRequest(),
		);
		const body = await response?.json();

		expect(body.rows[0]).toEqual(
			expect.objectContaining({ id: "relic-1", filename: "report.md" }),
		);
		expect(body.rows[0]).not.toHaveProperty("path");
		expect(body.rows[0]).not.toHaveProperty("storage_key");
		expect(body.rows[0]).not.toHaveProperty("sha256");
		expect(body.rows[0]).not.toHaveProperty("agent_cwd");
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

function makeLiveSdkEntry(dbSessionId: string) {
	return {
		manager: {
			abort: vi.fn(),
			getCurrentSessionId: vi.fn().mockReturnValue(dbSessionId),
		},
	};
}

const activeDelegationStates = [
	["pending", "pending", false],
	["running", "running", false],
] as const;

const ownedDelegationStates = [
	...activeDelegationStates,
	["resumable interrupted", "interrupted", true],
] as const;

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

	it.each(
		ownedDelegationStates,
	)("returns 409 for a %s delegation-owned child", async (_label, status, resumable) => {
		const fakeEntry = makeLiveSdkEntry("delegated-db-session");
		const pool = makePool({
			get: vi.fn().mockReturnValue(fakeEntry),
		});
		mockGetHlidDelegationByChildSession.mockResolvedValueOnce({
			status,
			resumable,
		});
		const url = makeUrl("/db/live-sessions/stop");
		const req = new Request("http://localhost/db/live-sessions/stop", {
			method: "POST",
			body: JSON.stringify({ session_id: "delegated-pool-session" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleDbRoute(url, req, pool);

		expect(res?.status).toBe(409);
		expect(await res?.text()).toMatch(/owned by an active or resumable/i);
		expect(mockGetHlidDelegationByChildSession).toHaveBeenCalledWith(
			"delegated-db-session",
		);
		expect(fakeEntry.manager.abort).not.toHaveBeenCalled();
	});

	it("calls manager.abort() and returns ok for valid session_id", async () => {
		const mockAbort = vi.fn();
		const fakeEntry = {
			manager: {
				abort: mockAbort,
				getCurrentSessionId: vi.fn().mockReturnValue("db-session-1"),
			},
		};
		mockGetHlidDelegationByChildSession.mockResolvedValueOnce({
			status: "completed",
			resumable: false,
		});
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
		expect(mockGetHlidDelegationByChildSession).toHaveBeenCalledWith(
			"db-session-1",
		);
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

	it.each(
		activeDelegationStates,
	)("returns 409 for a %s delegation-owned child", async (_label, status, resumable) => {
		const fakeEntry = makeLiveSdkEntry("delegated-db-session");
		const mockClose = vi.fn();
		const pool = makePool({
			get: vi.fn().mockReturnValue(fakeEntry),
			close: mockClose,
			isVaultSession: vi.fn().mockReturnValue(false),
		});
		mockGetHlidDelegationByChildSession.mockResolvedValueOnce({
			status,
			resumable,
		});
		const url = makeUrl("/db/live-sessions/close");
		const req = new Request("http://localhost/db/live-sessions/close", {
			method: "POST",
			body: JSON.stringify({ session_id: "delegated-pool-session" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleDbRoute(url, req, pool);

		expect(res?.status).toBe(409);
		expect(await res?.text()).toMatch(/owned by an active or resumable/i);
		expect(mockGetHlidDelegationByChildSession).toHaveBeenCalledWith(
			"delegated-db-session",
		);
		expect(mockClose).not.toHaveBeenCalled();
	});

	it("abandons and closes a detached restart-interrupted child", async () => {
		const refreshDurableDelegationAttention = vi
			.fn()
			.mockResolvedValue(undefined);
		const pool = makePool({ refreshDurableDelegationAttention });
		mockGetHlidDelegationByChildSession.mockResolvedValueOnce({
			id: "delegation-1",
			status: "interrupted",
			resumable: true,
		});
		mockAbandonInterruptedHlidDelegation.mockResolvedValueOnce({
			id: "delegation-1",
			status: "cancelled",
			resumable: false,
		});
		const url = makeUrl("/db/live-sessions/close");
		const req = new Request("http://localhost/db/live-sessions/close", {
			method: "POST",
			body: JSON.stringify({ session_id: "delegated-db-session" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleDbRoute(url, req, pool);

		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ ok: true });
		expect(mockAbandonInterruptedHlidDelegation).toHaveBeenCalledWith(
			"delegation-1",
			"The user closed this restart-interrupted child without continuing it.",
		);
		expect(refreshDurableDelegationAttention).toHaveBeenCalledOnce();
	});

	it("returns 403 when attempting to close the vault session", async () => {
		const fakeEntry = {
			manager: {
				abort: vi.fn(),
				getCurrentSessionId: vi.fn().mockReturnValue("vault-db-session"),
			},
		};
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
		const fakeEntry = {
			manager: {
				abort: vi.fn(),
				getCurrentSessionId: vi.fn().mockReturnValue("agent-db-session-1"),
			},
		};
		mockGetHlidDelegationByChildSession.mockResolvedValueOnce({
			status: "completed",
			resumable: false,
		});
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
		expect(mockGetHlidDelegationByChildSession).toHaveBeenCalledWith(
			"agent-db-session-1",
		);
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
		mockDeleteSession.mockReset();
		mockDeleteSession.mockResolvedValue({ ephemeralPaths: [] });
		mockGetMessageForFork.mockReset();
		mockInsertForkedMessages.mockReset();
		mockCopyForkedSessionTranscript.mockReset();
		mockCopyForkedSessionTranscript.mockResolvedValue(2);
		mockCopyForkedSessionAttachments.mockReset();
		mockCopyForkedSessionAttachments.mockResolvedValue(0);
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

	it("returns 422 for a Live row without a native fork boundary", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "codex",
		});
		mockGetMessageForFork.mockResolvedValue({
			sessionId: "abc-123",
			seq: 3,
			role: "assistant",
			sdkUuid: null,
			providerTurnId: null,
			forkSupported: false,
		});
		const res = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123", messageId: 42 }),
			makePool(),
		);
		if (!res) throw new Error("Expected a Response, got null");
		expect(res.status).toBe(422);
		expect(await res.text()).toContain(
			"does not expose a native Codex fork boundary",
		);
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

	it("uses the exact provider runtime cwd for fork negotiation and execution", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "acp:test",
			agent_cwd: "/work/context-agent",
			history_resume_mode: "native",
		});
		mockGetSessionProviderSession.mockResolvedValue("native-source-id");
		const resolveForkCapability = vi.fn().mockResolvedValue({
			kind: "exact",
			wholeSession: true,
			throughMessage: false,
		});
		const forkSession = vi
			.fn()
			.mockResolvedValue({ sessionId: "native-forked-id" });
		const providerRuntimeCwd = vi
			.fn()
			.mockReturnValue("C:\\Users\\kyle\\Vault");
		const pool = makePool({
			providerRuntimeCwd,
			getProvider: vi.fn().mockReturnValue({
				providerId: "acp:test",
				resolveForkCapability,
				forkSession,
			}),
		});

		const response = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123" }),
			pool,
		);

		expect(response?.status).toBe(200);
		expect(providerRuntimeCwd).toHaveBeenCalledWith("/work/context-agent");
		expect(resolveForkCapability).toHaveBeenCalledWith({
			cwd: "C:\\Users\\kyle\\Vault",
		});
		expect(forkSession).toHaveBeenCalledWith({
			sessionId: "native-source-id",
			cwd: "C:\\Users\\kyle\\Vault",
			historyResumeMode: "native",
			cutoff: undefined,
		});
	});

	it("fails a fork closed when its persisted workspace is no longer configured", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "acp:test",
			agent_cwd: "/work/removed-agent",
		});
		mockGetSessionProviderSession.mockResolvedValue("native-source-id");
		const resolveForkCapability = vi.fn();
		const forkSession = vi.fn();
		const pool = makePool({
			providerRuntimeCwd: vi.fn().mockReturnValue(null),
			getProvider: vi.fn().mockReturnValue({
				providerId: "acp:test",
				resolveForkCapability,
				forkSession,
			}),
		});

		const response = await handleDbRoute(
			makeUrl("/db/session/fork"),
			forkRequest({ id: "abc-123" }),
			pool,
		);

		expect(response?.status).toBe(409);
		expect(await response?.text()).toContain("no longer configured");
		expect(resolveForkCapability).not.toHaveBeenCalled();
		expect(forkSession).not.toHaveBeenCalled();
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
				manager: {
					getStatus: () => ({ state: "running" }),
					hasActiveRealtime: () => false,
				},
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

	it("returns 409 while provider background work is still running", async () => {
		const pool = makePool({
			findByDbSessionId: vi.fn().mockReturnValue({
				manager: {
					getStatus: () => ({ state: "idle" }),
					hasActiveRealtime: () => false,
					getBackgroundActivities: () => [
						{
							providerId: "claude",
							providerSessionId: "native-live-session",
							activityId: "task-1",
							kind: "agent",
							status: "running",
							startedAtMs: 1,
							updatedAtMs: 2,
							capabilities: { stop: true },
						},
					],
				},
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
				manager: {
					getStatus: () => ({ state: "idle" }),
					hasActiveRealtime: () => false,
				},
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

	it("returns 409 while Raven Live is active", async () => {
		const pool = makePool({
			findByDbSessionId: vi.fn().mockReturnValue({
				manager: {
					getStatus: () => ({ state: "idle" }),
					hasActiveRealtime: () => true,
				},
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

	it("does not create Hlid state when the provider's native thread is gone", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "codex",
			agent_cwd: "/work/project",
		});
		mockGetSessionProviderSession.mockResolvedValue("thread-source");
		const forkSession = vi
			.fn()
			.mockRejectedValue(new Error("Native thread no longer exists"));
		const pool = makePool({
			getProvider: vi.fn().mockReturnValue({
				providerId: "codex",
				forkCapability: {
					kind: "exact",
					cutoff: "turn",
					wholeSession: true,
					throughMessage: true,
				},
				forkSession,
			}),
		});

		await expect(
			handleDbRoute(
				makeUrl("/db/session/fork"),
				forkRequest({ id: "abc-123" }),
				pool,
			),
		).rejects.toThrow("Native thread no longer exists");
		expect(mockCreateForkedSessionRow).not.toHaveBeenCalled();
		expect(mockCopyForkedSessionTranscript).not.toHaveBeenCalled();
		expect(mockDeleteSession).not.toHaveBeenCalled();
	});

	it("keeps Hlid empty when advertised ACP fork support fails at runtime", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "acp:test",
			agent_cwd: "/work/project",
		});
		mockGetSessionProviderSession.mockResolvedValue("acp-source");
		const forkSession = vi
			.fn()
			.mockRejectedValue(new Error("ACP fork was rejected"));
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

		await expect(
			handleDbRoute(
				makeUrl("/db/session/fork"),
				forkRequest({ id: "abc-123" }),
				pool,
			),
		).rejects.toThrow("ACP fork was rejected");
		expect(mockCreateForkedSessionRow).not.toHaveBeenCalled();
		expect(mockCopyForkedSessionTranscript).not.toHaveBeenCalled();
		expect(mockDeleteSession).not.toHaveBeenCalled();
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
		expect(mockCopyForkedSessionAttachments).toHaveBeenCalledWith(
			"abc-123",
			json.id,
		);
		expect(mockInsertForkedMessages).not.toHaveBeenCalled();
	});

	it("rolls back a partial Hlid child when transcript persistence fails", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "claude",
			agent_cwd: "/work/project",
			history_resume_mode: "none",
		});
		mockGetSessionProviderSession.mockResolvedValue("native-source-id");
		mockCopyForkedSessionTranscript.mockRejectedValue(
			new Error("Transcript copy failed"),
		);
		const pool = makePool({
			getProvider: vi.fn().mockReturnValue({
				providerId: "claude",
				forkCapability: {
					kind: "exact",
					cutoff: "message",
					wholeSession: true,
					throughMessage: true,
				},
				forkSession: vi
					.fn()
					.mockResolvedValue({ sessionId: "native-forked-id" }),
			}),
		});

		await expect(
			handleDbRoute(
				makeUrl("/db/session/fork"),
				forkRequest({ id: "abc-123" }),
				pool,
			),
		).rejects.toThrow("Transcript copy failed");
		const newId = mockCreateForkedSessionRow.mock.calls[0]?.[1];
		expect(newId).toEqual(expect.any(String));
		expect(mockDeleteSession).toHaveBeenCalledWith(newId);
		expect(mockInsertForkedMessages).not.toHaveBeenCalled();
	});

	it("rolls back the fork when visualization attachment copying fails", async () => {
		mockGetSessionById.mockResolvedValue({
			...sampleRow,
			provider_id: "codex",
			agent_cwd: "/work/project",
			history_resume_mode: "none",
		});
		mockGetSessionProviderSession.mockResolvedValue("thread-source");
		mockCopyForkedSessionAttachments.mockRejectedValue(
			new Error("Visualization copy failed"),
		);
		const pool = makePool({
			getProvider: vi.fn().mockReturnValue({
				providerId: "codex",
				forkCapability: {
					kind: "exact",
					cutoff: "turn",
					wholeSession: true,
					throughMessage: true,
				},
				forkSession: vi.fn().mockResolvedValue({ sessionId: "thread-fork" }),
			}),
		});

		await expect(
			handleDbRoute(
				makeUrl("/db/session/fork"),
				forkRequest({ id: "abc-123" }),
				pool,
			),
		).rejects.toThrow("Visualization copy failed");
		const newId = mockCreateForkedSessionRow.mock.calls[0]?.[1];
		expect(newId).toEqual(expect.any(String));
		expect(mockDeleteSession).toHaveBeenCalledWith(newId);
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
			setForkParentLabel: vi.fn(),
		};
		const other = {
			getCurrentSessionId: vi.fn().mockReturnValue("s2"),
			setSessionLabel: vi.fn(),
			setForkParentLabel: vi.fn(),
		};
		const pool = makePool();
		(pool as unknown as { getAllEntries: () => unknown[] }).getAllEntries =
			() => [{ manager: matching }, { manager: other }];
		const setSessionLabel = vi.fn();
		const setForkParentLabel = vi.fn();
		const terminalPool = {
			setSessionLabel,
			setForkParentLabel,
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
		expect(setForkParentLabel).toHaveBeenCalledWith("s1", "renamed");
		expect(matching.setSessionLabel).toHaveBeenCalledWith("renamed");
		expect(other.setSessionLabel).not.toHaveBeenCalled();
		expect(matching.setForkParentLabel).toHaveBeenCalledWith("s1", "renamed");
		expect(other.setForkParentLabel).toHaveBeenCalledWith("s1", "renamed");
	});

	it("returns 404 instead of broadcasting a rename for a missing session", async () => {
		mockRenameSession.mockRejectedValueOnce(new Error("Session not found"));
		const pool = makePool();

		const res = await handleDbRoute(
			makeUrl("/db/session", { id: "missing" }),
			patchRequest({ label: "renamed" }),
			pool,
		);

		expect(res?.status).toBe(404);
		expect(await res?.text()).toBe("Session not found");
		expect(mockRenameSession).toHaveBeenCalledWith("missing", "renamed");
		expect(pool.getSessionsStatus).not.toHaveBeenCalled();
	});

	it("persists pin state and refreshes matching live presentation", async () => {
		mockSetSessionPinned.mockResolvedValue(undefined);
		const setSessionPinned = vi.fn();
		const pool = makePool({
			findByDbSessionId: vi.fn().mockReturnValue({
				manager: { setSessionPinned },
			}),
		});
		const setTerminalPinned = vi.fn();
		const terminalPool = {
			setSessionPinned: setTerminalPinned,
			getSessionsStatus: () => [],
		} as never;
		const res = await handleDbRoute(
			makeUrl("/db/session", { id: "s1" }),
			patchRequest({ pinned: true }),
			pool,
			terminalPool,
		);

		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ ok: true });
		expect(mockSetSessionPinned).toHaveBeenCalledWith("s1", true);
		expect(setSessionPinned).toHaveBeenCalledWith(true);
		expect(setTerminalPinned).toHaveBeenCalledWith("s1", true);
		expect(mockRenameSession).not.toHaveBeenCalled();
		expect(pool.getSessionsStatus).toHaveBeenCalled();
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

	it("rejects archiving a durable pending delegation without a live running manager", async () => {
		const blocked = new Error(
			"Cannot archive a session owned by a pending or running delegation.",
		);
		blocked.name = "SessionDelegationOwnershipError";
		mockSetSessionArchived.mockRejectedValueOnce(blocked);
		const pool = makePool();

		const response = await handleDbRoute(
			makeUrl("/db/session", { id: "delegated-child" }),
			patchRequest({ archived: true }),
			pool,
		);

		expect(response?.status).toBe(409);
		expect(await response?.text()).toMatch(/pending or running delegation/i);
		expect(mockSetSessionArchived).toHaveBeenCalledWith(
			"delegated-child",
			true,
		);
		expect(pool.close).not.toHaveBeenCalled();
	});
});

describe("handleDbRoute — DELETE /db/session", () => {
	it("rejects a running parent before async delegation admission can orphan it", async () => {
		const runningEntry = {
			sessionId: "admission-parent-pool",
			manager: {
				getStatus: vi.fn().mockReturnValue({ state: "running" }),
			},
		};
		const pool = makePool({
			findByDbSessionId: vi.fn().mockReturnValue(runningEntry),
		});

		const response = await handleDbRoute(
			makeUrl("/db/session", { id: "admission-parent" }),
			makeRequest("DELETE"),
			pool,
		);

		expect(response?.status).toBe(409);
		expect(await response?.text()).toMatch(/running session/i);
		expect(mockDeleteSession).not.toHaveBeenCalled();
		expect(mockCloseProjectPreviewSession).not.toHaveBeenCalled();
	});

	it("rejects deleting a live terminal session before DB mutation", async () => {
		const terminalPool = {
			getSessionsStatus: vi.fn().mockReturnValue([
				{
					session_id: "terminal-session",
				},
			]),
		} as never;

		const response = await handleDbRoute(
			makeUrl("/db/session", { id: "terminal-session" }),
			makeRequest("DELETE"),
			undefined,
			terminalPool,
		);

		expect(response?.status).toBe(409);
		expect(await response?.text()).toMatch(/running session/i);
		expect(mockDeleteSession).not.toHaveBeenCalled();
	});

	it("still deletes an idle live session", async () => {
		mockDeleteSession.mockResolvedValueOnce({
			ephemeralPaths: ["/tmp/idle-session-attachment"],
		});
		const idleEntry = {
			sessionId: "idle-pool",
			manager: {
				getStatus: vi.fn().mockReturnValue({ state: "idle" }),
			},
		};
		const pool = makePool({
			findByDbSessionId: vi.fn().mockReturnValue(idleEntry),
		});

		const response = await handleDbRoute(
			makeUrl("/db/session", { id: "idle-session" }),
			makeRequest("DELETE"),
			pool,
		);

		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({ ok: true });
		expect(mockDeleteSession).toHaveBeenCalledWith("idle-session");
		expect(mockCloseProjectPreviewSession).toHaveBeenCalledWith(
			"idle-session",
			"session_deleted",
		);
		expect(pool.close).toHaveBeenCalledWith("idle-pool");
		expect(pool.refreshDurableDelegationAttention).toHaveBeenCalledOnce();
	});

	it("returns 409 when deleting a delegated parent would orphan descendants", async () => {
		const blocked = new Error(
			"Delete this session's delegated descendants before deleting their delegated parent.",
		);
		blocked.name = "SessionHasDelegationDescendantsError";
		mockDeleteSession.mockRejectedValueOnce(blocked);
		const pool = makePool();

		const response = await handleDbRoute(
			makeUrl("/db/session", { id: "delegated-parent" }),
			makeRequest("DELETE"),
			pool,
		);

		expect(response?.status).toBe(409);
		expect(await response?.text()).toMatch(/delegated descendants/i);
		expect(mockDeleteSession).toHaveBeenCalledWith("delegated-parent");
		expect(pool.refreshDurableDelegationAttention).not.toHaveBeenCalled();
	});

	it("returns 409 for a child still owned by an active or resumable delegation", async () => {
		const blocked = new Error(
			"Cannot delete a session owned by a pending, running, or resumable interrupted delegation.",
		);
		blocked.name = "SessionDelegationOwnershipError";
		mockDeleteSession.mockRejectedValueOnce(blocked);
		const pool = makePool();

		const response = await handleDbRoute(
			makeUrl("/db/session", { id: "delegated-child" }),
			makeRequest("DELETE"),
			pool,
		);

		expect(response?.status).toBe(409);
		expect(await response?.text()).toMatch(/resumable interrupted delegation/i);
		expect(mockDeleteSession).toHaveBeenCalledWith("delegated-child");
		expect(pool.refreshDurableDelegationAttention).not.toHaveBeenCalled();
	});
});

describe("handleDbRoute — POST /db/sessions/cleanup", () => {
	it("requires a short-lived preview receipt", async () => {
		const response = await handleDbRoute(
			makeUrl("/db/sessions/cleanup"),
			makeRequest("POST", { older_than_days: 30 }),
		);

		expect(response?.status).toBe(400);
		expect(await response?.text()).toMatch(/preview_id/);
		expect(mockDeleteSessionsOlderThan).not.toHaveBeenCalled();
	});

	it("consumes the receipt and refuses changed exact candidates", async () => {
		const preview = {
			days: 30,
			cutoff: 1_700_000_000,
			sessions: 1,
			messages: 2,
			toolEvents: 0,
			estimatedDatabaseBytes: 512,
			usageQueriesPreserved: 1,
			managedAttachments: 0,
			managedAttachmentBytes: 0,
			retainedRelics: 0,
			retainedRelicBytes: 0,
			vaultLinksDetached: 0,
			planProposals: 0,
			askUserQuestions: 0,
			projectPreviewFeedback: 0,
		};
		mockGetSessionCleanupPlan
			.mockResolvedValueOnce({ preview, sessionIds: ["old-a"] })
			.mockResolvedValueOnce({
				preview,
				sessionIds: ["old-b"],
			});
		const previewResponse = await handleDbRoute(
			makeUrl("/db/sessions/cleanup/preview", {
				older_than_days: "30",
			}),
			makeRequest(),
		);
		const receipt = await previewResponse?.json();

		const changed = await handleDbRoute(
			makeUrl("/db/sessions/cleanup"),
			makeRequest("POST", { preview_id: receipt.preview_id }),
		);
		const reused = await handleDbRoute(
			makeUrl("/db/sessions/cleanup"),
			makeRequest("POST", { preview_id: receipt.preview_id }),
		);

		expect(changed?.status).toBe(409);
		expect(await changed?.text()).toMatch(/impact changed/i);
		expect(reused?.status).toBe(409);
		expect(await reused?.text()).toMatch(/missing or expired/i);
		expect(mockDeleteSessionsOlderThan).not.toHaveBeenCalled();
	});

	it("atomically excludes every DB session claimed by a live pool or terminal", async () => {
		const preview = {
			days: 7,
			cutoff: 1_700_000_000,
			sessions: 1,
			messages: 2,
			toolEvents: 0,
			estimatedDatabaseBytes: 512,
			usageQueriesPreserved: 1,
			managedAttachments: 0,
			managedAttachmentBytes: 0,
			retainedRelics: 0,
			retainedRelicBytes: 0,
			vaultLinksDetached: 0,
			planProposals: 0,
			askUserQuestions: 0,
			projectPreviewFeedback: 0,
		};
		mockGetSessionCleanupPlan.mockResolvedValue({
			preview,
			sessionIds: ["unrelated-old-session"],
		});
		mockDeleteSessionsOlderThan.mockResolvedValueOnce({
			count: 1,
			ephemeralPaths: [],
			sessionIds: ["unrelated-old-session"],
		});
		mockDeleteProjectPreviewsForSessions.mockResolvedValueOnce(undefined);
		const pool = makePool({
			getAllEntries: vi.fn().mockImplementation(() =>
				[
					{
						claimedDbSessionId: "claimed-during-admission",
						manager: {
							getCurrentSessionId: vi
								.fn()
								.mockReturnValue("current-live-session"),
						},
					},
					{
						claimedDbSessionId: "claimed-only-session",
						manager: {
							getCurrentSessionId: vi.fn().mockReturnValue(null),
						},
					},
					{
						claimedDbSessionId: "current-live-session",
						manager: {
							getCurrentSessionId: vi
								.fn()
								.mockReturnValue("current-live-session"),
						},
					},
				].values(),
			),
		});
		const terminalPool = {
			getSessionsStatus: vi.fn().mockReturnValue([
				{
					session_id: "terminal-pool-session",
					hasDbSession: true,
					db_session_id: "terminal-db-session",
				},
				{
					session_id: "legacy-terminal-db-session",
					hasDbSession: true,
					db_session_id: null,
				},
			]),
		} as never;

		const previewResponse = await handleDbRoute(
			makeUrl("/db/sessions/cleanup/preview", {
				older_than_days: "7",
			}),
			makeRequest(),
			pool,
			terminalPool,
		);
		const previewReceipt = await previewResponse?.json();
		const response = await handleDbRoute(
			makeUrl("/db/sessions/cleanup"),
			makeRequest("POST", { preview_id: previewReceipt.preview_id }),
			pool,
			terminalPool,
		);

		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({ deleted: 1 });
		const [, excludedSessionIds] =
			mockDeleteSessionsOlderThan.mock.calls[0] ?? [];
		expect(new Set(excludedSessionIds)).toEqual(
			new Set([
				"current-live-session",
				"claimed-during-admission",
				"claimed-only-session",
				"terminal-db-session",
				"legacy-terminal-db-session",
			]),
		);
		expect(mockDeleteSessionsOlderThan).toHaveBeenCalledWith(
			7,
			expect.arrayContaining(["claimed-during-admission"]),
			["unrelated-old-session"],
		);
		expect(mockCloseProjectPreviewSession).toHaveBeenCalledWith(
			"unrelated-old-session",
			"session_deleted",
		);
		expect(mockDeleteProjectPreviewsForSessions).toHaveBeenCalledWith([
			"unrelated-old-session",
		]);
	});
});

describe("handleDbRoute — GET /db/sessions/cleanup/preview", () => {
	it("previews only sessions not claimed by a live runtime", async () => {
		const preview = {
			days: 30,
			cutoff: 1_700_000_000,
			sessions: 2,
			messages: 8,
			toolEvents: 3,
			estimatedDatabaseBytes: 4096,
			usageQueriesPreserved: 4,
			managedAttachments: 1,
			managedAttachmentBytes: 1024,
			retainedRelics: 1,
			retainedRelicBytes: 1024,
			vaultLinksDetached: 0,
			planProposals: 0,
			askUserQuestions: 0,
			projectPreviewFeedback: 0,
		};
		mockGetSessionCleanupPlan.mockResolvedValueOnce({
			preview,
			sessionIds: ["old-a", "old-b"],
		});
		const pool = makePool({
			getAllEntries: vi.fn().mockReturnValue(
				[
					{
						claimedDbSessionId: "claimed-session",
						manager: { getCurrentSessionId: vi.fn().mockReturnValue(null) },
					},
				].values(),
			),
		});

		const response = await handleDbRoute(
			makeUrl("/db/sessions/cleanup/preview", {
				older_than_days: "30",
			}),
			makeRequest(),
			pool,
		);

		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			...preview,
			preview_id: expect.any(String),
			expires_at: expect.any(Number),
		});
		expect(mockGetSessionCleanupPlan).toHaveBeenCalledWith(30, [
			"claimed-session",
		]);
	});
});

describe("handleDbRoute — storage maintenance", () => {
	it("retries queued file deletions before physically reclaiming storage", async () => {
		mockListPendingFileDeletions.mockResolvedValueOnce([
			{ path: "C:/Hlid/artifacts/old.png" },
		]);
		mockReclaimStorage.mockResolvedValueOnce({ databaseBytes: 2048 });

		const response = await handleDbRoute(
			makeUrl("/db/storage/reclaim"),
			makeRequest("POST"),
			makePool(),
		);

		expect(response?.status).toBe(200);
		expect(mockUnlinkPaths).toHaveBeenCalledWith(["C:/Hlid/artifacts/old.png"]);
		expect(mockReclaimStorage).toHaveBeenCalledOnce();
	});

	it("refuses a physical reclaim while a session is running", async () => {
		const pool = makePool({
			getSessionsStatus: vi
				.fn()
				.mockReturnValue([{ session_id: "running", state: "running" }]),
		});

		const response = await handleDbRoute(
			makeUrl("/db/storage/reclaim"),
			makeRequest("POST"),
			pool,
		);

		expect(response?.status).toBe(409);
		expect(mockReclaimStorage).not.toHaveBeenCalled();
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

	it("maps a mixed DB-selected tool window and leaves legacy reads complete", async () => {
		mockGetSessionMessages.mockResolvedValue([
			{ id: 1, seq: 2, role: "assistant", text: "done", query_id: 42 },
			{ id: 2, seq: 4, role: "assistant", text: "active", query_id: null },
		]);
		const eligibleEvents = Array.from({ length: 25 }, (_, index) => ({
			id: index + 1,
			assistant_seq: 2,
			name: "Read",
			result_text: "ok",
			is_error: index === 3 ? 1 : 0,
			subagent_json: null,
			activity_json: null,
		}));
		const activeEvents = Array.from({ length: 21 }, (_, index) => ({
			id: index + 101,
			assistant_seq: 4,
			name: "Read",
			result_text: index === 20 ? null : "ok",
			is_error: 0,
			subagent_json: null,
			activity_json: null,
		}));
		mockGetSessionToolEventSummaries.mockResolvedValue([
			...eligibleEvents,
			...activeEvents,
		]);
		mockGetSessionToolEventTranscriptWindow.mockResolvedValue({
			items: [...eligibleEvents.slice(-20), ...activeEvents],
			pages: [
				{
					assistantSeq: 2,
					total: 25,
					errorCount: 1,
					hasEarlier: true,
					nextBeforeId: 6,
				},
			],
		});
		mockGetAttachmentsForSession.mockResolvedValue([]);

		const compact = await handleDbRoute(
			makeUrl("/db/session-messages", {
				session_id: "s1",
				tool_event_page_size: "20",
			}),
			makeRequest(),
		);
		const compactRows = (await compact?.json()) as Array<{
			toolEvents: Array<{ id: number }>;
			toolEventPage?: Record<string, unknown>;
		}>;
		expect(compactRows[0].toolEvents.map((event) => event.id)).toEqual(
			Array.from({ length: 20 }, (_, index) => index + 6),
		);
		expect(compactRows[0].toolEventPage).toEqual({
			total: 25,
			errorCount: 1,
			hasEarlier: true,
			nextBeforeId: 6,
		});
		expect(compactRows[1].toolEvents).toHaveLength(21);
		expect(compactRows[1].toolEventPage).toBeUndefined();
		expect(mockGetSessionToolEventTranscriptWindow).toHaveBeenCalledWith(
			"s1",
			2,
			4,
			20,
		);
		expect(mockGetSessionToolEventSummaries).not.toHaveBeenCalled();

		const legacy = await handleDbRoute(
			makeUrl("/db/session-messages", { session_id: "s1" }),
			makeRequest(),
		);
		const legacyRows = (await legacy?.json()) as Array<{
			toolEvents: unknown[];
			toolEventPage?: unknown;
		}>;
		expect(legacyRows[0].toolEvents).toHaveLength(25);
		expect(legacyRows[1].toolEvents).toHaveLength(21);
		expect(legacyRows[0].toolEventPage).toBeUndefined();
		expect(legacyRows[1].toolEventPage).toBeUndefined();
	});

	it("omits page metadata when the DB returns a complete one-page history", async () => {
		mockGetSessionMessages.mockResolvedValue([
			{ id: 1, seq: 2, role: "assistant", text: "done", query_id: 42 },
		]);
		mockGetSessionToolEventTranscriptWindow.mockResolvedValue({
			items: Array.from({ length: 20 }, (_, index) => ({
				id: index + 1,
				assistant_seq: 2,
				name: "Read",
				result_text: "ok",
				is_error: 0,
				subagent_json: null,
				activity_json: null,
			})),
			pages: [],
		});
		mockGetAttachmentsForSession.mockResolvedValue([]);

		const response = await handleDbRoute(
			makeUrl("/db/session-messages", {
				session_id: "s1",
				tool_event_page_size: "20",
			}),
			makeRequest(),
		);
		const [row] = (await response?.json()) as Array<{
			toolEvents: unknown[];
			toolEventPage?: unknown;
		}>;
		expect(row.toolEvents).toHaveLength(20);
		expect(row.toolEventPage).toBeUndefined();
	});

	it("keeps assistant page metadata off a user row with the same sequence", async () => {
		mockGetSessionMessages.mockResolvedValue([
			{ id: 1, seq: 2, role: "assistant", text: "done", query_id: 42 },
			{ id: 2, seq: 2, role: "user", text: "same sequence" },
		]);
		mockGetSessionToolEventTranscriptWindow.mockResolvedValue({
			items: [],
			pages: [
				{
					assistantSeq: 2,
					total: 25,
					errorCount: 0,
					hasEarlier: true,
					nextBeforeId: 6,
				},
			],
		});
		mockGetAttachmentsForSession.mockResolvedValue([]);

		const response = await handleDbRoute(
			makeUrl("/db/session-messages", {
				session_id: "s1",
				tool_event_page_size: "20",
			}),
			makeRequest(),
		);
		const rows = (await response?.json()) as Array<{
			role: string;
			toolEventPage?: unknown;
		}>;
		expect(rows[0].toolEventPage).toBeDefined();
		expect(rows[1].toolEventPage).toBeUndefined();
	});
});

describe("handleDbRoute — GET /db/session-tool-events", () => {
	it("requires a session and assistant sequence", async () => {
		const missingSession = await handleDbRoute(
			makeUrl("/db/session-tool-events", { assistant_seq: "2" }),
			makeRequest(),
		);
		const missingSequence = await handleDbRoute(
			makeUrl("/db/session-tool-events", { session_id: "s1" }),
			makeRequest(),
		);
		expect(missingSession?.status).toBe(400);
		expect(missingSequence?.status).toBe(400);
	});

	it("passes the exclusive id cursor to storage", async () => {
		mockGetSessionToolEventPage.mockResolvedValue({
			items: [{ id: 10 }],
			total: 30,
			errorCount: 2,
			hasEarlier: true,
			nextBeforeId: 10,
		});
		const response = await handleDbRoute(
			makeUrl("/db/session-tool-events", {
				session_id: "s1",
				assistant_seq: "4",
				before_id: "20",
				limit: "10",
			}),
			makeRequest(),
		);
		expect(response?.status).toBe(200);
		expect(mockGetSessionToolEventPage).toHaveBeenCalledWith("s1", 4, 20, 10);
		expect(await response?.json()).toMatchObject({ total: 30, errorCount: 2 });
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
