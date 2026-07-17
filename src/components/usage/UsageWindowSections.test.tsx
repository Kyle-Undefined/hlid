// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderWindowEntry } from "#/db";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import {
	ContextWindowSection,
	ProviderWindowCell,
	RoutinesWindowSection,
} from "./UsageWindowSections";

afterEach(cleanup);

function stats(contextUsed?: number, contextWindow?: number): LiveStats {
	return {
		last_context_used: contextUsed ?? null,
		context_window: contextWindow ?? null,
	} as LiveStats;
}

describe("UsageWindowSections", () => {
	it("renders empty and populated context states", () => {
		const { rerender, container } = render(
			<ContextWindowSection stats={stats()} />,
		);
		expect(screen.getByText("no active context")).not.toBeNull();

		rerender(<ContextWindowSection stats={stats(70, 100)} />);
		expect(screen.getByText("70%")).not.toBeNull();
		expect(
			Array.from(container.querySelectorAll("div")).some((element) =>
				element.classList.contains("bg-yellow-600/60"),
			),
		).toBe(true);

		rerender(<ContextWindowSection stats={stats(120, 100)} />);
		expect(screen.getByText("100%")).not.toBeNull();
		expect(
			Array.from(container.querySelectorAll("div")).some((element) =>
				element.classList.contains("bg-destructive/60"),
			),
		).toBe(true);
	});

	it("keeps mobile context counts compact after the UI text-size floor", () => {
		render(<ContextWindowSection stats={stats(118_528, 258_400)} />);

		const count = screen.getByTitle("118,528 / 258,400");
		expect(count.className).toContain("whitespace-nowrap");
		expect(count.className).toContain("tracking-normal");
		expect(count.className).not.toContain("truncate");
		expect(screen.getByText("119k / 258k").className).toContain("md:hidden");
		expect(screen.getByText("118,528 / 258,400").className).toContain(
			"hidden md:inline",
		);
	});

	it("promotes mobile token counts through billion boundaries", () => {
		render(
			<ContextWindowSection stats={stats(1_157_300_000, 2_000_000_000)} />,
		);

		expect(screen.getByText("1.2B / 2B").className).toContain("md:hidden");
	});

	it("renders routines and provider usage details", () => {
		const win = {
			windowId: "five-hour",
			label: "5 HOUR",
			windowSecs: 18_000,
			utilization: 0.25,
			remaining: null,
			limit: null,
			resetsAt: Math.floor(Date.now() / 1000) + 3600,
			cost: 1.5,
			queries: 4,
			tokens: 100,
			sessions: 1,
		} satisfies ProviderWindowEntry;
		render(
			<>
				<RoutinesWindowSection />
				<ProviderWindowCell win={win} />
			</>,
		);
		expect(screen.getByText("no routines configured")).not.toBeNull();
		expect(screen.getByText("5 HOUR")).not.toBeNull();
		expect(screen.getByText("$1.50")).not.toBeNull();
		expect(screen.getByText("4q")).not.toBeNull();
	});
});
