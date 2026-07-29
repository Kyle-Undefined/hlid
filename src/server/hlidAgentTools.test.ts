import { beforeEach, describe, expect, it, vi } from "vitest";
import { HLID_AGENT_TOOL_COUNT } from "../lib/hlidContext";

const db = vi.hoisted(() => ({
	dbFetch: vi.fn(),
	requireDbOk: vi.fn(),
}));

vi.mock("#/lib/dbClient", () => db);

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
		for (const topic of HLID_HELP_TOPICS) {
			expect(hlidAgentSchemas.hlid_help.parse({ topic })).toEqual({ topic });
		}
	});

	it("exposes deferred orchestration, Relic, and Project Preview capabilities", () => {
		expect(HLID_AGENT_TOOL_SPECS).toHaveLength(HLID_AGENT_TOOL_COUNT);
		expect(HLID_AGENT_TOOL_SPECS.map((spec) => spec.name)).toEqual([
			"hlid_help",
			"hlid_api",
			"delegate_hlid_agent",
			"list_hlid_agents",
			"inspect_hlid_agent",
			"wait_hlid_agent",
			"steer_hlid_agent",
			"cancel_hlid_agent",
			"resume_hlid_agent",
			"publish_relic",
			"start_project_preview",
			"inspect_project_preview",
			"capture_project_preview",
			"control_project_preview",
			"stop_project_preview",
		]);
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
		const delegationPermissionDescription = (
			HLID_AGENT_TOOL_SPECS.find((spec) => spec.name === "delegate_hlid_agent")
				?.inputSchema.properties.permission_mode as
				| { description?: string }
				| undefined
		)?.description;
		expect(delegationPermissionDescription).toContain(
			"Set plan explicitly when a Codex child must use native request_user_input",
		);
		expect(delegationPermissionDescription).toContain(
			"does not enter plan review unless Codex emits a real plan",
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

	it("returns bounded help from the live persisted session selection", async () => {
		db.dbFetch.mockResolvedValueOnce(
			Response.json({
				provider_id: "codex",
				selected_model: "gpt-5.6-sol",
				selected_effort: "high",
				selected_permission_mode: "acceptEdits",
			}),
		);
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
					availability: "unavailable",
				},
			],
		});
		expect(db.dbFetch).toHaveBeenCalledWith("/db/session-row?id=session-1");
		expect(db.dbFetch).toHaveBeenCalledWith("/providers?host_capabilities=1");
	});

	it("uses the full live provider catalog for orchestration target discovery", async () => {
		db.dbFetch.mockImplementation((path: string) => {
			if (path === "/db/session-row?id=session-1") {
				return Promise.resolve(
					Response.json({
						provider_id: "codex",
						selected_model: "gpt-5.6-sol",
					}),
				);
			}
			if (path === "/providers?host_capabilities=1") {
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
			source: "live-provider-catalog",
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

	it("combines the live provider catalog, feature flag, model, and registered tools", async () => {
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
				}),
			);

		const result = JSON.parse(
			await executeHlidAgentTool(
				"hlid_help",
				{ topic: "voice_audio" },
				{
					providerId: "codex",
					sessionId: "session-1",
					codexRealtimeEnabled: true,
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
					native_audio_input: expect.objectContaining({
						availability: "provider-native",
					}),
					raven_live: expect.objectContaining({
						availability: "conditional",
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

	it("inspects and stops only the active session's preview", async () => {
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
