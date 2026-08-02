// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolEventMessage } from "#/server/protocol";
import { AssistantActivityTray } from "./AssistantActivityTray";

afterEach(cleanup);

function events(count: number): ToolEventMessage[] {
	return Array.from({ length: count }, (_, index) => ({
		type: "tool_event",
		id: `tool-${index}`,
		name: `Read ${index}`,
		input: {},
		result: "ok",
	}));
}

function tray(eventsValue: ToolEventMessage[], open = true) {
	return (
		<AssistantActivityTray
			responseId="response"
			events={eventsValue}
			streaming
			steerCount={0}
			open={open}
			onToggle={vi.fn()}
			onSelectTool={vi.fn()}
			renderContent={({ startIndex, endIndex }) => (
				<div data-testid="range">
					{startIndex}:{endIndex}
				</div>
			)}
		/>
	);
}

describe("AssistantActivityTray", () => {
	it("mounts only the newest 20 calls and reports the load state in its button", async () => {
		const view = render(tray(events(25)));
		expect(screen.getByTestId("range").textContent).toBe("5:25");
		fireEvent.click(screen.getByRole("button", { name: "Load 5 earlier" }));
		expect(
			(
				screen.getByRole("button", {
					name: "Loading earlier tool calls",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		await waitFor(() =>
			expect(screen.getByTestId("range").textContent).toBe("0:25"),
		);
		expect(
			(
				screen.getByRole("button", {
					name: "Loaded 5 earlier, 25 of 25 shown",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(screen.getByText("Loaded 5 · 25 of 25")).not.toBeNull();

		view.rerender(tray(events(25), false));
		expect(screen.queryByTestId("range")).toBeNull();
		expect(
			screen.getByRole("button", {
				name: "Activity, 25 tool calls, collapsed",
			}),
		).not.toBeNull();

		view.rerender(tray(events(25)));
		expect(screen.getByTestId("range").textContent).toBe("5:25");
	});

	it("detaches from live updates when scrolled upward and can jump back", () => {
		const view = render(tray(events(20)));
		const region = screen.getByRole("region", {
			name: /activity for response/i,
		});
		fireEvent.wheel(region, { deltaY: -10 });

		view.rerender(tray(events(22)));
		expect(screen.getByTestId("range").textContent).toBe("0:20");
		fireEvent.click(
			screen.getByRole("button", { name: "Jump to live · 2 new calls" }),
		);
		expect(screen.getByTestId("range").textContent).toBe("2:22");
	});
});
