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

	it("routes ui-server paths under /api/ and api-server paths outside it", () => {
		for (const e of API_ENDPOINTS) {
			if (e.server === "ui") expect(e.path.startsWith("/api/")).toBe(true);
			else expect(e.path.startsWith("/api/")).toBe(false);
		}
	});
});
