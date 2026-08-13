import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HLID_AGENT_TOOL_COUNT } from "../lib/hlidContext";

const db = vi.hoisted(() => ({
	dbFetch: vi.fn(),
	requireDbOk: vi.fn(),
}));
const config = vi.hoisted(() => ({
	loadConfig: vi.fn(),
}));

vi.mock("#/lib/dbClient", () => db);
vi.mock("./config", () => config);

function storageStats(overrides: Record<string, number> = {}) {
	return {
		databaseBytes: 1_000,
		walBytes: 100,
		reclaimableBytes: 400,
		trackedAttachmentBytes: 200,
		trackedAttachments: 2,
		libraryBytes: 300,
		sessions: 10,
		messages: 20,
		usageQueries: 30,
		pendingFileDeletions: 0,
		availableBytes: 10_000,
		...overrides,
	};
}

function cleanupPreview(overrides: Record<string, unknown> = {}) {
	return {
		preview_id: "019f0000-0000-7000-8000-000000000001",
		expires_at: Math.floor(Date.now() / 1_000) + 600,
		days: 30,
		cutoff: 1_700_000_000,
		sessions: 2,
		messages: 8,
		toolEvents: 4,
		estimatedDatabaseBytes: 500,
		usageQueriesPreserved: 3,
		managedAttachments: 2,
		managedAttachmentBytes: 120,
		retainedRelics: 1,
		retainedRelicBytes: 80,
		vaultLinksDetached: 1,
		planProposals: 0,
		askUserQuestions: 0,
		projectPreviewFeedback: 0,
		...overrides,
	};
}

import {
	executeHlidAgentTool,
	executeHlidAgentToolRich,
	HLID_AGENT_TOOL_SPECS,
	hlidAgentSchemas,
} from "./hlidAgentTools";
import { HLID_HELP_TOPICS } from "./hlidHelp";

describe("Hlid agent tools", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		config.loadConfig.mockReturnValue({
			voice: { codex_live_mode: false },
		});
		db.dbFetch.mockImplementation(() =>
			Promise.resolve(
				Response.json({
					id: "relic-1",
					filename: "report.html",
					open_url: "/api/attachments/relic-1/raw",
				}),
			),
		);
		db.requireDbOk.mockImplementation(async (response) => response);
	});

	it("derives the callable help topic schemas from the help registry", () => {
		const helpSpec = HLID_AGENT_TOOL_SPECS.find(
			(spec) => spec.name === "hlid_help",
		);
		const advertisedTopics = (
			helpSpec?.inputSchema.properties.topic as { enum?: string[] } | undefined
		)?.enum;

		expect(advertisedTopics).toEqual([...HLID_HELP_TOPICS]);
		expect(advertisedTopics).toContain("orchestration");
		expect(helpSpec?.searchHint).toContain("Ledger");
		expect(helpSpec?.searchHint).toContain("diagnostics");
		expect(helpSpec?.searchHint).toContain("Routines");
		expect(helpSpec?.searchHint).toContain("orchestration");
		for (const topic of HLID_HELP_TOPICS) {
			expect(hlidAgentSchemas.hlid_help.parse({ topic })).toEqual({ topic });
		}
		expect(
			hlidAgentSchemas.hlid_help.parse({
				topic: "providers",
				query: "plan",
				capability_id: "codex:collaboration-mode:plan",
				integration: "integrated",
				availability: "available",
				limit: 5,
				cursor: "opaque-cursor",
			}),
		).toMatchObject({
			topic: "providers",
			query: "plan",
			capability_id: "codex:collaboration-mode:plan",
			integration: "integrated",
			availability: "available",
			limit: 5,
			cursor: "opaque-cursor",
		});
		expect(() =>
			hlidAgentSchemas.hlid_help.parse({ topic: "mcp", query: "plan" }),
		).toThrow(/topic=providers/i);
		expect(helpSpec?.inputSchema.properties).toMatchObject({
			query: {
				type: "string",
				description: expect.stringContaining(
					"resolved provider capability snapshot",
				),
			},
			capability_id: {
				type: "string",
				description: expect.stringContaining("registry.providerDiscovery"),
			},
			integration: {
				type: "string",
				enum: ["integrated", "provider-native", "not-integrated"],
			},
			availability: {
				type: "string",
				enum: ["available", "provider-native", "conditional", "unavailable"],
				description: expect.stringContaining(
					"resolved provider capability snapshot",
				),
			},
			limit: { type: "number" },
			cursor: { type: "string" },
		});
	});

	it("exposes deferred orchestration, Relic, and Project Preview capabilities", () => {
		expect(HLID_AGENT_TOOL_SPECS).toHaveLength(HLID_AGENT_TOOL_COUNT);
		const specNames = HLID_AGENT_TOOL_SPECS.map((spec) => spec.name);
		expect(new Set(specNames).size).toBe(specNames.length);
		expect([...specNames].sort()).toEqual(Object.keys(hlidAgentSchemas).sort());
		expect(specNames).toEqual([
			"hlid_help",
			"hlid_api",
			"inspect_hlid_storage",
			"optimize_hlid_storage",
			"cleanup_hlid_sessions",
			"delegate_hlid_agent",
			"list_hlid_agents",
			"inspect_hlid_agent",
			"wait_hlid_agent",
			"steer_hlid_agent",
			"cancel_hlid_agent",
			"resume_hlid_agent",
			"search_relics",
			"read_relic",
			"search_hlid_sessions",
			"inspect_hlid_session",
			"inspect_hlid_ledger",
			"inspect_hlid_context",
			"inspect_hlid_diagnostics",
			"list_hlid_routines",
			"inspect_hlid_routine",
			"preview_hlid_routine_schedule",
			"publish_relic",
			"start_project_preview",
			"inspect_project_preview",
			"capture_project_preview",
			"export_project_preview_capture",
			"control_project_preview",
			"restart_project_preview",
			"stop_project_preview",
		]);
		expect(specNames.some((name) => name.includes("reclaim"))).toBe(false);
		expect(HLID_AGENT_TOOL_SPECS).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "hlid_help",
					readOnly: true,
					deferLoading: true,
				}),
				expect.objectContaining({
					name: "hlid_api",
					readOnly: true,
					deferLoading: true,
				}),
				expect.objectContaining({
					name: "inspect_hlid_storage",
					readOnly: true,
					deferLoading: true,
				}),
				expect.objectContaining({
					name: "optimize_hlid_storage",
					readOnly: false,
					deferLoading: true,
					approvalTitle: "Hlid optimize storage",
				}),
				expect.objectContaining({
					name: "cleanup_hlid_sessions",
					readOnly: false,
					deferLoading: true,
					approvalTitle: "Hlid clean up sessions",
				}),
				expect.objectContaining({
					name: "delegate_hlid_agent",
					readOnly: false,
					deferLoading: true,
					approvalTitle: "Hlid delegate child agent",
				}),
				expect.objectContaining({
					name: "list_hlid_agents",
					readOnly: true,
					deferLoading: true,
				}),
				expect.objectContaining({
					name: "inspect_hlid_agent",
					readOnly: true,
					deferLoading: true,
				}),
				expect.objectContaining({
					name: "wait_hlid_agent",
					readOnly: true,
					deferLoading: true,
				}),
				expect.objectContaining({
					name: "steer_hlid_agent",
					readOnly: false,
					approvalTitle: "Hlid steer child agent",
				}),
				expect.objectContaining({
					name: "cancel_hlid_agent",
					readOnly: false,
					approvalTitle: "Hlid cancel child agent",
				}),
				expect.objectContaining({
					name: "resume_hlid_agent",
					readOnly: false,
					approvalTitle: "Hlid continue interrupted child",
				}),
				expect.objectContaining({
					name: "publish_relic",
					readOnly: false,
					deferLoading: true,
				}),
				expect.objectContaining({
					name: "inspect_project_preview",
					readOnly: true,
				}),
				expect.objectContaining({
					name: "capture_project_preview",
					readOnly: true,
					deferLoading: true,
				}),
				expect.objectContaining({
					name: "export_project_preview_capture",
					readOnly: false,
					deferLoading: true,
					approvalTitle: "Hlid export Project Preview capture",
				}),
				expect.objectContaining({
					name: "control_project_preview",
					readOnly: false,
					deferLoading: true,
					approvalTitle: "Hlid control Project Preview",
				}),
			]),
		);
		expect(
			HLID_AGENT_TOOL_SPECS.find((spec) => spec.name === "publish_relic")
				?.inputSchema.properties,
		).toMatchObject({
			source_path: { type: "string" },
			filename: { type: "string" },
			content: { type: "string" },
		});
		expect(
			HLID_AGENT_TOOL_SPECS.find((spec) => spec.name === "delegate_hlid_agent")
				?.inputSchema.properties,
		).toMatchObject({
			service_tier: { type: "string" },
			cwd: { type: "string" },
		});
		const delegateSpec = HLID_AGENT_TOOL_SPECS.find(
			(spec) => spec.name === "delegate_hlid_agent",
		);
		const resumeSpec = HLID_AGENT_TOOL_SPECS.find(
			(spec) => spec.name === "resume_hlid_agent",
		);
		const delegationPermission = delegateSpec?.inputSchema.properties
			.permission_mode as { description?: string; enum?: string[] } | undefined;
		const resumePermission = resumeSpec?.inputSchema.properties
			.permission_mode as { description?: string; enum?: string[] } | undefined;
		const delegationPermissionDescription = delegationPermission?.description;
		expect(delegationPermission?.enum).toEqual([
			"default",
			"acceptEdits",
			"bypassPermissions",
			"plan",
			"dontAsk",
			"auto",
		]);
		expect(resumePermission?.enum).toEqual(delegationPermission?.enum);
		expect(delegationPermissionDescription).toContain(
			"Set plan explicitly when a Codex child must use native request_user_input",
		);
		expect(delegationPermissionDescription).toContain(
			"does not enter plan review unless Codex emits a real plan",
		);
		expect(delegationPermissionDescription).toContain(
			"Auto is allowed only when the parent is Auto or bypass",
		);
		expect(delegationPermissionDescription).toContain(
			"Cross-provider children inheriting Auto must explicitly narrow",
		);
		expect(delegationPermissionDescription).toContain(
			"exact selected or inherited child model passes live readiness validation",
		);
		expect(delegateSpec?.description).toContain("direct native Claude child");
		expect(resumePermission?.description).toContain(
			"before consuming the continuation attempt",
		);
		expect(resumeSpec?.description).toContain(
			"revalidates the recorded exact model against live readiness",
		);
		for (const name of ["delegate_hlid_agent", "resume_hlid_agent"]) {
			const properties = HLID_AGENT_TOOL_SPECS.find(
				(spec) => spec.name === name,
			)?.inputSchema.properties;
			expect(properties).not.toHaveProperty("token_budget");
			expect(properties).not.toHaveProperty("cost_budget");
			expect(properties).not.toHaveProperty("timeout_seconds");
		}
		expect(
			Object.fromEntries(
				HLID_AGENT_TOOL_SPECS.filter((spec) =>
					[
						"delegate_hlid_agent",
						"list_hlid_agents",
						"inspect_hlid_agent",
						"wait_hlid_agent",
						"steer_hlid_agent",
						"cancel_hlid_agent",
						"resume_hlid_agent",
					].includes(spec.name),
				).map((spec) => [spec.name, spec.inputSchema.required]),
			),
		).toEqual({
			delegate_hlid_agent: ["task", "provider"],
			list_hlid_agents: [],
			inspect_hlid_agent: ["id"],
			wait_hlid_agent: ["id"],
			steer_hlid_agent: ["id", "instruction"],
			cancel_hlid_agent: ["id"],
			resume_hlid_agent: ["id", "instruction"],
		});
		const orchestrationSpecs = Object.fromEntries(
			HLID_AGENT_TOOL_SPECS.map((spec) => [spec.name, spec]),
		);
		expect(orchestrationSpecs.inspect_hlid_agent?.description).toContain(
			"bounded active progress",
		);
		expect(orchestrationSpecs.wait_hlid_agent?.description).toContain(
			"partial result plus error",
		);
		expect(orchestrationSpecs.resume_hlid_agent?.description).toContain(
			"live running parent turn",
		);
		expect(orchestrationSpecs.resume_hlid_agent?.description).toContain(
			"recorded configured workspace",
		);
		expect(orchestrationSpecs.resume_hlid_agent?.description).toContain(
			"four-per-parent and twelve-global active limits",
		);
		expect(orchestrationSpecs.delegate_hlid_agent?.description).toContain(
			"passively recorded usage",
		);
		expect(orchestrationSpecs.delegate_hlid_agent?.description).toContain(
			"no elapsed-time or inactivity cap",
		);
		expect(orchestrationSpecs.delegate_hlid_agent?.description).toContain(
			"cross-provider silence is not proof of failure",
		);
		expect(orchestrationSpecs.delegate_hlid_agent?.description).toContain(
			"do not accept a timeout input or transition automatically to timed_out",
		);
		expect(orchestrationSpecs.delegate_hlid_agent?.description).toContain(
			"Provider availability is checked before launch",
		);
		expect(orchestrationSpecs.delegate_hlid_agent?.description).toContain(
			"Scheduled Routines may delegate",
		);
		expect(orchestrationSpecs.resume_hlid_agent?.description).toContain(
			"service tier",
		);
		expect(orchestrationSpecs.resume_hlid_agent?.description).toContain(
			"Routine-owned child",
		);
		expect(orchestrationSpecs.resume_hlid_agent?.description).toContain(
			"no elapsed-time or inactivity cap",
		);
		expect(orchestrationSpecs.cancel_hlid_agent?.description).toContain(
			"retains provider control",
		);
		expect(orchestrationSpecs.cancel_hlid_agent?.description).toContain(
			"until each active provider turn settles",
		);
		expect(orchestrationSpecs.cancel_hlid_agent?.description).toContain(
			"explicitly abandons continuation",
		);
	});

	it("rejects a schema entry that has no registered execution handler", async () => {
		const mutableSchemas = hlidAgentSchemas as unknown as Record<
			string,
			(typeof hlidAgentSchemas)["publish_relic"]
		>;
		mutableSchemas.future_tool = hlidAgentSchemas.publish_relic;
		try {
			await expect(
				executeHlidAgentTool("future_tool", {
					filename: "unexpected.html",
					content: "<p>must not publish</p>",
				}),
			).rejects.toThrow("Unknown Hlid tool: future_tool");
			expect(db.dbFetch).not.toHaveBeenCalled();
		} finally {
			delete mutableSchemas.future_tool;
		}
	});

	it("creates, inspects, and waits on parent-owned durable children", async () => {
		const delegationId = "7c0eea4d-f74e-45c8-8674-a535fbb4412b";
		db.dbFetch
			.mockResolvedValueOnce(
				Response.json({
					id: delegationId,
					child_session_id: "child-1",
					status: "pending",
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					id: delegationId,
					child_session_id: "child-1",
					status: "running",
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					id: delegationId,
					child_session_id: "child-1",
					status: "completed",
					result_text: "Done",
				}),
			);

		await executeHlidAgentTool(
			"delegate_hlid_agent",
			{
				task: "Inspect the provider boundary",
				provider: "codex",
				permission_mode: "plan",
				timeout_seconds: 120,
				token_budget: 12_000,
				cost_budget: 1,
			},
			{ sessionId: "parent-1" },
		);
		expect(db.dbFetch).toHaveBeenLastCalledWith(
			"/hlid-agents/delegate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					task: "Inspect the provider boundary",
					provider: "codex",
					permission_mode: "plan",
					parent_session_id: "parent-1",
				}),
			}),
		);

		await executeHlidAgentTool(
			"inspect_hlid_agent",
			{ id: delegationId },
			{ sessionId: "parent-1" },
		);
		expect(db.dbFetch).toHaveBeenLastCalledWith(
			`/hlid-agents/${delegationId}?parent_session_id=parent-1`,
		);

		await executeHlidAgentTool(
			"wait_hlid_agent",
			{ id: delegationId, wait_seconds: 5 },
			{ sessionId: "parent-1" },
		);
		expect(db.dbFetch).toHaveBeenLastCalledWith(
			`/hlid-agents/${delegationId}/wait`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					parent_session_id: "parent-1",
					wait_seconds: 5,
				}),
			}),
		);
	});

	it("lists and controls the complete parent-owned child lifecycle", async () => {
		const delegationId = "7c0eea4d-f74e-45c8-8674-a535fbb4412b";
		db.dbFetch.mockImplementation(async () =>
			Response.json({ id: delegationId }),
		);

		await executeHlidAgentTool(
			"list_hlid_agents",
			{ limit: 10 },
			{ sessionId: "parent-1" },
		);
		expect(db.dbFetch).toHaveBeenLastCalledWith(
			"/hlid-agents?parent_session_id=parent-1&limit=10",
		);

		await executeHlidAgentTool(
			"steer_hlid_agent",
			{ id: delegationId, instruction: "Check the edge case" },
			{ sessionId: "parent-1" },
		);
		expect(db.dbFetch).toHaveBeenLastCalledWith(
			`/hlid-agents/${delegationId}/steer`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					instruction: "Check the edge case",
					parent_session_id: "parent-1",
				}),
			}),
		);

		await executeHlidAgentTool(
			"cancel_hlid_agent",
			{ id: delegationId },
			{ sessionId: "parent-1" },
		);
		expect(db.dbFetch).toHaveBeenLastCalledWith(
			`/hlid-agents/${delegationId}/cancel`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ parent_session_id: "parent-1" }),
			}),
		);

		await executeHlidAgentTool(
			"resume_hlid_agent",
			{
				id: delegationId,
				instruction: "Continue explicitly",
				timeout_seconds: 180,
				token_budget: 24_000,
				cost_budget: 2,
			},
			{ sessionId: "parent-1" },
		);
		expect(db.dbFetch).toHaveBeenLastCalledWith(
			`/hlid-agents/${delegationId}/resume`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					instruction: "Continue explicitly",
					parent_session_id: "parent-1",
				}),
			}),
		);
	});

	it("requires an active parent session for orchestration tools", async () => {
		await expect(
			executeHlidAgentTool("delegate_hlid_agent", {
				task: "Do work",
				provider: "codex",
			}),
		).rejects.toThrow("active parent Raven session");
		expect(db.dbFetch).not.toHaveBeenCalled();
	});

	it("searches the live API index without invoking an endpoint", async () => {
		db.dbFetch.mockResolvedValueOnce(
			Response.json({
				description: "catalog",
				api_port: 3001,
				ui_port: 3000,
				endpoints: [
					{
						method: "GET",
						path: "/db/sessions",
						server: "api",
						desc: "List sessions.",
					},
					{
						method: "DELETE",
						path: "/db/session",
						server: "api",
						desc: "Delete one session.",
					},
				],
			}),
		);

		const result = JSON.parse(
			await executeHlidAgentTool("hlid_api", {
				query: "session",
				method: "GET",
			}),
		);

		expect(result).toMatchObject({
			total: 1,
			returned: 1,
			truncated: false,
			endpoints: [{ method: "GET", path: "/db/sessions" }],
		});
		expect(db.dbFetch).toHaveBeenCalledTimes(1);
		expect(db.dbFetch).toHaveBeenCalledWith("/api-index");
	});

	it("inspects storage and issues a session-scoped cleanup preview", async () => {
		db.dbFetch.mockImplementation((path: string) => {
			if (path === "/db/storage") {
				return Promise.resolve(Response.json(storageStats()));
			}
			if (path === "/db/sessions/cleanup/preview?older_than_days=30") {
				return Promise.resolve(Response.json(cleanupPreview()));
			}
			throw new Error(`Unexpected path: ${path}`);
		});

		const result = JSON.parse(
			await executeHlidAgentTool(
				"inspect_hlid_storage",
				{ cleanup_older_than_days: 30 },
				{ sessionId: "session-1" },
			),
		);

		expect(result).toMatchObject({
			storage: { databaseBytes: 1_000, usageQueries: 30 },
			cleanup: {
				days: 30,
				sessions: 2,
				usageQueriesPreserved: 3,
			},
		});
		expect(result.cleanup.preview_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(result.cleanup.expires_at).toBeGreaterThan(
			Math.floor(Date.now() / 1_000),
		);
	});

	it("optimizes storage without exposing physical reclaim", async () => {
		db.dbFetch.mockImplementation((path: string, init?: RequestInit) => {
			if (path === "/db/storage") {
				return Promise.resolve(Response.json(storageStats()));
			}
			if (path === "/db/storage/optimize" && init?.method === "POST") {
				return Promise.resolve(
					Response.json(storageStats({ walBytes: 0, reclaimableBytes: 300 })),
				);
			}
			throw new Error(`Unexpected path: ${path}`);
		});

		const result = JSON.parse(
			await executeHlidAgentTool("optimize_hlid_storage", {}),
		);
		expect(result).toMatchObject({
			before: { walBytes: 100 },
			after: { walBytes: 0, reclaimableBytes: 300 },
			physical_reclaim: "forge-only",
		});
		expect(db.dbFetch).not.toHaveBeenCalledWith(
			"/db/storage/reclaim",
			expect.anything(),
		);
	});

	it("cleans only through the server receipt from the same session", async () => {
		let storageReads = 0;
		let previewReads = 0;
		db.dbFetch.mockImplementation((path: string, init?: RequestInit) => {
			if (path === "/db/storage") {
				storageReads += 1;
				return Promise.resolve(
					Response.json(
						storageReads === 1
							? storageStats()
							: storageStats({ sessions: 8, databaseBytes: 900 }),
					),
				);
			}
			if (path === "/db/sessions/cleanup/preview?older_than_days=30") {
				previewReads += 1;
				return Promise.resolve(
					Response.json(
						cleanupPreview({ cutoff: 1_700_000_000 + previewReads }),
					),
				);
			}
			if (path === "/db/sessions/cleanup" && init?.method === "POST") {
				return Promise.resolve(Response.json({ deleted: 2 }));
			}
			throw new Error(`Unexpected path: ${path}`);
		});

		const inspected = JSON.parse(
			await executeHlidAgentTool(
				"inspect_hlid_storage",
				{ cleanup_older_than_days: 30 },
				{ sessionId: "session-1" },
			),
		);
		const result = JSON.parse(
			await executeHlidAgentTool(
				"cleanup_hlid_sessions",
				{ preview_id: inspected.cleanup.preview_id },
				{ sessionId: "session-1" },
			),
		);

		expect(result).toMatchObject({
			preview: { sessions: 2, usageQueriesPreserved: 3 },
			cleanup: { deleted: 2 },
			storage: { sessions: 8, databaseBytes: 900 },
			physical_reclaim: "forge-only",
		});
		expect(previewReads).toBe(1);
		expect(db.dbFetch).toHaveBeenCalledWith("/db/sessions/cleanup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				preview_id: "019f0000-0000-7000-8000-000000000001",
			}),
		});
		expect(db.dbFetch).not.toHaveBeenCalledWith(
			"/db/storage/reclaim",
			expect.anything(),
		);
	});

	it("surfaces a server refusal when the preview impact changed", async () => {
		db.dbFetch.mockImplementation((path: string, init?: RequestInit) => {
			if (path === "/db/storage") {
				return Promise.resolve(Response.json(storageStats()));
			}
			if (path === "/db/sessions/cleanup/preview?older_than_days=30") {
				return Promise.resolve(Response.json(cleanupPreview()));
			}
			if (path === "/db/sessions/cleanup" && init?.method === "POST") {
				return Promise.resolve(
					new Response("Cleanup impact changed; preview again", {
						status: 409,
					}),
				);
			}
			throw new Error(`Unexpected path: ${path}`);
		});
		const inspected = JSON.parse(
			await executeHlidAgentTool(
				"inspect_hlid_storage",
				{ cleanup_older_than_days: 30 },
				{ sessionId: "session-1" },
			),
		);
		db.requireDbOk.mockRejectedValueOnce(
			new Error("Cleanup impact changed; preview again"),
		);

		await expect(
			executeHlidAgentTool(
				"cleanup_hlid_sessions",
				{ preview_id: inspected.cleanup.preview_id },
				{ sessionId: "session-1" },
			),
		).rejects.toThrow("impact changed");
		expect(db.dbFetch).not.toHaveBeenCalledWith(
			"/db/storage/reclaim",
			expect.anything(),
		);
	});

	it("does not let another Raven session consume a cleanup preview", async () => {
		db.dbFetch.mockImplementation((path: string) => {
			if (path === "/db/storage") {
				return Promise.resolve(Response.json(storageStats()));
			}
			if (path === "/db/sessions/cleanup/preview?older_than_days=30") {
				return Promise.resolve(Response.json(cleanupPreview()));
			}
			throw new Error(`Unexpected path: ${path}`);
		});
		const inspected = JSON.parse(
			await executeHlidAgentTool(
				"inspect_hlid_storage",
				{ cleanup_older_than_days: 30 },
				{ sessionId: "session-1" },
			),
		);

		await expect(
			executeHlidAgentTool(
				"cleanup_hlid_sessions",
				{ preview_id: inspected.cleanup.preview_id },
				{ sessionId: "session-2" },
			),
		).rejects.toThrow("different Raven session");
	});

	it("returns bounded help from the live persisted session selection", async () => {
		db.dbFetch.mockImplementation((path: string) => {
			if (path === "/db/session-row?id=session-1") {
				return Promise.resolve(
					Response.json({
						provider_id: "codex",
						selected_model: "gpt-5.6-sol",
						selected_effort: "high",
						selected_permission_mode: "acceptEdits",
					}),
				);
			}
			if (path.startsWith("/providers?")) {
				return Promise.resolve(
					Response.json({
						providers: [
							{
								id: "codex",
								label: "Codex",
								available: true,
								models: [],
								capabilities: { goalControl: true },
							},
						],
					}),
				);
			}
			return Promise.resolve(Response.json({}));
		});
		const result = JSON.parse(
			await executeHlidAgentTool(
				"hlid_help",
				{ topic: "workflows" },
				{
					providerId: "codex",
					model: "gpt-5.6-sol",
					permissionMode: "default",
					runtimeCwd: "/work/project",
					sessionId: "session-1",
					vaultName: "Fornbok",
				},
			),
		);

		expect(result).toMatchObject({
			contractVersion: 1,
			topic: "workflows",
			runtime: {
				providerId: "codex",
				providerRuntime: "codex",
				model: "gpt-5.6-sol",
				effort: "high",
				sessionScoped: true,
			},
			permissions: { mode: "acceptEdits" },
			capabilities: [
				{
					id: "workflows",
					availability: "conditional",
				},
			],
		});
		expect(db.dbFetch).toHaveBeenCalledWith("/db/session-row?id=session-1");
		expect(db.dbFetch).toHaveBeenCalledWith(
			"/providers?host_capabilities=1&provider_capabilities=1&provider_id=codex&capability_cwd=%2Fwork%2Fproject",
		);
	});

	it("uses the persisted active workspace for the cached capability snapshot", async () => {
		db.dbFetch.mockResolvedValueOnce(
			Response.json({
				provider_id: "codex",
				agent_cwd:
					"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid",
			}),
		);
		await executeHlidAgentTool(
			"hlid_help",
			{ topic: "providers" },
			{
				providerId: "codex",
				runtimeCwd: "C:\\Users\\kyleu\\Documents\\Obsidian\\Fornbok",
				sessionId: "session-1",
			},
		);

		expect(db.dbFetch).toHaveBeenCalledWith(
			"/providers?host_capabilities=1&provider_capabilities=1&provider_id=codex&capability_cwd=%5C%5Cwsl.localhost%5CUbuntu-24.04%5Chome%5Ckyle%5Cdevelopment%5Crepos%5Chlid",
		);
	});

	it("reports provider discovery failure without inventing native unavailability", async () => {
		db.dbFetch.mockImplementation((path: string) => {
			if (path.startsWith("/providers?")) {
				return Promise.resolve(
					Response.json(
						{ error: "Provider catalog changed repeatedly during refresh" },
						{ status: 503 },
					),
				);
			}
			return Promise.resolve(Response.json({}));
		});

		const result = JSON.parse(
			await executeHlidAgentTool(
				"hlid_help",
				{ topic: "goals" },
				{ providerId: "codex", runtimeCwd: "/work/project" },
			),
		);

		expect(result.capabilities).toEqual([
			expect.objectContaining({
				id: "goals",
				availability: "conditional",
			}),
		]);
		expect(result.registry).toMatchObject({
			providerSnapshot: "unavailable",
			providerDiscovery: {
				status: "unavailable",
				source: "none",
				retryable: true,
				reason: expect.stringContaining("HTTP 503"),
			},
		});
	});

	it("retains active provider and exact loaded tools when live discovery fails", async () => {
		db.dbFetch.mockImplementation((path: string) => {
			if (path.startsWith("/providers?")) {
				return Promise.resolve(new Response(null, { status: 503 }));
			}
			return Promise.resolve(Response.json({}));
		});
		const registeredHlidTools = [
			...HLID_AGENT_TOOL_SPECS.map((spec) => spec.name),
			"windows_computer_use",
			"create_visualization",
		];
		const context = {
			providerId: "codex",
			runtimeCwd: "/work/project",
			registeredHlidTools,
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				capabilities: { goalControl: true },
				hostCapabilities: {
					windowsComputerUse: {
						label: "Windows Computer Use",
						available: true,
					},
					windowsVisualize: {
						label: "Windows Visualize",
						available: true,
					},
				},
			},
		} as const;

		const failedDiscovery = JSON.parse(
			await executeHlidAgentTool("hlid_help", { topic: "providers" }, context),
		);
		const goals = JSON.parse(
			await executeHlidAgentTool("hlid_help", { topic: "goals" }, context),
		);

		expect(goals.capabilities).toEqual([
			expect.objectContaining({
				id: "goals",
				availability: "provider-native",
			}),
		]);
		expect(failedDiscovery.registry).toMatchObject({
			providerSnapshot: "captured",
			providerDiscovery: {
				status: "captured",
				source: "active-provider-context",
				retryable: true,
			},
		});
		expect(failedDiscovery.registry.hlidTools).toHaveLength(
			HLID_AGENT_TOOL_SPECS.length + 2,
		);
		expect(new Set(failedDiscovery.registry.hlidTools).size).toBe(
			failedDiscovery.registry.hlidTools.length,
		);
		expect(failedDiscovery.registry.hlidTools).toEqual(
			expect.arrayContaining(["windows_computer_use", "create_visualization"]),
		);
		expect(db.dbFetch).toHaveBeenCalledTimes(1);
	});

	it("does not wait on provider discovery for provider-independent help", async () => {
		db.dbFetch.mockClear();

		const result = JSON.parse(
			await executeHlidAgentTool(
				"hlid_help",
				{ topic: "references" },
				{ providerId: "codex", runtimeCwd: "/work/project" },
			),
		);

		expect(result.capabilities).toEqual([
			expect.objectContaining({ id: "references", availability: "available" }),
		]);
		expect(db.dbFetch).not.toHaveBeenCalled();
	});

	it("builds overview from captured provider evidence without live probes", async () => {
		db.dbFetch.mockClear();
		const registeredHlidTools = [
			...HLID_AGENT_TOOL_SPECS.map((spec) => spec.name),
			"windows_computer_use",
			"create_visualization",
		];

		const result = JSON.parse(
			await executeHlidAgentTool(
				"hlid_help",
				{ topic: "overview" },
				{
					providerId: "codex",
					runtimeCwd: "/work/project",
					registeredHlidTools,
					providerSnapshot: {
						id: "codex",
						label: "Codex",
						available: true,
						capabilities: { goalControl: true, realtime: true },
						hostCapabilities: {
							windowsComputerUse: {
								label: "Windows Computer Use",
								available: true,
							},
							windowsVisualize: {
								label: "Windows Visualize",
								available: true,
							},
						},
					},
				},
			),
		);

		expect(db.dbFetch).not.toHaveBeenCalled();
		expect(result.registry).toMatchObject({
			providerSnapshot: "captured",
			providerDiscovery: {
				status: "captured",
				source: "active-provider-context",
				retryable: false,
			},
			hlidTools: expect.arrayContaining([
				"windows_computer_use",
				"create_visualization",
			]),
		});
		expect(
			result.capabilities.find(
				(capability: { id: string }) => capability.id === "goals",
			),
		).toMatchObject({ availability: "provider-native" });
	});

	it("retrieves an omitted provider capability through the agent help tool", async () => {
		db.dbFetch.mockImplementation((path: string) => {
			if (path === "/db/session-row?id=session-1") {
				return Promise.resolve(
					Response.json({
						provider_id: "codex",
						agent_cwd: "/work/project",
					}),
				);
			}
			if (path.startsWith("/providers?")) {
				return Promise.resolve(
					Response.json({
						providers: [
							{
								id: "codex",
								label: "Codex",
								available: true,
								models: [],
								capabilitySnapshot: {
									contractVersion: 1,
									providerId: "codex",
									status: "current",
									source: "live",
									revision: "v1-query-test",
									observedAt: 1,
									capabilities: [
										{
											id: "codex:collaboration-mode:default",
											label: "Default",
											scope: "session",
											support: "advertised",
											integration: "integrated",
											readiness: "ready",
											source: "provider-runtime",
											availability: "available",
										},
										{
											id: "codex:collaboration-mode:plan",
											label: "Plan",
											scope: "session",
											support: "advertised",
											integration: "integrated",
											readiness: "ready",
											source: "provider-runtime",
											availability: "available",
											operations: ["select"],
										},
									],
								},
							},
						],
					}),
				);
			}
			return Promise.resolve(Response.json({}));
		});

		const result = JSON.parse(
			await executeHlidAgentTool(
				"hlid_help",
				{ topic: "providers", query: "plan" },
				{
					providerId: "codex",
					runtimeCwd: "/work/project",
					sessionId: "session-1",
				},
			),
		);

		expect(result.providerCapabilities).toMatchObject({
			total: 2,
			matched: 1,
			returned: 1,
			truncated: false,
		});
		expect(result.providerCapabilities.items).toEqual([
			expect.objectContaining({
				id: "codex:collaboration-mode:plan",
				availability: "available",
			}),
		]);
	});

	it("keeps Windows host bridges available to a WSL-scoped session", async () => {
		const runtimeCwd =
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid";
		db.dbFetch.mockImplementation((path: string) => {
			if (path === "/db/session-row?id=session-1") {
				return Promise.resolve(
					Response.json({
						provider_id: "codex",
						agent_cwd: runtimeCwd,
					}),
				);
			}
			if (path.startsWith("/providers?")) {
				return Promise.resolve(
					Response.json(
						{
							providers: [
								{
									id: "codex",
									label: "Codex",
									available: true,
									models: [],
									hostCapabilities: {
										windowsComputerUse: {
											label: "Windows Computer Use",
											available: true,
										},
										windowsVisualize: {
											label: "Windows Visualize",
											available: true,
										},
									},
								},
							],
						},
						{ headers: { "x-hlid-providers-revision": "42" } },
					),
				);
			}
			return Promise.resolve(Response.json({}));
		});

		const result = JSON.parse(
			await executeHlidAgentTool(
				"hlid_help",
				{ topic: "computer_use" },
				{ providerId: "codex", runtimeCwd, sessionId: "session-1" },
			),
		);

		expect(result.runtime.providerEnvironment).toBe("wsl");
		expect(result.registry.hlidTools).toEqual(
			expect.arrayContaining(["windows_computer_use", "create_visualization"]),
		);
		expect(result.registry.providerDiscovery).toMatchObject({
			status: "captured",
			source: "provider-catalog-cache",
			retryable: false,
			revision: "42",
		});
		expect(
			result.capabilities.find(
				(capability: { id: string }) => capability.id === "computer_use",
			),
		).toMatchObject({ owner: "hlid", availability: "available" });
	});

	it("reports persisted provider capability evidence as cached and stale", async () => {
		db.dbFetch.mockResolvedValue(
			Response.json({
				providers: [
					{
						id: "codex",
						label: "Codex",
						available: true,
						models: [],
						capabilitySnapshot: {
							contractVersion: 1,
							providerId: "codex",
							status: "stale",
							source: "persisted",
							revision: "v1-persisted",
							observedAt: 1,
							capabilities: [],
						},
					},
				],
			}),
		);

		const result = JSON.parse(
			await executeHlidAgentTool(
				"hlid_help",
				{ topic: "providers" },
				{ providerId: "codex", runtimeCwd: "/work/project" },
			),
		);

		expect(result.registry).toMatchObject({
			providerSnapshot: "captured",
			providerDiscovery: {
				status: "captured",
				source: "provider-catalog-cache",
				retryable: false,
			},
			providerCapabilities: {
				status: "stale",
				revision: "v1-persisted",
			},
		});
	});

	it("uses the full cached provider catalog for orchestration target discovery", async () => {
		db.dbFetch.mockImplementation((path: string) => {
			if (path === "/db/session-row?id=session-1") {
				return Promise.resolve(
					Response.json({
						provider_id: "codex",
						selected_model: "gpt-5.6-sol",
					}),
				);
			}
			if (path === "/providers?host_capabilities=1&provider_capabilities=1") {
				return Promise.resolve(
					Response.json({
						providers: [
							{
								id: "codex",
								label: "Codex",
								available: true,
								models: [{ value: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
							},
							{
								id: "claude",
								label: "Claude",
								available: true,
								models: [{ value: "claude-sonnet", label: "Claude Sonnet" }],
							},
						],
					}),
				);
			}
			return Promise.resolve(Response.json({}));
		});

		const result = JSON.parse(
			await executeHlidAgentTool(
				"hlid_help",
				{ topic: "orchestration" },
				{
					providerId: "codex",
					runtimeCwd: "/work/project",
					sessionId: "session-1",
				},
			),
		);

		expect(result.capabilities).toEqual([
			expect.objectContaining({
				id: "orchestration",
				availability: "available",
			}),
		]);
		expect(result.orchestrationTargets).toMatchObject({
			source: "provider-catalog-cache",
			snapshot: "current",
			totalProviders: 2,
			availableProviders: 2,
			providers: [
				{
					id: "codex",
					models: {
						items: [{ value: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
					},
				},
				{
					id: "claude",
					models: {
						items: [{ value: "claude-sonnet", label: "Claude Sonnet" }],
					},
				},
			],
		});
	});

	it("combines the provider catalog, feature flag, model, and registered tools", async () => {
		config.loadConfig.mockReturnValue({
			voice: { codex_live_mode: true },
		});
		db.dbFetch
			.mockResolvedValueOnce(
				Response.json({
					provider_id: "codex",
					selected_model: "gpt-audio",
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					providers: [
						{
							id: "codex",
							label: "Codex",
							available: true,
							models: [
								{
									value: "gpt-audio",
									label: "Audio",
									inputModalities: ["text", "audio"],
								},
							],
							capabilities: { realtime: true },
							capabilitySnapshot: {
								contractVersion: 1,
								providerId: "codex",
								status: "current",
								source: "live",
								revision: "v1-realtime-enabled",
								observedAt: 1,
								capabilities: [
									{
										id: "codex:experimental-feature:realtime_conversation",
										label: "Realtime conversation",
										scope: "provider",
										support: "advertised",
										integration: "provider-native",
										readiness: "ready",
										source: "provider-runtime",
										availability: "provider-native",
									},
								],
							},
							hostCapabilities: {
								windowsComputerUse: {
									label: "Windows Computer Use",
									available: true,
								},
							},
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					status: { state: "ready", model: "base" },
					codexRealtimeBackend: { available: true, observedAt: 1 },
				}),
			);

		const result = JSON.parse(
			await executeHlidAgentTool(
				"hlid_help",
				{ topic: "voice_audio" },
				{
					providerId: "codex",
					sessionId: "session-1",
					codexRealtimeEnabled: false,
				},
			),
		);

		expect(result.capabilities).toEqual([
			expect.objectContaining({
				id: "voice_audio",
				availability: "available",
				modes: expect.objectContaining({
					local_dictation: expect.objectContaining({
						availability: "available",
					}),
					codex_dictation: expect.objectContaining({
						availability: "provider-native",
					}),
					native_audio_input: expect.objectContaining({
						availability: "provider-native",
					}),
					raven_live: expect.objectContaining({
						availability: "provider-native",
					}),
				}),
			}),
		]);
		expect(result.registry).toMatchObject({
			providerSnapshot: "current",
			hlidTools: expect.arrayContaining([
				"hlid_help",
				"hlid_api",
				"windows_computer_use",
			]),
		});
		expect(db.dbFetch).toHaveBeenCalledWith("/voice");
		expect(config.loadConfig).toHaveBeenCalled();
	});

	it("starts a session-scoped preview through Hlid's internal API", async () => {
		db.dbFetch.mockResolvedValueOnce(
			Response.json({
				id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
				session_id: "session-1",
				state: "ready",
			}),
		);
		await executeHlidAgentTool(
			"start_project_preview",
			{ command: "bun run dev -- --port 4173", port: 4173 },
			{ runtimeCwd: "/work/project", sessionId: "session-1" },
		);
		expect(db.dbFetch).toHaveBeenCalledWith("/api/project-previews/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				command: "bun run dev -- --port 4173",
				port: 4173,
				runtime_cwd: "/work/project",
				session_id: "session-1",
			}),
		});
	});

	it("inspects, restarts, and stops only the active session's preview", async () => {
		const previewId = "7c0eea4d-f74e-45c8-8674-a535fbb4412b";
		await executeHlidAgentTool(
			"inspect_project_preview",
			{ preview_id: previewId },
			{ sessionId: "session-1" },
		);
		expect(db.dbFetch).toHaveBeenLastCalledWith(
			`/api/project-previews/${previewId}?session_id=session-1`,
		);
		await executeHlidAgentTool(
			"restart_project_preview",
			{ preview_id: previewId },
			{ sessionId: "session-1" },
		);
		expect(db.dbFetch).toHaveBeenLastCalledWith(
			`/api/project-previews/${previewId}/restart`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ session_id: "session-1" }),
			}),
		);
		await executeHlidAgentTool(
			"stop_project_preview",
			{ preview_id: previewId },
			{ sessionId: "session-1" },
		);
		expect(db.dbFetch).toHaveBeenLastCalledWith(
			`/api/project-previews/${previewId}/stop`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ session_id: "session-1" }),
			}),
		);
	});

	it("returns a Preview capture as image content without publishing a Relic", async () => {
		const previewId = "7c0eea4d-f74e-45c8-8674-a535fbb4412b";
		db.dbFetch.mockResolvedValueOnce(
			Response.json({
				preview_id: previewId,
				session_id: "session-1",
				path: "/settings",
				viewport: "tablet",
				width: 768,
				height: 1024,
				full_page: false,
				captured_at: Date.now(),
				mime: "image/png",
				size_bytes: 3,
				image_base64: "AQID",
			}),
		);

		const result = await executeHlidAgentToolRich(
			"capture_project_preview",
			{
				preview_id: previewId,
				path: "/settings",
				viewport: "tablet",
			},
			{ sessionId: "session-1" },
		);

		expect(db.dbFetch).toHaveBeenCalledWith(
			`/api/project-previews/${previewId}/capture`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					session_id: "session-1",
					path: "/settings",
					viewport: "tablet",
				}),
			}),
		);
		expect(result.images).toEqual([{ data: "AQID", mimeType: "image/png" }]);
		expect(JSON.parse(result.text)).toMatchObject({
			preview_id: previewId,
			viewport: "tablet",
			size_bytes: 3,
		});
		expect(result.text).not.toContain("image_base64");
	});

	it("exports the exact captured PNG inside the active workspace", async () => {
		const workspace = await mkdtemp(
			join(tmpdir(), "hlid-preview-export-test-"),
		);
		await mkdir(join(workspace, "docs"));
		const previewId = "7c0eea4d-f74e-45c8-8674-a535fbb4412b";
		db.dbFetch.mockResolvedValueOnce(
			Response.json({
				preview_id: previewId,
				session_id: "session-1",
				path: "/",
				viewport: "mobile",
				width: 390,
				height: 844,
				pixel_width: 780,
				pixel_height: 1688,
				device_scale_factor: 2,
				pixel_ratio: 2,
				full_page: false,
				captured_at: Date.now(),
				mime: "image/png",
				size_bytes: 3,
				image_base64: "AQID",
			}),
		);

		try {
			const result = await executeHlidAgentToolRich(
				"export_project_preview_capture",
				{
					preview_id: previewId,
					viewport: "mobile",
					output_path: "docs/mobile.png",
				},
				{ runtimeCwd: workspace, sessionId: "session-1" },
			);

			expect(await readFile(join(workspace, "docs/mobile.png"))).toEqual(
				Buffer.from([1, 2, 3]),
			);
			expect(db.dbFetch).toHaveBeenCalledWith(
				`/api/project-previews/${previewId}/capture`,
				expect.objectContaining({
					body: JSON.stringify({
						session_id: "session-1",
						viewport: "mobile",
					}),
				}),
			);
			expect(result.images).toEqual([{ data: "AQID", mimeType: "image/png" }]);
			expect(JSON.parse(result.text)).toMatchObject({
				saved_path: "docs/mobile.png",
				pixel_width: 780,
				pixel_height: 1688,
				device_scale_factor: 2,
				pixel_ratio: 2,
			});
			expect(result.text).not.toContain("image_base64");
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("rejects traversal and symlink escapes before capturing an export", async () => {
		const workspace = await mkdtemp(
			join(tmpdir(), "hlid-preview-export-test-"),
		);
		const outside = await mkdtemp(
			join(tmpdir(), "hlid-preview-export-outside-"),
		);
		await symlink(outside, join(workspace, "outside"));

		try {
			await expect(
				executeHlidAgentTool(
					"export_project_preview_capture",
					{ output_path: "/tmp/outside.png" },
					{ runtimeCwd: workspace, sessionId: "session-1" },
				),
			).rejects.toThrow("workspace-relative");
			await expect(
				executeHlidAgentTool(
					"export_project_preview_capture",
					{ output_path: "../outside.png" },
					{ runtimeCwd: workspace, sessionId: "session-1" },
				),
			).rejects.toThrow("parent traversal");
			await expect(
				executeHlidAgentTool(
					"export_project_preview_capture",
					{ output_path: "outside/capture.png" },
					{ runtimeCwd: workspace, sessionId: "session-1" },
				),
			).rejects.toThrow("resolves outside");
			expect(db.dbFetch).not.toHaveBeenCalled();
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("returns every Preview control action with its resulting image", async () => {
		const previewId = "7c0eea4d-f74e-45c8-8674-a535fbb4412b";
		const frameId = "e16b1643-591f-4d67-8c22-9df105659385";
		db.dbFetch.mockResolvedValueOnce(
			Response.json({
				preview_id: previewId,
				session_id: "session-1",
				path: "/settings",
				viewport: "desktop",
				width: 1440,
				height: 1000,
				full_page: false,
				captured_at: Date.now(),
				mime: "image/png",
				size_bytes: 3,
				image_base64: "AQID",
				frame_id: crypto.randomUUID(),
				title: "Settings",
				elements: [],
				console_messages: [],
				failed_requests: [],
				last_action: "click",
			}),
		);

		const result = await executeHlidAgentToolRich(
			"control_project_preview",
			{
				preview_id: previewId,
				action: "click",
				frame_id: frameId,
				ref: "e1",
			},
			{ sessionId: "session-1" },
		);

		expect(db.dbFetch).toHaveBeenCalledWith(
			`/api/project-previews/${previewId}/control`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					session_id: "session-1",
					action: "click",
					frame_id: frameId,
					ref: "e1",
				}),
			}),
		);
		expect(result.images).toEqual([{ data: "AQID", mimeType: "image/png" }]);
		expect(JSON.parse(result.text)).toMatchObject({
			last_action: "click",
			path: "/settings",
		});
		expect(result.text).not.toContain("image_base64");
	});

	it("publishes a workspace file through Hlid's internal API", async () => {
		const result = await executeHlidAgentTool(
			"publish_relic",
			{ source_path: "reports/a.pdf" },
			{ runtimeCwd: "/work/project", sessionId: "session-1" },
		);

		expect(db.dbFetch).toHaveBeenCalledWith("/api/relics/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				source_path: "reports/a.pdf",
				runtime_cwd: "/work/project",
				session_id: "session-1",
			}),
		});
		expect(JSON.parse(result)).toMatchObject({
			id: "relic-1",
			open_url: "/api/attachments/relic-1/raw",
		});
	});

	it("accepts direct HTML content without a provider path", async () => {
		await executeHlidAgentTool("publish_relic", {
			filename: "report.html",
			content: "<!doctype html><title>Report</title>",
		});
		expect(db.dbFetch).toHaveBeenCalledOnce();
	});

	it("rejects ambiguous sources and direct content without a filename", async () => {
		await expect(
			executeHlidAgentTool("publish_relic", {
				source_path: "report.html",
				filename: "report.html",
				content: "<p>duplicate</p>",
			}),
		).rejects.toThrow("exactly one");
		await expect(
			executeHlidAgentTool("publish_relic", { content: "hello" }),
		).rejects.toThrow("filename is required");
	});
});
