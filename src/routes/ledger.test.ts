import { describe, expect, it } from "vitest";
import { parseLedgerSearch } from "./ledger";

describe("parseLedgerSearch", () => {
	it("defaults tab to 'stats' when not provided", () => {
		expect(parseLedgerSearch({})).toMatchObject({ tab: "stats" });
	});

	it("accepts 'sessions' tab", () => {
		expect(parseLedgerSearch({ tab: "sessions" })).toMatchObject({
			tab: "sessions",
		});
	});

	it("accepts 'stats' tab", () => {
		expect(parseLedgerSearch({ tab: "stats" })).toMatchObject({ tab: "stats" });
	});

	it("falls back to 'stats' for unknown tab values", () => {
		expect(parseLedgerSearch({ tab: "invalid" })).toMatchObject({
			tab: "stats",
		});
		expect(parseLedgerSearch({ tab: 42 })).toMatchObject({ tab: "stats" });
		expect(parseLedgerSearch({ tab: null })).toMatchObject({ tab: "stats" });
	});

	it("defaults page to 1 when not provided", () => {
		expect(parseLedgerSearch({})).toMatchObject({ page: 1 });
	});

	it("accepts numeric page values", () => {
		expect(parseLedgerSearch({ page: 3 })).toMatchObject({ page: 3 });
	});

	it("floors fractional page values", () => {
		expect(parseLedgerSearch({ page: 2.9 })).toMatchObject({ page: 2 });
	});

	it("clamps page to minimum 1", () => {
		expect(parseLedgerSearch({ page: 0 })).toMatchObject({ page: 1 });
		expect(parseLedgerSearch({ page: -5 })).toMatchObject({ page: 1 });
	});
});
