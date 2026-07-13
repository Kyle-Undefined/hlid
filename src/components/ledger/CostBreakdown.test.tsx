// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StatBundle } from "#/components/ledger/LedgerStats";
import { CostBreakdown } from "./CostBreakdown";

afterEach(cleanup);

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** Typical session with healthy cache utilisation. */
const populated: StatBundle = {
	cost: 0.5,
	queries: 10,
	turns: 25,
	input_tokens: 100_000,
	output_tokens: 20_000,
	cache_read_tokens: 200_000,
	cache_creation_tokens: 30_000,
};

// totalTokens = 350_000
// inputPct    = 100k/350k*100 = 28.57 → "29"
// outputPct   = 20k/350k*100  =  5.71 → "6"
// readPct     = 200k/350k*100 = 57.14 → "57"
// writePct    = 30k/350k*100  =  8.57 → "9"
// hitRate     = 200k/(100k+200k+30k)*100 = 60.6%
// avgCost     = $0.5/10 = $0.0500
// avgTokens   = round(350k/10) = 35k → "35.0k"
// out/in      = 20k/100k = 0.20 → "0.20×"

/** No data yet — all zeroes. */
const empty: StatBundle = {
	cost: 0,
	queries: 0,
	turns: 0,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
};

// ─── CostBreakdown ────────────────────────────────────────────────────────────

describe("CostBreakdown", () => {
	// ── renders without error ──────────────────────────────────────────────────

	it("renders with populated data", () => {
		render(<CostBreakdown s={populated} />);
		expect(screen.getByText(/cost breakdown/i)).toBeDefined();
	});

	it("renders with all-zero data", () => {
		render(<CostBreakdown s={empty} />);
		expect(screen.getByText(/cost breakdown/i)).toBeDefined();
	});

	// ── section headers ────────────────────────────────────────────────────────

	it("shows Token Composition section header", () => {
		render(<CostBreakdown s={populated} />);
		expect(screen.getByText(/token composition/i)).toBeDefined();
	});

	it("shows Cache Impact section header", () => {
		render(<CostBreakdown s={populated} />);
		expect(screen.getByText(/cache impact/i)).toBeDefined();
	});

	it("shows Per-Query Efficiency section header", () => {
		render(<CostBreakdown s={populated} />);
		expect(screen.getByText(/per-query efficiency/i)).toBeDefined();
	});

	// ── token composition legend ───────────────────────────────────────────────

	it("renders all four legend labels", () => {
		render(<CostBreakdown s={populated} />);
		expect(screen.getByText(/^input$/i)).toBeDefined();
		expect(screen.getByText(/^output$/i)).toBeDefined();
		expect(screen.getByText(/^cache read$/i)).toBeDefined();
		expect(screen.getByText(/^cache write$/i)).toBeDefined();
	});

	it("shows correct token composition percentages", () => {
		render(<CostBreakdown s={populated} />);
		// inputPct=29%, outputPct=6%, readPct=57%, writePct=9%
		expect(screen.getByText("29%")).toBeDefined();
		expect(screen.getByText("6%")).toBeDefined();
		expect(screen.getByText("57%")).toBeDefined();
		expect(screen.getByText("9%")).toBeDefined();
	});

	it("shows -- for legend percentages when no tokens", () => {
		render(<CostBreakdown s={empty} />);
		const dashes = screen.getAllByText("--");
		// 4 legend items + 3 efficiency rows = at least 4 dashes
		expect(dashes.length).toBeGreaterThanOrEqual(4);
	});

	// ── stacked bar ────────────────────────────────────────────────────────────

	it("renders stacked bar with aria-label when tokens exist", () => {
		render(<CostBreakdown s={populated} />);
		expect(
			screen.getByRole("img", { name: /token composition bar/i }),
		).toBeDefined();
	});

	it("does not render stacked bar role when no tokens", () => {
		render(<CostBreakdown s={empty} />);
		expect(
			screen.queryByRole("img", { name: /token composition bar/i }),
		).toBeNull();
	});

	// ── cache impact ───────────────────────────────────────────────────────────

	it("shows cache hit rate row", () => {
		render(<CostBreakdown s={populated} />);
		expect(screen.getByText(/cache hit rate/i)).toBeDefined();
		expect(screen.getByText("60.6%")).toBeDefined();
	});

	it("shows 0% cache hit rate when no tokens at all", () => {
		render(<CostBreakdown s={empty} />);
		// cacheHitPct returns "0" when total is zero → renders as "0%"
		expect(screen.getByText("0%")).toBeDefined();
	});

	it("shows tokens-from-cache row with formatted value", () => {
		render(<CostBreakdown s={populated} />);
		expect(screen.getByText(/tokens from cache/i)).toBeDefined();
		// fmt(200_000) = "200.0k"
		expect(screen.getByText("200.0k")).toBeDefined();
	});

	it("shows tokens-written-to-cache row with formatted value", () => {
		render(<CostBreakdown s={populated} />);
		expect(screen.getByText(/tokens written to cache/i)).toBeDefined();
		// fmt(30_000) = "30.0k"
		expect(screen.getByText("30.0k")).toBeDefined();
	});

	// ── per-query efficiency ───────────────────────────────────────────────────

	it("shows avg cost per query", () => {
		render(<CostBreakdown s={populated} />);
		expect(screen.getByText(/avg cost \/ query/i)).toBeDefined();
		// $0.5 / 10 = $0.0500
		expect(screen.getByText("$0.0500")).toBeDefined();
	});

	it("shows avg tokens per query", () => {
		render(<CostBreakdown s={populated} />);
		expect(screen.getByText(/avg tokens \/ query/i)).toBeDefined();
		// round(350k/10) = 35k → fmt = "35.0k"
		expect(screen.getByText("35.0k")).toBeDefined();
	});

	it("shows output/input ratio", () => {
		render(<CostBreakdown s={populated} />);
		expect(screen.getByText(/output \/ input ratio/i)).toBeDefined();
		// 20k/100k = 0.20
		expect(screen.getByText("0.20×")).toBeDefined();
	});

	it("shows -- for efficiency metrics when queries is zero", () => {
		render(<CostBreakdown s={empty} />);
		// avg cost/query and avg tokens/query → "--"; ratio → "--" (input=0)
		const dashes = screen.getAllByText("--");
		expect(dashes.length).toBeGreaterThanOrEqual(3);
	});

	it("shows -- for ratio when input_tokens is zero", () => {
		const noInput: StatBundle = { ...empty, queries: 5, cost: 0.1, turns: 5 };
		render(<CostBreakdown s={noInput} />);
		// output_tokens=0, input_tokens=0 → ratio "--"
		const dashes = screen.getAllByText("--");
		expect(dashes.length).toBeGreaterThan(0);
	});
});
