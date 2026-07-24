// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AggStats } from "#/db";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import { DashboardHeader } from "./DashboardHeader";

afterEach(cleanup);

function makeStats(overrides?: Partial<LiveStats>): LiveStats {
	return {
		cost: 0.5,
		queries: 3,
		duration_ms: 4000,
		...overrides,
	} as LiveStats;
}

function makeAgg(): AggStats {
	return {
		today: { cost: 1.25, queries: 12, tokens: 40_000 },
		thisMonth: { cost: 20, queries: 300, tokens: 900_000 },
		allTime: {
			cost: 100,
			queries: 5000,
			turns: 15000,
			input_tokens: 1_000_000,
			output_tokens: 500_000,
			cache_read_tokens: 2_000_000,
			cache_creation_tokens: 500_000,
		},
	} as AggStats;
}

describe("DashboardHeader", () => {
	it("shows session cost with query count and duration when active", () => {
		render(<DashboardHeader stats={makeStats()} agg={makeAgg()} isConnected />);
		expect(screen.getByText("$0.5000")).toBeTruthy();
		expect(screen.getByText("3q · 4.0s")).toBeTruthy();
	});

	it("shows an in-flight estimate as active before the first query completes", () => {
		render(
			<DashboardHeader
				stats={makeStats({
					cost: 0,
					estimated_cost: 0,
					queries: 0,
					duration_ms: 0,
					pending_input_tokens: 100,
					pending_output_tokens: 20,
					pending_cache_read_tokens: 300,
					pending_cache_creation_tokens: 0,
					pending_estimated_cost: 0.0123,
				})}
				agg={makeAgg()}
				isConnected
			/>,
		);
		expect(screen.getByText("~$0.0123")).toBeTruthy();
		expect(screen.getByText("active")).toBeTruthy();
	});

	it("shows -- and idle when disconnected with no session cost", () => {
		render(
			<DashboardHeader
				stats={makeStats({ cost: 0, queries: 0, duration_ms: 0 })}
				agg={makeAgg()}
				isConnected={false}
			/>,
		);
		expect(screen.getByText("--")).toBeTruthy();
		expect(screen.getByText("idle")).toBeTruthy();
	});

	it("renders today, month, and all-time aggregates", () => {
		render(<DashboardHeader stats={makeStats()} agg={makeAgg()} isConnected />);
		expect(screen.getByText("$1.2500")).toBeTruthy();
		expect(screen.getByText("$20.0000")).toBeTruthy();
		expect(screen.getByText("$100.00")).toBeTruthy();
		// all-time token total across input/output/cache
		expect(screen.getByText("4.0M")).toBeTruthy();
	});
});
