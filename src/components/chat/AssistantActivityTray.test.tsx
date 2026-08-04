// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolEventMessage } from "#/server/protocol";
import { AssistantActivityTray } from "./AssistantActivityTray";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

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
	it("keeps Claude's background action with active tool activity", () => {
		const onBackground = vi.fn();
		const running: ToolEventMessage[] = [
			{
				type: "tool_event",
				id: "bash-1",
				name: "Bash",
				input: { command: "sleep 30" },
			},
		];
		const view = render(
			<AssistantActivityTray
				responseId="response"
				events={running}
				streaming
				steerCount={0}
				open
				onToggle={vi.fn()}
				onBackground={onBackground}
				renderContent={() => null}
			/>,
		);

		const background = screen.getByRole("button", {
			name: "Background running Claude tools",
		});
		expect(
			background.parentElement?.parentElement?.getAttribute(
				"data-activity-tray",
			),
		).toBe("response");
		fireEvent.click(background);
		expect(onBackground).toHaveBeenCalledOnce();

		view.rerender(
			<AssistantActivityTray
				responseId="response"
				events={[{ ...running[0], result: "done" }]}
				streaming={false}
				steerCount={0}
				open
				onToggle={vi.fn()}
				onBackground={onBackground}
				renderContent={() => null}
			/>,
		);
		expect(
			screen.queryByRole("button", {
				name: "Background running Claude tools",
			}),
		).toBeNull();
	});

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

	it("fetches only after the loaded prefix is exhausted and anchors the inner scroll", async () => {
		let view: ReturnType<typeof render>;
		let scrollHeight = 200;
		const pagedTray = (items: ToolEventMessage[]) => (
			<AssistantActivityTray
				responseId="paged-response"
				events={items}
				totalCount={45}
				errorCount={2}
				hasEarlier={items.length < 45}
				onLoadEarlier={onLoadEarlier}
				streaming={false}
				steerCount={0}
				open
				onToggle={vi.fn()}
				renderContent={({ startIndex, endIndex }) => (
					<div data-testid="paged-range">
						{startIndex}:{endIndex}
					</div>
				)}
			/>
		);
		const onLoadEarlier = vi.fn(async () => {
			scrollHeight = 400;
			view.rerender(pagedTray(events(40)));
			return 20;
		});
		view = render(pagedTray(events(20)));

		expect(
			screen.getByRole("button", {
				name: "Activity, 45 tool calls · 2 errors, expanded",
			}),
		).not.toBeNull();
		const region = screen.getByRole("region", {
			name: /activity for response/i,
		}) as HTMLDivElement;
		Object.defineProperty(region, "scrollHeight", {
			configurable: true,
			get: () => scrollHeight,
		});
		region.scrollTop = 30;

		fireEvent.click(screen.getByRole("button", { name: "Load 20 earlier" }));
		await waitFor(() =>
			expect(screen.getByTestId("paged-range").textContent).toBe("0:40"),
		);
		expect(onLoadEarlier).toHaveBeenCalledOnce();
		expect(region.scrollTop).toBe(230);
		expect(
			screen.getByRole("button", {
				name: "Loaded 20 earlier, 40 of 45 shown",
			}),
		).not.toBeNull();
	});

	it("does not let the prepend's queued tail pin override its scroll anchor", async () => {
		let nextFrame = 1;
		const frames = new Map<number, FrameRequestCallback>();
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((callback: FrameRequestCallback) => {
				const frame = nextFrame++;
				frames.set(frame, callback);
				return frame;
			}),
		);
		vi.stubGlobal(
			"cancelAnimationFrame",
			vi.fn((frame: number) => {
				frames.delete(frame);
			}),
		);
		const flushFrames = () => {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(0);
		};

		let view: ReturnType<typeof render>;
		let scrollHeight = 200;
		const pagedTray = (items: ToolEventMessage[]) => (
			<AssistantActivityTray
				responseId="anchored-response"
				events={items}
				totalCount={45}
				hasEarlier={items.length < 45}
				onLoadEarlier={onLoadEarlier}
				streaming={false}
				steerCount={0}
				open
				onToggle={vi.fn()}
				renderContent={({ startIndex, endIndex }) => (
					<div data-testid="anchored-range">
						{startIndex}:{endIndex}
					</div>
				)}
			/>
		);
		const onLoadEarlier = vi.fn(async () => {
			scrollHeight = 400;
			view.rerender(pagedTray(events(40)));
			return 20;
		});
		view = render(pagedTray(events(20)));

		const region = screen.getByRole("region", {
			name: /activity for response/i,
		}) as HTMLDivElement;
		Object.defineProperty(region, "scrollHeight", {
			configurable: true,
			get: () => scrollHeight,
		});
		act(flushFrames);
		region.scrollTop = 30;

		fireEvent.click(screen.getByRole("button", { name: "Load 20 earlier" }));
		await waitFor(() =>
			expect(screen.getByTestId("anchored-range").textContent).toBe("0:40"),
		);
		expect(region.scrollTop).toBe(230);
		act(flushFrames);
		expect(region.scrollTop).toBe(230);

		scrollHeight = 410;
		view.rerender(pagedTray(events(41)));
		act(flushFrames);
		expect(region.scrollTop).toBe(410);
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
