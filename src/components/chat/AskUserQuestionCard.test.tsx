// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
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
});
