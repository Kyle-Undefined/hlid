// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
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

	it("ignores an older refresh that resolves after the post-done totals", async () => {
		const stale = Promise.withResolvers<ProviderUsageSnapshot[]>();
		const fresh = Promise.withResolvers<ProviderUsageSnapshot[]>();
		const withWindow = (queries: number, cost: number) =>
			[
				{
					providerId: "claude",
					providerLabel: "Claude",
					windows: [
						{
							windowId: "five_hour",
							label: "5-HOUR",
							windowSecs: 18_000,
							utilization: 0.55,
							remaining: null,
							limit: null,
							resetsAt: null,
							cost,
							queries,
							tokens: 0,
							sessions: queries > 0 ? 1 : 0,
						},
					],
				},
			] satisfies ProviderUsageSnapshot[];
		const fetchFn = vi
			.fn<() => Promise<ProviderUsageSnapshot[]>>()
			.mockReturnValueOnce(stale.promise)
			.mockReturnValueOnce(fresh.promise);
		const rateLimit = {
			type: "rate_limit" as const,
			status: "allowed",
			providerId: "claude",
			rateLimitType: "five_hour",
			utilization: 0.55,
		};
		const view = render(
			<ProviderUsageStrip
				initial={withWindow(0, 0)}
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={fetchFn}
			/>,
		);

		view.rerender(
			<ProviderUsageStrip
				initial={withWindow(0, 0)}
				liveQueryCount={0}
				rateLimit={rateLimit}
				fetchFn={fetchFn}
			/>,
		);
		view.rerender(
			<ProviderUsageStrip
				initial={withWindow(0, 0)}
				liveQueryCount={1}
				rateLimit={rateLimit}
				fetchFn={fetchFn}
			/>,
		);

		await act(async () => fresh.resolve(withWindow(3, 17.24)));
		expect(screen.getByText("3 queries")).not.toBeNull();
		expect(screen.getByText("~$17.24")).not.toBeNull();

		await act(async () => stale.resolve(withWindow(0, 0)));
		expect(screen.getByText("3 queries")).not.toBeNull();
		expect(screen.queryByText("0 queries")).toBeNull();
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
