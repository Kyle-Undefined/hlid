// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerPaginationBar } from "./LedgerPagination";

afterEach(cleanup);

function renderBar(
	overrides?: Partial<{
		page: number;
		totalPages: number;
		loading: boolean;
	}>,
) {
	const onPageChange = vi.fn<(p: number) => void>();
	render(
		<LedgerPaginationBar
			pagination={{
				page: overrides?.page ?? 2,
				pageSize: 20,
				pageSizeOptions: [20, 50],
				totalPages: overrides?.totalPages ?? 5,
				onPageChange,
				onPageSizeChange: vi.fn(),
			}}
			loading={overrides?.loading ?? false}
		/>,
	);
	return { onPageChange };
}

function jumpInput(): HTMLInputElement {
	return screen.getByRole("spinbutton") as HTMLInputElement;
}

describe("LedgerPaginationBar", () => {
	it("navigates first/prev/next/last", () => {
		const { onPageChange } = renderBar();
		fireEvent.click(screen.getByRole("button", { name: "First page" }));
		fireEvent.click(screen.getByRole("button", { name: /prev/i }));
		fireEvent.click(screen.getByRole("button", { name: /next/i }));
		fireEvent.click(screen.getByRole("button", { name: "Last page" }));
		expect(onPageChange.mock.calls.map((c) => c[0])).toEqual([1, 1, 3, 5]);
	});

	it("disables backwards buttons on the first page and forwards on the last", () => {
		renderBar({ page: 1 });
		expect(
			(screen.getByRole("button", { name: "First page" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		cleanup();
		renderBar({ page: 5 });
		expect(
			(screen.getByRole("button", { name: "Last page" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("disables everything while loading", () => {
		renderBar({ loading: true });
		for (const name of ["First page", "Last page"]) {
			expect(
				(screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
			).toBe(true);
		}
	});

	it("jumps to a valid page on Enter and clears the input", () => {
		const { onPageChange } = renderBar();
		fireEvent.change(jumpInput(), { target: { value: "4" } });
		fireEvent.keyDown(jumpInput(), { key: "Enter" });
		expect(onPageChange).toHaveBeenCalledWith(4);
		expect(jumpInput().value).toBe("");
	});

	it("ignores out-of-range jumps", () => {
		const { onPageChange } = renderBar();
		fireEvent.change(jumpInput(), { target: { value: "99" } });
		fireEvent.keyDown(jumpInput(), { key: "Enter" });
		expect(onPageChange).not.toHaveBeenCalled();
	});

	it("clears the input on Escape and commits on blur", () => {
		const { onPageChange } = renderBar();
		fireEvent.change(jumpInput(), { target: { value: "3" } });
		fireEvent.keyDown(jumpInput(), { key: "Escape" });
		expect(jumpInput().value).toBe("");
		fireEvent.change(jumpInput(), { target: { value: "3" } });
		fireEvent.blur(jumpInput());
		expect(onPageChange).toHaveBeenCalledWith(3);
	});
});
