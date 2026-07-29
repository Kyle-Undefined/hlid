import { describe, expect, it } from "vitest";
import { hlidDelegationsPath } from "./hlidDelegations";

describe("hlidDelegationsPath", () => {
	it("keeps durable child reads on the authenticated server-function path", () => {
		expect(
			hlidDelegationsPath({
				sessionId: "parent/session",
				limit: 50,
			}),
		).toBe("/hlid-agents?parent_session_id=parent%2Fsession&limit=50");
	});

	it("omits an unspecified limit", () => {
		expect(hlidDelegationsPath({ sessionId: "parent" })).toBe(
			"/hlid-agents?parent_session_id=parent",
		);
	});
});
