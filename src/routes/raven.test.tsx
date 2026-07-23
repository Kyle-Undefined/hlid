// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "#/server/protocol";

const state = vi.hoisted(() => ({
	loaderData: {} as Record<string, unknown>,
	search: {} as Record<string, unknown>,
	navigate: vi.fn(),
	send: vi.fn(),
	subscribeToSession: vi.fn(),
	enqueueChat: vi.fn(),
	sessionState: "idle" as "idle" | "running" | "error",
	wsStatus: "connected" as "connecting" | "connected" | "disconnected",
	actualModel: null as string | null,
	model: "claude-sonnet-4-6",
	effort: "high",
	permissionMode: "default",
	sessions: [] as unknown[],
	onMessage: null as ((message: ServerMessage) => void) | null,
	onAgentChange: null as ((value: string) => void) | null,
	terminalProps: null as null | {
		active: boolean;
		terminateOnDisconnect?: boolean;
		sessionId: string;
	},
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useLoaderData: () => state.loaderData,
		useSearch: () => state.search,
	}),
	useNavigate: () => state.navigate,
}));

vi.mock("#/components/AgentSelect", () => ({
	AgentSelect: ({
		fullWidth,
		onChange,
		value,
	}: {
		fullWidth?: boolean;
		onChange: (value: string) => void;
		value: string;
	}) => {
		state.onAgentChange = onChange;
		return (
			<div
				data-testid="agent-select"
				data-full-width={String(fullWidth)}
				data-value={value}
			/>
		);
	},
}));
vi.mock("#/components/AttachmentStrip", () => ({
	AttachmentStrip: () => null,
}));
vi.mock("#/components/chat/MessageList", () => ({
	MessageList: ({ messages }: { messages: unknown[] }) => (
		<div data-testid="messages">{messages.length}</div>
	),
}));
vi.mock("#/components/cockpit/SlashPicker", () => ({
	SlashPicker: ({
		items,
		onSelect,
	}: {
		items: Array<{ name: string }>;
		onSelect: (item: { name: string }) => void;
	}) =>
		items[0] ? (
			<button type="button" onClick={() => onSelect(items[0])}>
				Select /{items[0].name}
			</button>
		) : null,
}));
vi.mock("#/components/PrivacyMask", () => ({
	PrivacyMask: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("#/components/TerminalView", () => ({
	TerminalView: (props: {
		active: boolean;
		terminateOnDisconnect?: boolean;
		sessionId: string;
	}) => {
		state.terminalProps = props;
		return (
			<div
				data-testid="terminal-view"
				data-active={String(props.active)}
				data-terminate={String(props.terminateOnDisconnect ?? false)}
			/>
		);
	},
}));
vi.mock("#/components/usage/ProviderUsageStrip", () => ({
	ProviderUsageStrip: () => null,
}));
vi.mock("#/components/usage/UsageWindowSections", () => ({
	ContextWindowSection: () => null,
}));

vi.mock("#/hooks/useChatWsHandler", () => ({
	useChatWsHandler: () => vi.fn(),
}));
vi.mock("#/hooks/useLoadChatHistory", () => ({ useLoadChatHistory: vi.fn() }));
vi.mock("#/hooks/useVoiceInput", () => ({
	useVoiceInput: () => ({
		phase: "idle",
		seconds: 0,
		error: null,
		ready: false,
		status: { state: "unavailable", model: "" },
		start: vi.fn(),
		stop: vi.fn(),
		cancel: vi.fn(),
		refresh: vi.fn(),
		clearError: vi.fn(),
	}),
}));
vi.mock("#/hooks/useFileUpload", () => ({
	useFileUpload: () => ({
		pendingAttachments: [],
		uploadingCount: 0,
		uploadError: null,
		gitignoreHint: null,
		uploadFiles: vi.fn(),
		removePending: vi.fn(),
		clearPending: vi.fn(),
		setPendingAttachments: vi.fn(),
		dismissGitignoreHint: vi.fn(),
	}),
}));
vi.mock("#/hooks/useWs", () => ({
	useWs: (onMessage?: (message: ServerMessage) => void) => {
		state.onMessage = onMessage ?? null;
		return {
			wsStatus: state.wsStatus,
			sessionState: state.sessionState,
			model: state.model,
			actualModel: state.actualModel,
			permissionMode: state.permissionMode,
			effort: state.effort,
			runningTurnId: state.sessionState === "running" ? "running" : null,
			send: state.send,
		};
	},
}));
vi.mock("#/hooks/useWsSelectors", () => ({
	useWsLiveStats: () => ({ queries: 0 }),
	useWsChatQueue: () => [],
}));
vi.mock("#/hooks/wsStore", () => ({
	subscribeToSession: state.subscribeToSession,
	enqueueChat: state.enqueueChat,
	removeFromQueue: vi.fn(),
	promoteQueued: vi.fn(),
	seedActualModel: vi.fn(),
	clearMessageBuffer: vi.fn(),
}));
vi.mock("#/hooks/wsChatQueueStore", () => ({
	clearChatQueue: vi.fn(),
}));
vi.mock("#/hooks/wsLiveStatsStore", () => ({
	resetLiveStats: vi.fn(),
}));
vi.mock("#/hooks/wsSessionStatusStore", () => ({
	subscribeSessionsStatus: () => () => {},
	getSessionsStatus: () => state.sessions,
}));
vi.mock("#/lib/serverFns/sessions", () => ({
	ensureSessionFn: vi.fn(),
	getCurrentSessionFn: vi.fn(),
	getLiveSessionsFn: vi.fn(),
	getSessionRowFn: vi.fn(),
	getSessionSelectionFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/agents", () => ({
	getAgentListFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/cockpit", () => ({
	getCockpitData: vi.fn(),
}));
vi.mock("#/lib/serverFns/providers", () => ({
	getProvidersFn: vi.fn(),
	loadProviderUsages: vi.fn(),
}));
vi.mock("#/lib/serverFns/voice", () => ({
	getVoiceInfoFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/config", () => ({ getConfig: vi.fn() }));

import { resetRavenTerminalsForTesting } from "#/hooks/ravenTerminalStore";
import { resetRavenProviderCacheForTesting } from "#/lib/ravenProviderCache";
import { getAgentListFn } from "#/lib/serverFns/agents";
import { getCockpitData } from "#/lib/serverFns/cockpit";
import { getConfig } from "#/lib/serverFns/config";
import { getProvidersFn, loadProviderUsages } from "#/lib/serverFns/providers";
import {
	getCurrentSessionFn,
	getLiveSessionsFn,
	getSessionRowFn,
	getSessionSelectionFn,
} from "#/lib/serverFns/sessions";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";
import { ChatPage, Route } from "./raven";

afterEach(cleanup);

beforeEach(() => {
	vi.clearAllMocks();
	resetRavenProviderCacheForTesting();
	localStorage.clear();
	resetRavenTerminalsForTesting();
	state.sessionState = "idle";
	state.wsStatus = "connected";
	state.actualModel = null;
	state.model = "claude-sonnet-4-6";
	state.effort = "high";
	state.permissionMode = "default";
	state.sessions = [];
	state.onMessage = null;
	state.onAgentChange = null;
	state.terminalProps = null;
	state.search = {};
	state.loaderData = {
		config: {
			vault: { path: "/vault" },
			voice: {
				enabled: false,
				model: "",
				language: "auto",
				auto_send: false,
				hotkey: "Alt+Shift+KeyV",
				max_recording_seconds: 300,
				threads: 4,
				vocabulary: ["Claude", "Codex"],
			},
			ui: { enter_to_submit: true },
			claude: { interactive_mode: false },
			agents: [],
			vault_provider: "claude",
		},
		existingSessionId: null,
		isExplicitSession: false,
		providerUsages: [],
		agentSkillContext: undefined,
		sessionModel: null,
		sessionProviderId: null,
		sessionEffort: null,
		sessionPermissionMode: null,
		agentList: [],
		vaultSkills: [],
		interactiveMode: false,
		providers: [
			{
				id: "claude",
				label: "Claude",
				available: true,
				forkCapability: {
					kind: "exact",
					cutoff: "message",
					wholeSession: true,
					throughMessage: true,
				},
			},
		],
		forkParentSessionId: null,
		forkKind: null,
		voiceInfo: {
			status: { state: "unavailable", model: "" },
			models: [],
		},
	};
});

describe("Raven composed submission behavior", () => {
	it("requests MCP and command metadata automatically when the WebSocket connects", async () => {
		state.wsStatus = "connecting";
		const { rerender } = render(<ChatPage />);
		expect(state.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "probe_mcp" }),
		);

		state.wsStatus = "connected";
		rerender(<ChatPage />);

		await waitFor(() => {
			expect(state.send).toHaveBeenCalledWith({ type: "sync_mcp_list" });
			expect(state.send).toHaveBeenCalledWith({
				type: "probe_mcp",
				session_id: expect.any(String),
			});
			expect(state.send).toHaveBeenCalledWith({
				type: "probe_slash_commands",
				session_id: expect.any(String),
			});
		});
	});

	it("shows the configured agent name for a WSL UNC session path", () => {
		state.loaderData = {
			...state.loaderData,
			agentSkillContext:
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid",
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				agents: [
					{
						path: "/home/kyle/development/repos/hlid",
						name: "Hlid",
					},
				],
			},
			agentList: [],
		};

		render(<ChatPage />);

		expect(screen.getByText("Hlid")).toBeTruthy();
		expect(screen.queryByText(/wsl\.localhost/i)).toBeNull();
	});

	it("recovers agent inventory after the optional loader fallback", async () => {
		vi.mocked(getAgentListFn).mockResolvedValue([
			{
				path: "/home/kyle/development/repos/hlid",
				name: "Hlid",
				provider: "codex",
			},
		] as never);

		render(<ChatPage />);

		await waitFor(() =>
			expect(screen.getByTestId("agent-select")).toBeTruthy(),
		);
		expect(getAgentListFn).toHaveBeenCalledTimes(1);
	});

	it("keeps multiple selected skills outside the textarea and clears them independently", () => {
		state.loaderData = {
			...state.loaderData,
			vaultSkills: [
				{
					file: "review.md",
					name: "review",
					description: "Review changes",
					content: "Review the work",
					filePath: "/vault/skills/review.md",
				},
				{
					file: "release.md",
					name: "release",
					description: "Release changes",
					content: "Release the work",
					filePath: "/vault/skills/release.md",
				},
			],
		};
		render(<ChatPage />);

		const composer = screen.getByRole("combobox");
		fireEvent.change(composer, { target: { value: "/rev" } });
		fireEvent.click(screen.getByRole("button", { name: "Select /review" }));

		expect(screen.getByTestId("active-command").textContent).toContain(
			"skill/review",
		);
		fireEvent.change(composer, { target: { value: "/rel" } });
		fireEvent.click(screen.getByRole("button", { name: "Select /release" }));
		expect(screen.getAllByTestId("active-command")).toHaveLength(2);
		fireEvent.change(composer, { target: { value: "keep this context" } });
		fireEvent.click(
			screen.getByRole("button", { name: "Clear selected skill /review" }),
		);
		expect(screen.getAllByTestId("active-command")).toHaveLength(1);
		expect(screen.getByTestId("active-command").textContent).toContain(
			"skill/release",
		);
		expect((composer as HTMLTextAreaElement).value).toBe("keep this context");
	});

	it("keeps agent selection and all composer modes on-screen at mobile widths", () => {
		state.loaderData = {
			...state.loaderData,
			agentSkillContext: "/codex-project",
			agentList: [
				{
					path: "/codex-project",
					name: "Codex project with a long mobile label",
					provider: "codex",
				},
			],
		};

		render(<ChatPage />);
		fireEvent.click(screen.getByRole("button", { name: "plan" }));

		const agentSelect = screen.getByTestId("agent-select");
		const agentRow = agentSelect.parentElement;
		const terminalButton = screen.getByRole("button", { name: "terminal" });
		const modeRow = terminalButton.parentElement;
		const toolbar = modeRow?.parentElement;

		expect(agentSelect.dataset.fullWidth).toBe("true");
		expect(agentRow?.className).toContain("min-w-0");
		expect(agentRow?.className).toContain("w-full");
		expect(modeRow?.className).toContain("w-full");
		expect(toolbar?.className).toContain("flex-wrap");
		expect(screen.getByRole("button", { name: "html" })).toBeTruthy();
	});

	it("aligns the agent and model badges to the same top edge", () => {
		state.loaderData = {
			...state.loaderData,
			agentSkillContext: "/project",
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				agents: [{ path: "/project", name: "Hlid", provider: "claude" }],
			},
		};
		render(<ChatPage />);

		const agentBadge = screen.getByRole("button", { name: "Hlid" });
		const modelBadge = document.querySelector<HTMLButtonElement>(
			'button[aria-haspopup="dialog"]',
		);

		expect(agentBadge.className).toContain("block");
		expect(modelBadge?.className).toContain("block");
		expect(agentBadge.parentElement?.className).toContain("-top-5");
		expect(modelBadge?.parentElement?.className).toContain("-top-5");
	});

	it("keeps composer controls in DOM order inside the mobile grid", () => {
		render(<ChatPage />);

		const attach = screen.getByRole("button", { name: "Attach file" });
		const voice = screen.getByRole("button", { name: "Start voice input" });
		const activeNote = screen.getByRole("button", {
			name: "Attach active Obsidian note",
		});
		const controlGrid = attach.parentElement;
		const activeNoteContainer = activeNote.parentElement as HTMLElement;

		expect(voice.parentElement).toBe(controlGrid);
		expect(activeNoteContainer?.parentElement).toBe(controlGrid);
		expect(controlGrid?.className).toContain("grid-cols-2");
		expect(controlGrid?.className).toContain("gap-y-1");
		expect(controlGrid?.className).toContain("md:contents");
		expect(attach.className).toContain("py-2");
		expect(voice.className).toContain("py-2");
		expect(attach.className).not.toContain("md:order");
		expect(voice.className).not.toContain("md:order");
		expect(activeNoteContainer?.className).not.toContain("md:order");
		expect(
			attach.compareDocumentPosition(activeNoteContainer) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			activeNoteContainer.compareDocumentPosition(voice) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("places Fork in the left control cluster next to voice", () => {
		render(<ChatPage />);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "create a forkable turn" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		const attach = screen.getByRole("button", { name: "Attach file" });
		const voice = screen.getByRole("button", { name: "Start voice input" });
		const newChat = screen.getByRole("button", { name: "New chat" });
		const fork = screen.getByRole("button", { name: "Fork session" });

		expect(fork.parentElement).toBe(attach.parentElement);
		expect(fork.parentElement).not.toBe(newChat.parentElement);
		expect(
			voice.compareDocumentPosition(fork) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(fork.className).toContain("px-2");
		expect(fork.className).not.toContain("w-full");
	});

	it("offers the same exact-fork action for Codex sessions", () => {
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "codex-session",
			sessionProviderId: "codex",
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					forkCapability: {
						kind: "exact",
						cutoff: "turn",
						wholeSession: true,
						throughMessage: true,
					},
				},
			],
		};
		render(<ChatPage />);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "create a Codex turn" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		expect(screen.getByRole("button", { name: "Fork session" })).toBeTruthy();
	});

	it("shows durable exact-fork provenance with a source-session link", () => {
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "fork-session",
			forkParentSessionId: "source-session",
			forkKind: "exact",
		};
		render(<ChatPage />);

		expect(screen.getByText("Exact fork")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Open source" }));
		expect(state.navigate).toHaveBeenCalledWith({
			to: "/raven",
			search: { session: "source-session", agent: undefined },
		});
	});

	it("makes long mobile drafts independently touch-scrollable", () => {
		render(<ChatPage />);
		const composer = screen.getByRole("combobox");

		expect(composer.className).toContain("overflow-y-auto");
		expect(composer.className).toContain("overscroll-contain");
		expect(composer.className).toContain("touch-pan-y");
		expect(composer.className).toContain("scroll-py-3");
		expect(composer.className).not.toContain("overflow-y-hidden");
	});

	it("top-aligns mobile input text and Run with the control row", () => {
		render(<ChatPage />);
		const composer = screen.getByRole("combobox");
		const run = screen.getByRole("button", { name: "Send" });

		expect(composer.className).toContain("pt-1");
		expect(composer.className).toContain("pb-2");
		expect(composer.className).toContain("md:py-3");
		expect(run.className).toContain("self-start");
		expect(run.className).toContain("py-2");
		expect(run.className).toContain("md:py-3");
	});

	it("stacks Stop and Queue evenly on mobile", () => {
		state.sessionState = "running";
		render(<ChatPage />);

		const stop = screen.getByRole("button", { name: "Abort" });
		const queue = screen.getByRole("button", { name: "Queue message" });
		const actionStack = stop.parentElement;

		expect(queue.parentElement).toBe(actionStack);
		expect(actionStack?.className).toContain("grid-rows-2");
		expect(actionStack?.className).toContain("gap-y-1");
		expect(actionStack?.className).toContain("md:contents");
		expect(stop.className).toContain("py-2");
		expect(queue.className).toContain("py-2");
		expect(stop.className).toContain("w-full");
		expect(queue.className).toContain("w-full");
		expect(stop.className).toContain("md:w-auto");
		expect(queue.className).toContain("md:w-auto");
	});

	it("keeps mobile terminal tab content above the composer while desktop orders it last", () => {
		render(<ChatPage />);

		fireEvent.click(screen.getByRole("button", { name: "terminal" }));

		const terminal = screen.getByTestId("terminal-view");
		const composer = screen.getByRole("combobox");
		const terminalPane = terminal.parentElement;
		const terminalTabs = screen.getAllByRole("button", { name: "terminal" });

		expect(
			terminal.compareDocumentPosition(composer) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			terminalTabs[0].compareDocumentPosition(terminal) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(terminalPane?.className).toContain("md:order-last");
	});

	it("keeps following async tool-card growth until the reader wheels away", () => {
		let resizeCallback: ResizeObserverCallback | null = null;
		const frames: FrameRequestCallback[] = [];
		class MockResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				resizeCallback = callback;
			}
			observe() {}
			disconnect() {}
			unobserve() {}
		}
		vi.stubGlobal("ResizeObserver", MockResizeObserver);
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				frames.push(callback);
				return frames.length;
			});

		try {
			render(<ChatPage />);
			act(() => {
				while (frames.length > 0) frames.shift()?.(0);
			});
			const scroller = document.querySelector(
				'[data-scroll-restoration-id="raven-transcript"]',
			) as HTMLDivElement;
			let scrollHeight = 1_000;
			Object.defineProperty(scroller, "scrollHeight", {
				configurable: true,
				get: () => scrollHeight,
			});
			Object.defineProperty(scroller, "clientHeight", {
				configurable: true,
				value: 500,
			});
			scroller.scrollTop = 500;
			scroller.scrollTo = vi.fn(({ top }) => {
				scroller.scrollTop = Number(top);
			});

			scrollHeight = 1_200;
			act(() => {
				resizeCallback?.([], {} as ResizeObserver);
				frames.shift()?.(16);
			});
			expect(scroller.scrollTop).toBe(1_200);

			scroller.scrollTop = 900;
			fireEvent.wheel(scroller, { deltaY: -20 });
			scrollHeight = 1_400;
			act(() => {
				resizeCallback?.([], {} as ResizeObserver);
				frames.shift()?.(32);
			});
			expect(scroller.scrollTop).toBe(900);
		} finally {
			requestFrame.mockRestore();
			vi.unstubAllGlobals();
		}
	});

	it("restores an open project terminal after navigating away without terminating it", () => {
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "saved-session",
			isExplicitSession: true,
		};

		render(<ChatPage />);
		fireEvent.click(screen.getByRole("button", { name: "terminal" }));

		expect(state.terminalProps).toMatchObject({
			active: true,
			terminateOnDisconnect: false,
			sessionId: "saved-session",
		});

		cleanup();
		state.terminalProps = null;
		render(<ChatPage />);

		expect(state.terminalProps).toMatchObject({
			active: true,
			terminateOnDisconnect: false,
			sessionId: "saved-session",
		});
		const chatTab = screen.getByRole("button", { name: "chat" });
		expect(chatTab.className).toContain("text-primary");
		expect(
			document.querySelector('[data-scroll-restoration-id="raven-transcript"]')
				?.className,
		).not.toContain("hidden md:block");
		expect(
			screen.getByTestId("terminal-view").parentElement?.className,
		).toContain("hidden md:flex");

		fireEvent.click(screen.getByTitle(/open a real terminal in this project/i));
		expect(state.terminalProps).toMatchObject({
			active: false,
			terminateOnDisconnect: true,
			sessionId: "saved-session",
		});
	});

	it("shows the selected Einherjar model, effort, and permission instead of stale vault state", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				agents: [
					{
						path: "/codex-project",
						provider: "codex",
						model: "gpt-5.4",
						effort: "low",
						permission_mode: "bypassPermissions",
					},
				],
			},
			agentSkillContext: "/codex-project",
			agentList: [
				{
					path: "/codex-project",
					name: "Codex project",
					provider: "codex",
					model: "gpt-5.4",
				},
			],
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [{ value: "gpt-5.4", label: "GPT-5.4" }],
					effortLevels: [{ value: "low", label: "Low" }],
					permissionModes: [
						{ value: "bypassPermissions", label: "Auto-approve all" },
					],
				},
			],
		};

		render(<ChatPage />);

		const badge = screen.getByRole("button", {
			name: /gpt-5\.4.*low.*auto/i,
		});
		expect(badge).toBeTruthy();
		expect(badge.textContent).not.toMatch(/claude|medium/i);
	});

	it("keeps the CLIProxy model badge compact on mobile", () => {
		state.actualModel = "gpt-5.6-sol(high)";
		state.model = "gpt-5.6-sol";
		state.effort = "high";
		state.permissionMode = "bypassPermissions";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				agents: [
					{
						path: "/cliproxy-project",
						provider: "cliproxy-codex",
						model: "gpt-5.6-sol",
						effort: "high",
						permission_mode: "bypassPermissions",
					},
				],
			},
			agentSkillContext: "/cliproxy-project",
			agentList: [
				{
					path: "/cliproxy-project",
					name: "CLIProxy project",
					provider: "cliproxy-codex",
					model: "gpt-5.6-sol",
				},
			],
			providers: [
				{
					id: "cliproxy-codex",
					label: "Claude Code · CLIProxy",
					available: true,
					models: [{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
					effortLevels: [{ value: "high", label: "High" }],
					permissionModes: [
						{ value: "bypassPermissions", label: "Auto-approve all" },
					],
				},
			],
		};

		render(<ChatPage />);

		const badge = screen.getByRole("button", {
			name: /Claude Code.*CLIProxy.*gpt-5\.6-sol.*high.*auto/i,
		});
		expect(badge.className).toContain("max-w-full");
		expect(badge.parentElement?.className).toContain(
			"max-w-[calc(100vw-1.5rem)]",
		);
		expect(
			screen.getByText("CLIProxy · gpt-5.6-sol · high · auto"),
		).toBeTruthy();
		expect(badge.className).not.toContain("text-amber");
	});

	it("keeps model settings open while changing multiple options", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
			},
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [
						{ value: "gpt-5.4", label: "GPT-5.4" },
						{ value: "gpt-5.5", label: "GPT-5.5" },
					],
					effortLevels: [
						{ value: "medium", label: "Medium" },
						{ value: "high", label: "High" },
					],
					permissionModes: [
						{ value: "default", label: "Ask" },
						{ value: "bypassPermissions", label: "Auto-approve all" },
					],
				},
			],
		};

		render(<ChatPage />);
		fireEvent.click(screen.getByRole("button", { name: /sonnet 4\.6/i }));

		fireEvent.click(screen.getByRole("button", { name: "GPT-5.5" }));
		expect(screen.getByRole("dialog", { name: "Model settings" })).toBeTruthy();
		expect(state.send).toHaveBeenCalledWith({
			type: "set_model",
			model: "gpt-5.5",
			session_id: expect.any(String),
		});

		fireEvent.click(screen.getByRole("button", { name: "High" }));
		expect(screen.getByRole("dialog", { name: "Model settings" })).toBeTruthy();
		expect(state.send).toHaveBeenCalledWith({
			type: "set_effort",
			effort: "high",
			session_id: expect.any(String),
		});

		fireEvent.focus(screen.getByRole("combobox"));
		expect(screen.queryByRole("dialog", { name: "Model settings" })).toBeNull();
	});

	it("switches the current chat to any available CLI without changing config", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				claude: {
					interactive_mode: false,
					model: "claude-sonnet-4-6",
					effort: "high",
					permission_mode: "default",
				},
			},
			providers: [
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" }],
				},
				{
					id: "pi",
					label: "Pi",
					available: true,
					models: [{ value: "pi-pro", label: "Pi Pro", isDefault: true }],
					effortLevels: [{ value: "medium", label: "Medium" }],
					permissionModes: [{ value: "default", label: "Ask" }],
				},
			],
		};

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", { name: /claude.*sonnet 4\.6/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Pi" }));

		expect(state.send).toHaveBeenCalledWith({
			type: "set_provider",
			provider: "pi",
			model: "pi-pro",
			effort: "medium",
			permission_mode: "default",
			session_id: expect.any(String),
		});
		expect(
			screen.getByRole("button", { name: /pi.*pi-pro.*medium.*ask/i }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Pi Pro (default)" }),
		).toBeTruthy();
	});

	it("does not highlight equivalent Fable family identifiers as different", () => {
		state.actualModel = "claude-fable-5";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				claude: {
					interactive_mode: false,
					model: "fable-5[1m]",
					effort: "high",
					permission_mode: "default",
				},
			},
			providers: [
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [{ value: "fable-5[1m]", label: "Fable" }],
				},
			],
		};

		render(<ChatPage />);
		const badge = screen.getByRole("button", { name: /claude.*fable-5/i });
		expect(badge.className).not.toContain("text-amber");
		fireEvent.click(badge);
		expect(screen.queryByText("configured")).toBeNull();
		expect(screen.queryByText("current")).toBeNull();
	});

	it("restores an agent session's saved provider and model instead of current config", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
				codex: { model: "gpt-5.6-terra" },
				agents: [
					{
						path: "/hlid",
						provider: "codex",
						model: "gpt-5.6-sol",
					},
				],
			},
			existingSessionId: "saved-session",
			agentSkillContext: "/hlid",
			sessionModel: "claude-fable-5",
			sessionProviderId: "claude",
			agentList: [
				{
					path: "/hlid",
					name: "Hlid",
					provider: "codex",
					model: "gpt-5.6-sol",
				},
			],
			providers: [
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [{ value: "claude-fable-5", label: "Fable" }],
				},
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [
						{ value: "gpt-5.6-sol", label: "Sol" },
						{ value: "gpt-5.6-terra", label: "Terra" },
					],
				},
			],
		};

		render(<ChatPage />);

		const badge = screen.getByRole("button", { name: /fable-5/i });
		expect(badge).toBeTruthy();
		fireEvent.click(badge);
		expect(screen.getByRole("button", { name: "Fable" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Sol" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Terra" })).toBeNull();
		expect(screen.queryByText("selected")).toBeNull();
		expect(screen.queryByText("actual")).toBeNull();
		expect(screen.getByText("configured")).toBeTruthy();
		expect(screen.getByText("current")).toBeTruthy();
	});

	it("restores a live session's model, effort, and permission after refresh", () => {
		state.model = "gpt-5.5";
		state.effort = "xhigh";
		state.permissionMode = "bypassPermissions";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
				codex: {
					model: "gpt-5.4",
					effort: "high",
					permission_mode: "default",
				},
			},
			existingSessionId: "db-session",
			isExplicitSession: true,
			sessionModel: "gpt-5.4",
			sessionProviderId: "codex",
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [
						{ value: "gpt-5.4", label: "GPT-5.4" },
						{ value: "gpt-5.5", label: "GPT-5.5" },
					],
					effortLevels: [
						{ value: "high", label: "High" },
						{ value: "xhigh", label: "X-High" },
					],
					permissionModes: [
						{ value: "default", label: "Ask" },
						{ value: "bypassPermissions", label: "Auto-approve all" },
					],
				},
			],
		};
		state.sessions = [
			{
				session_id: "pool-session",
				db_session_id: "db-session",
				mode: "sdk",
				state: "idle",
				model: "gpt-5.5",
				effort: "xhigh",
				permission_mode: "bypassPermissions",
			},
		];

		render(<ChatPage />);

		expect(
			screen.getByRole("button", {
				name: /codex.*gpt-5\.5.*xhigh.*auto/i,
			}),
		).toBeTruthy();
	});

	it("binds a database transcript to its matching live pool session", () => {
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "db-session",
			isExplicitSession: true,
		};
		state.sessions = [
			{
				session_id: "pool-session",
				db_session_id: "db-session",
				mode: "chat",
				state: "running",
			},
		];

		render(<ChatPage />);

		expect(state.subscribeToSession).toHaveBeenCalledWith("pool-session");
	});

	it("accepts runtime MCP updates tagged with the live pool session", () => {
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "db-session",
			isExplicitSession: true,
		};
		state.sessions = [
			{
				session_id: "pool-session",
				db_session_id: "db-session",
				mode: "chat",
				state: "idle",
			},
		];
		render(<ChatPage />);

		act(() => {
			state.onMessage?.({
				type: "mcp_status",
				provider_id: "claude",
				session_id: "pool-session",
				servers: [
					{
						name: "claude.ai Excalidraw",
						status: "connected",
						scope: "claudeai",
					},
				],
			});
		});

		expect(
			screen.getByRole("button", { name: "MCP server status" }).textContent,
		).toContain("1/1");
	});

	it("ignores vault MCP updates from a different provider than the archived session", () => {
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "archived-claude-session",
			isExplicitSession: true,
			sessionProviderId: "claude",
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				vault_provider: "codex",
			},
		};
		render(<ChatPage />);

		act(() => {
			state.onMessage?.({
				type: "mcp_status",
				provider_id: "codex",
				servers: [
					{ name: "codex_apps", status: "connected", scope: "global" },
					{ name: "node_repl", status: "connected", scope: "global" },
				],
			});
		});

		expect(
			screen.getByRole("button", { name: "MCP server status" }).textContent,
		).toContain("0");
	});

	it("sends an idle message through the WebSocket boundary", () => {
		render(<ChatPage />);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "hello watcher" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(state.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chat",
				text: "hello watcher",
				session_id: expect.any(String),
			}),
		);
		expect(screen.getByTestId("messages").textContent).toBe("1");
	});

	it("queues a message while a turn is running", () => {
		state.sessionState = "running";
		render(<ChatPage />);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "next request" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
		expect(state.enqueueChat).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "next request",
				session_id: expect.any(String),
			}),
		);
		expect(state.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "chat" }),
		);
	});

	it("keeps a new chat and its agent selected across Raven reloads", async () => {
		state.search = { session: "previous-chat", agent: "/old-project" };
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "previous-chat",
			isExplicitSession: true,
			agentSkillContext: "/old-project",
			agentList: [
				{ path: "/old-project", name: "Old project", provider: "claude" },
				{ path: "/new-project", name: "New project", provider: "claude" },
			],
		};

		render(<ChatPage />);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "create a visible message" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		fireEvent.click(screen.getByRole("button", { name: "New chat" }));

		const newChatNavigation = state.navigate.mock.calls
			.map(([options]) => options as { search?: unknown })
			.reverse()
			.find((options) => {
				if (typeof options.search !== "function") return false;
				const next = options.search(state.search) as Record<string, unknown>;
				return next.session !== "previous-chat" && next.agent === undefined;
			});
		expect(newChatNavigation).toBeTruthy();
		const newSearch = (
			newChatNavigation?.search as (
				previous: Record<string, unknown>,
			) => Record<string, unknown>
		)(state.search);
		expect(localStorage.getItem("hlid:raven:last-session")).toBe(
			newSearch.session,
		);

		const navigationCount = state.navigate.mock.calls.length;
		act(() => state.onAgentChange?.("/new-project"));
		expect(state.navigate).toHaveBeenCalledTimes(navigationCount);
		expect(new URL(window.location.href).searchParams.get("agent")).toBeNull();
		expect(localStorage.getItem("hlid:raven:last-agent")).toBe("/new-project");

		cleanup();
		state.search = newSearch;
		state.loaderData = {
			...state.loaderData,
			existingSessionId: newSearch.session,
			agentSkillContext: undefined,
		};
		render(<ChatPage />);
		await waitFor(() =>
			expect(screen.getByTestId("agent-select").dataset.value).toBe(
				"/new-project",
			),
		);
	});

	it("does not swap a newly selected route back to the previous chat", () => {
		state.search = { session: "chat-a" };
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "chat-a",
			isExplicitSession: true,
		};
		const view = render(<ChatPage />);
		state.navigate.mockClear();

		state.search = { session: "chat-b" };
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "chat-b",
		};
		view.rerender(<ChatPage />);

		expect(state.navigate).not.toHaveBeenCalled();
		expect(localStorage.getItem("hlid:raven:last-session")).toBe("chat-b");
	});
});

describe("Raven composer keyboard", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: false })),
		);
	});

	afterEach(() => vi.unstubAllGlobals());

	it("Enter submits the composer when enter_to_submit is on", () => {
		render(<ChatPage />);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "keyboard send" },
		});
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(state.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: "chat", text: "keyboard send" }),
		);
	});

	it("Shift+Enter inserts a newline instead of sending", () => {
		render(<ChatPage />);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "multi line" },
		});
		fireEvent.keyDown(screen.getByRole("combobox"), {
			key: "Enter",
			shiftKey: true,
		});
		expect(state.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "chat" }),
		);
	});
});

// ─── route loader ─────────────────────────────────────────────────────────────

type RouteShape = {
	validateSearch: (search: Record<string, unknown>) => Record<string, unknown>;
	loaderDeps: (input: { search: Record<string, unknown> }) => {
		session?: string;
		agent?: string;
	};
	loader: (input: {
		deps: { session?: string; agent?: string };
	}) => Promise<Record<string, unknown>>;
	pendingMs?: number;
	pendingComponent?: React.ComponentType;
};

const route = Route as unknown as RouteShape;

function makeLoaderConfig(overrides?: Record<string, unknown>) {
	return {
		vault: { path: "/vault" },
		claude: { interactive_mode: false },
		agents: [],
		...overrides,
	};
}

describe("raven route search/deps", () => {
	it("replaces the previous transcript immediately while a session load is pending", () => {
		expect(route.pendingMs).toBe(0);
		const Pending = route.pendingComponent;
		expect(Pending).toBeTypeOf("function");
		if (!Pending) throw new Error("missing Raven pending component");
		render(<Pending />);
		expect(screen.getByTestId("raven-session-pending")).toBeTruthy();
	});

	it("validateSearch keeps only string params", () => {
		expect(
			route.validateSearch({
				session: 1,
				agent: "/proj",
				prompt: {},
				extra: "dropped",
			}),
		).toEqual({ agent: "/proj" });
		expect(route.validateSearch({ session: "s", prompt: "p" })).toEqual({
			session: "s",
			prompt: "p",
		});
	});

	it("loaderDeps extracts session and agent", () => {
		expect(
			route.loaderDeps({ search: { session: "s", agent: "a", prompt: "p" } }),
		).toEqual({ session: "s", agent: "a" });
	});
});

describe("raven route loader", () => {
	beforeEach(() => {
		vi.mocked(getConfig).mockResolvedValue(makeLoaderConfig() as never);
		vi.mocked(getAgentListFn).mockResolvedValue([] as never);
		vi.mocked(getCockpitData).mockResolvedValue({ skills: [] } as never);
		vi.mocked(getProvidersFn).mockResolvedValue([] as never);
		vi.mocked(getVoiceInfoFn).mockResolvedValue({
			status: { state: "unavailable", model: "" },
			models: [],
		} as never);
		vi.mocked(loadProviderUsages).mockResolvedValue([] as never);
		vi.mocked(getLiveSessionsFn).mockResolvedValue([] as never);
		vi.mocked(getCurrentSessionFn).mockResolvedValue(null as never);
		vi.mocked(getSessionRowFn).mockResolvedValue(null as never);
		vi.mocked(getSessionSelectionFn).mockResolvedValue(null as never);
	});

	it("uses the explicit session without consulting live sessions", async () => {
		const data = await route.loader({ deps: { session: "s1" } });
		expect(data.existingSessionId).toBe("s1");
		expect(data.isExplicitSession).toBe(true);
		expect(getLiveSessionsFn).not.toHaveBeenCalled();
	});

	it("does not let a stalled provider catalog hold Raven navigation pending", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(getProvidersFn).mockImplementation(() => new Promise(() => {}));
			const pending = route.loader({ deps: { session: "s1" } });
			await vi.advanceTimersByTimeAsync(501);
			const data = await pending;
			expect(data.existingSessionId).toBe("s1");
			expect(data.providers).toEqual([]);
			expect(getProvidersFn).toHaveBeenCalledWith({
				data: { preferCachedModels: true },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("shares a stalled provider read across session switches", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(getProvidersFn).mockImplementation(() => new Promise(() => {}));
			const first = route.loader({ deps: { session: "switch-test-a" } });
			await vi.advanceTimersByTimeAsync(501);
			const firstData = await first;

			const second = route.loader({ deps: { session: "switch-test-b" } });
			await vi.advanceTimersByTimeAsync(501);
			const secondData = await second;

			expect(firstData.existingSessionId).toBe("switch-test-a");
			expect(secondData.existingSessionId).toBe("switch-test-b");
			expect(getProvidersFn).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not let optional agent, skill, or voice inventory hold navigation pending", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(getAgentListFn).mockImplementation(() => new Promise(() => {}));
			vi.mocked(getCockpitData).mockImplementation(() => new Promise(() => {}));
			vi.mocked(getVoiceInfoFn).mockImplementation(() => new Promise(() => {}));
			const pending = route.loader({ deps: { session: "s1" } });
			await vi.advanceTimersByTimeAsync(501);
			const data = await pending;
			expect(data.existingSessionId).toBe("s1");
			expect(data.agentList).toEqual([]);
			expect(data.vaultSkills).toEqual([]);
			expect(data.voiceInfo).toEqual({
				status: { state: "unavailable", model: "" },
				models: [],
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not let stalled provider usage hold Raven navigation pending", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(getProvidersFn).mockResolvedValue([
				{ id: "codex", label: "Codex", available: true },
			] as never);
			vi.mocked(loadProviderUsages).mockImplementation(
				() => new Promise(() => {}),
			);
			const pending = route.loader({ deps: { session: "s1" } });
			await vi.advanceTimersByTimeAsync(501);
			const data = await pending;
			expect(data.existingSessionId).toBe("s1");
			expect(data.providerUsages).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back to the newest live SDK session", async () => {
		vi.mocked(getLiveSessionsFn).mockResolvedValue([
			{ mode: "chat", db_session_id: "old-sdk" },
			{ mode: "terminal", db_session_id: "term" },
			{ mode: "chat", db_session_id: "new-sdk" },
		] as never);
		const data = await route.loader({ deps: {} });
		expect(data.existingSessionId).toBe("new-sdk");
		expect(getCurrentSessionFn).not.toHaveBeenCalled();
	});

	it("falls back to the current DB session when no live SDK session exists", async () => {
		vi.mocked(getCurrentSessionFn).mockResolvedValue("cur" as never);
		const data = await route.loader({ deps: {} });
		expect(data.existingSessionId).toBe("cur");
	});

	it("derives the agent skill context from the resolved session cwd", async () => {
		vi.mocked(getCurrentSessionFn).mockResolvedValue("cur" as never);
		vi.mocked(getSessionSelectionFn).mockResolvedValue({
			agentCwd: "/proj",
			providerId: null,
			model: null,
			effort: null,
			permissionMode: null,
		} as never);
		const data = await route.loader({ deps: {} });
		expect(data.agentSkillContext).toBe("/proj");
		expect(getSessionSelectionFn).toHaveBeenCalledWith({ data: "cur" });
	});

	it("restores all controls selected for the resolved session", async () => {
		vi.mocked(getCurrentSessionFn).mockResolvedValue("cur" as never);
		vi.mocked(getSessionSelectionFn).mockResolvedValue({
			agentCwd: "/proj",
			providerId: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "bypassPermissions",
		} as never);
		const data = await route.loader({ deps: {} });
		expect(data).toMatchObject({
			agentSkillContext: "/proj",
			sessionModel: "gpt-5.6-sol",
			sessionProviderId: "codex",
			sessionEffort: "high",
			sessionPermissionMode: "bypassPermissions",
		});
		expect(getSessionSelectionFn).toHaveBeenCalledWith({ data: "cur" });
	});

	it("loads durable fork provenance for the resolved session", async () => {
		vi.mocked(getCurrentSessionFn).mockResolvedValue("fork" as never);
		vi.mocked(getSessionRowFn).mockResolvedValue({
			fork_parent_session_id: "source",
			fork_kind: "exact",
		} as never);

		const data = await route.loader({ deps: {} });

		expect(data).toMatchObject({
			forkParentSessionId: "source",
			forkKind: "exact",
		});
		expect(getSessionRowFn).toHaveBeenCalledWith({ data: "fork" });
	});

	it("attaches to a running terminal session in interactive vault mode", async () => {
		vi.mocked(getConfig).mockResolvedValue(
			makeLoaderConfig({ claude: { interactive_mode: true } }) as never,
		);
		vi.mocked(getLiveSessionsFn).mockResolvedValue([
			{
				mode: "terminal",
				state: "running",
				agent_cwd: "/vault",
				session_id: "term-live",
				db_session_id: "term-db",
			},
			{
				mode: "terminal",
				state: "idle",
				agent_cwd: "/vault",
				session_id: "idle-term",
			},
		] as never);
		const data = await route.loader({ deps: {} });
		expect(data.interactiveMode).toBe(true);
		expect(data.existingSessionId).toBe("term-db");
	});

	it("honors per-agent interactive_mode override", async () => {
		vi.mocked(getConfig).mockResolvedValue(
			makeLoaderConfig({
				agents: [{ path: "/proj", interactive_mode: true }],
			}) as never,
		);
		vi.mocked(getLiveSessionsFn).mockResolvedValue([
			{
				mode: "terminal",
				state: "running",
				agent_cwd: "/proj",
				session_id: "proj-term",
			},
		] as never);
		const data = await route.loader({ deps: { agent: "/proj" } });
		expect(data.interactiveMode).toBe(true);
		// falls back to session_id when the terminal has no DB session yet
		expect(data.existingSessionId).toBe("proj-term");
	});

	it("returns null session in interactive mode with no live terminal", async () => {
		vi.mocked(getConfig).mockResolvedValue(
			makeLoaderConfig({ claude: { interactive_mode: true } }) as never,
		);
		const data = await route.loader({ deps: {} });
		expect(data.existingSessionId).toBeNull();
		expect(getCurrentSessionFn).not.toHaveBeenCalled();
	});
});
