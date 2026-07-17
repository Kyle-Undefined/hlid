import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export type AnchoredPopoverPosition = {
	left: number;
	top: number;
	width: number;
	maxHeight: number;
	placement: "above" | "below";
};

type AnchorRect = Pick<DOMRect, "top" | "right" | "bottom">;

export function calculateAnchoredPopoverPosition(
	anchor: AnchorRect,
	viewportWidth: number,
	viewportHeight: number,
	preferredWidth: number,
	preferredHeight: number,
): AnchoredPopoverPosition {
	const margin = 12;
	const gap = 8;
	const width = Math.max(
		0,
		Math.min(preferredWidth, viewportWidth - margin * 2),
	);
	const left = Math.max(
		margin,
		Math.min(anchor.right - width, viewportWidth - width - margin),
	);
	const belowTop = anchor.bottom + gap;
	const belowSpace = viewportHeight - margin - belowTop;
	const aboveSpace = anchor.top - gap - margin;
	const placement =
		belowSpace >= Math.min(preferredHeight, viewportHeight / 2) ||
		belowSpace >= aboveSpace
			? "below"
			: "above";
	const availableHeight = Math.max(
		96,
		placement === "below" ? belowSpace : aboveSpace,
	);
	const height = Math.min(preferredHeight, availableHeight);
	const top =
		placement === "below"
			? belowTop
			: Math.max(margin, anchor.top - gap - height);

	return { left, top, width, maxHeight: availableHeight, placement };
}

export function useAnchoredPopover(
	open: boolean,
	anchorRef: RefObject<HTMLElement | null>,
	preferredWidth: number,
	preferredHeight: number,
	popoverRef?: RefObject<HTMLElement | null>,
): AnchoredPopoverPosition | null {
	const [position, setPosition] = useState<AnchoredPopoverPosition | null>(
		null,
	);
	const update = useCallback(() => {
		const anchor = anchorRef.current;
		if (!anchor) return;
		const viewport = window.visualViewport;
		const measuredHeight = popoverRef?.current?.getBoundingClientRect().height;
		const next = calculateAnchoredPopoverPosition(
			anchor.getBoundingClientRect(),
			viewport?.width ?? window.innerWidth,
			viewport?.height ?? window.innerHeight,
			preferredWidth,
			measuredHeight && measuredHeight > 0 ? measuredHeight : preferredHeight,
		);
		setPosition((current) =>
			current &&
			current.left === next.left &&
			current.top === next.top &&
			current.width === next.width &&
			current.maxHeight === next.maxHeight &&
			current.placement === next.placement
				? current
				: next,
		);
	}, [anchorRef, popoverRef, preferredHeight, preferredWidth]);

	useEffect(() => {
		if (!open) {
			setPosition(null);
			return;
		}

		update();
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		window.visualViewport?.addEventListener("resize", update);
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
			window.visualViewport?.removeEventListener("resize", update);
		};
	}, [open, update]);

	const positioned = position !== null;
	useLayoutEffect(() => {
		const popover = popoverRef?.current;
		if (!open || !positioned || !popover) return;
		update();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(update);
		observer.observe(popover);
		return () => observer.disconnect();
	}, [open, popoverRef, positioned, update]);

	return position;
}
