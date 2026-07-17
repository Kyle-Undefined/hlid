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

	it("shows counts, error rates, and an explained color legend", () => {
		render(<TopToolsChart data={data} />);
		expect(screen.getByText("Total calls")).toBeTruthy();
		expect(screen.getByText("Errors")).toBeTruthy();
		expect(screen.getByText(/10 calls/)).toBeTruthy();
		expect(screen.getByText(/2 errors \(20.0%\)/)).toBeTruthy();
	});

	it("clicking an errored bar opens the error modal with cleaned text", async () => {
		vi.mocked(getToolErrorsFn).mockResolvedValue([
			{ count: 3, text: "<tool_use_error> boom </tool_use_error>" },
		] as never);
		render(<TopToolsChart data={data} />);
		fireEvent.click(screen.getByRole("button", { name: /create_issue/i }));
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
		fireEvent.click(screen.getByRole("button", { name: /bash/i }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
