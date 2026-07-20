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

const serverFns = vi.hoisted(() => ({
	appendToObsidianFn: vi.fn(),
	captureReplyToObsidianFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/obsidian", () => serverFns);

beforeEach(() => {
	serverFns.appendToObsidianFn.mockReset();
	serverFns.captureReplyToObsidianFn.mockReset();
});
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

	it("creates a new note in the configured capture destination", async () => {
		serverFns.captureReplyToObsidianFn.mockResolvedValue({
			ok: true,
			path: "0 Inbox/Hlid 2026-07-20.md",
			destination: "Inbox",
		});
		render(
			<SaveToObsidianActions
				text="Useful answer"
				capture={{
					kind: "inbox",
					label: "Inbox",
					folder: "0 Inbox",
					vaultName: "Fornbok",
					template: "Quick Capture",
				}}
			/>,
		);
		const button = screen.getByRole("button", {
			name: "Send reply to Obsidian Inbox",
		});
		expect(button.getAttribute("title")).toBe("Send to Inbox\nFornbok/0 Inbox");
		fireEvent.click(button);

		await waitFor(() =>
			expect(serverFns.captureReplyToObsidianFn).toHaveBeenCalledWith({
				data: { content: "Useful answer" },
			}),
		);
		expect(await screen.findByText("saved to Inbox")).toBeTruthy();
	});

	it("hides capture when the workspace has no Inbox or Raw folder", () => {
		render(<SaveToObsidianActions text="Useful answer" capture={null} />);
		expect(
			screen.queryByRole("button", { name: /Send reply to Obsidian/ }),
		).toBeNull();
	});
});
