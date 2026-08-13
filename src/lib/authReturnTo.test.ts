import { describe, expect, it } from "vitest";
import {
	loginLocationForReturnTo,
	requestAuthReturnTo,
	safeAuthReturnTo,
} from "./authReturnTo";

describe("authentication return paths", () => {
	it("keeps bounded authenticated application routes", () => {
		expect(safeAuthReturnTo("/raven?session=session-1")).toBe(
			"/raven?session=session-1",
		);
		expect(safeAuthReturnTo("/forge#experience")).toBe("/forge#experience");
		expect(
			requestAuthReturnTo(new Request("https://hlid.test/vault?tab=skills")),
		).toBe("/vault?tab=skills");
	});

	it("rejects external, protocol-relative, privileged, and oversized targets", () => {
		for (const target of [
			"https://example.test/raven",
			"//example.test/raven",
			"/login?next=/raven",
			"/api/auth/logout",
			"/_serverFn/private",
			`/raven?value=${"x".repeat(2_100)}`,
		]) {
			expect(safeAuthReturnTo(target), target).toBe("/");
		}
	});

	it("adds a login next parameter only for a valid non-root target", () => {
		expect(loginLocationForReturnTo("/")).toBe("/login");
		expect(loginLocationForReturnTo("/raven?session=session-1")).toBe(
			"/login?next=%2Fraven%3Fsession%3Dsession-1",
		);
	});
});
