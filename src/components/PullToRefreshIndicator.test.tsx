// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { THRESHOLD } from "#/hooks/usePullToRefresh";
import { PullToRefreshIndicator } from "./PullToRefreshIndicator";

afterEach(cleanup);

describe("PullToRefreshIndicator", () => {
	it("renders nothing when idle", () => {
		const { container } = render(
			<PullToRefreshIndicator pullY={0} isRefreshing={false} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("shows Pull below the threshold", () => {
		render(
			<PullToRefreshIndicator pullY={THRESHOLD / 2} isRefreshing={false} />,
		);
		expect(screen.getByText("Pull")).toBeTruthy();
	});

	it("shows Release at the threshold", () => {
		render(<PullToRefreshIndicator pullY={THRESHOLD} isRefreshing={false} />);
		expect(screen.getByText("Release")).toBeTruthy();
	});

	it("shows a spinner while refreshing", () => {
		render(<PullToRefreshIndicator pullY={0} isRefreshing={true} />);
		expect(screen.getByText("Refreshing")).toBeTruthy();
	});
});
