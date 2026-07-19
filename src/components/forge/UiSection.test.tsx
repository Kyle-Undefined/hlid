// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInThemePalette } from "#/lib/theme";
import { type UiForm, UiSection } from "./UiSection";

afterEach(cleanup);

function uiForm(showProviderEntries: boolean): UiForm {
	return {
		theme: "tan",
		mobileTheme: "same",
		customTheme: builtInThemePalette("tan"),
		mobileCustomTheme: builtInThemePalette("tan"),
		enterToSubmit: true,
		hideSkillsIndex: true,
		showProviderEntries,
		htmlPlans: false,
	};
}

describe("UiSection provider skills preference", () => {
	it("shows the persisted state and emits a toggle patch", () => {
		const onChange = vi.fn();
		render(<UiSection ui={uiForm(false)} onChange={onChange} />);
		const toggle = screen.getByLabelText(
			"Show provider entries in slash picker",
		);

		expect((toggle as HTMLInputElement).checked).toBe(false);
		fireEvent.click(toggle);
		expect(onChange).toHaveBeenCalledWith({ showProviderEntries: true });
	});
});
