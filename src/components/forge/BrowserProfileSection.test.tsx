// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserProfileSection } from "./BrowserProfileSection";

afterEach(cleanup);

describe("BrowserProfileSection", () => {
	it("defaults to an isolated profile without showing the sensitive-data warning", () => {
		render(
			<BrowserProfileSection
				value={{ useRealBrowserProfile: false }}
				onChange={vi.fn()}
			/>,
		);

		expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
			false,
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("warns about profile data and browser consent when enabled", () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<BrowserProfileSection
				value={{ useRealBrowserProfile: false }}
				onChange={onChange}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox"));
		expect(onChange).toHaveBeenCalledWith({ useRealBrowserProfile: true });

		rerender(
			<BrowserProfileSection
				value={{ useRealBrowserProfile: true }}
				onChange={onChange}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain("cookies");
		expect(screen.getByRole("alert").textContent).toContain(
			"chrome://inspect/#remote-debugging",
		);
	});
});
