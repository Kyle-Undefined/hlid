import { describe, expect, it } from "vitest";
import { navSearch } from "./items";

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
