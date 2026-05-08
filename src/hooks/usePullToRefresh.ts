import { useEffect, useRef, useState } from "react";

/** Pull distance (px) required to trigger refresh. */
export const THRESHOLD = 80;
/** Max visual pull distance shown. */
export const MAX_PULL = 90;
/** Minimum actual drag (px) before we start tracking a pull gesture. */
const DEADZONE = 12;

/**
 * Walk up the DOM to find the nearest scrollable ancestor.
 * Returns null if none found before document.body.
 */
function getScrollContainer(el: Element | null): Element | null {
	while (el && el !== document.body) {
		const { overflow, overflowY } = window.getComputedStyle(el);
		if (
			/auto|scroll/.test(overflow + overflowY) &&
			el.scrollHeight > el.clientHeight
		) {
			return el;
		}
		el = el.parentElement;
	}
	return null;
}

export interface PullToRefreshState {
	/** Current pull distance 0..MAX_PULL. */
	pullY: number;
	/** True after threshold met; page will reload shortly. */
	isRefreshing: boolean;
}

/**
 * Attaches pull-to-refresh gesture handling to `containerRef`.
 *
 * - Walks the DOM on each touchmove to find the real scroll container;
 *   bails out if that container isn't scrolled to the top, so inner
 *   scroll areas (e.g. raven message list) work correctly.
 * - Calls `window.location.reload()` when triggered.
 * - Handles touchcancel for iOS system gestures.
 */
export function usePullToRefresh(
	containerRef: React.RefObject<HTMLElement | null>,
): PullToRefreshState {
	const [pullY, setPullY] = useState(0);
	const [isRefreshing, setIsRefreshing] = useState(false);

	const startYRef = useRef(0);
	const currentPullRef = useRef(0);
	const activeRef = useRef(false);
	const refreshingRef = useRef(false);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const onTouchStart = (e: TouchEvent) => {
			if (refreshingRef.current) return;
			startYRef.current = e.touches[0].clientY;
			activeRef.current = false;
			currentPullRef.current = 0;
		};

		const onTouchMove = (e: TouchEvent) => {
			if (refreshingRef.current) return;

			const deltaY = e.touches[0].clientY - startYRef.current;

			if (deltaY <= 0) {
				if (activeRef.current) {
					activeRef.current = false;
					currentPullRef.current = 0;
					setPullY(0);
				}
				return;
			}

			// Find the actual scrolling element under the finger.
			// If it has content above the viewport, this is a normal scroll — bail.
			const scrollEl = getScrollContainer(e.target as Element);
			if (scrollEl && scrollEl.scrollTop > 6) return;

			// Require a deliberate downward pull before engaging.
			if (deltaY < DEADZONE) return;

			// Prevent native scroll/bounce while in pull gesture.
			e.preventDefault();

			activeRef.current = true;

			// sqrt-based resistance: feels like elastic rubber band.
			const effectiveDelta = deltaY - DEADZONE;
			const pull = Math.min(Math.sqrt(effectiveDelta) * 5.5, MAX_PULL);
			currentPullRef.current = pull;
			setPullY(pull);
		};

		const onRelease = () => {
			if (!activeRef.current || refreshingRef.current) return;
			activeRef.current = false;

			if (currentPullRef.current >= THRESHOLD) {
				refreshingRef.current = true;
				setIsRefreshing(true);
				// Small delay lets the spin animation render before reload.
				setTimeout(() => window.location.reload(), 500);
			} else {
				currentPullRef.current = 0;
				setPullY(0);
			}
		};

		container.addEventListener("touchstart", onTouchStart, { passive: true });
		container.addEventListener("touchmove", onTouchMove, { passive: false });
		container.addEventListener("touchend", onRelease, { passive: true });
		container.addEventListener("touchcancel", onRelease, { passive: true });

		return () => {
			container.removeEventListener("touchstart", onTouchStart);
			container.removeEventListener("touchmove", onTouchMove);
			container.removeEventListener("touchend", onRelease);
			container.removeEventListener("touchcancel", onRelease);
		};
	}, [containerRef]);

	return { pullY, isRefreshing };
}
