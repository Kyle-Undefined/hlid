// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
	applyThemeToDocument,
	builtInThemePalette,
	effectiveTheme,
} from "./theme";

afterEach(() => {
	document.documentElement.removeAttribute("style");
	document.documentElement.removeAttribute("class");
	document.documentElement.removeAttribute("data-theme");
});

describe("custom themes", () => {
	it("applies and then clears custom properties when returning to a built-in", () => {
		const palette = builtInThemePalette("tan");
		palette.primary = "#123456";
		palette.cache_write = "#654321";
		applyThemeToDocument("custom", palette);

		expect(document.documentElement.dataset.theme).toBe("custom");
		expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
			"#123456",
		);
		expect(document.documentElement.style.colorScheme).toBe("light");
		expect(
			document.documentElement.style.getPropertyValue("--cache-write"),
		).toBe("#654321");

		applyThemeToDocument("dark");
		expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
			"",
		);
		expect(
			document.documentElement.style.getPropertyValue("--cache-write"),
		).toBe("");
		expect(document.documentElement.classList.contains("dark")).toBe(true);
	});

	it("uses the separate mobile custom palette only for its override", () => {
		const desktop = builtInThemePalette("dark");
		const mobile = builtInThemePalette("tan");
		const ui = {
			theme: "custom" as const,
			mobileTheme: "custom" as const,
			customTheme: desktop,
			mobileCustomTheme: mobile,
		};
		expect(effectiveTheme(ui, false).palette).toBe(desktop);
		expect(effectiveTheme(ui, true).palette).toBe(mobile);
	});
});
