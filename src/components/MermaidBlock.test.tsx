// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import mermaid from "mermaid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidBlock } from "./MermaidBlock";

vi.mock("mermaid", () => ({
	default: {
		initialize: vi.fn(),
		render: vi.fn(async () => ({
			svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>',
		})),
	},
}));

afterEach(() => {
	cleanup();
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.removeAttribute("data-theme-appearance");
	vi.mocked(mermaid.render).mockClear();
});

describe("MermaidBlock theme appearance", () => {
	it("rerenders when a custom theme changes appearance", async () => {
		document.documentElement.dataset.theme = "custom";
		document.documentElement.dataset.themeAppearance = "dark";
		render(<MermaidBlock code="graph TD; A-->B" />);

		await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
		expect(vi.mocked(mermaid.render).mock.calls[0]?.[1]).toContain(
			"'theme':'dark'",
		);

		document.documentElement.dataset.themeAppearance = "light";

		await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
		expect(vi.mocked(mermaid.render).mock.calls[1]?.[1]).toContain(
			"'theme':'default'",
		);
	});
});
