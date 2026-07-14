// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/components/cockpit/CockpitSidebar", () => ({
	UtilBar: ({ value, max }: { value: number; max: number }) => (
		<div data-testid="util-bar">
			{value}/{max}
		</div>
	),
}));

import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import { MobileContextBand } from "./MobileContextBand";

afterEach(cleanup);

function makeStats(overrides?: Partial<LiveStats>): LiveStats {
	return {
		last_context_used: 50_000,
		context_window: 200_000,
		...overrides,
	} as LiveStats;
}

describe("MobileContextBand", () => {
	it("renders nothing without context data", () => {
		const { container } = render(
			<MobileContextBand
				stats={makeStats({ last_context_used: null, context_window: null })}
			/>,
		);
		expect(container.firstChild).toBeNull();
	});

	it("shows utilization bar and percentage", () => {
		render(<MobileContextBand stats={makeStats()} />);
		expect(screen.getByTestId("util-bar").textContent).toBe("50000/200000");
		expect(screen.getByText("25%")).toBeTruthy();
	});

	it("caps the percentage at 100", () => {
		render(
			<MobileContextBand stats={makeStats({ last_context_used: 500_000 })} />,
		);
		expect(screen.getByText("100%")).toBeTruthy();
	});
});
