export const THEME_COLOR_KEYS = [
	"background",
	"foreground",
	"card",
	"card_foreground",
	"popover",
	"popover_foreground",
	"primary",
	"primary_foreground",
	"secondary",
	"secondary_foreground",
	"muted",
	"muted_foreground",
	"accent",
	"accent_foreground",
	"destructive",
	"destructive_foreground",
	"border",
	"input",
	"ring",
	"sidebar",
	"sidebar_foreground",
	"sidebar_primary",
	"sidebar_primary_foreground",
	"sidebar_accent",
	"sidebar_accent_foreground",
	"sidebar_border",
	"sidebar_ring",
	"data",
	"chart_error",
	"status_success",
	"status_warning",
	"tool_panel",
	"tool_panel_border",
	"user_msg",
	"agent_msg",
] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
export type CustomThemePalette = { color_scheme: "dark" | "light" } & Record<
	ThemeColorKey,
	string
>;
export type ThemeName = "dark" | "tan" | "custom";

export const DARK_THEME: CustomThemePalette = {
	color_scheme: "dark",
	background: "#0f0f12",
	foreground: "#dcdce4",
	card: "#151518",
	card_foreground: "#dcdce4",
	popover: "#131316",
	popover_foreground: "#dcdce4",
	primary: "#38bdf8",
	primary_foreground: "#071825",
	secondary: "#1a1a1e",
	secondary_foreground: "#dcdce4",
	muted: "#1a1a1e",
	muted_foreground: "#ccccda",
	accent: "#1e1e22",
	accent_foreground: "#d0d0d8",
	destructive: "#963232",
	destructive_foreground: "#d0d0d8",
	border: "#222226",
	input: "#1a1a1e",
	ring: "#38bdf8",
	sidebar: "#0b0b0e",
	sidebar_foreground: "#dcdce4",
	sidebar_primary: "#38bdf8",
	sidebar_primary_foreground: "#071825",
	sidebar_accent: "#1a1a1e",
	sidebar_accent_foreground: "#d0d0d8",
	sidebar_border: "#161618",
	sidebar_ring: "#38bdf8",
	data: "#38bdf8",
	chart_error: "#ef4444",
	status_success: "#22c55e",
	status_warning: "#f59e0b",
	tool_panel: "#071825",
	tool_panel_border: "#1a5580",
	user_msg: "#dcdce4",
	agent_msg: "#38bdf8",
};

export const TAN_THEME: CustomThemePalette = {
	color_scheme: "light",
	background: "#f0e6d3",
	foreground: "#2a1a10",
	card: "#e9ddc8",
	card_foreground: "#2a1a10",
	popover: "#eddfd0",
	popover_foreground: "#2a1a10",
	primary: "#8c4e35",
	primary_foreground: "#f5ede0",
	secondary: "#e4d4ba",
	secondary_foreground: "#2a1a10",
	muted: "#e4d4ba",
	muted_foreground: "#4d2c18",
	accent: "#ddd0b5",
	accent_foreground: "#2a1a10",
	destructive: "#b03a2e",
	destructive_foreground: "#f5ede0",
	border: "#c5a882",
	input: "#e4d4ba",
	ring: "#8c4e35",
	sidebar: "#e6d5bc",
	sidebar_foreground: "#2a1a10",
	sidebar_primary: "#8c4e35",
	sidebar_primary_foreground: "#f5ede0",
	sidebar_accent: "#ddd0b5",
	sidebar_accent_foreground: "#2a1a10",
	sidebar_border: "#b89870",
	sidebar_ring: "#8c4e35",
	data: "#8c4e35",
	chart_error: "#c0392b",
	status_success: "#3f7d44",
	status_warning: "#a65f00",
	tool_panel: "#e9ddc8",
	tool_panel_border: "#c5a882",
	user_msg: "#2a1a10",
	agent_msg: "#8c4e35",
};

export function builtInThemePalette(theme: "dark" | "tan"): CustomThemePalette {
	return { ...(theme === "dark" ? DARK_THEME : TAN_THEME) };
}

export function applyThemeToDocument(
	theme: ThemeName,
	palette?: CustomThemePalette,
	doc: Document = document,
): void {
	const root = doc.documentElement;
	root.dataset.theme = theme;
	root.dataset.themeAppearance =
		theme === "custom"
			? (palette ?? DARK_THEME).color_scheme
			: theme === "tan"
				? "light"
				: "dark";
	root.classList.remove("dark", "tan", "custom");
	root.classList.add(theme);
	const themeColor =
		theme === "custom"
			? (palette ?? DARK_THEME).background
			: theme === "tan"
				? TAN_THEME.background
				: DARK_THEME.background;
	doc
		.querySelector('meta[name="theme-color"]')
		?.setAttribute("content", themeColor);
	if (theme === "custom") {
		const colors = palette ?? DARK_THEME;
		root.style.colorScheme = colors.color_scheme;
		for (const key of THEME_COLOR_KEYS) {
			root.style.setProperty(`--${key.replaceAll("_", "-")}`, colors[key]);
		}
		return;
	}
	root.style.removeProperty("color-scheme");
	for (const key of THEME_COLOR_KEYS)
		root.style.removeProperty(`--${key.replaceAll("_", "-")}`);
}

export function effectiveTheme(
	ui: {
		theme: ThemeName;
		mobileTheme: ThemeName | "same";
		customTheme: CustomThemePalette;
		mobileCustomTheme: CustomThemePalette;
	},
	isMobile: boolean,
): { name: ThemeName; palette?: CustomThemePalette } {
	const name =
		isMobile && ui.mobileTheme !== "same" ? ui.mobileTheme : ui.theme;
	if (name !== "custom") return { name };
	return {
		name,
		palette:
			isMobile && ui.mobileTheme === "custom"
				? ui.mobileCustomTheme
				: ui.customTheme,
	};
}
