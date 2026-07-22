import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	dbFetch: vi.fn(),
	requireDbOk: vi.fn(),
}));

vi.mock("#/lib/dbClient", () => db);

import { executeHlidAgentTool, HLID_AGENT_TOOL_SPECS } from "./hlidAgentTools";

describe("Hlid agent tools", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.dbFetch.mockResolvedValue(
			Response.json({
				id: "relic-1",
				filename: "report.html",
				open_url: "/api/attachments/relic-1/raw",
			}),
		);
		db.requireDbOk.mockImplementation(async (response) => response);
	});

	it("exposes one deferred, create-focused capability", () => {
		expect(HLID_AGENT_TOOL_SPECS).toEqual([
			expect.objectContaining({
				name: "publish_relic",
				readOnly: false,
				deferLoading: true,
			}),
		]);
		expect(HLID_AGENT_TOOL_SPECS[0].inputSchema.properties).toMatchObject({
			source_path: { type: "string" },
			filename: { type: "string" },
			content: { type: "string" },
		});
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
