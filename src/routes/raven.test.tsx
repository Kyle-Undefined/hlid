// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
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
	}: {
		fullWidth?: boolean;
		onChange: (value: string) => void;
	}) => {
		state.onAgentChange = onChange;
		return (
			<div data-testid="agent-select" data-full-width={String(fullWidth)} />
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
			wsStatus: "connected",
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
import { getCockpitData } from "#/lib/serverFns/cockpit";
import { getConfig } from "#/lib/serverFns/config";
import { getProvidersFn, loadProviderUsages } from "#/lib/serverFns/providers";
import {
	getCurrentSessionFn,
	getLiveSessionsFn,
	getSessionSelectionFn,
} from "#/lib/serverFns/sessions";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";
import { ChatPage, Route } from "./raven";

afterEach(cleanup);

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	resetRavenTerminalsForTesting();
	state.sessionState = "idle";
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
		providers: [{ id: "claude", label: "Claude", available: true }],
		voiceInfo: {
			status: { state: "unavailable", model: "" },
			models: [],
		},
	};
});

describe("Raven composed submission behavior", () => {
	it("shows the selected skill outside the textarea and clears only the selection", () => {
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
			],
		};
		render(<ChatPage />);

		const composer = screen.getByRole("combobox");
		fireEvent.change(composer, { target: { value: "/rev" } });
		fireEvent.click(screen.getByRole("button", { name: "Select /review" }));

		expect(screen.getByTestId("active-command").textContent).toContain(
			"skill/review",
		);
		fireEvent.change(composer, { target: { value: "keep this context" } });
		fireEvent.click(
			screen.getByRole("button", { name: "Clear selected skill /review" }),
		);
		expect(screen.queryByTestId("active-command")).toBeNull();
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

	it("keeps a new chat and its agent selected across Raven reloads", () => {
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

		act(() => state.onAgentChange?.("/new-project"));
		const agentNavigation = state.navigate.mock.calls.at(-1)?.[0] as {
			search: (previous: Record<string, unknown>) => Record<string, unknown>;
		};
		expect(agentNavigation.search(newSearch)).toEqual({
			session: newSearch.session,
			agent: "/new-project",
		});
		expect(localStorage.getItem("hlid:raven:last-agent")).toBe("/new-project");
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
		vi.mocked(getCockpitData).mockResolvedValue({ skills: [] } as never);
		vi.mocked(getProvidersFn).mockResolvedValue([] as never);
		vi.mocked(getVoiceInfoFn).mockResolvedValue({
			status: { state: "unavailable", model: "" },
			models: [],
		} as never);
		vi.mocked(loadProviderUsages).mockResolvedValue([] as never);
		vi.mocked(getLiveSessionsFn).mockResolvedValue([] as never);
		vi.mocked(getCurrentSessionFn).mockResolvedValue(null as never);
		vi.mocked(getSessionSelectionFn).mockResolvedValue(null as never);
	});

	it("uses the explicit session without consulting live sessions", async () => {
		const data = await route.loader({ deps: { session: "s1" } });
		expect(data.existingSessionId).toBe("s1");
		expect(data.isExplicitSession).toBe(true);
		expect(getLiveSessionsFn).not.toHaveBeenCalled();
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
