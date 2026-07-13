import { describe, expect, it } from "vitest";
import {
	composerKeyAction,
	insertAtSelection,
	prepareChatSubmission,
	resizeComposer,
	responsiveComposerMaxHeight,
} from "./composer";

const key = (
	overrides: Partial<Parameters<typeof composerKeyAction>[0]> = {},
) =>
	composerKeyAction({
		key: "x",
		shiftKey: false,
		metaKey: false,
		ctrlKey: false,
		pickerOpen: false,
		isTouch: false,
		enterToSubmit: true,
		...overrides,
	});

describe("composer keyboard decisions", () => {
	it("routes picker navigation before submission", () => {
		expect(key({ key: "ArrowDown", pickerOpen: true })).toBe("picker-next");
		expect(key({ key: "ArrowUp", pickerOpen: true })).toBe("picker-previous");
		expect(key({ key: "Escape", pickerOpen: true })).toBe("picker-close");
		expect(key({ key: "Tab", pickerOpen: true })).toBe("picker-select");
		expect(key({ key: "Enter", pickerOpen: true })).toBe("picker-select");
	});

	it("submits keyboard shortcuts consistently", () => {
		expect(key({ key: "Enter", ctrlKey: true, isTouch: true })).toBe("submit");
		expect(key({ key: "Enter", metaKey: true, isTouch: true })).toBe("submit");
		expect(key({ key: "Enter" })).toBe("submit");
		expect(key({ key: "Enter", shiftKey: true })).toBeNull();
		expect(key({ key: "Enter", isTouch: true })).toBeNull();
		expect(key({ key: "Enter", enterToSubmit: false })).toBeNull();
	});
});

describe("composer text behavior", () => {
	it("inserts transcription at the selection with a separating space", () => {
		expect(insertAtSelection("hello world", "brave", 5, 5)).toBe(
			"hello brave world",
		);
		expect(insertAtSelection("hello old world", "new", 6, 9)).toBe(
			"hello new world",
		);
	});

	it("appends without introducing duplicate whitespace", () => {
		expect(insertAtSelection("hello ", "world")).toBe("hello world");
		expect(insertAtSelection("", "hello")).toBe("hello");
	});

	it("resizes through one bounded helper", () => {
		const element = { scrollHeight: 500, style: { height: "10px" } };
		resizeComposer(element, 280);
		expect(element.style.height).toBe("280px");
	});

	it("caps mobile composers against the visible viewport height", () => {
		expect(responsiveComposerMaxHeight(390, 844)).toBe(240);
		expect(responsiveComposerMaxHeight(720, 320)).toBe(112);
		expect(responsiveComposerMaxHeight(720, 120)).toBe(60);
	});

	it("retains the larger desktop cap when the viewport has room", () => {
		expect(responsiveComposerMaxHeight(1280, 1080)).toBe(480);
		expect(responsiveComposerMaxHeight(1280, 500)).toBe(250);
	});
});

const attachment = {
	id: "attachment-1",
	path: "/tmp/file.txt",
	filename: "file.txt",
	mime: "text/plain",
	kind: "ephemeral",
};

function submission(
	overrides: Partial<Parameters<typeof prepareChatSubmission>[0]> = {},
) {
	return prepareChatSubmission({
		id: "turn-1",
		text: "hello",
		sessionId: "session-1",
		running: false,
		attachments: [],
		agentContextAlreadySent: false,
		planMode: false,
		planHtml: false,
		...overrides,
	});
}

describe("chat submission policy", () => {
	it("does not submit empty text without attachments", () => {
		expect(submission({ text: "" })).toBeNull();
	});

	it("allows an attachment-only immediate submission", () => {
		const result = submission({ text: "", attachments: [attachment] });
		expect(result).toMatchObject({
			kind: "immediate",
			user: { text: "", attachments: [attachment] },
			message: { type: "chat", attachments: [attachment] },
		});
	});

	it("builds a queued message with skill, attachment, and agent context", () => {
		expect(
			submission({
				running: true,
				skillContext: "/skills/review.md",
				attachments: [attachment],
				agentCwd: "/agents/reviewer",
				planMode: true,
				planHtml: true,
			}),
		).toEqual({
			kind: "queued",
			message: {
				id: "turn-1",
				text: "hello",
				session_id: "session-1",
				skill_context: "/skills/review.md",
				attachments: [attachment],
				agent_cwd: "/agents/reviewer",
				plan_mode: true,
				plan_html: true,
			},
		});
	});

	it("sends agent context once and enables HTML only with plan mode", () => {
		const first = submission({
			agentCwd: "/agents/reviewer",
			planMode: true,
			planHtml: true,
		});
		expect(first).toMatchObject({
			kind: "immediate",
			marksAgentContextSent: true,
			message: {
				agent_cwd: "/agents/reviewer",
				plan_mode: true,
				plan_html: true,
			},
		});

		const later = submission({
			agentCwd: "/agents/reviewer",
			agentContextAlreadySent: true,
			planHtml: true,
		});
		expect(later).toMatchObject({
			kind: "immediate",
			marksAgentContextSent: false,
			message: {
				agent_cwd: undefined,
				plan_mode: undefined,
				plan_html: undefined,
			},
		});
	});

	it("does not attach empty arrays to the wire message", () => {
		expect(submission()).toMatchObject({
			kind: "immediate",
			message: { attachments: undefined, skill_context: undefined },
		});
	});
});
