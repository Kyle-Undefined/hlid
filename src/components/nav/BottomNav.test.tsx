// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		search,
		children,
	}: {
		to: string;
		search?: { session?: string; agent?: string };
		children: React.ReactNode;
	}) => (
		<a
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
import { BottomNav } from "./BottomNav";

afterEach(cleanup);

describe("BottomNav", () => {
	it("keeps the mobile bar focused on the seven navigation destinations", () => {
		render(<BottomNav />);
		const nav = screen.getByRole("navigation", {
			name: "Primary navigation",
		});

		expect(within(nav).getAllByRole("link")).toHaveLength(7);
		expect(within(nav).queryByRole("button", { name: /lock/i })).toBeNull();
	});

	it("links Raven to the last chat Raven displayed", () => {
		rememberRavenSessionId("third-of-five", "/selected-project");
		render(<BottomNav />);

		expect(
			screen.getByRole("link", { name: "RAVEN" }).getAttribute("href"),
		).toBe("/raven?session=third-of-five&agent=/selected-project");
	});
});
