// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldControlProvider } from "#/components/form/FieldControlContext";
import { BrowseDialog, BrowseFieldControl } from "./BrowseFieldParts";

afterEach(cleanup);

describe("BrowseFieldParts", () => {
	it("carries the surrounding field label into the shared text input", () => {
		const onBrowse = vi.fn();
		render(
			<>
				<span id="vault-path-label">Vault path</span>
				<FieldControlProvider value={{ "aria-labelledby": "vault-path-label" }}>
					<BrowseFieldControl
						value="/vault"
						onChange={() => {}}
						onBrowse={onBrowse}
					/>
				</FieldControlProvider>
			</>,
		);
		expect(screen.getByRole("textbox", { name: "Vault path" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "BROWSE" }));
		expect(onBrowse).toHaveBeenCalledOnce();
	});

	it("owns dialog focus, Escape handling, and trigger restoration", () => {
		function Harness() {
			const [open, setOpen] = useState(false);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Open browser
					</button>
					{open && (
						<BrowseDialog title="Pick folder" onClose={() => setOpen(false)}>
							<button type="button">Select folder</button>
						</BrowseDialog>
					)}
				</>
			);
		}
		render(<Harness />);
		const trigger = screen.getByRole("button", { name: "Open browser" });
		trigger.focus();
		fireEvent.click(trigger);
		const dialog = screen.getByRole("dialog", { name: "Pick folder" });
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "CANCEL" }),
		);
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});
});
