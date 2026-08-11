// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Field, StatusIndicator, TextInput, VocabRow } from "./fields";

afterEach(cleanup);

describe("Forge fields", () => {
	it("programmatically associates visible labels and hints with controls", () => {
		render(
			<>
				<Field label="Vault name" hint="Shown in the header">
					<TextInput value="Hall" onChange={() => {}} />
				</Field>
				<VocabRow label="Active words" value="Active" onChange={() => {}} />
			</>,
		);
		const vault = screen.getByRole("textbox", { name: "Vault name" });
		const vaultRow = vault.closest("[data-forge-setting-label]");
		expect(vaultRow?.getAttribute("data-forge-setting-label")).toBe(
			"vault name",
		);
		expect((vaultRow as HTMLElement | null)?.tabIndex).toBe(-1);
		expect(vault.getAttribute("aria-describedby")).toBeTruthy();
		expect(screen.getByText("Shown in the header").id).toBe(
			vault.getAttribute("aria-describedby"),
		);
		expect(screen.getByRole("textbox", { name: "Active words" })).toBeTruthy();
	});

	it("keeps long copy readable until the field container is roomy", () => {
		const hint =
			"This ordinary sentence stays readable beside an arbitrarily long runtime status.";
		const statusCopy =
			"A deliberately long provider status that may include a path or backend error";
		render(
			<Field label="Agent access" hint={hint}>
				<StatusIndicator ok={true}>{statusCopy}</StatusIndicator>
			</Field>,
		);

		const hintNode = screen.getByText(hint);
		const fieldRow = hintNode.parentElement?.parentElement;
		const statusText = screen.getByText(statusCopy);
		const statusNode = statusText.parentElement;
		const control = statusNode?.parentElement;

		expect(fieldRow?.className).toContain("grid");
		expect(fieldRow?.className).toContain(
			"@4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]",
		);
		expect(fieldRow?.className).not.toContain("md:flex-row");
		expect(hintNode.className).toContain("break-words");
		expect(hintNode.className).not.toContain("break-all");
		expect(control?.className).toContain("min-w-0");
		expect(control?.className).toContain("max-w-full");
		expect(statusNode?.className).toContain("min-w-0");
		expect(statusText.className).toContain("[overflow-wrap:anywhere]");
	});

	it("exposes stable focusable setting destinations when given an id", () => {
		render(
			<Field id="forge-setting-example" label="Example setting">
				<TextInput value="" onChange={() => {}} />
			</Field>,
		);

		const row = document.getElementById("forge-setting-example");
		expect(row).toBeTruthy();
		expect(row?.tabIndex).toBe(-1);
		row?.focus();
		expect(document.activeElement).toBe(row);
	});
});
