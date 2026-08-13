// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import { ASK_USER_QUESTION_CANCEL_KEY } from "#/server/protocol";
import { AskUserQuestionCard } from "./AskUserQuestionCard";
import type { AskUserQuestionChatMessage } from "./chatReducer";

afterEach(cleanup);
beforeEach(() => {
	privacyStore.__resetForTesting();
});

function makeMsg(
	overrides?: Partial<AskUserQuestionChatMessage>,
): AskUserQuestionChatMessage {
	return {
		id: "aq-1",
		role: "ask_user_question",
		questions: [
			{
				question: "Which library?",
				options: ["React", "Vue"],
				multiSelect: false,
			},
		],
		answers: null,
		...overrides,
	};
}

describe("AskUserQuestionCard — notes (user feedback)", () => {
	it("marks only an unanswered question as notification-actionable", () => {
		const { container, rerender } = render(
			<AskUserQuestionCard message={makeMsg()} onSubmit={vi.fn()} />,
		);
		expect(
			container.querySelector('[data-notification-attention="question"]'),
		).not.toBeNull();
		expect(screen.getByLabelText("Pending question")).toBeTruthy();
		rerender(
			<AskUserQuestionCard
				message={makeMsg({ answers: { "Which library?": ["React"] } })}
				onSubmit={vi.fn()}
			/>,
		);
		expect(
			container.querySelector('[data-notification-attention="question"]'),
		).toBeNull();
	});

	it("does not render the notes textarea by default", () => {
		const onSubmit = vi.fn();
		render(<AskUserQuestionCard message={makeMsg()} onSubmit={onSubmit} />);
		expect(screen.queryByLabelText(/notes/i)).toBeNull();
	});

	it("clicking the add-note toggle reveals a textarea", () => {
		const onSubmit = vi.fn();
		render(<AskUserQuestionCard message={makeMsg()} onSubmit={onSubmit} />);
		const toggle = screen.getByRole("button", { name: /add note/i });
		fireEvent.click(toggle);
		expect(screen.getByLabelText(/notes/i)).not.toBeNull();
	});

	it("includes notes in onSubmit when user types feedback (multi-question card)", () => {
		const onSubmit = vi.fn();
		const message = makeMsg({
			questions: [
				{
					question: "First?",
					options: ["red", "blue"],
					multiSelect: false,
				},
				{
					question: "Second?",
					options: ["fast", "slow"],
					multiSelect: false,
				},
			],
		});
		render(<AskUserQuestionCard message={message} onSubmit={onSubmit} />);

		// Multi-question card → manual submit (no auto). Pick one option per question
		// by clicking its visible label; click bubbles to the wrapping button.
		fireEvent.click(screen.getByText("red"));
		fireEvent.click(screen.getByText("fast"));

		// Add a note to the first question only
		const toggles = screen.getAllByRole("button", { name: /add note/i });
		fireEvent.click(toggles[0]);
		const textarea = screen.getByLabelText(/notes/i);
		fireEvent.change(textarea, { target: { value: "context for first" } });

		fireEvent.click(screen.getByRole("button", { name: /submit/i }));

		expect(onSubmit).toHaveBeenCalledTimes(1);
		const [id, answers, notes] = onSubmit.mock.calls[0];
		expect(id).toBe("aq-1");
		expect(answers).toEqual({
			"First?": ["red"],
			"Second?": ["fast"],
		});
		expect(notes).toEqual({ "First?": "context for first" });
	});

	it("auto-submit (single non-multi question) carries the note when present", () => {
		const onSubmit = vi.fn();
		render(<AskUserQuestionCard message={makeMsg()} onSubmit={onSubmit} />);

		// Add note before picking
		fireEvent.click(screen.getByRole("button", { name: /add note/i }));
		fireEvent.change(screen.getByLabelText(/notes/i), {
			target: { value: "team prefers it" },
		});

		// Pick option -> auto-submits
		fireEvent.click(screen.getByText("React"));

		expect(onSubmit).toHaveBeenCalledTimes(1);
		const [id, answers, notes] = onSubmit.mock.calls[0];
		expect(id).toBe("aq-1");
		expect(answers).toEqual({ "Which library?": ["React"] });
		expect(notes).toEqual({ "Which library?": "team prefers it" });
	});

	it("omits empty/whitespace-only notes from the notes map", () => {
		const onSubmit = vi.fn();
		render(<AskUserQuestionCard message={makeMsg()} onSubmit={onSubmit} />);

		fireEvent.click(screen.getByRole("button", { name: /add note/i }));
		fireEvent.change(screen.getByLabelText(/notes/i), {
			target: { value: "   " },
		});
		fireEvent.click(screen.getByText("React"));

		expect(onSubmit).toHaveBeenCalledTimes(1);
		const [, , notes] = onSubmit.mock.calls[0];
		expect(notes).toBeUndefined();
	});

	it("renders submitted notes in the answered (read-only) state", () => {
		const onSubmit = vi.fn();
		render(
			<AskUserQuestionCard
				message={makeMsg({
					answers: { "Which library?": ["React"] },
					notes: { "Which library?": "team prefers it" },
				})}
				onSubmit={onSubmit}
			/>,
		);
		expect(screen.getByText(/team prefers it/i)).not.toBeNull();
	});
});

describe("AskUserQuestionCard — direct form input", () => {
	it("renders and submits an ACP numeric elicitation field", () => {
		const onSubmit = vi.fn();
		render(
			<AskUserQuestionCard
				message={makeMsg({
					questions: [
						{
							question: "Replicas",
							options: [],
							multiSelect: false,
							freeText: true,
							inputType: "number",
							placeholder: "How many?",
						},
					],
				})}
				onSubmit={onSubmit}
			/>,
		);
		const submit = screen.getByRole("button", { name: /submit/i });
		expect((submit as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByRole("spinbutton"), {
			target: { value: "3" },
		});
		expect((submit as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(submit);
		expect(onSubmit).toHaveBeenCalledWith(
			"aq-1",
			{ Replicas: ["3"] },
			undefined,
		);
	});

	it("allows an optional direct field to be omitted", () => {
		const onSubmit = vi.fn();
		render(
			<AskUserQuestionCard
				message={makeMsg({
					questions: [
						{
							question: "Nickname",
							options: [],
							multiSelect: false,
							freeText: true,
							optional: true,
						},
					],
				})}
				onSubmit={onSubmit}
			/>,
		);
		const submit = screen.getByRole("button", { name: /submit/i });
		expect((submit as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(submit);
		expect(onSubmit).toHaveBeenCalledWith("aq-1", {}, undefined);
	});
});

describe("AskUserQuestionCard — provider interaction provenance", () => {
	const provenance = {
		provider_id: "claude",
		kind: "mcp_elicitation" as const,
		source_name: "github",
		tool_name: "authenticate",
		summary: "Authenticate the connector",
		turn_id: "turn-1234567890",
		url: "https://example.test/oauth",
	};

	it("shows Claude, MCP source, originating turn, and URL", () => {
		render(
			<AskUserQuestionCard
				message={makeMsg({ provenance })}
				onSubmit={vi.fn()}
			/>,
		);
		expect(screen.getByText("claude")).not.toBeNull();
		expect(screen.getByText("github")).not.toBeNull();
		expect(screen.getByText("authenticate")).not.toBeNull();
		expect(screen.getByText("turn turn-123")).not.toBeNull();
		expect(screen.getByText("Authenticate the connector")).not.toBeNull();
		expect(
			screen
				.getByRole("link", { name: /open provider link/i })
				.getAttribute("href"),
		).toBe("https://example.test/oauth");
	});

	it("renders a held peer message as a provider preview with bounded provenance", () => {
		render(
			<AskUserQuestionCard
				message={makeMsg({
					provenance: {
						provider_id: "claude",
						kind: "provider_dialog",
						source_name: "peer_inbound_approval",
						peer: {
							preview: "Please review the deployment plan",
							claimed_name: "Release helper",
							from_address: "peer-17",
							verified_peer_pid: 4242,
							hold_cause: "mode-mismatch",
						},
					},
				})}
				onSubmit={vi.fn()}
			/>,
		);

		expect(screen.getByText("Claude peer inbox")).not.toBeNull();
		expect(screen.getByText("Held for review")).not.toBeNull();
		expect(
			screen.getByText("Claude has not acted on this message."),
		).not.toBeNull();
		expect(screen.getByText("Provider preview")).not.toBeNull();
		expect(
			screen.getByText("sanitized and truncated by Claude Code"),
		).not.toBeNull();
		expect(
			screen.getByText("Please review the deployment plan"),
		).not.toBeNull();
		expect(screen.getByText("Claimed sender")).not.toBeNull();
		expect(screen.getByText("Release helper")).not.toBeNull();
		expect(screen.getByText("peer-17")).not.toBeNull();
		expect(screen.getByText("hold reason mode-mismatch")).not.toBeNull();
		expect(
			screen.getByText("connecting PID 4242 (provenance only)"),
		).not.toBeNull();
		expect(screen.getByText(/not human authority/i)).not.toBeNull();
		expect(screen.queryByRole("link", { name: /source session/i })).toBeNull();
	});

	it.each([
		[
			"Deliver to Claude",
			"Approved for delivery",
			"This review approved the message for delivery to Claude.",
			"Delivered message",
		],
		[
			"Deny",
			"Delivery denied",
			"The held message was not delivered to Claude.",
			"Provider preview",
		],
	])("retains peer audit context after %s", (answer, stateLabel, stateCopy, contentLabel) => {
		const question = "Deliver this held peer message to Claude?";
		render(
			<AskUserQuestionCard
				message={makeMsg({
					questions: [
						{
							question,
							options: ["Deliver to Claude", "Deny"],
							multiSelect: false,
						},
					],
					answers: { [question]: [answer] },
					provenance: {
						provider_id: "claude",
						kind: "provider_dialog",
						source_name: "peer_inbound_approval",
						peer: {
							preview: "Keep this preview for the audit trail",
							claimed_name: "Peer helper",
							...(answer === "Deliver to Claude"
								? {
										body: "Exact delivered body",
										from_session: "claimed-session-17",
									}
								: {}),
						},
					},
				})}
				onSubmit={vi.fn()}
			/>,
		);

		expect(screen.getByText(stateLabel)).not.toBeNull();
		expect(screen.getByText(stateCopy)).not.toBeNull();
		expect(screen.getByText(contentLabel)).not.toBeNull();
		if (answer === "Deliver to Claude") {
			expect(screen.getByText("Exact delivered body")).not.toBeNull();
			expect(
				screen.queryByText("Keep this preview for the audit trail"),
			).toBeNull();
			expect(screen.getByText("Claimed source session")).not.toBeNull();
			expect(screen.getByText("navigation claim only")).not.toBeNull();
			expect(screen.getByText("claimed-session-17")).not.toBeNull();
			expect(screen.queryByRole("link")).toBeNull();
		} else {
			expect(
				screen.getByText("Keep this preview for the audit trail"),
			).not.toBeNull();
		}
		expect(screen.getByText("Peer helper")).not.toBeNull();
		expect(screen.getByText(answer)).not.toBeNull();
		expect(
			screen.getByText(
				"This decision covered message delivery only, not tool authority.",
			),
		).not.toBeNull();
	});

	it("labels a cancelled peer review without implying an explicit denial", () => {
		render(
			<AskUserQuestionCard
				message={makeMsg({
					answers: { [ASK_USER_QUESTION_CANCEL_KEY]: [] },
					provenance: {
						provider_id: "claude",
						kind: "provider_dialog",
						source_name: "peer_inbound_approval",
						peer: { preview: "Cancelled provider preview" },
					},
				})}
				onSubmit={vi.fn()}
			/>,
		);

		expect(screen.getByText("Delivery cancelled")).not.toBeNull();
		expect(
			screen.getByText(
				"The review ended before the held message was delivered.",
			),
		).not.toBeNull();
		expect(screen.getByText("Cancelled")).not.toBeNull();
	});

	it("returns a deterministic shared cancellation marker", () => {
		const onSubmit = vi.fn();
		render(
			<AskUserQuestionCard
				message={makeMsg({ provenance })}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		expect(onSubmit).toHaveBeenCalledWith("aq-1", {
			[ASK_USER_QUESTION_CANCEL_KEY]: [],
		});
	});

	it("renders a cancelled provider interaction as resolved", () => {
		render(
			<AskUserQuestionCard
				message={makeMsg({
					provenance,
					answers: { [ASK_USER_QUESTION_CANCEL_KEY]: [] },
				})}
				onSubmit={vi.fn()}
			/>,
		);
		expect(screen.getByText("Cancelled")).not.toBeNull();
	});
});
