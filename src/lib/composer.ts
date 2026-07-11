export type ComposerKeyAction =
	| "picker-next"
	| "picker-previous"
	| "picker-close"
	| "picker-select"
	| "submit"
	| null;

export function composerKeyAction(input: {
	key: string;
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	pickerOpen: boolean;
	isTouch: boolean;
	enterToSubmit: boolean;
}): ComposerKeyAction {
	if (input.pickerOpen) {
		if (input.key === "ArrowDown") return "picker-next";
		if (input.key === "ArrowUp") return "picker-previous";
		if (input.key === "Escape") return "picker-close";
		if (input.key === "Tab") return "picker-select";
		if (
			input.key === "Enter" &&
			!input.shiftKey &&
			!input.metaKey &&
			!input.ctrlKey
		) {
			return "picker-select";
		}
	}
	if (input.key !== "Enter" || input.shiftKey) return null;
	if (input.metaKey || input.ctrlKey) return "submit";
	if (!input.isTouch && input.enterToSubmit) return "submit";
	return null;
}

export function insertAtSelection(
	value: string,
	text: string,
	start = value.length,
	end = start,
): string {
	const safeStart = Math.max(0, Math.min(start, value.length));
	const safeEnd = Math.max(safeStart, Math.min(end, value.length));
	const before = value.slice(0, safeStart);
	const after = value.slice(safeEnd);
	const separator = before && !/\s$/.test(before) ? " " : "";
	return `${before}${separator}${text}${after}`;
}

export function resizeComposer(
	element: { scrollHeight: number; style: { height: string } } | null,
	maxHeight: number,
): void {
	if (!element) return;
	element.style.height = "auto";
	element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
}
