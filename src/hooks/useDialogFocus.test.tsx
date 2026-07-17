// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "./useDialogFocus";

afterEach(cleanup);

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open
			</button>
			{open && (
				<Dialog
					onClose={() => {
						setOpen(false);
						onClose();
					}}
				/>
			)}
		</>
	);
}

function Dialog({ onClose }: { onClose: () => void }) {
	const { dialogRef, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose);
	return (
		<div
			ref={dialogRef}
			tabIndex={-1}
			role="dialog"
			onKeyDown={onDialogKeyDown}
		>
			<button type="button">First</button>
			<button type="button">Last</button>
		</div>
	);
}

describe("useDialogFocus", () => {
	it("moves focus in, traps Tab, closes on Escape, and restores focus", () => {
		const onClose = vi.fn();
		render(<Harness onClose={onClose} />);
		const trigger = screen.getByRole("button", { name: "Open" });
		trigger.focus();
		fireEvent.click(trigger);

		const first = screen.getByRole("button", { name: "First" });
		const last = screen.getByRole("button", { name: "Last" });
		expect(document.activeElement).toBe(first);
		last.focus();
		fireEvent.keyDown(last, { key: "Tab" });
		expect(document.activeElement).toBe(first);
		fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(last);
		fireEvent.keyDown(last, { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(trigger);
	});
});
