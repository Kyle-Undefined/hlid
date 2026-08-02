// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "./useDialogFocus";

afterEach(cleanup);

function Harness({
	onClose = vi.fn(),
	initialFocus = "first",
}: {
	onClose?: () => void;
	initialFocus?: "first" | "dialog";
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open
			</button>
			{open && (
				<Dialog
					initialFocus={initialFocus}
					onClose={() => {
						setOpen(false);
						onClose();
					}}
				/>
			)}
		</>
	);
}

function Dialog({
	onClose,
	initialFocus,
}: {
	onClose: () => void;
	initialFocus: "first" | "dialog";
}) {
	const { dialogRef, onBackdropClick, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose, true, initialFocus);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the focused dialog
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop test harness
		<div data-testid="dialog-backdrop" onClick={onBackdropClick}>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				onKeyDown={onDialogKeyDown}
			>
				<button type="button">First</button>
				<button type="button">Last</button>
			</div>
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

	it("can focus the dialog surface without highlighting its first action", () => {
		render(<Harness initialFocus="dialog" />);
		fireEvent.click(screen.getByRole("button", { name: "Open" }));

		expect(document.activeElement).toBe(screen.getByRole("dialog"));
		expect(document.activeElement).not.toBe(
			screen.getByRole("button", { name: "First" }),
		);
	});

	it("dismisses only when the click originates on the backdrop", () => {
		const onClose = vi.fn();
		render(<Harness onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Open" }));

		fireEvent.click(screen.getByRole("dialog"));
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId("dialog-backdrop"));
		expect(onClose).toHaveBeenCalledOnce();
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
