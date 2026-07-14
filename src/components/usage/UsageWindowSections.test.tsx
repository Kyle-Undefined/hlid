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
