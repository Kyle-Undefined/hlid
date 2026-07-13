// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cacheHitPct, type StatBundle, StatRows } from "./LedgerStats";

afterEach(cleanup);

function makeBundle(overrides?: Partial<StatBundle>): StatBundle {
	return {
		cost: 1.5,
		queries: 10,
		turns: 25,
		input_tokens: 1000,
		output_tokens: 500,
		cache_read_tokens: 3000,
		cache_creation_tokens: 1000,
		...overrides,
	};
}

describe("StatRows", () => {
	it("renders exact cost with averages and totals", () => {
		render(<StatRows s={makeBundle()} />);
		expect(screen.getByText("Cost")).toBeTruthy();
		expect(screen.getByText("Avg cost/query")).toBeTruthy();
		expect(screen.getByText("$0.1500")).toBeTruthy();
		expect(screen.getByText("2.5")).toBeTruthy();
		// 3000 cache read of 5000 total input-side tokens
		expect(screen.getByText("60.0%")).toBeTruthy();
	});

	it("labels estimated costs and prefixes the average with ~", () => {
		render(<StatRows s={makeBundle({ estimated_cost: 0.5 })} />);
		expect(screen.getByText("Cost (estimated)")).toBeTruthy();
		// both the cost row and the avg cost/query row carry the ~ prefix
		expect(screen.getAllByText(/^~\$/).length).toBeGreaterThanOrEqual(1);
	});

	it("labels partial costs when some queries are unpriced", () => {
		render(<StatRows s={makeBundle({ unpriced_queries: 4 })} />);
		expect(screen.getByText("Cost (partial)")).toBeTruthy();
	});

	it("falls back to -- when nothing is priced or queried", () => {
		render(
			<StatRows
				s={makeBundle({
					queries: 0,
					turns: 0,
				})}
			/>,
		);
		expect(screen.getAllByText("--")).toHaveLength(2);
	});
});

describe("cacheHitPct", () => {
	it("computes the cache read share of input-side tokens", () => {
		expect(cacheHitPct(1000, 3000, 1000)).toBe("60.0");
	});

	it("returns 0 when total is zero", () => {
		expect(cacheHitPct(0, 0, 0)).toBe("0");
	});
});
