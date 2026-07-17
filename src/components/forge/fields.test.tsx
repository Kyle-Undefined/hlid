// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Field, TextInput, VocabRow } from "./fields";

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
		expect(vault.getAttribute("aria-describedby")).toBeTruthy();
		expect(screen.getByText("Shown in the header").id).toBe(
			vault.getAttribute("aria-describedby"),
		);
		expect(screen.getByRole("textbox", { name: "Active words" })).toBeTruthy();
	});
});
