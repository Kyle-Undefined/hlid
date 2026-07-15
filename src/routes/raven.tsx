import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	FileCode,
	MessageSquare,
	Mic,
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
	type SetStateAction,
	useCallback,
	useEffect,
	useReducer,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { AgentSelect } from "#/components/AgentSelect";
import { AttachmentStrip } from "#/components/AttachmentStrip";
import { reducer } from "#/components/chat/chatReducer";
import { MessageList } from "#/components/chat/MessageList";
import { SlashPicker } from "#/components/cockpit/SlashPicker";
import { McpIndicator } from "#/components/McpIndicator";
import { PrivacyMask } from "#/components/PrivacyMask";
import { TerminalView } from "#/components/TerminalView";
import { ProviderUsageStrip } from "#/components/usage/ProviderUsageStrip";
import { ContextWindowSection } from "#/components/usage/UsageWindowSections";
import { getConfig } from "#/config";
import { rememberRavenSessionId } from "#/hooks/ravenSessionStore";
import { useChatWsHandler } from "#/hooks/useChatWsHandler";
import { useCommands } from "#/hooks/useCommands";
import { useDraft } from "#/hooks/useDraft";
import { useFileUpload } from "#/hooks/useFileUpload";
import { useLoadChatHistory } from "#/hooks/useLoadChatHistory";
import { useSlashPicker } from "#/hooks/useSlashPicker";
import { useVoiceInput } from "#/hooks/useVoiceInput";
import { useWs } from "#/hooks/useWs";
import { useWsChatQueue, useWsLiveStats } from "#/hooks/useWsSelectors";
import { clearChatQueue } from "#/hooks/wsChatQueueStore";
import { resetLiveStats } from "#/hooks/wsLiveStatsStore";
import {
	getSessionsStatus,
	subscribeSessionsStatus,
} from "#/hooks/wsSessionStatusStore";
import * as wsStore from "#/hooks/wsStore";
import {
	type CommandDescriptor,
	resolveCommandSubmission,
} from "#/lib/commands";
import {
	composerKeyAction,
	insertAtSelection,
	prepareChatSubmission,
	resizeComposer,
	responsiveComposerMaxHeight,
} from "#/lib/composer";
import { deriveModelMismatch, fmtModel } from "#/lib/formatters";
import { mapMcpServer } from "#/lib/mcp";
import {
	effortOptionsFor,
	modelOptions,
	normalizeEffortForPlanMode,
	resolveActiveProviderId,
} from "#/lib/providerOptions";
import {
	ROUTE_SCROLL_RESTORATION_IDS,
	resetScrollAncestors,
	scrollChatToBottom,
} from "#/lib/scrollContainers";
import { getAgentListFn } from "#/lib/serverFns/agents";
import { getCockpitData } from "#/lib/serverFns/cockpit";
import { getProvidersFn, loadProviderUsages } from "#/lib/serverFns/providers";
import {
	ensureSessionFn,
	getCurrentSessionFn,
	getLiveSessionsFn,
	getSessionAgentCwdFn,
	getSessionModelFn,
	getSessionProviderIdFn,
} from "#/lib/serverFns/sessions";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";
import { uid } from "#/lib/utils";
import { displayVoiceHotkey } from "#/lib/voiceHotkey";
import { decisionFromScope, type RateLimitMessage } from "#/server/protocol";

// ─── route ───────────────────────────────────────────────────────────────────

type RavenConfig = Awaited<ReturnType<typeof getConfig>>;
type RavenLiveSessions = Awaited<ReturnType<typeof getLiveSessionsFn>>;

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
			(candidate) => candidate.mode !== "terminal" && candidate.db_session_id,
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
	const [config, agentList, cockpitData, providers, voiceInfo] =
		await Promise.all([
			getConfig(),
			getAgentListFn(),
			getCockpitData(),
			getProvidersFn(),
			getVoiceInfoFn(),
		]);
	const providerUsages = await loadProviderUsages(providers);
	const routeInteractiveMode = interactiveModeForAgent(config, agent);
	const liveSessions = session ? [] : await getLiveSessionsFn();
	let resolvedSessionId = await resolveSdkSession(
		session,
		routeInteractiveMode,
		liveSessions,
	);
	let agentSkillContext = agent;
	let sessionModel: string | null = null;
	let sessionProviderId: string | null = null;
	if (!agentSkillContext && resolvedSessionId) {
		const [savedAgentCwd, savedModel, savedProviderId] = await Promise.all([
			getSessionAgentCwdFn({ data: resolvedSessionId }),
			getSessionModelFn({ data: resolvedSessionId }),
			getSessionProviderIdFn({ data: resolvedSessionId }),
		]);
		agentSkillContext = savedAgentCwd ?? undefined;
		sessionModel = savedModel;
		sessionProviderId = savedProviderId;
	} else if (resolvedSessionId) {
		[sessionModel, sessionProviderId] = await Promise.all([
			getSessionModelFn({ data: resolvedSessionId }),
			getSessionProviderIdFn({ data: resolvedSessionId }),
		]);
	}
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
		providerUsages,
		agentSkillContext,
		sessionModel,
		sessionProviderId,
		agentList,
		vaultSkills: cockpitData.skills,
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
	component: ChatPage,
});

type RavenNavigate = ReturnType<typeof useNavigate>;
type RavenAgentList = Awaited<ReturnType<typeof getAgentListFn>>;
type RavenProviders = Awaited<ReturnType<typeof getProvidersFn>>;
type ActiveRavenSkill = CommandDescriptor;
type RavenSessionSelection = {
	providerId?: string;
	model?: string;
	effort?: string;
	permissionMode?: string;
};

function restoredRavenSessionSelection(
	existingSessionId: string | null,
	agentSkillContext: string | undefined,
	initialAgentSkillContext: string | undefined,
	initialSessionModel: string | null,
	initialSessionProviderId: string | null,
): RavenSessionSelection {
	return existingSessionId &&
		agentSkillContext === initialAgentSkillContext &&
		initialSessionModel
		? {
				model: initialSessionModel,
				...(initialSessionProviderId
					? { providerId: initialSessionProviderId }
					: {}),
			}
		: {};
}

function useRavenSessionIdentity({
	config,
	existingSessionId,
	interactiveMode,
	initialAgentSkillContext,
	routeSessionId,
	navigate,
}: {
	config: RavenConfig;
	existingSessionId: string | null;
	interactiveMode: boolean;
	initialAgentSkillContext: string | undefined;
	routeSessionId: string | undefined;
	navigate: RavenNavigate;
}) {
	const [agentSkillContext, setAgentSkillContext] = useState(
		initialAgentSkillContext,
	);
	const agentContextSentRef = useRef(false);
	const sessionsStatus = useSyncExternalStore(
		subscribeSessionsStatus,
		getSessionsStatus,
		() => [],
	);
	const [sessionId, setSessionId] = useState(
		() => existingSessionId ?? (interactiveMode ? "" : uid()),
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
			setAgentSkillContext(agent);
			agentContextSentRef.current = false;
			rememberRavenSessionId(sessionIdRef.current, agent);
			void navigate({
				to: "/raven",
				search: (previous) => ({
					...previous,
					session: sessionIdRef.current,
					agent,
				}),
				replace: true,
			});
		},
		[navigate],
	);

	useEffect(() => {
		sessionIdRef.current = sessionId;
	}, [sessionId]);

	useEffect(() => {
		if (!sessionId) return;
		// Route navigation updates loader data before this hook's local session
		// state catches up. Do not overwrite the newly selected route with the
		// previous chat during that transition.
		if (existingSessionId && existingSessionId !== sessionId) return;
		rememberRavenSessionId(sessionId, agentSkillContext);
		if (routeSessionId === sessionId) return;
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
		navigate,
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on session navigation only
	useEffect(() => {
		if (existingSessionId) {
			setSessionId(existingSessionId);
			sessionIdRef.current = existingSessionId;
		}
		setAgentSkillContext(initialAgentSkillContext);
		agentContextSentRef.current = false;
	}, [existingSessionId]);

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
	};
}

function useRavenChatRuntime({
	existingSessionId,
	isExplicitSession,
	sessionIdRef,
	agentCwd,
}: {
	existingSessionId: string | null;
	isExplicitSession: boolean;
	sessionIdRef: { current: string };
	agentCwd?: string;
}) {
	const [sdkSlashCommands, setSdkSlashCommands] = useState<
		Array<{
			name: string;
			description: string;
			argumentHint: string;
			aliases?: string[];
			action?: "review";
		}>
	>([]);
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const [mcpServers, setMcpServers] = useState<
		ReturnType<typeof mapMcpServer>[]
	>([]);
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
	const handleAllMessages = useCallback(
		(message: Parameters<typeof handleWsMessage>[0]) => {
			if (message.type === "mcp_status") {
				if ((message.agent_cwd ?? "") !== (agentCwd ?? "")) return;
				setMcpServers(
					message.servers.map((server) =>
						mapMcpServer({
							...server,
							providerId: server.provider_id ?? message.provider_id,
						}),
					),
				);
				return;
			}
			if (message.type === "slash_commands") {
				if ((message.agent_cwd ?? "") !== (agentCwd ?? "")) return;
				setSdkSlashCommands(message.commands);
				return;
			}
			handleWsMessage(message);
		},
		[handleWsMessage, agentCwd],
	);
	const connection = useWs(handleAllMessages);

	useLoadChatHistory({
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
		setMcpServers([]);
	}, [agentCwd, existingSessionId]);

	useEffect(() => {
		connection.send({
			type: "sync_mcp_list",
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
	}, [connection.send, agentCwd, sessionIdRef]);

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
		isRunning,
		sdkSlashCommands,
		mcpServers,
		rateLimit,
		setRateLimit,
		messages,
		dispatch,
		pendingIdRef,
		lastAssistantIdRef,
	};
}

function useRavenViewport({
	input,
	messages,
	activeSkill,
	showModelPopup,
	setShowModelPopup,
}: {
	input: string;
	messages: unknown[];
	activeSkill: unknown;
	showModelPopup: boolean;
	setShowModelPopup: Dispatch<SetStateAction<boolean>>;
}) {
	const bottomRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const atBottomRef = useRef(true);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const modelBadgeRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const pendingSkillFocusRef = useRef(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: activeSkill triggers deferred focus
	useEffect(() => {
		if (!pendingSkillFocusRef.current) return;
		pendingSkillFocusRef.current = false;
		textareaRef.current?.focus();
	}, [activeSkill]);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		const onScroll = () => {
			atBottomRef.current =
				element.scrollHeight - element.scrollTop - element.clientHeight < 80;
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		return () => element.removeEventListener("scroll", onScroll);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: messages is the scroll trigger
	useEffect(() => {
		if (atBottomRef.current) scrollChatToBottom(scrollRef.current);
	}, [messages]);

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
	input: string;
	setInput: ReturnType<typeof useDraft>["setInput"];
	clearDraft: ReturnType<typeof useDraft>["clearDraft"];
	activeSkill: ActiveRavenSkill | null;
	setActiveSkill: Dispatch<SetStateAction<ActiveRavenSkill | null>>;
	commands: CommandDescriptor[];
	planMode: boolean;
	setPlanMode: Dispatch<SetStateAction<boolean>>;
	planHtml: boolean;
	sessionSelection: RavenSessionSelection;
	setSessionSelection: Dispatch<SetStateAction<RavenSessionSelection>>;
	session: ReturnType<typeof useRavenSessionIdentity>;
	runtime: ReturnType<typeof useRavenChatRuntime>;
	upload: ReturnType<typeof useFileUpload>;
	viewport: ReturnType<typeof useRavenViewport>;
	chatQueue: ReturnType<typeof useWsChatQueue>;
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
	const {
		input,
		setInput,
		clearDraft,
		activeSkill,
		setActiveSkill,
		commands,
		planMode,
		planHtml,
		sessionSelection,
	} = props;
	const { agentSkillContext, agentContextSentRef, sessionId } = props.session;
	const { sessionState, send, dispatch } = props.runtime;
	const { pendingAttachments, clearPending: clearPendingAttachments } =
		props.upload;
	const { atBottomRef } = props.viewport;

	return useCallback(
		(overrideText?: string) => {
			const typed = (overrideText ?? input).trim();

			const { text, skillContext, commandAction } = resolveCommandSubmission(
				activeSkill,
				typed,
				commands,
			);
			const id = uid();
			const submission = prepareChatSubmission({
				id,
				text,
				sessionId,
				running: sessionState === "running",
				skillContext,
				commandAction,
				attachments: pendingAttachments,
				agentCwd: agentSkillContext ?? undefined,
				agentContextAlreadySent: agentContextSentRef.current,
				planMode,
				planHtml,
				provider: sessionSelection.providerId,
				model: sessionSelection.model,
				effort: sessionSelection.effort,
				permissionMode: sessionSelection.permissionMode,
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
			clearDraft();
			setInput("");
			setActiveSkill(null);
			clearPendingAttachments();
		},
		[
			input,
			setInput,
			activeSkill,
			commands,
			sessionState,
			send,
			sessionId,
			pendingAttachments,
			agentSkillContext,
			clearDraft,
			clearPendingAttachments,
			planMode,
			planHtml,
			sessionSelection,
			dispatch,
			atBottomRef,
			agentContextSentRef,
			setActiveSkill,
		],
	);
}

function useRavenVoice(
	props: RavenActionProps,
	handleSend: (overrideText?: string) => void,
) {
	const { config, initialVoiceInfo, input, setInput } = props;
	const { textareaRef } = props.viewport;
	return useVoiceInput({
		config: config.voice,
		initialInfo: initialVoiceInfo,
		onTranscription: (text) => {
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
	});
}

function useRavenQueueActions(props: RavenActionProps) {
	const { input, setInput, chatQueue } = props;
	const { dispatch } = props.runtime;
	const { pendingAttachments, setPendingAttachments } = props.upload;

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
			if (!input.trim() && pendingAttachments.length === 0) {
				setInput(item.text);
				if (item.attachments && item.attachments.length > 0) {
					setPendingAttachments(item.attachments);
				}
			}
		},
		[
			input,
			setInput,
			pendingAttachments.length,
			setPendingAttachments,
			dispatch,
		],
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

	return { handleCancelQueued, handlePromoteQueued };
}

function useRavenClear(props: RavenActionProps) {
	const { clearDraft, setPlanMode, setSessionSelection } = props;
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
		setSessionSelection({});
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
		setSessionSelection,
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
	if (providerId === "codex") {
		return {
			model: config.codex?.model,
			effort: config.codex?.effort,
			permissionMode: config.codex?.permission_mode,
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
): RavenSessionSelection {
	const useConfigured = configured.providerId === provider.id;
	const models = modelOptions(provider);
	const configuredModel = useConfigured ? configured.model : undefined;
	const model =
		models.find((candidate) => candidate.value === configuredModel)?.value ??
		models.find((candidate) => candidate.isDefault)?.value ??
		models[0]?.value;
	const efforts = effortOptionsFor(provider, model ?? "");
	const configuredEffort = useConfigured ? configured.effort : undefined;
	const effort =
		efforts.find((candidate) => candidate.value === configuredEffort)?.value ??
		efforts.find((candidate) => candidate.isDefault)?.value ??
		efforts.find((candidate) => candidate.value === "medium")?.value ??
		efforts[0]?.value;
	const permissions = provider.permissionModes ?? [];
	const configuredPermission = useConfigured
		? configured.permissionMode
		: undefined;
	const permissionMode =
		permissions.find((candidate) => candidate.value === configuredPermission)
			?.value ??
		permissions.find((candidate) => candidate.value === "default")?.value ??
		permissions[0]?.value;
	return {
		providerId: provider.id,
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		...(permissionMode ? { permissionMode } : {}),
	};
}

function deriveRavenComposerState({
	config,
	agentList,
	providers,
	agentSkillContext,
	input,
	activeSkill,
	pendingAttachmentCount,
	uploadingCount,
	wsStatus,
	isRunning,
	model,
	actualModel,
	selection,
	restoredSession,
	sessionProviderId,
	planMode,
}: {
	config: RavenConfig;
	agentList: RavenAgentList;
	providers: RavenProviders;
	agentSkillContext: string | undefined;
	input: string;
	activeSkill: ActiveRavenSkill | null;
	pendingAttachmentCount: number;
	uploadingCount: number;
	wsStatus: string;
	isRunning: boolean;
	model: string | undefined;
	actualModel: string | null;
	selection: RavenSessionSelection;
	restoredSession: boolean;
	sessionProviderId: string | null;
	planMode: boolean;
}) {
	const hasInput =
		(input.trim().length > 0 ||
			activeSkill !== null ||
			pendingAttachmentCount > 0) &&
		uploadingCount === 0 &&
		wsStatus === "connected";
	const selectedAgent = agentSkillContext
		? config.agents?.find((agent) => agent.path === agentSkillContext)
		: undefined;
	const configuredProviderId = resolveActiveProviderId(
		agentList,
		agentSkillContext,
		config.vault_provider,
	);
	const vaultSelection = configuredVaultSelection(config, configuredProviderId);
	const configuredSelection: RavenSessionSelection = {
		providerId: configuredProviderId,
		model: selectedAgent?.model ?? vaultSelection.model,
		effort: selectedAgent?.effort ?? vaultSelection.effort,
		permissionMode:
			selectedAgent?.permission_mode ?? vaultSelection.permissionMode,
	};
	const providerId =
		selection.providerId ??
		(restoredSession ? sessionProviderId : null) ??
		configuredProviderId;
	const providerUsesConfiguredDefaults = providerId === configuredProviderId;
	const selectedModel =
		selection.model ??
		(providerUsesConfiguredDefaults ? configuredSelection.model : undefined) ??
		model;
	const selectedEffort =
		selection.effort ??
		(providerUsesConfiguredDefaults ? configuredSelection.effort : null) ??
		null;
	const selectedPermissionMode =
		selection.permissionMode ??
		(providerUsesConfiguredDefaults
			? configuredSelection.permissionMode
			: null) ??
		null;
	const { effectiveActualModel, mismatch: runtimeModelMismatch } =
		deriveModelMismatch(configuredSelection.model, actualModel, selectedModel);
	const modelMismatch =
		providerId !== configuredProviderId || runtimeModelMismatch;
	const provider = providers.find((candidate) => candidate.id === providerId);
	const configuredProvider = providers.find(
		(candidate) => candidate.id === configuredProviderId,
	);
	return {
		canSend: hasInput && !isRunning,
		canQueue: hasInput && isRunning,
		activeModel: selectedModel,
		activeEffort: selectedEffort,
		activePermissionMode: selectedPermissionMode,
		modelShort: selectedModel ? fmtModel(selectedModel) : null,
		actualModelShort: effectiveActualModel
			? fmtModel(effectiveActualModel)
			: null,
		modelMismatch,
		activeProviderId: providerId,
		activeProviderLabel: provider?.label ?? providerId,
		configuredProviderId,
		configuredProviderLabel: configuredProvider?.label ?? configuredProviderId,
		configuredModelShort: configuredSelection.model
			? fmtModel(configuredSelection.model)
			: null,
		configuredSelection,
		modelPickerOptions: modelOptions(provider),
		permissionOptions: provider?.permissionModes ?? [],
		effortOptions: effortOptionsFor(provider, selectedModel ?? "", planMode),
	};
}

export function ChatPage() {
	const {
		config,
		existingSessionId,
		isExplicitSession,
		providerUsages: initialProviderUsages,
		agentSkillContext: initialAgentSkillContext,
		sessionModel: initialSessionModel,
		sessionProviderId: initialSessionProviderId,
		agentList,
		vaultSkills,
		interactiveMode,
		providers,
		voiceInfo: initialVoiceInfo,
	} = Route.useLoaderData();
	const ravenSearch = Route.useSearch();
	const navigate = useNavigate();
	const session = useRavenSessionIdentity({
		config,
		existingSessionId,
		interactiveMode,
		initialAgentSkillContext,
		routeSessionId: ravenSearch.session,
		navigate,
	});
	const { agentSkillContext, sessionId, sessionIdRef } = session;
	const restoredSession = Boolean(
		existingSessionId && agentSkillContext === initialAgentSkillContext,
	);
	const [activeSkill, setActiveSkill] = useState<ActiveRavenSkill | null>(null);
	const [sessionSelection, setSessionSelection] =
		useState<RavenSessionSelection>(() =>
			restoredRavenSessionSelection(
				existingSessionId,
				agentSkillContext,
				initialAgentSkillContext,
				initialSessionModel,
				initialSessionProviderId,
			),
		);
	useEffect(() => {
		setSessionSelection(
			restoredRavenSessionSelection(
				existingSessionId,
				agentSkillContext,
				initialAgentSkillContext,
				initialSessionModel,
				initialSessionProviderId,
			),
		);
	}, [
		existingSessionId,
		agentSkillContext,
		initialAgentSkillContext,
		initialSessionModel,
		initialSessionProviderId,
	]);

	const liveStats = useWsLiveStats();
	const chatQueue = useWsChatQueue();
	const runtime = useRavenChatRuntime({
		existingSessionId,
		isExplicitSession,
		sessionIdRef,
		agentCwd: agentSkillContext,
	});
	const {
		wsStatus,
		model,
		actualModel,
		isRunning,
		sdkSlashCommands,
		rateLimit,
		messages,
	} = runtime;
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
	const upload = useFileUpload({ agentCwd: agentSkillContext, sessionId });
	const { pendingAttachments, uploadingCount } = upload;
	const [planMode, setPlanMode] = useState(false);
	const [planHtml, setPlanHtml] = useState(config.ui.html_plans ?? false);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [shellTab, setShellTab] = useState<"chat" | "terminal">("chat");
	const handleToggleTerminal = useCallback(() => {
		setTerminalOpen((open) => {
			const next = !open;
			setShellTab(next ? "terminal" : "chat");
			return next;
		});
	}, []);
	const [dragOver, setDragOver] = useState(false);
	const [showModelPopup, setShowModelPopup] = useState(false);
	const viewport = useRavenViewport({
		input,
		messages,
		activeSkill,
		showModelPopup,
		setShowModelPopup,
	});
	const { focusSkillOnNextRender } = viewport;

	// ─── Skills + slash picker ────────────────────────────────────────────────

	const commands = useCommands(vaultSkills, sdkSlashCommands);

	const picker = useSlashPicker(input, commands, activeSkill);

	function handleSkillSelect(command: CommandDescriptor) {
		focusSkillOnNextRender();
		setActiveSkill(command);
		setInput("");
	}

	// ─── Handlers ─────────────────────────────────────────────────────────────

	const {
		voice,
		handleDecide,
		handleSubmitAnswers,
		handlePlanDecide,
		handleSend,
		handleCancelQueued,
		handlePromoteQueued,
		handleClear,
	} = useRavenActions({
		config,
		initialVoiceInfo,
		input,
		setInput,
		clearDraft,
		activeSkill,
		setActiveSkill,
		commands,
		planMode,
		setPlanMode,
		planHtml,
		sessionSelection,
		setSessionSelection,
		session,
		runtime,
		upload,
		viewport,
		chatQueue,
	});

	const {
		canSend,
		canQueue,
		modelShort,
		activeModel,
		activeEffort,
		activePermissionMode,
		actualModelShort,
		modelMismatch,
		activeProviderId,
		activeProviderLabel,
		configuredProviderId,
		configuredProviderLabel,
		configuredModelShort,
		configuredSelection,
		modelPickerOptions,
		permissionOptions,
		effortOptions,
	} = deriveRavenComposerState({
		config,
		agentList,
		providers,
		agentSkillContext,
		input,
		activeSkill,
		pendingAttachmentCount: pendingAttachments.length,
		uploadingCount,
		wsStatus,
		isRunning,
		model,
		actualModel,
		selection: sessionSelection,
		restoredSession,
		sessionProviderId: initialSessionProviderId,
		planMode,
	});
	const composerProps: ChatComposerProps = {
		interactiveMode,
		config,
		agentList,
		session,
		runtime,
		upload,
		viewport,
		picker,
		voice,
		input,
		setInput,
		activeSkill,
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
		setSessionSelection,
		actualModelShort,
		modelMismatch,
		activeProviderId,
		activeProviderLabel,
		configuredProviderId,
		configuredProviderLabel,
		configuredModelShort,
		configuredSelection,
		providers,
		modelPickerOptions,
		permissionOptions,
		effortOptions,
		canSend,
		canQueue,
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
			interactiveMode={interactiveMode}
			terminalOpen={terminalOpen}
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
	interactiveMode: boolean;
	terminalOpen: boolean;
	shellTab: "chat" | "terminal";
	setShellTab: Dispatch<SetStateAction<"chat" | "terminal">>;
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
	>;
	composerProps: ChatComposerProps;
}

function ChatPageContent(props: ChatPageContentProps) {
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
	return (
		<div className="h-full min-h-0 flex flex-col overflow-hidden">
			<ProviderUsageStrip
				initial={initialProviderUsages}
				liveQueryCount={liveStats?.queries ?? 0}
				rateLimit={rateLimit}
				preferredProviderId={composerProps.activeProviderId}
				fetchFn={loadProviderUsages}
				tail={<ContextWindowSection stats={liveStats} />}
			/>

			<RavenTerminalPane {...props} />
			{!interactiveMode && terminalOpen && (
				<RavenShellTabBar activeTab={shellTab} setActiveTab={setShellTab} />
			)}
			<RavenMessagePane {...props} />
			{!interactiveMode && <RavenShellPane {...props} />}
			<ChatComposer
				{...composerProps}
				hideOnMobile={terminalOpen && shellTab === "terminal"}
			/>
		</div>
	);
}

/** Mobile-only Chat/Terminal tab switch — desktop gets a split panel instead (chunk 4). */
function RavenShellTabBar({
	activeTab,
	setActiveTab,
}: {
	activeTab: "chat" | "terminal";
	setActiveTab: Dispatch<SetStateAction<"chat" | "terminal">>;
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
		</div>
	);
}

/**
 * Dev-shell pane — mounts a real login shell (/ws/shell), once, only while
 * terminalOpen (nothing spins up until toggled on). A single TerminalView
 * stays connected the whole time terminalOpen is true — below md it's
 * CSS-shown/hidden by the Chat/Terminal tab bar; at md+ it's always visible
 * as a fixed-height panel under the chat, alongside the chat rather than
 * swapped with it. Unmounting this component — terminalOpen flipping false —
 * is what kills the PTY, via terminateOnDisconnect.
 */
function RavenShellPane({
	config,
	terminalOpen,
	shellTab,
	session,
}: ChatPageContentProps) {
	const { agentSkillContext, sessionId } = session;
	if (!terminalOpen || !sessionId) return null;
	return (
		<div
			className={`${
				shellTab === "terminal" ? "flex" : "hidden"
			} md:order-last md:flex flex-1 md:flex-none md:h-64 overflow-hidden md:border-t md:border-border/40`}
		>
			<TerminalView
				sessionId={sessionId}
				cwd={agentSkillContext ?? config.vault.path}
				wsPath="/ws/shell"
				active={true}
				terminateOnDisconnect
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
	interactiveMode,
	terminalOpen,
	shellTab,
	session,
	runtime,
	chatQueue,
	viewport,
	actions,
}: ChatPageContentProps) {
	const { sessionId } = session;
	const { wsStatus, sessionState, runningTurnId, messages } = runtime;
	const { scrollRef, bottomRef } = viewport;
	const {
		handleDecide,
		handleSubmitAnswers,
		handlePlanDecide,
		handleCancelQueued,
		handlePromoteQueued,
	} = actions;
	// Below md, the Terminal tab fully replaces chat (RavenShellTabBar); md+
	// always shows chat regardless (desktop split panel is chunk 4).
	const mobileHideChat = terminalOpen && shellTab === "terminal";
	return (
		<>
			{/* Messages, inner min-h-full + justify-end anchors messages to bottom */}
			{!interactiveMode && (
				<div
					ref={scrollRef}
					data-scroll-restoration-id={
						ROUTE_SCROLL_RESTORATION_IDS.ravenTranscript
					}
					className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden ${
						mobileHideChat ? "hidden md:block" : ""
					}`}
				>
					<div className="min-h-full flex flex-col justify-end px-5 pt-2 pb-7 min-w-0">
						{messages.length === 0 ? (
							<div className="flex-1 flex flex-col items-center justify-center gap-3">
								<div className="text-2xl font-bold tracking-widest text-foreground/20 uppercase select-none">
									{wsStatus !== "connected"
										? "CONNECTING"
										: "THE WATCHER LISTENS"}
								</div>
								{wsStatus === "connected" && (
									<div className="text-[9px] tracking-[0.35em] text-muted-foreground/35">
										↵ send · ⇧↵ newline
									</div>
								)}
							</div>
						) : (
							<MessageList
								messages={messages}
								chatQueue={chatQueue}
								sessionId={sessionId}
								sessionState={sessionState}
								runningTurnId={runningTurnId}
								handleDecide={handleDecide}
								handleSubmitAnswers={handleSubmitAnswers}
								handlePlanDecide={handlePlanDecide}
								handleCancelQueued={handleCancelQueued}
								handlePromoteQueued={handlePromoteQueued}
								bottomRef={bottomRef}
							/>
						)}
					</div>
				</div>
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
 * One labelled option list inside the model badge popup (model / effort /
 * permission). All three groups share markup and selection behaviour; only
 * the label, options, and what "select" means differ.
 */
function OptionGroup({
	label,
	options,
	selectedValue,
	onSelect,
	divider = false,
}: {
	label: string;
	options: BadgeOption[];
	selectedValue: string | null | undefined;
	onSelect: (value: string) => void;
	divider?: boolean;
}) {
	if (options.length === 0) return null;
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
					onClick={() => onSelect(o.value)}
					className={`block w-full text-left normal-case tracking-normal px-1.5 py-1 transition-colors ${
						o.value === selectedValue
							? "text-primary bg-primary/10"
							: "text-foreground/70 hover:bg-accent"
					}`}
				>
					{o.label}
					{o.isDefault ? " (default)" : ""}
				</button>
			))}
		</div>
	);
}

function ChatModelBadge({
	session,
	runtime,
	viewport,
	showModelPopup,
	setShowModelPopup,
	modelShort,
	activeModel,
	activeEffort,
	activePermissionMode,
	setSessionSelection,
	actualModelShort,
	modelMismatch,
	activeProviderId,
	activeProviderLabel,
	configuredProviderLabel,
	configuredModelShort,
	configuredSelection,
	providers,
	modelPickerOptions,
	permissionOptions,
	effortOptions,
}: ChatComposerProps) {
	const { model, permissionMode, effort, sessionState, send } = runtime;
	const { sessionId } = session;
	const displayedModel = activeModel ?? model;
	const displayedEffort = activeEffort ?? effort;
	const displayedPermissionMode = activePermissionMode ?? permissionMode;
	const badgeParts = [
		activeProviderLabel,
		actualModelShort ?? modelShort,
		displayedEffort,
		displayedPermissionMode === "bypassPermissions"
			? "auto"
			: displayedPermissionMode === "acceptEdits"
				? "edits"
				: displayedPermissionMode === "default"
					? "ask"
					: displayedPermissionMode,
	].filter(Boolean);
	const { modelBadgeRef } = viewport;
	const popupRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (showModelPopup) popupRef.current?.focus();
	}, [showModelPopup]);
	return (
		<>
			{activeProviderLabel && (
				<div ref={modelBadgeRef} className="absolute -top-5 right-3 z-10">
					<button
						type="button"
						aria-haspopup="dialog"
						aria-expanded={showModelPopup}
						onClick={(e) => {
							e.stopPropagation();
							setShowModelPopup((v) => !v);
						}}
						className={`text-[9px] tracking-widest px-2 py-0.5 uppercase bg-background border cursor-pointer transition-colors ${
							modelMismatch
								? "text-amber-500/80 border-amber-500/60"
								: "text-muted-foreground/50 border-border/70 hover:text-foreground/70 hover:border-primary/40"
						}`}
					>
						{badgeParts.join(" · ")}
					</button>
					{showModelPopup && (
						<div
							ref={popupRef}
							tabIndex={-1}
							role="dialog"
							aria-label="Model settings"
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
										<span className="text-muted-foreground/50">current </span>
										<span className="text-amber-400">
											{activeProviderLabel}
											{actualModelShort || modelShort
												? ` · ${actualModelShort ?? modelShort}`
												: ""}
										</span>
									</div>
								</div>
							)}
							<OptionGroup
								label="cli"
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
									const provider = providers.find(
										(candidate) => candidate.id === value,
									);
									if (!provider || provider.id === activeProviderId) return;
									const next = defaultSelectionForProvider(
										provider,
										configuredSelection,
									);
									setSessionSelection(next);
									wsStore.seedActualModel(null);
									send({
										type: "set_provider",
										provider: value,
										session_id: sessionId,
										...(next.model ? { model: next.model } : {}),
										...(next.effort ? { effort: next.effort } : {}),
										...(next.permissionMode
											? { permission_mode: next.permissionMode }
											: {}),
									});
								}}
							/>
							<OptionGroup
								label="model"
								divider
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
								selectedValue={displayedModel}
								onSelect={(value) => {
									setSessionSelection((current) => ({
										...current,
										model: value,
									}));
									wsStore.seedActualModel(null);
									send({
										type: "set_model",
										model: value,
										session_id: sessionId,
									});
								}}
							/>
							<OptionGroup
								label="effort"
								divider
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
									setSessionSelection((current) => ({
										...current,
										effort: value,
									}));
									send({
										type: "set_effort",
										effort: value,
										session_id: sessionId,
									});
								}}
							/>
							<OptionGroup
								label="permission"
								divider
								options={permissionOptions.map((p) => ({
									value: p.value,
									label: p.label,
									...(p.desc !== undefined ? { title: p.desc } : {}),
								}))}
								selectedValue={displayedPermissionMode}
								onSelect={(value) => {
									setSessionSelection((current) => ({
										...current,
										permissionMode: value,
									}));
									send({
										type: "set_permission_mode",
										mode: value,
										session_id: sessionId,
									});
								}}
							/>
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
	agentList,
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
	activeEffort,
	setSessionSelection,
}: ChatComposerProps) {
	const { agentSkillContext, selectAgent, sessionId } = session;
	const { messages, effort, send } = runtime;
	const {
		pendingAttachments,
		uploadingCount,
		uploadError,
		gitignoreHint,
		removePending,
		dismissGitignoreHint,
	} = upload;
	return (
		<>
			{gitignoreHint && (
				<div className="px-4 py-2 flex items-start gap-2 border-b border-border/40 bg-yellow-500/5">
					<div className="flex-1 text-[10px] text-foreground/70 leading-relaxed">
						<span className="text-yellow-500/80">tip:</span> attachments stored
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
				attachments={pendingAttachments}
				uploadingCount={uploadingCount}
				uploadError={uploadError}
				onRemove={removePending}
			/>
			{voice.error && (
				<div
					className="px-4 py-2 flex items-start gap-3 border-b border-destructive/30 bg-destructive/5"
					role="alert"
				>
					<div className="flex-1 text-[10px] text-destructive/80 leading-relaxed">
						voice transcription failed: {voice.error}
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
				<div className="flex w-full min-w-0 items-center justify-end gap-3 md:w-auto">
					<McpIndicator servers={runtime.mcpServers} align="mobile-left" />
					<button
						type="button"
						onClick={() => {
							const enabling = !planMode;
							if (enabling) {
								const normalized = normalizeEffortForPlanMode(
									activeProviderId,
									activeEffort ?? effort,
								);
								if (normalized && normalized !== (activeEffort ?? effort)) {
									setSessionSelection((current) => ({
										...current,
										effort: normalized,
									}));
									send({
										type: "set_effort",
										effort: normalized,
										session_id: sessionId,
									});
								}
							}
							setPlanMode(enabling);
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
		</>
	);
}

function ChatInputControls(props: ChatComposerProps) {
	const { runtime, upload, viewport } = props;
	const { wsStatus } = runtime;
	const { uploadFiles } = upload;
	const { fileInputRef } = viewport;
	return (
		<div className="flex min-w-0 items-start">
			<span className="text-primary text-sm px-4 py-3 shrink-0 select-none">
				›
			</span>
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
				className="px-2 py-3 text-muted-foreground/45 hover:text-muted-foreground transition-colors shrink-0 disabled:opacity-30"
				aria-label="Attach file"
				title="Attach file"
			>
				<Paperclip className="w-3.5 h-3.5" />
			</button>
			<ChatVoiceControls {...props} />
			<ChatTextarea {...props} />
			<ChatActionButtons {...props} />
		</div>
	);
}

function ChatVoiceControls({ config, runtime, voice }: ChatComposerProps) {
	const { wsStatus } = runtime;
	return (
		<>
			<button
				type="button"
				onClick={() => {
					if (voice.phase === "recording") voice.stop();
					else void voice.start();
				}}
				onFocus={voice.refresh}
				disabled={
					wsStatus !== "connected" ||
					(!voice.ready && voice.phase !== "recording") ||
					voice.phase === "transcribing"
				}
				className={`px-2 py-3 transition-colors shrink-0 disabled:opacity-30 ${voice.phase === "recording" ? "text-destructive" : "text-muted-foreground/45 hover:text-muted-foreground"}`}
				aria-label={
					voice.phase === "recording" ? "Stop recording" : "Start voice input"
				}
				title={
					!config.voice.enabled
						? "Enable voice in Forge"
						: voice.status.state !== "ready"
							? `Voice ${voice.status.state}`
							: config.voice.hotkey
								? `Voice input (${displayVoiceHotkey(config.voice.hotkey)})`
								: "Start voice input"
				}
			>
				{voice.phase === "recording" ? (
					<Square className="w-3.5 h-3.5 fill-current" />
				) : (
					<Mic className="w-3.5 h-3.5" />
				)}
			</button>
			{voice.phase === "recording" && (
				<button
					type="button"
					onClick={voice.cancel}
					className="px-1 py-3 text-muted-foreground/45 hover:text-muted-foreground"
					aria-label="Cancel recording"
					title="Cancel recording"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			)}
		</>
	);
}

function handleComposerKeyDown(
	event: ReactKeyboardEvent<HTMLTextAreaElement>,
	{ config, picker, handleSkillSelect, handleSend }: ChatComposerProps,
): void {
	const action = composerKeyAction({
		key: event.key,
		shiftKey: event.shiftKey,
		metaKey: event.metaKey,
		ctrlKey: event.ctrlKey,
		pickerOpen: picker.isOpen,
		isTouch:
			typeof window !== "undefined" &&
			window.matchMedia("(pointer: coarse)").matches,
		enterToSubmit: config.ui.enter_to_submit,
	});
	if (!action) return;
	event.preventDefault();
	if (action === "picker-next") picker.navigate(1);
	if (action === "picker-previous") picker.navigate(-1);
	if (action === "picker-close") picker.close();
	if (action === "picker-select" && picker.items.length > 0)
		handleSkillSelect(picker.items[picker.selectedIndex]);
	if (action === "submit") handleSend();
}

function composerPlaceholder(
	voice: RavenVoice,
	wsStatus: string,
	activeSkill: ActiveRavenSkill | null,
	isRunning: boolean,
): string {
	if (voice.phase === "recording") return `recording… ${voice.seconds}s`;
	if (voice.phase === "transcribing") return "transcribing locally…";
	if (wsStatus !== "connected") return "connecting…";
	if (activeSkill) return `add context for /${activeSkill.name}… (optional)`;
	return isRunning ? "type to queue next…" : "speak to the watcher…";
}

function voiceAnnouncement(voice: RavenVoice): string {
	if (voice.phase === "recording") return `Recording, ${voice.seconds} seconds`;
	if (voice.phase === "transcribing") return "Transcribing audio locally";
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
		activeSkill,
	} = props;
	const { wsStatus, isRunning } = runtime;
	const { uploadFiles } = upload;
	const { textareaRef } = viewport;
	const { isOpen: pickerOpen, selectedIndex: pickerIndex } = picker;
	return (
		<>
			<textarea
				ref={textareaRef}
				value={input}
				onChange={(e) => setInput(e.target.value)}
				onPaste={(e) => {
					const files = Array.from(e.clipboardData?.files ?? []);
					if (files.length > 0) {
						e.preventDefault();
						void uploadFiles(files);
					}
				}}
				onKeyDown={(event) => handleComposerKeyDown(event, props)}
				role="combobox"
				aria-expanded={pickerOpen}
				aria-controls="slash-picker"
				aria-autocomplete="list"
				aria-activedescendant={
					pickerOpen ? `slash-picker-opt-${pickerIndex}` : undefined
				}
				rows={1}
				placeholder={composerPlaceholder(
					voice,
					wsStatus,
					activeSkill,
					isRunning,
				)}
				disabled={wsStatus !== "connected" || voice.phase === "transcribing"}
				className={`flex-1 min-w-0 resize-none bg-transparent py-3 pr-2 text-sm text-foreground focus:outline-none disabled:opacity-30 overflow-y-hidden min-h-[60px] md:min-h-[120px] ${wsStatus !== "connected" ? "placeholder:text-foreground/50" : "placeholder:text-muted-foreground/35"}`}
			/>
			<span className="sr-only" aria-live="polite">
				{voiceAnnouncement(voice)}
			</span>
		</>
	);
}

function ChatActionButtons({
	runtime,
	canSend,
	canQueue,
	handleSend,
	handleClear,
}: ChatComposerProps) {
	const { send, isRunning, messages } = runtime;
	return (
		<>
			{isRunning && (
				<button
					type="button"
					onClick={() => send({ type: "abort" })}
					className="px-2.5 md:px-4 py-3 text-[10px] tracking-widest text-destructive/70 hover:text-destructive transition-colors shrink-0 uppercase font-bold"
					aria-label="Abort"
				>
					STOP
				</button>
			)}
			{isRunning ? (
				<button
					type="button"
					onClick={() => handleSend()}
					disabled={!canQueue}
					className="px-2.5 md:px-4 py-3 text-[10px] tracking-widest text-primary/70 hover:text-primary disabled:text-muted-foreground/35 transition-colors shrink-0 uppercase font-bold"
					aria-label="Queue message"
				>
					QUEUE
				</button>
			) : (
				<button
					type="button"
					onClick={() => handleSend()}
					disabled={!canSend}
					className="px-4 py-3 text-[10px] tracking-widest text-primary/70 hover:text-primary disabled:text-muted-foreground/35 transition-colors shrink-0 uppercase font-bold"
					aria-label="Send"
				>
					RUN
				</button>
			)}
			{messages.length > 0 && (
				<button
					type="button"
					onClick={handleClear}
					className="px-3 py-3 text-muted-foreground/45 hover:text-muted-foreground transition-colors shrink-0"
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
type RavenVoice = ReturnType<typeof useVoiceInput>;

interface ChatComposerProps {
	interactiveMode: boolean;
	config: RavenConfig;
	agentList: RavenAgentList;
	session: RavenSessionIdentity;
	runtime: RavenChatRuntime;
	upload: RavenUpload;
	viewport: RavenViewport;
	picker: RavenPicker;
	voice: RavenVoice;
	input: string;
	setInput: ReturnType<typeof useDraft>["setInput"];
	activeSkill: ActiveRavenSkill | null;
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
	setSessionSelection: Dispatch<SetStateAction<RavenSessionSelection>>;
	actualModelShort: string | null;
	modelMismatch: boolean;
	activeProviderId: string;
	activeProviderLabel: string;
	configuredProviderId: string;
	configuredProviderLabel: string;
	configuredModelShort: string | null;
	configuredSelection: RavenSessionSelection;
	providers: RavenProviders;
	modelPickerOptions: ReturnType<typeof modelOptions>;
	permissionOptions: NonNullable<RavenProviders[number]["permissionModes"]>;
	effortOptions: ReturnType<typeof effortOptionsFor>;
	canSend: boolean;
	canQueue: boolean;
	handleSkillSelect: (command: CommandDescriptor) => void;
	handleSend: (overrideText?: string) => void;
	handleClear: () => void;
	hideOnMobile?: boolean;
}

function ChatComposer(props: ChatComposerProps) {
	const {
		interactiveMode,
		agentList,
		session,
		runtime,
		picker,
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
			{pickerOpen && (
				<SlashPicker
					items={pickerItems}
					selectedIndex={pickerIndex}
					onSelect={handleSkillSelect}
					direction="up"
				/>
			)}
			{agentSkillContext && (
				<div className="absolute -top-5 left-3 z-10">
					<button
						type="button"
						className="text-[9px] tracking-widest px-2 py-0.5 uppercase bg-background border border-primary/30 text-primary/60 cursor-default"
					>
						<PrivacyMask inline>
							{agentList.find((a) => a.path === agentSkillContext)?.name ??
								agentSkillContext.split("/").pop() ??
								"agent"}
						</PrivacyMask>
					</button>
				</div>
			)}
			<ChatModelBadge {...props} />

			{/* Auto-sleep banner */}
			{sleepState && (
				<div className="border-t border-primary/30 bg-primary/5 px-4 py-2 flex items-center justify-between gap-4">
					<span className="text-[10px] tracking-widest text-primary/70 uppercase">
						sleeping
						{sleepState.until
							? ` until ${new Date(sleepState.until * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
							: ""}
						{sleepState.utilization != null
							? ` — usage window at ${Math.round(sleepState.utilization * 100)}%`
							: sleepState.reason === "limit_reached"
								? " — usage limit reached"
								: ""}
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
			{sessionState === "error" && (
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
