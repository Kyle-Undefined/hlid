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
import {
	resetSubagentOpenStateForTest,
	SubagentToolBlock,
} from "./SubagentToolBlock";

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
	resetSubagentOpenStateForTest();
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

	it("wraps long subagent identity and runtime fields on mobile", () => {
		const name = "long_mobile_subagent_name_that_must_remain_visible";
		const agentId = "019f6942-a481-7651-b1b9-a39b62c56657-extra-context";
		render(
			<SubagentToolBlock
				subagent={snapshot({
					name,
					label: "/root/long_mobile_subagent_name_that_must_remain_visible",
					agentId,
					model: "gpt-5.6-sol-with-a-long-runtime-label",
					effort: "high",
				})}
			/>,
		);

		const button = screen.getByRole("button", { name: new RegExp(name) });
		expect(button.className).toContain(
			"grid-cols-[auto_auto_minmax(0,1fr)_auto]",
		);
		expect(screen.getByText(name).className).toContain("break-all");
		expect(screen.getByTitle(/Model:/).className).toContain("break-all");
		expect(screen.getByText(agentId).className).toContain("break-all");
		expect(
			screen.getByText(
				"/root/long_mobile_subagent_name_that_must_remain_visible",
			).className,
		).toContain("break-words");
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

	it("restores a running card's collapsed state after navigation remounts it", () => {
		const first = render(<SubagentToolBlock subagent={snapshot()} />);
		fireEvent.click(screen.getByRole("button", { name: /explorer running/i }));
		expect(
			screen
				.getByRole("button", { name: /explorer running/i })
				.getAttribute("aria-expanded"),
		).toBe("false");

		first.unmount();
		render(<SubagentToolBlock subagent={snapshot()} />);
		expect(
			screen
				.getByRole("button", { name: /explorer running/i })
				.getAttribute("aria-expanded"),
		).toBe("false");
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
