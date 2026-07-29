import { describe, expect, it } from "vitest";
import { API_ENDPOINTS, buildApiIndex } from "./apiIndex";

describe("buildApiIndex", () => {
	it("carries the ports and the full endpoint catalog", () => {
		const index = buildApiIndex(3001, 3000);
		expect(index.api_port).toBe(3001);
		expect(index.ui_port).toBe(3000);
		expect(index.endpoints).toBe(API_ENDPOINTS);
		expect(index.endpoints.length).toBeGreaterThan(0);
	});

	it("has unique method+path entries", () => {
		const keys = API_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("lists itself so agents can rediscover the catalog", () => {
		expect(
			API_ENDPOINTS.some((e) => e.path === "/api-index" && e.method === "GET"),
		).toBe(true);
	});

	it("describes orchestration progress, partial results, and resume admission", () => {
		const endpoint = (path: string) =>
			API_ENDPOINTS.find((entry) => entry.path === path)?.desc ?? "";
		expect(endpoint("/hlid-agents/:id?parent_session_id=")).toContain(
			"bounded active progress",
		);
		expect(endpoint("/hlid-agents/:id/wait")).toContain("partial result");
		expect(endpoint("/hlid-agents/:id/resume")).toContain(
			"live running parent turn",
		);
		expect(endpoint("/hlid-agents/:id/resume")).toContain(
			"active-capacity admission",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain("model service_tier");
		expect(endpoint("/hlid-agents/delegate")).toContain("exact configured cwd");
		expect(endpoint("/hlid-agents/delegate")).toContain("recorded passively");
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"no elapsed-time or inactivity cap",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"cross-provider silence is not proof of failure",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"never transition automatically to timed_out",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"Provider availability is checked before launch",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"explicit cancellation stops work",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"Scheduled Routines may delegate",
		);
		expect(endpoint("/hlid-agents/:id/resume")).toContain(
			"recorded configured workspace",
		);
		expect(endpoint("/hlid-agents/:id/resume")).toContain("service tier");
		expect(endpoint("/hlid-agents/:id/resume")).toContain(
			"passive observations",
		);
		expect(endpoint("/hlid-agents/:id/resume")).toContain(
			"no elapsed-time or inactivity cap",
		);
		expect(endpoint("/hlid-agents/:id/resume")).toContain("non-Routine child");
		expect(endpoint("/hlid-agents/:id/cancel")).toContain(
			"retains provider control",
		);
		expect(endpoint("/hlid-agents/:id/cancel")).toContain(
			"until each provider turn settles",
		);
	});

	it("routes ui-server paths under /api/ and api-server paths outside it", () => {
		for (const e of API_ENDPOINTS) {
			if (e.server === "ui") expect(e.path.startsWith("/api/")).toBe(true);
			else expect(e.path.startsWith("/api/")).toBe(false);
		}
	});
});
