import { useEffect, useState } from "react";
import type { Skill } from "#/lib/skills";

export type SlashPickerState = {
	isOpen: boolean;
	items: Skill[];
	query: string;
	selectedIndex: number;
	navigate: (dir: 1 | -1) => void;
	/** Close the picker without clearing the input. Resets automatically when the query changes. */
	close: () => void;
};

/**
 * Drives the slash-command picker dropdown.
 *
 * Opens when:
 *  - `activeSkill` is null (an active skill means user is typing context, not a new command)
 *  - `prompt` matches /^\/[^:\s]*$/ — starts with "/" and has no colon or space yet
 *
 * Items are filtered by prefix match (case-insensitive) against `allSkills`,
 * which should include both vault skills and SDK (claude-section) commands.
 *
 * Call `close()` to dismiss the picker without touching the input (e.g. on Escape).
 * The picker reopens automatically once the user changes the query.
 *
 * TODO: SDK commands expose `aliases` that are not yet part of the Skill shape.
 *       Wire aliases into filter matching once Skill gains an `aliases` field.
 */
export function useSlashPicker(
	prompt: string,
	allSkills: Skill[],
	activeSkill: { name: string } | null,
): SlashPickerState {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [forceClosed, setForceClosed] = useState(false);

	// Bare slash query: starts with "/" with no colon or space yet
	const isSlashQuery = /^\/[^:\s]*$/.test(prompt);
	const shouldOpen = activeSkill === null && isSlashQuery;

	const query = shouldOpen ? prompt.slice(1).toLowerCase() : "";

	const items = shouldOpen
		? allSkills.filter((s) => s.name.toLowerCase().startsWith(query))
		: [];

	const isOpen = shouldOpen && items.length > 0 && !forceClosed;

	// Reset index and forced-close state when query changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: query is a trigger dep — not used in body but drives re-run
	useEffect(() => {
		setSelectedIndex(0);
		setForceClosed(false);
	}, [query]);

	// Clamp at read time: safety net when items shrink without a query change
	// (e.g. allSkills updates while picker is open)
	const clampedIndex =
		items.length === 0 ? 0 : Math.min(selectedIndex, items.length - 1);

	function navigate(dir: 1 | -1) {
		setSelectedIndex((i) => {
			const len = items.length;
			if (len === 0) return 0;
			return (i + dir + len) % len;
		});
	}

	function close() {
		setForceClosed(true);
	}

	return { isOpen, items, query, selectedIndex: clampedIndex, navigate, close };
}
