import { useEffect, useState } from "react";
import type { UiForm } from "#/components/forge/UiSection";
import {
	builtInThemePalette,
	type CustomThemePalette,
	type ThemeColorKey,
} from "#/lib/theme";
import { Section } from "./fields";

type ThemeTarget = "desktop" | "mobile";

const COLOR_GROUPS: Array<{
	title: string;
	colors: Array<[ThemeColorKey, string]>;
}> = [
	{
		title: "Foundation",
		colors: [
			["background", "Background"],
			["foreground", "Text"],
			["card", "Cards"],
			["card_foreground", "Card text"],
			["primary", "Primary accent"],
			["primary_foreground", "Primary contrast"],
			["border", "Borders"],
			["muted_foreground", "Muted text"],
		],
	},
	{
		title: "Surfaces and states",
		colors: [
			["popover", "Popovers"],
			["popover_foreground", "Popover text"],
			["secondary", "Secondary surface"],
			["secondary_foreground", "Secondary text"],
			["muted", "Muted surface"],
			["accent", "Hover surface"],
			["accent_foreground", "Hover text"],
			["input", "Inputs"],
			["ring", "Focus ring"],
			["destructive", "Destructive"],
			["destructive_foreground", "Destructive text"],
			["status_success", "Success"],
			["status_warning", "Warning"],
		],
	},
	{
		title: "Ledger and stats",
		colors: [
			["data", "Charts and heatmap"],
			["chart_error", "Tool errors"],
			["token_input", "Token input"],
			["token_output", "Token output"],
			["cache_read", "Cache read"],
			["cache_write", "Cache write"],
		],
	},
	{
		title: "Navigation and chat",
		colors: [
			["sidebar", "Sidebar"],
			["sidebar_foreground", "Sidebar text"],
			["sidebar_primary", "Sidebar primary"],
			["sidebar_primary_foreground", "Sidebar primary text"],
			["sidebar_accent", "Sidebar hover"],
			["sidebar_accent_foreground", "Sidebar hover text"],
			["sidebar_border", "Sidebar border"],
			["sidebar_ring", "Sidebar focus"],
			["tool_panel", "Tool panels"],
			["tool_panel_border", "Tool panel border"],
			["user_msg", "User messages"],
			["agent_msg", "Agent messages"],
		],
	},
];

function ColorControl({
	colorKey,
	label,
	value,
	onChange,
}: {
	colorKey: ThemeColorKey;
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	const commitDraft = () => {
		if (/^#[0-9a-fA-F]{6}$/.test(draft)) onChange(draft);
		else setDraft(value);
	};
	return (
		<label className="flex items-center gap-3 border border-border bg-background/40 p-2">
			<input
				type="color"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				aria-label={`${label} color`}
				className="h-8 w-10 shrink-0 border-0 bg-transparent p-0"
			/>
			<span className="min-w-0 flex-1">
				<span className="block text-xs text-foreground">{label}</span>
				<span className="block truncate text-[10px] text-muted-foreground">
					{colorKey.replaceAll("_", "-")}
				</span>
			</span>
			<input
				type="text"
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commitDraft}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
				aria-label={`${label} hex`}
				className="w-20 bg-secondary border border-border px-2 py-1 text-[10px] uppercase"
			/>
		</label>
	);
}

export function CustomThemeSection({
	ui,
	onChange,
	target,
	onTargetChange,
}: {
	ui: UiForm;
	onChange: (patch: Partial<UiForm>) => void;
	target: ThemeTarget;
	onTargetChange: (target: ThemeTarget) => void;
}) {
	const field = target === "desktop" ? "customTheme" : "mobileCustomTheme";
	const palette = ui[field];
	const updatePalette = (next: CustomThemePalette) =>
		onChange({ [field]: next } as Partial<UiForm>);
	const updateColor = (key: ThemeColorKey, value: string) =>
		updatePalette({ ...palette, [key]: value });
	const copyActiveTheme = () => {
		const selected =
			target === "desktop"
				? ui.theme
				: ui.mobileTheme === "same"
					? ui.theme
					: ui.mobileTheme;
		if (selected === "dark" || selected === "tan") {
			updatePalette(builtInThemePalette(selected));
			return;
		}
		updatePalette({
			...(target === "mobile" && ui.mobileTheme === "custom"
				? ui.mobileCustomTheme
				: ui.customTheme),
		});
	};

	return (
		<Section title="Custom palette">
			<div className="p-4 space-y-5">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div
						className="inline-flex border border-border bg-card p-1"
						role="tablist"
						aria-label="Custom theme target"
					>
						{(["desktop", "mobile"] as const).map((option) => (
							<button
								key={option}
								type="button"
								role="tab"
								aria-selected={target === option}
								onClick={() => onTargetChange(option)}
								className={`px-3 py-1.5 text-[10px] tracking-widest uppercase ${
									target === option
										? "bg-primary/10 text-primary"
										: "text-muted-foreground hover:bg-accent"
								}`}
							>
								{option}
							</button>
						))}
					</div>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							onClick={copyActiveTheme}
							className="border border-primary/50 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-primary hover:bg-primary/10"
						>
							Copy active theme
						</button>
						<button
							type="button"
							onClick={() => updatePalette(builtInThemePalette("dark"))}
							className="border border-border px-2.5 py-1.5 text-[10px] uppercase tracking-wider hover:bg-accent"
						>
							Copy dark
						</button>
						<button
							type="button"
							onClick={() => updatePalette(builtInThemePalette("tan"))}
							className="border border-border px-2.5 py-1.5 text-[10px] uppercase tracking-wider hover:bg-accent"
						>
							Copy tan
						</button>
						{target === "mobile" && (
							<button
								type="button"
								onClick={() => updatePalette({ ...ui.customTheme })}
								className="border border-border px-2.5 py-1.5 text-[10px] uppercase tracking-wider hover:bg-accent"
							>
								Copy desktop custom
							</button>
						)}
					</div>
				</div>

				<div className="flex items-center justify-between gap-3 border border-border bg-card p-3">
					<div>
						<div className="text-xs text-foreground">Native control style</div>
						<div className="text-[10px] text-muted-foreground">
							Controls browser menus, inputs, and scrollbars.
						</div>
					</div>
					<select
						value={palette.color_scheme}
						onChange={(event) =>
							updatePalette({
								...palette,
								color_scheme: event.target.value as "dark" | "light",
							})
						}
						aria-label="Native control style"
						className="bg-secondary border border-border px-2 py-1.5 text-xs"
					>
						<option value="dark">Dark</option>
						<option value="light">Light</option>
					</select>
				</div>

				{COLOR_GROUPS.map((group) => (
					<div key={group.title} className="space-y-2">
						<h3 className="text-[10px] tracking-widest uppercase text-muted-foreground">
							{group.title}
						</h3>
						<div className="grid gap-2 sm:grid-cols-2">
							{group.colors.map(([key, label]) => (
								<ColorControl
									key={key}
									colorKey={key}
									label={label}
									value={palette[key]}
									onChange={(value) => updateColor(key, value)}
								/>
							))}
						</div>
					</div>
				))}
			</div>
		</Section>
	);
}
