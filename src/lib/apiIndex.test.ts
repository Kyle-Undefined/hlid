import { describe, expect, it } from "vitest";
import { parseHlidApiIndex } from "./apiIndex";

describe("Hlid API index parsing", () => {
	it("accepts the bounded live catalog contract", () => {
		expect(
			parseHlidApiIndex({
				description: "catalog",
				api_port: 3001,
				ui_port: 3000,
				endpoints: [
					{
						method: "GET",
						path: "/api-index",
						server: "api",
						desc: "This catalog.",
					},
				],
			}),
		).toMatchObject({ api_port: 3001, endpoints: [{ path: "/api-index" }] });
	});

	it("rejects malformed endpoints and ports", () => {
		expect(() =>
			parseHlidApiIndex({
				description: "catalog",
				api_port: 0,
				ui_port: 3000,
				endpoints: [],
			}),
		).toThrow("invalid API catalog");
		expect(() =>
			parseHlidApiIndex({
				description: "catalog",
				api_port: 3001,
				ui_port: 3000,
				endpoints: [{ method: "TRACE", path: "/", server: "api", desc: "" }],
			}),
		).toThrow("invalid API catalog");
	});
});
