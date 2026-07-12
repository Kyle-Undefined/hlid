// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentSnapshot } from "#/server/agentProvider";
import { SubagentToolBlock } from "./SubagentToolBlock";

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		provider: "codex",
		agentId: "child-1",
		label: "Explorer",
		prompt: "Inspect the authentication flow",
		status: "running",
		currentStep: "Reading session code",
		startedAtMs: 1_000,
		...overrides,
	};
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("SubagentToolBlock", () => {
	it("stays expanded and advances elapsed time while running", () => {
		vi.useFakeTimers();
		vi.setSystemTime(6_000);
		render(<SubagentToolBlock subagent={snapshot()} />);
		const button = screen.getByRole("button", { name: /explorer running/i });
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getAllByText("5s").length).toBeGreaterThan(0);
		fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("true");
		act(() => vi.advanceTimersByTime(2_000));
		expect(screen.getAllByText("7s").length).toBeGreaterThan(0);
	});

	it("auto-collapses on completion and reopens with retained details", () => {
		const { rerender } = render(<SubagentToolBlock subagent={snapshot()} />);
		rerender(
			<SubagentToolBlock
				subagent={snapshot({
					status: "completed",
					currentStep: "Inspection complete",
					endedAtMs: 8_000,
				})}
			/>,
		);
		const button = screen.getByRole("button", { name: /explorer completed/i });
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Inspect the authentication flow")).toBeNull();
		fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Inspect the authentication flow")).toBeTruthy();
	});
});
