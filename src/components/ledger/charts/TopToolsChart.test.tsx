// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/serverFns/stats", () => ({
	getToolErrorsFn: vi.fn(),
}));

import { getToolErrorsFn } from "#/lib/serverFns/stats";
import { TopToolsChart } from "./TopToolsChart";

afterEach(cleanup);

beforeEach(() => {
	vi.clearAllMocks();
});

const data = [
	{ name: "Bash", count: 40, errorCount: 0, errorRate: 0 },
	{
		name: "mcp__jira__create_issue",
		count: 10,
		errorCount: 2,
		errorRate: 0.2,
	},
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

	it("shows counts, error rates, and an explained color legend", () => {
		render(<TopToolsChart data={data} />);
		expect(screen.getByText("Total calls")).toBeTruthy();
		expect(screen.getByText("Errors")).toBeTruthy();
		expect(screen.getByText(/10 calls/)).toBeTruthy();
		expect(screen.getByText(/2 errors \(20.0%\)/)).toBeTruthy();
	});

	it("clicking an errored bar opens the error modal with cleaned text", async () => {
		vi.mocked(getToolErrorsFn).mockResolvedValue({
			total: 3,
			distinct: 1,
			groups: [{ count: 3, text: "<tool_use_error> boom </tool_use_error>" }],
		} as never);
		render(<TopToolsChart data={data} />);
		fireEvent.click(screen.getByRole("button", { name: /create_issue/i }));
		expect(
			await screen.findByRole("dialog", { name: /create_issue/ }),
		).toBeTruthy();
		expect(await screen.findByText("boom")).toBeTruthy();
		expect(screen.getByText("3×")).toBeTruthy();
		expect(screen.getByText("3 errors · 1 distinct message")).toBeTruthy();
		expect(getToolErrorsFn).toHaveBeenCalledWith({
			data: {
				toolName: "mcp__jira__create_issue",
				filter: { range: "all" },
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("ignores clicks on bars without errors", () => {
		render(<TopToolsChart data={data} />);
		fireEvent.click(screen.getByRole("button", { name: /bash/i }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("keeps the exact event total visible when messages are grouped", async () => {
		vi.mocked(getToolErrorsFn).mockResolvedValue({
			total: 11,
			distinct: 2,
			groups: [
				{ count: 10, text: "same failure" },
				{ count: 1, text: "" },
			],
		} as never);
		render(
			<TopToolsChart
				data={[{ name: "Bash", count: 20, errorCount: 11, errorRate: 0.55 }]}
				filter={{ range: "today", provider: "codex" }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /bash/i }));
		expect(
			await screen.findByText("11 errors · 2 distinct messages"),
		).toBeTruthy();
		expect(screen.getByText("10×")).toBeTruthy();
		expect(screen.getByText("No error details recorded.")).toBeTruthy();
		expect(getToolErrorsFn).toHaveBeenCalledWith({
			data: {
				toolName: "Bash",
				filter: { range: "today", provider: "codex" },
			},
		});
	});
});
