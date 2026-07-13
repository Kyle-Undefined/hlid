// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsageSnapshot } from "#/db";
import { ProviderUsageStrip } from "./ProviderUsageStrip";

const initial: ProviderUsageSnapshot[] = [
	{
		providerId: "claude",
		providerLabel: "Claude",
		windows: [],
	},
];

function setVisibility(state: DocumentVisibilityState): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: state,
	});
}

function renderStrip(fetchFn = vi.fn().mockResolvedValue(initial)) {
	render(
		<ProviderUsageStrip
			initial={initial}
			liveQueryCount={0}
			rateLimit={null}
			fetchFn={fetchFn}
		/>,
	);
	return fetchFn;
}

beforeEach(() => {
	vi.useFakeTimers();
	setVisibility("visible");
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("ProviderUsageStrip polling", () => {
	it("marks Claude SDK cost as estimated", () => {
		const claudeWithUsage: ProviderUsageSnapshot[] = [
			{
				providerId: "claude",
				providerLabel: "Claude",
				windows: [
					{
						windowId: "five-hour",
						label: "5 HOUR",
						windowSecs: 18_000,
						utilization: 0.25,
						remaining: null,
						limit: null,
						resetsAt: null,
						cost: 7.6,
						queries: 4,
						tokens: 100,
						sessions: 1,
					},
				],
			},
		];
		render(
			<ProviderUsageStrip
				initial={claudeWithUsage}
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={vi.fn().mockResolvedValue(claudeWithUsage)}
			/>,
		);

		expect(screen.getByText("~$7.60")).not.toBeNull();
	});

	it("refreshes authoritative totals when a live window reading arrives", () => {
		const fetchFn = vi.fn().mockResolvedValue(initial);
		const view = render(
			<ProviderUsageStrip
				initial={initial}
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={fetchFn}
			/>,
		);

		view.rerender(
			<ProviderUsageStrip
				initial={initial}
				liveQueryCount={0}
				rateLimit={{
					type: "rate_limit",
					status: "allowed",
					providerId: "claude",
					rateLimitType: "five_hour",
					utilization: 0.2,
				}}
				fetchFn={fetchFn}
			/>,
		);

		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("refreshes every minute while the page is visible", () => {
		const fetchFn = renderStrip();

		vi.advanceTimersByTime(120_000);

		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("stops while hidden and refreshes immediately when visible again", () => {
		const fetchFn = renderStrip();

		setVisibility("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
		vi.advanceTimersByTime(180_000);
		expect(fetchFn).not.toHaveBeenCalled();

		setVisibility("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		expect(fetchFn).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(60_000);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("does not start an interval when initially hidden", () => {
		setVisibility("hidden");
		const fetchFn = renderStrip();

		vi.advanceTimersByTime(180_000);

		expect(fetchFn).not.toHaveBeenCalled();
	});
});
