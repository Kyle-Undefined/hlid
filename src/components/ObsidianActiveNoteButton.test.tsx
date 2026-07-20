// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ObsidianActiveNoteButton,
	ObsidianActiveNoteError,
} from "./ObsidianActiveNoteButton";

const serverFns = vi.hoisted(() => ({
	getActiveObsidianNoteFn: vi.fn(),
}));

vi.mock("#/lib/serverFns/obsidian", () => serverFns);
vi.mock("#/lib/transientFeedback", () => ({ TRANSIENT_FEEDBACK_MS: 10 }));

beforeEach(() => serverFns.getActiveObsidianNoteFn.mockReset());
afterEach(cleanup);

describe("ObsidianActiveNoteButton", () => {
	it("adds the active Obsidian note as an exact vault reference", async () => {
		const reference = {
			relativePath: "Notes/Current.md",
			name: "Current.md",
			directory: "Notes",
		};
		serverFns.getActiveObsidianNoteFn.mockResolvedValue(reference);
		const onAdd = vi.fn();
		render(<ObsidianActiveNoteButton onAdd={onAdd} />);

		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: "Attach active Obsidian note" }),
			);
		});

		await waitFor(() => expect(onAdd).toHaveBeenCalledWith(reference));
		expect(
			screen.getByRole("button", {
				name: "Active Obsidian note attached",
			}),
		).toBeTruthy();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Attach active Obsidian note" }),
			).toBeTruthy(),
		);
	});

	it("shows a dismissible error message on touch-sized controls", async () => {
		const onDismiss = vi.fn();
		render(
			<ObsidianActiveNoteError
				error="No active Obsidian note was found in this vault."
				onDismiss={onDismiss}
			/>,
		);

		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain(
			"No active Obsidian note was found in this vault.",
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Dismiss active Obsidian note error",
			}),
		);
		expect(onDismiss).toHaveBeenCalledOnce();
	});
});
