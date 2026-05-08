import { describe, expect, it } from "vitest";
import { approvedLabel, decisionFromScope, mapMcpServer } from "./protocol";

// ── decisionFromScope ─────────────────────────────────────────────────────────

describe("decisionFromScope", () => {
	it("returns denied when not approved", () => {
		expect(decisionFromScope(false)).toBe("denied");
		expect(decisionFromScope(false, "session")).toBe("denied");
		expect(decisionFromScope(false, "local")).toBe("denied");
	});

	it("returns approved_always for local scope", () => {
		expect(decisionFromScope(true, "local")).toBe("approved_always");
	});

	it("returns approved_session for session scope", () => {
		expect(decisionFromScope(true, "session")).toBe("approved_session");
	});

	it("returns approved when no saveScope provided", () => {
		expect(decisionFromScope(true)).toBe("approved");
	});

	it("returns approved when saveScope is undefined explicitly", () => {
		expect(decisionFromScope(true, undefined)).toBe("approved");
	});
});

// ── approvedLabel ─────────────────────────────────────────────────────────────

describe("approvedLabel", () => {
	it("returns correct label for approved_always", () => {
		expect(approvedLabel("approved_always")).toBe("APPROVED ALWAYS");
	});

	it("returns correct label for approved_session", () => {
		expect(approvedLabel("approved_session")).toBe("APPROVED FOR SESSION");
	});

	it("returns correct label for approved", () => {
		expect(approvedLabel("approved")).toBe("APPROVED");
	});

	it("returns null for denied", () => {
		expect(approvedLabel("denied")).toBeNull();
	});

	it("returns null for unknown string", () => {
		expect(approvedLabel("something_else")).toBeNull();
	});
});

// ── mapMcpServer ──────────────────────────────────────────────────────────────

describe("mapMcpServer", () => {
	it("maps required fields", () => {
		const result = mapMcpServer({ name: "my-server", status: "connected" });
		expect(result.name).toBe("my-server");
		expect(result.status).toBe("connected");
	});

	it("passes through optional scope and error", () => {
		const result = mapMcpServer({
			name: "bad-server",
			status: "failed",
			scope: "project",
			error: "connection refused",
		});
		expect(result.scope).toBe("project");
		expect(result.error).toBe("connection refused");
	});

	it("returns undefined scope and error when not provided", () => {
		const result = mapMcpServer({ name: "x", status: "pending" });
		expect(result.scope).toBeUndefined();
		expect(result.error).toBeUndefined();
	});

	it("handles all status values", () => {
		const statuses = [
			"connected",
			"failed",
			"needs-auth",
			"pending",
			"disabled",
		] as const;
		for (const status of statuses) {
			expect(mapMcpServer({ name: "s", status }).status).toBe(status);
		}
	});
});
