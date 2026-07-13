// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgeSettings } from "./ForgeSettings";

vi.mock("#/components/forge/SystemSection", () => ({
	SystemSection: ({ view }: { view?: string }) => (
		<div>System section: {view ?? "overview"}</div>
	),
}));

vi.mock("#/components/forge/UpdatesSection", () => ({
	UpdatesSection: () => <div>Updates section</div>,
}));

afterEach(cleanup);

describe("ForgeSettings search", () => {
	it("opens the matching category instead of only filtering the sidebar", async () => {
		render(
			<ForgeSettings
				initial={{} as never}
				state={
					{
						saving: false,
						error: null,
						savedMsg: null,
					} as never
				}
			/>,
		);

		expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
		fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
			target: { value: "shutdown" },
		});

		await waitFor(() =>
			expect(screen.getByRole("heading", { name: "Advanced" })).toBeTruthy(),
		);
		expect(screen.getByText("System section: advanced")).toBeTruthy();
	});
});
