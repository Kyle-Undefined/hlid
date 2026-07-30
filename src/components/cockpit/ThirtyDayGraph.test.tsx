// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThirtyDayStats } from "#/db";
import { ThirtyDayGraph } from "./ThirtyDayGraph";

afterEach(cleanup);

function stats(count = 1): ThirtyDayStats {
	const days = Array.from({ length: 30 }, (_, index) => ({
		date: `2026-07-${String(index + 1).padStart(2, "0")}`,
		count,
	}));
	return { days, total: count * days.length };
}

describe("ThirtyDayGraph", () => {
	it("renders a responsive native SVG series with the expected date ticks", () => {
		const { container } = render(<ThirtyDayGraph data={stats()} />);

		expect(
			screen.getByRole("img", { name: "Cumulative queries over 30 days" }),
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

	it("shows the nearest cumulative value while pointing at the graph", () => {
		render(<ThirtyDayGraph data={stats()} />);
		const graph = screen.getByRole("img", {
			name: "Cumulative queries over 30 days",
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
