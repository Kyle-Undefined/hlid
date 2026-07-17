import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
	"button:not([disabled])",
	"[href]",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"iframe",
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
	return Array.from(
		container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
	).filter(
		(element) =>
			!element.hidden && element.getAttribute("aria-hidden") !== "true",
	);
}

/** Focus management shared by modal dialogs: enter, trap, Escape, and restore. */
export function useDialogFocus<T extends HTMLElement>(
	onClose: () => void,
	active = true,
): {
	dialogRef: RefObject<T | null>;
	onDialogKeyDown: (event: KeyboardEvent<T>) => void;
} {
	const dialogRef = useRef<T>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!active) return;
		const previous =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const dialog = dialogRef.current;
		if (!dialog) return;
		const first = focusableElements(dialog)[0];
		(first ?? dialog).focus();
		return () => {
			if (previous?.isConnected) previous.focus();
		};
	}, [active]);

	function onDialogKeyDown(event: KeyboardEvent<T>): void {
		if (event.key === "Escape") {
			event.preventDefault();
			onCloseRef.current();
			return;
		}
		if (event.key !== "Tab") return;
		const dialog = dialogRef.current;
		if (!dialog) return;
		const focusable = focusableElements(dialog);
		if (focusable.length === 0) {
			event.preventDefault();
			dialog.focus();
			return;
		}
		const first = focusable[0];
		const last = focusable.at(-1) ?? first;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	return { dialogRef, onDialogKeyDown };
}
