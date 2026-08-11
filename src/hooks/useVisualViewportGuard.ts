import { type RefObject, useEffect } from "react";
import { resetShellScroll, resetWindowScroll } from "#/lib/scrollContainers";

const APP_HEIGHT_VAR = "--app-height";
const ROUTE_SCROLL_SETTLE_MS = 250;

/**
 * Keeps the fixed app shell glued to the visible viewport on mobile.
 *
 * - Pin the shell height (`--app-height`, consumed by the root layout) to the
 *   visual viewport from the first client render onward. Some Android
 *   standalone browsers report a stale dynamic viewport height at launch and
 *   do not correct it until an input opens the keyboard.
 * - On viewport changes / route changes, clamp any stray window scroll the
 *   keyboard reveal left behind. The persistent shell containers
 *   (`shellRefs`) are clamped too: focusing an input scrolls even their
 *   overflow-hidden boxes, and they outlive route changes, which would leave
 *   the next page rendered pre-scrolled.
 * - Pinch-zoom (scale > 1) is left alone so panning still works.
 */
export function useVisualViewportGuard(
	routeKey: string,
	shellRefs: Array<RefObject<HTMLElement | null>> = [],
): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: route change is the clamp trigger
	useEffect(() => {
		let settleFrame = 0;
		let delayedClamp = 0;
		const clamp = () => {
			resetWindowScroll();
			resetShellScroll(shellRefs.map((ref) => ref.current));
		};

		clamp();
		settleFrame = requestAnimationFrame(clamp);
		// Destination focus can land after the route commit (Forge waits 200ms).
		// Clamp once more after it has had time to scroll persistent shell boxes.
		delayedClamp = window.setTimeout(clamp, ROUTE_SCROLL_SETTLE_MS);
		return () => {
			cancelAnimationFrame(settleFrame);
			window.clearTimeout(delayedClamp);
		};
	}, [routeKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: shellRefs holds stable ref objects; routeKey deliberately retriggers the immediate and settled measurements
	useEffect(() => {
		const visualViewport = window.visualViewport;
		if (!visualViewport) return;
		let resetFrame = 0;
		let settleFrame = 0;
		const sync = () => {
			if (visualViewport.scale > 1.01) return;
			document.documentElement.style.setProperty(
				APP_HEIGHT_VAR,
				`${Math.round(visualViewport.height)}px`,
			);
			// After the shell fits the visible area, any window or shell scroll is
			// bogus. rAF lets the height change land before clamping.
			cancelAnimationFrame(resetFrame);
			resetFrame = requestAnimationFrame(() => {
				resetWindowScroll();
				resetShellScroll(shellRefs.map((ref) => ref.current));
			});
		};
		const syncWhenVisible = () => {
			if (document.visibilityState === "visible") sync();
		};

		// Measure now, then once more after the standalone window has settled.
		// Brave can finalize its usable viewport after the first client frame
		// without dispatching a visualViewport resize event.
		sync();
		settleFrame = requestAnimationFrame(sync);
		window.addEventListener("resize", sync);
		window.addEventListener("pageshow", sync);
		document.addEventListener("visibilitychange", syncWhenVisible);
		visualViewport.addEventListener("resize", sync);
		visualViewport.addEventListener("scroll", sync);
		return () => {
			window.removeEventListener("resize", sync);
			window.removeEventListener("pageshow", sync);
			document.removeEventListener("visibilitychange", syncWhenVisible);
			visualViewport.removeEventListener("resize", sync);
			visualViewport.removeEventListener("scroll", sync);
			cancelAnimationFrame(resetFrame);
			cancelAnimationFrame(settleFrame);
			document.documentElement.style.removeProperty(APP_HEIGHT_VAR);
		};
	}, [routeKey]);
}
