export function isRavenPath(pathname: string): boolean {
	return pathname === "/raven" || pathname === "/raven/";
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
