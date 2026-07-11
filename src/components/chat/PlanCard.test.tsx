// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import type { PlanProposalMessage } from "./chatReducer";
import { PlanCard } from "./PlanCard";

afterEach(cleanup);
beforeEach(() => {
	privacyStore.__resetForTesting();
});

function makeMsg(
	overrides?: Partial<PlanProposalMessage>,
): PlanProposalMessage {
	return {
		id: "pp1",
		role: "plan_proposal",
		plan: "## Steps\n\n1. **Refactor** auth\n2. Add tests",
		decision: "pending",
		...overrides,
	};
}

describe("PlanCard — pending", () => {
	it("renders plan content with markdown formatting", () => {
		render(<PlanCard message={makeMsg()} onDecide={vi.fn()} />);
		// markdown-rendered: <strong> for bold
		expect(screen.getByText("Refactor").tagName).toBe("STRONG");
		expect(screen.getByText("Steps").tagName).toBe("H2");
	});

	it("calls onDecide with 'approved' on Approve click", () => {
		const onDecide = vi.fn();
		render(<PlanCard message={makeMsg()} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: /approve plan/i }));
		expect(onDecide).toHaveBeenCalledWith("pp1", "approved");
	});

	it("calls onDecide with 'cancelled' on Cancel click", () => {
		const onDecide = vi.fn();
		render(<PlanCard message={makeMsg()} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: /cancel plan/i }));
		expect(onDecide).toHaveBeenCalledWith("pp1", "cancelled");
	});

	it("Revise sends 'edited' with feedback when textarea has content", () => {
		const onDecide = vi.fn();
		render(<PlanCard message={makeMsg()} onDecide={onDecide} />);
		const ta = screen.getByPlaceholderText(/suggest revisions/i);
		fireEvent.change(ta, { target: { value: "do X first" } });
		fireEvent.click(screen.getByRole("button", { name: /send revisions/i }));
		expect(onDecide).toHaveBeenCalledWith("pp1", "edited", "do X first");
	});

	it("Revise is disabled when feedback is empty", () => {
		const onDecide = vi.fn();
		render(<PlanCard message={makeMsg()} onDecide={onDecide} />);
		const btn = screen.getByRole("button", { name: /send revisions/i });
		expect(btn).toHaveProperty("disabled", true);
		fireEvent.click(btn);
		expect(onDecide).not.toHaveBeenCalled();
	});

	it("Enter in textarea submits revision (no Shift)", () => {
		const onDecide = vi.fn();
		render(<PlanCard message={makeMsg()} onDecide={onDecide} />);
		const ta = screen.getByPlaceholderText(/suggest revisions/i);
		fireEvent.change(ta, { target: { value: "swap step 1" } });
		fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
		expect(onDecide).toHaveBeenCalledWith("pp1", "edited", "swap step 1");
	});

	it("opens an HTML plan in the sandboxed modal and shares its decisions", () => {
		const onDecide = vi.fn();
		render(
			<PlanCard
				message={makeMsg({ htmlRelicId: "att-html" })}
				onDecide={onDecide}
			/>,
		);
		const frame = screen.getByTitle("Plan document");
		expect(frame.getAttribute("src")).toBe("/api/attachments/att-html/raw");
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		fireEvent.click(
			screen.getAllByRole("button", { name: /approve plan/i })[1],
		);
		expect(onDecide).toHaveBeenCalledWith("pp1", "approved");
		expect(screen.queryByRole("dialog", { name: "Plan document" })).toBeNull();
	});
});

describe("PlanCard — resolved", () => {
	it("renders approved label without buttons", () => {
		render(
			<PlanCard
				message={makeMsg({ decision: "approved" })}
				onDecide={vi.fn()}
			/>,
		);
		expect(screen.getByText("PLAN APPROVED")).not.toBeNull();
		expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
	});

	it("approved card hides plan content by default", () => {
		render(
			<PlanCard
				message={makeMsg({ decision: "approved" })}
				onDecide={vi.fn()}
			/>,
		);
		expect(screen.queryByText("Refactor")).toBeNull();
	});

	it("approved card expands content on click", () => {
		render(
			<PlanCard
				message={makeMsg({ decision: "approved" })}
				onDecide={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText("Refactor")).not.toBeNull();
	});

	it("resolved HTML plans reopen in a read-only modal", () => {
		render(
			<PlanCard
				message={makeMsg({ decision: "approved", htmlRelicId: "att-html" })}
				onDecide={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /view html/i }));
		expect(
			screen.getByRole("dialog", { name: "Plan document" }),
		).not.toBeNull();
		expect(screen.queryByRole("button", { name: /approve plan/i })).toBeNull();
	});

	it("renders cancelled label", () => {
		render(
			<PlanCard
				message={makeMsg({ decision: "cancelled" })}
				onDecide={vi.fn()}
			/>,
		);
		expect(screen.getByText("PLAN CANCELLED")).not.toBeNull();
	});

	it("cancelled card hides plan content", () => {
		render(
			<PlanCard
				message={makeMsg({ decision: "cancelled" })}
				onDecide={vi.fn()}
			/>,
		);
		expect(screen.queryByText("Refactor")).toBeNull();
	});

	it("renders edited label", () => {
		render(
			<PlanCard message={makeMsg({ decision: "edited" })} onDecide={vi.fn()} />,
		);
		expect(screen.getByText("PLAN REVISED")).not.toBeNull();
	});

	it("edited card hides plan content and has no expand button", () => {
		render(
			<PlanCard message={makeMsg({ decision: "edited" })} onDecide={vi.fn()} />,
		);
		expect(screen.queryByText("Refactor")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});
});
