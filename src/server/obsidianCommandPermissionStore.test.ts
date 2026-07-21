import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	config: {
		vault: {
			name: "Fornbok",
			path: "C:\\Vaults\\Fornbok",
			obsidian_command_allowlist: ["app:go-back"],
		},
	},
	writeConfig: vi.fn(),
}));

vi.mock("./config", () => ({ loadConfig: () => state.config }));
vi.mock("../lib/config-writer", () => ({ writeConfig: state.writeConfig }));

import { persistAlwaysAllowedObsidianCommand } from "./permissionStore";

describe("persistAlwaysAllowedObsidianCommand", () => {
	beforeEach(() => state.writeConfig.mockReset());

	it("adds one exact command to the configured vault", () => {
		persistAlwaysAllowedObsidianCommand(
			"Fornbok",
			"C:\\Vaults\\Fornbok",
			"templater-obsidian:insert-templater",
		);

		expect(state.writeConfig).toHaveBeenCalledWith({
			vault: {
				name: "Fornbok",
				path: "C:\\Vaults\\Fornbok",
				obsidian_command_allowlist: [
					"app:go-back",
					"templater-obsidian:insert-templater",
				],
			},
		});
	});

	it("does not duplicate an existing remembered command", () => {
		persistAlwaysAllowedObsidianCommand(
			"Fornbok",
			"C:\\Vaults\\Fornbok",
			"app:go-back",
		);

		expect(state.writeConfig).not.toHaveBeenCalled();
	});

	it("refuses to save against a vault that changed mid-approval", () => {
		expect(() =>
			persistAlwaysAllowedObsidianCommand(
				"Other",
				"C:\\Vaults\\Other",
				"app:go-back",
			),
		).toThrow("vault changed");
		expect(state.writeConfig).not.toHaveBeenCalled();
	});
});
