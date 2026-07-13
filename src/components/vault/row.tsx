import { ChevronDown, ChevronRight } from "lucide-react";

/** Shared row shell classes used by ProjectCard, MemoryCard, and SkillCard. */
export const ROW_BUTTON =
	"w-full flex items-center gap-3 px-4 py-3 text-left transition-colors";

/** Shared expanded-content region under a row (background shift + readable text). */
export const ROW_EXPANDED =
	"px-6 py-4 bg-secondary/30 text-xs text-foreground/80 leading-relaxed";

/** Readable line-length wrapper for expanded markdown. */
export const ROW_EXPANDED_INNER = "max-w-3xl";

/** Fixed-width leading chevron column; renders a spacer when not expandable. */
export function RowChevron({
	open,
	visible = true,
}: {
	open: boolean;
	visible?: boolean;
}) {
	if (!visible) return <span className="w-3 h-3 shrink-0" />;
	return open ? (
		<ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
	) : (
		<ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
	);
}
