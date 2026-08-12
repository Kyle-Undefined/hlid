// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		children,
		className,
		...props
	}: {
		to: string;
		children: React.ReactNode;
		className?: string;
		"aria-label"?: string;
		title?: string;
	}) => (
		<a
			href={to}
			aria-label={props["aria-label"]}
			title={props.title}
			className={className}
		>
			{children}
		</a>
	),
}));

vi.mock("#/hooks/ravenSessionStore", () => ({
	useLastRavenSession: () => null,
}));

vi.mock("#/hooks/updateStore", () => ({
	fetchUpdateStatus: vi.fn(),
	getUpdateSnapshot: () => null,
	subscribeUpdateStatus: () => () => {},
}));

vi.mock("../auth/LockButton", () => ({
	LockButton: () => <button type="button">Lock</button>,
}));

vi.mock("./SystemStatusDot", () => ({
	useSystemStatusIndicator: () => ({
		attentionCount: 0,
		attentionTone: "idle",
		dotClass: "bg-status-success",
	}),
}));

import { resolveNavigationLabels } from "#/lib/navigationNames";
import { NavigationNamesProvider } from "./NavigationNamesContext";
import { Sidebar } from "./Sidebar";

afterEach(cleanup);

describe("Sidebar", () => {
	it("uses plain-language names by default", () => {
		render(<Sidebar />);
		const nav = screen.getByRole("navigation", { name: "Primary navigation" });

		expect(within(nav).getAllByRole("link")).toHaveLength(7);
		expect(
			within(nav).getByRole("link", {
				name: "AGENTS, Hlið name: EINHERJAR",
			}),
		).toBeTruthy();
	});

	it("shows resolved names while retaining canonical context and routes", () => {
		const navigationLabels = resolveNavigationLabels({
			preset: "plain",
			labels: { einherjar: "Workspace" },
		});
		render(
			<NavigationNamesProvider initialLabels={navigationLabels}>
				<Sidebar />
			</NavigationNamesProvider>,
		);

		const workspace = screen.getByRole("link", {
			name: "Workspace, Hlið name: EINHERJAR",
		});
		expect(workspace.getAttribute("href")).toBe("/einherjar");
		expect(workspace.getAttribute("title")).toBe("Workspace · Hlið: EINHERJAR");
		expect(workspace.className).toContain("focus-visible:ring-sidebar-ring");
	});
});
