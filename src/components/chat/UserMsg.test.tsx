// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import type { UserMessage } from "./chatReducer";
import { UserMsg } from "./UserMsg";

afterEach(cleanup);

function makeMsg(overrides?: Partial<UserMessage>): UserMessage {
	return {
		id: "msg-1",
		role: "user",
		text: "hello world",
		attachments: [],
		...overrides,
	};
}

beforeEach(() => {
	privacyStore.__resetForTesting();
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText: vi.fn().mockResolvedValue(undefined) },
		configurable: true,
	});
});

describe("UserMsg", () => {
	it("keeps the normal ME label while a promoted queued message is running", () => {
		render(<UserMsg message={makeMsg()} queueState={{ kind: "running" }} />);
		expect(screen.getByText("ME")).toBeTruthy();
		expect(screen.queryByText("RUN")).toBeNull();
	});

	it("hides queued turn actions once promotion has been requested", () => {
		render(
			<UserMsg
				message={makeMsg()}
				queueState={{ kind: "promoting" }}
				onPromote={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		expect(screen.getByText("NEXT")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /send queued message/i }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /cancel queued message/i }),
		).toBeNull();
	});

	it("offers steering separately from interrupting a queued turn", () => {
		const onSteer = vi.fn();
		render(
			<UserMsg
				message={makeMsg()}
				queueState={{ kind: "queued", index: 0 }}
				onPromote={vi.fn()}
				onSteer={onSteer}
				onCancel={vi.fn()}
				canSteer={true}
			/>,
		);
		screen.getByRole("button", { name: /steer current run/i }).click();
		expect(onSteer).toHaveBeenCalledWith("msg-1");
		expect(
			screen
				.getByRole("button", { name: /send queued message/i })
				.getAttribute("title"),
		).toBe("Send now (interrupts current)");
	});

	it("hides queued actions while steering is being accepted", () => {
		render(
			<UserMsg
				message={makeMsg()}
				queueState={{ kind: "steering" }}
				onPromote={vi.fn()}
				onSteer={vi.fn()}
				onCancel={vi.fn()}
				canSteer={true}
			/>,
		);
		expect(screen.getByText("STEER")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /steer current run/i }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /send queued message/i }),
		).toBeNull();
	});

	it("opens the exact retained context receipt for a persisted turn", () => {
		const onViewContext = vi.fn();
		render(
			<UserMsg
				message={makeMsg({
					transcriptSeq: 8,
					hasContextReceipt: true,
				})}
				onViewContext={onViewContext}
			/>,
		);
		screen
			.getByRole("button", { name: "View context sent with this turn" })
			.click();
		expect(onViewContext).toHaveBeenCalledWith({
			seq: 8,
			turnId: "msg-1",
		});
	});

	it("opens a completed live turn by its stable turn id before history reloads", () => {
		const onViewContext = vi.fn();
		render(
			<UserMsg
				message={makeMsg({ hasContextReceipt: true })}
				onViewContext={onViewContext}
			/>,
		);
		screen
			.getByRole("button", { name: "View context sent with this turn" })
			.click();
		expect(onViewContext).toHaveBeenCalledWith({ turnId: "msg-1" });
	});

	it("does not offer context inspection when the turn has no receipt", () => {
		render(
			<UserMsg
				message={makeMsg({ transcriptSeq: 8 })}
				onViewContext={vi.fn()}
			/>,
		);
		expect(
			screen.queryByRole("button", {
				name: "View context sent with this turn",
			}),
		).toBeNull();
	});

	describe("persistent actions", () => {
		it("keeps user actions visible without hover-only opacity", () => {
			render(<UserMsg message={makeMsg()} />);
			const btn = screen.getByRole("button", { name: /copy/i });
			expect(btn.parentElement?.className).not.toContain("opacity-0");
			expect(btn.parentElement?.className).not.toContain(
				"group-hover:opacity-100",
			);
		});

		it("copy button not rendered when no text", () => {
			render(<UserMsg message={makeMsg({ text: "" })} />);
			expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
		});
	});
});
