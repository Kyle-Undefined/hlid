// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	loaderData: {} as Record<string, unknown>,
	search: {} as Record<string, unknown>,
	navigate: vi.fn(),
	send: vi.fn(),
	subscribeToSession: vi.fn(),
	enqueueChat: vi.fn(),
	sessionState: "idle" as "idle" | "running" | "error",
	sessions: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useLoaderData: () => state.loaderData,
		useSearch: () => state.search,
	}),
	useNavigate: () => state.navigate,
}));

vi.mock("#/components/AgentSelect", () => ({ AgentSelect: () => null }));
vi.mock("#/components/AttachmentStrip", () => ({
	AttachmentStrip: () => null,
}));
vi.mock("#/components/chat/MessageList", () => ({
	MessageList: ({ messages }: { messages: unknown[] }) => (
		<div data-testid="messages">{messages.length}</div>
	),
}));
vi.mock("#/components/cockpit/SlashPicker", () => ({
	SlashPicker: () => null,
}));
vi.mock("#/components/PrivacyMask", () => ({
	PrivacyMask: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("#/components/TerminalView", () => ({ TerminalView: () => null }));
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
	useWs: () => ({
		wsStatus: "connected",
		sessionState: state.sessionState,
		model: "claude-sonnet-4-6",
		actualModel: null,
		permissionMode: "default",
		runningTurnId: state.sessionState === "running" ? "running" : null,
		send: state.send,
	}),
}));
vi.mock("#/hooks/useWsSelectors", () => ({
	useWsLiveStats: () => ({ queries: 0 }),
	useWsChatQueue: () => [],
}));
vi.mock("#/hooks/wsStore", () => ({
	subscribeSessionsStatus: () => () => {},
	getSessionsStatus: () => state.sessions,
	subscribeToSession: state.subscribeToSession,
	enqueueChat: state.enqueueChat,
	removeFromQueue: vi.fn(),
	promoteQueued: vi.fn(),
	resetLiveStats: vi.fn(),
	seedActualModel: vi.fn(),
	clearMessageBuffer: vi.fn(),
	clearChatQueue: vi.fn(),
}));
vi.mock("#/lib/serverFns/sessions", () => ({
	ensureSessionFn: vi.fn(),
	getCurrentSessionFn: vi.fn(),
	getLiveSessionsFn: vi.fn(),
	getSessionAgentCwdFn: vi.fn(),
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
vi.mock("#/config", () => ({ getConfig: vi.fn() }));

import { getConfig } from "#/config";
import { getCockpitData } from "#/lib/serverFns/cockpit";
import { getProvidersFn, loadProviderUsages } from "#/lib/serverFns/providers";
import {
	getCurrentSessionFn,
	getLiveSessionsFn,
	getSessionAgentCwdFn,
} from "#/lib/serverFns/sessions";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";
import { ChatPage, Route } from "./raven";

afterEach(cleanup);

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	state.sessionState = "idle";
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
		vi.mocked(getSessionAgentCwdFn).mockResolvedValue(null as never);
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
		vi.mocked(getSessionAgentCwdFn).mockResolvedValue("/proj" as never);
		const data = await route.loader({ deps: {} });
		expect(data.agentSkillContext).toBe("/proj");
		expect(getSessionAgentCwdFn).toHaveBeenCalledWith({ data: "cur" });
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
