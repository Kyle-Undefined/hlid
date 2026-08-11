// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/hooks/useWs", () => ({
	useWs: () => ({ send: vi.fn() }),
}));

import { SessionSection } from "./SessionSection";

afterEach(cleanup);

describe("SessionSection destinations", () => {
	it("uses distinct stable anchors for privacy and lifecycle views", () => {
		const { rerender } = render(<SessionSection view="privacy" />);
		expect(screen.getByRole("heading", { name: "Privacy" }).id).toBe(
			"forge-section-privacy",
		);

		rerender(<SessionSection view="advanced" />);
		expect(screen.getByRole("heading", { name: "Session lifecycle" }).id).toBe(
			"forge-section-session-lifecycle",
		);
	});
});
