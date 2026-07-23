// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalState } from "#/server/protocol";
import { RavenGoalStrip } from "./RavenGoalStrip";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const goal: GoalState = {
	thread_id: "thread-1",
	objective: "Finish the release gate",
	status: "active",
	token_budget: 50_000,
	tokens_used: 1_250,
	time_used_seconds: 90,
	created_at: 1,
	updated_at: Math.floor(Date.now() / 1_000),
};

function props(overrides: Partial<Parameters<typeof RavenGoalStrip>[0]> = {}) {
	return {
		goal,
		editorOpen: false,
		pending: false,
		error: null,
		onOpenEditor: vi.fn(),
		onCloseEditor: vi.fn(),
		onSet: vi.fn(),
		onPause: vi.fn(),
		onResume: vi.fn(),
		onClear: vi.fn(),
		onDismissError: vi.fn(),
		...overrides,
	};
}

describe("RavenGoalStrip", () => {
	it("stays hidden without a goal, editor, or error", () => {
		const { container } = render(<RavenGoalStrip {...props({ goal: null })} />);
		expect(container.innerHTML).toBe("");
	});

	it("shows native goal progress and controls", () => {
		vi.useFakeTimers();
		vi.setSystemTime(goal.updated_at * 1_000);
		const value = props();
		render(<RavenGoalStrip {...value} />);
		expect(screen.getByText("Finish the release gate")).not.toBeNull();
		expect(screen.getByLabelText("Codex goal").textContent).toContain(
			"1,250 tokens / 50,000",
		);
		expect(screen.getByLabelText("Codex goal").textContent).toContain("1m 30s");
		fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
		fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
		fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
		expect(value.onPause).toHaveBeenCalledOnce();
		expect(value.onOpenEditor).toHaveBeenCalledOnce();
		expect(value.onClear).toHaveBeenCalledOnce();
	});

	it("ticks active goal time between provider usage updates", () => {
		vi.useFakeTimers();
		const updatedAt = 1_700_000_000;
		vi.setSystemTime(updatedAt * 1_000);
		render(
			<RavenGoalStrip
				{...props({ goal: { ...goal, updated_at: updatedAt } })}
			/>,
		);
		expect(screen.getByLabelText("Codex goal").textContent).toContain("1m 30s");

		act(() => vi.advanceTimersByTime(2_000));

		expect(screen.getByLabelText("Codex goal").textContent).toContain("1m 32s");
	});

	it("edits the objective and optional token budget", () => {
		const value = props({ editorOpen: true });
		render(<RavenGoalStrip {...value} />);
		fireEvent.change(screen.getByLabelText("Goal objective"), {
			target: { value: "Ship the tested goal feature" },
		});
		fireEvent.change(screen.getByLabelText("Goal token budget"), {
			target: { value: "75000" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(value.onSet).toHaveBeenCalledWith(
			"Ship the tested goal feature",
			75_000,
		);
	});

	it("keeps a newly submitted goal visible while Codex is saving it", () => {
		render(<RavenGoalStrip {...props({ pending: true })} />);
		expect(screen.getByText("Finish the release gate")).not.toBeNull();
		expect(screen.getByText("Saving")).not.toBeNull();
		expect(
			(screen.getByRole("button", { name: "Pause goal" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(screen.getByRole("button", { name: "Edit goal" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("offers resume for a paused goal and dismisses errors", () => {
		const value = props({
			goal: { ...goal, status: "paused" },
			error: "Codex did not respond",
		});
		render(<RavenGoalStrip {...value} />);
		fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
		fireEvent.click(screen.getByRole("button", { name: "Dismiss goal error" }));
		expect(value.onResume).toHaveBeenCalledOnce();
		expect(value.onDismissError).toHaveBeenCalledOnce();
	});
});
