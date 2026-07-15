// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HydrationSafeText } from "./HydrationSafeText";

describe("HydrationSafeText", () => {
	it("uses deterministic text for SSR", () => {
		expect(
			renderToString(
				<HydrationSafeText serverText="stable" clientText="browser-local" />,
			),
		).toContain("stable");
	});

	it("uses browser-local text for client-only renders", () => {
		render(
			<HydrationSafeText serverText="stable" clientText="browser-local" />,
		);
		expect(screen.getByText("browser-local")).not.toBeNull();
	});
});
