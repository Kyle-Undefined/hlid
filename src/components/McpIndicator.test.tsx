// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { McpIndicator, mobilePopoverOffset } from "./McpIndicator";

afterEach(cleanup);

describe("McpIndicator", () => {
	it("clamps a mobile popover inside both viewport edges", () => {
		expect(mobilePopoverOffset(456, 172)).toBe(-20);
		expect(mobilePopoverOffset(360, 16)).toBe(0);
		expect(mobilePopoverOffset(320, 4)).toBe(12);
	});

	it("summarizes the active provider and opens a detailed status popover", () => {
		render(
			<McpIndicator
				servers={[
					{
						name: "filesystem",
						displayName: "filesystem",
						source: "vault",
						providerId: "codex",
						status: "connected",
					},
					{
						name: "github",
						displayName: "github",
						source: "global",
						providerId: "codex",
						status: "failed",
					},
				]}
			/>,
		);
		const button = screen.getByRole("button", { name: "MCP server status" });
		expect(button.textContent).toContain("1/2");
		expect(button.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(button);
		expect(button.getAttribute("aria-pressed")).toBe("true");
		expect(button.className).toContain("text-primary");
		expect(screen.getByText("filesystem")).toBeTruthy();
		expect(screen.getByText("github")).toBeTruthy();
		expect(screen.getAllByText(/codex ·/i)).toHaveLength(2);
	});

	it("anchors left on mobile and right on desktop when requested", () => {
		const { container } = render(
			<McpIndicator servers={[]} align="mobile-left" />,
		);
		fireEvent.click(screen.getByRole("button", { name: "MCP server status" }));
		const popover = container.querySelector(".bottom-full");
		expect(popover?.className).toContain("left-0");
		expect(popover?.className).toContain("md:left-auto");
		expect(popover?.className).toContain("md:right-0");
		expect(popover?.className).toContain("max-w-[calc(100vw-2rem)]");
	});
});
