import { describe, expect, it } from "vitest";
import {
	agentListSchema,
	eventLogQuerySchema,
	sessionCleanupSchema,
	sessionDeleteSchema,
	sessionPageSchema,
	sessionRenameSchema,
	terminalSessionSchema,
} from "./serverFnSchemas";

describe("server function boundary schemas", () => {
	it("accepts the supported ledger page sizes", () => {
		for (const size of [10, 20, 50, 100]) {
			expect(sessionPageSchema.parse({ page: 1, size })).toEqual({
				page: 1,
				size,
			});
		}
	});

	it.each([
		undefined,
		null,
		"bad",
		{ page: 0, size: 20 },
		{ page: 1.5, size: 20 },
		{ page: 1, size: 25 },
		{ page: 1, size: Number.NaN },
	])("rejects malformed pagination: %j", (value) => {
		expect(sessionPageSchema.safeParse(value).success).toBe(false);
	});

	it("trims and bounds session mutation values", () => {
		expect(sessionDeleteSchema.parse({ id: "  session-1  " })).toEqual({
			id: "session-1",
		});
		expect(
			sessionRenameSchema.parse({ id: "s1", label: "  Better name  " }),
		).toEqual({ id: "s1", label: "Better name" });
		expect(sessionDeleteSchema.safeParse({ id: " " }).success).toBe(false);
		expect(
			sessionRenameSchema.safeParse({ id: "s1", label: "x".repeat(201) })
				.success,
		).toBe(false);
	});

	it("rejects invalid cleanup windows", () => {
		for (const days of [0, -1, 1.5, 36_501, Number.POSITIVE_INFINITY]) {
			expect(sessionCleanupSchema.safeParse({ days }).success).toBe(false);
		}
		expect(sessionCleanupSchema.parse({ days: 30 })).toEqual({ days: 30 });
	});

	it("validates terminal session creation", () => {
		expect(
			terminalSessionSchema.parse({
				id: "s1",
				label: "Terminal",
				model: "cli",
			}),
		).toEqual({ id: "s1", label: "Terminal", model: "cli" });
		for (const value of [
			{},
			{ id: "", label: "Terminal", model: "cli" },
			{ id: "s1", label: "", model: "cli" },
			{ id: "s1", label: "Terminal", model: "" },
		]) {
			expect(terminalSessionSchema.safeParse(value).success).toBe(false);
		}
	});

	it("accepts only bounded event-log queries", () => {
		expect(
			eventLogQuerySchema.parse({ page: 2, size: 50, level: "warn" }),
		).toEqual({ page: 2, size: 50, level: "warn" });
		expect(
			eventLogQuerySchema.safeParse({ page: 1, size: 101, level: "debug" })
				.success,
		).toBe(false);
	});

	it("validates persisted agent entries rather than trusting annotations", () => {
		const parsed = agentListSchema.parse([{ path: "  /tmp/agent  " }]);
		expect(parsed[0]).toMatchObject({
			path: "/tmp/agent",
			mode: "cwd",
			provider: "claude",
		});
		for (const value of [
			[{ path: "" }],
			[{ path: "/tmp/a", mode: "unknown" }],
			[{ path: "/tmp/a", max_turns: 0 }],
			"not-an-array",
		]) {
			expect(agentListSchema.safeParse(value).success).toBe(false);
		}
	});
});
