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
});
