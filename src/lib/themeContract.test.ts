import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_COLOR_KEYS } from "./theme";
import { semanticStatusClass, themeSurfaceClass } from "./themeClasses";

function source(relativePath: string): string {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

describe("theme contract", () => {
	it("defines every exposed palette color in CSS", () => {
		const css = source("styles.css");
		for (const key of THEME_COLOR_KEYS) {
			expect(css).toContain(`--${key.replaceAll("_", "-")}`);
		}
	});

	it("uses appearance rather than a built-in theme name for light and dark behavior", () => {
		const css = source("styles.css");
		expect(css).toContain(
			'@custom-variant dark (&:is([data-theme-appearance="dark"] *));',
		);
		expect(css).toContain('html[data-theme-appearance="light"] .hljs-comment');
		expect(css).toContain(
			'html[data-theme-appearance="light"] .markdown-alert-note',
		);
		expect(css).not.toContain('html[data-theme="tan"] .hljs-');
		expect(css).not.toContain('html[data-theme="tan"] .markdown-alert-');
	});

	it("keeps paired surface and semantic roles in shared contracts", () => {
		expect(themeSurfaceClass).toMatchObject({
			card: expect.stringContaining("text-card-foreground"),
			popover: expect.stringContaining("text-popover-foreground"),
			secondary: expect.stringContaining("text-secondary-foreground"),
			input: expect.stringContaining("bg-input"),
			sidebar: expect.stringContaining("text-sidebar-foreground"),
			accentAction: expect.stringContaining("text-accent-foreground"),
			sidebarAction: expect.stringContaining("ring-sidebar-ring"),
		});
		expect(semanticStatusClass.success.dot).toBe("bg-status-success");
		expect(semanticStatusClass.warning.dot).toBe("bg-status-warning");
		expect(semanticStatusClass.info.dot).toBe("bg-status-info");
		expect(semanticStatusClass.danger.dot).toBe("bg-destructive");
		expect(semanticStatusClass.running.dot).toBe("bg-primary");
	});

	it("connects the shared contracts to representative application surfaces", () => {
		expect(source("components/shell/Section.tsx")).toContain(
			"themeSurfaceClass.card",
		);
		expect(source("components/chat/LiveSessionSwitcher.tsx")).toContain(
			"themeSurfaceClass.popover",
		);
		expect(source("components/forge/fields.tsx")).toContain(
			"themeSurfaceClass.input",
		);
		expect(source("components/nav/Sidebar.tsx")).toContain(
			"themeSurfaceClass.sidebar",
		);
	});
});
