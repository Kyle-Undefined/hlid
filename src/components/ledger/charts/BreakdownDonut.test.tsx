// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	tooltipContent: null as
		| ((props: { active?: boolean; payload?: unknown[] }) => ReactNode)
		| null,
}));

vi.mock("recharts", () => ({
	ResponsiveContainer: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	PieChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Pie: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Cell: () => null,
	Tooltip: (props: {
		content: (p: { active?: boolean; payload?: unknown[] }) => ReactNode;
	}) => {
		captured.tooltipContent = props.content;
		return null;
	},
}));

import { BreakdownDonut } from "./BreakdownDonut";

afterEach(cleanup);

const rows = [
	{ key: "opus", label: "Opus", value: 75 },
	{ key: "sonnet", label: "Sonnet", value: 25 },
];

function renderDonut(
	overrides?: Partial<Parameters<typeof BreakdownDonut>[0]>,
) {
	return render(
		<BreakdownDonut
			title="Model split"
			subtitle="by tokens"
			height={180}
			emptyMessage="No data yet"
			innerRadius="60%"
			rows={rows}
			{...overrides}
		/>,
	);
}

describe("BreakdownDonut", () => {
	it("shows the empty message when there are no rows", () => {
		renderDonut({ rows: [] });
		expect(screen.getByText("No data yet")).toBeTruthy();
		expect(screen.queryByText("by tokens")).toBeNull();
	});

	it("treats all-zero rows as empty", () => {
		renderDonut({
			rows: [{ key: "a", label: "A", value: 0 }],
		});
		expect(screen.getByText("No data yet")).toBeTruthy();
	});

	it("renders the legend aside with percentages when data exists", () => {
		renderDonut();
		expect(screen.getByText("by tokens")).toBeTruthy();
		expect(screen.getByText("Opus")).toBeTruthy();
		expect(screen.getByText("Sonnet")).toBeTruthy();
	});

	it("tooltip shows label, formatted value, and share", () => {
		renderDonut({ formatTooltipValue: (v) => `${v} tok` });
		const content = captured.tooltipContent;
		if (!content) throw new Error("tooltip content not captured");
		cleanup();
		render(content({ active: true, payload: [{ payload: rows[0] }] }));
		expect(screen.getByText("Opus")).toBeTruthy();
		expect(screen.getByText("75 tok · 75.0%")).toBeTruthy();
		expect(content({ active: false, payload: [] })).toBeNull();
	});
});
