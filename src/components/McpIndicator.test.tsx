// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	McpIndicator,
	mcpPopoverOffset,
	mobilePopoverOffset,
} from "./McpIndicator";

afterEach(cleanup);

describe("McpIndicator", () => {
	it("clamps a mobile popover inside both viewport edges", () => {
		expect(mobilePopoverOffset(456, 172)).toBe(-20);
		expect(mobilePopoverOffset(360, 16)).toBe(0);
		expect(mobilePopoverOffset(320, 4)).toBe(12);
	});

	it("clamps a right-aligned desktop popover when its anchor is near the left edge", () => {
		expect(mcpPopoverOffset(1_200, 20, 60, true)).toBe(-4);
		expect(mcpPopoverOffset(1_200, 1_100, 60, true)).toBe(-228);
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
		render(<McpIndicator servers={[]} align="mobile-left" />);
		fireEvent.click(screen.getByRole("button", { name: "MCP server status" }));
		const popover = screen.getByText(
			"MCP runtime · active provider",
		).parentElement;
		expect(popover?.className).toContain("fixed");
		expect(popover?.parentElement).toBe(document.body);
		expect(popover?.style.left).toBe("16px");
		expect(popover?.style.width).toBe("288px");
	});

	it("opens from a slash-command signal without opening on mount", () => {
		const { rerender } = render(
			<McpIndicator servers={[]} openSignal={0} label="MCP runtime · Vault" />,
		);
		const button = screen.getByRole("button", { name: "MCP server status" });
		expect(button.getAttribute("aria-pressed")).toBe("false");
		rerender(
			<McpIndicator servers={[]} openSignal={1} label="MCP runtime · Vault" />,
		);
		expect(button.getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText("MCP runtime · Vault")).toBeTruthy();
	});
});
