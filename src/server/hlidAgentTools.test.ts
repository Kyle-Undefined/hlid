import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	dbFetch: vi.fn(),
	requireDbOk: vi.fn(),
}));

vi.mock("#/lib/dbClient", () => db);

import {
	executeHlidAgentTool,
	executeHlidAgentToolRich,
	HLID_AGENT_TOOL_SPECS,
} from "./hlidAgentTools";

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

	it("exposes deferred Relic and Project Preview capabilities", () => {
		expect(HLID_AGENT_TOOL_SPECS.map((spec) => spec.name)).toEqual([
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
		expect(HLID_AGENT_TOOL_SPECS[0].inputSchema.properties).toMatchObject({
			source_path: { type: "string" },
			filename: { type: "string" },
			content: { type: "string" },
		});
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
