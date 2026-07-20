// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveToObsidianActions } from "./SaveToObsidianActions";

const serverFns = vi.hoisted(() => ({ appendToObsidianFn: vi.fn() }));
vi.mock("#/lib/serverFns/obsidian", () => serverFns);

beforeEach(() => serverFns.appendToObsidianFn.mockReset());
afterEach(cleanup);

describe("SaveToObsidianActions", () => {
	it.each([
		["active", "Append reply to active Obsidian note"],
		["daily", "Append reply to today's Obsidian daily note"],
	] as const)("appends the reply to %s", async (destination, label) => {
		serverFns.appendToObsidianFn.mockResolvedValue({ ok: true });
		render(<SaveToObsidianActions text="Useful answer" />);
		fireEvent.click(screen.getByRole("button", { name: label }));

		await waitFor(() =>
			expect(serverFns.appendToObsidianFn).toHaveBeenCalledWith({
				data: { destination, content: "Useful answer" },
			}),
		);
		expect(
			await screen.findByText(
				`saved to ${destination === "active" ? "active note" : "daily note"}`,
			),
		).toBeTruthy();
	});
});
