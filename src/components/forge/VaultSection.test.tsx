// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type VaultForm, VaultSection } from "./VaultSection";

const serverFns = vi.hoisted(() => ({
	listObsidianTemplatesFn: vi.fn(),
}));

vi.mock("#/lib/serverFns/obsidian", () => serverFns);

const vault: VaultForm = {
	style: "para",
	name: "Fornbok",
	path: "/vault",
	inbox: "0 Inbox",
	projects: "1 Projects",
	areas: "2 Areas",
	resources: "3 Resources",
	archive: "4 Archive",
	raw: "Raw",
	wikiFolder: "Wiki",
	outputs: "Outputs",
	skills: "Skills",
	memory: "Memory",
	saveToObsidianTemplate: "",
	obsidianCommandAllowlist: [],
};

beforeEach(() => {
	serverFns.listObsidianTemplatesFn.mockReset();
});
afterEach(cleanup);

describe("VaultSection Obsidian template setting", () => {
	it("loads template choices dynamically and supports an empty selection", async () => {
		serverFns.listObsidianTemplatesFn.mockResolvedValue({
			vaultName: "Fornbok",
			templates: ["Daily Note", "Quick Capture"],
		});
		const onChange = vi.fn();
		render(<VaultSection vault={vault} onChange={onChange} />);

		const select = await screen.findByRole("combobox", {
			name: "Save to Obsidian Template",
		});
		await waitFor(() =>
			expect(
				screen.getByRole("option", { name: "Quick Capture" }),
			).toBeTruthy(),
		);
		expect(screen.getByRole("option", { name: "None" })).toBeTruthy();

		fireEvent.change(select, { target: { value: "Quick Capture" } });
		expect(onChange).toHaveBeenCalledWith({
			saveToObsidianTemplate: "Quick Capture",
		});
	});

	it("preserves a configured template that Obsidian no longer reports", async () => {
		serverFns.listObsidianTemplatesFn.mockResolvedValue({
			vaultName: "Fornbok",
			templates: ["Daily Note"],
		});
		render(
			<VaultSection
				vault={{ ...vault, saveToObsidianTemplate: "Old Capture" }}
				onChange={vi.fn()}
			/>,
		);

		await waitFor(() =>
			expect(
				screen.getByRole("option", { name: "Old Capture (not found)" }),
			).toBeTruthy(),
		);
		expect(
			screen.getByRole<HTMLSelectElement>("combobox", {
				name: "Save to Obsidian Template",
			}).value,
		).toBe("Old Capture");
	});

	it("keeps the setting usable when Obsidian templates cannot be loaded", async () => {
		serverFns.listObsidianTemplatesFn.mockRejectedValue(
			new Error("Obsidian is unavailable"),
		);
		render(<VaultSection vault={vault} onChange={vi.fn()} />);

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"Obsidian is unavailable",
			),
		);
		expect(screen.getByRole("option", { name: "None" })).toBeTruthy();
	});
});
