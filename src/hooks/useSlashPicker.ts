import { useEffect, useState } from "react";
import { type CommandDescriptor, commandMatches } from "#/lib/commands";

export type SlashPickerState = {
	isOpen: boolean;
	items: CommandDescriptor[];
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
 *  - `activeCommand` is null (a selected command means the user is entering arguments)
 *  - `prompt` matches /^\/[^:\s]*$/ — starts with "/" and has no colon or space yet
 *
 * Items are filtered by prefix match against the provider-neutral command list,
 * including aliases reported by the active provider.
 *
 * Call `close()` to dismiss the picker without touching the input (e.g. on Escape).
 * The picker reopens automatically once the user changes the query.
 *
 */
export function useSlashPicker(
	prompt: string,
	commands: CommandDescriptor[],
	activeCommand: CommandDescriptor | null,
): SlashPickerState {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [forceClosed, setForceClosed] = useState(false);

	// Bare slash query: starts with "/" with no colon or space yet
	const isSlashQuery = /^\/[^:\s]*$/.test(prompt);
	const shouldOpen = activeCommand === null && isSlashQuery;

	const query = shouldOpen ? prompt.slice(1).toLowerCase() : "";

	const items = shouldOpen
		? commands.filter((command) => commandMatches(command, query))
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

	return { isOpen, items, query, selectedIndex: clampedIndex, navigate, close };
}
