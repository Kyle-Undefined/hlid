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
import { PrivacyMask } from "#/components/PrivacyMask";
import { TerminalView } from "#/components/TerminalView";
import { ProviderUsageStrip } from "#/components/usage/ProviderUsageStrip";
import { ContextWindowSection } from "#/components/usage/UsageWindowSections";
import { getConfig } from "#/config";
import { useChatWsHandler } from "#/hooks/useChatWsHandler";
import { useDraft } from "#/hooks/useDraft";
import { useFileUpload } from "#/hooks/useFileUpload";
import { useLoadChatHistory } from "#/hooks/useLoadChatHistory";
import { useMergedSkills } from "#/hooks/useMergedSkills";
import { useSlashPicker } from "#/hooks/useSlashPicker";
import { useVoiceInput } from "#/hooks/useVoiceInput";
import { useWs } from "#/hooks/useWs";
import { useWsChatQueue, useWsLiveStats } from "#/hooks/useWsSelectors";
import * as wsStore from "#/hooks/wsStore";
import {
	composerKeyAction,
	insertAtSelection,
	prepareChatSubmission,
	resizeComposer,
	responsiveComposerMaxHeight,
} from "#/lib/composer";
import { deriveModelMismatch, fmtModel } from "#/lib/formatters";
import {
	effortOptionsFor,
	modelOptions,
	resolveActiveProviderId,
} from "#/lib/providerOptions";
import { scrollChatToBottom } from "#/lib/scrollContainers";
import { getAgentListFn } from "#/lib/serverFns/agents";
import { getCockpitData } from "#/lib/serverFns/cockpit";
import { getProvidersFn, loadProviderUsages } from "#/lib/serverFns/providers";
import {
	ensureSessionFn,
	getCurrentSessionFn,
	getLiveSessionsFn,
	getSessionAgentCwdFn,
} from "#/lib/serverFns/sessions";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";
import { resolveSkillPrompt } from "#/lib/skillPrompt";
import type { Skill } from "#/lib/skills";
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
	if (!agentSkillContext && resolvedSessionId) {
		agentSkillContext =
			(await getSessionAgentCwdFn({ data: resolvedSessionId })) ?? undefined;
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
type ActiveRavenSkill = {
	name: string;
	section?: string;
	filePath: string;
};
type RavenSessionSelection = {
	model?: string;
	effort?: string;
	permissionMode?: string;
};

function useRavenSessionIdentity({
	config,
	existingSessionId,
	interactiveMode,
	initialAgentSkillContext,
	navigate,
}: {
	config: RavenConfig;
	existingSessionId: string | null;
	interactiveMode: boolean;
	initialAgentSkillContext: string | undefined;
	navigate: RavenNavigate;
}) {
	const [agentSkillContext, setAgentSkillContext] = useState(
		initialAgentSkillContext,
	);
	const agentContextSentRef = useRef(false);
	const sessionsStatus = useSyncExternalStore(
		wsStore.subscribeSessionsStatus,
		wsStore.getSessionsStatus,
		() => [],
	);
	const [sessionId, setSessionId] = useState(
		() => existingSessionId ?? (interactiveMode ? "" : uid()),
	);
	const sessionIdRef = useRef(sessionId);

	const handleNewTerminalSession = useCallback(() => {
		const newId = uid();
		setSessionId(newId);
		sessionIdRef.current = newId;
		void navigate({
			to: "/raven",
			search: (previous) => ({ ...previous, session: undefined }),
			replace: true,
		});
	}, [navigate]);

	useEffect(() => {
		sessionIdRef.current = sessionId;
	}, [sessionId]);

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
		agentContextSentRef,
		sessionId,
		setSessionId,
		sessionIdRef,
		handleNewTerminalSession,
	};
}

function useRavenChatRuntime({
	existingSessionId,
	isExplicitSession,
	sessionIdRef,
}: {
	existingSessionId: string | null;
	isExplicitSession: boolean;
	sessionIdRef: { current: string };
}) {
	const [sdkSlashCommands, setSdkSlashCommands] = useState<
		Array<{
			name: string;
			description: string;
			argumentHint: string;
			aliases?: string[];
		}>
	>([]);
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
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
			if (message.type === "slash_commands") {
				setSdkSlashCommands(message.commands);
				return;
			}
			handleWsMessage(message);
		},
		[handleWsMessage],
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

	useEffect(() => {
		connection.send({ type: "probe_slash_commands" });
	}, [connection.send]);

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
		const onViewportChange = () => {
			resizeTextarea();
			// Keyboard open/close resizes the chat shell (--app-height); keep the
			// transcript pinned to the bottom instead of leaving it mid-scroll.
			if (atBottomRef.current) scrollChatToBottom(scrollRef.current, "auto");
		};
		window.addEventListener("resize", onViewportChange);
		visualViewport?.addEventListener("resize", onViewportChange);
		return () => {
			window.removeEventListener("resize", onViewportChange);
			visualViewport?.removeEventListener("resize", onViewportChange);
		};
	}, [resizeTextarea]);

	useEffect(() => {
		if (!showModelPopup) return;
		const handleClick = (event: MouseEvent) => {
			if (!modelBadgeRef.current?.contains(event.target as Node))
				setShowModelPopup(false);
		};
		document.addEventListener("click", handleClick);
		return () => document.removeEventListener("click", handleClick);
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
	allSkills: ReturnType<typeof useMergedSkills>;
	planMode: boolean;
	setPlanMode: Dispatch<SetStateAction<boolean>>;
	planHtml: boolean;
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
		allSkills,
		planMode,
		planHtml,
	} = props;
	const { agentSkillContext, agentContextSentRef, sessionId } = props.session;
	const { sessionState, send, dispatch } = props.runtime;
	const { pendingAttachments, clearPending: clearPendingAttachments } =
		props.upload;
	const { atBottomRef } = props.viewport;

	return useCallback(
		(overrideText?: string) => {
			const typed = (overrideText ?? input).trim();

			const { text, skillContext } = resolveSkillPrompt(
				activeSkill,
				typed,
				allSkills,
			);
			const id = uid();
			const submission = prepareChatSubmission({
				id,
				text,
				sessionId,
				running: sessionState === "running",
				skillContext,
				attachments: pendingAttachments,
				agentCwd: agentSkillContext ?? undefined,
				agentContextAlreadySent: agentContextSentRef.current,
				planMode,
				planHtml,
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
			allSkills,
			sessionState,
			send,
			sessionId,
			pendingAttachments,
			agentSkillContext,
			clearDraft,
			clearPendingAttachments,
			planMode,
			planHtml,
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
	const { clearDraft, setPlanMode } = props;
	const {
		setAgentSkillContext,
		agentContextSentRef,
		setSessionId,
		sessionIdRef,
	} = props.session;
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
		wsStore.resetLiveStats();
		wsStore.seedActualModel(null);
		wsStore.clearMessageBuffer();
		wsStore.clearChatQueue();
		const newId = uid();
		setSessionId(newId);
		sessionIdRef.current = newId;
		setAgentSkillContext(undefined);
	}, [
		send,
		clearDraft,
		pendingIdRef,
		lastAssistantIdRef,
		agentContextSentRef,
		dispatch,
		setSessionId,
		sessionIdRef,
		setAgentSkillContext,
		setPlanMode,
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
	const agentModel = selectedAgent?.model ?? null;
	const selectedModel = selection.model ?? selectedAgent?.model ?? model;
	const selectedEffort = selection.effort ?? selectedAgent?.effort ?? null;
	const selectedPermissionMode =
		selection.permissionMode ?? selectedAgent?.permission_mode ?? null;
	const { effectiveActualModel, mismatch: modelMismatch } = deriveModelMismatch(
		selectedModel,
		agentSkillContext ? null : actualModel,
		agentModel,
	);
	const providerId = resolveActiveProviderId(
		agentList,
		agentSkillContext,
		config.vault_provider,
	);
	const provider = providers.find((candidate) => candidate.id === providerId);
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
		modelPickerOptions: modelOptions(provider),
		permissionOptions: provider?.permissionModes ?? [],
		effortOptions: effortOptionsFor(provider, selectedModel ?? ""),
	};
}

export function ChatPage() {
	const {
		config,
		existingSessionId,
		isExplicitSession,
		providerUsages: initialProviderUsages,
		agentSkillContext: initialAgentSkillContext,
		agentList,
		vaultSkills,
		interactiveMode,
		providers,
		voiceInfo: initialVoiceInfo,
	} = Route.useLoaderData();
	const navigate = useNavigate();
	const session = useRavenSessionIdentity({
		config,
		existingSessionId,
		interactiveMode,
		initialAgentSkillContext,
		navigate,
	});
	const { agentSkillContext, sessionId, sessionIdRef } = session;
	const [activeSkill, setActiveSkill] = useState<ActiveRavenSkill | null>(null);
	const [sessionSelection, setSessionSelection] =
		useState<RavenSessionSelection>({});
	// biome-ignore lint/correctness/useExhaustiveDependencies: changing project/provider resets session-only picker overrides
	useEffect(() => setSessionSelection({}), [agentSkillContext]);

	const liveStats = useWsLiveStats();
	const chatQueue = useWsChatQueue();
	const runtime = useRavenChatRuntime({
		existingSessionId,
		isExplicitSession,
		sessionIdRef,
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
	const { prompt: seededPrompt } = Route.useSearch();
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

	const allSkills = useMergedSkills(vaultSkills, sdkSlashCommands);

	const picker = useSlashPicker(input, allSkills, activeSkill);

	function handleSkillSelect(skill: Skill) {
		focusSkillOnNextRender();
		setActiveSkill({
			name: skill.name,
			section: skill.section,
			filePath: skill.filePath,
		});
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
		allSkills,
		planMode,
		setPlanMode,
		planHtml,
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
				fetchFn={loadProviderUsages}
				tail={<ContextWindowSection stats={liveStats} />}
			/>

			<RavenTerminalPane {...props} />
			{!interactiveMode && terminalOpen && (
				<RavenShellTabBar activeTab={shellTab} setActiveTab={setShellTab} />
			)}
			<RavenMessagePane {...props} />
			{!interactiveMode && <RavenShellPane {...props} />}
			<ChatComposer {...composerProps} />
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
	modelPickerOptions,
	permissionOptions,
	effortOptions,
}: ChatComposerProps) {
	const { model, permissionMode, effort, send } = runtime;
	const displayedModel = activeModel ?? model;
	const displayedEffort = activeEffort ?? effort;
	const displayedPermissionMode = activePermissionMode ?? permissionMode;
	const badgeParts = [
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
			{modelShort && (
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
										<span className="text-muted-foreground/50">vault </span>
										<span className="text-foreground/60">{modelShort}</span>
									</div>
									<div>
										<span className="text-muted-foreground/50">agent </span>
										<span className="text-amber-400">{actualModelShort}</span>
									</div>
								</div>
							)}
							<OptionGroup
								label="model"
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
									send({ type: "set_model", model: value });
									setShowModelPopup(false);
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
									send({ type: "set_effort", effort: value });
									setShowModelPopup(false);
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
									send({ type: "set_permission_mode", mode: value });
									setShowModelPopup(false);
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
			className={`border-t border-border bg-background transition-colors relative z-0 ${
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
}: ChatComposerProps) {
	const { agentSkillContext, setAgentSkillContext, agentContextSentRef } =
		session;
	const { messages } = runtime;
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
			<div className="flex items-center gap-3 px-4 py-1.5 border-b border-border/40">
				{messages.length === 0 && agentList.length > 0 && (
					<AgentSelect
						agents={agentList}
						value={agentSkillContext ?? ""}
						onChange={(val) => {
							setAgentSkillContext(val || undefined);
							agentContextSentRef.current = false;
						}}
					/>
				)}
				<button
					type="button"
					onClick={() => setPlanMode((v) => !v)}
					title="Enable plan mode — the agent plans before acting"
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
	modelPickerOptions: ReturnType<typeof modelOptions>;
	permissionOptions: NonNullable<RavenProviders[number]["permissionModes"]>;
	effortOptions: ReturnType<typeof effortOptionsFor>;
	canSend: boolean;
	canQueue: boolean;
	handleSkillSelect: (skill: Skill) => void;
	handleSend: (overrideText?: string) => void;
	handleClear: () => void;
}

function ChatComposer(props: ChatComposerProps) {
	const {
		interactiveMode,
		agentList,
		session,
		runtime,
		picker,
		handleSkillSelect,
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
		<div className="shrink-0 relative">
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
