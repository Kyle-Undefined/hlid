import { describe, expect, it } from "vitest";
import { navActiveOptions, navSearch } from "./items";

describe("navSearch", () => {
	it("restores the last Raven session only for the Raven destination", () => {
		const lastRavenSession = {
			sessionId: "session-1",
			agent: "/agents/hlid",
		};
		expect(navSearch("/raven", lastRavenSession)).toEqual({
			session: "session-1",
			agent: "/agents/hlid",
		});
		expect(navSearch("/ledger", lastRavenSession)).toBeUndefined();
	});

	it("omits search state when no Raven session has been remembered", () => {
		expect(navSearch("/raven", null)).toBeUndefined();
	});
});

describe("navActiveOptions", () => {
	it("matches the section pathname without requiring Raven search equality", () => {
		expect(navActiveOptions(false)).toEqual({
			exact: false,
			includeSearch: false,
		});
	});
});
