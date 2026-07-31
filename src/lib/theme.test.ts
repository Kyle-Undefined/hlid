// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyThemeToDocument,
	builtInThemePalette,
	effectiveTheme,
	themeBootstrapConfig,
	themeBootstrapScript,
} from "./theme";

afterEach(() => {
	localStorage.clear();
	vi.unstubAllGlobals();
	document.documentElement.removeAttribute("style");
	document.documentElement.removeAttribute("class");
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.removeAttribute("data-theme-appearance");
});

describe("custom themes", () => {
	it("applies and then clears custom properties when returning to a built-in", () => {
		const palette = builtInThemePalette("tan");
		palette.primary = "#123456";
		palette.cache_write = "#654321";
		palette.status_info = "#abcdef";
		applyThemeToDocument("custom", palette);

		expect(document.documentElement.dataset.theme).toBe("custom");
		expect(document.documentElement.dataset.themeAppearance).toBe("light");
		expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
			"#123456",
		);
		expect(document.documentElement.style.colorScheme).toBe("light");
		expect(
			document.documentElement.style.getPropertyValue("--cache-write"),
		).toBe("#654321");
		expect(
			document.documentElement.style.getPropertyValue("--status-info"),
		).toBe("#abcdef");

		applyThemeToDocument("dark");
		expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
			"",
		);
		expect(
			document.documentElement.style.getPropertyValue("--cache-write"),
		).toBe("");
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(document.documentElement.dataset.themeAppearance).toBe("dark");
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

function runThemeBootstrap(
	config: Parameters<typeof themeBootstrapScript>[0],
	coarsePointer = false,
): void {
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: coarsePointer,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	);
	// biome-ignore lint/security/noGlobalEval: executes only the schema-generated bootstrap in isolated jsdom
	window.eval(themeBootstrapScript(config));
}

describe("theme bootstrap", () => {
	it("maps configured desktop and mobile themes into loader data", () => {
		const customTheme = builtInThemePalette("dark");
		const mobileCustomTheme = builtInThemePalette("tan");

		expect(
			themeBootstrapConfig({
				theme: "custom",
				mobile_theme: "custom",
				custom_theme: customTheme,
				mobile_custom_theme: mobileCustomTheme,
			}),
		).toEqual({
			theme: "custom",
			mobileTheme: "custom",
			customTheme,
			mobileCustomTheme,
		});
	});

	it("starts a fresh desktop origin on the configured theme", () => {
		runThemeBootstrap({ theme: "dark", mobileTheme: "tan" });

		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(document.documentElement.dataset.themeAppearance).toBe("dark");
		expect(document.documentElement.className).toBe("dark");
	});

	it("starts a fresh coarse-pointer origin on its configured mobile theme", () => {
		runThemeBootstrap({ theme: "dark", mobileTheme: "tan" }, true);

		expect(document.documentElement.dataset.theme).toBe("tan");
		expect(document.documentElement.dataset.themeAppearance).toBe("light");
		expect(document.documentElement.className).toBe("tan");
	});

	it("applies the configured mobile custom palette before first paint", () => {
		const desktop = builtInThemePalette("dark");
		const mobile = builtInThemePalette("tan");
		mobile.primary = "#123456";

		runThemeBootstrap(
			{
				theme: "custom",
				mobileTheme: "custom",
				customTheme: desktop,
				mobileCustomTheme: mobile,
			},
			true,
		);

		expect(document.documentElement.dataset.theme).toBe("custom");
		expect(document.documentElement.dataset.themeAppearance).toBe("light");
		expect(document.documentElement.style.colorScheme).toBe("light");
		expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
			"#123456",
		);
		expect(localStorage.getItem("hlid-theme")).toBe("custom");
		expect(
			JSON.parse(localStorage.getItem("hlid-theme-palette") ?? "{}"),
		).toEqual(mobile);
	});

	it("replaces a stale browser cache with authoritative mobile config", () => {
		const stalePalette = builtInThemePalette("dark");
		stalePalette.primary = "#654321";
		localStorage.setItem("hlid-theme", "custom");
		localStorage.setItem("hlid-theme-palette", JSON.stringify(stalePalette));

		runThemeBootstrap({ theme: "dark", mobileTheme: "tan" }, true);

		expect(document.documentElement.dataset.theme).toBe("tan");
		expect(document.documentElement.dataset.themeAppearance).toBe("light");
		expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
			"",
		);
		expect(localStorage.getItem("hlid-theme")).toBe("tan");
		expect(localStorage.getItem("hlid-theme-palette")).toBeNull();
	});
});
