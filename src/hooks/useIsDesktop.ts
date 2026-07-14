import { useSyncExternalStore } from "react";

/** Tailwind `md` breakpoint. */
const QUERY = "(min-width: 768px)";

function subscribe(callback: () => void): () => void {
	if (typeof window.matchMedia !== "function") return () => {};
	const mql = window.matchMedia(QUERY);
	mql.addEventListener("change", callback);
	return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
	// jsdom has no matchMedia — default to desktop there (and anywhere else
	// the API is missing) so table layouts stay the baseline.
	if (typeof window.matchMedia !== "function") return true;
	return window.matchMedia(QUERY).matches;
}

/**
 * True at/above the `md` breakpoint. Used to swap between table and card
 * layouts without rendering both into the DOM (duplicate content breaks
 * screen-reader flow and double-loads thumbnails).
 */
export function useIsDesktop(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
