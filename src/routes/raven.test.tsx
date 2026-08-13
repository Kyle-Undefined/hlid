// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSessionSwitcherBoundary } from "#/components/chat/LiveSessionSwitcher";
import {
	getDataRevisionSnapshot,
	replaceDataRevisions,
	resetDataRevisionsForTesting,
} from "#/hooks/wsDataRevisionStore";
import type {
	ProjectPreviewSnapshot,
	ServerMessage,
	SessionStatusEntry,
} from "#/server/protocol";

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
	approvalsReviewer: "user" as "user" | "auto_review" | null,
	sessions: [] as unknown[],
	onMessage: null as ((message: ServerMessage) => void) | null,
	handleChatWsMessage: vi.fn(),
	chatDispatch: null as null | ((action: Record<string, unknown>) => void),
	onAgentChange: null as ((value: string) => void) | null,
	voiceOptions: null as null | {
		onTranscription?: (text: string) => void;
		onAudioTurn?: (audio: Blob) => void | Promise<void>;
		codexTurnAvailable?: boolean;
		codexTurnUnavailableReason?: string;
		codexDictation?: {
			available: boolean;
			unavailableReason?: string;
			phase: "idle" | "starting" | "connected" | "stopping" | "error";
			error: string | null;
			start: () => Promise<void>;
			stop: () => void;
			cancel: () => void;
			clearError: () => void;
		};
	},
	voiceError: null as string | null,
	voiceClearError: vi.fn(),
	voicePhase: "idle" as
		| "idle"
		| "starting"
		| "recording"
		| "transcribing"
		| "submitting"
		| "error",
	voiceEngine: "local" as "local" | "codex" | "codex_dictation",
	voiceReady: false,
	voiceStart: vi.fn(),
	voiceStop: vi.fn(),
	voiceCancel: vi.fn(),
	realtimeMode: null as "dictation" | "read-aloud" | "live" | null,
	realtimePhase: "idle" as
		| "idle"
		| "starting"
		| "connected"
		| "stopping"
		| "error",
	realtimeLiveMicrophoneMuted: false,
	realtimeError: null as string | null,
	realtimeUnavailableReason: null as string | null,
	realtimeOptions: null as null | {
		onDictation?: (text: string) => void;
		onLiveClosed?: () => void;
	},
	realtimeStart: vi.fn(),
	realtimeStop: vi.fn(),
	realtimeCancel: vi.fn(),
	realtimeToggleLiveMicrophone: vi.fn(),
	realtimeClearError: vi.fn(),
	uploadVoiceRecording: vi.fn(),
	terminalProps: null as null | {
		active: boolean;
		terminateOnDisconnect?: boolean;
		sessionId: string;
	},
	preview: null as ProjectPreviewSnapshot | null,
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
vi.mock("#/components/chat/SessionNotificationOverrideControl", () => ({
	SessionNotificationOverrideControl: ({
		sessionId,
	}: {
		sessionId: string;
	}) => <div data-testid="session-notification-override">{sessionId}</div>,
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
	PrivacyMask: ({
		children,
		inline,
		className,
	}: {
		children: React.ReactNode;
		inline?: boolean;
		className?: string;
	}) =>
		inline ? (
			<span className={className} data-privacy-mask="true">
				{children}
			</span>
		) : (
			children
		),
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
	useChatWsHandler: ({
		dispatch,
	}: {
		dispatch: (action: Record<string, unknown>) => void;
	}) => {
		state.chatDispatch = dispatch;
		return state.handleChatWsMessage;
	},
}));
vi.mock("#/hooks/useLoadChatHistory", () => ({ useLoadChatHistory: vi.fn() }));
vi.mock("#/hooks/useNotificationPresence", () => ({
	useNotificationPresence: vi.fn(),
}));
vi.mock("#/hooks/projectPreviewStore", () => ({
	useProjectPreview: () => state.preview,
	useProjectPreviewPresentationRequest: () => 0,
}));
vi.mock("#/hooks/codexRealtimeStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/hooks/codexRealtimeStore")>()),
	useCodexRealtime: (options: typeof state.realtimeOptions) => {
		state.realtimeOptions = options;
		return {
			phase: state.realtimePhase,
			mode: state.realtimeMode,
			transcript: "",
			error: state.realtimeError,
			unavailableReason: state.realtimeUnavailableReason,
			liveMicrophoneMuted: state.realtimeLiveMicrophoneMuted,
			start: state.realtimeStart,
			stop: state.realtimeStop,
			cancel: state.realtimeCancel,
			toggleLiveMicrophone: state.realtimeToggleLiveMicrophone,
			clearError: state.realtimeClearError,
		};
	},
}));
vi.mock("#/hooks/useVoiceInput", () => ({
	uploadVoiceRecording: state.uploadVoiceRecording,
	useVoiceInput: (options: typeof state.voiceOptions) => {
		state.voiceOptions = options;
		return {
			phase: state.voicePhase,
			engine: state.voiceEngine,
			seconds: 0,
			error: state.voiceError,
			ready: state.voiceReady,
			status: { state: "unavailable", model: "" },
			start: state.voiceStart,
			stop: state.voiceStop,
			cancel: state.voiceCancel,
			refresh: vi.fn(),
			clearError: state.voiceClearError,
		};
	},
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
			approvalsReviewer: state.approvalsReviewer,
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
	subscribeMessage: vi.fn(() => () => {}),
	subscribeStatus: vi.fn(() => () => {}),
	getSnapshot: () => ({ wsStatus: state.wsStatus }),
	send: state.send,
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
	canonicalSessionId: (sessionId: string) => {
		const status = (state.sessions as SessionStatusEntry[]).find(
			(session) =>
				session.session_id === sessionId || session.db_session_id === sessionId,
		);
		return status?.db_session_id ?? status?.session_id ?? sessionId;
	},
}));
vi.mock("#/lib/serverFns/sessions", () => ({
	ensureSessionFn: vi.fn(),
	getCurrentSessionFn: vi.fn(),
	getLiveSessionsFn: vi.fn(),
	getSessionContextFn: vi.fn().mockResolvedValue(null),
	getSessionRowFn: vi.fn(),
	getSessionSelectionFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/agents", () => ({
	getAgentListFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/cockpit", () => ({
	getCockpitSkillsFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/providers", () => ({
	getProvidersFn: vi.fn(),
	loadProviderUsages: vi.fn(),
}));
vi.mock("#/lib/serverFns/voice", () => ({
	getVoiceInfoFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/config");

import { resetRavenTerminalsForTesting } from "#/hooks/ravenTerminalStore";
import { useNotificationPresence } from "#/hooks/useNotificationPresence";
import {
	loadRavenProviders,
	refreshRavenProvider,
	resetRavenProviderCacheForTesting,
} from "#/lib/ravenProviderCache";
import { getAgentListFn } from "#/lib/serverFns/agents";
import { getCockpitSkillsFn } from "#/lib/serverFns/cockpit";
import { getConfig } from "#/lib/serverFns/config";
import { getProvidersFn, loadProviderUsages } from "#/lib/serverFns/providers";
import {
	getCurrentSessionFn,
	getLiveSessionsFn,
	getSessionRowFn,
	getSessionSelectionFn,
} from "#/lib/serverFns/sessions";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";
import {
	ChatPage,
	isNewProjectPreviewPresentationRequest,
	providerBackgroundOperationAvailable,
	Route,
	ravenSleepDetail,
	ravenTabAfterProjectPreviewStops,
} from "./raven";

afterEach(cleanup);

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getProvidersFn)
		.mockReset()
		.mockResolvedValue([] as never);
	state.send.mockReturnValue(true);
	resetDataRevisionsForTesting();
	resetRavenProviderCacheForTesting();
	localStorage.clear();
	resetRavenTerminalsForTesting();
	state.sessionState = "idle";
	state.wsStatus = "connected";
	state.actualModel = null;
	state.model = "claude-sonnet-4-6";
	state.effort = "high";
	state.permissionMode = "default";
	state.approvalsReviewer = "user";
	state.sessions = [];
	state.onMessage = null;
	state.handleChatWsMessage.mockReset();
	state.chatDispatch = null;
	state.onAgentChange = null;
	state.voiceOptions = null;
	state.voiceError = null;
	state.voicePhase = "idle";
	state.voiceEngine = "local";
	state.voiceReady = false;
	state.realtimeMode = null;
	state.realtimePhase = "idle";
	state.realtimeLiveMicrophoneMuted = false;
	state.realtimeError = null;
	state.realtimeUnavailableReason = null;
	state.realtimeOptions = null;
	state.uploadVoiceRecording.mockResolvedValue({
		id: "voice-1",
		path: "/library/voice-1/voice-message.wav",
		filename: "voice-message.wav",
		mime: "audio/wav",
		kind: "ephemeral",
	});
	state.terminalProps = null;
	state.preview = null;
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
		sessionApprovalsReviewer: null,
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
		delegationParentSessionId: null,
		delegationParentLabel: null,
		delegationDepth: null,
		delegationControlOwned: false,
		voiceInfo: {
			status: { state: "unavailable", model: "" },
			models: [],
		},
	};
});

function configureEffortRejectionSession(): void {
	state.loaderData = {
		...state.loaderData,
		config: {
			...(state.loaderData.config as object),
			vault_provider: "claude",
			claude: {
				interactive_mode: false,
				model: "claude-sonnet-4-6",
				effort: "high",
				permission_mode: "default",
			},
		},
		existingSessionId: "saved-session",
		isExplicitSession: true,
		sessionModel: "claude-sonnet-4-6",
		sessionProviderId: "claude",
		sessionEffort: "high",
		sessionPermissionMode: "default",
		providers: [
			{
				id: "claude",
				label: "Claude",
				available: true,
				models: [
					{
						value: "claude-sonnet-4-6",
						label: "Sonnet 4.6",
						isDefault: true,
					},
				],
				effortLevels: [
					{ value: "high", label: "High", isDefault: true },
					{ value: "max", label: "Max" },
					{ value: "xhigh", label: "X-High" },
				],
				permissionModes: [{ value: "default", label: "Ask", isDefault: true }],
			},
		],
	};
	state.sessions = [
		{
			session_id: "live-session",
			db_session_id: "saved-session",
			mode: "sdk",
			state: "idle",
			provider_id: "claude",
			model: "claude-sonnet-4-6",
			effort: "high",
			permission_mode: "default",
		},
	];
}

function configureModelRejectionSession(
	model:
		| "claude-sonnet-4-6"
		| "claude-opus-4-6"
		| "claude-haiku-4-5" = "claude-sonnet-4-6",
): void {
	configureEffortRejectionSession();
	state.model = model;
	state.loaderData = {
		...state.loaderData,
		sessionModel: model,
		providers: [
			{
				...((state.loaderData.providers as Array<Record<string, unknown>>)[0] ??
					{}),
				models: [
					{
						value: "claude-sonnet-4-6",
						label: "Sonnet 4.6",
						isDefault: true,
					},
					{ value: "claude-opus-4-6", label: "Opus 4.6" },
					{ value: "claude-haiku-4-5", label: "Haiku 4.5" },
				],
			},
		],
	};
	state.sessions = [
		{
			session_id: "live-session",
			db_session_id: "saved-session",
			mode: "sdk",
			state: "idle",
			provider_id: "claude",
			model,
			effort: "high",
			permission_mode: "default",
		},
	];
}

function configureClaudeSessionPermissions(options?: {
	providerId?: string;
	supportsAutoMode?: boolean;
	umbod?: boolean;
	autoSleep?: boolean;
}): void {
	const providerId = options?.providerId ?? "claude";
	state.model = "claude-sonnet-4-6";
	state.permissionMode = "default";
	state.loaderData = {
		...state.loaderData,
		config: {
			...(state.loaderData.config as object),
			vault_provider: providerId,
			claude: {
				interactive_mode: false,
				model: "claude-sonnet-4-6",
				permission_mode: "default",
			},
			cliproxy: {
				model: "claude-sonnet-4-6",
				permission_mode: "default",
			},
			umbod: { enabled: options?.umbod === true },
			auto_sleep: { enabled: options?.autoSleep === true },
		},
		providers: [
			{
				id: providerId,
				label: providerId === "claude" ? "Claude" : "Claude Code · CLIProxy",
				available: true,
				models: [
					{
						value: "sonnet",
						resolvedModel: "claude-sonnet-4-6",
						label: "Sonnet 4.6",
						...(options?.supportsAutoMode === false
							? {}
							: { supportsAutoMode: true }),
					},
				],
				permissionModes: [{ value: "default", label: "Persistent ask only" }],
				sessionPermissionModes: [
					{ value: "default", label: "Ask" },
					{ value: "bypassPermissions", label: "Auto-approve all" },
					{ value: "auto", label: "Auto" },
					{ value: "dontAsk", label: "Pre-approved only" },
				],
			},
		],
	};
}

function configurePermissionRejectionSession(
	permissionMode: "default" | "auto" = "default",
): void {
	configureClaudeSessionPermissions();
	state.permissionMode = permissionMode;
	state.loaderData = {
		...state.loaderData,
		existingSessionId: "saved-session",
		isExplicitSession: true,
		sessionModel: "claude-sonnet-4-6",
		sessionProviderId: "claude",
		sessionEffort: "high",
		sessionPermissionMode: permissionMode,
	};
	state.sessions = [
		{
			session_id: "live-session",
			db_session_id: "saved-session",
			mode: "sdk",
			state: "idle",
			provider_id: "claude",
			model: "claude-sonnet-4-6",
			effort: "high",
			permission_mode: permissionMode,
		},
	];
}

function configureProviderRejectionSession(): void {
	configurePermissionRejectionSession("auto");
	state.loaderData = {
		...state.loaderData,
		providers: [
			...((state.loaderData.providers as unknown[]) ?? []),
			{
				id: "codex",
				label: "Codex",
				available: true,
				models: [
					{
						value: "gpt-5.6-sol",
						label: "GPT-5.6 Sol",
						isDefault: true,
					},
				],
				effortLevels: [{ value: "medium", label: "Medium", isDefault: true }],
				permissionModes: [{ value: "default", label: "Ask", isDefault: true }],
				approvalReviewers: [
					{ value: "user", label: "User review", isDefault: true },
					{ value: "auto_review", label: "Auto-review" },
				],
			},
			{
				id: "pi",
				label: "Pi",
				available: true,
				models: [{ value: "pi-pro", label: "Pi Pro", isDefault: true }],
				effortLevels: [{ value: "low", label: "Low", isDefault: true }],
				permissionModes: [{ value: "default", label: "Ask", isDefault: true }],
			},
		],
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("Raven hydration", () => {
	it("hydrates cached live-session snapshots without entering a render loop", async () => {
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "hydration-session",
			isExplicitSession: true,
		};
		const view = (
			<LiveSessionSwitcherBoundary routeKey="/raven?session=hydration-session">
				<ChatPage />
			</LiveSessionSwitcherBoundary>
		);
		const container = document.createElement("div");
		container.innerHTML = renderToString(view);
		document.body.append(container);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		let root: ReturnType<typeof hydrateRoot> | undefined;

		try {
			await act(async () => {
				root = hydrateRoot(container, view);
				await Promise.resolve();
			});
			await waitFor(() =>
				expect(container.querySelector('[role="combobox"]')).not.toBeNull(),
			);
			const errors = consoleError.mock.calls
				.map((call) => call.map(String).join(" "))
				.join("\n");
			expect(errors).not.toContain(
				"getServerSnapshot should be cached to avoid an infinite loop",
			);
			expect(errors).not.toContain("Maximum update depth exceeded");
		} finally {
			await act(async () => root?.unmount());
			consoleError.mockRestore();
			container.remove();
		}
	});
});

describe("Project Preview tabs", () => {
	it("returns a stopped mobile Preview to Chat without closing Terminal", () => {
		expect(ravenTabAfterProjectPreviewStops("preview")).toBe("chat");
		expect(ravenTabAfterProjectPreviewStops("terminal")).toBe("terminal");
		expect(ravenTabAfterProjectPreviewStops("chat")).toBe("chat");
	});

	it("does not replay an old Preview presentation request on chat entry", () => {
		expect(isNewProjectPreviewPresentationRequest(2, 2)).toBe(false);
		expect(isNewProjectPreviewPresentationRequest(3, 2)).toBe(true);
	});

	it("keeps the mobile composer focused when a Preview starts", () => {
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "preview-session",
			isExplicitSession: true,
		};
		const { rerender } = render(<ChatPage />);
		const composer = screen.getByRole("combobox");
		composer.focus();

		state.preview = {
			id: "123e4567-e89b-12d3-a456-426614174000",
			session_id: "preview-session",
			label: "Web app",
			command: "bun run dev",
			cwd: "/work/web",
			port: 4173,
			path: "/",
			url: "http://127.0.0.1:4173/",
			relay_url:
				"/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/",
			state: "ready",
			present: true,
			started_at: new Date().toISOString(),
			expires_at: "2026-07-24T14:00:00.000Z",
			logs: [],
		};
		rerender(<ChatPage />);

		expect(screen.getByRole("button", { name: "chat" }).className).toContain(
			"border-primary",
		);
		expect(document.activeElement).toBe(composer);
	});

	it("ends desktop Preview resizing when the captured pointer is released", () => {
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "preview-session",
			isExplicitSession: true,
		};
		state.preview = {
			id: "123e4567-e89b-12d3-a456-426614174000",
			session_id: "preview-session",
			label: "Web app",
			command: "bun run dev",
			cwd: "/work/web",
			port: 4173,
			path: "/",
			url: "http://127.0.0.1:4173/",
			relay_url:
				"/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/",
			state: "ready",
			present: true,
			started_at: "2026-07-24T10:00:00.000Z",
			expires_at: "2026-07-24T14:00:00.000Z",
			logs: [],
		};
		localStorage.setItem("hlid:raven-preview-width", "520");
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 1_200,
		});

		render(<ChatPage />);
		const divider = screen.getByLabelText("Resize Project Preview");
		const pane = screen.getByLabelText("Project Preview") as HTMLElement;
		const releasePointerCapture = vi.fn();
		Object.assign(divider, {
			setPointerCapture: vi.fn(),
			hasPointerCapture: vi.fn(() => true),
			releasePointerCapture,
		});

		fireEvent.pointerDown(divider, { clientX: 800, pointerId: 1 });
		expect(pane.className).toContain("pointer-events-none");
		fireEvent.pointerMove(window, { clientX: 700, pointerId: 1 });
		expect(pane.style.width).toBe("620px");

		fireEvent.pointerUp(window, { pointerId: 1 });
		expect(releasePointerCapture).toHaveBeenCalledWith(1);
		expect(pane.className).not.toContain("pointer-events-none");

		fireEvent.pointerMove(window, { clientX: 600, pointerId: 1 });
		expect(pane.style.width).toBe("620px");
	});
});

describe("Raven auto-sleep copy", () => {
	it("labels spend-control threshold and hard-limit sleeps accurately", () => {
		expect(
			ravenSleepDetail({ windowId: "spend_control", utilization: 0.99 }),
		).toBe(" — spend control at 99%");
		expect(
			ravenSleepDetail({
				windowId: "spend_control",
				reason: "limit_reached",
			}),
		).toBe(" — spend limit reached");
	});

	it("retains the rolling-window sleep labels", () => {
		expect(ravenSleepDetail({ windowId: "weekly", utilization: 0.9 })).toBe(
			" — weekly usage at 90%",
		);
		expect(
			ravenSleepDetail({ windowId: "five_hour", reason: "limit_reached" }),
		).toBe(" — usage limit reached");
	});
});

describe("Raven composed submission behavior", () => {
	it("reports the current Raven session for notification suppression", () => {
		render(<ChatPage />);

		expect(useNotificationPresence).toHaveBeenCalledWith(
			expect.any(String),
			null,
			"connected",
			state.send,
		);
	});

	it("offers notification overrides only for the durable session identity", () => {
		configureEffortRejectionSession();
		state.loaderData = { ...state.loaderData, sessionPersisted: true };
		state.sessions = [];
		render(<ChatPage />);

		const settings = screen.getByRole("button", {
			name: /Claude.*Sonnet 4\.6.*session model and notification settings/i,
		});
		fireEvent.click(settings);
		expect(
			screen.getByTestId("session-notification-override").textContent,
		).toBe("saved-session");
		expect(
			screen.getByRole("dialog", {
				name: "Session model and notification settings",
			}),
		).toBeTruthy();
	});

	it("does not offer notification overrides for a missing durable route", () => {
		configureEffortRejectionSession();
		state.loaderData = { ...state.loaderData, sessionPersisted: false };
		state.sessions = [];
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
		);
		expect(screen.queryByTestId("session-notification-override")).toBeNull();
	});

	it("does not offer notification overrides for an undurable live identity", () => {
		configureEffortRejectionSession();
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "live-session",
			sessionPersisted: false,
		};
		state.sessions = state.sessions.map((session) => ({
			...(session as Record<string, unknown>),
			db_session_id: null,
		}));
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
		);
		expect(screen.queryByTestId("session-notification-override")).toBeNull();
	});

	it("inserts dictated text at the active Raven selection", () => {
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				callback(0);
				return 1;
			});
		try {
			render(<ChatPage />);
			const composer = screen.getByRole("combobox") as HTMLTextAreaElement;
			fireEvent.change(composer, { target: { value: "draft ending" } });
			composer.setSelectionRange(6, 12);

			act(() => state.voiceOptions?.onTranscription?.("spoken"));

			expect(composer.value).toBe("draft spoken");
			expect(document.activeElement).toBe(composer);
		} finally {
			requestFrame.mockRestore();
		}
	});

	it("auto-sends non-empty Raven dictation through normal chat submission", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				voice: {
					...(state.loaderData.config as { voice: Record<string, unknown> })
						.voice,
					auto_send: true,
				},
			},
		};
		render(<ChatPage />);
		state.send.mockClear();

		act(() => state.voiceOptions?.onTranscription?.(""));
		expect(state.send).not.toHaveBeenCalled();

		act(() => state.voiceOptions?.onTranscription?.("send the transcript"));

		expect(state.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: "chat", text: "send the transcript" }),
		);
	});

	it("keeps Codex voice inputs gated on native Codex sessions", async () => {
		render(<ChatPage />);

		expect(state.voiceOptions?.codexTurnAvailable).toBe(false);
		expect(state.voiceOptions?.codexTurnUnavailableReason).toBe(
			"Talk to Codex requires the native Codex provider.",
		);
		expect(state.voiceOptions?.codexDictation).toMatchObject({
			available: false,
			unavailableReason:
				"Dictate with Codex requires the native Codex provider.",
		});

		const onAudioTurn = state.voiceOptions?.onAudioTurn;
		expect(onAudioTurn).toBeTypeOf("function");
		await expect(
			onAudioTurn?.(new Blob(["recording"], { type: "audio/wav" })),
		).rejects.toThrow("Talk to Codex requires the native Codex provider");
		expect(state.uploadVoiceRecording).not.toHaveBeenCalled();
	});

	it("sends a staged microphone recording as a normal Codex turn", async () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				vault_provider: "codex",
				voice: {
					...(state.loaderData.config as { voice: Record<string, unknown> })
						.voice,
					enabled: true,
					input_provider: "codex",
				},
				codex: { model: "gpt-audio" },
			},
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [
						{
							value: "gpt-audio",
							label: "GPT Audio",
							inputModalities: ["text", "image", "audio"],
						},
					],
				},
			],
		};
		render(<ChatPage />);

		expect(state.voiceOptions?.codexTurnAvailable).toBe(true);
		await act(async () => {
			await state.voiceOptions?.onAudioTurn?.(
				new Blob(["recording"], { type: "audio/wav" }),
			);
		});

		expect(state.uploadVoiceRecording).toHaveBeenCalledWith(
			expect.any(Blob),
			expect.objectContaining({ sessionId: expect.any(String) }),
		);
		expect(state.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chat",
				text: "Voice message",
				attachments: [
					expect.objectContaining({
						id: "voice-1",
						mime: "audio/wav",
					}),
				],
			}),
		);
	});

	it("offers and starts realtime Codex dictation without model audio input", async () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				vault_provider: "codex",
				voice: {
					...(state.loaderData.config as { voice: Record<string, unknown> })
						.voice,
					enabled: true,
					input_provider: "codex_dictation",
					codex_live_mode: true,
					codex_voice: "marin",
				},
				codex: { model: "gpt-text" },
			},
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					capabilities: { realtime: true },
					models: [
						{
							value: "gpt-text",
							label: "GPT Text",
							inputModalities: ["text", "image"],
						},
					],
				},
			],
			voiceInfo: {
				status: { state: "unavailable", model: "" },
				models: [],
				codexRealtimeBackend: { available: true },
			},
		};
		state.realtimeMode = "dictation";
		state.realtimePhase = "connected";

		render(<ChatPage />);

		expect(state.voiceOptions?.codexTurnAvailable).toBe(false);
		expect(state.voiceOptions?.codexDictation).toMatchObject({
			available: true,
			phase: "connected",
			error: null,
		});
		await act(async () => state.voiceOptions?.codexDictation?.start());
		expect(state.realtimeStart).toHaveBeenCalledWith("dictation");
	});

	it("shows a tap-to-mute control only while Raven Live is connected", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				vault_provider: "codex",
				voice: {
					...(state.loaderData.config as { voice: Record<string, unknown> })
						.voice,
					enabled: true,
					input_provider: "codex_dictation",
					codex_live_mode: true,
					codex_voice: "marin",
				},
				codex: { model: "gpt-text" },
			},
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					capabilities: { realtime: true },
					models: [
						{
							value: "gpt-text",
							label: "GPT Text",
							inputModalities: ["text", "image"],
						},
					],
				},
			],
			voiceInfo: {
				status: { state: "unavailable", model: "" },
				models: [],
				codexRealtimeBackend: { available: true },
			},
		};
		state.realtimeMode = "live";
		state.realtimePhase = "starting";

		const { rerender } = render(<ChatPage />);
		expect(screen.getByText(/Raven Live · connecting/)).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Mute Raven Live microphone" }),
		).toBeNull();

		state.realtimePhase = "connected";
		rerender(<ChatPage />);
		expect(screen.getByText(/Raven Live · listening/)).toBeTruthy();
		const stop = screen.getByRole("button", { name: "Stop Raven Live" });
		const mute = screen.getByRole("button", {
			name: "Mute Raven Live microphone",
		});
		expect(mute.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(mute);
		expect(state.realtimeToggleLiveMicrophone).toHaveBeenCalledOnce();
		expect(state.realtimeStop).not.toHaveBeenCalled();
		expect(stop).toBeTruthy();

		state.realtimeLiveMicrophoneMuted = true;
		rerender(<ChatPage />);
		expect(screen.getByText(/Raven Live · microphone muted/)).toBeTruthy();
		const unmute = screen.getByRole("button", {
			name: "Unmute Raven Live microphone",
		});
		expect(unmute.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(unmute);
		expect(state.realtimeToggleLiveMicrophone).toHaveBeenCalledTimes(2);
		expect(state.realtimeStop).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Stop Raven Live" }),
		).toBeTruthy();

		state.realtimePhase = "stopping";
		rerender(<ChatPage />);
		expect(screen.getByText(/Raven Live · stopping/)).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Mute Raven Live microphone" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Unmute Raven Live microphone" }),
		).toBeNull();
	});

	it("maps Raven Live start and errors separately from ordinary voice input", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				vault_provider: "codex",
				voice: {
					...(state.loaderData.config as { voice: Record<string, unknown> })
						.voice,
					codex_live_mode: true,
					codex_voice: "marin",
				},
			},
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					capabilities: { realtime: true },
				},
			],
			voiceInfo: {
				status: { state: "unavailable", model: "" },
				models: [],
				codexRealtimeBackend: { available: true },
			},
		};

		const view = render(<ChatPage />);
		fireEvent.click(screen.getByRole("button", { name: "Start Raven Live" }));
		expect(state.realtimeStart).toHaveBeenCalledWith("live");

		state.realtimeMode = "live";
		state.realtimePhase = "error";
		state.realtimeError = "realtime connection closed";
		view.rerender(<ChatPage />);

		expect(screen.getByRole("alert").textContent).toContain(
			"Raven Live failed: realtime connection closed",
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Dismiss voice error" }),
		);
		expect(state.voiceClearError).toHaveBeenCalledOnce();
		expect(state.realtimeClearError).toHaveBeenCalledOnce();
	});

	it("discards provisional Raven Live transcript bubbles when Live closes", () => {
		render(<ChatPage />);
		act(() => {
			state.chatDispatch?.({
				type: "UPSERT_REALTIME_TRANSCRIPT",
				id: "live-partial",
				role: "assistant",
				text: "unfinished response",
				done: false,
				realtimeSessionId: "realtime-1",
				transcriptSeq: 1,
				forkSupported: false,
			});
		});
		expect(screen.getByTestId("messages").textContent).toBe("1");

		act(() => state.realtimeOptions?.onLiveClosed?.());

		expect(screen.queryByTestId("messages")).toBeNull();
	});

	it("shows a cancellable connecting state for Codex dictation", () => {
		state.voicePhase = "starting";
		state.voiceEngine = "codex_dictation";
		state.voiceReady = true;

		render(<ChatPage />);

		const composer = screen.getByRole("combobox") as HTMLTextAreaElement;
		expect(composer.placeholder).toBe("connecting Codex dictation…");
		expect(screen.getByText("Connecting Codex dictation")).toBeTruthy();
		const connecting = screen.getByRole("button", {
			name: "Connecting Codex dictation",
		}) as HTMLButtonElement;
		expect(connecting.disabled).toBe(true);
		expect(connecting.querySelector(".animate-spin")).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Cancel Codex dictation" }),
		);
		expect(state.voiceCancel).toHaveBeenCalledOnce();
		expect(state.voiceStart).not.toHaveBeenCalled();
		expect(state.voiceStop).not.toHaveBeenCalled();
	});

	it("requests authoritative provider metadata when the WebSocket connects", async () => {
		state.wsStatus = "connecting";
		const { rerender } = render(<ChatPage />);
		expect(state.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "probe_mcp" }),
		);

		state.wsStatus = "connected";
		rerender(<ChatPage />);

		await waitFor(() => {
			expect(state.send).toHaveBeenCalledWith({
				type: "probe_provider_config",
				session_id: expect.any(String),
			});
			expect(state.send).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "sync_mcp_list" }),
			);
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

	it("routes live Claude MCP controls without changing persistent MCP config", () => {
		state.send.mockReturnValue(true);
		render(<ChatPage />);
		act(() => {
			state.onMessage?.({
				type: "mcp_status",
				provider_id: "claude",
				operations: ["reconnect", "toggle"],
				servers: [{ name: "github", status: "failed", scope: "project" }],
			});
		});

		fireEvent.click(screen.getByRole("button", { name: "MCP server status" }));
		fireEvent.click(screen.getByRole("button", { name: "Reconnect github" }));

		const request = state.send.mock.calls
			.map(([message]) => message)
			.find((message) => message.type === "mcp_control");
		expect(request).toMatchObject({
			type: "mcp_control",
			session_id: expect.any(String),
			server_name: "github",
			action: "reconnect",
		});

		act(() => {
			state.onMessage?.({
				type: "mcp_control_result",
				request_id: request.request_id,
				session_id: request.session_id,
				provider_id: "claude",
				server_name: "github",
				action: "reconnect",
				error: "Claude could not reconnect github.",
			});
		});
		expect(screen.getByText("Claude could not reconnect github.")).toBeTruthy();
	});

	it("routes Claude MCP approval overrides and surfaces provider warnings", () => {
		state.send.mockReturnValue(true);
		state.permissionMode = "bypassPermissions";
		render(<ChatPage />);
		act(() => {
			state.onMessage?.({
				type: "mcp_status",
				provider_id: "claude",
				operations: ["reconnect", "toggle", "permission-override"],
				servers: [
					{
						name: "github",
						status: "connected",
						scope: "project",
						permission_mode_override: "default",
					},
				],
			});
		});

		fireEvent.click(screen.getByRole("button", { name: "MCP server status" }));
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "MCP approval mode for github",
			}),
			{ target: { value: "auto" } },
		);

		const request = state.send.mock.calls
			.map(([message]) => message)
			.find(
				(message) =>
					message.type === "mcp_control" &&
					message.action === "permission-auto",
			);
		expect(request).toMatchObject({
			type: "mcp_control",
			session_id: expect.any(String),
			server_name: "github",
			action: "permission-auto",
		});

		act(() => {
			state.onMessage?.({
				type: "mcp_control_result",
				request_id: request.request_id,
				session_id: request.session_id,
				provider_id: "claude",
				server_name: "github",
				action: "permission-auto",
				warning:
					"Claude stored the override for a server that is not connected yet.",
			});
		});
		expect(
			screen.getByText(
				"Claude stored the override for a server that is not connected yet.",
			),
		).toBeTruthy();
	});

	it("opens the Claude workflow manager without forwarding /workflows as a prompt", () => {
		render(<ChatPage />);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "/workflows" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		expect(
			screen.getByRole("dialog", { name: "Claude workflows" }),
		).toBeTruthy();
		expect(state.send).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chat",
				text: "/workflows",
			}),
		);
	});

	it("clears a selected /context action after opening the local inspector", async () => {
		render(<ChatPage />);
		const composer = screen.getByRole("combobox");
		fireEvent.change(composer, { target: { value: "/context" } });
		fireEvent.click(screen.getByRole("button", { name: "Select /context" }));

		expect(screen.getByTestId("active-command").textContent).toContain(
			"command/context",
		);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		expect(screen.getByRole("dialog", { name: "Hlid context" })).toBeTruthy();
		expect(screen.queryByTestId("active-command")).toBeNull();
		expect((composer as HTMLTextAreaElement).value).toBe("");
		expect(state.send).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chat",
				text: "/context",
			}),
		);
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

	it("replaces stale Claude loader skills with the live command snapshot", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				ui: { enter_to_submit: true, show_provider_entries: true },
			},
			vaultSkills: [
				{
					file: "SKILL.md",
					name: "hlid-reload-smoke",
					description: "Provider skill removed after the loader snapshot",
					content: "",
					filePath: "/home/kyle/.claude/skills/hlid-reload-smoke/SKILL.md",
					providerId: "claude",
					source: "provider",
				},
				{
					file: "managed.md",
					name: "managed",
					description: "Hlid-managed skill",
					content: "Managed context",
					filePath: "/vault/.hlid/skills/managed.md",
					source: "hlid",
				},
			],
		};
		render(<ChatPage />);

		const composer = screen.getByRole("combobox");
		fireEvent.change(composer, { target: { value: "/hlid-reload" } });
		expect(
			screen.getByRole("button", { name: "Select /hlid-reload-smoke" }),
		).toBeTruthy();

		act(() => {
			state.onMessage?.({
				type: "slash_commands",
				provider_id: "claude",
				commands: [],
			});
		});
		expect(
			screen.queryByRole("button", { name: "Select /hlid-reload-smoke" }),
		).toBeNull();

		fireEvent.change(composer, { target: { value: "/managed" } });
		expect(
			screen.getByRole("button", { name: "Select /managed" }),
		).toBeTruthy();
	});

	it("keeps agent selection and all composer modes on-screen at mobile widths", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
			},
			agentSkillContext: "/codex-project",
			agentList: [
				{
					path: "/codex-project",
					name: "Codex project with a long mobile label",
					provider: "codex",
				},
			],
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					capabilities: { appCatalog: true },
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
		expect(modeRow?.className).toContain("gap-2");
		expect(modeRow?.className).toContain("md:gap-3");
		expect(toolbar?.className).toContain("flex-wrap");
		expect(screen.getByRole("button", { name: "apps" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "html" })).toBeTruthy();
	});

	it("switches live sessions through the Raven route and preserves the current draft", () => {
		state.search = { session: "chat-current" };
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "chat-current",
			isExplicitSession: true,
		};
		state.sessions = [
			{
				session_id: "pool-placeholder",
				agent_cwd: "/unused",
				agent_name: "Unused",
				state: "idle",
				model: "sonnet",
				hasPendingPermissions: false,
				hasDbSession: false,
				db_session_id: null,
			},
			{
				session_id: "pool-current",
				agent_cwd: "/current",
				agent_name: "Current agent",
				lastLabel: "Current work",
				state: "idle",
				provider_id: "claude",
				model: "sonnet",
				hasPendingPermissions: false,
				hasDbSession: true,
				db_session_id: "chat-current",
			},
			{
				session_id: "pool-other",
				agent_cwd: "/other",
				agent_name: "Other agent",
				lastLabel: "Other work",
				state: "running",
				provider_id: "codex",
				model: "gpt-5.6-sol",
				hasPendingPermissions: false,
				hasDbSession: true,
				db_session_id: "chat-other",
			},
		] satisfies SessionStatusEntry[];
		render(<ChatPage />);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "draft before switching" },
		});
		state.navigate.mockClear();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Open session attention, 2 total, work in progress",
			}),
		);
		expect(
			screen
				.getByRole("button", { name: "Open Current work session" })
				.getAttribute("aria-current"),
		).toBe("page");
		fireEvent.click(
			screen.getByRole("button", { name: "Open Other work session" }),
		);

		const switchNavigation = state.navigate.mock.calls
			.map(([options]) => options as { to?: string; search?: unknown })
			.find((options) => {
				if (options.to !== "/raven" || typeof options.search !== "function") {
					return false;
				}
				return (
					(
						options.search as (
							previous: Record<string, unknown>,
						) => Record<string, unknown>
					)(state.search).session === "chat-other"
				);
			});
		expect(switchNavigation).toBeTruthy();

		cleanup();
		expect(localStorage.getItem("hlid:draft:chat-current")).toBe(
			"draft before switching",
		);
	});

	it("keeps session attention open while the keyed chat page changes", () => {
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "chat-current",
			isExplicitSession: true,
		};
		state.sessions = [
			{
				session_id: "pool-current",
				agent_cwd: "/current",
				agent_name: "Current agent",
				lastLabel: "Current work",
				state: "running",
				provider_id: "claude",
				model: "sonnet",
				hasPendingPermissions: false,
				hasDbSession: true,
				db_session_id: "chat-current",
			},
		] satisfies SessionStatusEntry[];
		const RavenPage = (Route as unknown as { component: React.ComponentType })
			.component;
		const view = render(
			<LiveSessionSwitcherBoundary>
				<RavenPage />
			</LiveSessionSwitcherBoundary>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Open session attention, 1 total, work in progress",
			}),
		);
		expect(
			screen.getByRole("dialog", { name: "Session attention" }),
		).toBeTruthy();

		state.loaderData = {
			...state.loaderData,
			existingSessionId: "chat-next",
		};
		view.rerender(
			<LiveSessionSwitcherBoundary>
				<RavenPage />
			</LiveSessionSwitcherBoundary>,
		);

		expect(
			screen.getByRole("dialog", { name: "Session attention" }),
		).toBeTruthy();
	});

	it("stacks the workspace and model badges on mobile while preserving desktop edge alignment", () => {
		state.loaderData = {
			...state.loaderData,
			agentSkillContext: "/project",
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				agents: [
					{
						path: "/project",
						name: "Hlid Mobile Release Investigator",
						provider: "claude",
					},
				],
			},
		};
		render(<ChatPage />);

		const workspaceBadge = screen.getByRole("button", {
			name: "Hlid Mobile Release Investigator",
		});
		const modelBadge = document.querySelector<HTMLButtonElement>(
			'button[aria-haspopup="dialog"]',
		);

		expect(workspaceBadge.className).toContain("max-w-full");
		expect(workspaceBadge.querySelector(".truncate")).toBeTruthy();
		expect(modelBadge?.className).toContain("block");
		expect(modelBadge?.className).toContain("w-full");
		expect(workspaceBadge.parentElement?.className).toContain("relative");
		expect(workspaceBadge.parentElement?.className).toContain("mt-1");
		expect(workspaceBadge.parentElement?.className).toContain("md:absolute");
		expect(workspaceBadge.parentElement?.className).toContain("md:left-3");
		expect(modelBadge?.className).toContain("min-h-7");
		expect(modelBadge?.parentElement?.className).toContain("relative");
		expect(modelBadge?.parentElement?.className).toContain("mt-px");
		expect(modelBadge?.parentElement?.className).toContain("mb-1");
		expect(modelBadge?.parentElement?.className).toContain("md:absolute");
		expect(modelBadge?.parentElement?.className).toContain("md:right-3");
		expect(
			workspaceBadge.compareDocumentPosition(modelBadge as HTMLButtonElement) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("keeps the desktop Enter shortcut hint off mobile and coarse pointers", () => {
		render(<ChatPage />);

		const hint = screen.getByText("↵ send · ⇧↵ newline");
		expect(hint.className).toContain("hidden");
		expect(hint.className).toContain("md:block");
		expect(hint.className).toContain("[@media(pointer:coarse)]:hidden");
	});

	it("does not advertise Enter submission when the setting is off", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				ui: { enter_to_submit: false },
			},
		};
		render(<ChatPage />);

		expect(screen.queryByText("↵ send · ⇧↵ newline")).toBeNull();
	});

	it("keeps composer controls in DOM order inside the mobile grid", () => {
		render(<ChatPage />);

		const attach = screen.getByRole("button", { name: "Attach file" });
		const voice = screen.getByRole("button", { name: "Dictate with Whisper" });
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
		for (const control of [attach, activeNote, voice]) {
			expect(control.className).not.toContain("min-h-11");
			expect(control.className).not.toContain("min-w-11");
		}
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

	it("keeps secondary composer controls compact on mobile", () => {
		render(<ChatPage />);

		const secondaryControls = [
			screen.getByRole("button", { name: "MCP server status" }),
			screen.getByRole("button", { name: "plan" }),
			screen.getByRole("button", { name: "terminal" }),
		];
		for (const control of secondaryControls) {
			expect(control.className).not.toContain("min-h-11");
		}

		const send = screen.getByRole("button", { name: "Send" });
		expect(send.className).toContain("min-h-11");
		expect(send.className).toContain("md:min-h-0");
	});

	it("places Fork in the left control cluster next to voice", () => {
		render(<ChatPage />);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "create a forkable turn" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		const attach = screen.getByRole("button", { name: "Attach file" });
		const voice = screen.getByRole("button", { name: "Dictate with Whisper" });
		const newChat = screen.getByRole("button", { name: "New chat" });
		const fork = screen.getByRole("button", { name: "Fork session" });

		expect(fork.parentElement).toBe(attach.parentElement);
		expect(fork.parentElement).not.toBe(newChat.parentElement);
		expect(
			voice.compareDocumentPosition(fork) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(fork.className).toContain("px-2");
		expect(fork.className).not.toContain("min-h-11");
		expect(fork.className).not.toContain("min-w-11");
		expect(newChat.className).toContain("min-h-11");
		expect(newChat.className).toContain("min-w-11");
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

	it("shows durable delegation provenance with a parent-session link", () => {
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "child-session",
			delegationParentSessionId: "parent-session",
			delegationParentLabel: "Parent task",
			delegationDepth: 1,
		};
		render(<ChatPage />);

		expect(screen.getByText(/Delegated child · depth 1/i)).toBeTruthy();
		const parentLabel = screen.getByText("Parent task");
		expect(parentLabel.dataset.privacyMask).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "Open parent" }));
		expect(state.navigate).toHaveBeenCalledWith({
			to: "/raven",
			search: { session: "parent-session", agent: undefined },
		});
	});

	it("keeps navigation and native steering available inside an active delegated child", async () => {
		vi.mocked(getSessionRowFn).mockResolvedValue({
			delegation_control_owned: 1,
		} as never);
		state.sessionState = "running";
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "child-session",
			isExplicitSession: true,
			delegationParentSessionId: "parent-session",
			delegationParentLabel: "Parent task",
			delegationDepth: 1,
			delegationControlOwned: true,
		};
		render(<ChatPage />);

		expect(
			screen.getByText(/Native steering is available here/i),
		).not.toBeNull();
		expect(
			screen.getByRole("button", { name: /Open session attention/i }),
		).not.toBeNull();
		const composer = screen.getByRole("combobox");
		expect(composer.getAttribute("placeholder")).toBe(
			"steer the active child turn…",
		);
		expect(screen.queryByRole("button", { name: "Abort" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
		fireEvent.change(composer, {
			target: { value: "Check the failing branch" },
		});
		state.send.mockClear();
		fireEvent.click(
			screen.getByRole("button", { name: "Steer current child" }),
		);
		expect(state.send).toHaveBeenCalledWith({
			type: "steer_active",
			session_id: "child-session",
			turn_id: expect.any(String),
			text: "Check the failing branch",
		});
		expect(state.enqueueChat).not.toHaveBeenCalled();
		expect((composer as HTMLTextAreaElement).value).toBe("");

		vi.mocked(getSessionRowFn).mockResolvedValue({
			delegation_control_owned: 0,
		} as never);
		act(() => {
			replaceDataRevisions({
				...getDataRevisionSnapshot(),
				sessions: getDataRevisionSnapshot().sessions + 1,
			});
		});

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Queue message" }),
			).not.toBeNull(),
		);
		expect(screen.queryByText(/Native steering is available here/i)).toBeNull();
	});

	it("does not offer a queued fallback when a delegated provider lacks native steering", () => {
		state.sessionState = "running";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				vault_provider: "acp:test",
			},
			existingSessionId: "child-session",
			isExplicitSession: true,
			sessionProviderId: "acp:test",
			delegationParentSessionId: "parent-session",
			delegationParentLabel: "Parent task",
			delegationDepth: 1,
			delegationControlOwned: true,
			providers: [
				{
					id: "acp:test",
					label: "ACP test",
					available: true,
				},
			],
		};
		render(<ChatPage />);

		expect(screen.getByText(/has no native steering/i)).not.toBeNull();
		expect((screen.getByRole("combobox") as HTMLTextAreaElement).disabled).toBe(
			true,
		);
		expect(
			(
				screen.getByRole("button", {
					name: "Steer current child",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
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

	it("keeps Claude's capability-gated background control out of the composer", () => {
		state.sessionState = "running";
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "session-1",
			isExplicitSession: true,
			providers: [
				{
					id: "claude",
					label: "Claude",
					available: true,
					capabilities: {
						backgroundActivities: {
							maturity: "experimental",
							operations: ["background", "list", "stop"],
						},
					},
				},
			],
		};
		expect(
			providerBackgroundOperationAvailable(
				state.loaderData.providers as Parameters<
					typeof providerBackgroundOperationAvailable
				>[0],
				"claude",
				"background",
			),
		).toBe(true);
		render(<ChatPage />);
		expect(
			screen.queryByRole("button", { name: "Background Claude tasks" }),
		).toBeNull();
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
			name: /gpt-5\.4.*low.*bypass/i,
		});
		expect(badge).toBeTruthy();
		expect(badge.textContent).not.toMatch(/claude|medium/i);
	});

	it("submits the effective Einherjar controls shown for a new chat", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
				codex: {
					model: "gpt-5.6-terra",
					effort: "medium",
					permission_mode: "default",
				},
				agents: [
					{
						path: "/hlid",
						provider: "codex",
						model: "gpt-5.6-sol",
						effort: "ultra",
						permission_mode: "bypassPermissions",
					},
				],
			},
			agentSkillContext: "/hlid",
			agentList: [{ path: "/hlid", name: "Hlid", provider: "codex" }],
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [
						{ value: "gpt-5.6-sol", label: "Sol" },
						{ value: "gpt-5.6-terra", label: "Terra" },
					],
					effortLevels: [{ value: "ultra", label: "Ultra" }],
					permissionModes: [
						{
							value: "bypassPermissions",
							label: "Auto-approve all",
						},
					],
				},
			],
		};

		render(<ChatPage />);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "keep this on Sol" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		expect(state.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chat",
				provider: "codex",
				model: "gpt-5.6-sol",
				effort: "ultra",
				permission_mode: "bypassPermissions",
			}),
		);
	});

	it("shows the selected model before a stale last-used model", () => {
		state.model = "gpt-5.6-sol";
		state.actualModel = "gpt-5.6-terra";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
				codex: { model: "gpt-5.6-terra" },
			},
			existingSessionId: "saved-session",
			isExplicitSession: true,
			sessionModel: "gpt-5.6-sol",
			sessionProviderId: "codex",
			providers: [
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
		const badge = screen.getByRole("button", { name: /gpt-5\.6-sol/i });
		expect(badge.getAttribute("aria-label")).not.toMatch(/terra/i);
		expect(badge.className).toContain("text-status-warning");
		fireEvent.click(badge);
		expect(screen.getByText("selected")).toBeTruthy();
		expect(screen.getByText("last used")).toBeTruthy();
		expect(screen.getAllByText("gpt-5.6-terra").length).toBeGreaterThan(0);
	});

	it("preserves a restored native model that is absent from the catalog", () => {
		state.model = "custom-codex-model";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
			},
			existingSessionId: "saved-custom-model",
			isExplicitSession: true,
			sessionPersisted: true,
			sessionModel: "custom-codex-model",
			sessionProviderId: "codex",
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [{ value: "gpt-5.6-sol", label: "Sol" }],
				},
			],
		};

		render(<ChatPage />);
		expect(
			screen.getByRole("button", { name: /Codex.*custom-codex-model/i }),
		).toBeTruthy();
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "keep the restored model" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(state.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chat",
				provider: "codex",
				model: "custom-codex-model",
			}),
		);
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
			name: /Claude Code.*CLIProxy.*gpt-5\.6-sol.*high.*bypass/i,
		});
		expect(badge.className).toContain("max-w-full");
		expect(badge.className).toContain("w-full");
		expect(badge.parentElement?.className).toContain("relative");
		expect(badge.parentElement?.className).toContain("md:max-w");
		expect(badge.firstElementChild?.className).toContain("truncate");
		expect(
			screen.getByText("CLIProxy · gpt-5.6-sol · high · bypass"),
		).toBeTruthy();
		expect(badge.className).not.toContain("text-amber");
	});

	it("keeps model settings open while changing multiple options", () => {
		state.model = "gpt-5.4";
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
		fireEvent.click(screen.getByRole("button", { name: /Codex.*gpt-5\.4/i }));
		expect(screen.queryByTestId("session-notification-override")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "GPT-5.5" }));
		expect(
			screen.getByRole("dialog", {
				name: "Session model and notification settings",
			}),
		).toBeTruthy();
		expect(state.send).toHaveBeenCalledWith({
			type: "set_model",
			model: "gpt-5.5",
			session_id: expect.any(String),
		});

		fireEvent.click(screen.getByRole("button", { name: "High" }));
		expect(
			screen.getByRole("dialog", {
				name: "Session model and notification settings",
			}),
		).toBeTruthy();
		expect(state.send).toHaveBeenCalledWith({
			type: "set_effort",
			effort: "high",
			session_id: expect.any(String),
		});

		fireEvent.focus(screen.getByRole("combobox"));
		expect(
			screen.queryByRole("dialog", {
				name: "Session model and notification settings",
			}),
		).toBeNull();
	});

	it("keeps an ACP provider usable when it advertises no model choices", () => {
		state.model = "stale";
		state.effort = "";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "acp:pi-acp",
				acp_agents: [{ id: "pi-acp" }],
			},
			providers: [
				{
					id: "acp:pi-acp",
					label: "Pi ACP",
					available: true,
					models: [],
					permissionModes: [{ value: "default", label: "Agent asks" }],
				},
			],
		};

		render(<ChatPage />);
		fireEvent.click(screen.getByRole("button", { name: /Pi ACP/i }));
		const providerDefault = screen.getByRole("button", {
			name: "Provider default",
		});
		expect(providerDefault.getAttribute("title")).toContain(
			"has not advertised model choices",
		);
		fireEvent.click(providerDefault);
		expect(state.send).toHaveBeenCalledWith({
			type: "set_model",
			session_id: expect.any(String),
		});
	});

	it("switches back to an ACP provider on its durable default sentinel", async () => {
		state.model = "";
		state.effort = "";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "acp:opencode",
				acp_agents: [{ id: "opencode", model: "anthropic/claude-sonnet-4-6" }],
			},
			providers: [
				{
					id: "acp:opencode",
					label: "OpenCode",
					available: true,
					models: [],
					permissionModes: [{ value: "default", label: "Agent asks" }],
				},
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" }],
				},
			],
		};
		vi.mocked(getProvidersFn).mockResolvedValue([
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [],
				modelCatalogRefresh: { status: "current", source: "live" },
				permissionModes: [{ value: "default", label: "Agent asks" }],
			},
			{
				id: "claude",
				label: "Claude",
				available: true,
				models: [{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" }],
			},
		] as never);

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", {
				name: /OpenCode.*ask/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Claude" }));
		if (!screen.queryByRole("button", { name: "OpenCode" })) {
			fireEvent.click(
				screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
			);
		}
		fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
		expect(state.send).toHaveBeenCalledWith({
			type: "set_provider",
			provider: "acp:opencode",
			session_id: expect.any(String),
		});

		fireEvent.click(screen.getByRole("button", { name: "Provider default" }));
		expect(state.send).toHaveBeenCalledWith({
			type: "set_model",
			session_id: expect.any(String),
		});
		expect(
			screen.getByRole("button", {
				name: /^OpenCode · ask · Open session model and notification settings$/i,
			}),
		).toBeTruthy();
	});

	it("replaces stale ACP models with a live catalog for a new session", async () => {
		state.model = "stale";
		state.effort = "";
		const refresh = deferred<Array<Record<string, unknown>>>();
		const freshProviders = [
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [{ value: "allowed", label: "Allowed", isDefault: true }],
				modelCatalogRefresh: { status: "current", source: "live" },
				permissionModes: [{ value: "default", label: "Ask" }],
			},
		];
		vi.mocked(getProvidersFn).mockImplementation(
			() => refresh.promise as never,
		);
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "acp:opencode",
				acp_agents: [{ id: "opencode" }],
			},
			sessionPersisted: false,
			providers: [
				{
					id: "acp:opencode",
					label: "OpenCode",
					available: true,
					models: [{ value: "stale", label: "Stale", isDefault: true }],
					permissionModes: [{ value: "default", label: "Ask" }],
				},
			],
		};

		render(<ChatPage />);

		await waitFor(() =>
			expect(getProvidersFn).toHaveBeenCalledWith({
				data: {
					refresh: true,
					refreshProviderId: "acp:opencode",
					discoveryCwd: "/vault",
				},
			}),
		);
		const pendingBadge = screen.getByRole("button", { name: /OpenCode.*Ask/i });
		fireEvent.click(pendingBadge);
		expect(
			screen.getByRole("button", { name: "Provider default" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: /^Stale/ })).toBeTruthy();
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "use the provider default" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		const pendingChat = state.send.mock.calls
			.map(([message]) => message as { type?: string; model?: string })
			.find((message) => message.type === "chat");
		expect(pendingChat).toBeTruthy();
		expect(pendingChat).not.toHaveProperty("model");

		await act(async () => refresh.resolve(freshProviders));
		const badge = await screen.findByRole("button", {
			name: /OpenCode.*Allowed.*Ask/i,
		});
		if (!screen.queryByRole("button", { name: /Allowed/ })) {
			fireEvent.click(badge);
		}
		expect(screen.getByRole("button", { name: /Allowed/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^Stale/ })).toBeNull();
	});

	it("switches to ACP immediately on provider default while models refresh", async () => {
		state.model = "claude-sonnet-4-6";
		const refresh = deferred<Array<Record<string, unknown>>>();
		const freshProviders = [
			{
				id: "claude",
				label: "Claude",
				available: true,
				models: [
					{ value: "claude-sonnet-4-6", label: "Sonnet 4.6", isDefault: true },
				],
			},
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [{ value: "allowed", label: "Allowed", isDefault: true }],
				modelCatalogRefresh: { status: "current", source: "live" },
				permissionModes: [{ value: "default", label: "Ask" }],
			},
		];
		vi.mocked(getProvidersFn).mockImplementation(
			() => refresh.promise as never,
		);
		state.loaderData = {
			...state.loaderData,
			sessionPersisted: false,
			providers: [
				freshProviders[0],
				{
					...freshProviders[1],
					models: [{ value: "stale", label: "Stale", isDefault: true }],
					modelCatalogRefresh: undefined,
				},
			],
		};

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));

		expect(state.send).toHaveBeenCalledWith({
			type: "set_provider",
			provider: "acp:opencode",
			session_id: expect.any(String),
		});
		expect(state.send).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "set_provider",
				model: expect.anything(),
			}),
		);
		expect(
			screen.getByRole("button", { name: "Provider default" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: /^Stale/ })).toBeTruthy();

		await act(async () => refresh.resolve(freshProviders));
		expect(await screen.findByRole("button", { name: /Allowed/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^Stale/ })).toBeNull();
		expect(
			state.send.mock.calls.filter(
				([message]) => (message as { type?: string }).type === "set_provider",
			),
		).toHaveLength(1);
		expect(state.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "set_model" }),
		);
		expect(
			screen.getByRole("button", { name: "Provider default" }).className,
		).toContain("text-primary");
	});

	it("uses a fresh exact-workspace ACP cache on first selection without a live refresh", async () => {
		state.model = "claude-sonnet-4-6";
		const cachedProviders = [
			{
				id: "claude",
				label: "Claude",
				available: true,
				models: [
					{
						value: "claude-sonnet-4-6",
						label: "Sonnet 4.6",
						isDefault: true,
					},
				],
			},
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [{ value: "cached", label: "Cached", isDefault: true }],
				modelCatalogRefresh: { status: "current", source: "live" },
				permissionModes: [{ value: "default", label: "Ask" }],
			},
		];
		vi.mocked(getProvidersFn).mockResolvedValue(cachedProviders as never);
		await loadRavenProviders("/vault");
		vi.mocked(getProvidersFn).mockClear();
		state.loaderData = {
			...state.loaderData,
			sessionPersisted: false,
			providers: cachedProviders,
		};

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
		await act(async () => {});

		expect(getProvidersFn).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("status", { name: /Loading OpenCode models/i }),
		).toBeNull();
		expect(screen.getByRole("button", { name: /^Cached/ })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Provider default" }).className,
		).toContain("text-primary");
		expect(state.send).toHaveBeenCalledWith({
			type: "set_provider",
			provider: "acp:opencode",
			session_id: expect.any(String),
		});
	});

	it("shows model loading on the first ACP selection and fills the picker without a provider bounce", async () => {
		state.model = "claude-sonnet-4-6";
		const refresh = deferred<Array<Record<string, unknown>>>();
		vi.mocked(getProvidersFn).mockImplementation(
			() => refresh.promise as never,
		);
		state.loaderData = {
			...state.loaderData,
			sessionPersisted: false,
			providers: [
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [
						{
							value: "claude-sonnet-4-6",
							label: "Sonnet 4.6",
							isDefault: true,
						},
					],
				},
				{
					id: "acp:opencode",
					label: "OpenCode",
					available: true,
					models: [],
					permissionModes: [{ value: "default", label: "Ask" }],
				},
			],
		};

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));

		const loading = await screen.findByRole("status", {
			name: /Loading OpenCode models/i,
		});
		expect(loading.querySelector(".animate-spin")).not.toBeNull();
		expect(
			screen.getByRole("button", { name: "Provider default" }),
		).toBeTruthy();
		expect(state.send).toHaveBeenCalledWith({
			type: "set_provider",
			provider: "acp:opencode",
			session_id: expect.any(String),
		});

		await act(async () =>
			refresh.resolve([
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [
						{
							value: "claude-sonnet-4-6",
							label: "Sonnet 4.6",
							isDefault: true,
						},
					],
				},
				{
					id: "acp:opencode",
					label: "OpenCode",
					available: true,
					models: [{ value: "allowed", label: "Allowed", isDefault: true }],
					modelCatalogRefresh: { status: "current", source: "live" },
					permissionModes: [{ value: "default", label: "Ask" }],
				},
			]),
		);

		expect(
			await screen.findByRole("button", { name: /^Allowed/ }),
		).toBeTruthy();
		expect(
			screen.queryByRole("status", { name: /Loading OpenCode models/i }),
		).toBeNull();
		expect(
			state.send.mock.calls.filter(
				([message]) => (message as { type?: string }).type === "set_provider",
			),
		).toHaveLength(1);
	});

	it("offers an in-place retry when the first ACP model refresh fails", async () => {
		state.model = "claude-sonnet-4-6";
		vi.mocked(getProvidersFn)
			.mockRejectedValueOnce(new Error("live refresh failed"))
			.mockResolvedValueOnce([
				{
					id: "acp:opencode",
					label: "OpenCode",
					available: true,
					models: [{ value: "allowed", label: "Allowed", isDefault: true }],
					modelCatalogRefresh: { status: "current", source: "live" },
				},
			] as never);
		state.loaderData = {
			...state.loaderData,
			providers: [
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [
						{
							value: "claude-sonnet-4-6",
							label: "Sonnet 4.6",
						},
					],
				},
				{
					id: "acp:opencode",
					label: "OpenCode",
					available: true,
					models: [],
				},
			],
		};

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));

		const unavailable = await screen.findByRole("status", {
			name: /Models unavailable/i,
		});
		fireEvent.click(within(unavailable).getByRole("button", { name: "Retry" }));

		expect(
			await screen.findByRole("button", { name: /^Allowed/ }),
		).toBeTruthy();
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("preserves a restored ACP model while dropping an unadvertised effort", async () => {
		state.model = "fake-smart";
		state.effort = "medium";
		const refresh = deferred<Array<Record<string, unknown>>>();
		vi.mocked(getProvidersFn).mockImplementation(
			() => refresh.promise as never,
		);
		const provider = {
			id: "acp:opencode",
			label: "OpenCode",
			available: true,
			models: [
				{ value: "fake-fast", label: "Fast" },
				{ value: "fake-smart", label: "Smart" },
			],
			effortLevels: [{ value: "medium", label: "Medium" }],
			permissionModes: [{ value: "default", label: "Ask" }],
		};
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "acp:opencode",
				acp_agents: [{ id: "opencode" }],
			},
			existingSessionId: "saved-acp",
			isExplicitSession: true,
			sessionPersisted: true,
			sessionModel: "fake-smart",
			sessionProviderId: "acp:opencode",
			sessionEffort: "medium",
			sessionPermissionMode: "default",
			providers: [provider],
		};

		render(<ChatPage />);
		const badge = screen.getByRole("button", {
			name: /OpenCode.*Smart.*Ask/i,
		});
		expect(badge.getAttribute("aria-label")).not.toContain("Medium");
		fireEvent.click(badge);
		expect(
			screen.getByRole("button", { name: "Provider default" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Smart" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Fast" })).toBeTruthy();

		await act(async () =>
			refresh.resolve([
				{
					...provider,
					modelCatalogRefresh: { status: "current", source: "live" },
				},
			]),
		);
		expect(await screen.findByRole("button", { name: "Smart" })).toBeTruthy();
	});

	it("does not let a late ACP refresh undo a newer provider selection", async () => {
		state.model = "claude-sonnet-4-6";
		const refresh = deferred<Array<Record<string, unknown>>>();
		const providers = [
			{
				id: "claude",
				label: "Claude",
				available: true,
				models: [
					{
						value: "claude-sonnet-4-6",
						label: "Sonnet 4.6",
						isDefault: true,
					},
				],
			},
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [{ value: "stale", label: "Stale", isDefault: true }],
			},
		];
		vi.mocked(getProvidersFn).mockImplementation(
			() => refresh.promise as never,
		);
		state.loaderData = {
			...state.loaderData,
			providers,
		};

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
		fireEvent.click(screen.getByRole("button", { name: "Claude" }));

		await act(async () =>
			refresh.resolve([
				providers[0] as Record<string, unknown>,
				{
					...providers[1],
					models: [{ value: "allowed", label: "Allowed", isDefault: true }],
					modelCatalogRefresh: { status: "current", source: "live" },
				},
			]),
		);

		expect(
			screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Allowed" })).toBeNull();
		const providerChanges = state.send.mock.calls
			.map(([message]) => message as { type?: string; provider?: string })
			.filter((message) => message.type === "set_provider");
		expect(providerChanges.map((message) => message.provider)).toEqual([
			"acp:opencode",
			"claude",
		]);

		// The accepted exact-workspace result is still published while Claude is
		// active, so returning to OpenCode consumes it immediately and does not
		// require another provider process or a second bounce.
		fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
		expect(screen.getByRole("button", { name: /^Allowed/ })).toBeTruthy();
		expect(getProvidersFn).toHaveBeenCalledOnce();
	});

	it("keeps ACP selected on provider default when refresh returns stale", async () => {
		state.model = "claude-sonnet-4-6";
		const initialProviders = [
			{
				id: "claude",
				label: "Claude",
				available: true,
				models: [
					{ value: "claude-sonnet-4-6", label: "Sonnet 4.6", isDefault: true },
				],
			},
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [{ value: "stale", label: "Stale", isDefault: true }],
				permissionModes: [{ value: "default", label: "Ask" }],
			},
		];
		vi.mocked(getProvidersFn).mockResolvedValue([
			initialProviders[0],
			{
				...initialProviders[1],
				modelCatalogRefresh: { status: "stale", source: "persisted" },
			},
		] as never);
		state.loaderData = {
			...state.loaderData,
			sessionPersisted: true,
			providers: initialProviders,
		};

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));

		await waitFor(() =>
			expect(getProvidersFn).toHaveBeenCalledWith({
				data: {
					refresh: true,
					refreshProviderId: "acp:opencode",
					discoveryCwd: "/vault",
				},
			}),
		);
		await act(async () => {});
		expect(state.send).toHaveBeenCalledWith({
			type: "set_provider",
			provider: "acp:opencode",
			session_id: expect.any(String),
		});
		expect(
			screen.getByRole("button", { name: "Provider default" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: /^Stale/ })).toBeTruthy();
		const cachedStatus = screen.getByRole("status", {
			name: "Showing cached models",
		});
		expect(
			within(cachedStatus).getByRole("button", { name: "Retry" }),
		).toBeTruthy();
	});

	it("keeps ACP selected on provider default when live refresh fails", async () => {
		state.model = "claude-sonnet-4-6";
		const cachedProviders = [
			{
				id: "claude",
				label: "Claude",
				available: true,
				models: [
					{ value: "claude-sonnet-4-6", label: "Sonnet 4.6", isDefault: true },
				],
			},
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [{ value: "stale", label: "Stale", isDefault: true }],
				permissionModes: [{ value: "default", label: "Ask" }],
			},
		];
		vi.mocked(getProvidersFn)
			.mockResolvedValueOnce(cachedProviders as never)
			.mockRejectedValueOnce(new Error("live refresh failed"));
		expect(await loadRavenProviders("/vault")).toEqual(cachedProviders);
		state.loaderData = {
			...state.loaderData,
			sessionPersisted: true,
			providers: cachedProviders,
		};

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));

		await waitFor(() => expect(getProvidersFn).toHaveBeenCalledTimes(2));
		await act(async () => {});
		expect(state.send).toHaveBeenCalledWith({
			type: "set_provider",
			provider: "acp:opencode",
			session_id: expect.any(String),
		});
		expect(
			screen.getByRole("button", { name: "Provider default" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: /^Stale/ })).toBeTruthy();
		const cachedStatus = screen.getByRole("status", {
			name: "Showing cached models",
		});
		expect(
			within(cachedStatus).getByRole("button", { name: "Retry" }),
		).toBeTruthy();
	});

	it("drops an ACP selection refresh after the active workspace context changes", async () => {
		state.model = "claude-sonnet-4-6";
		let resolveRefresh:
			| ((providers: Array<Record<string, unknown>>) => void)
			| undefined;
		vi.mocked(getProvidersFn).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveRefresh = resolve;
				}) as never,
		);
		state.loaderData = {
			...state.loaderData,
			sessionPersisted: true,
			config: {
				...(state.loaderData.config as object),
				agents: [
					{ path: "/context-project", mode: "context", provider: "codex" },
				],
			},
			agentList: [
				{
					path: "/context-project",
					name: "Context project",
					provider: "codex",
				},
			],
			providers: [
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [
						{
							value: "claude-sonnet-4-6",
							label: "Sonnet 4.6",
							isDefault: true,
						},
					],
				},
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
				},
				{
					id: "acp:opencode",
					label: "OpenCode",
					available: true,
					models: [{ value: "stale", label: "Stale", isDefault: true }],
				},
			],
		};

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", { name: /Claude.*Sonnet 4\.6/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
		await waitFor(() => expect(getProvidersFn).toHaveBeenCalledOnce());

		act(() => state.onAgentChange?.("/context-project"));
		await act(async () => {
			resolveRefresh?.(
				(state.loaderData.providers as Array<Record<string, unknown>>).map(
					(provider) =>
						provider.id === "acp:opencode"
							? {
									...provider,
									models: [
										{
											value: "allowed",
											label: "Allowed",
											isDefault: true,
										},
									],
									modelCatalogRefresh: {
										status: "current",
										source: "live",
									},
								}
							: provider,
				),
			);
		});

		expect(
			state.send.mock.calls.filter(
				([message]) =>
					(message as { type?: string; provider?: string }).type ===
						"set_provider" &&
					(message as { provider?: string }).provider === "acp:opencode",
			),
		).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "Allowed" })).toBeNull();
	});

	it("refreshes the workspace ACP provider selected through AgentSelect", async () => {
		state.model = "stale";
		state.effort = "";
		const freshProviders = [
			{
				id: "claude",
				label: "Claude",
				available: true,
			},
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [{ value: "allowed", label: "Allowed", isDefault: true }],
				modelCatalogRefresh: { status: "current", source: "live" },
				permissionModes: [{ value: "default", label: "Ask" }],
			},
		];
		vi.mocked(getProvidersFn).mockResolvedValue(freshProviders as never);
		state.loaderData = {
			...state.loaderData,
			sessionPersisted: false,
			config: {
				...(state.loaderData.config as object),
				agents: [
					{ path: "/open-project", mode: "cwd", provider: "acp:opencode" },
				],
			},
			agentList: [
				{
					path: "/open-project",
					name: "Open project",
					provider: "acp:opencode",
				},
			],
			providers: [
				freshProviders[0],
				{
					...freshProviders[1],
					models: [{ value: "stale", label: "Stale", isDefault: true }],
					modelCatalogRefresh: undefined,
				},
			],
		};

		render(<ChatPage />);
		act(() => state.onAgentChange?.("/open-project"));

		await waitFor(() =>
			expect(getProvidersFn).toHaveBeenCalledWith({
				data: {
					refresh: true,
					refreshProviderId: "acp:opencode",
					discoveryCwd: "/open-project",
				},
			}),
		);
		expect(
			await screen.findByRole("button", { name: /OpenCode.*Allowed.*Ask/i }),
		).toBeTruthy();
	});

	it("uses the provider-accepted ACP model and valid effort default instead of stale intent", async () => {
		state.model = "opencode/deepseek-v4-flash-free";
		state.effort = "medium";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "acp:opencode",
				acp_agents: [{ id: "opencode" }],
			},
			existingSessionId: "accepted-config-session",
			isExplicitSession: true,
			sessionModel: "opencode/deepseek-v4-flash-free",
			sessionProviderId: "acp:opencode",
			sessionEffort: "medium",
			sessionPermissionMode: "default",
			providers: [
				{
					id: "acp:opencode",
					label: "OpenCode",
					available: true,
					models: [
						{
							value: "opencode/deepseek-v4-flash-free",
							label: "DeepSeek V4 Flash Free",
						},
						{ value: "opencode/big-pickle", label: "Big Pickle" },
					],
					effortLevels: [{ value: "medium", label: "Medium" }],
					permissionModes: [{ value: "default", label: "Ask" }],
				},
			],
		};
		state.sessions = [
			{
				session_id: "accepted-config-live",
				db_session_id: "accepted-config-session",
				mode: "sdk",
				state: "idle",
				provider_id: "acp:opencode",
				model: "opencode/deepseek-v4-flash-free",
				effort: "medium",
				permission_mode: "default",
			},
		];

		render(<ChatPage />);
		act(() => {
			state.onMessage?.({
				type: "provider_config_options",
				provider_id: "acp:opencode",
				session_id: "accepted-config-session",
				models: [
					{
						value: "opencode/deepseek-v4-flash-free",
						label: "DeepSeek V4 Flash Free",
					},
					{
						value: "opencode/big-pickle",
						label: "Big Pickle",
						efforts: [{ value: "high", label: "High", isDefault: true }],
					},
				],
				activeModel: "opencode/big-pickle",
				// The prior model's stale value is not valid for Big Pickle.
				activeEffort: "medium",
			});
		});

		const badge = await screen.findByRole("button", {
			name: /OpenCode.*opencode\/big-pickle.*High.*Ask/i,
		});
		expect(
			screen.queryByRole("button", {
				name: /OpenCode.*DeepSeek.*Medium/i,
			}),
		).toBeNull();
		fireEvent.click(badge);
		expect(screen.getByRole("button", { name: /^High/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Medium" })).toBeNull();

		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "use the accepted config" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		const chat = state.send.mock.calls
			.map(([message]) => message)
			.find((message) => message.type === "chat");
		expect(chat).toMatchObject({
			type: "chat",
			provider: "acp:opencode",
			model: "opencode/big-pickle",
			effort: "high",
		});
	});

	it("omits ACP effort controls and effort submission for a no-effort first chat", async () => {
		const provider = {
			id: "acp:opencode",
			label: "OpenCode",
			available: true,
			models: [
				{
					value: "opencode/deepseek-v4-flash-free",
					label: "DeepSeek V4 Flash Free",
					isDefault: true,
				},
			],
			// This provider-wide value belongs to another model and must not leak.
			effortLevels: [{ value: "medium", label: "Medium" }],
			permissionModes: [{ value: "default", label: "Ask" }],
			modelCatalogRefresh: { status: "current", source: "live" },
		};
		vi.mocked(getProvidersFn).mockResolvedValue([provider] as never);
		state.model = "opencode/deepseek-v4-flash-free";
		state.effort = "medium";
		state.loaderData = {
			...state.loaderData,
			sessionPersisted: false,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "acp:opencode",
				acp_agents: [
					{
						id: "opencode",
						model: "opencode/deepseek-v4-flash-free",
						effort: "medium",
						permission_mode: "default",
					},
				],
			},
			providers: [provider],
		};

		render(<ChatPage />);
		const sessionId = state.subscribeToSession.mock.calls.at(-1)?.[0];
		expect(sessionId).toEqual(expect.any(String));
		act(() => {
			state.onMessage?.({
				type: "provider_config_options",
				provider_id: "acp:opencode",
				session_id: sessionId as string,
				models: [
					{
						value: "opencode/deepseek-v4-flash-free",
						label: "DeepSeek V4 Flash Free",
						isDefault: true,
					},
				],
				activeModel: "opencode/deepseek-v4-flash-free",
				activeEffort: "medium",
			});
		});
		const badge = await screen.findByRole("button", {
			name: /OpenCode.*opencode\/deepseek-v4-flash-free.*Ask/i,
		});
		expect(badge.getAttribute("aria-label")).not.toMatch(/medium/i);
		fireEvent.click(badge);
		expect(screen.queryByRole("button", { name: "Medium" })).toBeNull();

		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "run without effort" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		const chat = state.send.mock.calls
			.map(([message]) => message)
			.find((message) => message.type === "chat");
		expect(chat).toMatchObject({
			type: "chat",
			provider: "acp:opencode",
			model: "opencode/deepseek-v4-flash-free",
		});
		expect(chat).not.toHaveProperty("effort");
	});

	it("applies live dependent ACP effort and mode options to the active session", async () => {
		state.model = "fake-smart";
		state.effort = "medium";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "acp:opencode",
				acp_agents: [{ id: "opencode" }],
			},
			existingSessionId: "saved-session",
			isExplicitSession: true,
			sessionModel: "fake-smart",
			sessionProviderId: "acp:opencode",
			sessionEffort: "medium",
			sessionPermissionMode: "default",
			providers: [
				{
					id: "acp:opencode",
					label: "OpenCode",
					available: true,
					models: [
						{ value: "fake-fast", label: "Fast" },
						{ value: "fake-smart", label: "Smart" },
					],
					effortLevels: [{ value: "medium", label: "Medium" }],
					permissionModes: [{ value: "default", label: "Ask" }],
				},
			],
		};
		state.sessions = [
			{
				session_id: "live-session",
				db_session_id: "saved-session",
				mode: "sdk",
				state: "idle",
				provider_id: "acp:opencode",
				model: "fake-smart",
				effort: "medium",
				permission_mode: "default",
			},
		];
		const initialProviders = state.loaderData.providers;

		const view = render(<ChatPage />);
		act(() => {
			state.onMessage?.({
				type: "provider_config_options",
				provider_id: "acp:opencode",
				session_id: "saved-session",
				models: [
					{ value: "fake-fast", label: "Fast" },
					{
						value: "fake-smart",
						label: "Smart",
						efforts: [
							{ value: "high", label: "High", isDefault: true },
							{ value: "xhigh", label: "Extra High" },
						],
					},
				],
				activeModel: "fake-smart",
				activeEffort: "high",
				effortLevels: [
					{ value: "high", label: "High", isDefault: true },
					{ value: "xhigh", label: "Extra High" },
				],
				modes: [
					{ value: "build", label: "Build" },
					{ value: "plan", label: "Plan", isDefault: true },
					{ value: "review", label: "Review" },
				],
				activeMode: "plan",
				planModeValue: "plan",
			});
		});

		await waitFor(() =>
			expect(
				screen.getByRole("button", {
					name: /OpenCode.*Smart.*High.*Ask/i,
				}),
			).toBeTruthy(),
		);
		expect(screen.getByRole("button", { name: "plan" }).className).toContain(
			"text-primary",
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: /OpenCode.*Smart.*High.*Ask/i,
			}),
		);
		expect(screen.getByRole("button", { name: "Extra High" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Medium" })).toBeNull();

		state.loaderData = {
			...state.loaderData,
			providers: [
				{
					...(initialProviders as Array<Record<string, unknown>>)[0],
					label: "OpenCode Reloaded",
				},
			],
		};
		view.rerender(<ChatPage />);
		await screen.findByRole("button", {
			name: /OpenCode Reloaded.*Smart.*High.*Plan.*Ask/i,
		});
		expect(screen.getByRole("button", { name: "Extra High" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Review" }));
		expect(state.send).toHaveBeenCalledWith({
			type: "set_provider_mode",
			mode: "review",
			session_id: "saved-session",
		});
		// The control stays provider-authoritative instead of flipping on delivery.
		expect(screen.getByRole("button", { name: "plan" }).className).toContain(
			"text-primary",
		);
		act(() => {
			state.onMessage?.({
				type: "provider_config_options",
				provider_id: "acp:opencode",
				session_id: "saved-session",
				modes: [
					{ value: "build", label: "Build" },
					{ value: "plan", label: "Plan" },
					{ value: "review", label: "Review", isDefault: true },
				],
				activeMode: "review",
				planModeValue: "plan",
			});
		});
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "plan" }).className,
			).not.toContain("text-primary"),
		);

		fireEvent.click(screen.getByRole("button", { name: "plan" }));
		expect(state.send).toHaveBeenCalledWith({
			type: "set_provider_mode",
			mode: "plan",
			session_id: "saved-session",
		});
		expect(
			screen.getByRole("button", { name: "plan" }).className,
		).not.toContain("text-primary");
		act(() => {
			state.onMessage?.({
				type: "provider_config_options",
				provider_id: "acp:opencode",
				session_id: "saved-session",
				modes: [
					{ value: "build", label: "Build" },
					{ value: "plan", label: "Plan", isDefault: true },
					{ value: "review", label: "Review" },
				],
				activeMode: "plan",
				planModeValue: "plan",
			});
		});
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "plan" }).className).toContain(
				"text-primary",
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "plan" }));
		expect(state.send).toHaveBeenLastCalledWith({
			type: "restore_provider_mode",
			session_id: "saved-session",
		});
		// Plan remains authoritative while the provider restores Review.
		expect(screen.getByRole("button", { name: "plan" }).className).toContain(
			"text-primary",
		);
		act(() => {
			state.onMessage?.({
				type: "provider_config_options",
				provider_id: "acp:opencode",
				session_id: "saved-session",
				modes: [
					{ value: "build", label: "Build" },
					{ value: "plan", label: "Plan" },
					{ value: "review", label: "Review", isDefault: true },
				],
				activeMode: "review",
				planModeValue: "plan",
			});
		});
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "plan" }).className,
			).not.toContain("text-primary"),
		);

		vi.mocked(getProvidersFn).mockResolvedValue([
			{
				...(initialProviders as Array<Record<string, unknown>>)[0],
				modelCatalogRefresh: { status: "current", source: "live" },
			},
		] as never);
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "other-session",
			providers: initialProviders,
		};
		state.sessions = [];
		view.rerender(<ChatPage />);
		const resetBadge = await screen.findByRole("button", {
			name: /OpenCode.*Smart.*Ask/i,
		});
		expect(resetBadge.getAttribute("aria-label")).not.toMatch(/medium/i);
		expect(
			screen.getByRole("button", { name: "plan" }).className,
		).not.toContain("text-primary");
		fireEvent.click(resetBadge);
		expect(screen.queryByRole("button", { name: "Extra High" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Medium" })).toBeNull();
	});

	it("rebases an early live ACP snapshot onto a late provider catalog recovery", async () => {
		let resolveProviders: (providers: Array<Record<string, unknown>>) => void =
			() => {};
		const providerRead = new Promise<Array<Record<string, unknown>>>(
			(resolve) => {
				resolveProviders = resolve;
			},
		);
		vi.mocked(getProvidersFn).mockReturnValue(providerRead as never);
		state.model = "fake-smart";
		state.effort = "medium";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "acp:opencode",
				acp_agents: [{ id: "opencode" }],
			},
			existingSessionId: "late-catalog-session",
			isExplicitSession: true,
			sessionModel: "fake-smart",
			sessionProviderId: "acp:opencode",
			sessionEffort: "medium",
			sessionPermissionMode: "default",
			providers: [],
		};
		state.sessions = [
			{
				session_id: "late-catalog-live",
				db_session_id: "late-catalog-session",
				mode: "sdk",
				state: "idle",
				provider_id: "acp:opencode",
				model: "fake-smart",
				effort: "medium",
				permission_mode: "default",
			},
		];

		render(<ChatPage />);
		act(() => {
			state.onMessage?.({
				type: "provider_config_options",
				provider_id: "acp:opencode",
				session_id: "late-catalog-session",
				models: [
					{
						value: "fake-smart",
						label: "Smart",
						efforts: [
							{ value: "high", label: "High" },
							{ value: "xhigh", label: "Extra High", isDefault: true },
						],
					},
				],
				activeModel: "fake-smart",
				activeEffort: "xhigh",
				effortLevels: [
					{ value: "high", label: "High" },
					{ value: "xhigh", label: "Extra High", isDefault: true },
				],
				modes: [
					{ value: "build", label: "Build" },
					{ value: "review", label: "Review", isDefault: true },
				],
				activeMode: "review",
			});
		});
		expect(screen.queryByRole("button", { name: /xhigh.*Review/i })).toBeNull();

		await act(async () => {
			resolveProviders([
				{
					id: "acp:opencode",
					label: "OpenCode",
					available: true,
					models: [{ value: "fake-smart", label: "Smart" }],
					effortLevels: [{ value: "medium", label: "Medium" }],
					permissionModes: [{ value: "default", label: "Ask" }],
				},
			]);
			await providerRead;
		});

		const badge = await screen.findByRole("button", {
			name: /OpenCode.*Smart.*xhigh.*Review.*Ask/i,
		});
		fireEvent.click(badge);
		expect(screen.getByRole("button", { name: /^Extra High/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^Review/ })).toBeTruthy();
	});

	it("rolls an optimistic effort picker back on its correlated rejection", () => {
		configureEffortRejectionSession();
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*ask/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Max" }));
		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*max.*ask/i,
			}),
		).toBeTruthy();
		expect(state.send).toHaveBeenCalledWith({
			type: "set_effort",
			effort: "max",
			session_id: "saved-session",
		});

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "effort",
				attempted_value: "max",
				authoritative_value: "high",
				session_id: "saved-session",
			});
		});

		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*ask/i,
			}),
		).toBeTruthy();
	});

	it("ignores stale or mismatched effort rejections without clearing the pending value", () => {
		configureEffortRejectionSession();
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*ask/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Max" }));

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "effort",
				attempted_value: "xhigh",
				authoritative_value: "high",
				session_id: "saved-session",
			});
			state.onMessage?.({
				type: "session_control_rejected",
				control: "effort",
				attempted_value: "max",
				authoritative_value: "high",
				session_id: "another-session",
			});
		});

		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*max.*ask/i,
			}),
		).toBeTruthy();

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "effort",
				attempted_value: "max",
				authoritative_value: "high",
				session_id: "saved-session",
			});
		});
		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*ask/i,
			}),
		).toBeTruthy();
	});

	it("rolls an optimistic model picker back on its correlated rejection", () => {
		configureModelRejectionSession();
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*ask/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Opus 4.6" }));
		expect(
			screen.getByRole("button", {
				name: /claude.*opus-4-6.*high.*ask/i,
			}),
		).toBeTruthy();
		expect(state.send).toHaveBeenCalledWith({
			type: "set_model",
			model: "claude-opus-4-6",
			session_id: "saved-session",
		});

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "model",
				attempted_value: "claude-opus-4-6",
				authoritative_value: "claude-sonnet-4-6",
				session_id: "saved-session",
			});
		});

		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*ask/i,
			}),
		).toBeTruthy();
	});

	it("applies a late native or durable model rollback after pending clears", () => {
		configureModelRejectionSession("claude-opus-4-6");
		render(<ChatPage />);
		expect(
			screen.getByRole("button", {
				name: /claude.*opus-4-6.*high.*ask/i,
			}),
		).toBeTruthy();

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "model",
				attempted_value: "claude-opus-4-6",
				authoritative_value: "claude-sonnet-4-6",
				session_id: "saved-session",
			});
		});

		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*ask/i,
			}),
		).toBeTruthy();
	});

	it("ignores stale and cross-session model rejections", () => {
		configureModelRejectionSession();
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*ask/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Opus 4.6" }));
		fireEvent.click(screen.getByRole("button", { name: "Haiku 4.5" }));

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "model",
				attempted_value: "claude-opus-4-6",
				authoritative_value: "claude-sonnet-4-6",
				session_id: "saved-session",
			});
			state.onMessage?.({
				type: "session_control_rejected",
				control: "model",
				attempted_value: "claude-haiku-4-5",
				authoritative_value: "claude-sonnet-4-6",
				session_id: "another-session",
			});
		});

		expect(
			screen.getByRole("button", {
				name: /claude.*haiku-4-5.*high.*ask/i,
			}),
		).toBeTruthy();

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "model",
				attempted_value: "claude-haiku-4-5",
				authoritative_value: "claude-sonnet-4-6",
				session_id: "saved-session",
			});
		});
		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*ask/i,
			}),
		).toBeTruthy();
	});

	it("rolls an optimistic permission picker back on its correlated rejection", () => {
		configurePermissionRejectionSession();
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*ask/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Auto" }));
		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*auto/i,
			}),
		).toBeTruthy();

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "permission_mode",
				attempted_value: "auto",
				authoritative_value: "default",
				session_id: "saved-session",
			});
		});

		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*ask/i,
			}),
		).toBeTruthy();
		expect(screen.queryByRole("note")).toBeNull();
	});

	it("applies a native permission rejection after the pending marker has cleared", () => {
		configurePermissionRejectionSession("auto");
		render(<ChatPage />);
		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*auto/i,
			}),
		).toBeTruthy();

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "permission_mode",
				attempted_value: "auto",
				authoritative_value: "default",
				session_id: "saved-session",
			});
		});

		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*ask/i,
			}),
		).toBeTruthy();
	});

	it("applies an Auto downgrade without discarding a newer model selection", () => {
		configurePermissionRejectionSession("auto");
		const provider = (
			state.loaderData.providers as Array<{
				models: Array<Record<string, unknown>>;
			}>
		)[0];
		provider?.models.push({
			value: "haiku",
			resolvedModel: "claude-haiku-4-5",
			label: "Haiku 4.5",
		});
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*auto/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Haiku 4.5" }));
		expect(
			screen.getByRole("button", {
				name: /claude.*haiku.*auto/i,
			}),
		).toBeTruthy();

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "permission_mode",
				attempted_value: "auto",
				authoritative_value: "default",
				session_id: "saved-session",
			});
		});

		expect(
			screen.getByRole("button", {
				name: /claude.*haiku.*ask/i,
			}),
		).toBeTruthy();
	});

	it("ignores an older permission rejection while a newer mode is pending", () => {
		configurePermissionRejectionSession();
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*ask/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Auto" }));
		fireEvent.click(screen.getByRole("button", { name: "Pre-approved only" }));

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "permission_mode",
				attempted_value: "auto",
				authoritative_value: "default",
				session_id: "saved-session",
			});
		});
		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*pre-approved/i,
			}),
		).toBeTruthy();

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "permission_mode",
				attempted_value: "dontAsk",
				authoritative_value: "default",
				session_id: "saved-session",
			});
		});
		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*ask/i,
			}),
		).toBeTruthy();
	});

	it("ignores a permission rejection addressed to another session", () => {
		configurePermissionRejectionSession();
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*ask/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Auto" }));
		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "permission_mode",
				attempted_value: "auto",
				authoritative_value: "default",
				session_id: "another-session",
			});
		});

		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*auto/i,
			}),
		).toBeTruthy();
	});

	it.each([
		"provider-first",
		"permission-first",
	] as const)("rolls back an atomic provider selection with duplicate rejection order %s", (order) => {
		configureProviderRejectionSession();
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*auto/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Codex" }));
		expect(state.send).toHaveBeenCalledWith({
			type: "set_provider",
			provider: "codex",
			model: "gpt-5.6-sol",
			effort: "medium",
			permission_mode: "default",
			approvals_reviewer: "user",
			session_id: "saved-session",
		});
		expect(
			screen.getByRole("button", {
				name: /codex.*gpt-5\.6-sol.*medium.*ask/i,
			}),
		).toBeTruthy();

		const providerRejection = {
			type: "session_control_rejected",
			control: "provider",
			attempted_value: "codex",
			authoritative_value: "claude",
			session_id: "saved-session",
		} satisfies ServerMessage;
		const permissionRejection = {
			type: "session_control_rejected",
			control: "permission_mode",
			attempted_value: "default",
			authoritative_value: "auto",
			session_id: "saved-session",
		} satisfies ServerMessage;
		act(() => {
			if (order === "provider-first") {
				state.onMessage?.(providerRejection);
				state.onMessage?.(permissionRejection);
			} else {
				state.onMessage?.(permissionRejection);
				state.onMessage?.(providerRejection);
			}
		});

		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*auto/i,
			}),
		).toBeTruthy();
		expect(screen.getByRole("note")).toBeTruthy();
	});

	it("ignores mismatched and stale provider rejections until the latest selection rejects", () => {
		configureProviderRejectionSession();
		render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*auto/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Codex" }));
		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "provider",
				attempted_value: "codex",
				authoritative_value: "claude",
				session_id: "another-session",
			});
		});
		expect(
			screen.getByRole("button", {
				name: /codex.*gpt-5\.6-sol.*medium.*ask/i,
			}),
		).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Pi" }));
		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "provider",
				attempted_value: "codex",
				authoritative_value: "claude",
				session_id: "saved-session",
			});
		});
		expect(
			screen.getByRole("button", { name: /pi.*pi-pro.*low.*ask/i }),
		).toBeTruthy();

		act(() => {
			state.onMessage?.({
				type: "session_control_rejected",
				control: "provider",
				attempted_value: "pi",
				authoritative_value: "claude",
				session_id: "saved-session",
			});
		});
		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*auto/i,
			}),
		).toBeTruthy();
	});

	it("uses Claude's session catalog and exposes Auto on affirmative raw resolved-model capability", () => {
		configureClaudeSessionPermissions();
		render(<ChatPage />);

		const badge = screen.getByRole("button", {
			name: /claude.*sonnet 4\.6.*ask/i,
		});
		fireEvent.click(badge);
		expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Auto" })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Pre-approved only" }),
		).toBeTruthy();
		expect(screen.queryByText("Persistent ask only")).toBeNull();

		state.send.mockClear();
		fireEvent.click(screen.getByRole("button", { name: "Auto" }));
		expect(state.send).toHaveBeenCalledWith({
			type: "set_permission_mode",
			mode: "auto",
			session_id: expect.any(String),
		});
		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*auto/i,
			}),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*auto/i,
			}),
		);
		expect(
			screen.queryByRole("dialog", {
				name: "Session model and notification settings",
			}),
		).toBeNull();
		expect(
			screen.getByRole("note", {
				name: "Claude does not expose Auto classifier usage or cost, so Hlid Ledger totals exclude that overhead.",
			}),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*auto/i,
			}),
		);

		state.send.mockClear();
		fireEvent.click(screen.getByRole("button", { name: "Pre-approved only" }));
		expect(state.send).toHaveBeenCalledWith({
			type: "set_permission_mode",
			mode: "dontAsk",
			session_id: expect.any(String),
		});
		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*pre-approved/i,
			}),
		).toBeTruthy();
		expect(
			screen.queryByText(
				"Claude does not expose Auto classifier usage or cost, so Hlid Ledger totals exclude that overhead.",
			),
		).toBeNull();
	});

	it("fails Auto closed when raw model capability is unknown", () => {
		configureClaudeSessionPermissions({ supportsAutoMode: false });
		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*ask/i,
			}),
		);

		expect(screen.queryByRole("button", { name: "Auto" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Pre-approved only" }),
		).toBeTruthy();
	});

	it("explains that an unavailable saved Auto selection is rechecked on resume", () => {
		configurePermissionRejectionSession("auto");
		const provider = (
			state.loaderData.providers as Array<{
				models: Array<{ supportsAutoMode?: boolean }>;
			}>
		)[0];
		delete provider?.models[0]?.supportsAutoMode;
		state.sessions = [];

		render(<ChatPage />);

		expect(
			screen.getByRole("note", {
				name: "Auto is saved for this chat but is not currently available. Hlid will recheck it when the chat resumes and use Ask if Claude still rejects it.",
			}),
		).toBeTruthy();
		expect(
			screen.queryByText(
				"Claude does not expose Auto classifier usage or cost, so Hlid Ledger totals exclude that overhead.",
			),
		).toBeNull();

		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*auto/i,
			}),
		);
		expect(screen.queryByRole("button", { name: "Auto" })).toBeNull();
	});

	it("does not call a live accepted Auto session an unverified saved selection", () => {
		configurePermissionRejectionSession("auto");
		const provider = (
			state.loaderData.providers as Array<{
				models: Array<{ supportsAutoMode?: boolean }>;
			}>
		)[0];
		delete provider?.models[0]?.supportsAutoMode;

		render(<ChatPage />);

		expect(
			screen.queryByText(
				"Auto is saved for this chat but is not currently available. Hlid will recheck it when the chat resumes and use Ask if Claude still rejects it.",
			),
		).toBeNull();
		expect(
			screen.getByRole("note", {
				name: "Claude does not expose Auto classifier usage or cost, so Hlid Ledger totals exclude that overhead.",
			}),
		).toBeTruthy();
	});

	it("hides Claude advanced modes under Umbod and Auto under auto-sleep", () => {
		configureClaudeSessionPermissions({ umbod: true });
		const view = render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*ask/i,
			}),
		);
		expect(screen.queryByRole("button", { name: "Auto" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Pre-approved only" }),
		).toBeNull();

		view.unmount();
		configureClaudeSessionPermissions({ autoSleep: true });
		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*ask/i,
			}),
		);
		expect(screen.queryByRole("button", { name: "Auto" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Pre-approved only" }),
		).toBeTruthy();
	});

	it("does not expose Claude-only session modes through CLIProxy", () => {
		configureClaudeSessionPermissions({ providerId: "cliproxy-claude" });
		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", {
				name: /claude code.*cliproxy.*sonnet 4\.6.*ask/i,
			}),
		);
		expect(screen.queryByRole("button", { name: "Auto" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Pre-approved only" }),
		).toBeNull();
	});

	it("describes Claude MCP overrides as available under Auto or bypass", () => {
		configureClaudeSessionPermissions();
		render(<ChatPage />);
		fireEvent.click(screen.getByRole("button", { name: "MCP server status" }));
		expect(
			screen.getByText(
				"Per-server Claude approval becomes available when this live session uses Auto or bypass.",
			),
		).toBeTruthy();
	});

	it("only exposes approval reviewers for Codex and carries its default when switching", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "claude",
				claude: { model: "claude-sonnet-4-6" },
			},
			providers: [
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" }],
				},
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [
						{
							value: "gpt-5.6-sol",
							label: "GPT-5.6 Sol",
							isDefault: true,
						},
					],
					approvalReviewers: [
						{ value: "user", label: "User review", isDefault: true },
						{ value: "auto_review", label: "Auto-review" },
					],
				},
			],
		};

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", { name: /claude.*sonnet 4\.6/i }),
		);
		expect(screen.queryByText("approval reviewer")).toBeNull();
		expect(screen.queryByRole("button", { name: "Auto-review" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Codex" }));

		expect(state.send).toHaveBeenCalledWith({
			type: "set_provider",
			provider: "codex",
			model: "gpt-5.6-sol",
			approvals_reviewer: "user",
			session_id: expect.any(String),
		});
		expect(screen.getByText("approval reviewer")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Auto-review" })).toBeTruthy();
	});

	it("selects Codex auto-review and shows it on the session badge", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
				codex: { model: "gpt-5.6-sol" },
			},
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [{ value: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
					approvalReviewers: [
						{ value: "user", label: "User review", isDefault: true },
						{ value: "auto_review", label: "Auto-review" },
					],
				},
			],
		};

		render(<ChatPage />);
		fireEvent.click(
			screen.getByRole("button", { name: /codex.*gpt-5\.6-sol/i }),
		);
		state.send.mockClear();

		fireEvent.click(screen.getByRole("button", { name: "Auto-review" }));

		expect(state.send).toHaveBeenCalledWith({
			type: "set_approvals_reviewer",
			reviewer: "auto_review",
			session_id: expect.any(String),
		});
		expect(
			screen.getByRole("button", {
				name: /codex.*gpt-5\.6-sol.*auto-review/i,
			}),
		).toBeTruthy();
		expect(
			screen.getByText(
				"Codex does not expose Auto-review token usage, so Ledger excludes it.",
			),
		).toBeTruthy();
	});

	it("keeps auto-review unavailable while Hlid policy enforcement owns approvals", () => {
		state.approvalsReviewer = "auto_review";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
				codex: { model: "gpt-5.6-sol" },
				umbod: { enabled: true },
			},
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [{ value: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
					approvalReviewers: [
						{ value: "user", label: "User review", isDefault: true },
						{ value: "auto_review", label: "Auto-review" },
					],
				},
			],
		};

		render(<ChatPage />);
		const badge = screen.getByRole("button", {
			name: /codex.*gpt-5\.6-sol/i,
		});
		expect(badge.getAttribute("aria-label")).not.toMatch(/auto-review/i);
		fireEvent.click(badge);

		expect(screen.queryByRole("button", { name: "Auto-review" })).toBeNull();
		expect(screen.getByRole("button", { name: /User review/ })).toBeTruthy();
		expect(
			screen.getByText(
				"Auto-review is unavailable while Hlid policy enforcement is enabled.",
			),
		).toBeTruthy();
	});

	it("does not present auto-review as active when bypass mode has no approvals", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
				codex: {
					model: "gpt-5.6-sol",
					permission_mode: "bypassPermissions",
				},
			},
			existingSessionId: "bypass-review-session",
			isExplicitSession: true,
			sessionModel: "gpt-5.6-sol",
			sessionProviderId: "codex",
			sessionPermissionMode: "bypassPermissions",
			sessionApprovalsReviewer: "auto_review",
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [{ value: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
					approvalReviewers: [
						{ value: "user", label: "User review", isDefault: true },
						{ value: "auto_review", label: "Auto-review" },
					],
				},
			],
		};

		render(<ChatPage />);
		const badge = screen.getByRole("button", {
			name: /codex.*gpt-5\.6-sol/i,
		});
		expect(badge.getAttribute("aria-label")).not.toMatch(/auto-review/i);
		fireEvent.click(badge);

		expect(screen.queryByRole("button", { name: "Auto-review" })).toBeNull();
		expect(screen.getByRole("button", { name: /User review/ })).toBeTruthy();
		expect(
			screen.getByText(
				"Bypass permissions has no approval requests to review.",
			),
		).toBeTruthy();
	});

	it("keeps an optimistic model selection until live status acknowledges it", async () => {
		state.model = "gpt-5.6-terra";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
				codex: { model: "gpt-5.6-terra" },
			},
			existingSessionId: "saved-session",
			isExplicitSession: true,
			sessionModel: "gpt-5.6-terra",
			sessionProviderId: "codex",
			providers: [
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
		state.sessions = [
			{
				session_id: "live-session",
				db_session_id: "saved-session",
				mode: "sdk",
				state: "idle",
				provider_id: "codex",
				model: "gpt-5.6-terra",
			},
		];
		const view = render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", { name: /codex.*gpt-5\.6-terra/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Sol" }));
		expect(
			screen.getByRole("button", { name: /codex.*gpt-5\.6-sol/i }),
		).toBeTruthy();

		state.sessions = [
			{
				session_id: "live-session",
				db_session_id: "saved-session",
				mode: "sdk",
				state: "idle",
				provider_id: "codex",
				model: "gpt-5.6-terra",
			},
		];
		view.rerender(<ChatPage />);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /codex.*gpt-5\.6-sol/i }),
			).toBeTruthy(),
		);

		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "next turn" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(state.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: "chat", model: "gpt-5.6-sol" }),
		);

		state.sessions = [
			{
				session_id: "live-session",
				db_session_id: "saved-session",
				mode: "sdk",
				state: "idle",
				provider_id: "codex",
				model: "gpt-5.6-sol",
			},
		];
		view.rerender(<ChatPage />);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /codex.*gpt-5\.6-sol/i }),
			).toBeTruthy(),
		);
	});

	it("does not keep a dropped or disconnected model selection authoritative", async () => {
		state.model = "gpt-5.6-terra";
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
				codex: { model: "gpt-5.6-terra" },
			},
			existingSessionId: "saved-session",
			isExplicitSession: true,
			sessionModel: "gpt-5.6-terra",
			sessionProviderId: "codex",
			providers: [
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
		state.sessions = [
			{
				session_id: "live-session",
				db_session_id: "saved-session",
				mode: "sdk",
				state: "idle",
				provider_id: "codex",
				model: "gpt-5.6-terra",
			},
		];
		const view = render(<ChatPage />);

		fireEvent.click(
			screen.getByRole("button", { name: /codex.*gpt-5\.6-terra/i }),
		);
		state.send.mockReturnValue(false);
		fireEvent.click(screen.getByRole("button", { name: "Sol" }));
		expect(
			screen.getByRole("button", { name: /codex.*gpt-5\.6-terra/i }),
		).toBeTruthy();

		state.send.mockReturnValue(true);
		fireEvent.click(screen.getByRole("button", { name: "Sol" }));
		expect(
			screen.getByRole("button", { name: /codex.*gpt-5\.6-sol/i }),
		).toBeTruthy();

		state.wsStatus = "disconnected";
		view.rerender(<ChatPage />);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /codex.*gpt-5\.6-terra/i }),
			).toBeTruthy(),
		);
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
		expect(screen.queryByText("selected")).toBeNull();
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
		expect(screen.queryByText("actual")).toBeNull();
		expect(screen.getByText("configured")).toBeTruthy();
		expect(screen.getByText("selected")).toBeTruthy();
		expect(screen.queryByText("last used")).toBeNull();
	});

	it("keeps restored and switched provider metadata, commands, and composer state aligned", async () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "codex",
				codex: { model: "gpt-5.6-sol" },
			},
			existingSessionId: "saved-session",
			isExplicitSession: true,
			sessionModel: "claude-sonnet-4-6",
			sessionProviderId: "claude",
			providers: [
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" }],
				},
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [
						{
							value: "gpt-5.6-sol",
							label: "GPT-5.6-Sol",
							isDefault: true,
						},
					],
					effortLevels: [{ value: "medium", label: "Medium", isDefault: true }],
					permissionModes: [
						{ value: "default", label: "Ask", isDefault: true },
					],
				},
			],
		};
		render(<ChatPage />);

		expect(
			screen.getByRole("button", { name: /claude.*sonnet 4\.6/i }),
		).toBeTruthy();
		act(() => {
			state.onMessage?.({
				type: "mcp_status",
				provider_id: "codex",
				servers: [
					{ name: "stale-a", status: "connected", scope: "global" },
					{ name: "stale-b", status: "connected", scope: "global" },
				],
			});
			state.onMessage?.({
				type: "mcp_status",
				provider_id: "claude",
				servers: [
					{ name: "claude-tools", status: "connected", scope: "global" },
				],
			});
			state.onMessage?.({
				type: "slash_commands",
				provider_id: "claude",
				commands: [
					{
						name: "claude-only",
						description: "Claude command",
						argumentHint: "",
					},
				],
			});
		});
		expect(
			screen.getByRole("button", { name: "MCP server status" }).textContent,
		).toContain("1/1");

		const composer = screen.getByRole("combobox");
		fireEvent.change(composer, { target: { value: "/claude" } });
		fireEvent.click(
			screen.getByRole("button", { name: "Select /claude-only" }),
		);
		expect(
			screen.getByRole("button", {
				name: "Clear selected command /claude-only",
			}),
		).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: /claude.*sonnet 4\.6/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Codex" }));

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /codex.*gpt-5\.6-sol/i }),
			).toBeTruthy(),
		);
		expect(
			screen.queryByRole("button", {
				name: "Clear selected command /claude-only",
			}),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "MCP server status" }).textContent,
		).toContain("0");

		act(() => {
			state.onMessage?.({
				type: "mcp_status",
				provider_id: "claude",
				servers: [
					{ name: "stale-a", status: "connected", scope: "global" },
					{ name: "stale-b", status: "connected", scope: "global" },
				],
			});
			state.onMessage?.({
				type: "slash_commands",
				provider_id: "claude",
				commands: [
					{
						name: "stale-claude",
						description: "Stale command",
						argumentHint: "",
					},
				],
			});
			state.onMessage?.({
				type: "workflow_catalog",
				provider_id: "claude",
				workflows: [
					{
						id: "stale-workflow",
						name: "stale-workflow",
						description: "Stale workflow",
						argumentHint: "",
						scriptPath: "/vault/.claude/workflows/stale.js",
						scope: "project",
						scopeLabel: "Project",
						availableAsCommand: true,
					},
				],
				locations: [],
			});
		});
		fireEvent.change(composer, { target: { value: "/stale" } });
		expect(screen.queryByRole("button", { name: /Select \/stale/ })).toBeNull();
		expect(
			screen.getByRole("button", { name: "MCP server status" }).textContent,
		).toContain("0");

		act(() => {
			state.onMessage?.({
				type: "mcp_status",
				provider_id: "codex",
				servers: [
					{ name: "codex-tools", status: "connected", scope: "global" },
				],
			});
			state.onMessage?.({
				type: "slash_commands",
				provider_id: "codex",
				commands: [
					{
						name: "codex-only",
						description: "Codex command",
						argumentHint: "",
					},
				],
			});
			state.onMessage?.({
				type: "workflow_catalog",
				provider_id: "codex",
				workflows: [
					{
						id: "codex-workflow",
						name: "codex-workflow",
						description: "Codex workflow",
						argumentHint: "",
						scriptPath: "/vault/.codex/workflows/codex.js",
						scope: "project",
						scopeLabel: "Project",
						availableAsCommand: true,
					},
				],
				locations: [],
			});
		});
		expect(
			screen.getByRole("button", { name: "MCP server status" }).textContent,
		).toContain("1/1");
		fireEvent.change(composer, { target: { value: "/codex-only" } });
		expect(
			screen.getByRole("button", { name: "Select /codex-only" }),
		).toBeTruthy();
		fireEvent.change(composer, { target: { value: "/codex-workflow" } });
		expect(
			screen.getByRole("button", { name: "Select /codex-workflow" }),
		).toBeTruthy();

		const staleCodexHandler = state.onMessage;
		if (!screen.queryByRole("button", { name: "Claude" })) {
			fireEvent.click(
				screen.getByRole("button", { name: /codex.*gpt-5\.6-sol/i }),
			);
		}
		fireEvent.click(screen.getByRole("button", { name: "Claude" }));
		expect(
			screen.getByRole("button", { name: /claude.*sonnet 4\.6/i }),
		).toBeTruthy();

		act(() => {
			staleCodexHandler?.({
				type: "mcp_status",
				provider_id: "codex",
				servers: [
					{ name: "late-a", status: "connected", scope: "global" },
					{ name: "late-b", status: "connected", scope: "global" },
				],
			});
			staleCodexHandler?.({
				type: "slash_commands",
				provider_id: "codex",
				commands: [
					{
						name: "late-codex",
						description: "Late Codex command",
						argumentHint: "",
					},
				],
			});
			staleCodexHandler?.({
				type: "workflow_catalog",
				provider_id: "codex",
				workflows: [
					{
						id: "late-codex-workflow",
						name: "late-codex-workflow",
						description: "Late Codex workflow",
						argumentHint: "",
						scriptPath: "/vault/.codex/workflows/late.js",
						scope: "project",
						scopeLabel: "Project",
						availableAsCommand: true,
					},
				],
				locations: [],
			});
		});
		fireEvent.change(composer, { target: { value: "/late" } });
		expect(screen.queryByRole("button", { name: /Select \/late/ })).toBeNull();
		expect(
			screen.getByRole("button", { name: "MCP server status" }).textContent,
		).toContain("0");

		act(() => {
			state.onMessage?.({
				type: "mcp_status",
				provider_id: "claude",
				servers: [
					{ name: "claude-tools", status: "connected", scope: "global" },
				],
			});
			state.onMessage?.({
				type: "slash_commands",
				provider_id: "claude",
				commands: [
					{
						name: "current-claude",
						description: "Current Claude command",
						argumentHint: "",
					},
				],
			});
		});
		expect(
			screen.getByRole("button", { name: "MCP server status" }).textContent,
		).toContain("1/1");
		fireEvent.change(composer, { target: { value: "/current" } });
		expect(
			screen.getByRole("button", { name: "Select /current-claude" }),
		).toBeTruthy();
	});

	it("gives a live provider tuple ownership while preserving optimistic user switches", async () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as object),
				vault_provider: "claude",
				claude: {
					interactive_mode: false,
					model: "claude-sonnet-4-6",
					effort: "high",
					permission_mode: "default",
				},
			},
			existingSessionId: "saved-session",
			isExplicitSession: true,
			sessionModel: "claude-sonnet-4-6",
			sessionProviderId: "claude",
			sessionEffort: "high",
			sessionPermissionMode: "default",
			providers: [
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [
						{
							value: "claude-sonnet-4-6",
							label: "Sonnet 4.6",
							isDefault: true,
						},
					],
					effortLevels: [{ value: "high", label: "High", isDefault: true }],
					permissionModes: [
						{ value: "default", label: "Ask", isDefault: true },
					],
				},
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [
						{
							value: "gpt-5.6-sol",
							label: "GPT-5.6-Sol",
							isDefault: true,
						},
					],
					effortLevels: [{ value: "xhigh", label: "X-High", isDefault: true }],
					permissionModes: [
						{
							value: "bypassPermissions",
							label: "Auto-approve all",
							isDefault: true,
						},
					],
				},
			],
		};
		state.sessions = [
			{
				session_id: "live-session",
				db_session_id: "saved-session",
				mode: "sdk",
				state: "idle",
				provider_id: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permission_mode: "bypassPermissions",
			},
		];
		const view = render(<ChatPage />);

		expect(
			screen.getByRole("button", {
				name: /codex.*gpt-5\.6-sol.*xhigh.*bypass/i,
			}),
		).toBeTruthy();
		state.send.mockClear();
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "use the live owner" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(state.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chat",
				provider: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permission_mode: "bypassPermissions",
			}),
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: /codex.*gpt-5\.6-sol.*xhigh.*bypass/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Claude" }));
		expect(
			screen.getByRole("button", {
				name: /claude.*sonnet 4\.6.*high.*ask/i,
			}),
		).toBeTruthy();

		state.send.mockClear();
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "keep the optimistic switch" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(state.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chat",
				provider: "claude",
				model: "claude-sonnet-4-6",
				effort: "high",
				permission_mode: "default",
			}),
		);

		state.sessions = [
			{
				session_id: "live-session",
				db_session_id: "saved-session",
				mode: "sdk",
				state: "idle",
				provider_id: "claude",
				model: "claude-sonnet-4-6",
				effort: "high",
				permission_mode: "default",
			},
		];
		view.rerender(<ChatPage />);
		await waitFor(() =>
			expect(
				screen.getByRole("button", {
					name: /claude.*sonnet 4\.6.*high.*ask/i,
				}),
			).toBeTruthy(),
		);

		state.sessions = [
			{
				session_id: "live-session",
				db_session_id: "saved-session",
				mode: "sdk",
				state: "idle",
				provider_id: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permission_mode: "bypassPermissions",
			},
		];
		view.rerender(<ChatPage />);
		expect(
			screen.getByRole("button", {
				name: /codex.*gpt-5\.6-sol.*xhigh.*bypass/i,
			}),
		).toBeTruthy();

		state.send.mockClear();
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "follow the remote switch" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(state.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chat",
				provider: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permission_mode: "bypassPermissions",
			}),
		);
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
				name: /codex.*gpt-5\.5.*xhigh.*bypass/i,
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

	it("routes matching Codex goal messages without leaking them into chat", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				vault_provider: "codex",
				codex: { model: "gpt-5.6-sol" },
			},
			existingSessionId: "goal-session",
			isExplicitSession: true,
			sessionProviderId: "codex",
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [{ value: "gpt-5.6-sol", label: "Sol" }],
				},
			],
		};
		render(<ChatPage />);
		state.handleChatWsMessage.mockClear();
		const goalGetRequest = state.send.mock.calls.find(
			([message]) =>
				message.type === "goal_control" && message.action === "get",
		)?.[0];
		expect(goalGetRequest?.request_id).toEqual(expect.any(String));

		const goal = {
			thread_id: "thread-1",
			objective: "Finish the advisory cleanup",
			status: "active" as const,
			token_budget: 10_000,
			tokens_used: 250,
			time_used_seconds: 30,
			created_at: 1_700_000_000,
			updated_at: Math.floor(Date.now() / 1_000),
		};
		act(() => {
			state.onMessage?.({
				type: "goal_state",
				session_id: "other-session",
				provider_id: "codex",
				goal: { ...goal, objective: "Wrong session" },
			});
		});
		expect(screen.queryByText("Wrong session")).toBeNull();

		act(() => {
			state.onMessage?.({
				type: "goal_state",
				session_id: "goal-session",
				provider_id: "codex",
				request_id: goalGetRequest?.request_id,
				goal,
			});
		});
		expect(screen.getByText("Finish the advisory cleanup")).toBeTruthy();

		state.send.mockClear();
		fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
		const pauseRequest = state.send.mock.calls.find(
			([message]) =>
				message.type === "goal_control" && message.action === "pause",
		)?.[0];
		expect(pauseRequest).toEqual(
			expect.objectContaining({
				type: "goal_control",
				request_id: expect.any(String),
				session_id: "goal-session",
				action: "pause",
			}),
		);

		act(() => {
			state.onMessage?.({
				type: "goal_error",
				session_id: "goal-session",
				request_id: "not-the-active-request",
				message: "Ignore this error",
			});
		});
		expect(screen.queryByText("Ignore this error")).toBeNull();

		act(() => {
			state.onMessage?.({
				type: "goal_error",
				session_id: "goal-session",
				request_id: pauseRequest?.request_id ?? "",
				message: "Pause failed",
			});
		});
		expect(screen.getByText("Pause failed")).toBeTruthy();
		expect(state.handleChatWsMessage).not.toHaveBeenCalled();
	});

	it("keeps Raven metadata and workflow results out of the chat handler", () => {
		render(<ChatPage />);
		state.handleChatWsMessage.mockClear();

		act(() => {
			state.onMessage?.({
				type: "slash_commands",
				provider_id: "claude",
				commands: [
					{
						name: "diagnose",
						description: "Diagnose the current issue",
						argumentHint: "[scope]",
					},
				],
			});
			state.onMessage?.({
				type: "workflow_catalog",
				provider_id: "claude",
				workflows: [
					{
						id: "saved-audit",
						name: "saved-audit",
						description: "Audit the project",
						argumentHint: "[input]",
						scriptPath: "/project/.claude/workflows/saved-audit.js",
						scope: "project",
						scopeLabel: "Project",
						availableAsCommand: true,
					},
				],
				locations: [],
			});
			state.onMessage?.({
				type: "workflow_save_result",
				request_id: "save-1",
			});
			state.onMessage?.({
				type: "workflow_delete_result",
				request_id: "delete-1",
			});
			state.onMessage?.({
				type: "workflow_source_result",
				request_id: "source-1",
				script_path: "/project/.claude/workflows/saved-audit.js",
				source: "export default async function audit() {}",
			});
		});

		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "/diag" },
		});
		expect(
			screen.getByRole("button", { name: "Select /diagnose" }),
		).toBeTruthy();
		expect(state.handleChatWsMessage).not.toHaveBeenCalled();

		const runtimeError = {
			type: "error" as const,
			message: "Provider runtime failed",
		};
		act(() => state.onMessage?.(runtimeError));
		expect(state.handleChatWsMessage).toHaveBeenCalledWith(runtimeError);
	});

	it("shows a pending goal-start error while still forwarding the runtime error", () => {
		state.loaderData = {
			...state.loaderData,
			config: {
				...(state.loaderData.config as Record<string, unknown>),
				vault_provider: "codex",
				codex: { model: "gpt-5.6-sol" },
			},
			existingSessionId: "goal-session",
			isExplicitSession: true,
			sessionProviderId: "codex",
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [{ value: "gpt-5.6-sol", label: "Sol" }],
				},
			],
		};
		render(<ChatPage />);
		const goalGetRequest = state.send.mock.calls.find(
			([message]) =>
				message.type === "goal_control" && message.action === "get",
		)?.[0];
		act(() => {
			state.onMessage?.({
				type: "goal_state",
				session_id: "goal-session",
				provider_id: "codex",
				request_id: goalGetRequest?.request_id,
				goal: null,
			});
			state.onMessage?.({
				type: "slash_commands",
				provider_id: "codex",
				commands: [
					{
						name: "goal",
						description: "Control the Codex goal",
						argumentHint: "[objective]",
						action: "goal",
					},
				],
			});
		});

		const composer = screen.getByRole("combobox");
		fireEvent.change(composer, { target: { value: "/goal" } });
		fireEvent.click(screen.getByRole("button", { name: "Select /goal" }));
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		fireEvent.change(screen.getByRole("textbox", { name: "Goal objective" }), {
			target: { value: "Finish the Raven cleanup" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(screen.getByText("Finish the Raven cleanup")).toBeTruthy();

		state.handleChatWsMessage.mockClear();
		const runtimeError = {
			type: "error" as const,
			message: "Goal startup failed",
		};
		act(() => state.onMessage?.(runtimeError));

		expect(screen.getByText("Goal startup failed")).toBeTruthy();
		expect(screen.queryByText("Finish the Raven cleanup")).toBeNull();
		expect(state.handleChatWsMessage).toHaveBeenCalledWith(runtimeError);
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

	it("discards a remembered agent that is no longer configured", async () => {
		localStorage.setItem("hlid:raven:last-session", "stale-agent-chat");
		localStorage.setItem("hlid:raven:last-agent", "/tmp/removed-test-agent");
		state.search = {
			session: "stale-agent-chat",
			agent: "/tmp/removed-test-agent",
		};
		state.loaderData = {
			...state.loaderData,
			existingSessionId: "stale-agent-chat",
			isExplicitSession: true,
			agentSkillContext: undefined,
			agentList: [
				{ path: "/current-project", name: "Current", provider: "claude" },
			],
		};

		render(<ChatPage />);

		await waitFor(() => {
			expect(screen.getByTestId("agent-select").dataset.value).toBe("");
			expect(localStorage.getItem("hlid:raven:last-agent")).toBeNull();
		});
		const normalizedNavigation = state.navigate.mock.calls
			.map(([options]) => options as { search?: unknown })
			.find((options) => {
				if (typeof options.search !== "function") return false;
				const next = options.search(state.search) as Record<string, unknown>;
				return next.session === "stale-agent-chat" && next.agent === undefined;
			});
		expect(normalizedNavigation).toBeTruthy();
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
			vi.fn(() => ({
				matches: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
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
		vi.mocked(getCockpitSkillsFn).mockResolvedValue([] as never);
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

	it("uses the process-free provider snapshot for a rowless ACP session", async () => {
		vi.mocked(getConfig).mockResolvedValue(
			makeLoaderConfig({
				vault_provider: "acp:opencode",
				acp_agents: [{ id: "opencode" }],
			}) as never,
		);
		const filteredProviders = [
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [{ value: "allowed", label: "Allowed" }],
			},
		];
		vi.mocked(getProvidersFn).mockResolvedValue(filteredProviders as never);

		const data = await route.loader({ deps: { session: "new-acp" } });

		expect(data.sessionPersisted).toBe(false);
		expect(data.providers).toEqual(filteredProviders);
		expect(getProvidersFn).toHaveBeenCalledWith({
			data: { preferCachedModels: true, discoveryCwd: "/vault" },
		});
	});

	it("does not join an overlapping ACP refresh during route navigation", async () => {
		const liveRefresh = deferred<Array<Record<string, unknown>>>();
		const navigationRead = deferred<Array<Record<string, unknown>>>();
		vi.mocked(getProvidersFn)
			.mockImplementationOnce(() => liveRefresh.promise as never)
			.mockImplementationOnce(() => navigationRead.promise as never);
		const refreshing = refreshRavenProvider("acp:opencode", "/vault");

		const loading = route.loader({ deps: { session: "overlap-session" } });
		await waitFor(() => expect(getProvidersFn).toHaveBeenCalledTimes(2));
		expect(getProvidersFn).toHaveBeenNthCalledWith(2, {
			data: { preferCachedModels: true, discoveryCwd: "/vault" },
		});

		const cachedProviders = [
			{ id: "acp:opencode", label: "OpenCode", available: true },
		];
		navigationRead.resolve(cachedProviders);
		const data = await loading;
		expect(data.providers).toEqual(cachedProviders);

		liveRefresh.resolve([
			{
				...cachedProviders[0],
				models: [{ value: "allowed", label: "Allowed" }],
				modelCatalogRefresh: { status: "current", source: "live" },
			},
		]);
		await refreshing;
	});

	it("keeps cached provider navigation for a persisted ACP session", async () => {
		vi.mocked(getConfig).mockResolvedValue(
			makeLoaderConfig({
				vault_provider: "acp:opencode",
				acp_agents: [{ id: "opencode" }],
			}) as never,
		);
		vi.mocked(getSessionRowFn).mockResolvedValue({ id: "saved-acp" } as never);

		const data = await route.loader({ deps: { session: "saved-acp" } });

		expect(data.sessionPersisted).toBe(true);
		expect(getProvidersFn).toHaveBeenCalledWith({
			data: { preferCachedModels: true, discoveryCwd: "/vault" },
		});
	});

	it("discards an explicit route agent that is no longer configured", async () => {
		const data = await route.loader({
			deps: { session: "s1", agent: "/tmp/removed-test-agent" },
		});
		expect(data.agentSkillContext).toBeUndefined();
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
				data: { preferCachedModels: true, discoveryCwd: "/vault" },
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
			vi.mocked(getCockpitSkillsFn).mockImplementation(
				() => new Promise(() => {}),
			);
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

	it("defers provider usage until after Raven navigation", async () => {
		vi.mocked(getProvidersFn).mockResolvedValue([
			{ id: "codex", label: "Codex", available: true },
		] as never);

		const data = await route.loader({ deps: { session: "s1" } });

		expect(data.existingSessionId).toBe("s1");
		expect(data.providerUsages).toEqual([]);
		expect(loadProviderUsages).not.toHaveBeenCalled();
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

	it("does not make a background delegated child the default Raven session", async () => {
		vi.mocked(getLiveSessionsFn).mockResolvedValue([
			{ mode: "chat", db_session_id: "focused-parent" },
			{
				mode: "chat",
				db_session_id: "background-child",
				delegation_parent_session_id: "focused-parent",
			},
		] as never);

		const data = await route.loader({ deps: {} });

		expect(data.existingSessionId).toBe("focused-parent");
		expect(getCurrentSessionFn).not.toHaveBeenCalled();
	});

	it("falls back to the current DB session when no live SDK session exists", async () => {
		vi.mocked(getCurrentSessionFn).mockResolvedValue("cur" as never);
		const data = await route.loader({ deps: {} });
		expect(data.existingSessionId).toBe("cur");
	});

	it("uses a cwd-mode agent workspace for provider options", async () => {
		vi.mocked(getConfig).mockResolvedValue(
			makeLoaderConfig({ agents: [{ path: "/proj", mode: "cwd" }] }) as never,
		);
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
		expect(getProvidersFn).toHaveBeenCalledWith({
			data: { preferCachedModels: true, discoveryCwd: "/proj" },
		});
	});

	it("uses the vault workspace for context-mode agent options", async () => {
		vi.mocked(getConfig).mockResolvedValue(
			makeLoaderConfig({
				agents: [{ path: "/proj", mode: "context" }],
			}) as never,
		);
		vi.mocked(getCurrentSessionFn).mockResolvedValue("cur" as never);
		vi.mocked(getSessionSelectionFn).mockResolvedValue({
			agentCwd: "/proj",
			providerId: "acp:opencode",
			model: null,
			effort: null,
			permissionMode: null,
		} as never);

		const data = await route.loader({ deps: {} });

		expect(data.agentSkillContext).toBe("/proj");
		expect(getProvidersFn).toHaveBeenCalledWith({
			data: { preferCachedModels: true, discoveryCwd: "/vault" },
		});
	});

	it("normalizes an equivalent saved WSL path to the configured agent path", async () => {
		vi.mocked(getConfig).mockResolvedValue(
			makeLoaderConfig({
				agents: [{ path: "/home/kyle/project" }],
			}) as never,
		);
		vi.mocked(getCurrentSessionFn).mockResolvedValue("cur" as never);
		vi.mocked(getSessionSelectionFn).mockResolvedValue({
			agentCwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\project",
			providerId: null,
			model: null,
			effort: null,
			permissionMode: null,
		} as never);

		const data = await route.loader({ deps: {} });

		expect(data.agentSkillContext).toBe("/home/kyle/project");
	});

	it("restores all controls selected for the resolved session", async () => {
		vi.mocked(getConfig).mockResolvedValue(
			makeLoaderConfig({ agents: [{ path: "/proj" }] }) as never,
		);
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

	it("does not reactivate a saved agent cwd that is no longer configured", async () => {
		vi.mocked(getCurrentSessionFn).mockResolvedValue("cur" as never);
		vi.mocked(getSessionSelectionFn).mockResolvedValue({
			agentCwd: "/tmp/removed-test-agent",
			providerId: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "bypassPermissions",
		} as never);

		const data = await route.loader({ deps: {} });

		expect(data).toMatchObject({
			agentSkillContext: undefined,
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

	it("loads durable delegation provenance for the resolved session", async () => {
		vi.mocked(getCurrentSessionFn).mockResolvedValue("child" as never);
		vi.mocked(getSessionRowFn).mockResolvedValue({
			delegation_parent_session_id: "parent",
			delegation_parent_label: "Parent task",
			delegation_depth: 1,
			delegation_control_owned: 1,
		} as never);

		const data = await route.loader({ deps: {} });

		expect(data).toMatchObject({
			delegationParentSessionId: "parent",
			delegationParentLabel: "Parent task",
			delegationDepth: 1,
			delegationControlOwned: true,
		});
		expect(getSessionRowFn).toHaveBeenCalledWith({ data: "child" });
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
