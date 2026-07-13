export function isRavenPath(pathname: string): boolean {
	return pathname === "/raven" || pathname === "/raven/";
}

/**
 * TanStack Router otherwise identifies nested scroll containers from their DOM
 * position. Raven, Relics, and Ledger each put their primary scroller in the
 * same structural slot, so Raven's auto-scroll position can be restored onto a
 * different page. Stable route-specific IDs keep those histories isolated.
 */
export const ROUTE_SCROLL_RESTORATION_IDS = {
	ravenTranscript: "raven-transcript",
	relicsList: "relics-list",
	ledgerList: "ledger-list",
	forgeSettings: "forge-settings",
	vaultContent: "vault-content",
	einherjarContent: "einherjar-content",
} as const;

/** Nested page areas that should reset on normal router navigation. */
export const SCROLL_TO_TOP_SELECTORS = [
	'[data-scroll-to-top="app"]',
	'[data-scroll-to-top="route"]',
] as const;

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

/**
 * Mobile browsers scroll every scrollable-box ancestor — including
 * overflow-hidden ones — to reveal a focused input. The app-shell wrappers
 * persist across route changes, so a stray scrollTop left there (e.g. by
 * focusing Raven's composer) makes every later page render pre-scrolled.
 * Clamp them back to the origin.
 */
export function resetShellScroll(containers: Array<HTMLElement | null>): void {
	for (const element of containers) {
		if (!element) continue;
		if (element.scrollTop !== 0) element.scrollTop = 0;
		if (element.scrollLeft !== 0) element.scrollLeft = 0;
	}
}

/**
 * Raven's transcript is the only ancestor that should scroll. Mobile browsers
 * can still move its overflow-hidden page/shell ancestors to reveal the
 * composer, clipping the whole application until another layout change occurs.
 */
export function resetScrollAncestors(
	element: HTMLElement | null,
	boundary: HTMLElement | null = document.body,
): void {
	let ancestor = element?.parentElement ?? null;
	while (ancestor) {
		if (ancestor.scrollTop !== 0) ancestor.scrollTop = 0;
		if (ancestor.scrollLeft !== 0) ancestor.scrollLeft = 0;
		if (ancestor === boundary) break;
		ancestor = ancestor.parentElement;
	}
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
