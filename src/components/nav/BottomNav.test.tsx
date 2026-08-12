// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		search,
		children,
		...props
	}: {
		to: string;
		search?: { session?: string; agent?: string };
		children: React.ReactNode;
		"aria-label"?: string;
		title?: string;
	}) => (
		<a
			aria-label={props["aria-label"]}
			title={props.title}
			href={
				search?.session
					? `${to}?session=${search.session}${search.agent ? `&agent=${search.agent}` : ""}`
					: to
			}
		>
			{children}
		</a>
	),
}));

vi.mock("./SystemStatusDot", () => ({
	WsStatusDot: () => <span data-testid="system-status" />,
}));

import { rememberRavenSessionId } from "#/hooks/ravenSessionStore";
import { resolveNavigationLabels } from "#/lib/navigationNames";
import { BottomNav } from "./BottomNav";
import { NavigationNamesProvider } from "./NavigationNamesContext";

afterEach(cleanup);

describe("BottomNav", () => {
	it("keeps the mobile bar focused on the seven navigation destinations", () => {
		render(<BottomNav />);
		const nav = screen.getByRole("navigation", {
			name: "Primary navigation",
		});

		expect(within(nav).getAllByRole("link")).toHaveLength(7);
		expect(within(nav).queryByRole("button", { name: /lock/i })).toBeNull();
		expect(
			within(
				screen.getByRole("link", { name: "HOME, Hlið name: WATCH" }),
			).getByTestId("system-status"),
		).not.toBeNull();
	});

	it("links Raven to the last chat Raven displayed", () => {
		rememberRavenSessionId("third-of-five", "/selected-project");
		render(<BottomNav />);

		expect(
			screen
				.getByRole("link", { name: "CHAT, Hlið name: RAVEN" })
				.getAttribute("href"),
		).toBe("/raven?session=third-of-five&agent=/selected-project");
	});

	it("changes visible names without changing routes and keeps Hlið context", () => {
		const navigationLabels = resolveNavigationLabels({
			preset: "plain",
			labels: { einherjar: "Workspace" },
		});
		render(
			<NavigationNamesProvider initialLabels={navigationLabels}>
				<BottomNav />
			</NavigationNamesProvider>,
		);

		const home = screen.getByRole("link", {
			name: "HOME, Hlið name: WATCH",
		});
		expect(home.getAttribute("href")).toBe("/");
		expect(home.getAttribute("title")).toBe("HOME · Hlið: WATCH");

		const workspace = screen.getByRole("link", {
			name: "Workspace, Hlið name: EINHERJAR",
		});
		expect(workspace.getAttribute("href")).toBe("/einherjar");
	});
});
