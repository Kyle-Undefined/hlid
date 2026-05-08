import { describe, expect, it } from "vitest";
import { resolveSessionId } from "./sessionRouting";

describe("resolveSessionId", () => {
	// ── sameSession = false ───────────────────────────────────────────────────

	describe("sameSession = false", () => {
		it("returns newId when no attachment", () => {
			expect(
				resolveSessionId({
					sameSession: false,
					currentId: null,
					mostRecentId: undefined,
					attachedId: null,
					newId: "new-1",
				}),
			).toBe("new-1");
		});

		it("ignores currentId and uses newId anyway", () => {
			expect(
				resolveSessionId({
					sameSession: false,
					currentId: "active-session",
					mostRecentId: "recent-session",
					attachedId: null,
					newId: "new-2",
				}),
			).toBe("new-2");
		});

		it("uses attachedId over newId when attachment pre-selected a session", () => {
			expect(
				resolveSessionId({
					sameSession: false,
					currentId: null,
					mostRecentId: undefined,
					attachedId: "attached-session",
					newId: "new-3",
				}),
			).toBe("attached-session");
		});

		it("ignores mostRecentId regardless", () => {
			expect(
				resolveSessionId({
					sameSession: false,
					currentId: null,
					mostRecentId: "some-old-session",
					attachedId: null,
					newId: "new-4",
				}),
			).toBe("new-4");
		});
	});

	// ── sameSession = true ────────────────────────────────────────────────────

	describe("sameSession = true", () => {
		it("uses currentId when active session exists", () => {
			expect(
				resolveSessionId({
					sameSession: true,
					currentId: "active-session",
					mostRecentId: "recent-session",
					attachedId: null,
					newId: "new-5",
				}),
			).toBe("active-session");
		});

		it("falls back to mostRecentId when no active session", () => {
			expect(
				resolveSessionId({
					sameSession: true,
					currentId: null,
					mostRecentId: "recent-session",
					attachedId: null,
					newId: "new-6",
				}),
			).toBe("recent-session");
		});

		it("falls back to newId only when no existing sessions at all", () => {
			expect(
				resolveSessionId({
					sameSession: true,
					currentId: null,
					mostRecentId: undefined,
					attachedId: null,
					newId: "new-7",
				}),
			).toBe("new-7");
		});

		it("prefers currentId over mostRecentId (active > recent)", () => {
			expect(
				resolveSessionId({
					sameSession: true,
					currentId: "active-session",
					mostRecentId: "recent-session",
					attachedId: null,
					newId: "new-8",
				}),
			).toBe("active-session");
		});

		it("ignores attachedId — attachment flow does not override sameSession", () => {
			// attachedId is only honored when sameSession=false
			expect(
				resolveSessionId({
					sameSession: true,
					currentId: "active-session",
					mostRecentId: undefined,
					attachedId: "attached-session",
					newId: "new-9",
				}),
			).toBe("active-session");
		});
	});
});
