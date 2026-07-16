// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	tooltipContent: null as
		| ((props: { active?: boolean; payload?: unknown[] }) => ReactNode)
		| null,
	barOnClick: null as ((data: unknown) => void) | null,
}));

vi.mock("recharts", () => ({
	ResponsiveContainer: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	BarChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Bar: (props: { children?: ReactNode; onClick: (d: unknown) => void }) => {
		captured.barOnClick = props.onClick;
		return <div>{props.children}</div>;
	},
	Cell: () => null,
	XAxis: () => null,
	YAxis: () => null,
	Tooltip: (props: {
		content: (p: { active?: boolean; payload?: unknown[] }) => ReactNode;
	}) => {
		captured.tooltipContent = props.content;
		return null;
	},
}));

vi.mock("#/lib/serverFns/stats", () => ({
	getToolErrorsFn: vi.fn(),
}));

import { getToolErrorsFn } from "#/lib/serverFns/stats";
import { TopToolsChart } from "./TopToolsChart";

afterEach(cleanup);

beforeEach(() => {
	vi.clearAllMocks();
	captured.tooltipContent = null;
	captured.barOnClick = null;
});

const data = [
	{ name: "Bash", count: 40, errorRate: 0 },
	{ name: "mcp__jira__create_issue", count: 10, errorRate: 0.2 },
];

describe("TopToolsChart", () => {
	it("shows the empty state without data", () => {
		render(<TopToolsChart data={[]} />);
		expect(screen.getByText("No tool events recorded")).toBeTruthy();
	});

	it("renders subtitle with tool count", () => {
		render(<TopToolsChart data={data} />);
		expect(screen.getByText("Top 2 by count")).toBeTruthy();
	});

	it("tooltip shows full name, calls, and error hint when errors exist", () => {
		render(<TopToolsChart data={data} />);
		const content = captured.tooltipContent;
		if (!content) throw new Error("tooltip content not captured");
		render(
			content({
				active: true,
				payload: [
					{
						payload: {
							name: "create_issue",
							fullName: "mcp__jira__create_issue",
							count: 10,
							errorRate: 0.2,
						},
					},
				],
			}),
		);
		expect(screen.getByText("mcp__jira__create_issue")).toBeTruthy();
		expect(screen.getByText("10 calls")).toBeTruthy();
		expect(screen.getByText("— click for details")).toBeTruthy();
		expect(content({ active: false })).toBeNull();
	});

	it("clicking an errored bar opens the error modal with cleaned text", async () => {
		vi.mocked(getToolErrorsFn).mockResolvedValue([
			{ count: 3, text: "<tool_use_error> boom </tool_use_error>" },
		] as never);
		render(<TopToolsChart data={data} />);
		if (!captured.barOnClick) throw new Error("bar onClick not captured");
		captured.barOnClick({
			name: "create_issue",
			fullName: "mcp__jira__create_issue",
			count: 10,
			errorRate: 0.2,
		});
		expect(
			await screen.findByRole("dialog", { name: /create_issue/ }),
		).toBeTruthy();
		expect(await screen.findByText("boom")).toBeTruthy();
		expect(screen.getByText("3×")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("ignores clicks on bars without errors", () => {
		render(<TopToolsChart data={data} />);
		captured.barOnClick?.({
			name: "Bash",
			fullName: "Bash",
			count: 40,
			errorRate: 0,
		});
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
