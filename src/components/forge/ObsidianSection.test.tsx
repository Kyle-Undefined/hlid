// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObsidianSection } from "./ObsidianSection";

const serverFns = vi.hoisted(() => ({
	getObsidianStatusFn: vi.fn(),
	testObsidianConnectionFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/obsidian", () => serverFns);

beforeEach(() => {
	serverFns.getObsidianStatusFn.mockReset();
	serverFns.testObsidianConnectionFn.mockReset();
});
afterEach(cleanup);

describe("ObsidianSection", () => {
	it("shows passive installation state before offering an explicit connection test", async () => {
		serverFns.getObsidianStatusFn.mockResolvedValue({
			supported: true,
			installed: true,
			registered: false,
			version: "1.12.7",
			state: "available",
			detail: "Obsidian CLI is installed.",
			agentTools: [
				"search",
				"current_note",
				"links",
				"tasks",
				"properties",
				"base_query",
				"history",
			],
		});
		serverFns.testObsidianConnectionFn.mockResolvedValue({
			version: "1.12.7",
			vaultPath: "C:\\Vaults\\Fornbok",
		});
		render(<ObsidianSection />);

		await waitFor(() => expect(screen.getByText("v1.12.7")).toBeTruthy());
		expect(screen.getByText("7 read-only tools")).toBeTruthy();
		expect(screen.getByText("not registered")).toBeTruthy();
		expect(serverFns.testObsidianConnectionFn).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
		await waitFor(() =>
			expect(screen.getByText("connected with v1.12.7")).toBeTruthy(),
		);
		expect(screen.getByText("C:\\Vaults\\Fornbok")).toBeTruthy();
	});

	it("links to setup when the CLI is not installed", async () => {
		serverFns.getObsidianStatusFn.mockResolvedValue({
			supported: true,
			installed: false,
			registered: false,
			version: null,
			state: "not_installed",
			detail: "Not found",
			agentTools: [],
		});
		render(<ObsidianSection />);
		await waitFor(() => expect(screen.getByText("not detected")).toBeTruthy());
		expect(
			screen.getByRole("link", { name: "Setup guide" }).getAttribute("href"),
		).toBe("https://obsidian.md/help/cli");
	});
});
