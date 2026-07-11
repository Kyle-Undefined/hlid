// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
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
