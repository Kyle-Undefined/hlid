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
	it("shows the provider name, model, and effort in the collapsed card", () => {
		render(
			<SubagentToolBlock
				subagent={snapshot({
					name: "auth-scout",
					model: "gpt-5.4",
					effort: "high",
				})}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /auth-scout running/i }),
		).toBeTruthy();
		expect(screen.getByTitle("Model: gpt-5.4")).toBeTruthy();
		expect(screen.getByTitle("Effort: high")).toBeTruthy();
	});

	it("can collapse while running and continues advancing elapsed time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(6_000);
		render(<SubagentToolBlock subagent={snapshot()} />);
		const button = screen.getByRole("button", { name: /explorer running/i });
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getAllByText("5s").length).toBeGreaterThan(0);
		fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Inspect the authentication flow")).toBeNull();
		act(() => vi.advanceTimersByTime(2_000));
		expect(screen.getByText("7s")).toBeTruthy();
		fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Inspect the authentication flow")).toBeTruthy();
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
