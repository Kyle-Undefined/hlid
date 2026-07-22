import { describe, expect, it, vi } from "vitest";
import {
	composerKeyAction,
	insertAtSelection,
	prepareChatSubmission,
	resizeComposer,
	responsiveComposerMaxHeight,
	runComposerPickerAction,
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

	it("runs shared picker actions and reports submission", () => {
		const picker = {
			items: ["one"],
			navigate: vi.fn(),
			close: vi.fn(),
		};
		const select = vi.fn();

		expect(runComposerPickerAction("picker-next", picker, select)).toBe(false);
		expect(picker.navigate).toHaveBeenCalledWith(1);
		expect(runComposerPickerAction("picker-select", picker, select)).toBe(
			false,
		);
		expect(select).toHaveBeenCalledOnce();
		expect(runComposerPickerAction("submit", picker, select)).toBe(true);
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
		const element = {
			scrollHeight: 500,
			scrollTop: 120,
			selectionEnd: 5,
			value: "draft",
			style: { height: "10px", overflowY: "hidden" },
		};
		resizeComposer(element, 280);
		expect(element.style.height).toBe("280px");
		expect(element.style.overflowY).toBe("auto");
		expect(element.scrollTop).toBe(500);
	});

	it("keeps short composers free of an internal scroll region", () => {
		const element = {
			scrollHeight: 120,
			scrollTop: 0,
			selectionEnd: 5,
			value: "draft",
			style: { height: "280px", overflowY: "auto" },
		};
		resizeComposer(element, 280);
		expect(element.style.height).toBe("120px");
		expect(element.style.overflowY).toBe("hidden");
	});

	it("leaves middle-edit scrolling to the native textarea", () => {
		const element = {
			scrollHeight: 500,
			scrollTop: 120,
			selectionEnd: 2,
			value: "draft",
			style: { height: "280px", overflowY: "auto" },
		};
		resizeComposer(element, 280);
		expect(element.scrollTop).toBe(120);
	});

	it("caps mobile composers against the visible viewport height", () => {
		expect(responsiveComposerMaxHeight(390, 844)).toBe(320);
		expect(responsiveComposerMaxHeight(720, 320)).toBe(160);
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

	it("allows a vault-reference-only submission and preserves it on the wire", () => {
		const result = submission({
			text: "",
			vaultReferences: ["Projects/Hlid.md"],
		});
		expect(result).toMatchObject({
			kind: "immediate",
			user: {
				text: "Vault references:\n- Projects/Hlid.md",
			},
			message: {
				text: "",
				turn_id: "turn-1",
				vault_references: ["Projects/Hlid.md"],
			},
		});
	});

	it("builds a queued message with skill, attachment, and agent context", () => {
		expect(
			submission({
				running: true,
				skillContexts: ["/skills/review.md"],
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
				skill_contexts: ["/skills/review.md"],
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

	it("carries session-scoped CLI controls on immediate and queued turns", () => {
		const controls = {
			provider: "pi",
			model: "pi-pro",
			effort: "medium",
			permissionMode: "default",
		};
		for (const running of [false, true]) {
			expect(submission({ ...controls, running })).toMatchObject({
				message: {
					provider: "pi",
					model: "pi-pro",
					effort: "medium",
					permission_mode: "default",
				},
			});
		}
	});

	it("does not attach empty arrays to the wire message", () => {
		expect(submission()).toMatchObject({
			kind: "immediate",
			message: { attachments: undefined, skill_contexts: undefined },
		});
	});
});
