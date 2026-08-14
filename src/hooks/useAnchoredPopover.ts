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

type AnchoredPopoverMeasurement = {
	contentHeight?: number;
	viewportLeft?: number;
	viewportTop?: number;
};

export function calculateAnchoredPopoverPosition(
	anchor: AnchorRect,
	viewportWidth: number,
	viewportHeight: number,
	preferredWidth: number,
	preferredHeight: number,
	measurement: AnchoredPopoverMeasurement = {},
): AnchoredPopoverPosition {
	const margin = 12;
	const gap = 8;
	const viewportLeft = measurement.viewportLeft ?? 0;
	const viewportTop = measurement.viewportTop ?? 0;
	const viewportRight = viewportLeft + viewportWidth;
	const viewportBottom = viewportTop + viewportHeight;
	const width = Math.max(
		0,
		Math.min(preferredWidth, viewportWidth - margin * 2),
	);
	const left = Math.max(
		viewportLeft + margin,
		Math.min(anchor.right - width, viewportRight - width - margin),
	);
	const belowTop = anchor.bottom + gap;
	const belowSpace = Math.max(0, viewportBottom - margin - belowTop);
	const aboveSpace = Math.max(0, anchor.top - gap - (viewportTop + margin));
	const desiredHeight = Math.min(
		preferredHeight,
		Math.max(0, viewportHeight - margin * 2),
	);
	const placement =
		belowSpace >= desiredHeight ||
		(aboveSpace < desiredHeight && belowSpace >= aboveSpace)
			? "below"
			: "above";
	const availableHeight = placement === "below" ? belowSpace : aboveSpace;
	const contentHeight =
		measurement.contentHeight && measurement.contentHeight > 0
			? measurement.contentHeight
			: preferredHeight;
	const height = Math.min(contentHeight, availableHeight);
	const top =
		placement === "below"
			? belowTop
			: Math.max(viewportTop + margin, anchor.top - gap - height);

	return { left, top, width, maxHeight: availableHeight, placement };
}

export function useAnchoredPopover(
	open: boolean,
	anchorRef: RefObject<HTMLElement | null>,
	preferredWidth: number,
	preferredHeight: number,
	popoverRef?: RefObject<HTMLElement | null>,
	trackingRef?: RefObject<HTMLElement | null>,
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
			preferredHeight,
			{
				contentHeight: measuredHeight,
				viewportLeft: viewport?.offsetLeft ?? 0,
				viewportTop: viewport?.offsetTop ?? 0,
			},
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
		window.visualViewport?.addEventListener("scroll", update);
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
			window.visualViewport?.removeEventListener("resize", update);
			window.visualViewport?.removeEventListener("scroll", update);
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
		if (anchorRef.current) observer.observe(anchorRef.current);
		if (trackingRef?.current) observer.observe(trackingRef.current);
		return () => observer.disconnect();
	}, [anchorRef, open, popoverRef, positioned, trackingRef, update]);

	return position;
}
