import { THEME_OPTIONS } from "#/lib/agentOptions";
import type { NavigationNamesConfig } from "#/lib/navigationNames";
import type { CustomThemePalette, ThemeName } from "#/lib/theme";
import { displayHotkey, hotkeyFromEvent } from "#/lib/voiceHotkey";
import { Field, Section } from "./fields";

export type UiForm = {
	theme: ThemeName;
	mobileTheme: ThemeName | "same";
	customTheme: CustomThemePalette;
	mobileCustomTheme: CustomThemePalette;
	enterToSubmit: boolean;
	liveSessionsHotkey: string;
	hideSkillsIndex: boolean;
	showProviderEntries: boolean;
	htmlPlans: boolean;
	navigationNames: NavigationNamesConfig;
};

const MOBILE_THEME_OPTIONS = [
	{ value: "same" as const, label: "Same", desc: "no override" },
	{ value: "dark" as const, label: "Dark", desc: "neutral dark, sky blue" },
	{ value: "tan" as const, label: "Tan", desc: "warm parchment, terracotta" },
	{ value: "custom" as const, label: "Custom", desc: "mobile custom palette" },
] satisfies {
	value: ThemeName | "same";
	label: string;
	desc: string;
}[];

export function UiSection({
	ui,
	onChange,
	voiceHotkey = "",
}: {
	ui: UiForm;
	onChange: (patch: Partial<UiForm>) => void;
	voiceHotkey?: string;
}) {
	const hotkeyConflict =
		Boolean(ui.liveSessionsHotkey) && ui.liveSessionsHotkey === voiceHotkey;
	return (
		<Section title="UI" id="forge-section-ui">
			<div className="px-4 py-3 space-y-2">
				<div className="text-sm text-foreground">Theme</div>
				<div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
					{THEME_OPTIONS.map((opt) => (
						<button
							key={opt.value}
							type="button"
							onClick={() => onChange({ theme: opt.value })}
							aria-pressed={ui.theme === opt.value}
							className={`flex flex-col gap-1 p-3 border text-left transition-colors ${
								ui.theme === opt.value
									? "border-primary bg-primary/5"
									: "border-border hover:bg-accent"
							}`}
						>
							<span className="text-sm font-medium text-foreground">
								{opt.label}
							</span>
							<span className="text-xs text-muted-foreground">{opt.desc}</span>
						</button>
					))}
				</div>
			</div>
			<div className="px-4 py-3 space-y-2">
				<div className="text-sm text-foreground">Mobile theme override</div>
				<div className="text-xs text-muted-foreground mb-2">
					override theme on touch devices
				</div>
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
					{MOBILE_THEME_OPTIONS.map((opt) => (
						<button
							key={opt.value}
							type="button"
							onClick={() => onChange({ mobileTheme: opt.value })}
							aria-pressed={ui.mobileTheme === opt.value}
							className={`flex flex-col gap-1 p-3 border text-left transition-colors ${
								ui.mobileTheme === opt.value
									? "border-primary bg-primary/5"
									: "border-border hover:bg-accent"
							}`}
						>
							<span className="text-sm font-medium text-foreground">
								{opt.label}
							</span>
							<span className="text-xs text-muted-foreground">{opt.desc}</span>
						</button>
					))}
				</div>
			</div>
			<Field
				label="Enter to submit"
				hint="desktop only, mobile always uses Enter for newline"
			>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={ui.enterToSubmit}
						onChange={(e) => onChange({ enterToSubmit: e.target.checked })}
						className="accent-primary w-3.5 h-3.5"
					/>
					<span className="text-xs text-muted-foreground">
						{ui.enterToSubmit ? "on" : "off"}
					</span>
				</label>
			</Field>
			<Field
				label="Live sessions hotkey"
				hint="desktop shortcut; Escape or Backspace clears it"
			>
				<div className="space-y-1">
					<input
						type="text"
						readOnly
						value={
							ui.liveSessionsHotkey ? displayHotkey(ui.liveSessionsHotkey) : ""
						}
						placeholder="Click and press shortcut"
						onKeyDown={(event) => {
							event.preventDefault();
							if (event.key === "Escape" || event.key === "Backspace") {
								onChange({ liveSessionsHotkey: "" });
								return;
							}
							const hotkey = hotkeyFromEvent(event.nativeEvent);
							if (hotkey) onChange({ liveSessionsHotkey: hotkey });
						}}
						aria-label="Live sessions hotkey"
						aria-invalid={hotkeyConflict || undefined}
						aria-describedby={
							hotkeyConflict ? "live-sessions-hotkey-conflict" : undefined
						}
						className="w-40 sm:w-52 bg-input border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 cursor-pointer"
					/>
					{hotkeyConflict && (
						<div
							id="live-sessions-hotkey-conflict"
							role="alert"
							className="text-[10px] text-status-warning"
						>
							Voice recording currently uses this shortcut.
						</div>
					)}
				</div>
			</Field>
			<Field label="Hide skills index.md">
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={ui.hideSkillsIndex}
						onChange={(e) => onChange({ hideSkillsIndex: e.target.checked })}
						className="accent-primary w-3.5 h-3.5"
					/>
					<span className="text-xs text-muted-foreground">
						{ui.hideSkillsIndex ? "on" : "off"}
					</span>
				</label>
			</Field>
			<Field
				label="Show provider entries in / picker"
				hint="controls every provider-badged skill, command, and plugin entry; Hlid and vault entries stay visible"
			>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						aria-label="Show provider entries in slash picker"
						checked={ui.showProviderEntries}
						onChange={(e) =>
							onChange({ showProviderEntries: e.target.checked })
						}
						className="accent-primary w-3.5 h-3.5"
					/>
					<span className="text-xs text-muted-foreground">
						{ui.showProviderEntries ? "shown" : "hidden"}
					</span>
				</label>
			</Field>
			<Field
				id="forge-setting-html-plans"
				label="HTML plans"
				hint="default for the per-session toggle; in plan mode the agent renders its plan as a styled page shown in a modal"
			>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={ui.htmlPlans}
						onChange={(e) => onChange({ htmlPlans: e.target.checked })}
						className="accent-primary w-3.5 h-3.5"
					/>
					<span className="text-xs text-muted-foreground">
						{ui.htmlPlans ? "on" : "off"}
					</span>
				</label>
			</Field>
		</Section>
	);
}
