import { useEffect } from "react";
import { THEME_OPTIONS } from "#/lib/agentOptions";
import { Field, Section } from "./fields";

export type UiForm = {
	theme: "dark" | "tan";
	mobileTheme: "dark" | "tan" | "same";
	enterToSubmit: boolean;
	hideSkillsIndex: boolean;
};

const MOBILE_THEME_OPTIONS = [
	{ value: "same" as const, label: "Same", desc: "no override" },
	{ value: "dark" as const, label: "Dark", desc: "neutral dark, sky blue" },
	{ value: "tan" as const, label: "Tan", desc: "warm parchment, terracotta" },
] satisfies { value: "dark" | "tan" | "same"; label: string; desc: string }[];

export function UiSection({
	ui,
	onChange,
}: {
	ui: UiForm;
	onChange: (patch: Partial<UiForm>) => void;
}) {
	useEffect(() => {
		const mq = window.matchMedia("(pointer: coarse)");
		const apply = () => {
			const effective =
				mq.matches && ui.mobileTheme !== "same" ? ui.mobileTheme : ui.theme;
			document.documentElement.setAttribute("data-theme", effective);
			const themes = ["dark", "tan"] as const;
			for (const t of themes) document.documentElement.classList.remove(t);
			document.documentElement.classList.add(effective);
		};
		apply();
		mq.addEventListener("change", apply);
		return () => mq.removeEventListener("change", apply);
	}, [ui.theme, ui.mobileTheme]);

	return (
		<Section title="UI">
			<div className="px-4 py-3 space-y-2">
				<div className="text-sm text-foreground">Theme</div>
				<div className="grid grid-cols-2 gap-2">
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
				<div className="grid grid-cols-3 gap-2">
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
		</Section>
	);
}
