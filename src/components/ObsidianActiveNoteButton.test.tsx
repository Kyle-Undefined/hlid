// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObsidianActiveNoteButton } from "./ObsidianActiveNoteButton";

const serverFns = vi.hoisted(() => ({
	getActiveObsidianNoteFn: vi.fn(),
}));

vi.mock("#/lib/serverFns/obsidian", () => serverFns);

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

		fireEvent.click(
			screen.getByRole("button", { name: "Attach active Obsidian note" }),
		);

		await waitFor(() => expect(onAdd).toHaveBeenCalledWith(reference));
		expect(
			screen.getByRole("button", {
				name: "Active Obsidian note attached",
			}),
		).toBeTruthy();
	});
});
