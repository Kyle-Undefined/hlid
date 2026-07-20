// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObsidianOpenButton } from "./ObsidianOpenButton";

const serverFns = vi.hoisted(() => ({ openObsidianNoteFn: vi.fn() }));
vi.mock("#/lib/serverFns/obsidian", () => serverFns);

beforeEach(() => serverFns.openObsidianNoteFn.mockReset());
afterEach(cleanup);

describe("ObsidianOpenButton", () => {
	it("opens only the selected vault-relative note", async () => {
		serverFns.openObsidianNoteFn.mockResolvedValue({ ok: true });
		render(<ObsidianOpenButton relativePath="Projects/Hlid.md" />);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Open Projects/Hlid.md in Obsidian",
			}),
		);

		await waitFor(() =>
			expect(serverFns.openObsidianNoteFn).toHaveBeenCalledWith({
				data: "Projects/Hlid.md",
			}),
		);
	});
});
