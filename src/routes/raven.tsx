import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	Blocks,
	FileCode,
	GitFork,
	Headphones,
	LoaderCircle,
	MessageSquare,
	Mic,
	MicOff,
	Monitor,
	Paperclip,
	ShieldCheck,
	Square,
	SquarePen,
	TerminalIcon,
	X,
} from "lucide-react";
import {
	type Dispatch,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type SetStateAction,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { AgentSelect } from "#/components/AgentSelect";
import { AttachmentStrip } from "#/components/AttachmentStrip";
import { ActiveCommandBadges } from "#/components/chat/ActiveCommandBadge";
import { ContextInspectorDialog } from "#/components/chat/ContextInspectorDialog";
import { reducer } from "#/components/chat/chatReducer";
import { FileRewindDialog } from "#/components/chat/FileRewindDialog";
import {
	LiveSessionSwitcher,
	LiveSessionToggle,
} from "#/components/chat/LiveSessionSwitcher";
import { MessageList } from "#/components/chat/MessageList";
import { ProjectPreviewPane } from "#/components/chat/ProjectPreviewPane";
import { RavenGoalStrip } from "#/components/chat/RavenGoalStrip";
import { SessionNotificationOverrideControl } from "#/components/chat/SessionNotificationOverrideControl";
import {
	VaultReferenceBadges,
	VaultReferencePicker,
	WorkspaceReferenceBadges,
} from "#/components/chat/VaultReferencePicker";
import { WorkflowManagerDialog } from "#/components/chat/WorkflowManagerDialog";
import { SlashPicker } from "#/components/cockpit/SlashPicker";
import { McpIndicator } from "#/components/McpIndicator";
import { ObsidianActiveNoteButton } from "#/components/ObsidianActiveNoteButton";
import { PrivacyMask } from "#/components/PrivacyMask";
import { ProviderAppsDialog } from "#/components/ProviderAppsCatalog";
import { TerminalView } from "#/components/TerminalView";
import { ProviderUsageStrip } from "#/components/usage/ProviderUsageStrip";
import { ContextWindowSection } from "#/components/usage/UsageWindowSections";
import { useCodexRealtime } from "#/hooks/codexRealtimeStore";
import {
	useProjectPreview,
	useProjectPreviewPresentationRequest,
} from "#/hooks/projectPreviewStore";
import {
	rememberedRavenAgent,
	rememberRavenSessionId,
} from "#/hooks/ravenSessionStore";
import {
	forgetRavenTerminal,
	isRavenTerminalOpen,
	rememberRavenTerminal,
} from "#/hooks/ravenTerminalStore";
import { useChatWsHandler } from "#/hooks/useChatWsHandler";
import { useCommands } from "#/hooks/useCommands";
import { useDraft } from "#/hooks/useDraft";
import { useFileUpload } from "#/hooks/useFileUpload";
import { useLoadChatHistory } from "#/hooks/useLoadChatHistory";
import { useNotificationPresence } from "#/hooks/useNotificationPresence";
import { useSlashPicker } from "#/hooks/useSlashPicker";
import { useVaultReferencePicker } from "#/hooks/useVaultReferencePicker";
import { uploadVoiceRecording, useVoiceInput } from "#/hooks/useVoiceInput";
import { useWs } from "#/hooks/useWs";
import { useWsChatQueue, useWsLiveStats } from "#/hooks/useWsSelectors";
import { clearChatQueue } from "#/hooks/wsChatQueueStore";
import {
	getDataRevisionSnapshot,
	subscribeDataRevisionSnapshot,
} from "#/hooks/wsDataRevisionStore";
import { resetLiveStats } from "#/hooks/wsLiveStatsStore";
import {
	canonicalSessionId,
	getSessionsStatus,
	subscribeSessionsStatus,
} from "#/hooks/wsSessionStatusStore";
import * as wsStore from "#/hooks/wsStore";
import {
	type AgentDisplayCandidate,
	agentDisplayName,
	sameAgentDisplayPath,
} from "#/lib/agentDisplay";
import {
	addCommandSelection,
	type CommandDescriptor,
	filterProviderCompatibleCommands,
	type ProviderCommand,
	parseGoalCommand,
	parseRenameCommand,
	resolveCommandSubmission,
} from "#/lib/commands";
import {
	composerKeyAction,
	insertAtSelection,
	prepareChatSubmission,
	resizeComposer,
	responsiveComposerMaxHeight,
	runComposerPickerAction,
} from "#/lib/composer";
import {
	deriveModelMismatch,
	fmtModel,
	modelComparisonKey,
} from "#/lib/formatters";
import type { HlidContextReceiptTarget } from "#/lib/hlidContext";
import { applyLiveProviderConfig } from "#/lib/liveProviderConfig";
import { loaderValueOrFallback } from "#/lib/loaderFallback";
import { mapMcpServer } from "#/lib/mcp";
import { configuredObsidianCapture } from "#/lib/obsidianCapture";
import { isCliProxyProvider } from "#/lib/providerIds";
import {
	codexRealtimeAvailability,
	effortOptionsFor,
	modelInputAvailability,
	modelOptions,
	normalizeEffortForPlanMode,
	permissionModeBadgeLabel,
	resolveActiveProviderId,
	sessionPermissionOptionsFor,
} from "#/lib/providerOptions";
import {
	isClaudeRuntimeProvider,
	isCodexRuntimeProvider,
} from "#/lib/providerRuntime";
import {
	getRavenProviderCacheSnapshot,
	hasFreshRavenProviderModels,
	loadRavenProviders,
	loadRavenProvidersForNavigation,
	refreshRavenProviderForSession,
	subscribeRavenProviderCache,
} from "#/lib/ravenProviderCache";
import {
	createAnimationFrameCoalescer,
	isNearChatBottom,
	loadOlderPreservingScroll,
	ROUTE_SCROLL_RESTORATION_IDS,
	resetScrollAncestors,
	scrollChatToBottom,
	touchMovesTowardOlderMessages,
} from "#/lib/scrollContainers";
import { getAgentListFn } from "#/lib/serverFns/agents";
import { getCockpitSkillsFn } from "#/lib/serverFns/cockpit";
import { getConfig } from "#/lib/serverFns/config";
import {
	type getProvidersFn,
	loadProviderUsages,
} from "#/lib/serverFns/providers";
import {
	ensureSessionFn,
	forkSessionFn,
	getCurrentSessionFn,
	getLiveSessionsFn,
	getSessionRowFn,
	getSessionSelectionFn,
	renameSessionFn,
	setSessionArchivedFn,
} from "#/lib/serverFns/sessions";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";
import { uid } from "#/lib/utils";
import { voiceInputPresentation } from "#/lib/voiceInputPresentation";
import type { ProviderApprovalsReviewer } from "#/server/agentProvider";
import {
	type ChatAttachment,
	decisionFromScope,
	type ErrorMessage,
	type FileRewindResultMessage,
	type GoalErrorMessage,
	type GoalState,
	type GoalStateMessage,
	type McpControlAction,
	type McpControlOperation,
	type McpControlResultMessage,
	type McpStatusMessage,
	type ProviderConfigOptionsMessage,
	type RateLimitMessage,
	type SessionControlRejectedMessage,
	type SlashCommandsMessage,
	type WorkflowCatalogMessage,
	type WorkflowDeleteResultMessage,
	type WorkflowSaveResultMessage,
	type WorkflowSourceResultMessage,
} from "#/server/protocol";

type RavenPaneTab = "chat" | "terminal" | "preview";

export function ravenTabAfterProjectPreviewStops(
	tab: RavenPaneTab,
): RavenPaneTab {
	return tab === "preview" ? "chat" : tab;
}

export function isNewProjectPreviewPresentationRequest(
	request: number,
	requestAtSessionEntry: number,
): boolean {
	return request > requestAtSessionEntry;
}

export function ravenSleepDetail(
	sleepState: Partial<
		Pick<wsStore.SleepBanner, "reason" | "utilization" | "windowId">
	>,
): string {
	if (sleepState.utilization != null) {
		if (sleepState.windowId === "spend_control") {
			return ` — spend control at ${Math.round(sleepState.utilization * 100)}%`;
		}
		const window = sleepState.windowId === "weekly" ? "weekly" : "five-hour";
		return ` — ${window} usage at ${Math.round(sleepState.utilization * 100)}%`;
	}
	if (sleepState.reason !== "limit_reached") return "";
	if (sleepState.windowId === "spend_control") return " — spend limit reached";
	return ` — ${sleepState.windowId === "weekly" ? "weekly " : ""}usage limit reached`;
}
const RAVEN_PREVIEW_WIDTH_KEY = "hlid:raven-preview-width";

// ─── route ───────────────────────────────────────────────────────────────────

type RavenConfig = Awaited<ReturnType<typeof getConfig>>;
type RavenLiveSessions = Awaited<ReturnType<typeof getLiveSessionsFn>>;
const RAVEN_OPTIONAL_LOADER_WAIT_MS = 500;
const CLAUDE_AUTO_ACCOUNTING_DISCLOSURE =
	"Claude does not expose Auto classifier usage or cost, so Hlid Ledger totals exclude that overhead.";
const CLAUDE_SAVED_AUTO_RECHECK_NOTICE =
	"Auto is saved for this chat but is not currently available. Hlid will recheck it when the chat resumes and use Ask if Claude still rejects it.";

/** Optional inventory must never hold the route pending behind an API timeout. */
function optionalRavenLoaderValue<T>(
	read: Promise<T>,
	fallback: T,
): Promise<T> {
	return loaderValueOrFallback(read, fallback, RAVEN_OPTIONAL_LOADER_WAIT_MS);
}

function interactiveModeForAgent(
	config: RavenConfig,
	agentPath: string | undefined,
): boolean {
	return (
		(config.agents ?? []).find((candidate) => candidate.path === agentPath)
			?.interactive_mode ??
		config.claude?.interactive_mode ??
		false
	);
}

function ravenProviderDiscoveryCwd(
	config: RavenConfig,
	agentPath: string | undefined,
): string | undefined {
	if (!agentPath) return config.vault.path || undefined;
	const configured = (config.agents ?? []).find((candidate) =>
		sameAgentDisplayPath(candidate.path, agentPath),
	);
	return configured?.mode === "context"
		? config.vault.path || undefined
		: agentPath;
}

function configuredRavenAgentPath(
	candidate: string | null | undefined,
	configuredAgents: readonly AgentDisplayCandidate[],
): string | undefined {
	if (!candidate) return undefined;
	const match = configuredAgents.find(
		(agent) =>
			sameAgentDisplayPath(agent.path, candidate) ||
			(agent.resolvedPath != null &&
				sameAgentDisplayPath(agent.resolvedPath, candidate)),
	);
	return match?.path;
}

async function resolveSdkSession(
	explicitSession: string | undefined,
	interactiveMode: boolean,
	liveSessions: RavenLiveSessions,
): Promise<string | null> {
	if (explicitSession) return explicitSession;
	if (interactiveMode) return null;
	const newestLiveSdk = liveSessions
		.slice()
		.reverse()
		.find(
			(candidate) =>
				candidate.mode !== "terminal" &&
				candidate.db_session_id &&
				!candidate.delegation_parent_session_id,
		);
	return newestLiveSdk?.db_session_id ?? (await getCurrentSessionFn());
}

function resolveTerminalSession(
	currentSession: string | null,
	interactiveMode: boolean,
	agentPath: string | undefined,
	vaultPath: string,
	liveSessions: RavenLiveSessions,
): string | null {
	if (currentSession || !interactiveMode) return currentSession;
	const cwd = agentPath ?? vaultPath;
	const liveTerminal = liveSessions
		.slice()
		.reverse()
		.find(
			(candidate) =>
				candidate.mode === "terminal" &&
				candidate.state === "running" &&
				candidate.agent_cwd === cwd,
		);
	return liveTerminal?.db_session_id ?? liveTerminal?.session_id ?? null;
}

async function loadRavenRoute(session?: string, agent?: string) {
	const explicitSelection = session
		? getSessionSelectionFn({ data: session })
		: Promise.resolve(null);
	const explicitRow = session
		? getSessionRowFn({ data: session })
		: Promise.resolve(null);
	const liveSessionsRead = session
		? Promise.resolve([] as RavenLiveSessions)
		: getLiveSessionsFn();
	const [
		config,
		agentList,
		vaultSkills,
		voiceInfo,
		explicitSessionSelection,
		explicitSessionRow,
		liveSessions,
	] = await Promise.all([
		getConfig(),
		optionalRavenLoaderValue(getAgentListFn(), []),
		optionalRavenLoaderValue(getCockpitSkillsFn(), []),
		optionalRavenLoaderValue(getVoiceInfoFn(), {
			status: { state: "unavailable", model: "" },
			models: [],
		}),
		explicitSelection,
		explicitRow,
		liveSessionsRead,
	]);
	// Usage is presentation-only and ChatPage already hydrates an empty snapshot.
	// Keeping it out of the loader removes a second provider round trip from the
	// route's interactive critical path.
	const providerUsages: Awaited<ReturnType<typeof loadProviderUsages>> = [];
	const configuredAgents = [
		...agentList,
		...(config.agents ?? []),
	] satisfies AgentDisplayCandidate[];
	const explicitAgent = configuredRavenAgentPath(agent, configuredAgents);
	const routeInteractiveMode = interactiveModeForAgent(config, explicitAgent);
	let resolvedSessionId = await resolveSdkSession(
		session,
		routeInteractiveMode,
		liveSessions,
	);
	let agentSkillContext = explicitAgent;
	let sessionModel: string | null = null;
	let sessionProviderId: string | null = null;
	let sessionEffort: string | null = null;
	let sessionPermissionMode: string | null = null;
	let sessionApprovalsReviewer: string | null = null;
	let forkParentSessionId: string | null = null;
	let forkKind: "exact" | "recap" | null = null;
	let delegationParentSessionId: string | null = null;
	let delegationParentLabel: string | null = null;
	let delegationDepth: number | null = null;
	let delegationControlOwned = false;
	let sessionPersisted = false;
	if (resolvedSessionId) {
		const [savedSelection, savedRow] = await Promise.all([
			resolvedSessionId === session
				? explicitSessionSelection
				: getSessionSelectionFn({ data: resolvedSessionId }),
			resolvedSessionId === session
				? explicitSessionRow
				: getSessionRowFn({ data: resolvedSessionId }),
		]);
		agentSkillContext ||=
			configuredRavenAgentPath(savedSelection?.agentCwd, configuredAgents) ??
			undefined;
		sessionModel = savedSelection?.model ?? null;
		sessionProviderId = savedSelection?.providerId ?? null;
		sessionEffort = savedSelection?.effort ?? null;
		sessionPermissionMode = savedSelection?.permissionMode ?? null;
		sessionApprovalsReviewer = savedSelection?.approvalsReviewer ?? null;
		forkParentSessionId = savedRow?.fork_parent_session_id ?? null;
		forkKind = savedRow?.fork_kind ?? null;
		delegationParentSessionId = savedRow?.delegation_parent_session_id ?? null;
		delegationParentLabel = savedRow?.delegation_parent_label ?? null;
		delegationDepth = savedRow?.delegation_depth ?? null;
		delegationControlOwned = savedRow?.delegation_control_owned === 1;
		sessionPersisted = savedRow !== null;
	}
	const providerDiscoveryCwd = ravenProviderDiscoveryCwd(
		config,
		agentSkillContext,
	);
	const providers = await optionalRavenLoaderValue(
		loadRavenProvidersForNavigation(providerDiscoveryCwd),
		[],
	);
	const interactiveMode = interactiveModeForAgent(config, agentSkillContext);
	resolvedSessionId = resolveTerminalSession(
		resolvedSessionId,
		interactiveMode,
		agentSkillContext,
		config.vault.path,
		liveSessions,
	);

	return {
		config,
		existingSessionId: resolvedSessionId,
		isExplicitSession: Boolean(session),
		sessionPersisted,
		providerUsages,
		agentSkillContext,
		sessionModel,
		sessionProviderId,
		sessionEffort,
		sessionPermissionMode,
		sessionApprovalsReviewer,
		forkParentSessionId,
		forkKind,
		delegationParentSessionId,
		delegationParentLabel,
		delegationDepth,
		delegationControlOwned,
		agentList,
		vaultSkills,
		interactiveMode,
		providers,
		voiceInfo,
	};
}

export const Route = createFileRoute("/raven")({
	validateSearch: (
		search: Record<string, unknown>,
	): { session?: string; agent?: string; prompt?: string } => {
		const out: { session?: string; agent?: string; prompt?: string } = {};
		if (typeof search.session === "string") out.session = search.session;
		if (typeof search.agent === "string") out.agent = search.agent;
		if (typeof search.prompt === "string") out.prompt = search.prompt;
		return out;
	},
	loaderDeps: ({ search: { session, agent } }) => ({ session, agent }),
	loader: ({ deps: { session, agent } }) => loadRavenRoute(session, agent),
	// Replace the previous transcript as soon as a session navigation starts.
	// Otherwise its live stream remains visible (and scrollable) while the next
	// session's loader resolves, making the app look stuck on the old reply.
	pendingMs: 0,
	pendingComponent: RavenSessionPending,
	component: RavenRoutePage,
});

function RavenSessionPending() {
	return (
		<div
			className="grid min-h-full place-items-center p-6"
			data-testid="raven-session-pending"
		>
			<LoaderCircle className="w-5 h-5 text-muted-foreground/40 animate-spin" />
		</div>
	);
}

function RavenRoutePage() {
	const { existingSessionId, agentSkillContext } = Route.useLoaderData();
	return (
		<ChatPage
			key={`${existingSessionId ?? "new"}:${agentSkillContext ?? "vault"}`}
		/>
	);
}

type RavenNavigate = ReturnType<typeof useNavigate>;
type RavenAgentList = Awaited<ReturnType<typeof getAgentListFn>>;
type RavenProviders = Awaited<ReturnType<typeof getProvidersFn>>;
type ActiveRavenSkill = CommandDescriptor;
type RavenSessionSelection = {
	providerId?: string;
	model?: string;
	effort?: string;
	permissionMode?: string;
	approvalsReviewer?: ProviderApprovalsReviewer;
};

type RavenProviderIdentity = {
	activeProviderId: string;
	configuredProviderId: string;
};

type RavenProviderOwnership = RavenProviderIdentity & {
	sessionSelection: RavenSessionSelection;
};

function restoredRavenSessionSelection(
	existingSessionId: string | null,
	agentSkillContext: string | undefined,
	initialAgentSkillContext: string | undefined,
	initialSessionModel: string | null,
	initialSessionProviderId: string | null,
	initialSessionEffort: string | null,
	initialSessionPermissionMode: string | null,
	initialSessionApprovalsReviewer: string | null,
): RavenSessionSelection {
	if (!existingSessionId || agentSkillContext !== initialAgentSkillContext) {
		return {};
	}
	const approvalsReviewer: ProviderApprovalsReviewer | undefined =
		initialSessionApprovalsReviewer === "user" ||
		initialSessionApprovalsReviewer === "auto_review"
			? initialSessionApprovalsReviewer
			: undefined;
	return {
		// Empty is the durable provider-default sentinel. Preserve it separately
		// from NULL (no saved selection) so a reconnect cannot turn an explicit
		// provider default into today's configured Vault model.
		...(initialSessionModel !== null ? { model: initialSessionModel } : {}),
		...(initialSessionProviderId
			? { providerId: initialSessionProviderId }
			: {}),
		...(initialSessionEffort ? { effort: initialSessionEffort } : {}),
		...(initialSessionPermissionMode
			? { permissionMode: initialSessionPermissionMode }
			: {}),
		...(approvalsReviewer ? { approvalsReviewer } : {}),
	};
}

function liveRavenSessionSelection(
	status: RavenLiveSessions[number] | null | undefined,
): RavenSessionSelection | null {
	if (!status || status.mode === "terminal" || !status.provider_id) return null;
	return {
		providerId: status.provider_id,
		model: status.model,
		...(status.effort ? { effort: status.effort } : {}),
		...(status.permission_mode
			? { permissionMode: status.permission_mode }
			: {}),
		...(status.approvals_reviewer
			? { approvalsReviewer: status.approvals_reviewer }
			: {}),
	};
}

function useRavenSessionIdentity({
	config,
	agentList,
	existingSessionId,
	initialAgentSkillContext,
	routeSessionId,
	routeAgent,
	navigate,
}: {
	config: RavenConfig;
	agentList: RavenAgentList;
	existingSessionId: string | null;
	initialAgentSkillContext: string | undefined;
	routeSessionId: string | undefined;
	routeAgent: string | undefined;
	navigate: RavenNavigate;
}) {
	const configuredAgents = useMemo(
		() => [...agentList, ...(config.agents ?? [])],
		[agentList, config.agents],
	);
	const [agentSkillContext, setAgentSkillContext] = useState(() =>
		configuredRavenAgentPath(initialAgentSkillContext, configuredAgents),
	);
	const interactiveMode = interactiveModeForAgent(config, agentSkillContext);
	const agentContextSentRef = useRef(false);
	const sessionsStatus = useSyncExternalStore(
		subscribeSessionsStatus,
		getSessionsStatus,
		getSessionsStatus,
	);
	const [sessionId, setSessionId] = useState(
		() =>
			existingSessionId ??
			(interactiveModeForAgent(config, agentSkillContext) ? "" : uid()),
	);
	const sessionIdRef = useRef(sessionId);

	const activateNewSession = useCallback(
		(newId: string, clearAgent: boolean) => {
			rememberRavenSessionId(newId, clearAgent ? undefined : agentSkillContext);
			setSessionId(newId);
			sessionIdRef.current = newId;
			void navigate({
				to: "/raven",
				search: (previous) => ({
					...previous,
					session: newId,
					...(clearAgent ? { agent: undefined } : {}),
				}),
				replace: true,
			});
		},
		[agentSkillContext, navigate],
	);

	const handleNewTerminalSession = useCallback(() => {
		const newId = uid();
		activateNewSession(newId, false);
	}, [activateNewSession]);

	const selectAgent = useCallback(
		(agent: string | undefined) => {
			const configuredAgent = configuredRavenAgentPath(agent, configuredAgents);
			setAgentSkillContext(configuredAgent);
			agentContextSentRef.current = false;
			rememberRavenSessionId(sessionIdRef.current, configuredAgent);
		},
		[configuredAgents],
	);

	useEffect(() => {
		sessionIdRef.current = sessionId;
	}, [sessionId]);

	useEffect(() => {
		if (!sessionId) return;
		const storedAgent = configuredRavenAgentPath(
			initialAgentSkillContext === undefined && agentSkillContext === undefined
				? rememberedRavenAgent(sessionId)
				: undefined,
			configuredAgents,
		);
		if (storedAgent) {
			setAgentSkillContext(storedAgent);
			agentContextSentRef.current = false;
			return;
		}
		// Route navigation updates loader data before this hook's local session
		// state catches up. Do not overwrite the newly selected route with the
		// previous chat during that transition.
		if (existingSessionId && existingSessionId !== sessionId) return;
		rememberRavenSessionId(sessionId, agentSkillContext);
		if (routeSessionId === sessionId && routeAgent === agentSkillContext)
			return;
		void navigate({
			to: "/raven",
			search: (previous) => ({
				...previous,
				session: sessionId,
				agent: agentSkillContext,
			}),
			replace: true,
		});
	}, [
		agentSkillContext,
		existingSessionId,
		initialAgentSkillContext,
		configuredAgents,
		navigate,
		routeAgent,
		routeSessionId,
		sessionId,
	]);

	useEffect(() => {
		if (!sessionId || interactiveMode) return;
		const liveSession = sessionsStatus.find(
			(session) =>
				session.session_id === sessionId || session.db_session_id === sessionId,
		);
		wsStore.subscribeToSession(liveSession?.session_id ?? sessionId);
	}, [interactiveMode, sessionId, sessionsStatus]);

	useEffect(() => {
		if (!interactiveMode || existingSessionId || sessionId) return;
		const cwd = agentSkillContext ?? config.vault.path;
		const liveTerminal = sessionsStatus
			.slice()
			.reverse()
			.find(
				(session) =>
					session.mode === "terminal" &&
					session.state === "running" &&
					session.agent_cwd === cwd,
			);
		const nextId =
			liveTerminal?.db_session_id ?? liveTerminal?.session_id ?? uid();
		setSessionId(nextId);
		sessionIdRef.current = nextId;
	}, [
		interactiveMode,
		existingSessionId,
		sessionId,
		sessionsStatus,
		agentSkillContext,
		config.vault.path,
	]);

	useEffect(() => {
		if (existingSessionId) {
			setSessionId(existingSessionId);
			sessionIdRef.current = existingSessionId;
		}
		setAgentSkillContext(
			configuredRavenAgentPath(
				initialAgentSkillContext ??
					rememberedRavenAgent(existingSessionId ?? ""),
				configuredAgents,
			),
		);
		agentContextSentRef.current = false;
	}, [existingSessionId, configuredAgents, initialAgentSkillContext]);

	useEffect(() => {
		if (!interactiveMode || !sessionId) return;
		void ensureSessionFn({
			data: { id: sessionId, label: "Terminal session", model: "claude-cli" },
		});
	}, [interactiveMode, sessionId]);

	return {
		agentSkillContext,
		setAgentSkillContext,
		selectAgent,
		agentContextSentRef,
		sessionId,
		sessionIdRef,
		activateNewSession,
		handleNewTerminalSession,
		liveSessionStatus: sessionsStatus.find(
			(status) =>
				status.session_id === sessionId || status.db_session_id === sessionId,
		),
		interactiveMode,
	};
}

function useRavenChatRuntime({
	existingSessionId,
	isExplicitSession,
	sessionId,
	notificationSessionId,
	sessionIdRef,
	agentCwd,
	expectedProviderId,
	onSessionControlRejected,
}: {
	existingSessionId: string | null;
	isExplicitSession: boolean;
	sessionId: string;
	notificationSessionId: string | null;
	sessionIdRef: { current: string };
	agentCwd?: string;
	expectedProviderId?: string;
	onSessionControlRejected: (message: SessionControlRejectedMessage) => void;
}) {
	const [sdkSlashCommands, setSdkSlashCommands] = useState<
		Array<{
			name: string;
			description: string;
			argumentHint: string;
			aliases?: string[];
			action?: "review" | "computer-use" | "goal" | "compact";
		}>
	>([]);
	const [sdkSlashCommandProviderId, setSdkSlashCommandProviderId] = useState<
		string | null
	>(null);
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const [goal, setGoal] = useState<GoalState | null>(null);
	const [goalEditorOpen, setGoalEditorOpen] = useState(false);
	const [goalPending, setGoalPending] = useState(false);
	const [goalError, setGoalError] = useState<string | null>(null);
	const goalRequestIdRef = useRef<string | null>(null);
	const goalStartPendingRef = useRef(false);
	const [mcpSnapshot, setMcpSnapshot] = useState<{
		providerId: string | null;
		operations: McpControlOperation[];
		servers: ReturnType<typeof mapMcpServer>[];
	}>({
		providerId: null,
		operations: [],
		servers: [],
	});
	const [mcpPendingControl, setMcpPendingControl] = useState<{
		serverName: string;
		action: McpControlAction;
	} | null>(null);
	const [mcpControlError, setMcpControlError] = useState<string | null>(null);
	const [mcpControlNotice, setMcpControlNotice] = useState<string | null>(null);
	const mcpControlRequestIdRef = useRef<string | null>(null);
	const [fileRewindTurnId, setFileRewindTurnId] = useState<string | null>(null);
	const [fileRewindPending, setFileRewindPending] = useState<
		"preview" | "execute" | null
	>(null);
	const [fileRewindResult, setFileRewindResult] =
		useState<FileRewindResultMessage | null>(null);
	const fileRewindRequestIdRef = useRef<string | null>(null);
	const [mcpOpenSignal, setMcpOpenSignal] = useState(0);
	const [contextInspectorOpen, setContextInspectorOpen] = useState(false);
	const [contextInspectorTarget, setContextInspectorTarget] =
		useState<HlidContextReceiptTarget | null>(null);
	const [workflowManagerOpen, setWorkflowManagerOpen] = useState(false);
	const [workflowCatalog, setWorkflowCatalog] = useState<
		Pick<WorkflowCatalogMessage, "workflows" | "locations">
	>({
		workflows: [],
		locations: [],
	});
	const [workflowCatalogProviderId, setWorkflowCatalogProviderId] = useState<
		string | null
	>(null);
	const [workflowCatalogAgentCwd, setWorkflowCatalogAgentCwd] = useState<
		string | null
	>(null);
	const [workflowSaveResult, setWorkflowSaveResult] =
		useState<WorkflowSaveResultMessage | null>(null);
	const [workflowDeleteResult, setWorkflowDeleteResult] =
		useState<WorkflowDeleteResultMessage | null>(null);
	const [workflowSourceResult, setWorkflowSourceResult] =
		useState<WorkflowSourceResultMessage | null>(null);
	const [providerConfigOptions, setProviderConfigOptions] =
		useState<ProviderConfigOptionsMessage | null>(null);
	const [messages, dispatch] = useReducer(reducer, []);
	const pendingIdRef = useRef<string | null>(null);
	const lastAssistantIdRef = useRef<string | null>(null);
	const historyReadyRef = useRef(!existingSessionId);
	const handleWsMessage = useChatWsHandler({
		dispatch,
		pendingIdRef,
		lastAssistantIdRef,
		historyReadyRef,
		setRateLimit,
	});
	const handleGoalStateMessage = useCallback(
		function handleGoalStateMessage(message: GoalStateMessage) {
			if (expectedProviderId && !isCodexRuntimeProvider(expectedProviderId))
				return;
			if (
				canonicalSessionId(message.session_id) !==
				canonicalSessionId(sessionIdRef.current)
			)
				return;
			setGoal(message.goal);
			if (
				!goalStartPendingRef.current &&
				message.request_id !== goalRequestIdRef.current
			)
				return;
			goalStartPendingRef.current = false;
			goalRequestIdRef.current = null;
			setGoalPending(false);
			setGoalError(null);
		},
		[expectedProviderId, sessionIdRef],
	);
	const handleGoalErrorMessage = useCallback(
		function handleGoalErrorMessage(message: GoalErrorMessage) {
			if (
				canonicalSessionId(message.session_id) !==
					canonicalSessionId(sessionIdRef.current) ||
				message.request_id !== goalRequestIdRef.current
			)
				return;
			goalRequestIdRef.current = null;
			setGoalPending(false);
			setGoalError(message.message);
		},
		[sessionIdRef],
	);
	const handlePendingGoalRuntimeError = useCallback(
		function handlePendingGoalRuntimeError(message: ErrorMessage) {
			if (!goalStartPendingRef.current) return;
			goalStartPendingRef.current = false;
			setGoal(null);
			setGoalPending(false);
			setGoalError(message.message);
		},
		[],
	);
	const handleGoalMessage = useCallback(
		function handleGoalMessage(message: Parameters<typeof handleWsMessage>[0]) {
			if (message.type === "goal_state") {
				handleGoalStateMessage(message);
				return true;
			}
			if (message.type === "goal_error") {
				handleGoalErrorMessage(message);
				return true;
			}
			if (message.type === "error") {
				handlePendingGoalRuntimeError(message);
			}
			return false;
		},
		[
			handleGoalErrorMessage,
			handleGoalStateMessage,
			handlePendingGoalRuntimeError,
		],
	);
	const handleMcpStatusMessage = useCallback(
		function handleMcpStatusMessage(message: McpStatusMessage) {
			if ((message.agent_cwd ?? "") !== (agentCwd ?? "")) return;
			const messageProviderId =
				message.provider_id ?? message.servers[0]?.provider_id;
			if (
				expectedProviderId &&
				messageProviderId &&
				messageProviderId !== expectedProviderId
			)
				return;
			setMcpSnapshot({
				providerId: messageProviderId ?? expectedProviderId ?? null,
				operations: message.operations ?? [],
				servers: message.servers.map((server) =>
					mapMcpServer(
						{
							...server,
							providerId: server.provider_id ?? message.provider_id,
						},
						message.agent_cwd ? "agent" : "vault",
					),
				),
			});
		},
		[agentCwd, expectedProviderId],
	);
	const handleMcpControlResultMessage = useCallback(
		function handleMcpControlResultMessage(message: McpControlResultMessage) {
			if (
				canonicalSessionId(message.session_id) !==
					canonicalSessionId(sessionIdRef.current) ||
				message.request_id !== mcpControlRequestIdRef.current
			)
				return;
			mcpControlRequestIdRef.current = null;
			setMcpPendingControl(null);
			setMcpControlError(message.error ?? null);
			setMcpControlNotice(message.warning ?? null);
		},
		[sessionIdRef],
	);
	const handleFileRewindResultMessage = useCallback(
		function handleFileRewindResultMessage(message: FileRewindResultMessage) {
			if (
				canonicalSessionId(message.session_id) !==
					canonicalSessionId(sessionIdRef.current) ||
				message.request_id !== fileRewindRequestIdRef.current
			)
				return;
			fileRewindRequestIdRef.current = null;
			setFileRewindPending(null);
			setFileRewindResult(message);
		},
		[sessionIdRef],
	);
	const handleSlashCommandsMessage = useCallback(
		function handleSlashCommandsMessage(message: SlashCommandsMessage) {
			if ((message.agent_cwd ?? "") !== (agentCwd ?? "")) return;
			if (expectedProviderId && message.provider_id !== expectedProviderId)
				return;
			setSdkSlashCommands(message.commands);
			setSdkSlashCommandProviderId(message.provider_id);
		},
		[agentCwd, expectedProviderId],
	);
	const handleWorkflowCatalogMessage = useCallback(
		function handleWorkflowCatalogMessage(message: WorkflowCatalogMessage) {
			if ((message.agent_cwd ?? "") !== (agentCwd ?? "")) return;
			if (expectedProviderId && message.provider_id !== expectedProviderId)
				return;
			setWorkflowCatalog({
				workflows: message.workflows,
				locations: message.locations,
			});
			setWorkflowCatalogProviderId(message.provider_id);
			setWorkflowCatalogAgentCwd(message.agent_cwd ?? null);
		},
		[agentCwd, expectedProviderId],
	);
	const handleProviderConfigOptionsMessage = useCallback(
		function handleProviderConfigOptionsMessage(
			message: ProviderConfigOptionsMessage,
		) {
			if (
				canonicalSessionId(message.session_id) !==
				canonicalSessionId(sessionIdRef.current)
			)
				return;
			if ((message.agent_cwd ?? "") !== (agentCwd ?? "")) return;
			if (expectedProviderId && message.provider_id !== expectedProviderId)
				return;
			setProviderConfigOptions(message);
		},
		[agentCwd, expectedProviderId, sessionIdRef],
	);
	const handleRuntimeMetadataMessage = useCallback(
		function handleRuntimeMetadataMessage(
			message: Parameters<typeof handleWsMessage>[0],
		) {
			if (message.type === "mcp_status") {
				handleMcpStatusMessage(message);
				return true;
			}
			if (message.type === "slash_commands") {
				handleSlashCommandsMessage(message);
				return true;
			}
			if (message.type === "workflow_catalog") {
				handleWorkflowCatalogMessage(message);
				return true;
			}
			if (message.type === "provider_config_options") {
				handleProviderConfigOptionsMessage(message);
				return true;
			}
			return false;
		},
		[
			handleMcpStatusMessage,
			handleProviderConfigOptionsMessage,
			handleSlashCommandsMessage,
			handleWorkflowCatalogMessage,
		],
	);
	const handleWorkflowResultMessage = useCallback(
		function handleWorkflowResultMessage(
			message: Parameters<typeof handleWsMessage>[0],
		) {
			switch (message.type) {
				case "workflow_save_result":
					setWorkflowSaveResult(message);
					return true;
				case "workflow_delete_result":
					setWorkflowDeleteResult(message);
					return true;
				case "workflow_source_result":
					setWorkflowSourceResult(message);
					return true;
				default:
					return false;
			}
		},
		[],
	);
	const handleAllMessages = useCallback(
		function handleAllMessages(message: Parameters<typeof handleWsMessage>[0]) {
			if (handleGoalMessage(message)) return;
			if (message.type === "session_control_rejected") {
				onSessionControlRejected(message);
				return;
			}
			if (message.type === "file_rewind_result") {
				handleFileRewindResultMessage(message);
				return;
			}
			if (message.type === "mcp_control_result") {
				handleMcpControlResultMessage(message);
				return;
			}
			if (handleRuntimeMetadataMessage(message)) return;
			if (handleWorkflowResultMessage(message)) return;
			handleWsMessage(message);
		},
		[
			handleGoalMessage,
			handleFileRewindResultMessage,
			handleMcpControlResultMessage,
			handleRuntimeMetadataMessage,
			handleWorkflowResultMessage,
			handleWsMessage,
			onSessionControlRejected,
		],
	);
	const connection = useWs(handleAllMessages);
	useNotificationPresence(
		sessionId,
		notificationSessionId,
		connection.wsStatus,
		connection.send,
	);
	const controlGoal = useCallback(
		(
			control:
				| { action: "get" | "pause" | "resume" | "clear" }
				| {
						action: "set";
						objective: string;
						tokenBudget?: number | null;
				  },
		) => {
			const requestId = uid();
			goalRequestIdRef.current = requestId;
			setGoalPending(true);
			setGoalError(null);
			connection.send({
				type: "goal_control",
				request_id: requestId,
				session_id: sessionIdRef.current,
				action: control.action,
				...(control.action === "set"
					? {
							objective: control.objective,
							...(control.tokenBudget !== undefined
								? { token_budget: control.tokenBudget }
								: {}),
						}
					: {}),
				...(agentCwd ? { agent_cwd: agentCwd } : {}),
			});
		},
		[agentCwd, connection.send, sessionIdRef],
	);
	const openMcp = useCallback(() => {
		connection.send({
			type: "probe_mcp",
			session_id: sessionIdRef.current,
			...(agentCwd ? { agent_cwd: agentCwd } : {}),
		});
		setMcpOpenSignal((value) => value + 1);
	}, [agentCwd, connection.send, sessionIdRef]);
	const controlMcp = useCallback(
		(serverName: string, action: McpControlAction) => {
			const requestId = uid();
			mcpControlRequestIdRef.current = requestId;
			setMcpPendingControl({ serverName, action });
			setMcpControlError(null);
			setMcpControlNotice(null);
			const delivered = connection.send({
				type: "mcp_control",
				request_id: requestId,
				session_id: sessionIdRef.current,
				server_name: serverName,
				action,
			});
			if (delivered) return;
			mcpControlRequestIdRef.current = null;
			setMcpPendingControl(null);
			setMcpControlError("MCP control is unavailable while Raven is offline.");
		},
		[connection.send, sessionIdRef],
	);
	const previewFileRewind = useCallback(
		(turnId: string) => {
			const requestId = uid();
			fileRewindRequestIdRef.current = requestId;
			setFileRewindTurnId(turnId);
			setFileRewindPending("preview");
			setFileRewindResult(null);
			const delivered = connection.send({
				type: "file_rewind",
				request_id: requestId,
				session_id: sessionIdRef.current,
				turn_id: turnId,
				action: "preview",
			});
			if (delivered) return;
			fileRewindRequestIdRef.current = null;
			setFileRewindPending(null);
			setFileRewindResult({
				type: "file_rewind_result",
				request_id: requestId,
				session_id: sessionIdRef.current,
				turn_id: turnId,
				action: "preview",
				can_rewind: false,
				files_changed: [],
				insertions: 0,
				deletions: 0,
				error: "File rewind is unavailable while Raven is offline.",
			});
		},
		[connection.send, sessionIdRef],
	);
	const executeFileRewind = useCallback(() => {
		const turnId = fileRewindTurnId;
		const previewId = fileRewindResult?.preview_id;
		if (!turnId || !previewId || fileRewindPending !== null) return;
		const requestId = uid();
		fileRewindRequestIdRef.current = requestId;
		setFileRewindPending("execute");
		const delivered = connection.send({
			type: "file_rewind",
			request_id: requestId,
			session_id: sessionIdRef.current,
			turn_id: turnId,
			action: "execute",
			preview_id: previewId,
		});
		if (delivered) return;
		fileRewindRequestIdRef.current = null;
		setFileRewindPending(null);
		setFileRewindResult({
			type: "file_rewind_result",
			request_id: requestId,
			session_id: sessionIdRef.current,
			turn_id: turnId,
			action: "execute",
			can_rewind: false,
			files_changed: [],
			insertions: 0,
			deletions: 0,
			error: "File rewind is unavailable while Raven is offline.",
		});
	}, [
		connection.send,
		fileRewindPending,
		fileRewindResult?.preview_id,
		fileRewindTurnId,
		sessionIdRef,
	]);
	const closeFileRewind = useCallback(() => {
		if (fileRewindPending !== null) return;
		setFileRewindTurnId(null);
		setFileRewindResult(null);
	}, [fileRewindPending]);
	const openContext = useCallback((target?: HlidContextReceiptTarget) => {
		setContextInspectorTarget(target ?? null);
		setContextInspectorOpen(true);
	}, []);
	const closeContext = useCallback(() => {
		setContextInspectorOpen(false);
		setContextInspectorTarget(null);
	}, []);
	const refreshWorkflows = useCallback(() => {
		connection.send({
			type: "probe_workflows",
			session_id: sessionIdRef.current,
			...(agentCwd ? { agent_cwd: agentCwd } : {}),
		});
	}, [agentCwd, connection.send, sessionIdRef]);
	const openWorkflows = useCallback(() => {
		setWorkflowSaveResult(null);
		setWorkflowDeleteResult(null);
		setWorkflowSourceResult(null);
		refreshWorkflows();
		setWorkflowManagerOpen(true);
	}, [refreshWorkflows]);
	const closeWorkflows = useCallback(() => setWorkflowManagerOpen(false), []);

	const historyPagination = useLoadChatHistory({
		existingSessionId,
		isExplicitSession,
		dispatch,
		pendingIdRef,
		historyReadyRef,
		handleWsMessage: handleAllMessages,
		wsStatus: connection.wsStatus,
		sessionIdRef,
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: Raven context changes invalidate provider-scoped runtime snapshots
	useEffect(() => {
		setSdkSlashCommands([]);
		setSdkSlashCommandProviderId(null);
		setMcpSnapshot({ providerId: null, operations: [], servers: [] });
		setMcpPendingControl(null);
		setMcpControlError(null);
		setMcpControlNotice(null);
		mcpControlRequestIdRef.current = null;
		setFileRewindTurnId(null);
		setFileRewindPending(null);
		setFileRewindResult(null);
		fileRewindRequestIdRef.current = null;
		setContextInspectorOpen(false);
		setContextInspectorTarget(null);
		setWorkflowManagerOpen(false);
		setWorkflowCatalog({ workflows: [], locations: [] });
		setWorkflowCatalogProviderId(null);
		setProviderConfigOptions(null);
		setWorkflowSaveResult(null);
		setWorkflowDeleteResult(null);
		setGoal(null);
		setGoalEditorOpen(false);
		setGoalPending(false);
		setGoalError(null);
		goalRequestIdRef.current = null;
		goalStartPendingRef.current = false;
	}, [agentCwd, existingSessionId, expectedProviderId]);

	useEffect(() => {
		if (connection.wsStatus !== "connected") return;
		connection.send({
			type: "probe_provider_config",
			session_id: sessionIdRef.current,
			...(agentCwd ? { agent_cwd: agentCwd } : {}),
		});
		connection.send({
			type: "probe_mcp",
			session_id: sessionIdRef.current,
			...(agentCwd ? { agent_cwd: agentCwd } : {}),
		});
		connection.send({
			type: "probe_slash_commands",
			session_id: sessionIdRef.current,
			...(agentCwd ? { agent_cwd: agentCwd } : {}),
		});
		connection.send({
			type: "probe_workflows",
			session_id: sessionIdRef.current,
			...(agentCwd ? { agent_cwd: agentCwd } : {}),
		});
		if (expectedProviderId && isCodexRuntimeProvider(expectedProviderId)) {
			controlGoal({ action: "get" });
		}
	}, [
		connection.send,
		connection.wsStatus,
		agentCwd,
		expectedProviderId,
		sessionIdRef,
		controlGoal,
	]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: session navigation is the reset trigger
	useEffect(() => {
		setRateLimit(null);
	}, [existingSessionId]);

	const isRunning = connection.sessionState === "running";
	useEffect(() => {
		if (!isRunning || !historyReadyRef.current || pendingIdRef.current) return;
		const newId = uid();
		pendingIdRef.current = newId;
		dispatch({ type: "ADD_ASSISTANT", id: newId });
	}, [isRunning]);

	return {
		...connection,
		...historyPagination,
		isRunning,
		sdkSlashCommands,
		sdkSlashCommandProviderId,
		workflowCatalog,
		workflowCatalogProviderId,
		workflowCatalogAgentCwd,
		workflowSaveResult,
		setWorkflowSaveResult,
		workflowDeleteResult,
		setWorkflowDeleteResult,
		workflowSourceResult,
		setWorkflowSourceResult,
		providerConfigOptions,
		refreshWorkflows,
		mcpServers:
			!expectedProviderId || mcpSnapshot.providerId === expectedProviderId
				? mcpSnapshot.servers
				: [],
		mcpOperations:
			!expectedProviderId || mcpSnapshot.providerId === expectedProviderId
				? mcpSnapshot.operations
				: [],
		mcpPendingControl,
		mcpControlError,
		mcpControlNotice,
		controlMcp,
		fileRewindTurnId,
		fileRewindPending,
		fileRewindResult,
		previewFileRewind,
		executeFileRewind,
		closeFileRewind,
		mcpOpenSignal,
		openMcp,
		contextInspectorOpen,
		contextInspectorTarget,
		openContext,
		closeContext,
		workflowManagerOpen,
		openWorkflows,
		closeWorkflows,
		rateLimit,
		setRateLimit,
		goal,
		goalEditorOpen,
		goalPending,
		goalError,
		stageGoalStart: (objective: string, tokenBudget?: number | null) => {
			const now = Math.floor(Date.now() / 1000);
			goalStartPendingRef.current = true;
			setGoalPending(true);
			setGoalError(null);
			setGoal({
				thread_id: "",
				objective,
				status: "active",
				token_budget: tokenBudget ?? null,
				tokens_used: 0,
				time_used_seconds: 0,
				created_at: now,
				updated_at: now,
			});
		},
		controlGoal,
		openGoalEditor: () => setGoalEditorOpen(true),
		closeGoalEditor: () => setGoalEditorOpen(false),
		dismissGoalError: () => setGoalError(null),
		messages,
		dispatch,
		pendingIdRef,
		lastAssistantIdRef,
	};
}

function useRavenViewport({
	input,
	messages,
	sessionId,
	activeSkills,
	showModelPopup,
	setShowModelPopup,
}: {
	input: string;
	messages: unknown[];
	sessionId: string;
	activeSkills: unknown;
	showModelPopup: boolean;
	setShowModelPopup: Dispatch<SetStateAction<boolean>>;
}) {
	const bottomRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const transcriptContentRef = useRef<HTMLDivElement>(null);
	const atBottomRef = useRef(true);
	const wheelAwayRef = useRef(false);
	const pointerScrollingRef = useRef(false);
	const lastScrollTopRef = useRef(0);
	const touchActiveRef = useRef(false);
	const touchStartYRef = useRef(0);
	const touchAwayRef = useRef(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const modelBadgeRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const pendingSkillFocusRef = useRef(false);
	const scrollSessionRef = useRef(sessionId);
	const needsInitialBottomRef = useRef(true);
	const streamingScrollSchedulerRef = useRef<ReturnType<
		typeof createAnimationFrameCoalescer
	> | null>(null);
	streamingScrollSchedulerRef.current ??= createAnimationFrameCoalescer();
	if (scrollSessionRef.current !== sessionId) {
		scrollSessionRef.current = sessionId;
		needsInitialBottomRef.current = true;
		atBottomRef.current = true;
		wheelAwayRef.current = false;
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: activeSkill triggers deferred focus
	useEffect(() => {
		if (!pendingSkillFocusRef.current) return;
		pendingSkillFocusRef.current = false;
		textareaRef.current?.focus();
	}, [activeSkills]);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		const isCoarsePointer =
			typeof window.matchMedia === "function" &&
			window.matchMedia("(pointer: coarse)").matches;
		const onScroll = () => {
			const nextScrollTop = element.scrollTop;
			const movedTowardOlder = nextScrollTop < lastScrollTopRef.current - 1;
			lastScrollTopRef.current = nextScrollTop;
			if (touchActiveRef.current && touchAwayRef.current) return;
			if (pointerScrollingRef.current && movedTowardOlder) {
				atBottomRef.current = false;
				return;
			}
			if (wheelAwayRef.current) {
				const distance =
					element.scrollHeight - element.scrollTop - element.clientHeight;
				if (distance > 1) return;
				wheelAwayRef.current = false;
			}
			// Content growth can emit scroll events without user intent. Do not drop
			// bottom-follow just because a tool card expanded past the proximity zone;
			// explicit wheel/touch/scrollbar movement owns detaching instead.
			if (isNearChatBottom(element, isCoarsePointer)) {
				atBottomRef.current = true;
			}
		};
		const onTouchStart = (event: TouchEvent) => {
			touchActiveRef.current = true;
			touchAwayRef.current = false;
			touchStartYRef.current = event.touches[0]?.clientY ?? 0;
		};
		const onTouchMove = (event: TouchEvent) => {
			const currentY = event.touches[0]?.clientY;
			if (
				currentY !== undefined &&
				touchMovesTowardOlderMessages(touchStartYRef.current, currentY)
			) {
				touchAwayRef.current = true;
				atBottomRef.current = false;
			}
		};
		const onTouchEnd = () => {
			touchActiveRef.current = false;
			if (!touchAwayRef.current)
				atBottomRef.current = isNearChatBottom(element, isCoarsePointer);
		};
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY < 0) {
				wheelAwayRef.current = true;
				atBottomRef.current = false;
			} else if (
				event.deltaY > 0 &&
				isNearChatBottom(element, isCoarsePointer)
			) {
				wheelAwayRef.current = false;
				atBottomRef.current = true;
			}
		};
		const onPointerDown = () => {
			pointerScrollingRef.current = true;
			lastScrollTopRef.current = element.scrollTop;
		};
		const onPointerUp = () => {
			pointerScrollingRef.current = false;
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		element.addEventListener("touchstart", onTouchStart, { passive: true });
		element.addEventListener("touchmove", onTouchMove, { passive: true });
		element.addEventListener("touchend", onTouchEnd, { passive: true });
		element.addEventListener("touchcancel", onTouchEnd, { passive: true });
		element.addEventListener("wheel", onWheel, { passive: true });
		element.addEventListener("pointerdown", onPointerDown, { passive: true });
		window.addEventListener("pointerup", onPointerUp, { passive: true });
		window.addEventListener("pointercancel", onPointerUp, { passive: true });
		return () => {
			element.removeEventListener("scroll", onScroll);
			element.removeEventListener("touchstart", onTouchStart);
			element.removeEventListener("touchmove", onTouchMove);
			element.removeEventListener("touchend", onTouchEnd);
			element.removeEventListener("touchcancel", onTouchEnd);
			element.removeEventListener("wheel", onWheel);
			element.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerUp);
		};
	}, []);

	// Tool rows can grow after the message update that created them (results,
	// subagent progress, async markdown). Observe the committed transcript size
	// so a reader who is following the turn stays pinned through those changes.
	useEffect(() => {
		const content = transcriptContentRef.current;
		if (!content || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (!atBottomRef.current) return;
			streamingScrollSchedulerRef.current?.request(() => {
				if (atBottomRef.current) scrollChatToBottom(scrollRef.current, "auto");
			});
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, []);

	// Put restored/new chats at the bottom before their first paint. This avoids
	// replaying a visible smooth scroll through the entire mounted transcript.
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages is the DOM commit trigger
	useLayoutEffect(() => {
		if (!needsInitialBottomRef.current || messages.length === 0) return;
		scrollChatToBottom(scrollRef.current, "auto");
		needsInitialBottomRef.current = false;
	}, [messages, sessionId]);

	// Streaming should stay pinned when the reader is already at the bottom, but
	// multiple chunks in one frame should pay for only one layout/scroll update.
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages is the scroll trigger
	useEffect(() => {
		if (needsInitialBottomRef.current || !atBottomRef.current) {
			return;
		}
		streamingScrollSchedulerRef.current?.request(() => {
			if (atBottomRef.current) scrollChatToBottom(scrollRef.current, "auto");
		});
	}, [messages]);

	useEffect(
		() => () => {
			streamingScrollSchedulerRef.current?.cancel();
		},
		[],
	);

	const resizeTextarea = useCallback(() => {
		const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
		resizeComposer(
			textareaRef.current,
			responsiveComposerMaxHeight(window.innerWidth, visibleHeight),
		);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: input length triggers resize
	useEffect(() => {
		resizeTextarea();
	}, [input, resizeTextarea]);

	useEffect(() => {
		const visualViewport = window.visualViewport;
		let frame = 0;
		const onViewportChange = () => {
			if (visualViewport && visualViewport.scale > 1.01) return;
			resizeTextarea();
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				// Keyboard reveal can scroll overflow-hidden Raven ancestors. Clamp
				// those boxes without disturbing the transcript's own position.
				resetScrollAncestors(scrollRef.current);
				if (atBottomRef.current) scrollChatToBottom(scrollRef.current, "auto");
			});
		};
		onViewportChange();
		window.addEventListener("resize", onViewportChange);
		visualViewport?.addEventListener("resize", onViewportChange);
		visualViewport?.addEventListener("scroll", onViewportChange);
		return () => {
			window.removeEventListener("resize", onViewportChange);
			visualViewport?.removeEventListener("resize", onViewportChange);
			visualViewport?.removeEventListener("scroll", onViewportChange);
			cancelAnimationFrame(frame);
		};
	}, [resizeTextarea]);

	useEffect(() => {
		if (!showModelPopup) return;
		const handleOutsideInteraction = (event: Event) => {
			if (!modelBadgeRef.current?.contains(event.target as Node))
				setShowModelPopup(false);
		};
		document.addEventListener("click", handleOutsideInteraction);
		document.addEventListener("focusin", handleOutsideInteraction);
		return () => {
			document.removeEventListener("click", handleOutsideInteraction);
			document.removeEventListener("focusin", handleOutsideInteraction);
		};
	}, [showModelPopup, setShowModelPopup]);

	return {
		bottomRef,
		scrollRef,
		transcriptContentRef,
		atBottomRef,
		textareaRef,
		modelBadgeRef,
		fileInputRef,
		focusSkillOnNextRender: () => {
			pendingSkillFocusRef.current = true;
		},
	};
}

// ─── Page ─────────────────────────────────────────────────────────────────────
type RavenActionProps = {
	config: RavenConfig;
	initialVoiceInfo: Awaited<ReturnType<typeof getVoiceInfoFn>>;
	activeProviderId: string;
	input: string;
	setInput: ReturnType<typeof useDraft>["setInput"];
	clearDraft: ReturnType<typeof useDraft>["clearDraft"];
	activeSkills: ActiveRavenSkill[];
	setActiveSkills: Dispatch<SetStateAction<ActiveRavenSkill[]>>;
	commands: CommandDescriptor[];
	planMode: boolean;
	setPlanMode: Dispatch<SetStateAction<boolean>>;
	planHtml: boolean;
	sessionSelection: RavenSessionSelection;
	setSessionSelection: Dispatch<SetStateAction<RavenSessionSelection>>;
	resetSessionSelection: () => void;
	session: ReturnType<typeof useRavenSessionIdentity>;
	runtime: ReturnType<typeof useRavenChatRuntime>;
	upload: ReturnType<typeof useFileUpload>;
	vaultPicker: ReturnType<typeof useVaultReferencePicker>;
	viewport: ReturnType<typeof useRavenViewport>;
	chatQueue: ReturnType<typeof useWsChatQueue>;
	providers: RavenProviders;
};

/** Permission / question / plan-proposal card decisions. */
function useRavenDecisionActions({ runtime, setPlanMode }: RavenActionProps) {
	const { send, dispatch } = runtime;

	const handleDecide = useCallback(
		(
			id: string,
			approved: boolean,
			saveScope?: "session" | "local",
			denyMessage?: string,
		) => {
			const decision = decisionFromScope(approved, saveScope);
			dispatch({ type: "RESOLVE_PERMISSION", id, decision });
			send({
				type: "permission_response",
				id,
				approved,
				saveScope,
				denyMessage,
			});
		},
		[send, dispatch],
	);

	const handleSubmitAnswers = useCallback(
		(
			id: string,
			answers: Record<string, string[]>,
			notes?: Record<string, string>,
		) => {
			dispatch({ type: "RESOLVE_ASK_USER_QUESTION", id, answers, notes });
			send({ type: "ask_user_question_response", id, answers, notes });
		},
		[send, dispatch],
	);

	const handlePlanDecide = useCallback(
		(
			id: string,
			decision: "approved" | "edited" | "cancelled",
			feedback?: string,
		) => {
			dispatch({ type: "RESOLVE_PLAN_PROPOSAL", id, decision });
			if (decision !== "edited") setPlanMode(false);
			if (decision === "edited") {
				send({
					type: "plan_mode_exit_response",
					id,
					decision: "edited",
					feedback: feedback ?? "",
				});
			} else {
				send({ type: "plan_mode_exit_response", id, decision });
			}
		},
		[send, dispatch, setPlanMode],
	);

	return { handleDecide, handleSubmitAnswers, handlePlanDecide };
}

function useRavenSend(props: RavenActionProps) {
	const navigate = useNavigate();
	const {
		input,
		setInput,
		clearDraft,
		activeSkills,
		setActiveSkills,
		commands,
		planMode,
		planHtml,
		sessionSelection,
		activeProviderId,
	} = props;
	const { agentSkillContext, agentContextSentRef, sessionId } = props.session;
	const {
		sessionState,
		send,
		dispatch,
		controlGoal,
		openGoalEditor,
		closeGoalEditor,
		openMcp,
		openContext,
		openWorkflows,
	} = props.runtime;
	const { pendingAttachments, clearPending: clearPendingAttachments } =
		props.upload;
	const {
		referencePaths,
		relicAttachments,
		selectedWorkspace,
		clear: clearVaultReferences,
	} = props.vaultPicker;
	const { atBottomRef } = props.viewport;

	return useCallback(
		(
			overrideText?: string,
			explicitGoal?: { objective: string; tokenBudget?: number | null },
			voiceAttachments?: ChatAttachment[],
		) => {
			const typed = (overrideText ?? input).trim();
			const voiceTurn = voiceAttachments !== undefined;

			const resolved = resolveCommandSubmission(
				voiceTurn ? [] : activeSkills,
				typed,
				commands,
			);
			let { text } = resolved;
			const { skillContexts, commandAction } = resolved;
			let goalStart = explicitGoal;
			if (commandAction === "goal") {
				if (!goalStart) {
					const intent = parseGoalCommand(text);
					if (intent.action === "edit") openGoalEditor();
					else if (intent.action === "set") goalStart = intent;
					else {
						controlGoal(intent);
						closeGoalEditor();
					}
					if (intent.action !== "set") {
						clearDraft();
						setInput("");
						setActiveSkills([]);
						return;
					}
				}
				if (!goalStart) return;
				text = goalStart.objective;
				closeGoalEditor();
			}
			if (commandAction === "mcp") {
				openMcp();
				clearDraft();
				setInput("");
				setActiveSkills([]);
				return;
			}
			if (commandAction === "context") {
				openContext();
				clearDraft();
				setInput("");
				setActiveSkills([]);
				return;
			}
			if (commandAction === "workflows") {
				openWorkflows();
				clearDraft();
				setInput("");
				setActiveSkills([]);
				return;
			}
			if (commandAction === "rename") {
				const label = parseRenameCommand(text);
				clearDraft();
				setInput("");
				setActiveSkills([]);
				if (!label) {
					dispatch({
						type: "ADD_LOCAL_COMMAND_OUTPUT",
						id: uid(),
						content: "Usage: /rename <name>",
					});
					return;
				}
				void renameSessionFn({ data: { id: sessionId, label } }).then(
					() =>
						dispatch({
							type: "ADD_LOCAL_COMMAND_OUTPUT",
							id: uid(),
							content: `Session renamed to “${label}”.`,
						}),
					(error) =>
						dispatch({
							type: "ADD_LOCAL_COMMAND_OUTPUT",
							id: uid(),
							content:
								error instanceof Error
									? `Rename failed: ${error.message}`
									: "Rename failed.",
						}),
				);
				return;
			}
			if (commandAction === "archive") {
				clearDraft();
				setInput("");
				setActiveSkills([]);
				void setSessionArchivedFn({
					data: { id: sessionId, archived: true },
				}).then(
					() =>
						navigate({
							to: "/ledger",
							search: {
								tab: "sessions",
								page: 1,
								size: 20,
								archived: true,
							},
						}),
					(error) =>
						dispatch({
							type: "ADD_LOCAL_COMMAND_OUTPUT",
							id: uid(),
							content:
								error instanceof Error
									? `Archive failed: ${error.message}`
									: "Archive failed.",
						}),
				);
				return;
			}
			const id = uid();
			const submission = prepareChatSubmission({
				id,
				text,
				sessionId,
				running: sessionState === "running",
				skillContexts,
				commandAction: commandAction === "goal" ? undefined : commandAction,
				attachments: voiceTurn
					? voiceAttachments
					: [...pendingAttachments, ...relicAttachments],
				vaultReferences: voiceTurn ? [] : referencePaths,
				workspaceReferences: voiceTurn ? [] : selectedWorkspace,
				agentCwd: agentSkillContext ?? undefined,
				agentContextAlreadySent: agentContextSentRef.current,
				planMode,
				planHtml,
				provider: activeProviderId,
				model: sessionSelection.model,
				effort: sessionSelection.effort,
				permissionMode: sessionSelection.permissionMode,
				approvalsReviewer: sessionSelection.approvalsReviewer,
				goal: goalStart
					? {
							objective: goalStart.objective,
							...(goalStart.tokenBudget !== undefined
								? { token_budget: goalStart.tokenBudget }
								: {}),
						}
					: undefined,
			});
			if (!submission) return;

			if (submission.kind === "queued") {
				wsStore.enqueueChat(submission.message);
			} else {
				atBottomRef.current = true;
				dispatch({ type: "ADD_USER", ...submission.user });
				if (submission.marksAgentContextSent)
					agentContextSentRef.current = true;
				send(submission.message);
			}
			if (!voiceTurn) {
				clearDraft();
				setInput("");
				setActiveSkills([]);
				clearPendingAttachments();
				clearVaultReferences();
			}
		},
		[
			input,
			setInput,
			activeSkills,
			commands,
			sessionState,
			send,
			sessionId,
			pendingAttachments,
			relicAttachments,
			referencePaths,
			selectedWorkspace,
			agentSkillContext,
			clearDraft,
			clearPendingAttachments,
			clearVaultReferences,
			planMode,
			planHtml,
			sessionSelection,
			activeProviderId,
			dispatch,
			atBottomRef,
			agentContextSentRef,
			setActiveSkills,
			controlGoal,
			openGoalEditor,
			closeGoalEditor,
			openMcp,
			openContext,
			openWorkflows,
			navigate,
		],
	);
}

function useRavenVoice(
	props: RavenActionProps,
	handleSend: (
		overrideText?: string,
		goal?: { objective: string; tokenBudget?: number | null },
		voiceAttachments?: ChatAttachment[],
	) => void,
) {
	const { config, initialVoiceInfo, input, setInput, providers } = props;
	const { textareaRef } = props.viewport;
	const onTranscription = useCallback(
		(text: string) => {
			if (!text) return;
			if (config.voice.auto_send) {
				handleSend(text);
				return;
			}
			const el = textareaRef.current;
			const start = el?.selectionStart ?? input.length;
			const end = el?.selectionEnd ?? input.length;
			setInput(insertAtSelection(input, text, start, end));
			requestAnimationFrame(() => textareaRef.current?.focus());
		},
		[config.voice.auto_send, handleSend, input, setInput, textareaRef],
	);
	const providerId = props.activeProviderId;
	const codexProvider = providers.find((provider) => provider.id === "codex");
	const selectedAgent = (config.agents ?? []).find(
		(agent) => agent.path === props.session.agentSkillContext,
	);
	const activeModel =
		props.sessionSelection.model ??
		props.session.liveSessionStatus?.model ??
		selectedAgent?.model ??
		config.codex?.model;
	const codexAudio =
		providerId === "codex"
			? modelInputAvailability(codexProvider, activeModel, "audio")
			: {
					available: false,
					reason: "Talk to Codex requires the native Codex provider.",
				};
	const onAudioTurn = useCallback(
		async (audio: Blob) => {
			if (providerId !== "codex") {
				throw new Error("Talk to Codex requires the native Codex provider");
			}
			const sessionId = props.session.sessionIdRef.current;
			if (!sessionId) throw new Error("No Raven session is available");
			const attachment = await uploadVoiceRecording(audio, {
				sessionId,
				agentCwd: props.session.agentSkillContext,
			});
			handleSend("Voice message", undefined, [attachment]);
		},
		[
			handleSend,
			props.session.agentSkillContext,
			props.session.sessionIdRef,
			providerId,
		],
	);
	const discardLivePartials = useCallback(
		() => props.runtime.dispatch({ type: "DISCARD_REALTIME_PARTIALS" }),
		[props.runtime.dispatch],
	);
	const realtime = useCodexRealtime({
		sessionId: props.session.sessionIdRef.current,
		agentCwd: props.session.agentSkillContext,
		providerId,
		voice: config.voice.codex_voice,
		onDictation: onTranscription,
		onLiveClosed: discardLivePartials,
	});
	const configuredDictation =
		providerId === "codex"
			? codexRealtimeAvailability(
					config.voice.codex_live_mode,
					codexProvider,
					initialVoiceInfo.codexRealtimeBackend,
				)
			: {
					available: false,
					reason: "Dictate with Codex requires the native Codex provider.",
				};
	const realtimeDictationActive = realtime.mode === "dictation";
	const voice = useVoiceInput({
		config: config.voice,
		initialInfo: initialVoiceInfo,
		onTranscription,
		onAudioTurn,
		codexTurnAvailable: providerId === "codex" && codexAudio.available,
		codexTurnUnavailableReason: codexAudio.reason,
		codexDictation: {
			available: configuredDictation.available && !realtime.unavailableReason,
			unavailableReason:
				realtime.unavailableReason ??
				(configuredDictation.available
					? undefined
					: configuredDictation.reason),
			phase: realtimeDictationActive ? realtime.phase : "idle",
			error: realtimeDictationActive ? realtime.error : null,
			start: () => realtime.start("dictation"),
			stop: realtime.stop,
			cancel: realtime.cancel,
			clearError: realtime.clearError,
		},
	});
	return {
		...voice,
		error:
			realtime.phase === "error" && realtime.mode === "live"
				? realtime.error
				: voice.error,
		errorLabel:
			realtime.mode === "live"
				? "Raven Live failed"
				: config.voice.input_provider === "codex"
					? "voice message failed"
					: config.voice.input_provider === "codex_dictation"
						? "Codex dictation failed"
						: "voice transcription failed",
		clearError: () => {
			voice.clearError();
			if (realtime.mode === "live") realtime.clearError();
		},
		livePhase: realtime.mode === "live" ? realtime.phase : "idle",
		liveUnavailable: realtime.unavailableReason,
		liveMicrophoneMuted: realtime.liveMicrophoneMuted,
		startLive: () => realtime.start("live"),
		stopLive: realtime.stop,
		toggleLiveMicrophone: realtime.toggleLiveMicrophone,
	};
}

function isRavenLiveInteractionLocked(phase: RavenVoice["livePhase"]): boolean {
	return phase === "starting" || phase === "connected" || phase === "stopping";
}

function useRavenQueueActions(props: RavenActionProps) {
	const { input, setInput, chatQueue } = props;
	const { dispatch } = props.runtime;
	const { pendingAttachments, setPendingAttachments } = props.upload;
	const inputRef = useRef(input);
	const pendingAttachmentsRef = useRef(pendingAttachments);
	inputRef.current = input;
	pendingAttachmentsRef.current = pendingAttachments;

	const handleCancelQueued = useCallback(
		(id: string) => {
			const item = wsStore.removeFromQueue(id);
			if (!item) return;
			// Slice C fix: cancelled msgs were never persisted server-side, so
			// remove them from the local transcript too. Otherwise they appear
			// in the chat until refresh (which clears them by reloading from
			// DB) — confusing because they look "sent."
			dispatch({ type: "REMOVE_USER", id });
			// Restore to input only if the input box is empty
			if (
				!inputRef.current.trim() &&
				pendingAttachmentsRef.current.length === 0
			) {
				setInput(item.text);
				if (item.attachments && item.attachments.length > 0) {
					setPendingAttachments(item.attachments);
				}
			}
		},
		[setInput, setPendingAttachments, dispatch],
	);

	const handlePromoteQueued = useCallback(
		(id: string) => {
			// Slice C: server interrupts current turn + reorders queue so this
			// msg runs next. Also reorder the local transcript so the
			// promoted user msg appears in its new processing position —
			// matches what DB/refresh will show.
			wsStore.promoteQueued(id);
			dispatch({
				type: "PROMOTE_USER",
				turnId: id,
				pendingTurnIds: chatQueue.map((q) => q.id),
			});
		},
		[chatQueue, dispatch],
	);

	const handleSteerQueued = useCallback((id: string) => {
		wsStore.steerQueued(id);
	}, []);

	return { handleCancelQueued, handlePromoteQueued, handleSteerQueued };
}

function useRavenClear(props: RavenActionProps) {
	const { clearDraft, setPlanMode, resetSessionSelection } = props;
	const clearVaultReferences = props.vaultPicker.clear;
	const { setAgentSkillContext, agentContextSentRef, activateNewSession } =
		props.session;
	const { send, dispatch, pendingIdRef, lastAssistantIdRef } = props.runtime;

	return useCallback(() => {
		setPlanMode(false);
		clearDraft();
		pendingIdRef.current = null;
		// Reset the recap target ref too — it points at a message we're about
		// to wipe via dispatch CLEAR, and a late tool_use_summary would
		// otherwise dispatch SET_RECAP at a non-existent ID.
		lastAssistantIdRef.current = null;
		agentContextSentRef.current = false;
		dispatch({ type: "CLEAR" });
		send({ type: "clear" });
		resetLiveStats();
		wsStore.seedActualModel(null);
		wsStore.clearMessageBuffer();
		clearChatQueue();
		clearVaultReferences();
		resetSessionSelection();
		const newId = uid();
		setAgentSkillContext(undefined);
		activateNewSession(newId, true);
	}, [
		send,
		clearDraft,
		pendingIdRef,
		lastAssistantIdRef,
		agentContextSentRef,
		dispatch,
		activateNewSession,
		setAgentSkillContext,
		setPlanMode,
		resetSessionSelection,
		clearVaultReferences,
	]);
}

function useRavenActions(props: RavenActionProps) {
	const decisions = useRavenDecisionActions(props);
	const handleSend = useRavenSend(props);
	const voice = useRavenVoice(props, handleSend);
	const queue = useRavenQueueActions(props);
	const handleClear = useRavenClear(props);

	return {
		voice,
		...decisions,
		handleSend,
		...queue,
		handleClear,
	};
}

function configuredVaultSelection(
	config: RavenConfig,
	providerId: string,
): Omit<RavenSessionSelection, "providerId"> {
	if (providerId.startsWith("acp:")) {
		const configured = config.acp_agents?.find(
			(agent) => agent.id === providerId.slice("acp:".length),
		);
		return {
			model: configured?.model,
			effort: configured?.effort,
			permissionMode: configured?.permission_mode,
		};
	}
	if (providerId === "codex") {
		return {
			model: config.codex?.model,
			effort: config.codex?.effort,
			permissionMode: config.codex?.permission_mode,
		};
	}
	if (isCliProxyProvider(providerId)) {
		return {
			model: config.cliproxy?.model,
			effort: config.cliproxy?.effort,
			permissionMode: config.cliproxy?.permission_mode,
		};
	}
	if (providerId === "claude") {
		return {
			model: config.claude?.model,
			effort: config.claude?.effort,
			permissionMode: config.claude?.permission_mode,
		};
	}
	return {};
}

function defaultSelectionForProvider(
	provider: RavenProviders[number],
	configured: RavenSessionSelection,
	config: RavenConfig,
): RavenSessionSelection {
	const useConfigured = configured.providerId === provider.id;
	const models = modelOptions(provider);
	const configuredModel = useConfigured ? configured.model : undefined;
	const model =
		models.find((candidate) => candidate.value === configuredModel)?.value ??
		(provider.id.startsWith("acp:") && models.length === 0
			? configuredModel
			: undefined) ??
		models.find((candidate) => candidate.isDefault)?.value ??
		models[0]?.value;
	const efforts = effortOptionsFor(provider, model ?? "");
	const configuredEffort = useConfigured ? configured.effort : undefined;
	const effort =
		efforts.find((candidate) => candidate.value === configuredEffort)?.value ??
		(provider.id.startsWith("acp:") && efforts.length === 0
			? configuredEffort
			: undefined) ??
		efforts.find((candidate) => candidate.isDefault)?.value ??
		efforts.find((candidate) => candidate.value === "medium")?.value ??
		efforts[0]?.value;
	const permissions = sessionPermissionOptionsFor(provider, {
		model,
		policyEnforced: config.umbod?.enabled === true,
		usageGateEnforced: config.auto_sleep?.enabled === true,
	});
	const configuredPermission = useConfigured
		? configured.permissionMode
		: undefined;
	const permissionMode =
		permissions.find((candidate) => candidate.value === configuredPermission)
			?.value ??
		permissions.find((candidate) => candidate.value === "default")?.value ??
		permissions[0]?.value;
	const reviewers = provider.approvalReviewers ?? [];
	const configuredReviewer = useConfigured
		? configured.approvalsReviewer
		: undefined;
	const approvalsReviewer =
		reviewers.find((candidate) => candidate.value === configuredReviewer)
			?.value ??
		reviewers.find((candidate) => candidate.isDefault)?.value ??
		reviewers.find((candidate) => candidate.value === "user")?.value ??
		reviewers[0]?.value;
	return {
		providerId: provider.id,
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		...(permissionMode ? { permissionMode } : {}),
		...(approvalsReviewer ? { approvalsReviewer } : {}),
	};
}

function resolveRavenProviderOwnership({
	agentList,
	agentSkillContext,
	vaultProviderId,
	sessionSelection,
	restoredProviderId,
	liveSessionSelection,
	pendingProviderId,
}: {
	agentList: RavenAgentList;
	agentSkillContext: string | undefined;
	vaultProviderId: string;
	sessionSelection: RavenSessionSelection;
	restoredProviderId: string | null;
	liveSessionSelection: RavenSessionSelection | null;
	pendingProviderId: string | null;
}): RavenProviderOwnership {
	const configuredProviderId = resolveActiveProviderId(
		agentList,
		agentSkillContext,
		vaultProviderId,
	);
	const selectedProviderId =
		sessionSelection.providerId ?? restoredProviderId ?? configuredProviderId;
	if (pendingProviderId) {
		return {
			activeProviderId: pendingProviderId,
			configuredProviderId,
			sessionSelection,
		};
	}
	if (
		liveSessionSelection?.providerId &&
		liveSessionSelection.providerId !== selectedProviderId
	) {
		return {
			activeProviderId: liveSessionSelection.providerId,
			configuredProviderId,
			sessionSelection: liveSessionSelection,
		};
	}
	return {
		activeProviderId: liveSessionSelection?.providerId ?? selectedProviderId,
		configuredProviderId,
		sessionSelection,
	};
}

function deriveRavenComposerState({
	config,
	providers,
	providerIdentity,
	acpModelCatalogCurrent,
	forceAcpProviderDefaults,
	acpModelCatalogStatus,
	agentSkillContext,
	input,
	activeSkills,
	pendingAttachmentCount,
	pendingVaultReferenceCount,
	uploadingCount,
	wsStatus,
	isRunning,
	model,
	actualModel,
	selection,
	planMode,
}: {
	config: RavenConfig;
	providers: RavenProviders;
	providerIdentity: RavenProviderIdentity;
	acpModelCatalogCurrent: boolean;
	forceAcpProviderDefaults: boolean;
	acpModelCatalogStatus: "loading" | "failed" | null;
	agentSkillContext: string | undefined;
	input: string;
	activeSkills: ActiveRavenSkill[];
	pendingAttachmentCount: number;
	pendingVaultReferenceCount: number;
	uploadingCount: number;
	wsStatus: string;
	isRunning: boolean;
	model: string | undefined;
	actualModel: string | null;
	selection: RavenSessionSelection;
	planMode: boolean;
}) {
	const hasInput =
		(input.trim().length > 0 ||
			activeSkills.length > 0 ||
			pendingAttachmentCount > 0 ||
			pendingVaultReferenceCount > 0) &&
		uploadingCount === 0 &&
		wsStatus === "connected";
	const selectedAgent = agentSkillContext
		? config.agents?.find((agent) => agent.path === agentSkillContext)
		: undefined;
	const { activeProviderId, configuredProviderId } = providerIdentity;
	const vaultSelection = configuredVaultSelection(config, configuredProviderId);
	const configuredSelection: RavenSessionSelection = {
		providerId: configuredProviderId,
		model: selectedAgent?.model ?? vaultSelection.model,
		effort: selectedAgent?.effort ?? vaultSelection.effort,
		permissionMode:
			selectedAgent?.permission_mode ?? vaultSelection.permissionMode,
	};
	const providerUsesConfiguredDefaults =
		activeProviderId === configuredProviderId;
	const desiredModel =
		selection.model ??
		(providerUsesConfiguredDefaults ? configuredSelection.model : undefined) ??
		model;
	const provider = providers.find(
		(candidate) => candidate.id === activeProviderId,
	);
	const advertisedModels = modelOptions(provider);
	const desiredModelAdvertised =
		desiredModel !== undefined &&
		desiredModel !== "" &&
		advertisedModels.some(
			(candidate) =>
				candidate.value === desiredModel ||
				(candidate.resolvedModel !== undefined &&
					modelComparisonKey(candidate.resolvedModel) ===
						modelComparisonKey(desiredModel)),
		);
	const currentAcpCatalog =
		provider?.id.startsWith("acp:") && acpModelCatalogCurrent;
	const acceptedLiveAcpModel = provider?.id.startsWith("acp:")
		? provider.liveSessionConfig?.activeModel
		: undefined;
	const selectedModel =
		acceptedLiveAcpModel !== undefined
			? acceptedLiveAcpModel
			: provider?.id.startsWith("acp:") && forceAcpProviderDefaults
				? ""
				: desiredModel === "" && provider?.id.startsWith("acp:")
					? ""
					: !currentAcpCatalog ||
							advertisedModels.length === 0 ||
							desiredModelAdvertised
						? desiredModel
						: (advertisedModels.find((candidate) => candidate.isDefault)
								?.value ?? advertisedModels[0]?.value);
	const desiredEffort =
		selection.effort ??
		(providerUsesConfiguredDefaults ? configuredSelection.effort : null) ??
		null;
	const exactLiveAcpConfig =
		acceptedLiveAcpModel !== undefined &&
		acceptedLiveAcpModel === selectedModel;
	const selectedAcpModelEfforts = provider?.models?.find(
		(candidate) => candidate.value === selectedModel,
	)?.efforts;
	// ACP effort choices may depend on the selected model. An absent model effort
	// list means the provider has not advertised an effort control for that model;
	// falling back to a provider-wide list would make Raven promise a control that
	// the agent may reject.
	const liveEfforts = provider?.id.startsWith("acp:")
		? // ACP's top-level effort list describes only the model that was active
			// during inspection. Reuse it only through that model's annotated row;
			// another model with no row-level efforts advertises no truthful picker.
			(selectedAcpModelEfforts ?? [])
		: effortOptionsFor(provider, selectedModel ?? "", planMode);
	const defaultLiveEffort =
		liveEfforts.find((candidate) => candidate.isDefault)?.value ?? null;
	const acceptedLiveEffort =
		provider?.liveSessionConfig?.activeEffort &&
		liveEfforts.some(
			(candidate) =>
				candidate.value === provider.liveSessionConfig?.activeEffort,
		)
			? provider.liveSessionConfig.activeEffort
			: null;
	const selectedEffort = provider?.id.startsWith("acp:")
		? liveEfforts.length === 0
			? null
			: exactLiveAcpConfig
				? (acceptedLiveEffort ?? defaultLiveEffort)
				: desiredEffort &&
						liveEfforts.some((candidate) => candidate.value === desiredEffort)
					? desiredEffort
					: defaultLiveEffort
		: desiredEffort;
	const selectedPermissionMode =
		selection.permissionMode ??
		(providerUsesConfiguredDefaults
			? configuredSelection.permissionMode
			: null) ??
		null;
	const { effectiveActualModel, mismatch: runtimeModelMismatch } =
		deriveModelMismatch(configuredSelection.model, actualModel, selectedModel);
	const actualSelectionMismatch =
		!!actualModel &&
		!!selectedModel &&
		modelComparisonKey(actualModel) !== modelComparisonKey(selectedModel);
	const modelMismatch =
		activeProviderId !== configuredProviderId ||
		runtimeModelMismatch ||
		actualSelectionMismatch;
	const permissionOptions = sessionPermissionOptionsFor(provider, {
		model: selectedModel,
		policyEnforced: config.umbod?.enabled === true,
		usageGateEnforced: config.auto_sleep?.enabled === true,
	});
	const reviewerOptions = provider?.approvalReviewers ?? [];
	const supportsAutoReview = reviewerOptions.some(
		(candidate) => candidate.value === "auto_review",
	);
	const approvalsReviewerUnavailableReason = !supportsAutoReview
		? null
		: config.umbod?.enabled
			? "Auto-review is unavailable while Hlid policy enforcement is enabled."
			: config.auto_sleep?.enabled
				? "Auto-review is unavailable while Hlid's auto-sleep usage gate is enabled."
				: planMode || selectedPermissionMode === "plan"
					? "Auto-review is inactive in Plan mode; Hlid keeps plan approvals."
					: selectedPermissionMode === "bypassPermissions"
						? "Bypass permissions has no approval requests to review."
						: null;
	const selectedApprovalsReviewer = approvalsReviewerUnavailableReason
		? (reviewerOptions.find((candidate) => candidate.value === "user")?.value ??
			null)
		: (selection.approvalsReviewer ??
			reviewerOptions.find((candidate) => candidate.isDefault)?.value ??
			reviewerOptions.find((candidate) => candidate.value === "user")?.value ??
			reviewerOptions[0]?.value ??
			null);
	const configuredProvider = providers.find(
		(candidate) => candidate.id === configuredProviderId,
	);
	const modelPickerOptions = provider?.id.startsWith("acp:")
		? [
				{
					value: "",
					label: "Provider default",
					description:
						advertisedModels.length > 0
							? "Let the ACP agent choose its configured default model."
							: acpModelCatalogStatus === "loading"
								? "This ACP agent has not advertised model choices yet; live choices are loading and Provider default remains usable."
								: acpModelCatalogStatus === "failed"
									? "Live model discovery is unavailable; Provider default remains usable."
									: "This ACP agent has not advertised model choices.",
				},
				...advertisedModels,
			]
		: advertisedModels;
	return {
		canSend: hasInput && !isRunning,
		canQueue: hasInput && isRunning,
		activeModel: selectedModel,
		activeEffort: selectedEffort,
		activePermissionMode: selectedPermissionMode,
		activeApprovalsReviewer: selectedApprovalsReviewer,
		modelShort: selectedModel ? fmtModel(selectedModel) : null,
		actualModelShort: effectiveActualModel
			? fmtModel(effectiveActualModel)
			: null,
		modelMismatch,
		actualSelectionMismatch,
		activeProviderLabel: provider?.label ?? activeProviderId,
		configuredProviderLabel: configuredProvider?.label ?? configuredProviderId,
		configuredModelShort: configuredSelection.model
			? fmtModel(configuredSelection.model)
			: null,
		configuredSelection,
		modelPickerOptions,
		permissionOptions,
		approvalsReviewerOptions: approvalsReviewerUnavailableReason
			? reviewerOptions.filter((candidate) => candidate.value === "user")
			: reviewerOptions,
		approvalsReviewerUnavailableReason,
		effortOptions: liveEfforts,
		providerModeOptions: provider?.liveSessionConfig?.modes ?? [],
		activeProviderMode: provider?.liveSessionConfig?.activeMode ?? null,
		providerPlanModeValue: provider?.liveSessionConfig?.planModeValue ?? null,
	};
}

export function ChatPage() {
	const {
		config,
		existingSessionId,
		isExplicitSession,
		sessionPersisted: loadedSessionPersisted,
		providerUsages: initialProviderUsages,
		agentSkillContext: initialAgentSkillContext,
		sessionModel: initialSessionModel,
		sessionProviderId: initialSessionProviderId,
		sessionEffort: initialSessionEffort,
		sessionPermissionMode: initialSessionPermissionMode,
		sessionApprovalsReviewer: initialSessionApprovalsReviewer,
		forkParentSessionId,
		forkKind,
		delegationParentSessionId,
		delegationParentLabel,
		delegationDepth,
		delegationControlOwned: initialDelegationControlOwned,
		agentList: initialAgentList,
		vaultSkills,
		providers: initialProviders,
		voiceInfo: initialVoiceInfo,
	} = Route.useLoaderData();
	const sessionPersisted = loadedSessionPersisted ?? Boolean(existingSessionId);
	const [agentList, setAgentList] = useState(initialAgentList);
	const [providerCatalog, setProviderCatalog] = useState(initialProviders);
	const [providers, setProviders] = useState(initialProviders);
	const initialProviderDiscoveryCwd = ravenProviderDiscoveryCwd(
		config,
		initialAgentSkillContext,
	);
	useEffect(() => {
		setAgentList(initialAgentList);
		if (initialAgentList.length > 0) return;
		let cancelled = false;
		void Promise.resolve(getAgentListFn()).then(
			(next) => {
				if (!cancelled && Array.isArray(next) && next.length > 0) {
					setAgentList(next);
				}
			},
			() => {},
		);
		return () => {
			cancelled = true;
		};
	}, [initialAgentList]);
	useEffect(() => {
		setProviderCatalog(initialProviders);
		if (initialProviders.length > 0) return;
		let cancelled = false;
		void loadRavenProviders(initialProviderDiscoveryCwd).then(
			(next) => {
				if (!cancelled && Array.isArray(next) && next.length > 0) {
					setProviderCatalog(next);
				}
			},
			() => {},
		);
		return () => {
			cancelled = true;
		};
	}, [initialProviderDiscoveryCwd, initialProviders]);
	const ravenSearch = Route.useSearch();
	const navigate = useNavigate();
	const sessionsDataRevision = useSyncExternalStore(
		subscribeDataRevisionSnapshot,
		() => getDataRevisionSnapshot().sessions,
		() => 0,
	);
	const providersDataRevision = useSyncExternalStore(
		subscribeDataRevisionSnapshot,
		() => getDataRevisionSnapshot().providers,
		() => 0,
	);
	const [delegationControlOwned, setDelegationControlOwned] = useState(
		initialDelegationControlOwned,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset cached ownership on session navigation
	useEffect(() => {
		setDelegationControlOwned(initialDelegationControlOwned);
	}, [existingSessionId, initialDelegationControlOwned]);
	useEffect(() => {
		if (!existingSessionId || !delegationParentSessionId) {
			setDelegationControlOwned(false);
			return;
		}
		let cancelled = false;
		void Promise.resolve(getSessionRowFn({ data: existingSessionId }))
			.then((row) => {
				if (
					!cancelled &&
					row &&
					getDataRevisionSnapshot().sessions === sessionsDataRevision
				) {
					setDelegationControlOwned(row.delegation_control_owned === 1);
				}
			})
			.catch(() => {
				// Preserve the last known ownership state until a later revision retries.
			});
		return () => {
			cancelled = true;
		};
	}, [delegationParentSessionId, existingSessionId, sessionsDataRevision]);
	const session = useRavenSessionIdentity({
		config,
		agentList,
		existingSessionId,
		initialAgentSkillContext,
		routeSessionId: ravenSearch.session,
		routeAgent: ravenSearch.agent,
		navigate,
	});
	const { agentSkillContext, sessionId, sessionIdRef, interactiveMode } =
		session;
	const notificationSessionId =
		session.liveSessionStatus?.db_session_id ??
		(sessionPersisted ? sessionId : null);
	const restoredSession = Boolean(
		existingSessionId && agentSkillContext === initialAgentSkillContext,
	);
	const [activeSkills, setActiveSkills] = useState<ActiveRavenSkill[]>([]);
	const [sessionSelection, setSessionSelection] =
		useState<RavenSessionSelection>(() =>
			restoredRavenSessionSelection(
				existingSessionId,
				agentSkillContext,
				initialAgentSkillContext,
				initialSessionModel,
				initialSessionProviderId,
				initialSessionEffort,
				initialSessionPermissionMode,
				initialSessionApprovalsReviewer,
			),
		);
	const [pendingProviderId, setPendingProviderId] = useState<string | null>(
		null,
	);
	const pendingProviderIdRef = useRef<string | null>(null);
	const pendingSessionControlsRef = useRef<
		Partial<Omit<RavenSessionSelection, "providerId">>
	>({});
	useEffect(() => {
		pendingProviderIdRef.current = null;
		pendingSessionControlsRef.current = {};
		setPendingProviderId(null);
		setSessionSelection(
			restoredRavenSessionSelection(
				existingSessionId,
				agentSkillContext,
				initialAgentSkillContext,
				initialSessionModel,
				initialSessionProviderId,
				initialSessionEffort,
				initialSessionPermissionMode,
				initialSessionApprovalsReviewer,
			),
		);
	}, [
		existingSessionId,
		agentSkillContext,
		initialAgentSkillContext,
		initialSessionModel,
		initialSessionProviderId,
		initialSessionEffort,
		initialSessionPermissionMode,
		initialSessionApprovalsReviewer,
	]);
	const liveSessionStatus = session.liveSessionStatus;
	const liveSessionSelection = liveRavenSessionSelection(liveSessionStatus);
	const liveSessionSelectionRef = useRef(liveSessionSelection);
	liveSessionSelectionRef.current = liveSessionSelection;
	useEffect(() => {
		if (!liveSessionStatus || liveSessionStatus.mode === "terminal") return;
		const liveProviderId = liveSessionStatus.provider_id ?? null;
		const pendingProvider = pendingProviderIdRef.current;
		if (pendingProvider && liveProviderId !== pendingProvider) return;
		if (pendingProvider) {
			pendingProviderIdRef.current = null;
			setPendingProviderId(null);
		}
		const pendingControls = pendingSessionControlsRef.current;
		const applyModel =
			pendingControls.model === undefined ||
			pendingControls.model === liveSessionStatus.model;
		const applyEffort =
			pendingControls.effort === undefined ||
			pendingControls.effort === liveSessionStatus.effort;
		const applyPermissionMode =
			pendingControls.permissionMode === undefined ||
			pendingControls.permissionMode === liveSessionStatus.permission_mode;
		const applyApprovalsReviewer =
			pendingControls.approvalsReviewer === undefined ||
			pendingControls.approvalsReviewer ===
				liveSessionStatus.approvals_reviewer;
		pendingSessionControlsRef.current = {
			...(!applyModel && pendingControls.model !== undefined
				? { model: pendingControls.model }
				: {}),
			...(!applyEffort && pendingControls.effort !== undefined
				? { effort: pendingControls.effort }
				: {}),
			...(!applyPermissionMode && pendingControls.permissionMode !== undefined
				? { permissionMode: pendingControls.permissionMode }
				: {}),
			...(!applyApprovalsReviewer &&
			pendingControls.approvalsReviewer !== undefined
				? { approvalsReviewer: pendingControls.approvalsReviewer }
				: {}),
		};
		setSessionSelection((current) => {
			const providerChanged =
				liveProviderId !== null && current.providerId !== liveProviderId;
			const base: RavenSessionSelection = providerChanged
				? { providerId: liveProviderId }
				: current;
			const next = {
				...base,
				...(applyModel ? { model: liveSessionStatus.model } : {}),
				...(applyEffort && liveSessionStatus.effort
					? { effort: liveSessionStatus.effort }
					: {}),
				...(applyPermissionMode && liveSessionStatus.permission_mode
					? { permissionMode: liveSessionStatus.permission_mode }
					: {}),
				...(applyApprovalsReviewer && liveSessionStatus.approvals_reviewer
					? { approvalsReviewer: liveSessionStatus.approvals_reviewer }
					: {}),
			};
			return next.providerId === current.providerId &&
				next.model === current.model &&
				next.effort === current.effort &&
				next.permissionMode === current.permissionMode &&
				next.approvalsReviewer === current.approvalsReviewer
				? current
				: next;
		});
	}, [liveSessionStatus]);
	const selectSessionProvider = useCallback(
		(next: RavenSessionSelection) => {
			const nextProviderId = next.providerId ?? null;
			const liveProviderId = liveSessionSelection?.providerId ?? null;
			const pending =
				nextProviderId && nextProviderId !== liveProviderId
					? nextProviderId
					: null;
			pendingProviderIdRef.current = pending;
			pendingSessionControlsRef.current = {
				...(next.model !== undefined ? { model: next.model } : {}),
				...(next.effort !== undefined ? { effort: next.effort } : {}),
				...(next.permissionMode !== undefined
					? { permissionMode: next.permissionMode }
					: {}),
				...(next.approvalsReviewer !== undefined
					? { approvalsReviewer: next.approvalsReviewer }
					: {}),
			};
			setPendingProviderId(pending);
			setSessionSelection(next);
		},
		[liveSessionSelection?.providerId],
	);
	const selectSessionControls = useCallback(
		(next: Partial<Omit<RavenSessionSelection, "providerId">>) => {
			pendingSessionControlsRef.current = {
				...pendingSessionControlsRef.current,
				...next,
			};
			setSessionSelection((current) => ({ ...current, ...next }));
		},
		[],
	);
	const resetSessionSelection = useCallback(() => {
		pendingProviderIdRef.current = null;
		pendingSessionControlsRef.current = {};
		setPendingProviderId(null);
		setSessionSelection({});
	}, []);

	const liveStats = useWsLiveStats();
	const chatQueue = useWsChatQueue();
	const providerIdentity = resolveRavenProviderOwnership({
		agentList,
		agentSkillContext,
		vaultProviderId: config.vault_provider,
		sessionSelection,
		restoredProviderId: restoredSession ? initialSessionProviderId : null,
		liveSessionSelection,
		pendingProviderId,
	});
	const {
		activeProviderId,
		configuredProviderId,
		sessionSelection: effectiveSessionSelection,
	} = providerIdentity;
	const activeProviderDiscoveryCwd = ravenProviderDiscoveryCwd(
		config,
		agentSkillContext,
	);
	const sharedProviderCatalog = useSyncExternalStore(
		subscribeRavenProviderCache,
		() => getRavenProviderCacheSnapshot(activeProviderDiscoveryCwd),
		() => null,
	);
	useEffect(() => {
		// A scoped refresh that does not contain the provider Raven currently owns
		// is not an accepted replacement for this composer. In particular, keep a
		// live session's options intact when a failed/partial refresh returns an
		// empty catalog.
		if (
			sharedProviderCatalog?.some(
				(provider) => provider.id === activeProviderId,
			)
		) {
			setProviderCatalog(sharedProviderCatalog);
		}
	}, [activeProviderId, sharedProviderCatalog]);
	const providerCatalogRefreshSequenceRef = useRef(0);
	const providerCatalogRefreshContext = `${sessionId}\0${activeProviderDiscoveryCwd ?? ""}\0${activeProviderId}\0${configuredProviderId}\0${agentSkillContext ?? ""}`;
	const providerCatalogRefreshContextRef = useRef(
		providerCatalogRefreshContext,
	);
	providerCatalogRefreshContextRef.current = providerCatalogRefreshContext;
	useEffect(
		() => () => {
			providerCatalogRefreshSequenceRef.current += 1;
		},
		[],
	);
	const refreshProviderCatalog = useCallback(
		async (providerId: string): Promise<RavenProviders | null> => {
			const sequence = providerCatalogRefreshSequenceRef.current + 1;
			providerCatalogRefreshSequenceRef.current = sequence;
			const context = providerCatalogRefreshContext;
			const next = await refreshRavenProviderForSession(
				sessionId || "new",
				providerId,
				activeProviderDiscoveryCwd,
			);
			if (
				providerCatalogRefreshSequenceRef.current !== sequence ||
				providerCatalogRefreshContextRef.current !== context
			) {
				return null;
			}
			const target = next.find((candidate) => candidate.id === providerId);
			if (target?.modelCatalogRefresh?.status !== "current") return null;
			setProviderCatalog(next);
			return next;
		},
		[activeProviderDiscoveryCwd, providerCatalogRefreshContext, sessionId],
	);
	const [currentAcpModelCatalogContext, setCurrentAcpModelCatalogContext] =
		useState<string | null>(null);
	const [acpModelCatalogRefresh, setAcpModelCatalogRefresh] = useState<{
		context: string;
		phase: "loading" | "current" | "failed";
	} | null>(null);
	const [acpModelCatalogRefreshAttempt, setAcpModelCatalogRefreshAttempt] =
		useState(0);
	const handledAcpModelCatalogRefreshAttemptRef = useRef(0);
	const refreshingAcpModelCatalogContextRef = useRef<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry state deliberately restarts the exact refresh
	useEffect(() => {
		if (!activeProviderId.startsWith("acp:")) {
			refreshingAcpModelCatalogContextRef.current = null;
			setCurrentAcpModelCatalogContext(null);
			setAcpModelCatalogRefresh(null);
			return;
		}
		let cancelled = false;
		const context = providerCatalogRefreshContext;
		const explicitRetry =
			acpModelCatalogRefreshAttempt >
			handledAcpModelCatalogRefreshAttemptRef.current;
		if (explicitRetry) {
			handledAcpModelCatalogRefreshAttemptRef.current =
				acpModelCatalogRefreshAttempt;
		}
		const refreshAlreadyStartedForContext =
			refreshingAcpModelCatalogContextRef.current === context;
		// Keep the durable provider-default sentinel authoritative for a fresh
		// ownership change while cached options remain visible. A fresh accepted
		// exact-workspace cache needs no provider process on selection. If this
		// effect already started a required refresh, keep joining it when its cache
		// publication notifies React so the live result still becomes authoritative.
		setCurrentAcpModelCatalogContext(null);
		if (
			!explicitRetry &&
			!refreshAlreadyStartedForContext &&
			hasFreshRavenProviderModels(activeProviderId, activeProviderDiscoveryCwd)
		) {
			setAcpModelCatalogRefresh(null);
			return;
		}
		refreshingAcpModelCatalogContextRef.current = context;
		setAcpModelCatalogRefresh({ context, phase: "loading" });
		void refreshProviderCatalog(activeProviderId).then(
			(catalog) => {
				if (!cancelled && catalog) {
					if (refreshingAcpModelCatalogContextRef.current === context) {
						refreshingAcpModelCatalogContextRef.current = null;
					}
					setCurrentAcpModelCatalogContext(context);
					setAcpModelCatalogRefresh({ context, phase: "current" });
				} else if (!cancelled) {
					if (refreshingAcpModelCatalogContextRef.current === context) {
						refreshingAcpModelCatalogContextRef.current = null;
					}
					setAcpModelCatalogRefresh({ context, phase: "failed" });
				}
			},
			() => {
				if (!cancelled) {
					if (refreshingAcpModelCatalogContextRef.current === context) {
						refreshingAcpModelCatalogContextRef.current = null;
					}
					setAcpModelCatalogRefresh({ context, phase: "failed" });
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [
		activeProviderId,
		acpModelCatalogRefreshAttempt,
		providersDataRevision,
		providerCatalogRefreshContext,
		refreshProviderCatalog,
	]);
	const retryAcpModelCatalog = useCallback(() => {
		setAcpModelCatalogRefreshAttempt((attempt) => attempt + 1);
	}, []);
	const acpModelCatalogCurrent =
		!activeProviderId.startsWith("acp:") ||
		currentAcpModelCatalogContext === providerCatalogRefreshContext;
	const handleSessionControlRejected = useCallback(
		(message: SessionControlRejectedMessage) => {
			if (
				message.session_id !== undefined &&
				canonicalSessionId(message.session_id) !==
					canonicalSessionId(sessionIdRef.current)
			) {
				return;
			}
			const pending = pendingSessionControlsRef.current;
			if (message.control === "provider") {
				if (pendingProviderIdRef.current !== message.attempted_value) return;
				pendingProviderIdRef.current = null;
				pendingSessionControlsRef.current = {};
				setPendingProviderId(null);
				const liveSelection = liveSessionSelectionRef.current;
				setSessionSelection(
					liveSelection?.providerId === message.authoritative_value
						? liveSelection
						: { providerId: message.authoritative_value },
				);
				return;
			}
			if (message.control === "effort") {
				if (pending.effort !== message.attempted_value) return;
				const { effort: _rejectedEffort, ...remaining } = pending;
				pendingSessionControlsRef.current = remaining;
				setSessionSelection((current) => ({
					...current,
					effort: message.authoritative_value,
				}));
				return;
			}
			if (message.control === "model") {
				if (pending.model !== undefined) {
					if (pending.model !== message.attempted_value) return;
					const { model: _rejectedModel, ...remaining } = pending;
					pendingSessionControlsRef.current = remaining;
					setSessionSelection((current) => ({
						...current,
						model: message.authoritative_value,
					}));
					return;
				}

				// A live status can acknowledge the optimistic model before the native
				// or durable transaction later rolls back. Apply that correlated late
				// rejection only while the attempted model is still selected.
				setSessionSelection((current) =>
					current.model === message.attempted_value
						? { ...current, model: message.authoritative_value }
						: current,
				);
				return;
			}
			if (message.control !== "permission_mode") return;

			if (pending.permissionMode !== undefined) {
				if (pending.permissionMode !== message.attempted_value) return;
				const { permissionMode: _rejectedPermissionMode, ...remaining } =
					pending;
				pendingSessionControlsRef.current = remaining;
				setSessionSelection((current) => ({
					...current,
					permissionMode: message.authoritative_value,
				}));
				return;
			}

			// Native Claude can reject after its accepted status already cleared the
			// optimistic marker, including a model change that makes Auto invalid.
			// Apply only when the current selection is still the attempted mode so a
			// late rejection cannot overwrite a newer choice.
			setSessionSelection((current) =>
				current.permissionMode === message.attempted_value
					? {
							...current,
							permissionMode: message.authoritative_value,
						}
					: current,
			);
		},
		[sessionIdRef],
	);
	const runtime = useRavenChatRuntime({
		existingSessionId,
		isExplicitSession,
		sessionId,
		notificationSessionId,
		sessionIdRef,
		agentCwd: agentSkillContext,
		expectedProviderId: activeProviderId,
		onSessionControlRejected: handleSessionControlRejected,
	});
	const {
		wsStatus,
		model,
		actualModel,
		isRunning,
		sdkSlashCommands,
		sdkSlashCommandProviderId,
		rateLimit,
		messages,
	} = runtime;
	useEffect(() => {
		if (wsStatus === "connected") return;
		const pendingControls = pendingSessionControlsRef.current;
		const hadPendingControls = Object.values(pendingControls).some(
			(value) => value !== undefined,
		);
		if (!pendingProviderIdRef.current && !hadPendingControls) return;

		pendingProviderIdRef.current = null;
		pendingSessionControlsRef.current = {};
		setPendingProviderId(null);

		let rollbackSelection = liveRavenSessionSelection(liveSessionStatus);
		if (!rollbackSelection && existingSessionId) {
			rollbackSelection = restoredRavenSessionSelection(
				existingSessionId,
				agentSkillContext,
				initialAgentSkillContext,
				initialSessionModel,
				initialSessionProviderId,
				initialSessionEffort,
				initialSessionPermissionMode,
				initialSessionApprovalsReviewer,
			);
		}
		if (!rollbackSelection) return;
		setSessionSelection((current) =>
			current.providerId === rollbackSelection.providerId &&
			current.model === rollbackSelection.model &&
			current.effort === rollbackSelection.effort &&
			current.permissionMode === rollbackSelection.permissionMode &&
			current.approvalsReviewer === rollbackSelection.approvalsReviewer
				? current
				: rollbackSelection,
		);
	}, [
		wsStatus,
		liveSessionStatus,
		existingSessionId,
		agentSkillContext,
		initialAgentSkillContext,
		initialSessionModel,
		initialSessionProviderId,
		initialSessionEffort,
		initialSessionPermissionMode,
		initialSessionApprovalsReviewer,
	]);
	const { prompt: seededPrompt } = ravenSearch;
	const { input, setInput, clearDraft } = useDraft({
		existingSessionId,
		seededPrompt,
		onClearSeed: () =>
			navigate({
				to: "/raven",
				search: (prev) => ({ ...prev, prompt: undefined }),
				replace: true,
			}),
	});
	const vaultPicker = useVaultReferencePicker(input, setInput, {
		workspaceAgentCwd: agentSkillContext,
	});
	const upload = useFileUpload({ agentCwd: agentSkillContext, sessionId });
	const { pendingAttachments, uploadingCount } = upload;
	const [planMode, setPlanMode] = useState(false);
	useEffect(() => {
		const live = runtime.providerConfigOptions;
		setProviders(
			live
				? applyLiveProviderConfig(providerCatalog, live.provider_id, live)
				: providerCatalog,
		);
		if (live?.activeMode && live.planModeValue) {
			setPlanMode(live.activeMode === live.planModeValue);
		}
	}, [providerCatalog, runtime.providerConfigOptions]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: provider-backed Plan belongs to one Raven context
	useEffect(() => {
		setPlanMode(false);
	}, [agentSkillContext, existingSessionId, activeProviderId]);
	const [planHtml, setPlanHtml] = useState(config.ui.html_plans ?? false);
	const [, refreshTerminalState] = useReducer(
		(revision: number) => revision + 1,
		0,
	);
	const terminalOpen = isRavenTerminalOpen(sessionId);
	const [terminalClosingSessionId, setTerminalClosingSessionId] = useState<
		string | null
	>(null);
	// Terminal lifetime and the visible mobile pane are separate concerns. An
	// open terminal survives site navigation, but returning to Raven should put
	// the conversation back in view until the user explicitly selects Terminal.
	const [shellTab, setShellTab] = useState<RavenPaneTab>("chat");
	const handleToggleTerminal = useCallback(() => {
		const next = !isRavenTerminalOpen(sessionId);
		if (next) {
			setTerminalClosingSessionId(null);
			rememberRavenTerminal(sessionId);
		} else {
			// This distinguishes an explicit toggle-off from a route unmount. Only
			// the former owns and terminates the server-side shell.
			setTerminalClosingSessionId(sessionId);
			forgetRavenTerminal(sessionId);
		}
		setShellTab(next ? "terminal" : "chat");
		refreshTerminalState();
	}, [sessionId]);
	const [dragOver, setDragOver] = useState(false);
	const [showModelPopup, setShowModelPopup] = useState(false);
	const viewport = useRavenViewport({
		input,
		messages,
		sessionId,
		activeSkills,
		showModelPopup,
		setShowModelPopup,
	});
	const { focusSkillOnNextRender } = viewport;

	// ─── Skills + slash picker ────────────────────────────────────────────────

	useEffect(() => {
		setActiveSkills((selected) =>
			filterProviderCompatibleCommands(selected, activeProviderId),
		);
	}, [activeProviderId]);
	const savedWorkflowCommands = useMemo<ProviderCommand[]>(
		() =>
			runtime.workflowCatalogProviderId === activeProviderId &&
			(runtime.workflowCatalogAgentCwd ?? "") === (agentSkillContext ?? "")
				? runtime.workflowCatalog.workflows
						.filter((workflow) => workflow.availableAsCommand)
						.map((workflow) => ({
							name: workflow.name,
							description: workflow.description,
							argumentHint: workflow.argumentHint,
							workflowScriptPath: workflow.scriptPath,
							alwaysVisible: true,
						}))
				: [],
		[
			activeProviderId,
			agentSkillContext,
			runtime.workflowCatalog,
			runtime.workflowCatalogAgentCwd,
			runtime.workflowCatalogProviderId,
		],
	);
	const providerCommands = useMemo<ProviderCommand[]>(
		() => [
			...savedWorkflowCommands,
			...(sdkSlashCommandProviderId === activeProviderId
				? sdkSlashCommands
				: []),
		],
		[
			activeProviderId,
			savedWorkflowCommands,
			sdkSlashCommandProviderId,
			sdkSlashCommands,
		],
	);
	const commandVaultSkills = useMemo(
		() =>
			isClaudeRuntimeProvider(activeProviderId) &&
			sdkSlashCommandProviderId === activeProviderId
				? vaultSkills.filter((skill) => skill.providerId !== activeProviderId)
				: vaultSkills,
		[activeProviderId, sdkSlashCommandProviderId, vaultSkills],
	);
	const commands = useCommands(
		commandVaultSkills,
		providerCommands,
		activeProviderId,
		"raven",
	);
	useEffect(() => {
		const availableWorkflowIds = new Set(
			commands
				.filter((command) => command.execution.kind === "workflow")
				.map((command) => command.id),
		);
		setActiveSkills((selected) => {
			const next = selected.filter(
				(command) =>
					command.execution.kind !== "workflow" ||
					availableWorkflowIds.has(command.id),
			);
			return next.length === selected.length ? selected : next;
		});
	}, [commands]);

	const picker = useSlashPicker(
		input,
		commands,
		activeSkills,
		activeProviderId,
		config.ui.show_provider_entries,
	);

	function handleSkillSelect(command: CommandDescriptor) {
		focusSkillOnNextRender();
		setActiveSkills((selected) =>
			addCommandSelection(selected, command, activeProviderId),
		);
		setInput(picker.promptWithoutQuery);
	}
	const liveAcpModelCatalogCurrent =
		runtime.providerConfigOptions?.provider_id === activeProviderId &&
		runtime.providerConfigOptions.models !== undefined;
	const effectiveAcpModelCatalogCurrent =
		acpModelCatalogCurrent || liveAcpModelCatalogCurrent;
	const activeProviderCatalog = providers.find(
		(provider) => provider.id === activeProviderId,
	);
	const acpModelCatalogRefreshPhase =
		activeProviderId.startsWith("acp:") &&
		acpModelCatalogRefresh?.context === providerCatalogRefreshContext
			? acpModelCatalogRefresh.phase
			: null;
	const acpModelCatalogStatus =
		acpModelCatalogRefreshPhase === "failed" ||
		(acpModelCatalogRefreshPhase === "loading" &&
			(activeProviderCatalog?.models?.length ?? 0) === 0)
			? acpModelCatalogRefreshPhase
			: null;

	const {
		canSend,
		canQueue,
		modelShort,
		activeModel,
		activeEffort,
		activePermissionMode,
		activeApprovalsReviewer,
		actualModelShort,
		modelMismatch,
		actualSelectionMismatch,
		activeProviderLabel,
		configuredProviderLabel,
		configuredModelShort,
		configuredSelection,
		modelPickerOptions,
		permissionOptions,
		approvalsReviewerOptions,
		approvalsReviewerUnavailableReason,
		effortOptions,
		providerModeOptions,
		activeProviderMode,
		providerPlanModeValue,
	} = deriveRavenComposerState({
		config,
		providers,
		providerIdentity,
		acpModelCatalogCurrent: effectiveAcpModelCatalogCurrent,
		forceAcpProviderDefaults:
			activeProviderId.startsWith("acp:") &&
			!sessionPersisted &&
			!effectiveAcpModelCatalogCurrent,
		acpModelCatalogStatus,
		agentSkillContext,
		input,
		activeSkills,
		pendingAttachmentCount:
			pendingAttachments.length + vaultPicker.selectedRelics.length,
		pendingVaultReferenceCount:
			vaultPicker.selected.length + vaultPicker.selectedWorkspace.length,
		uploadingCount,
		wsStatus,
		isRunning,
		model,
		actualModel,
		selection: effectiveSessionSelection,
		planMode,
	});
	// The badge renders configured/live fallbacks even before a new chat has a
	// DB row. Submit that same effective tuple so the server never receives an
	// omitted model while Raven visibly promises a concrete one.
	const activeSessionSelection: RavenSessionSelection = {
		providerId: activeProviderId,
		...(activeModel !== undefined ? { model: activeModel } : {}),
		...(activeEffort !== null ? { effort: activeEffort } : {}),
		...(activePermissionMode !== null
			? { permissionMode: activePermissionMode }
			: {}),
		...(activeApprovalsReviewer !== null
			? { approvalsReviewer: activeApprovalsReviewer }
			: {}),
	};
	// ─── Handlers ─────────────────────────────────────────────────────────────

	const {
		voice,
		handleDecide,
		handleSubmitAnswers,
		handlePlanDecide,
		handleSend,
		handleCancelQueued,
		handlePromoteQueued,
		handleSteerQueued,
		handleClear,
	} = useRavenActions({
		config,
		initialVoiceInfo,
		activeProviderId,
		input,
		setInput,
		clearDraft,
		activeSkills,
		setActiveSkills,
		commands,
		planMode,
		setPlanMode,
		planHtml,
		sessionSelection: activeSessionSelection,
		setSessionSelection,
		resetSessionSelection,
		session,
		runtime,
		upload,
		vaultPicker,
		viewport,
		chatQueue,
		providers,
	});

	const delegatedNativeSteeringAvailable =
		delegationControlOwned &&
		isRunning &&
		(isClaudeRuntimeProvider(activeProviderId) ||
			isCodexRuntimeProvider(activeProviderId));
	const canSteerDelegatedChild =
		delegatedNativeSteeringAvailable &&
		wsStatus === "connected" &&
		input.trim().length > 0;
	const handleSteerDelegatedChild = useCallback(() => {
		const instruction = input.trim();
		if (!canSteerDelegatedChild || !instruction) return;
		runtime.send({
			type: "steer_active",
			session_id: session.sessionId,
			turn_id: uid(),
			text: instruction,
		});
		clearDraft();
		setInput("");
	}, [
		canSteerDelegatedChild,
		clearDraft,
		input,
		runtime,
		session.sessionId,
		setInput,
	]);
	const composerProps: ChatComposerProps = {
		interactiveMode,
		savedSession: restoredSession,
		sessionPersisted,
		config,
		agentList,
		session,
		runtime,
		upload,
		vaultPicker,
		viewport,
		picker,
		voice,
		input,
		setInput,
		activeSkills,
		clearActiveSkill: (commandId) => {
			setActiveSkills((selected) =>
				selected.filter((command) => command.id !== commandId),
			);
			viewport.textareaRef.current?.focus();
		},
		planMode,
		setPlanMode,
		planHtml,
		setPlanHtml,
		terminalOpen,
		onToggleTerminal: handleToggleTerminal,
		dragOver,
		setDragOver,
		showModelPopup,
		setShowModelPopup,
		modelShort,
		activeModel,
		activeEffort,
		activePermissionMode,
		activeApprovalsReviewer,
		selectSessionControls,
		selectSessionProvider,
		actualModelShort,
		modelMismatch,
		actualSelectionMismatch,
		activeProviderId,
		activeProviderLabel,
		configuredProviderId,
		configuredProviderLabel,
		configuredModelShort,
		configuredSelection,
		providers,
		modelPickerOptions,
		permissionOptions,
		approvalsReviewerOptions,
		approvalsReviewerUnavailableReason,
		effortOptions,
		providerModeOptions,
		activeProviderMode,
		providerPlanModeValue,
		acpModelCatalogStatus,
		retryAcpModelCatalog,
		canSend,
		canQueue,
		delegationSteering: delegationControlOwned,
		delegatedNativeSteeringAvailable,
		canSteerDelegatedChild,
		handleSteerDelegatedChild,
		handleSkillSelect,
		handleSend,
		handleClear,
	};
	// ─── Render ───────────────────────────────────────────────────────────────

	return (
		<ChatPageContent
			config={config}
			initialProviderUsages={initialProviderUsages}
			liveStats={liveStats}
			rateLimit={rateLimit}
			forkParentSessionId={forkParentSessionId}
			forkKind={forkKind}
			delegationParentSessionId={delegationParentSessionId}
			delegationParentLabel={delegationParentLabel}
			delegationDepth={delegationDepth}
			delegationControlOwned={delegationControlOwned}
			interactiveMode={interactiveMode}
			terminalOpen={terminalOpen}
			terminalClosingSessionId={terminalClosingSessionId}
			shellTab={shellTab}
			setShellTab={setShellTab}
			session={session}
			runtime={runtime}
			chatQueue={chatQueue}
			viewport={viewport}
			actions={{
				handleDecide,
				handleSubmitAnswers,
				handlePlanDecide,
				handleCancelQueued,
				handlePromoteQueued,
				handleSteerQueued,
			}}
			composerProps={composerProps}
		/>
	);
}

interface ChatPageContentProps {
	config: RavenConfig;
	initialProviderUsages: Awaited<ReturnType<typeof loadProviderUsages>>;
	liveStats: ReturnType<typeof useWsLiveStats>;
	rateLimit: RateLimitMessage | null;
	forkParentSessionId: string | null;
	forkKind: "exact" | "recap" | null;
	delegationParentSessionId: string | null;
	delegationParentLabel: string | null;
	delegationDepth: number | null;
	delegationControlOwned: boolean;
	interactiveMode: boolean;
	terminalOpen: boolean;
	terminalClosingSessionId: string | null;
	shellTab: RavenPaneTab;
	setShellTab: Dispatch<SetStateAction<RavenPaneTab>>;
	session: ReturnType<typeof useRavenSessionIdentity>;
	runtime: ReturnType<typeof useRavenChatRuntime>;
	chatQueue: ReturnType<typeof useWsChatQueue>;
	viewport: ReturnType<typeof useRavenViewport>;
	actions: Pick<
		ReturnType<typeof useRavenActions>,
		| "handleDecide"
		| "handleSubmitAnswers"
		| "handlePlanDecide"
		| "handleCancelQueued"
		| "handlePromoteQueued"
		| "handleSteerQueued"
	>;
	composerProps: ChatComposerProps;
}

function ChatPageContent(props: ChatPageContentProps) {
	const navigate = useNavigate();
	const {
		initialProviderUsages,
		liveStats,
		rateLimit,
		composerProps,
		interactiveMode,
		terminalOpen,
		shellTab,
		setShellTab,
	} = props;
	const preview = useProjectPreview(props.session.sessionId);
	const previewPresentationRequest = useProjectPreviewPresentationRequest(
		props.session.sessionId,
	);
	const previewActive = Boolean(preview && preview.state !== "stopped");
	const [previewPaneOpen, setPreviewPaneOpen] = useState(true);
	const [previewMaximized, setPreviewMaximized] = useState(false);
	const [previewResizing, setPreviewResizing] = useState(false);
	const previewResizeCleanupRef = useRef<(() => void) | null>(null);
	const previewPresentationEntryRef = useRef({
		sessionId: props.session.sessionId,
		request: previewPresentationRequest,
	});
	if (
		previewPresentationEntryRef.current.sessionId !== props.session.sessionId
	) {
		previewPresentationEntryRef.current = {
			sessionId: props.session.sessionId,
			request: previewPresentationRequest,
		};
	}
	const [previewWidth, setPreviewWidth] = useState(() => {
		if (typeof window === "undefined") return 560;
		const rawWidth = window.localStorage.getItem(RAVEN_PREVIEW_WIDTH_KEY);
		const stored = rawWidth === null ? Number.NaN : Number(rawWidth);
		const available = Math.max(360, window.innerWidth - 360);
		return Number.isFinite(stored)
			? Math.min(1_200, available, Math.max(360, stored))
			: Math.min(560, available);
	});
	const lastPresentedPreviewRef = useRef<{
		sessionId: string;
		previewId: string;
	} | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset the visible pane on session navigation
	useEffect(() => {
		setShellTab("chat");
		setPreviewMaximized(false);
	}, [props.session.sessionId, setShellTab]);
	useEffect(() => {
		if (!preview?.present || preview.state === "stopped") return;
		if (
			lastPresentedPreviewRef.current?.sessionId === preview.session_id &&
			lastPresentedPreviewRef.current.previewId === preview.id
		) {
			return;
		}
		lastPresentedPreviewRef.current = {
			sessionId: preview.session_id,
			previewId: preview.id,
		};
		setPreviewPaneOpen(true);
	}, [preview]);
	useEffect(() => {
		if (
			!isNewProjectPreviewPresentationRequest(
				previewPresentationRequest,
				previewPresentationEntryRef.current.request,
			)
		) {
			return;
		}
		setPreviewPaneOpen(true);
		if (window.matchMedia("(max-width: 767px)").matches) {
			setShellTab("preview");
		}
	}, [previewPresentationRequest, setShellTab]);
	useEffect(() => {
		window.localStorage.setItem(
			RAVEN_PREVIEW_WIDTH_KEY,
			String(Math.round(previewWidth)),
		);
	}, [previewWidth]);
	useEffect(() => {
		if (!previewMaximized) return;
		const restore = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") setPreviewMaximized(false);
		};
		window.addEventListener("keydown", restore);
		return () => window.removeEventListener("keydown", restore);
	}, [previewMaximized]);
	useEffect(() => {
		if (previewActive) return;
		setPreviewMaximized(false);
		setPreviewPaneOpen(false);
		setShellTab(ravenTabAfterProjectPreviewStops);
	}, [previewActive, setShellTab]);
	useEffect(() => {
		const clampPreviewWidth = () => {
			const available = Math.max(360, window.innerWidth - 360);
			setPreviewWidth((width) => Math.min(width, available));
		};
		window.addEventListener("resize", clampPreviewWidth);
		return () => window.removeEventListener("resize", clampPreviewWidth);
	}, []);
	useEffect(
		() => () => {
			previewResizeCleanupRef.current?.();
			previewResizeCleanupRef.current = null;
		},
		[],
	);
	const beginPreviewResize = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			previewResizeCleanupRef.current?.();
			const startX = event.clientX;
			const startWidth = previewWidth;
			const pointerId = event.pointerId;
			const handle = event.currentTarget;
			try {
				handle.setPointerCapture(pointerId);
			} catch {
				// Window listeners and iframe shielding remain the fallback.
			}
			setPreviewResizing(true);
			const move = (moveEvent: PointerEvent) => {
				if (moveEvent.pointerId !== pointerId) return;
				const available = Math.max(360, window.innerWidth - 360);
				setPreviewWidth(
					Math.min(
						available,
						Math.max(360, startWidth + startX - moveEvent.clientX),
					),
				);
			};
			let stopped = false;
			const stop = (stopEvent?: Event) => {
				if (
					stopEvent &&
					"pointerId" in stopEvent &&
					stopEvent.pointerId !== pointerId
				) {
					return;
				}
				if (stopped) return;
				stopped = true;
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", stop);
				window.removeEventListener("pointercancel", stop);
				window.removeEventListener("blur", stop);
				handle.removeEventListener("lostpointercapture", stop);
				try {
					if (handle.hasPointerCapture(pointerId)) {
						handle.releasePointerCapture(pointerId);
					}
				} catch {
					// Capture may already have been released by the browser.
				}
				previewResizeCleanupRef.current = null;
				setPreviewResizing(false);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", stop);
			window.addEventListener("pointercancel", stop);
			window.addEventListener("blur", stop);
			handle.addEventListener("lostpointercapture", stop);
			previewResizeCleanupRef.current = stop;
		},
		[previewWidth],
	);
	return (
		<LiveSessionSwitcher
			currentSessionId={props.session.sessionId}
			hotkey={props.config.ui.live_sessions_hotkey}
			voiceHotkey={
				props.config.voice.enabled ? props.config.voice.hotkey : undefined
			}
			onSelectSession={(sessionId, replace) =>
				void navigate({
					to: "/raven",
					search: (previous) => ({
						...previous,
						session: sessionId,
						agent: undefined,
						prompt: undefined,
					}),
					replace,
				})
			}
			onOpenLedger={(replace) =>
				void navigate({
					to: "/ledger",
					search: {
						tab: "sessions",
						page: 1,
						size: 20,
					},
					replace,
				})
			}
		>
			<ProviderUsageStrip
				initial={initialProviderUsages}
				liveQueryCount={liveStats?.queries ?? 0}
				rateLimit={rateLimit}
				preferredProviderId={composerProps.activeProviderId}
				fetchFn={loadProviderUsages}
				tail={<ContextWindowSection stats={liveStats} />}
			/>
			{!props.delegationControlOwned && (
				<RavenGoalStrip
					goal={props.runtime.goal}
					editorOpen={props.runtime.goalEditorOpen}
					pending={props.runtime.goalPending}
					error={props.runtime.goalError}
					onOpenEditor={props.runtime.openGoalEditor}
					onCloseEditor={props.runtime.closeGoalEditor}
					onSet={(objective, tokenBudget) => {
						if (props.runtime.goal) {
							props.runtime.controlGoal({
								action: "set",
								objective,
								tokenBudget,
							});
						} else {
							props.runtime.stageGoalStart(objective, tokenBudget);
							props.composerProps.handleSend(objective, {
								objective,
								tokenBudget,
							});
						}
						props.runtime.closeGoalEditor();
					}}
					onPause={() => props.runtime.controlGoal({ action: "pause" })}
					onResume={() => props.runtime.controlGoal({ action: "resume" })}
					onClear={() => props.runtime.controlGoal({ action: "clear" })}
					onDismissError={props.runtime.dismissGoalError}
				/>
			)}
			{!interactiveMode && (terminalOpen || previewActive) && (
				<RavenShellTabBar
					activeTab={shellTab}
					setActiveTab={(tab) => {
						if (tab === "preview") setPreviewPaneOpen(true);
						setShellTab(tab);
					}}
					terminalOpen={terminalOpen}
					previewOpen={previewActive}
				/>
			)}
			<div
				className={`flex flex-1 min-h-0 min-w-0 ${
					previewResizing ? "cursor-col-resize select-none" : ""
				}`}
			>
				<div
					className={`min-h-0 min-w-0 flex-1 flex-col ${
						previewActive && shellTab === "preview" && previewPaneOpen
							? "hidden md:flex"
							: "flex"
					}`}
				>
					{props.forkParentSessionId && (
						<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/15 px-4 py-1.5">
							<span className="text-[9px] tracking-widest text-muted-foreground uppercase">
								{props.forkKind === "exact" ? "Exact fork" : "Fork"}
							</span>
							<button
								type="button"
								onClick={() =>
									void navigate({
										to: "/raven",
										search: {
											session: props.forkParentSessionId ?? undefined,
											agent: undefined,
										},
									})
								}
								className="text-[9px] tracking-widest text-primary/70 hover:text-primary uppercase"
							>
								Open source
							</button>
						</div>
					)}
					{props.delegationParentSessionId && (
						<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-primary/[0.035] px-4 py-1.5">
							<span className="min-w-0">
								<span className="block truncate text-[9px] tracking-widest text-muted-foreground uppercase">
									Delegated child
									{props.delegationDepth
										? ` · depth ${props.delegationDepth}`
										: ""}
									{props.delegationParentLabel && (
										<>
											{" · "}
											<PrivacyMask inline>
												{props.delegationParentLabel}
											</PrivacyMask>
										</>
									)}
								</span>
								{props.delegationControlOwned && (
									<output className="mt-0.5 block truncate text-[9px] text-primary/65">
										{props.runtime.isRunning
											? props.composerProps.delegatedNativeSteeringAvailable
												? "Native steering is available here. Open the parent to cancel or manage this child."
												: "This provider has no native steering. Open the parent to cancel or manage this child."
											: "Open the parent to continue or manage this child."}
									</output>
								)}
							</span>
							<button
								type="button"
								onClick={() =>
									void navigate({
										to: "/raven",
										search: {
											session: props.delegationParentSessionId ?? undefined,
											agent: undefined,
										},
									})
								}
								className="shrink-0 text-[9px] tracking-widest text-primary/70 uppercase hover:text-primary"
							>
								Open parent
							</button>
						</div>
					)}
					<RavenTerminalPane {...props} />
					<RavenMessagePane {...props} />
					{!interactiveMode && <RavenShellPane {...props} />}
					<ChatComposer
						{...composerProps}
						hideOnMobile={
							(terminalOpen && shellTab === "terminal") ||
							(previewActive && previewPaneOpen && shellTab === "preview")
						}
					/>
				</div>
				{preview && previewActive && previewPaneOpen && (
					<>
						{!previewMaximized && (
							<hr
								aria-orientation="vertical"
								aria-label="Resize Project Preview"
								aria-valuemin={360}
								aria-valuemax={2400}
								aria-valuenow={previewWidth}
								tabIndex={0}
								onPointerDown={beginPreviewResize}
								onKeyDown={(event) => {
									if (event.key === "ArrowLeft") {
										setPreviewWidth((width) => width + 24);
									} else if (event.key === "ArrowRight") {
										setPreviewWidth((width) => Math.max(360, width - 24));
									}
								}}
								className={`hidden md:block h-full w-1 shrink-0 cursor-col-resize border-0 border-l border-border/50 hover:bg-primary/20 focus:bg-primary/20 ${
									previewResizing ? "bg-primary/20" : ""
								}`}
							/>
						)}
						<ProjectPreviewPane
							preview={preview}
							maximized={previewMaximized}
							onToggleMaximize={() =>
								setPreviewMaximized((maximized) => !maximized)
							}
							onClose={() => {
								setPreviewMaximized(false);
								setPreviewPaneOpen(false);
								setShellTab("chat");
							}}
							className={`${
								previewMaximized
									? "fixed inset-0 z-50 flex"
									: `flex-1 md:flex-none ${
											shellTab === "preview" ? "flex" : "hidden md:flex"
										}`
							}${previewResizing ? " pointer-events-none select-none" : ""}`}
							style={previewMaximized ? undefined : { width: previewWidth }}
						/>
					</>
				)}
				{preview && previewActive && !previewPaneOpen && (
					<button
						type="button"
						onClick={() => setPreviewPaneOpen(true)}
						aria-label="Open Project Preview"
						title="Open Project Preview"
						className="hidden md:flex h-full w-9 shrink-0 items-center justify-center border-l border-border/50 text-muted-foreground/50 hover:text-primary"
					>
						<Monitor className="h-4 w-4" />
					</button>
				)}
			</div>
			{props.runtime.contextInspectorOpen && (
				<ContextInspectorDialog
					sessionId={props.session.sessionId}
					initialTarget={props.runtime.contextInspectorTarget}
					pending={{
						providerId: props.composerProps.activeProviderId,
						model: props.composerProps.activeModel ?? undefined,
						effort: props.composerProps.activeEffort ?? undefined,
						permissionMode:
							props.composerProps.activePermissionMode ?? undefined,
						agentCwd: props.session.agentSkillContext,
						skills: props.composerProps.activeSkills.flatMap((command) =>
							command.execution.kind === "skill"
								? [command.execution.filePath]
								: [],
						),
						attachments: [
							...props.composerProps.upload.pendingAttachments,
							...props.composerProps.vaultPicker.relicAttachments,
						].map((attachment) => ({
							filename: attachment.filename,
							mime: attachment.mime,
						})),
						vaultReferences: props.composerProps.vaultPicker.referencePaths,
						workspaceReferences:
							props.composerProps.vaultPicker.selectedWorkspace.map(
								(reference) => ({
									relativePath: reference.relativePath,
									mime: reference.mime,
									sha256: reference.sha256,
								}),
							),
						planMode: props.composerProps.planMode,
					}}
					onClose={props.runtime.closeContext}
				/>
			)}
			{props.runtime.fileRewindTurnId && (
				<FileRewindDialog
					result={props.runtime.fileRewindResult}
					pending={props.runtime.fileRewindPending}
					onExecute={props.runtime.executeFileRewind}
					onClose={props.runtime.closeFileRewind}
				/>
			)}
			{props.runtime.workflowManagerOpen && (
				<WorkflowManagerDialog
					messages={props.runtime.messages}
					sessionId={props.session.sessionId}
					providerId={props.composerProps.activeProviderId}
					hasOlderHistory={props.runtime.hasOlderHistory}
					isLoadingOlderHistory={props.runtime.isLoadingOlderHistory}
					savedWorkflows={
						props.runtime.workflowCatalogProviderId ===
							props.composerProps.activeProviderId &&
						(props.runtime.workflowCatalogAgentCwd ?? "") ===
							(props.session.agentSkillContext ?? "")
							? props.runtime.workflowCatalog.workflows
							: []
					}
					saveLocations={
						props.runtime.workflowCatalogProviderId ===
							props.composerProps.activeProviderId &&
						(props.runtime.workflowCatalogAgentCwd ?? "") ===
							(props.session.agentSkillContext ?? "")
							? props.runtime.workflowCatalog.locations
							: []
					}
					saveResult={props.runtime.workflowSaveResult}
					deleteResult={props.runtime.workflowDeleteResult}
					sourceResult={props.runtime.workflowSourceResult}
					onLoadOlderHistory={props.runtime.loadOlderHistory}
					onStop={(run) => {
						const taskId = run.workflow.taskId;
						if (!taskId) return;
						props.runtime.send({
							type: "workflow_control",
							action: "stop",
							task_id: taskId,
							session_id: props.session.sessionId,
						});
					}}
					onRunPrompt={(prompt) => {
						props.composerProps.handleSend(prompt);
						props.runtime.closeWorkflows();
					}}
					onSave={(run, scope, overwrite) => {
						const requestId = uid();
						const scriptPath = run.workflow.workflowScriptPath;
						if (!scriptPath) return requestId;
						props.runtime.setWorkflowSaveResult(null);
						props.runtime.send({
							type: "save_workflow",
							request_id: requestId,
							session_id: props.session.sessionId,
							source_script_path: scriptPath,
							scope,
							...(overwrite ? { overwrite: true } : {}),
						});
						return requestId;
					}}
					onDelete={(workflow) => {
						const requestId = uid();
						props.runtime.setWorkflowDeleteResult(null);
						props.runtime.send({
							type: "delete_workflow",
							request_id: requestId,
							session_id: props.session.sessionId,
							script_path: workflow.scriptPath,
							scope: workflow.scope,
						});
						return requestId;
					}}
					onReadSource={(scriptPath, scope) => {
						const requestId = uid();
						props.runtime.setWorkflowSourceResult(null);
						props.runtime.send({
							type: "read_workflow_source",
							request_id: requestId,
							session_id: props.session.sessionId,
							script_path: scriptPath,
							...(scope ? { scope } : {}),
						});
						return requestId;
					}}
					onRefreshSaved={props.runtime.refreshWorkflows}
					onClose={props.runtime.closeWorkflows}
				/>
			)}
		</LiveSessionSwitcher>
	);
}

/** Mobile-only Chat/Terminal/Preview switch. Desktop keeps split panes. */
function RavenShellTabBar({
	activeTab,
	setActiveTab,
	terminalOpen,
	previewOpen,
}: {
	activeTab: RavenPaneTab;
	setActiveTab: (tab: RavenPaneTab) => void;
	terminalOpen: boolean;
	previewOpen: boolean;
}) {
	return (
		<div className="md:hidden flex shrink-0 border-b border-border/40">
			<button
				type="button"
				onClick={() => setActiveTab("chat")}
				className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[10px] tracking-widest uppercase transition-colors ${
					activeTab === "chat"
						? "text-primary border-b border-primary"
						: "text-muted-foreground/40"
				}`}
			>
				<MessageSquare className="w-3.5 h-3.5" />
				chat
			</button>
			{terminalOpen && (
				<button
					type="button"
					onClick={() => setActiveTab("terminal")}
					className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[10px] tracking-widest uppercase transition-colors ${
						activeTab === "terminal"
							? "text-primary border-b border-primary"
							: "text-muted-foreground/40"
					}`}
				>
					<TerminalIcon className="w-3.5 h-3.5" />
					terminal
				</button>
			)}
			{previewOpen && (
				<button
					type="button"
					onClick={() => setActiveTab("preview")}
					className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[10px] tracking-widest uppercase transition-colors ${
						activeTab === "preview"
							? "text-primary border-b border-primary"
							: "text-muted-foreground/40"
					}`}
				>
					<Monitor className="w-3.5 h-3.5" />
					preview
				</button>
			)}
		</div>
	);
}

/**
 * Dev-shell pane — connects a real login shell (/ws/shell) only after it is
 * toggled on. While open, ordinary Raven/site navigation disconnects the
 * browser without terminating the server-side PTY. Returning to the chat
 * restores the open pane and reattaches to its buffered shell. Toggling the
 * terminal off keeps this component mounted for its inactive render so that
 * TerminalView can send the explicit terminate frame.
 */
function RavenShellPane({
	config,
	terminalOpen,
	terminalClosingSessionId,
	shellTab,
	session,
}: ChatPageContentProps) {
	const { agentSkillContext, sessionId } = session;
	if (!sessionId) return null;
	return (
		<div
			className={`${
				terminalOpen
					? shellTab === "terminal"
						? "flex md:flex"
						: "hidden md:flex"
					: "hidden"
			} md:order-last flex-1 md:flex-none md:h-64 overflow-hidden md:border-t md:border-border/40`}
		>
			<TerminalView
				sessionId={sessionId}
				cwd={agentSkillContext ?? config.vault.path}
				wsPath="/ws/shell"
				active={terminalOpen}
				terminateOnDisconnect={
					!terminalOpen && terminalClosingSessionId === sessionId
				}
			/>
		</div>
	);
}

function RavenTerminalPane({
	config,
	interactiveMode,
	session,
}: ChatPageContentProps) {
	const { agentSkillContext, sessionId, handleNewTerminalSession } = session;
	return (
		<>
			{/* Interactive mode badge — visible when running claude CLI directly */}
			{interactiveMode && (
				<div className="shrink-0 px-3 py-1.5 flex items-center gap-2 border-b border-border/50 bg-background/80">
					<TerminalIcon className="w-3 h-3 text-primary/60" />
					<span className="text-[9px] tracking-widest uppercase text-primary/60 font-medium">
						Interactive Mode
					</span>
					<span className="text-[9px] text-muted-foreground/40 ml-auto">
						Claude CLI · billing via Claude Code
					</span>
					<button
						type="button"
						onClick={handleNewTerminalSession}
						className="ml-2 text-muted-foreground/45 hover:text-muted-foreground transition-colors"
						aria-label="New terminal session"
					>
						<SquarePen className="w-3.5 h-3.5" />
					</button>
				</div>
			)}

			{/* Terminal mode: replace messages + input with full-height xterm.js view */}
			{interactiveMode && sessionId && (
				<div className="flex-1 overflow-hidden">
					<TerminalView
						sessionId={sessionId}
						cwd={agentSkillContext ?? config.vault.path}
						active={true}
						onNewSession={handleNewTerminalSession}
					/>
				</div>
			)}
		</>
	);
}

function RavenMessagePane({
	config,
	interactiveMode,
	terminalOpen,
	shellTab,
	session,
	runtime,
	chatQueue,
	viewport,
	actions,
	composerProps,
}: ChatPageContentProps) {
	const { sessionId } = session;
	const { wsStatus, sessionState, runningTurnId, messages, send } = runtime;
	const { scrollRef, bottomRef, transcriptContentRef } = viewport;
	const {
		handleDecide,
		handleSubmitAnswers,
		handlePlanDecide,
		handleCancelQueued,
		handlePromoteQueued,
		handleSteerQueued,
	} = actions;
	const handleLoadOlderHistory = useCallback(async () => {
		return loadOlderPreservingScroll(
			scrollRef.current,
			runtime.loadOlderHistory,
		);
	}, [runtime.loadOlderHistory, scrollRef]);
	const obsidianCapture = useMemo(
		() => configuredObsidianCapture(config.vault),
		[config.vault],
	);
	const {
		fork: forkFromMessage,
		forkingMessageId,
		forkError,
		dismissForkError,
	} = useForkSession(sessionId);
	const handleBranch = useCallback(
		(dbId: number) => void forkFromMessage(dbId),
		[forkFromMessage],
	);
	// Same preconditions as the composer's whole-session Fork button — see
	// ChatActionButtons.
	const canBranch =
		composerProps.providers.find(
			(provider) => provider.id === composerProps.activeProviderId,
		)?.forkCapability?.throughMessage === true &&
		!runtime.isRunning &&
		!isRavenLiveInteractionLocked(composerProps.voice.livePhase);
	const canSteerQueued =
		runtime.isRunning &&
		(isClaudeRuntimeProvider(composerProps.activeProviderId) ||
			isCodexRuntimeProvider(composerProps.activeProviderId));
	const canPreviewFileRewind =
		isClaudeRuntimeProvider(composerProps.activeProviderId) &&
		!runtime.isRunning;
	const canBackgroundTools =
		runtime.isRunning &&
		providerBackgroundOperationAvailable(
			composerProps.providers,
			composerProps.activeProviderId,
			"background",
		);
	const handleBackgroundTools = useCallback(() => {
		send({
			type: "background_activity_control",
			action: "background",
			session_id: sessionId,
		});
	}, [send, sessionId]);
	// Below md, the Terminal tab fully replaces chat (RavenShellTabBar); md+
	// always shows chat regardless (desktop split panel is chunk 4).
	const mobileHideChat = terminalOpen && shellTab === "terminal";
	return (
		<>
			{/* Messages, inner min-h-full + justify-end anchors messages to bottom */}
			{!interactiveMode && (
				<>
					{forkError && (
						<div
							role="alert"
							className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive shrink-0"
						>
							{forkError}
							<button
								type="button"
								onClick={dismissForkError}
								aria-label="Dismiss"
								className="text-destructive/60 hover:text-destructive shrink-0"
							>
								<X className="h-3 w-3" />
							</button>
						</div>
					)}
					<div
						ref={scrollRef}
						data-scroll-restoration-id={
							ROUTE_SCROLL_RESTORATION_IDS.ravenTranscript
						}
						className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden ${
							mobileHideChat ? "hidden md:block" : ""
						}`}
					>
						<div
							ref={transcriptContentRef}
							className="min-h-full flex flex-col justify-end px-5 pt-2 pb-2 min-w-0 md:pb-7"
						>
							{messages.length === 0 ? (
								<div className="flex-1 flex flex-col items-center justify-center gap-3">
									<div className="text-2xl font-bold tracking-widest text-foreground/20 uppercase select-none">
										{wsStatus !== "connected"
											? "CONNECTING"
											: "THE WATCHER LISTENS"}
									</div>
									{wsStatus === "connected" && config.ui.enter_to_submit && (
										<div className="hidden text-[9px] tracking-[0.35em] text-muted-foreground/35 md:block [@media(pointer:coarse)]:hidden">
											↵ send · ⇧↵ newline
										</div>
									)}
								</div>
							) : (
								<MessageList
									messages={messages}
									chatQueue={chatQueue}
									sessionId={sessionId}
									providerId={composerProps.activeProviderId}
									sessionState={sessionState}
									runningTurnId={runningTurnId}
									hasOlderHistory={runtime.hasOlderHistory}
									isLoadingOlderHistory={runtime.isLoadingOlderHistory}
									onLoadOlderHistory={handleLoadOlderHistory}
									onLoadEarlierToolEvents={runtime.loadEarlierToolEvents}
									handleDecide={handleDecide}
									handleSubmitAnswers={handleSubmitAnswers}
									handlePlanDecide={handlePlanDecide}
									handleCancelQueued={handleCancelQueued}
									handlePromoteQueued={handlePromoteQueued}
									handleSteerQueued={handleSteerQueued}
									onViewContext={runtime.openContext}
									onPreviewFileRewind={
										canPreviewFileRewind ? runtime.previewFileRewind : undefined
									}
									onBackgroundActivity={
										canBackgroundTools ? handleBackgroundTools : undefined
									}
									canSteerQueued={canSteerQueued}
									bottomRef={bottomRef}
									canBranch={canBranch}
									forkingMessageId={
										typeof forkingMessageId === "number"
											? forkingMessageId
											: null
									}
									onBranch={handleBranch}
									obsidianCapture={obsidianCapture}
								/>
							)}
						</div>
					</div>
				</>
			)}
		</>
	);
}

interface BadgeOption {
	value: string;
	label: string;
	title?: string;
	isDefault?: boolean;
}

/**
 * One labelled option list inside the session settings popup. Model, effort,
 * provider mode, permission, and reviewer controls share this compact markup.
 */
function OptionGroup({
	label,
	options,
	selectedValue,
	onSelect,
	divider = false,
	disabled = false,
	status,
}: {
	label: string;
	options: BadgeOption[];
	selectedValue: string | null | undefined;
	onSelect: (value: string) => void;
	divider?: boolean;
	disabled?: boolean;
	status?: {
		label: string;
		loading?: boolean;
		actionLabel?: string;
		onAction?: () => void;
	};
}) {
	if (options.length === 0 && !status) return null;
	return (
		<div
			className={`space-y-1${divider ? " pt-1 border-t border-border/50" : ""}`}
		>
			<div className="text-muted-foreground/40">{label}</div>
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					title={o.title}
					disabled={disabled}
					onClick={() => onSelect(o.value)}
					className={`block w-full text-left normal-case tracking-normal px-1.5 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
						o.value === selectedValue
							? "text-primary bg-primary/10"
							: "text-foreground/70 hover:bg-accent"
					}`}
				>
					{o.label}
					{o.isDefault ? " (default)" : ""}
				</button>
			))}
			{status && (
				<output
					aria-label={status.label}
					aria-live="polite"
					className="flex items-center gap-1.5 px-1.5 py-1 normal-case tracking-normal text-muted-foreground/60"
				>
					{status.loading && (
						<LoaderCircle
							aria-hidden
							className="h-3 w-3 shrink-0 animate-spin"
						/>
					)}
					<span>{status.label}</span>
					{status.actionLabel && status.onAction && (
						<button
							type="button"
							disabled={disabled}
							onClick={status.onAction}
							className="ml-auto text-primary/70 hover:text-primary disabled:opacity-40"
						>
							{status.actionLabel}
						</button>
					)}
				</output>
			)}
		</div>
	);
}

function ChatModelBadge({
	config,
	sessionPersisted,
	session,
	runtime,
	voice,
	viewport,
	showModelPopup,
	setShowModelPopup,
	modelShort,
	activeModel,
	activeEffort,
	activePermissionMode,
	activeApprovalsReviewer,
	selectSessionControls,
	selectSessionProvider,
	actualModelShort,
	modelMismatch,
	actualSelectionMismatch,
	activeProviderId,
	activeProviderLabel,
	configuredProviderLabel,
	configuredModelShort,
	configuredSelection,
	providers,
	modelPickerOptions,
	permissionOptions,
	approvalsReviewerOptions,
	approvalsReviewerUnavailableReason,
	effortOptions,
	providerModeOptions,
	activeProviderMode,
	acpModelCatalogStatus,
	retryAcpModelCatalog,
}: ChatComposerProps) {
	const {
		wsStatus,
		model,
		permissionMode,
		approvalsReviewer,
		effort,
		sessionState,
		send,
	} = runtime;
	const { sessionId } = session;
	const notificationSessionId =
		session.liveSessionStatus?.db_session_id ??
		(sessionPersisted ? sessionId : null);
	const displayedModel = activeModel ?? model;
	const liveActive = isRavenLiveInteractionLocked(voice.livePhase);
	const displayedEffort = activeProviderId.startsWith("acp:")
		? activeEffort
		: (activeEffort ?? effort);
	const displayedPermissionMode = activePermissionMode ?? permissionMode;
	const displayedApprovalsReviewer =
		approvalsReviewerOptions.length > 0
			? (activeApprovalsReviewer ?? approvalsReviewer)
			: null;
	const permissionBadge = permissionModeBadgeLabel(displayedPermissionMode);
	const approvalsReviewerBadge =
		displayedApprovalsReviewer === "auto_review" ? "auto-review" : null;
	const providerModeBadge = providerModeOptions.find(
		(option) => option.value === activeProviderMode,
	)?.label;
	// The primary badge is a control: it must show what the next turn will use.
	// Provider-reported history remains visible below as a diagnostic.
	const rawModelBadge = modelShort ?? actualModelShort;
	const duplicateEffortSuffix = displayedEffort ? `(${displayedEffort})` : null;
	const modelBadge =
		rawModelBadge &&
		duplicateEffortSuffix &&
		rawModelBadge.toLowerCase().endsWith(duplicateEffortSuffix.toLowerCase())
			? rawModelBadge.slice(0, -duplicateEffortSuffix.length)
			: rawModelBadge;
	const badgeParts = [
		activeProviderLabel,
		modelBadge,
		displayedEffort,
		providerModeBadge,
		permissionBadge,
		approvalsReviewerBadge,
	].filter(Boolean);
	const compactBadgeParts = [
		isCliProxyProvider(activeProviderId) ? "CLIProxy" : activeProviderLabel,
		modelBadge,
		displayedEffort,
		providerModeBadge,
		permissionBadge,
		approvalsReviewerBadge,
	].filter(Boolean);
	const { modelBadgeRef } = viewport;
	const popupRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (liveActive && showModelPopup) {
			setShowModelPopup(false);
			return;
		}
		if (showModelPopup) popupRef.current?.focus();
	}, [liveActive, setShowModelPopup, showModelPopup]);
	return (
		<>
			{activeProviderLabel && (
				<div
					ref={modelBadgeRef}
					className="relative z-10 mx-3 mt-px mb-1 min-w-0 md:absolute md:-top-5 md:right-3 md:mx-0 md:my-0 md:max-w-[calc(100vw-1.5rem)]"
				>
					<button
						type="button"
						disabled={liveActive}
						aria-haspopup="dialog"
						aria-expanded={showModelPopup}
						aria-label={`${badgeParts.join(" · ")} · Open session model and notification settings`}
						onClick={(e) => {
							e.stopPropagation();
							setShowModelPopup((v) => !v);
						}}
						title={
							liveActive
								? "Stop Raven Live to change the session model"
								: undefined
						}
						className={`block min-h-7 w-full max-w-full px-2 py-1 text-[10px] tracking-widest uppercase bg-background border cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-40 md:min-h-0 md:w-auto md:py-0.5 md:text-[9px] ${
							modelMismatch
								? "text-status-warning/80 border-status-warning/60"
								: "text-muted-foreground/50 border-border/70 hover:text-foreground/70 hover:border-primary/40"
						}`}
					>
						<span
							aria-hidden
							className="block md:hidden truncate whitespace-nowrap"
						>
							{compactBadgeParts.join(" · ")}
						</span>
						<span aria-hidden className="hidden md:block whitespace-nowrap">
							{badgeParts.join(" · ")}
						</span>
					</button>
					{showModelPopup && (
						<div
							ref={popupRef}
							tabIndex={-1}
							role="dialog"
							aria-label="Session model and notification settings"
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									setShowModelPopup(false);
								}
							}}
							className="absolute bottom-full right-0 mb-1.5 w-56 max-w-[calc(100vw-1.5rem)] max-h-72 overflow-y-auto bg-background border border-border px-3 py-2 text-[9px] tracking-widest uppercase space-y-2 focus:outline-none"
						>
							{modelMismatch && (
								<div className="space-y-0.5 pb-2 border-b border-border/50">
									<div>
										<span className="text-muted-foreground/50">
											configured{" "}
										</span>
										<span className="text-foreground/60">
											{configuredProviderLabel}
											{configuredModelShort ? ` · ${configuredModelShort}` : ""}
										</span>
									</div>
									<div>
										<span className="text-muted-foreground/50">selected </span>
										<span className="text-status-warning">
											{activeProviderLabel}
											{modelShort || actualModelShort
												? ` · ${modelShort ?? actualModelShort}`
												: ""}
										</span>
									</div>
									{actualSelectionMismatch && actualModelShort && (
										<div>
											<span className="text-muted-foreground/50">
												last used{" "}
											</span>
											<span className="text-foreground/60">
												{actualModelShort}
											</span>
										</div>
									)}
								</div>
							)}
							<OptionGroup
								label="cli"
								disabled={wsStatus !== "connected" || liveActive}
								options={providers
									.filter(
										(provider) =>
											provider.available &&
											(sessionState !== "running" ||
												provider.id === activeProviderId),
									)
									.map((provider) => ({
										value: provider.id,
										label: provider.label,
									}))}
								selectedValue={activeProviderId}
								onSelect={(value) => {
									if (value === activeProviderId) return;
									const provider = providers.find(
										(candidate) => candidate.id === value,
									);
									if (!provider) return;
									const next = value.startsWith("acp:")
										? { providerId: provider.id, model: "" }
										: defaultSelectionForProvider(
												provider,
												configuredSelection,
												config,
											);
									const delivered = send({
										type: "set_provider",
										provider: value,
										session_id: sessionId,
										...(next.model ? { model: next.model } : {}),
										...(next.effort ? { effort: next.effort } : {}),
										...(next.permissionMode
											? { permission_mode: next.permissionMode }
											: {}),
										...(next.approvalsReviewer
											? { approvals_reviewer: next.approvalsReviewer }
											: {}),
									});
									if (!delivered) return;
									selectSessionProvider(next);
									wsStore.seedActualModel(null);
								}}
							/>
							<OptionGroup
								label="model"
								divider
								disabled={wsStatus !== "connected" || liveActive}
								options={modelPickerOptions.map((m) => ({
									value: m.value,
									label: m.label,
									...(m.description !== undefined
										? { title: m.description }
										: {}),
									...(m.isDefault !== undefined
										? { isDefault: m.isDefault }
										: {}),
								}))}
								selectedValue={displayedModel ?? ""}
								status={
									acpModelCatalogStatus === "loading"
										? {
												label: `Loading ${activeProviderLabel} models…`,
												loading: true,
											}
										: acpModelCatalogStatus === "failed"
											? {
													label:
														modelPickerOptions.length > 1
															? "Showing cached models"
															: "Models unavailable",
													actionLabel: "Retry",
													onAction: retryAcpModelCatalog,
												}
											: undefined
								}
								onSelect={(value) => {
									const delivered = send({
										type: "set_model",
										...(value ? { model: value } : {}),
										session_id: sessionId,
									});
									if (!delivered) return;
									selectSessionControls({ model: value });
									wsStore.seedActualModel(null);
								}}
							/>
							<OptionGroup
								label="effort"
								divider
								disabled={wsStatus !== "connected" || liveActive}
								options={effortOptions.map((e) => ({
									value: e.value,
									label: e.label,
									...(e.desc !== undefined ? { title: e.desc } : {}),
									...(e.isDefault !== undefined
										? { isDefault: e.isDefault }
										: {}),
								}))}
								selectedValue={displayedEffort}
								onSelect={(value) => {
									const delivered = send({
										type: "set_effort",
										effort: value,
										session_id: sessionId,
									});
									if (!delivered) return;
									selectSessionControls({ effort: value });
								}}
							/>
							<OptionGroup
								label="mode"
								divider
								disabled={wsStatus !== "connected" || liveActive}
								options={providerModeOptions.map((mode) => ({
									value: mode.value,
									label: mode.label,
									...(mode.desc !== undefined ? { title: mode.desc } : {}),
									...(mode.isDefault !== undefined
										? { isDefault: mode.isDefault }
										: {}),
								}))}
								selectedValue={activeProviderMode}
								onSelect={(value) => {
									const delivered = send({
										type: "set_provider_mode",
										mode: value,
										session_id: sessionId,
									});
									if (!delivered) return;
								}}
							/>
							<OptionGroup
								label="permission"
								divider
								disabled={wsStatus !== "connected" || liveActive}
								options={permissionOptions.map((p) => ({
									value: p.value,
									label: p.label,
									...(p.desc !== undefined ? { title: p.desc } : {}),
								}))}
								selectedValue={displayedPermissionMode}
								onSelect={(value) => {
									const delivered = send({
										type: "set_permission_mode",
										mode: value,
										session_id: sessionId,
									});
									if (!delivered) return;
									selectSessionControls({ permissionMode: value });
								}}
							/>
							<OptionGroup
								label="approval reviewer"
								divider
								disabled={wsStatus !== "connected" || liveActive}
								options={approvalsReviewerOptions.map((reviewer) => ({
									value: reviewer.value,
									label: reviewer.label,
									...(reviewer.desc !== undefined
										? { title: reviewer.desc }
										: {}),
									...(reviewer.isDefault !== undefined
										? { isDefault: reviewer.isDefault }
										: {}),
								}))}
								selectedValue={displayedApprovalsReviewer}
								onSelect={(value) => {
									if (value !== "user" && value !== "auto_review") return;
									const delivered = send({
										type: "set_approvals_reviewer",
										reviewer: value,
										session_id: sessionId,
									});
									if (!delivered) return;
									selectSessionControls({ approvalsReviewer: value });
								}}
							/>
							{approvalsReviewerUnavailableReason && (
								<div className="normal-case tracking-normal text-muted-foreground/40">
									{approvalsReviewerUnavailableReason}
								</div>
							)}
							{displayedApprovalsReviewer === "auto_review" &&
								!approvalsReviewerUnavailableReason && (
									<div className="normal-case tracking-normal text-muted-foreground/40">
										Codex does not expose Auto-review token usage, so Ledger
										excludes it.
									</div>
								)}
							{notificationSessionId && (
								<SessionNotificationOverrideControl
									sessionId={notificationSessionId}
								/>
							)}
							<div className="normal-case tracking-normal text-muted-foreground/30 pt-1 border-t border-border/50">
								session only — not saved to config
							</div>
						</div>
					)}
				</div>
			)}
		</>
	);
}

function ChatInputArea(props: ChatComposerProps) {
	const { dragOver, setDragOver, upload } = props;
	const { uploadFiles } = upload;
	if (props.delegationSteering) {
		return (
			<div className="relative border-t border-border bg-background">
				<div className="flex min-w-0 items-start">
					<LiveSessionToggle />
					<ChatTextarea {...props} />
					<button
						type="button"
						onClick={props.handleSteerDelegatedChild}
						disabled={!props.canSteerDelegatedChild}
						className="min-h-11 self-start shrink-0 px-4 py-2 text-[10px] font-bold tracking-widest text-primary/70 uppercase transition-colors hover:text-primary disabled:text-muted-foreground/35 md:min-h-0 md:py-3"
						aria-label="Steer current child"
						title={
							props.delegatedNativeSteeringAvailable
								? "Append this instruction to the active native provider turn"
								: props.runtime.isRunning
									? "This provider does not support native steering"
									: "This child does not have an active provider turn"
						}
					>
						STEER
					</button>
				</div>
			</div>
		);
	}
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop zone wraps the input, interactive children handle keyboard input
		<div
			className={`relative border-t border-border bg-background transition-colors ${
				dragOver ? "bg-primary/5" : ""
			}`}
			onDragEnter={(e) => {
				if (e.dataTransfer?.types?.includes("Files")) {
					e.preventDefault();
					setDragOver(true);
				}
			}}
			onDragOver={(e) => {
				if (e.dataTransfer?.types?.includes("Files")) {
					e.preventDefault();
				}
			}}
			onDragLeave={(e) => {
				if (e.currentTarget === e.target) setDragOver(false);
			}}
			onDrop={(e) => {
				if (e.dataTransfer?.files?.length) {
					e.preventDefault();
					setDragOver(false);
					void uploadFiles(e.dataTransfer.files);
				}
			}}
		>
			<ChatInputNotices {...props} />
			<ChatInputControls {...props} />
		</div>
	);
}

function ChatInputNotices({
	savedSession,
	config,
	agentList,
	providers,
	session,
	runtime,
	upload,
	voice,
	planMode,
	setPlanMode,
	planHtml,
	setPlanHtml,
	terminalOpen,
	onToggleTerminal,
	activeProviderId,
	activePermissionMode,
	permissionOptions,
	activeEffort,
	selectSessionControls,
	providerPlanModeValue,
	activeSkills,
	clearActiveSkill,
	vaultPicker,
}: ChatComposerProps) {
	const { agentSkillContext, selectAgent, sessionId } = session;
	const { messages, effort, permissionMode, send } = runtime;
	const {
		pendingAttachments,
		uploadingCount,
		uploadError,
		gitignoreHint,
		removePending,
		dismissGitignoreHint,
	} = upload;
	const [appsOpen, setAppsOpen] = useState(false);
	const activeProvider = providers.find(
		(provider) => provider.id === activeProviderId,
	);
	const savedAutoNeedsRecheck =
		savedSession &&
		!session.liveSessionStatus &&
		activeProviderId === "claude" &&
		(activePermissionMode ?? permissionMode) === "auto" &&
		!permissionOptions.some((option) => option.value === "auto");
	return (
		<>
			<ActiveCommandBadges commands={activeSkills} onClear={clearActiveSkill} />
			<VaultReferenceBadges
				references={vaultPicker.selected}
				onRemove={vaultPicker.remove}
			/>
			<WorkspaceReferenceBadges
				references={vaultPicker.selectedWorkspace}
				onRemove={vaultPicker.removeWorkspace}
			/>
			{gitignoreHint && (
				<div className="px-4 py-2 flex items-start gap-2 border-b border-border/40 bg-status-info/5">
					<div className="flex-1 text-[10px] text-foreground/70 leading-relaxed">
						<span className="text-status-info/80">tip:</span> attachments stored
						at{" "}
						<code className="text-[10px] font-mono text-foreground/90">
							{gitignoreHint.agent_root}/.hlid/
						</code>
						. Add{" "}
						<code className="text-[10px] font-mono text-foreground/90">
							.hlid/
						</code>{" "}
						to <code className="text-[10px] font-mono">.gitignore</code> if this
						is a git repo.
					</div>
					<button
						type="button"
						onClick={dismissGitignoreHint}
						className="text-muted-foreground/40 hover:text-foreground transition-colors shrink-0"
						aria-label="Dismiss"
					>
						<X className="w-3 h-3" />
					</button>
				</div>
			)}
			<AttachmentStrip
				attachments={[...pendingAttachments, ...vaultPicker.relicAttachments]}
				uploadingCount={uploadingCount}
				uploadError={uploadError}
				onRemove={(id) => {
					if (vaultPicker.selectedRelics.some((relic) => relic.id === id)) {
						vaultPicker.removeRelic(id);
					} else {
						removePending(id);
					}
				}}
			/>
			{voice.error && (
				<div
					className="px-4 py-2 flex items-start gap-3 border-b border-destructive/30 bg-destructive/5"
					role="alert"
				>
					<div className="flex-1 text-[10px] text-destructive/80 leading-relaxed">
						{voice.errorLabel}: {voice.error}
					</div>
					<button
						type="button"
						onClick={voice.clearError}
						className="text-destructive/50 hover:text-destructive transition-colors shrink-0"
						aria-label="Dismiss voice error"
					>
						<X className="w-3 h-3" />
					</button>
				</div>
			)}
			{isRavenLiveInteractionLocked(voice.livePhase) && (
				<div className="flex items-center gap-3 px-4 py-1 border-b border-primary/20 bg-primary/5 text-primary/80">
					<output className="min-w-0 flex-1 text-[10px] leading-relaxed">
						Raven Live ·{" "}
						{voice.livePhase === "starting"
							? "connecting…"
							: voice.livePhase === "stopping"
								? "stopping…"
								: voice.liveMicrophoneMuted
									? "microphone muted"
									: "listening…"}
					</output>
					{voice.livePhase === "connected" && (
						<button
							type="button"
							onClick={voice.toggleLiveMicrophone}
							aria-pressed={voice.liveMicrophoneMuted}
							aria-label={
								voice.liveMicrophoneMuted
									? "Unmute Raven Live microphone"
									: "Mute Raven Live microphone"
							}
							title={
								voice.liveMicrophoneMuted
									? "Unmute Raven Live microphone"
									: "Mute Raven Live microphone"
							}
							className="min-h-10 px-3 inline-flex shrink-0 items-center gap-1.5 border border-primary/25 bg-background/60 text-[10px] text-primary hover:bg-primary/10 transition-colors"
						>
							{voice.liveMicrophoneMuted ? (
								<MicOff className="w-3.5 h-3.5" />
							) : (
								<Mic className="w-3.5 h-3.5" />
							)}
							{voice.liveMicrophoneMuted ? "Unmute" : "Mute"}
						</button>
					)}
				</div>
			)}
			{savedAutoNeedsRecheck ? (
				<div
					role="note"
					aria-label={CLAUDE_SAVED_AUTO_RECHECK_NOTICE}
					className="px-4 py-1.5 border-b border-status-info/20 bg-status-info/5 text-[10px] text-foreground/65 leading-relaxed"
				>
					{CLAUDE_SAVED_AUTO_RECHECK_NOTICE}
				</div>
			) : (
				activeProviderId === "claude" &&
				(activePermissionMode ?? permissionMode) === "auto" && (
					<div
						role="note"
						aria-label={CLAUDE_AUTO_ACCOUNTING_DISCLOSURE}
						className="px-4 py-1.5 border-b border-status-info/20 bg-status-info/5 text-[10px] text-foreground/65 leading-relaxed"
					>
						{CLAUDE_AUTO_ACCOUNTING_DISCLOSURE}
					</div>
				)
			)}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5 border-b border-border/40">
				{messages.length === 0 && agentList.length > 0 && (
					<div className="flex min-w-0 w-full items-center gap-3 md:w-auto md:flex-1">
						<AgentSelect
							agents={agentList}
							value={agentSkillContext ?? ""}
							fullWidth
							onChange={(val) => {
								selectAgent(val || undefined);
							}}
						/>
					</div>
				)}
				<div className="flex w-full min-w-0 items-center justify-end gap-2 md:w-auto md:gap-3">
					<McpIndicator
						servers={runtime.mcpServers}
						align="mobile-left"
						openSignal={runtime.mcpOpenSignal}
						operations={runtime.mcpOperations}
						pendingControl={runtime.mcpPendingControl}
						controlError={runtime.mcpControlError}
						controlNotice={runtime.mcpControlNotice}
						controlHint={
							isClaudeRuntimeProvider(activeProviderId)
								? "Native reconnect and toggle become available while this Claude session is live."
								: undefined
						}
						permissionOverrideHint={
							isClaudeRuntimeProvider(activeProviderId)
								? config.umbod?.enabled
									? "Hlid policy enforcement owns MCP approvals for this session, so Claude's native per-server override is inactive."
									: !["auto", "bypassPermissions"].includes(
												activePermissionMode ?? permissionMode ?? "",
											)
										? "Per-server Claude approval becomes available when this live session uses Auto or bypass."
										: undefined
								: undefined
						}
						onControl={runtime.controlMcp}
						label={`MCP runtime · ${
							agentList.find((agent) => agent.path === agentSkillContext)
								?.name ??
							config.vault.name ??
							"Vault"
						}`}
					/>
					{activeProvider?.capabilities?.appCatalog && (
						<button
							type="button"
							onClick={() => setAppsOpen(true)}
							title={`Inspect ${activeProvider.label} Apps and connectors`}
							className="flex shrink-0 items-center gap-1.5 text-[9px] tracking-widest text-muted-foreground/40 uppercase transition-colors hover:text-muted-foreground/70"
						>
							<Blocks className="h-3 w-3" />
							apps
						</button>
					)}
					<button
						type="button"
						onClick={() => {
							const enabling = !planMode;
							if (providerPlanModeValue) {
								const delivered = enabling
									? send({
											type: "set_provider_mode",
											mode: providerPlanModeValue,
											session_id: sessionId,
										})
									: send({
											type: "restore_provider_mode",
											session_id: sessionId,
										});
								if (!delivered) return;
							}
							if (enabling) {
								const normalized = normalizeEffortForPlanMode(
									activeProviderId,
									activeEffort ?? effort,
								);
								if (normalized && normalized !== (activeEffort ?? effort)) {
									const delivered = send({
										type: "set_effort",
										effort: normalized,
										session_id: sessionId,
									});
									if (delivered) {
										selectSessionControls({ effort: normalized });
									}
								}
							}
							if (!providerPlanModeValue) setPlanMode(enabling);
						}}
						title={
							activeProviderId === "codex"
								? "Enable plan mode — Codex plans at up to X-High effort"
								: "Enable plan mode — the agent plans before acting"
						}
						className={`flex items-center gap-1.5 text-[9px] tracking-widest uppercase transition-colors shrink-0 ${
							planMode
								? "text-primary border-b border-primary/50"
								: "text-muted-foreground/40 hover:text-muted-foreground/70"
						}`}
					>
						<ShieldCheck className="w-3 h-3" />
						plan
					</button>
					{planMode && (
						<button
							type="button"
							onClick={() => setPlanHtml((v) => !v)}
							title="Render the plan as a styled HTML page shown in a modal"
							className={`flex items-center gap-1.5 text-[9px] tracking-widest uppercase transition-colors shrink-0 ${
								planHtml
									? "text-primary border-b border-primary/50"
									: "text-muted-foreground/40 hover:text-muted-foreground/70"
							}`}
						>
							<FileCode className="w-3 h-3" />
							html
						</button>
					)}
					<button
						type="button"
						onClick={onToggleTerminal}
						title="Open a real terminal in this project — for running dev servers or recovering from things the agent can't fix"
						className={`flex items-center gap-1.5 text-[9px] tracking-widest uppercase transition-colors shrink-0 ${
							terminalOpen
								? "text-primary border-b border-primary/50"
								: "text-muted-foreground/40 hover:text-muted-foreground/70"
						}`}
					>
						<TerminalIcon className="w-3 h-3" />
						terminal
					</button>
				</div>
			</div>
			{appsOpen && activeProvider?.capabilities?.appCatalog && (
				<ProviderAppsDialog
					providerId={activeProvider.id}
					providerLabel={activeProvider.label}
					cwd={agentSkillContext ?? config.vault.path}
					sessionId={sessionId}
					onClose={() => setAppsOpen(false)}
				/>
			)}
		</>
	);
}

function ChatInputControls(props: ChatComposerProps) {
	const { runtime, upload, viewport } = props;
	const { wsStatus } = runtime;
	const { uploadFiles } = upload;
	const { fileInputRef } = viewport;
	const sessionFork = useChatSessionFork(props);
	return (
		<div className="flex min-w-0 items-start">
			<LiveSessionToggle />
			<div className="grid shrink-0 grid-cols-2 gap-y-1 md:contents">
				<input
					ref={fileInputRef}
					type="file"
					multiple
					className="hidden"
					onChange={(e) => {
						if (e.target.files) void uploadFiles(e.target.files);
						e.target.value = "";
					}}
				/>
				<button
					type="button"
					onClick={() => fileInputRef.current?.click()}
					disabled={wsStatus !== "connected"}
					className="px-2 py-2 md:py-3 text-muted-foreground/45 hover:text-muted-foreground transition-colors shrink-0 disabled:opacity-30"
					aria-label="Attach file"
					title="Attach file"
				>
					<Paperclip className="w-3.5 h-3.5" />
				</button>
				<ObsidianActiveNoteButton
					onAdd={props.vaultPicker.addVaultReference}
					className="px-2 py-2 md:py-3"
				/>
				<ChatVoiceControls {...props} />
				{sessionFork.canFork && (
					<button
						type="button"
						onClick={() => sessionFork.fork()}
						disabled={sessionFork.forking}
						className="px-2 py-2 md:py-3 text-muted-foreground/45 hover:text-muted-foreground disabled:opacity-40 transition-colors shrink-0"
						aria-label="Fork session"
						title="Fork this session into a new one"
					>
						{sessionFork.forking ? (
							<LoaderCircle className="w-3.5 h-3.5 animate-spin" />
						) : (
							<GitFork className="w-3.5 h-3.5" />
						)}
					</button>
				)}
			</div>
			<ChatTextarea {...props} />
			<ChatActionButtons {...props} sessionFork={sessionFork} />
		</div>
	);
}

function ChatVoiceControls(props: ChatVoiceControlsProps) {
	const { config, runtime, voice } = props;
	const { wsStatus, isRunning } = runtime;
	const starting = voice.phase === "starting";
	const processing =
		voice.phase === "transcribing" || voice.phase === "submitting";
	const { actionLabel, title } = voiceInputPresentation({
		enabled: config.voice.enabled,
		engine: voice.engine,
		ready: voice.ready,
		unavailableReason: voice.unavailableReason,
		localState: voice.status.state,
		hotkey: config.voice.hotkey,
	});
	const liveActive = isRavenLiveInteractionLocked(voice.livePhase);
	return (
		<>
			<button
				type="button"
				onClick={() => {
					if (starting) return;
					if (voice.phase === "recording") voice.stop();
					else void voice.start();
				}}
				onFocus={voice.refresh}
				disabled={
					wsStatus !== "connected" ||
					starting ||
					(!voice.ready && voice.phase !== "recording") ||
					processing ||
					liveActive
				}
				className={`px-2 py-2 md:py-3 transition-colors shrink-0 disabled:opacity-30 ${voice.phase === "recording" ? "text-destructive" : starting ? "text-primary" : "text-muted-foreground/45 hover:text-muted-foreground"}`}
				aria-label={
					starting
						? "Connecting Codex dictation"
						: voice.phase === "recording"
							? "Stop recording"
							: actionLabel
				}
				title={starting ? "Connecting Codex dictation" : title}
			>
				{starting ? (
					<LoaderCircle className="w-3.5 h-3.5 animate-spin" />
				) : voice.phase === "recording" ? (
					<Square className="w-3.5 h-3.5 fill-current" />
				) : (
					<Mic className="w-3.5 h-3.5" />
				)}
			</button>
			{(starting || voice.phase === "recording") && (
				<button
					type="button"
					onClick={voice.cancel}
					className="px-2 py-2 md:py-3 text-muted-foreground/45 hover:text-muted-foreground transition-colors shrink-0"
					aria-label={starting ? "Cancel Codex dictation" : "Cancel recording"}
					title={starting ? "Cancel Codex dictation" : "Cancel recording"}
				>
					<X className="w-3.5 h-3.5" />
				</button>
			)}
			{config.voice.codex_live_mode && (
				<button
					type="button"
					onClick={() =>
						liveActive ? voice.stopLive() : void voice.startLive()
					}
					disabled={
						wsStatus !== "connected" ||
						props.activeProviderId !== "codex" ||
						isRunning ||
						voice.livePhase === "stopping" ||
						voice.liveUnavailable !== null
					}
					className={`px-2 py-2 md:py-3 transition-colors shrink-0 disabled:opacity-30 ${
						liveActive
							? "text-primary"
							: "text-muted-foreground/45 hover:text-muted-foreground"
					}`}
					aria-label={
						voice.livePhase === "stopping"
							? "Stopping Raven Live"
							: liveActive
								? "Stop Raven Live"
								: "Start Raven Live"
					}
					title={
						props.activeProviderId !== "codex"
							? "Raven Live requires a native Codex session"
							: voice.liveUnavailable
								? voice.liveUnavailable
								: voice.livePhase === "stopping"
									? "Waiting for Raven Live to finish"
									: isRunning
										? "Wait for the current turn to finish"
										: liveActive
											? "Stop Raven Live"
											: "Start Raven Live"
					}
				>
					{liveActive ? (
						<Square className="w-3.5 h-3.5 fill-current" />
					) : (
						<Headphones className="w-3.5 h-3.5" />
					)}
				</button>
			)}
		</>
	);
}

function handleComposerKeyDown(
	event: ReactKeyboardEvent<HTMLTextAreaElement>,
	props: ChatComposerProps,
): void {
	const {
		config,
		picker,
		vaultPicker,
		handleSkillSelect,
		handleSend,
		viewport,
	} = props;
	const vaultPickerOpen = vaultPicker.isOpen;
	const action = composerKeyAction({
		key: event.key,
		shiftKey: event.shiftKey,
		metaKey: event.metaKey,
		ctrlKey: event.ctrlKey,
		pickerOpen: !props.delegationSteering && (vaultPickerOpen || picker.isOpen),
		isTouch:
			typeof window !== "undefined" &&
			window.matchMedia("(pointer: coarse)").matches,
		enterToSubmit: config.ui.enter_to_submit,
	});
	if (!action) return;
	if (
		action === "submit" &&
		isRavenLiveInteractionLocked(props.voice.livePhase)
	) {
		event.preventDefault();
		return;
	}
	event.preventDefault();
	const activePicker = vaultPickerOpen ? vaultPicker : picker;
	const submit = runComposerPickerAction(action, activePicker, () => {
		if (vaultPickerOpen) {
			if (vaultPicker.referencePreviewOpen) {
				vaultPicker.confirmReferencePreview();
			} else {
				const reference = vaultPicker.items[vaultPicker.selectedIndex];
				if (reference) vaultPicker.select(reference);
			}
			requestAnimationFrame(() => viewport.textareaRef.current?.focus());
		} else {
			handleSkillSelect(picker.items[picker.selectedIndex]);
		}
	});
	if (submit) {
		if (props.delegationSteering) props.handleSteerDelegatedChild();
		else handleSend();
	}
}

function composerPlaceholder(
	voice: RavenVoice,
	wsStatus: string,
	activeSkills: ActiveRavenSkill[],
	vaultReferenceCount: number,
	isRunning: boolean,
	delegationSteering: boolean,
	delegatedNativeSteeringAvailable: boolean,
): string {
	if (voice.phase === "starting") return "connecting Codex dictation…";
	if (voice.phase === "recording") {
		return `${
			voice.engine === "codex"
				? "recording a Codex voice message"
				: voice.engine === "codex_dictation"
					? "dictating with Codex"
					: "recording for Whisper"
		}… ${voice.seconds}s`;
	}
	if (voice.phase === "transcribing")
		return voice.engine === "codex_dictation"
			? "finalizing Codex dictation…"
			: "transcribing locally…";
	if (voice.phase === "submitting") return "sending voice message to Codex…";
	if (wsStatus !== "connected") return "connecting…";
	if (delegationSteering) {
		if (delegatedNativeSteeringAvailable) return "steer the active child turn…";
		return isRunning
			? "native steering is unavailable for this provider"
			: "this child has no active provider turn";
	}
	if (activeSkills.length > 0 || vaultReferenceCount > 0)
		return "add more context, @file, or /command…";
	return isRunning ? "type to queue next…" : "speak to the watcher…";
}

function voiceAnnouncement(voice: RavenVoice): string {
	if (voice.livePhase === "starting") return "Starting Raven Live";
	if (voice.livePhase === "connected")
		return voice.liveMicrophoneMuted
			? "Raven Live microphone muted"
			: "Raven Live microphone active";
	if (voice.livePhase === "stopping") return "Stopping Raven Live";
	if (voice.phase === "starting") return "Connecting Codex dictation";
	if (voice.phase === "recording") {
		return `${
			voice.engine === "codex"
				? "Recording a Codex voice message"
				: voice.engine === "codex_dictation"
					? "Dictating with Codex"
					: "Recording for Local Whisper"
		}, ${voice.seconds} seconds`;
	}
	if (voice.phase === "transcribing")
		return voice.engine === "codex_dictation"
			? "Finalizing Codex dictation"
			: "Transcribing audio locally";
	if (voice.phase === "submitting") return "Sending voice message to Codex";
	return voice.error ?? "";
}

function ChatTextarea(props: ChatComposerProps) {
	const {
		runtime,
		upload,
		viewport,
		picker,
		voice,
		input,
		setInput,
		activeSkills,
	} = props;
	const { wsStatus, isRunning } = runtime;
	const { uploadFiles } = upload;
	const { textareaRef } = viewport;
	const { isOpen: pickerOpen, selectedIndex: pickerIndex } = picker;
	const vaultPickerOpen = props.vaultPicker.isOpen;
	const pickerExpanded =
		!props.delegationSteering && (vaultPickerOpen || pickerOpen);
	return (
		<>
			<textarea
				ref={textareaRef}
				value={input}
				onChange={(e) => setInput(e.target.value)}
				onPaste={(e) => {
					if (props.delegationSteering) return;
					const files = Array.from(e.clipboardData?.files ?? []);
					if (files.length > 0) {
						e.preventDefault();
						void uploadFiles(files);
					}
				}}
				onKeyDown={(event) => handleComposerKeyDown(event, props)}
				role="combobox"
				aria-expanded={pickerExpanded}
				aria-controls={
					vaultPickerOpen ? "vault-reference-picker" : "slash-picker"
				}
				aria-autocomplete="list"
				aria-activedescendant={
					vaultPickerOpen && props.vaultPicker.items.length > 0
						? `vault-reference-picker-opt-${props.vaultPicker.selectedIndex}`
						: pickerOpen
							? `slash-picker-opt-${pickerIndex}`
							: undefined
				}
				rows={1}
				placeholder={composerPlaceholder(
					voice,
					wsStatus,
					activeSkills,
					props.vaultPicker.selected.length +
						props.vaultPicker.selectedRelics.length +
						props.vaultPicker.selectedWorkspace.length,
					isRunning,
					props.delegationSteering,
					props.delegatedNativeSteeringAvailable,
				)}
				disabled={
					wsStatus !== "connected" ||
					(props.delegationSteering &&
						!props.delegatedNativeSteeringAvailable) ||
					voice.phase === "transcribing" ||
					voice.phase === "submitting"
				}
				className={`md:order-4 flex-1 min-w-0 resize-none bg-transparent pt-1 pb-2 md:py-3 pr-2 text-sm leading-6 text-foreground focus:outline-none disabled:opacity-30 overflow-y-auto overscroll-contain touch-pan-y scroll-py-3 min-h-[60px] md:min-h-[120px] ${wsStatus !== "connected" ? "placeholder:text-foreground/50" : "placeholder:text-muted-foreground/35"}`}
			/>
			<span className="sr-only" aria-live="polite">
				{voiceAnnouncement(voice)}
			</span>
		</>
	);
}

/**
 * Shared fork-and-navigate logic for both the whole-session composer Fork
 * button and the per-message "branch from here" action. `fork()` with no
 * `messageId` forks the whole session; with one, branches up to and
 * including that assistant row (see POST /db/session/fork).
 *
 * `forkingMessageId` distinguishes which of the two triggered the in-flight
 * fork: "session" for the composer button, a message's dbId for a branch
 * button. Each call site gets its own hook instance (composer vs message
 * list), so the two never contend over the same loading/error state — the
 * error banner shows up near whichever one was actually clicked.
 */
function useForkSession(sessionId: string) {
	const navigate = useNavigate();
	const [forkingMessageId, setForkingMessageId] = useState<
		"session" | number | null
	>(null);
	const [forkError, setForkError] = useState<string | null>(null);

	const fork = useCallback(
		async (messageId?: number) => {
			setForkError(null);
			setForkingMessageId(messageId ?? "session");
			try {
				const { id: newId } = await forkSessionFn({
					data: { id: sessionId, messageId },
				});
				void navigate({
					to: "/raven",
					search: (previous) => ({ ...previous, session: newId }),
				});
			} catch (error) {
				setForkError(error instanceof Error ? error.message : "Fork failed");
				setForkingMessageId(null);
			}
		},
		[sessionId, navigate],
	);

	return {
		fork,
		forkingMessageId,
		forkError,
		dismissForkError: useCallback(() => setForkError(null), []),
	};
}

function useChatSessionFork({
	runtime,
	session,
	activeProviderId,
	providers,
	voice,
}: ChatComposerProps) {
	const { isRunning, messages } = runtime;
	const forkState = useForkSession(session.sessionId);
	const forkCapability = providers.find(
		(provider) => provider.id === activeProviderId,
	)?.forkCapability;
	return {
		...forkState,
		forking: forkState.forkingMessageId === "session",
		canFork:
			forkCapability?.kind === "exact" &&
			!isRunning &&
			!isRavenLiveInteractionLocked(voice.livePhase) &&
			messages.length > 0,
	};
}

type ChatSessionFork = ReturnType<typeof useChatSessionFork>;

export function providerBackgroundOperationAvailable(
	providers: RavenProviders,
	providerId: string,
	operation: "background" | "list" | "stop" | "terminate" | "clean",
): boolean {
	return (
		providers
			.find((provider) => provider.id === providerId)
			?.capabilities?.backgroundActivities?.operations.includes(operation) ??
		false
	);
}

function ChatActionButtons({
	runtime,
	input,
	activeSkills,
	voice,
	canSend,
	canQueue,
	handleSend,
	handleClear,
	sessionFork,
}: ChatComposerProps & { sessionFork: ChatSessionFork }) {
	const { send, isRunning, messages } = runtime;
	const { forkError, dismissForkError } = sessionFork;
	const liveActive = isRavenLiveInteractionLocked(voice.livePhase);
	const nativeGoalCommand =
		/^\/goal(?:\s|$)/i.test(input.trim()) ||
		activeSkills.some(
			(command) =>
				command.execution.kind === "capability-action" &&
				command.execution.action === "goal",
		);

	return (
		<>
			{forkError && (
				<div
					role="alert"
					className="order-6 md:order-5 flex items-center gap-1.5 text-[9px] text-destructive/80 shrink-0"
				>
					{forkError}
					<button
						type="button"
						onClick={dismissForkError}
						aria-label="Dismiss fork error"
						className="text-destructive/50 hover:text-destructive"
					>
						<X className="w-3 h-3" />
					</button>
				</div>
			)}
			{isRunning ? (
				<div className="grid shrink-0 grid-cols-1 grid-rows-2 gap-x-1 gap-y-1 md:contents">
					<button
						type="button"
						onClick={() => send({ type: "abort" })}
						className="order-7 min-h-11 w-full shrink-0 px-2 py-2 text-[10px] font-bold tracking-widest text-destructive/70 uppercase transition-colors hover:text-destructive md:min-h-0 md:w-auto md:px-4 md:py-3"
						aria-label="Abort"
					>
						STOP
					</button>
					<button
						type="button"
						onClick={() => handleSend()}
						disabled={!canQueue}
						className="order-8 min-h-11 w-full shrink-0 px-2 py-2 text-[10px] font-bold tracking-widest text-primary/70 uppercase transition-colors hover:text-primary disabled:text-muted-foreground/35 md:min-h-0 md:w-auto md:px-4 md:py-3"
						aria-label={
							nativeGoalCommand ? "Run goal command" : "Queue message"
						}
					>
						{nativeGoalCommand ? "APPLY" : "QUEUE"}
					</button>
				</div>
			) : (
				<button
					type="button"
					onClick={() => handleSend()}
					disabled={!canSend || liveActive}
					className="order-9 min-h-11 self-start shrink-0 px-4 py-2 text-[10px] font-bold tracking-widest text-primary/70 uppercase transition-colors hover:text-primary disabled:text-muted-foreground/35 md:min-h-0 md:py-3"
					aria-label="Send"
					title={
						liveActive ? "Stop Raven Live to send a typed message" : undefined
					}
				>
					RUN
				</button>
			)}
			{messages.length > 0 && (
				<button
					type="button"
					onClick={handleClear}
					className="order-10 flex min-h-11 min-w-11 shrink-0 items-center justify-center px-3 py-2 text-muted-foreground/45 transition-colors hover:text-muted-foreground md:min-h-0 md:min-w-0 md:py-3"
					aria-label="New chat"
				>
					<SquarePen className="w-3.5 h-3.5" />
				</button>
			)}
		</>
	);
}

type RavenSessionIdentity = ReturnType<typeof useRavenSessionIdentity>;
type RavenChatRuntime = ReturnType<typeof useRavenChatRuntime>;
type RavenUpload = ReturnType<typeof useFileUpload>;
type RavenViewport = ReturnType<typeof useRavenViewport>;
type RavenPicker = ReturnType<typeof useSlashPicker>;
type RavenVaultPicker = ReturnType<typeof useVaultReferencePicker>;
type RavenVoice = ReturnType<typeof useRavenVoice>;

interface ChatComposerProps {
	interactiveMode: boolean;
	savedSession: boolean;
	sessionPersisted: boolean;
	config: RavenConfig;
	agentList: RavenAgentList;
	session: RavenSessionIdentity;
	runtime: RavenChatRuntime;
	upload: RavenUpload;
	viewport: RavenViewport;
	picker: RavenPicker;
	vaultPicker: RavenVaultPicker;
	voice: RavenVoice;
	input: string;
	setInput: ReturnType<typeof useDraft>["setInput"];
	activeSkills: ActiveRavenSkill[];
	clearActiveSkill: (commandId: string) => void;
	planMode: boolean;
	setPlanMode: Dispatch<SetStateAction<boolean>>;
	planHtml: boolean;
	setPlanHtml: Dispatch<SetStateAction<boolean>>;
	terminalOpen: boolean;
	onToggleTerminal: () => void;
	dragOver: boolean;
	setDragOver: Dispatch<SetStateAction<boolean>>;
	showModelPopup: boolean;
	setShowModelPopup: Dispatch<SetStateAction<boolean>>;
	modelShort: string | null;
	activeModel: string | undefined;
	activeEffort: string | null;
	activePermissionMode: string | null;
	activeApprovalsReviewer: ProviderApprovalsReviewer | null;
	selectSessionControls: (
		selection: Partial<Omit<RavenSessionSelection, "providerId">>,
	) => void;
	selectSessionProvider: (selection: RavenSessionSelection) => void;
	actualModelShort: string | null;
	modelMismatch: boolean;
	actualSelectionMismatch: boolean;
	activeProviderId: string;
	activeProviderLabel: string;
	configuredProviderId: string;
	configuredProviderLabel: string;
	configuredModelShort: string | null;
	configuredSelection: RavenSessionSelection;
	providers: RavenProviders;
	modelPickerOptions: ReturnType<typeof modelOptions>;
	permissionOptions: ReturnType<typeof sessionPermissionOptionsFor>;
	approvalsReviewerOptions: NonNullable<
		RavenProviders[number]["approvalReviewers"]
	>;
	approvalsReviewerUnavailableReason: string | null;
	effortOptions: ReturnType<typeof effortOptionsFor>;
	providerModeOptions: Array<{
		value: string;
		label: string;
		desc?: string;
		isDefault?: boolean;
	}>;
	activeProviderMode: string | null;
	providerPlanModeValue: string | null;
	acpModelCatalogStatus: "loading" | "failed" | null;
	retryAcpModelCatalog: () => void;
	canSend: boolean;
	canQueue: boolean;
	delegationSteering: boolean;
	delegatedNativeSteeringAvailable: boolean;
	canSteerDelegatedChild: boolean;
	handleSteerDelegatedChild: () => void;
	handleSkillSelect: (command: CommandDescriptor) => void;
	handleSend: (
		overrideText?: string,
		goal?: { objective: string; tokenBudget?: number | null },
		voiceAttachments?: ChatAttachment[],
	) => void;
	handleClear: () => void;
	hideOnMobile?: boolean;
}

type ChatVoiceControlsProps = Pick<
	ChatComposerProps,
	"config" | "runtime" | "voice" | "activeProviderId"
>;

function ChatComposer(props: ChatComposerProps) {
	const {
		interactiveMode,
		config,
		agentList,
		session,
		runtime,
		picker,
		vaultPicker,
		handleSkillSelect,
		hideOnMobile = false,
	} = props;
	const { agentSkillContext } = session;
	const { sessionState, send, sleepState } = runtime;
	const {
		isOpen: pickerOpen,
		items: pickerItems,
		selectedIndex: pickerIndex,
	} = picker;
	if (interactiveMode) return null;

	return (
		<div
			className={`shrink-0 relative ${hideOnMobile ? "hidden md:block" : ""}`}
		>
			{!props.delegationSteering && vaultPicker.isOpen ? (
				<VaultReferencePicker
					rootLabel={vaultPicker.rootLabel}
					workspaceRootLabel={vaultPicker.workspaceRootLabel}
					workspaceEnvironmentLabel={vaultPicker.workspaceEnvironmentLabel}
					query={vaultPicker.query}
					items={vaultPicker.items}
					selectedIndex={vaultPicker.selectedIndex}
					loading={vaultPicker.loading}
					error={vaultPicker.error}
					vaultTotal={vaultPicker.vaultTotal}
					relicTotal={vaultPicker.relicTotal}
					workspaceTotal={vaultPicker.workspaceTotal}
					workspaceAvailable={vaultPicker.workspaceAvailable}
					activeSource={vaultPicker.activeSource}
					truncated={vaultPicker.truncated}
					workspacePreview={vaultPicker.workspacePreview}
					vaultPreview={vaultPicker.vaultPreview}
					relicPreview={vaultPicker.relicPreview}
					previewLoading={vaultPicker.previewLoading}
					previewError={vaultPicker.previewError}
					workspaceSelectionLoading={vaultPicker.workspaceSelectionLoading}
					onSourceChange={vaultPicker.setActiveSource}
					onPreviewReference={vaultPicker.previewReference}
					onConfirmReference={vaultPicker.confirmReferencePreview}
					onCancelReferencePreview={vaultPicker.cancelReferencePreview}
					onSelect={(reference) => {
						vaultPicker.select(reference);
						requestAnimationFrame(() =>
							props.viewport.textareaRef.current?.focus(),
						);
					}}
					direction="up"
				/>
			) : !props.delegationSteering && pickerOpen ? (
				<SlashPicker
					items={pickerItems}
					selectedIndex={pickerIndex}
					onSelect={handleSkillSelect}
					direction="up"
				/>
			) : null}
			{!props.delegationSteering && agentSkillContext && (
				<div className="relative z-10 mx-3 mt-1 flex min-w-0 md:absolute md:-top-5 md:left-3 md:mx-0 md:mt-0 md:block">
					<button
						type="button"
						className="block min-w-0 max-w-full px-2 py-0.5 text-[10px] tracking-widest uppercase bg-background border border-primary/30 text-primary/60 cursor-default md:text-[9px]"
					>
						<PrivacyMask inline className="block truncate whitespace-nowrap">
							{agentDisplayName(agentSkillContext, [
								...agentList,
								...(config.agents ?? []),
							])}
						</PrivacyMask>
					</button>
				</div>
			)}
			{!props.delegationSteering && <ChatModelBadge {...props} />}

			{/* Auto-sleep banner */}
			{!props.delegationSteering && sleepState && (
				<div className="border-t border-primary/30 bg-primary/5 px-4 py-2 flex items-center justify-between gap-4">
					<span className="text-[10px] tracking-widest text-primary/70 uppercase">
						sleeping
						{sleepState.until
							? ` until ${new Date(sleepState.until * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
							: ""}
						{ravenSleepDetail(sleepState)}
					</span>
					<button
						type="button"
						onClick={() => send({ type: "skip_sleep" })}
						className="text-[10px] tracking-widest px-3 py-1 border border-primary/40 text-primary/70 hover:text-primary hover:border-primary transition-colors uppercase font-bold"
					>
						RESUME NOW
					</button>
				</div>
			)}

			{/* Error banner */}
			{!props.delegationSteering && sessionState === "error" && (
				<div className="border-t border-destructive/30 bg-destructive/5 px-4 py-2 flex items-center justify-between gap-4">
					<span className="text-[10px] tracking-widest text-destructive/70 uppercase">
						session error
					</span>
					<button
						type="button"
						onClick={() => send({ type: "reload_session" })}
						className="text-[10px] tracking-widest px-3 py-1 border border-destructive/40 text-destructive/70 hover:text-destructive hover:border-destructive transition-colors uppercase font-bold"
					>
						RESET SESSION
					</button>
				</div>
			)}

			<ChatInputArea {...props} />
		</div>
	);
}
