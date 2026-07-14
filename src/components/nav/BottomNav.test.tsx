// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
		<a href={to}>{children}</a>
	),
}));

vi.mock("./SystemStatusDot", () => ({
	WsStatusDot: () => <span data-testid="system-status" />,
}));

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
});
