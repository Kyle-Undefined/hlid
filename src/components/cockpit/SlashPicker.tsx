import { useEffect, useRef } from "react";
import type { Skill } from "#/lib/skills";

/**
 * Floating slash-command picker.
 *
 * Positioning: parent container must be `position: relative`.
 *   direction="down" (default) — picker drops below the container (top-full).
 *                                Use on the home page where the input is mid-page.
 *   direction="up"             — picker floats above the container (bottom-full).
 *                                Use on raven where the input bar is pinned to the bottom.
 *
 * Keyboard navigation (ArrowUp/Down/Enter/Escape/Tab) is handled by the parent
 * via `useSlashPicker` — this component is purely presentational.
 *
 * ARIA: the owning textarea should carry:
 *   role="combobox"
 *   aria-expanded={isOpen}
 *   aria-controls="slash-picker"
 *   aria-autocomplete="list"
 *   aria-activedescendant={isOpen ? `slash-picker-opt-${selectedIndex}` : undefined}
 */
export function SlashPicker({
	items,
	selectedIndex,
	onSelect,
	direction = "down",
}: {
	items: Skill[];
	selectedIndex: number;
	onSelect: (skill: Skill) => void;
	direction?: "up" | "down";
}) {
	const containerRef = useRef<HTMLDivElement>(null);

	// Keep the highlighted option visible when navigating with the keyboard.
	// selectedIndex is a trigger dep — it's a prop, not a value used inside the effect body.
	// biome-ignore lint/correctness/useExhaustiveDependencies: selectedIndex is the trigger dep
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const selected = container.querySelector<HTMLElement>(
			"[aria-selected='true']",
		);
		selected?.scrollIntoView?.({ block: "nearest" });
	}, [selectedIndex]);

	if (items.length === 0) return null;

	return (
		<div
			ref={containerRef}
			id="slash-picker"
			role="listbox"
			aria-label="Slash commands"
			className={`absolute ${direction === "up" ? "bottom-full" : "top-full"} left-0 right-0 z-50 border border-border bg-card shadow-lg max-h-48 overflow-y-auto`}
		>
			{items.map((skill, i) => (
				<div
					key={skill.file}
					id={`slash-picker-opt-${i}`}
					role="option"
					aria-selected={i === selectedIndex}
					// tabIndex={-1} makes the element programmatically focusable but keeps
					// it out of the tab order (keyboard nav is managed by the parent textarea).
					tabIndex={-1}
					onMouseDown={(e) => {
						// Prevent textarea blur before selection fires
						e.preventDefault();
					}}
					onClick={() => onSelect(skill)}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onSelect(skill);
						}
					}}
					className={`w-full flex flex-col px-3 py-1.5 text-left cursor-pointer transition-colors select-none ${
						i === selectedIndex ? "bg-primary/10" : "hover:bg-primary/5"
					}`}
				>
					<span
						className={`text-[11px] tracking-wider font-medium uppercase ${
							i === selectedIndex ? "text-primary" : "text-foreground/80"
						}`}
					>
						/{skill.name}
					</span>
					{skill.description && (
						<span className="text-[10px] tracking-wider text-muted-foreground/70 truncate">
							{skill.description}
						</span>
					)}
				</div>
			))}
		</div>
	);
}
