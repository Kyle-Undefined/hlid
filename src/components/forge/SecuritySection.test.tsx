// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecuritySection } from "./SecuritySection";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("SecuritySection", () => {
	it("keeps the current-device lock action in trusted-device settings", () => {
		vi.stubGlobal("fetch", vi.fn());
		render(<SecuritySection />);

		expect(screen.getByText("This Device")).toBeTruthy();
		expect(
			screen.getByText(
				"Return this browser to the unlock screen without affecting other trusted devices.",
			),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Lock" })).toBeTruthy();
	});
});
