export function isRavenPath(pathname: string): boolean {
	return pathname === "/raven" || pathname === "/raven/";
}

/**
 * Visual viewport this much shorter than the layout viewport means an
 * on-screen keyboard is up (URL-bar collapse and safe-area shifts are smaller).
 */
const KEYBOARD_MIN_INSET = 80;

/** Height (px) the on-screen keyboard steals from the layout viewport, or 0. */
export function keyboardInset(
	visualHeight: number | undefined,
	layoutHeight: number,
): number {
	if (visualHeight === undefined) return 0;
	const inset = layoutHeight - visualHeight;
	return inset > KEYBOARD_MIN_INSET ? inset : 0;
}

/**
 * The app shell is a fixed-height overflow-hidden column, so the window itself
 * must never scroll. iOS still scrolls the layout viewport to reveal a focused
 * input when the keyboard opens — and often never restores it, leaving the
 * shell shifted up (Raven's composer looks collapsed; other pages appear
 * pre-scrolled). Clamp it back to 0.
 */
export function resetWindowScroll(win: Window = window): void {
	const doc = win.document;
	if (
		win.scrollY === 0 &&
		doc.documentElement.scrollTop === 0 &&
		doc.body.scrollTop === 0
	)
		return;
	win.scrollTo(0, 0);
	doc.documentElement.scrollTop = 0;
	doc.body.scrollTop = 0;
}

/** Scroll only Raven's transcript container, never its page ancestors. */
export function scrollChatToBottom(
	element: HTMLElement | null,
	behavior: ScrollBehavior = "smooth",
): void {
	if (!element) return;
	if (typeof element.scrollTo === "function") {
		element.scrollTo({ top: element.scrollHeight, behavior });
		return;
	}
	element.scrollTop = element.scrollHeight;
}
