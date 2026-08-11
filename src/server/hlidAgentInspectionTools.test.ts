import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	artifactDirectory: vi.fn(),
	getAttachment: vi.fn(),
	getDb: vi.fn(),
	getSessionsPaginated: vi.fn(),
	getSessionById: vi.fn(),
	getSessionMessages: vi.fn(),
	getLedgerAnalytics: vi.fn(),
	getLogs: vi.fn(),
	listRoutines: vi.fn(),
	getRoutine: vi.fn(),
	listRoutineRuns: vi.fn(),
}));

vi.mock("../db", () => ({
	getAttachment: mocks.getAttachment,
	getDb: mocks.getDb,
	getSessionsPaginated: mocks.getSessionsPaginated,
	getSessionById: mocks.getSessionById,
	getSessionMessages: mocks.getSessionMessages,
	getLedgerAnalytics: mocks.getLedgerAnalytics,
	getLogs: mocks.getLogs,
	listRoutines: mocks.listRoutines,
	getRoutine: mocks.getRoutine,
}));

vi.mock("../db/routines", () => ({
	listRoutineRuns: mocks.listRoutineRuns,
}));

vi.mock("./libraryStore", () => ({
	artifactDirectory: mocks.artifactDirectory,
}));

import {
	executeInspectHlidContext,
	executeInspectHlidDiagnostics,
	executeInspectHlidLedger,
	executeInspectHlidRoutine,
	executeInspectHlidSession,
	executeListHlidRoutines,
	executePreviewHlidRoutineSchedule,
	executeReadRelic,
	executeSearchHlidSessions,
	executeSearchRelics,
} from "./hlidAgentInspectionTools";

const temporaryRoots: string[] = [];

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

function sessionRow() {
	return {
		id: "session-1",
		label: "Visible session",
		model: "model-a",
		selected_model: "model-b",
		selected_effort: "high",
		provider_id: "codex",
		agent_cwd: "/home/user/private-workspace",
		started_at: 100,
		ended_at: 200,
		query_count: 2,
		total_cost: 1.5,
		total_estimated_cost: 0,
		total_input_tokens: 10,
		total_output_tokens: 20,
		total_cache_read_tokens: 0,
		total_cache_creation_tokens: 0,
		total_turns: 2,
		tool_call_count: 3,
	};
}

function routineSummary() {
	return {
		id: "019f0000-0000-7000-8000-000000000001",
		name: "Daily report",
		prompt: "secret prompt",
		enabled: true,
		archived: false,
		revision: 2,
		schedule: { kind: "daily" as const, time: "09:00" },
		timezone: "UTC",
		nextRunAt: 1_000,
		providerId: "codex",
		model: "model-a",
		effort: "high",
		agentCwd: "/private/workspace",
		agentName: "Agent",
		skillContexts: ["/private/skill"],
		providerCommands: [],
		vaultReferences: ["Private.md"],
		relicIds: [],
		permissionMode: "read_only" as const,
		grants: [{ capability: "fs.read" as const, path: "/private" }],
		deliveries: [{ kind: "relic" as const }],
		catchUpWindowMinutes: 60,
		noOverlap: true,
		pausedReason: null,
		authorizationFingerprint: "fingerprint",
		createdAt: 10,
		updatedAt: 20,
		lastRun: null,
	};
}

describe("Hlid agent inspection tools", () => {
	it("searches only durable Hlid-generated Relics and returns safe metadata", async () => {
		const all = vi.fn().mockReturnValue([
			{
				id: "019f0000-0000-7000-8000-000000000001",
				filename: "report.md",
				path: "/private/report.md",
				mime: "text/markdown",
				size_bytes: 12,
				created_at: 100,
				kind: "ephemeral",
				retention: "retained",
				origin: "generated",
				storage_key: "artifacts/id/report.md",
				sha256: "secret",
				agent_cwd: "/private",
				category: "report",
				session_id: "session-1",
				message_seq: null,
			},
		]);
		const query = vi.fn().mockReturnValue({ all });
		mocks.getDb.mockResolvedValue({ query });

		const result = JSON.parse(await executeSearchRelics({ query: "report" }));

		expect(query.mock.calls[0]?.[0]).toContain("retention = 'retained'");
		expect(query.mock.calls[0]?.[0]).toContain("origin = 'generated'");
		expect(result.items[0]).not.toHaveProperty("path");
		expect(result.items[0]).not.toHaveProperty("sha256");
		expect(result.items[0]).not.toHaveProperty("agent_cwd");
	});

	it("reads and integrity-checks exact UTF-8 Relics without executing HTML", async () => {
		const root = await mkdtemp(join(tmpdir(), "hlid-relic-read-"));
		temporaryRoots.push(root);
		const artifact = join(root, "artifact");
		await mkdir(artifact);
		const path = join(artifact, "report.html");
		const bytes = Buffer.from("<script>never execute</script>", "utf8");
		await writeFile(path, bytes);
		mocks.artifactDirectory.mockReturnValue(artifact);
		mocks.getAttachment.mockResolvedValue({
			id: "019f0000-0000-7000-8000-000000000001",
			session_id: null,
			message_seq: null,
			kind: "ephemeral",
			filename: "report.html",
			path,
			mime: "text/html",
			size_bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			created_at: 100,
			storage_key: "artifacts/id/report.html",
			category: "report",
			retention: "retained",
			origin: "generated",
		});

		const result = await executeReadRelic({
			id: "019f0000-0000-7000-8000-000000000001",
		});
		const text = JSON.parse(result.text);

		expect(text.delivery).toBe("text");
		expect(text.content).toContain("never execute");
		expect(text.content_warning).toContain("never executed");
		expect(result.images).toBeUndefined();
	});

	it("does not treat retained plans as agent-discoverable Relics", async () => {
		mocks.getAttachment.mockResolvedValue({
			id: "019f0000-0000-7000-8000-000000000001",
			kind: "ephemeral",
			retention: "retained",
			origin: "generated",
			storage_key: "artifacts/id/plan.html",
			category: "plan",
		});

		await expect(
			executeReadRelic({
				id: "019f0000-0000-7000-8000-000000000001",
			}),
		).rejects.toThrow("not found");
		expect(mocks.artifactDirectory).not.toHaveBeenCalled();
	});

	it("returns safe session search and bounded transcript projections", async () => {
		mocks.getSessionsPaginated.mockResolvedValue({
			sessions: [sessionRow()],
			total: 1,
			oldest_started_at: 100,
			agent_cwds: ["/private"],
			models: ["model-b"],
		});
		mocks.getSessionById.mockResolvedValue(sessionRow());
		mocks.getSessionMessages.mockResolvedValue([
			{ id: 1, seq: 1, role: "user", timestamp: 100, text: "hello" },
		]);

		const search = JSON.parse(await executeSearchHlidSessions({}));
		const inspect = JSON.parse(
			await executeInspectHlidSession({ id: "session-1" }),
		);

		expect(search.items[0]).not.toHaveProperty("agent_cwd");
		expect(inspect.session).not.toHaveProperty("agent_cwd");
		expect(inspect.messages).toEqual([
			expect.objectContaining({ role: "user", text: "hello" }),
		]);
	});

	it("omits workspace facets from Ledger inspection", async () => {
		mocks.getLedgerAnalytics.mockResolvedValue({
			selected: { cost: 1, sessions: 1 },
			trend: { days: [], total: 0 },
			topTools: [],
			hourOfDay: [],
			weekdayHour: [],
			modelSplit: [],
			stopReasonSplit: [],
			facets: {
				agents: ["/private/workspace"],
				providers: ["codex"],
				models: ["model-a"],
			},
		});

		const result = JSON.parse(await executeInspectHlidLedger({ range: "30d" }));

		expect(result.facets).toEqual({
			providers: ["codex"],
			models: ["model-a"],
		});
		expect(JSON.stringify(result)).not.toContain("/private/workspace");
	});

	it("binds context receipt reads to the active Raven session", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(Response.json({ hlid_contexts: [] }));

		await expect(
			executeInspectHlidContext({}, undefined, fetcher),
		).rejects.toThrow("active Raven session");
		const result = JSON.parse(
			await executeInspectHlidContext({ limit: 3 }, "session-1", fetcher),
		);

		expect(fetcher).toHaveBeenCalledWith(
			"/db/session-context?session_id=session-1&limit=3",
		);
		expect(result).toEqual({ hlid_contexts: [] });
	});

	it("redacts Event Log paths and omits detail payloads", async () => {
		mocks.getLogs.mockResolvedValue({
			logs: [
				{
					id: 1,
					timestamp: 100,
					level: "error",
					source: "provider",
					message: "failed at /home/user/secret.txt",
					detail: '{"token":"secret"}',
				},
			],
			total: 1,
			counts: { error: 1, warn: 0, info: 0 },
		});

		const result = JSON.parse(await executeInspectHlidDiagnostics({}));
		const serialized = JSON.stringify(result);

		expect(serialized).toContain("<path>");
		expect(serialized).not.toContain("secret.txt");
		expect(serialized).not.toContain("token");
	});

	it("lists Routine metadata and history without prompts, paths, or grants", async () => {
		const routine = routineSummary();
		mocks.listRoutines.mockResolvedValue([routine]);
		mocks.getRoutine.mockResolvedValue(routine);
		mocks.listRoutineRuns.mockResolvedValue([
			{
				id: "run-1",
				trigger: "manual",
				scheduled_for: 100,
				started_at: 101,
				finished_at: 102,
				status: "succeeded",
				session_id: "session-1",
				provider_used: "codex",
				error: null,
				action_required: null,
			},
		]);

		const listed = JSON.parse(await executeListHlidRoutines({}));
		const inspected = JSON.parse(
			await executeInspectHlidRoutine({ id: routine.id }),
		);
		const serialized = JSON.stringify({ listed, inspected });

		expect(serialized).not.toContain("secret prompt");
		expect(serialized).not.toContain("/private");
		expect(serialized).not.toContain("fingerprint");
		expect(inspected.history[0].status).toBe("succeeded");
	});

	it("previews Routine occurrences without persisting anything", () => {
		const result = JSON.parse(
			executePreviewHlidRoutineSchedule({
				schedule: { kind: "daily", time: "09:00" },
				timezone: "UTC",
				after: 0,
			}),
		);

		expect(result.occurrences).toHaveLength(5);
		expect(mocks.getDb).not.toHaveBeenCalled();
	});
});
