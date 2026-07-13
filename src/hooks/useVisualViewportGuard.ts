import { useEffect } from "react";
import { keyboardInset, resetWindowScroll } from "#/lib/scrollContainers";

const APP_HEIGHT_VAR = "--app-height";

/**
 * Keeps the fixed app shell glued to the visible viewport on mobile.
 *
 * - Keyboard open: pin the shell height (`--app-height`, consumed by the root
 *   layout as `h-[var(--app-height,100dvh)]`) to the visual viewport so the
 *   composer sits above the keyboard, instead of relying on iOS scrolling the
 *   layout viewport to reveal the input — a scroll it often never undoes.
 * - Keyboard closed / route change: clear the pin and clamp any stray window
 *   scroll the keyboard reveal left behind.
 * - Pinch-zoom (scale > 1) is left alone so panning still works.
 */
export function useVisualViewportGuard(pathname: string): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: route change is the clamp trigger
	useEffect(() => {
		resetWindowScroll();
	}, [pathname]);

	useEffect(() => {
		const visualViewport = window.visualViewport;
		if (!visualViewport) return;
		let frame = 0;
		const sync = () => {
			if (visualViewport.scale > 1.01) return;
			const inset = keyboardInset(visualViewport.height, window.innerHeight);
			const rootStyle = document.documentElement.style;
			if (inset > 0) {
				rootStyle.setProperty(
					APP_HEIGHT_VAR,
					`${Math.round(visualViewport.height)}px`,
				);
			} else {
				rootStyle.removeProperty(APP_HEIGHT_VAR);
			}
			// After the shell fits the visible area, any window scroll is bogus.
			// rAF lets the height change land before clamping.
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => resetWindowScroll());
		};
		visualViewport.addEventListener("resize", sync);
		visualViewport.addEventListener("scroll", sync);
		return () => {
			visualViewport.removeEventListener("resize", sync);
			visualViewport.removeEventListener("scroll", sync);
			cancelAnimationFrame(frame);
			document.documentElement.style.removeProperty(APP_HEIGHT_VAR);
		};
	}, []);
}
