import { describe, expect, it } from "vitest";
import type { HlidApiIndex } from "../lib/apiIndex";
import {
	buildHlidApiDiscoveryResponse,
	MAX_HLID_API_RESPONSE_CHARS,
} from "./hlidApiDiscovery";

const index: HlidApiIndex = {
	description: "Live catalog",
	api_port: 3031,
	ui_port: 3030,
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
		{
			method: "GET",
			path: "/api/config",
			server: "ui",
			desc: "Read config.",
		},
	],
};

describe("Hlid API discovery", () => {
	it("reports true totals and truncation independently of the limit", () => {
		const result = JSON.parse(
			buildHlidApiDiscoveryResponse(index, { query: "session", limit: 1 }),
		);
		expect(result).toMatchObject({
			apiBaseUrl: "http://127.0.0.1:3031",
			uiBaseUrl: "http://127.0.0.1:3030",
			total: 2,
			returned: 1,
			truncated: true,
			endpoints: [{ path: "/db/sessions" }],
		});
	});

	it("combines method and listener filters", () => {
		const result = JSON.parse(
			buildHlidApiDiscoveryResponse(index, {
				method: "GET",
				scope: "ui",
			}),
		);
		expect(result).toMatchObject({
			total: 1,
			returned: 1,
			truncated: false,
			endpoints: [{ path: "/api/config", server: "ui" }],
		});
	});

	it("returns an empty, terminating envelope for no matches", () => {
		const result = JSON.parse(
			buildHlidApiDiscoveryResponse(index, { query: "missing" }),
		);
		expect(result).toMatchObject({
			total: 0,
			returned: 0,
			truncated: false,
			endpoints: [],
		});
	});

	it("keeps large matching catalogs within the hard response budget", () => {
		const largeIndex: HlidApiIndex = {
			...index,
			endpoints: Array.from({ length: 50 }, (_, position) => ({
				method: "GET",
				path: `/large/${position}`,
				server: "api",
				desc: "x".repeat(500),
			})),
		};
		const response = buildHlidApiDiscoveryResponse(largeIndex, { limit: 50 });
		const result = JSON.parse(response);
		expect(response.length).toBeLessThanOrEqual(MAX_HLID_API_RESPONSE_CHARS);
		expect(result.total).toBe(50);
		expect(result.returned).toBeLessThan(50);
		expect(result.truncated).toBe(true);
	});
});
