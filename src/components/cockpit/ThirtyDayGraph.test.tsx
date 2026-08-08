// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThirtyDayStats } from "#/db";
import { ThirtyDayGraph } from "./ThirtyDayGraph";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function setMobileViewport(): void {
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockImplementation((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(() => true),
		})),
	);
}

function stats(
	count = 1,
	dayCount = 30,
	startDate = "2026-07-01",
): ThirtyDayStats {
	const start = Date.parse(`${startDate}T00:00:00Z`);
	const days = Array.from({ length: dayCount }, (_, index) => ({
		date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
		count,
	}));
	return { days, total: count * days.length };
}

describe("ThirtyDayGraph", () => {
	it("renders a responsive native SVG series with the expected date ticks", () => {
		const { container } = render(<ThirtyDayGraph data={stats()} />);

		expect(
			screen.getByRole("img", { name: "30D activity: cumulative queries" }),
		).toBeDefined();
		expect(container.querySelector('[data-series="running-total"]')).not.toBe(
			null,
		);
		expect(
			container.querySelector('[data-series="running-total-area"]'),
		).not.toBe(null);
		expect(screen.getByText("Jul 1")).toBeDefined();
		expect(screen.getByText("Jul 10")).toBeDefined();
		expect(screen.getByText("Jul 20")).toBeDefined();
		expect(screen.getByText("Jul 30")).toBeDefined();
		expect(screen.getByText("30 queries")).toBeDefined();
	});

	it("distributes all-time date ticks across the full series", () => {
		render(
			<ThirtyDayGraph
				data={stats(1, 91, "2026-02-03")}
				label="All-time query activity"
			/>,
		);

		expect(
			screen.getByRole("img", {
				name: "All-time query activity: cumulative queries",
			}),
		).toBeDefined();
		expect(screen.getByText("Feb 3")).toBeDefined();
		expect(screen.getByText("Mar 5")).toBeDefined();
		expect(screen.getByText("Apr 4")).toBeDefined();
		expect(screen.getByText("May 4")).toBeDefined();

		const ticks = ["Feb 3", "Mar 5", "Apr 4", "May 4"].map((date) =>
			screen.getByText(date),
		);
		for (const [index, expected] of [0, 100 / 3, 200 / 3, 100].entries()) {
			expect(Number.parseFloat(ticks[index].style.left)).toBeCloseTo(expected);
		}
		expect(ticks[0].style.transform).toBe("none");
		expect(ticks[1].style.transform).toBe("translateX(-50%)");
		expect(ticks[3].style.transform).toBe("translateX(-100%)");
	});

	it("uses three evenly distributed date ticks on mobile", () => {
		setMobileViewport();
		render(
			<ThirtyDayGraph
				data={stats(1, 91, "2026-02-03")}
				label="All-time query activity"
			/>,
		);

		const ticks = ["Feb 3", "Mar 20", "May 4"].map((date) =>
			screen.getByText(date),
		);
		expect(ticks.map((tick) => Number.parseFloat(tick.style.left))).toEqual([
			0, 50, 100,
		]);
		expect(ticks[0].style.transform).toBe("none");
		expect(ticks[1].style.transform).toBe("translateX(-50%)");
		expect(ticks[2].style.transform).toBe("translateX(-100%)");
	});

	it("includes the final date when the series has fewer than 30 days", () => {
		render(<ThirtyDayGraph data={stats(1, 7, "2026-08-01")} />);

		expect(screen.getByText("Aug 1")).toBeDefined();
		expect(screen.getByText("Aug 3")).toBeDefined();
		expect(screen.getByText("Aug 5")).toBeDefined();
		expect(screen.getByText("Aug 7")).toBeDefined();
	});

	it("anchors a single date without duplicating the tick", () => {
		render(<ThirtyDayGraph data={stats(1, 1, "2026-08-07")} />);

		const ticks = screen.getAllByText("Aug 7");
		expect(ticks).toHaveLength(1);
		expect(ticks[0].style.left).toBe("0%");
		expect(ticks[0].style.transform).toBe("none");
	});

	it("shows the nearest cumulative value while pointing at the graph", () => {
		render(<ThirtyDayGraph data={stats()} />);
		const graph = screen.getByRole("img", {
			name: "30D activity: cumulative queries",
		});
		vi.spyOn(graph, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			right: 100,
			bottom: 40,
			width: 100,
			height: 40,
			toJSON: () => ({}),
		});

		fireEvent.pointerMove(graph, { clientX: 50 });
		expect(screen.getByRole("tooltip").textContent).toBe("16");

		fireEvent.pointerLeave(graph);
		expect(screen.queryByRole("tooltip")).toBe(null);
	});

	it("renders an empty graph without a series path", () => {
		const { container } = render(
			<ThirtyDayGraph data={{ days: [], total: 0 }} />,
		);

		expect(container.querySelector('[data-series="running-total"]')).toBe(null);
		expect(screen.getByText("0 queries")).toBeDefined();
	});
});
