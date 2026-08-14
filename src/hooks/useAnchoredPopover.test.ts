import { describe, expect, it } from "vitest";
import { calculateAnchoredPopoverPosition } from "./useAnchoredPopover";

describe("calculateAnchoredPopoverPosition", () => {
	it("opens below and right-aligns to the tapped button", () => {
		expect(
			calculateAnchoredPopoverPosition(
				{ top: 100, right: 340, bottom: 144 },
				360,
				800,
				208,
				160,
			),
		).toMatchObject({ left: 132, top: 152, width: 208, placement: "below" });
	});

	it("flips above a button near the viewport bottom", () => {
		const position = calculateAnchoredPopoverPosition(
			{ top: 700, right: 340, bottom: 744 },
			360,
			800,
			208,
			160,
		);
		expect(position.placement).toBe("above");
		expect(position.top).toBe(532);
	});

	it("keeps a wide composer popover inside a narrow mobile viewport", () => {
		const position = calculateAnchoredPopoverPosition(
			{ top: 700, right: 100, bottom: 732 },
			360,
			800,
			320,
			480,
		);

		expect(position.placement).toBe("above");
		expect(position.left).toBeGreaterThanOrEqual(12);
		expect(position.left + position.width).toBeLessThanOrEqual(348);
		expect(
			position.top + Math.min(480, position.maxHeight),
		).toBeLessThanOrEqual(692);
	});

	it("keeps placement above while loading content grows", () => {
		const anchor = { top: 384, right: 100, bottom: 420 };
		const loading = calculateAnchoredPopoverPosition(
			anchor,
			349,
			706,
			320,
			480,
			{ contentHeight: 68 },
		);
		const loaded = calculateAnchoredPopoverPosition(
			anchor,
			349,
			706,
			320,
			480,
			{ contentHeight: 267 },
		);

		expect(loading.placement).toBe("above");
		expect(loaded.placement).toBe("above");
		expect(loading.top + 68).toBe(376);
		expect(loaded.top + 267).toBe(376);
	});

	it("stays within a panned visual viewport", () => {
		const position = calculateAnchoredPopoverPosition(
			{ top: 500, right: 370, bottom: 540 },
			360,
			400,
			320,
			480,
			{ contentHeight: 320, viewportLeft: 20, viewportTop: 180 },
		);

		expect(position.placement).toBe("above");
		expect(position.left).toBeGreaterThanOrEqual(32);
		expect(position.left + position.width).toBeLessThanOrEqual(368);
		expect(position.top).toBeGreaterThanOrEqual(192);
		expect(
			position.top + Math.min(320, position.maxHeight),
		).toBeLessThanOrEqual(492);
	});
});
