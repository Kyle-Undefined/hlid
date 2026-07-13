// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitPrompt } from "./CockpitPrompt";

afterEach(cleanup);

beforeEach(() => {
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({ matches: false })),
	);
});

afterEach(() => vi.unstubAllGlobals());

type Props = Parameters<typeof CockpitPrompt>[0];

function makeVoice(overrides?: Partial<Props["voice"]>): Props["voice"] {
	return {
		phase: "idle",
		seconds: 0,
		error: null,
		ready: true,
		status: { state: "ready", model: "base" },
		start: vi.fn(),
		stop: vi.fn(),
		cancel: vi.fn(),
		refresh: vi.fn(),
		clearError: vi.fn(),
		...overrides,
	} as unknown as Props["voice"];
}

function makeProps(overrides?: Partial<Props>): Props {
	return {
		config: {
			ui: { enter_to_submit: true },
			voice: { enabled: true, hotkey: "Alt+Shift+KeyV" },
		} as unknown as Props["config"],
		prompt: "",
		setPrompt: vi.fn(),
		activeSkill: null,
		isConnected: true,
		isRunning: false,
		canRun: true,
		selectedAgentPath: "",
		setSelectedAgentPath: vi.fn(),
		agentList: [],
		background: false,
		setBackground: vi.fn(),
		sameSession: false,
		setSameSession: vi.fn(),
		textareaRef: createRef<HTMLTextAreaElement>(),
		fileInputRef: createRef<HTMLInputElement>(),
		upload: {
			pendingAttachments: [],
			uploadingCount: 0,
			uploadError: null,
			uploadFiles: vi.fn(),
			removePending: vi.fn(),
		} as unknown as Props["upload"],
		voice: makeVoice(),
		picker: {
			open: false,
			items: [],
			index: 0,
			navigate: vi.fn(),
			close: vi.fn(),
		},
		onSkillSelect: vi.fn(),
		onClear: vi.fn(),
		onRun: vi.fn(),
		...overrides,
	};
}

function textarea(): HTMLTextAreaElement {
	return screen.getByRole("combobox") as HTMLTextAreaElement;
}

describe("CockpitPrompt placeholder", () => {
	it("default prompt hint when idle and connected", () => {
		render(<CockpitPrompt {...makeProps()} />);
		expect(textarea().placeholder).toBe("type a prompt, or pick a skill below");
	});

	it("shows recording seconds", () => {
		render(
			<CockpitPrompt
				{...makeProps({
					voice: makeVoice({ phase: "recording", seconds: 7 } as never),
				})}
			/>,
		);
		expect(textarea().placeholder).toBe("recording… 7s");
	});

	it("shows transcribing state and disables textarea", () => {
		render(
			<CockpitPrompt
				{...makeProps({
					voice: makeVoice({ phase: "transcribing" } as never),
				})}
			/>,
		);
		expect(textarea().placeholder).toBe("transcribing locally…");
		expect(textarea().disabled).toBe(true);
	});

	it("shows offline placeholder when disconnected", () => {
		render(<CockpitPrompt {...makeProps({ isConnected: false })} />);
		expect(textarea().placeholder).toBe("server offline…");
	});

	it("shows skill context hint when a skill is active", () => {
		render(
			<CockpitPrompt
				{...makeProps({
					activeSkill: { name: "review", filePath: "/skills/review.md" },
				})}
			/>,
		);
		expect(textarea().placeholder).toBe("add context… (optional)");
		expect(screen.getByText("· review")).toBeTruthy();
	});
});

describe("CockpitPrompt composer keys", () => {
	it("Enter submits when enter_to_submit is on", () => {
		const onRun = vi.fn();
		render(<CockpitPrompt {...makeProps({ onRun })} />);
		fireEvent.keyDown(textarea(), { key: "Enter" });
		expect(onRun).toHaveBeenCalledOnce();
	});

	it("Shift+Enter does not submit", () => {
		const onRun = vi.fn();
		render(<CockpitPrompt {...makeProps({ onRun })} />);
		fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
		expect(onRun).not.toHaveBeenCalled();
	});

	it("arrow keys navigate open picker", () => {
		const navigate = vi.fn();
		const props = makeProps();
		render(
			<CockpitPrompt
				{...props}
				picker={{ ...props.picker, open: true, navigate }}
			/>,
		);
		fireEvent.keyDown(textarea(), { key: "ArrowDown" });
		fireEvent.keyDown(textarea(), { key: "ArrowUp" });
		expect(navigate).toHaveBeenNthCalledWith(1, 1);
		expect(navigate).toHaveBeenNthCalledWith(2, -1);
	});

	it("Escape closes open picker", () => {
		const close = vi.fn();
		const props = makeProps();
		render(
			<CockpitPrompt
				{...props}
				picker={{ ...props.picker, open: true, close }}
			/>,
		);
		fireEvent.keyDown(textarea(), { key: "Escape" });
		expect(close).toHaveBeenCalledOnce();
	});

	it("Enter selects highlighted skill while picker open", () => {
		const onSkillSelect = vi.fn();
		const props = makeProps();
		const skill = { name: "deploy", filePath: "/skills/deploy.md" };
		render(
			<CockpitPrompt
				{...props}
				onSkillSelect={onSkillSelect}
				picker={{
					...props.picker,
					open: true,
					items: [skill] as never,
					index: 0,
				}}
			/>,
		);
		fireEvent.keyDown(textarea(), { key: "Enter" });
		expect(onSkillSelect).toHaveBeenCalledWith(skill);
	});
});

describe("VoiceButton", () => {
	it("starts voice input on click when ready", () => {
		const voice = makeVoice();
		render(<CockpitPrompt {...makeProps({ voice })} />);
		fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
		expect(voice.start).toHaveBeenCalledOnce();
	});

	it("stops recording on click and offers cancel", () => {
		const voice = makeVoice({ phase: "recording" } as never);
		render(<CockpitPrompt {...makeProps({ voice })} />);
		fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
		expect(voice.stop).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
		expect(voice.cancel).toHaveBeenCalledOnce();
	});

	it("hints enabling voice when disabled in config", () => {
		const props = makeProps();
		render(
			<CockpitPrompt
				{...props}
				config={
					{
						ui: { enter_to_submit: true },
						voice: { enabled: false, hotkey: "" },
					} as unknown as Props["config"]
				}
			/>,
		);
		expect(
			screen
				.getByRole("button", { name: "Start voice input" })
				.getAttribute("title"),
		).toBe("Enable voice in Forge");
	});

	it("surfaces non-ready voice status in title and disables button", () => {
		const voice = makeVoice({
			ready: false,
			status: { state: "loading", model: "base" },
		} as never);
		render(<CockpitPrompt {...makeProps({ voice })} />);
		const btn = screen.getByRole("button", {
			name: "Start voice input",
		}) as HTMLButtonElement;
		expect(btn.title).toBe("Voice loading");
		expect(btn.disabled).toBe(true);
	});

	it("shows voice error banner and dismisses it", () => {
		const voice = makeVoice({ error: "mic not found" } as never);
		render(<CockpitPrompt {...makeProps({ voice })} />);
		expect(
			screen.getByText(/voice transcription failed: mic not found/),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Dismiss voice error" }),
		);
		expect(voice.clearError).toHaveBeenCalledOnce();
	});
});

describe("CockpitPrompt toolbar", () => {
	it("RUN button label flips to QUEUE while running", () => {
		render(<CockpitPrompt {...makeProps({ isRunning: true })} />);
		expect(screen.getByText("QUEUE →")).toBeTruthy();
	});

	it("CLEAR appears only with prompt content and triggers onClear", () => {
		const onClear = vi.fn();
		render(<CockpitPrompt {...makeProps({ onClear })} />);
		expect(screen.queryByText("CLEAR")).toBeNull();
		cleanup();
		render(<CockpitPrompt {...makeProps({ onClear, prompt: "hi" })} />);
		fireEvent.click(screen.getByText("CLEAR"));
		expect(onClear).toHaveBeenCalledOnce();
	});

	it("toggles background and same-session", () => {
		const setBackground = vi.fn();
		const setSameSession = vi.fn();
		render(<CockpitPrompt {...makeProps({ setBackground, setSameSession })} />);
		fireEvent.click(screen.getByLabelText("Background"));
		fireEvent.click(screen.getByLabelText("Same Session"));
		expect(setBackground).toHaveBeenCalledWith(true);
		expect(setSameSession).toHaveBeenCalledWith(true);
	});
});
