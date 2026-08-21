// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInThemePalette } from "#/lib/theme";
import { CustomThemeSection } from "./CustomThemeSection";
import type { UiForm } from "./UiSection";

afterEach(cleanup);

const ui: UiForm = {
	viewMode: "full",
	theme: "tan",
	mobileTheme: "same",
	customTheme: builtInThemePalette("tan"),
	mobileCustomTheme: builtInThemePalette("tan"),
	enterToSubmit: true,
	liveSessionsHotkey: "",
	hideSkillsIndex: true,
	showProviderEntries: false,
	htmlPlans: false,
	navigationNames: { preset: "hlid", labels: {} },
};

describe("CustomThemeSection responsive controls", () => {
	it("uses container width and keeps mobile actions comfortably tappable", () => {
		render(
			<CustomThemeSection
				ui={ui}
				onChange={vi.fn()}
				target="desktop"
				onTargetChange={vi.fn()}
			/>,
		);

		const tablist = screen.getByRole("tablist", {
			name: "Custom theme target",
		});
		expect(tablist.className).toContain("grid-cols-2");
		expect(tablist.className).toContain("@sm:inline-flex");
		expect(screen.getByRole("tab", { name: "desktop" }).className).toContain(
			"min-h-11",
		);
		expect(
			screen.getByRole("button", { name: "Copy active theme" }).className,
		).toContain("min-h-11");
		expect(screen.getByLabelText("Native control style").className).toContain(
			"w-full",
		);

		const colorGrid = screen
			.getByLabelText("Background color")
			.closest("div.grid");
		expect(colorGrid?.className).toContain("@lg:grid-cols-2");
		expect(screen.getByLabelText("Background hex").className).toContain(
			"min-h-11",
		);
	});
});
