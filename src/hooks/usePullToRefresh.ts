import { useEffect, useRef, useState } from "react";

/** Pull distance (px) required to trigger refresh. */
export const THRESHOLD = 80;
/** Max visual pull distance shown. */
export const MAX_PULL = 90;
/** Minimum actual drag (px) before we start tracking a pull gesture. */
const DEADZONE = 12;

/**
 * Require every scrollable ancestor under the listener container to be at the
 * top. A nested scroller can be at its own top while the page behind it still
 * has content above the viewport, which must remain a normal scroll gesture.
 */
function areScrollContainersAtTop(
	el: Element | null,
	listenerContainer: Element,
): boolean {
	while (el) {
		const { overflow, overflowY } = window.getComputedStyle(el);
		if (
			/auto|scroll/.test(overflow + overflowY) &&
			el.scrollHeight > el.clientHeight &&
			el.scrollTop > 6
		) {
			return false;
		}
		if (el === listenerContainer) return true;
		el = el.parentElement;
	}
	return false;
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
 * - Walks the DOM on each touchmove and bails out if any scroll container
 *   through the listener root isn't at the top, so nested scroll areas work
 *   without triggering a refresh while their parent page is still scrolled.
 * - Keeps a normal scroll gesture disqualified even if it reaches the top;
 *   only a new touch can begin pull-to-refresh.
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
	const disqualifiedRef = useRef(false);
	const refreshingRef = useRef(false);
	const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const onTouchStart = (e: TouchEvent) => {
			if (refreshingRef.current) return;
			startYRef.current = e.touches[0].clientY;
			activeRef.current = false;
			disqualifiedRef.current = false;
			currentPullRef.current = 0;
		};

		const onTouchMove = (e: TouchEvent) => {
			if (refreshingRef.current) return;

			const deltaY = e.touches[0].clientY - startYRef.current;

			// Once this touch has acted as a normal scroll, reaching the top midway
			// through it must not convert that same gesture into pull-to-refresh.
			const target = e.target instanceof Element ? e.target : container;
			if (!areScrollContainersAtTop(target, container)) {
				disqualifiedRef.current = true;
				if (activeRef.current) {
					activeRef.current = false;
					currentPullRef.current = 0;
					setPullY(0);
				}
				return;
			}
			if (disqualifiedRef.current) return;

			if (deltaY <= 0) {
				if (activeRef.current) {
					activeRef.current = false;
					currentPullRef.current = 0;
					setPullY(0);
				}
				return;
			}

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
				reloadTimerRef.current = setTimeout(
					() => window.location.reload(),
					500,
				);
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
			if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
			reloadTimerRef.current = null;
		};
	}, [containerRef]);

	return { pullY, isRefreshing };
}
