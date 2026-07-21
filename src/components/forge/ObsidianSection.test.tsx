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
	it("restores the startup-cached connection without testing again", async () => {
		serverFns.getObsidianStatusFn.mockResolvedValue({
			supported: true,
			installed: true,
			registered: false,
			version: "1.12.7",
			state: "available",
			detail: "Obsidian CLI is installed.",
			agentTools: [
				"vault_info",
				"search",
				"read_note",
				"current_note",
				"daily_note",
				"links",
				"tasks",
				"properties",
				"base_query",
				"history",
				"list_templates",
				"list_commands",
				"read_template",
				"create_note",
				"capture_note",
				"open_daily_note",
				"base_create",
				"append_note",
				"prepend_note",
				"task_update",
				"property_set",
				"property_remove",
				"move_file",
				"rename_file",
				"run_command",
			],
			connection: {
				vaultName: "Fornbok",
				state: "connected",
				connection: {
					version: "1.12.7",
					vaultPath: "C:\\Vaults\\Fornbok",
				},
				error: null,
				checkedAt: 1,
			},
		});
		serverFns.testObsidianConnectionFn.mockResolvedValue({
			version: "1.12.8",
			vaultPath: "C:\\Vaults\\Fornbok",
		});
		render(
			<ObsidianSection
				rememberedCommands={[]}
				onRememberedCommandsChange={vi.fn()}
			/>,
		);

		await waitFor(() => expect(screen.getByText("v1.12.7")).toBeTruthy());
		expect(screen.getByText("25 curated tools")).toBeTruthy();
		expect(
			screen.getByText(
				"None yet. Agents discover commands and request approval when needed.",
			),
		).toBeTruthy();
		expect(screen.queryByText("not registered")).toBeNull();
		expect(screen.getByText("connected with v1.12.7")).toBeTruthy();
		expect(screen.getByText("C:\\Vaults\\Fornbok")).toBeTruthy();
		expect(serverFns.testObsidianConnectionFn).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
		await waitFor(() =>
			expect(screen.getByText("connected with v1.12.8")).toBeTruthy(),
		);
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
			connection: {
				vaultName: "Fornbok",
				state: "failed",
				connection: null,
				error: "Obsidian CLI was not found.",
				checkedAt: 1,
			},
		});
		render(
			<ObsidianSection
				rememberedCommands={[]}
				onRememberedCommandsChange={vi.fn()}
			/>,
		);
		await waitFor(() => expect(screen.getByText("not detected")).toBeTruthy());
		expect(
			screen.getByRole("link", { name: "Setup guide" }).getAttribute("href"),
		).toBe("https://obsidian.md/help/cli");
	});

	it("removes a remembered command approval", async () => {
		serverFns.getObsidianStatusFn.mockResolvedValue({
			supported: true,
			installed: true,
			registered: false,
			version: "1.12.7",
			state: "available",
			detail: "Obsidian CLI is installed.",
			agentTools: ["run_command"],
			connection: {
				vaultName: "Fornbok",
				state: "connected",
				connection: {
					version: "1.12.7",
					vaultPath: "C:\\Vaults\\Fornbok",
				},
				error: null,
				checkedAt: 1,
			},
		});
		const onRememberedCommandsChange = vi.fn();
		render(
			<ObsidianSection
				rememberedCommands={["templater-obsidian:insert-templater"]}
				onRememberedCommandsChange={onRememberedCommandsChange}
			/>,
		);
		await screen.findByText("templater-obsidian:insert-templater");
		fireEvent.click(
			screen.getByRole("button", {
				name: "Forget approved Obsidian command templater-obsidian:insert-templater",
			}),
		);
		expect(onRememberedCommandsChange).toHaveBeenCalledWith([]);
	});
});
