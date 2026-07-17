import { useEffect, useState } from "react";
import {
	type CommandDescriptor,
	canSelectCommand,
	commandMatches,
} from "#/lib/commands";

export type SlashPickerState = {
	isOpen: boolean;
	items: CommandDescriptor[];
	query: string;
	/** Prompt text with the active slash fragment removed after selection. */
	promptWithoutQuery: string;
	selectedIndex: number;
	navigate: (dir: 1 | -1) => void;
	/** Close the picker without clearing the input. Resets automatically when the query changes. */
	close: () => void;
};

/**
 * Drives the slash-command picker dropdown.
 *
 * Opens when:
 *  - the prompt ends with a slash fragment at a word boundary, so commands can
 *    be activated after already-written context as well as at the start
 *
 * Items are filtered by prefix match, prior selection, and provider composition
 * limits. This keeps the picker available for repeated selections.
 *
 * Call `close()` to dismiss the picker without touching the input (e.g. on Escape).
 * The picker reopens automatically once the user changes the query.
 *
 */
export function useSlashPicker(
	prompt: string,
	commands: CommandDescriptor[],
	selectedCommands: CommandDescriptor[] | CommandDescriptor | null = [],
	providerId?: string,
): SlashPickerState {
	const selected = Array.isArray(selectedCommands)
		? selectedCommands
		: selectedCommands
			? [selectedCommands]
			: [];
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [forceClosed, setForceClosed] = useState(false);

	const slashMatch = /(?:^|\s)\/([^:\s]*)$/.exec(prompt);
	const slashStart = slashMatch
		? (slashMatch.index ?? 0) + slashMatch[0].lastIndexOf("/")
		: -1;
	const shouldOpen = slashMatch !== null;
	const query = shouldOpen ? (slashMatch?.[1].toLowerCase() ?? "") : "";
	const promptWithoutQuery =
		slashStart >= 0 ? prompt.slice(0, slashStart) : prompt;

	const items = shouldOpen
		? commands.filter(
				(command) =>
					commandMatches(command, query) &&
					canSelectCommand(selected, command, providerId),
			)
		: [];

	const isOpen = shouldOpen && items.length > 0 && !forceClosed;

	// Reset index and forced-close state when query changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: query is a trigger dep — not used in body but drives re-run
	useEffect(() => {
		setSelectedIndex(0);
		setForceClosed(false);
	}, [query]);

	// Clamp at read time: safety net when items shrink without a query change
	// (e.g. the active provider publishes a command update while open)
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

	return {
		isOpen,
		items,
		query,
		promptWithoutQuery,
		selectedIndex: clampedIndex,
		navigate,
		close,
	};
}
