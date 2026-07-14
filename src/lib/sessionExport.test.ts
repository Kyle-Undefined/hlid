import { describe, expect, it } from "vitest";
import type { SessionRow } from "#/db";
import { buildSessionExport, sessionsToCsv } from "./sessionExport";

const row: SessionRow = {
	id: "s-1",
	label: "plain label",
	model: "claude-opus-4-8",
	started_at: 1_700_000_000,
	ended_at: 1_700_000_100,
	query_count: 3,
	total_cost: 1.25,
	total_estimated_cost: 0,
	unpriced_query_count: 0,
	total_input_tokens: 100,
	total_output_tokens: 50,
	total_cache_read_tokens: 10,
	total_cache_creation_tokens: 5,
	total_turns: 4,
};

describe("sessionsToCsv", () => {
	it("emits a header plus one line per session", () => {
		const csv = sessionsToCsv([row]);
		const lines = csv.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0].startsWith("id,label,model,")).toBe(true);
		expect(lines[1].startsWith("s-1,plain label,claude-opus-4-8,")).toBe(true);
	});

	it("quotes fields containing commas, quotes, and newlines", () => {
		const tricky = { ...row, label: 'has, comma and "quote"\nnewline' };
		const csv = sessionsToCsv([tricky]);
		expect(csv).toContain('"has, comma and ""quote""\nnewline"');
	});

	it("renders null fields as empty", () => {
		const csv = sessionsToCsv([{ ...row, label: null, ended_at: null }]);
		expect(csv.split("\n")[1].startsWith("s-1,,claude-opus-4-8,")).toBe(true);
	});
});

describe("buildSessionExport", () => {
	it("builds csv exports with a dated filename", () => {
		const out = buildSessionExport([row], "csv");
		expect(out.mime).toBe("text/csv");
		expect(out.filename).toMatch(/^hlid-sessions-\d{4}-\d{2}-\d{2}\.csv$/);
		expect(out.content.split("\n")).toHaveLength(2);
	});

	it("builds json exports that round-trip", () => {
		const out = buildSessionExport([row], "json");
		expect(out.mime).toBe("application/json");
		expect(out.filename).toMatch(/\.json$/);
		expect(JSON.parse(out.content)).toEqual([row]);
	});
});
