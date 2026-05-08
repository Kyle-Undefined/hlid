import { describe, expect, it } from "vitest";
import { classifyStatus } from "./classify";

const vocab = {
	active: ["active", "in progress", "WIP"],
	planning: ["planning", "backlog", "proposed"],
	done: ["done", "complete", "shipped"],
};

describe("classifyStatus", () => {
	it("returns unknown for undefined input", () => {
		expect(classifyStatus(undefined, vocab)).toBe("unknown");
	});

	it("returns unknown for empty string", () => {
		expect(classifyStatus("", vocab)).toBe("unknown");
	});

	it("matches active vocab", () => {
		expect(classifyStatus("active", vocab)).toBe("active");
		expect(classifyStatus("in progress", vocab)).toBe("active");
		expect(classifyStatus("WIP", vocab)).toBe("active");
	});

	it("matches planning vocab", () => {
		expect(classifyStatus("planning", vocab)).toBe("planning");
		expect(classifyStatus("backlog", vocab)).toBe("planning");
	});

	it("matches done vocab", () => {
		expect(classifyStatus("done", vocab)).toBe("done");
		expect(classifyStatus("shipped", vocab)).toBe("done");
	});

	it("is case-insensitive", () => {
		expect(classifyStatus("ACTIVE", vocab)).toBe("active");
		expect(classifyStatus("Done", vocab)).toBe("done");
		expect(classifyStatus("PLANNING", vocab)).toBe("planning");
	});

	it("returns unknown for unrecognized value", () => {
		expect(classifyStatus("somerandombstatus", vocab)).toBe("unknown");
	});

	it("does not do partial matches", () => {
		// 'actives' should not match 'active'
		expect(classifyStatus("actives", vocab)).toBe("unknown");
	});
});
