import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Paperclip, ShieldCheck, SquarePen, X } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AgentSelect } from "#/components/AgentSelect";
import { AttachmentStrip } from "#/components/AttachmentStrip";
import { reducer } from "#/components/chat/chatReducer";
import { MessageList } from "#/components/chat/MessageList";
import { PrivacyMask } from "#/components/PrivacyMask";
import {
	ContextWindowSection,
	UsageWindowsPanel,
} from "#/components/UsageWindowsPanel";
import { getConfig } from "#/config";
import { useChatWsHandler } from "#/hooks/useChatWsHandler";
import { useDraft } from "#/hooks/useDraft";
import { useFileUpload } from "#/hooks/useFileUpload";
import { useLoadChatHistory } from "#/hooks/useLoadChatHistory";
import { useWs } from "#/hooks/useWs";
import { useWsChatQueue, useWsLiveStats } from "#/hooks/useWsSelectors";
import * as wsStore from "#/hooks/wsStore";
import { deriveModelMismatch, fmtModel } from "#/lib/formatters";
import {
	getAgentListFn,
	getCurrentSessionFn,
	getSessionAgentCwdFn,
	getUsageWindowsFn,
} from "#/lib/serverFns";
import { uid } from "#/lib/utils";
import { decisionFromScope, type RateLimitMessage } from "#/server/protocol";

// ─── route ───────────────────────────────────────────────────────────────────

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
	loader: async ({ deps: { session, agent } }) => {
		const [config, dbSessionId, usageWindows, agentList] = await Promise.all([
			getConfig(),
			session ? Promise.resolve(null) : getCurrentSessionFn(),
			getUsageWindowsFn(),
			getAgentListFn(),
		]);
		const resolvedSessionId = session ?? dbSessionId;
		let agentSkillContext = agent;
		if (!agentSkillContext && resolvedSessionId) {
			agentSkillContext =
				(await getSessionAgentCwdFn({ data: resolvedSessionId })) ?? undefined;
		}
		return {
			config,
			existingSessionId: resolvedSessionId,
			// true = session came from URL param (explicit open/resume)
			// false = session resolved via getCurrentSessionFn (implicit resume on fresh nav)
			isExplicitSession: !!session,
			usageWindows,
			agentSkillContext,
			agentList,
		};
	},
	component: ChatPage,
});

// ─── Page ─────────────────────────────────────────────────────────────────────

function ChatPage() {
	const {
		config,
		existingSessionId,
		isExplicitSession,
		usageWindows: initialUsageWindows,
		agentSkillContext: initialAgentSkillContext,
		agentList,
	} = Route.useLoaderData();
	const [agentSkillContext, setAgentSkillContext] = useState(
		initialAgentSkillContext,
	);
	const agentContextSentRef = useRef(false);
	const [sessionId, setSessionId] = useState(() => existingSessionId ?? uid());
	const sessionIdRef = useRef(sessionId);
	useEffect(() => {
		sessionIdRef.current = sessionId;
	}, [sessionId]);

	const liveStats = useWsLiveStats();
	const chatQueue = useWsChatQueue();
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const [messages, dispatch] = useReducer(reducer, []);
	const { prompt: seededPrompt } = Route.useSearch();
	const navigate = useNavigate();
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
	const {
		pendingAttachments,
		uploadingCount,
		uploadError,
		gitignoreHint,
		uploadFiles,
		removePending,
		clearPending: clearPendingAttachments,
		setPendingAttachments,
		dismissGitignoreHint,
	} = useFileUpload({ agentCwd: agentSkillContext, sessionId });
	const [planMode, setPlanMode] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const [showModelPopup, setShowModelPopup] = useState(false);
	const modelBadgeRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const pendingIdRef = useRef<string | null>(null);
	const lastAssistantIdRef = useRef<string | null>(null);
	// Tracks whether initial history load is done so the isRunning effect doesn't race it
	const historyReadyRef = useRef(!existingSessionId);
	const bottomRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const atBottomRef = useRef(true);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// ─── Session navigation reset ─────────────────────────────────────────────
	// TanStack Router re-renders (not remounts) on same-route navigation with
	// different search params. Client state must be explicitly reset when the
	// user switches to a different session so it doesn't bleed across sessions.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset on session navigation only
	useEffect(() => {
		setRateLimit(null);
		setAgentSkillContext(initialAgentSkillContext);
		agentContextSentRef.current = false;
	}, [existingSessionId]);

	// ─── WS message routing ───────────────────────────────────────────────────

	const handleWsMessage = useChatWsHandler({
		dispatch,
		pendingIdRef,
		lastAssistantIdRef,
		historyReadyRef,
		sessionIdRef,
		setRateLimit,
	});

	// ─── History loading ──────────────────────────────────────────────────────

	// ─── WS connection ────────────────────────────────────────────────────────

	const { wsStatus, sessionState, model, actualModel, runningTurnId, send } =
		useWs(handleWsMessage);

	useLoadChatHistory({
		existingSessionId,
		isExplicitSession,
		dispatch,
		pendingIdRef,
		historyReadyRef,
		handleWsMessage,
		wsStatus,
		sessionIdRef,
	});

	// If session is running but no pending assistant turn exists, add one.
	// Guard with historyReadyRef so we don't race the initial DB load.
	const isRunning = sessionState === "running";
	useEffect(() => {
		if (!isRunning || !historyReadyRef.current || pendingIdRef.current) return;
		const newId = uid();
		pendingIdRef.current = newId;
		dispatch({ type: "ADD_ASSISTANT", id: newId });
	}, [isRunning]);

	// ─── Handlers ─────────────────────────────────────────────────────────────

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
		[send],
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
		[send],
	);

	const handlePlanDecide = useCallback(
		(
			id: string,
			decision: "approved" | "edited" | "cancelled",
			feedback?: string,
		) => {
			dispatch({ type: "RESOLVE_PLAN_PROPOSAL", id, decision });
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
		[send],
	);

	const handleSend = useCallback(() => {
		const text = input.trim();
		if (!text && pendingAttachments.length === 0) return;

		if (sessionState === "running") {
			wsStore.enqueueChat({
				id: uid(),
				text,
				session_id: sessionId,
				attachments:
					pendingAttachments.length > 0 ? [...pendingAttachments] : undefined,
				agent_cwd: agentSkillContext ?? undefined,
			});
			clearDraft();
			setInput("");
			clearPendingAttachments();
			return;
		}

		atBottomRef.current = true;
		const id = uid();
		const attachments = pendingAttachments;
		dispatch({ type: "ADD_USER", id, text, attachments });
		const agentCwdToSend =
			agentSkillContext && !agentContextSentRef.current
				? agentSkillContext
				: undefined;
		if (agentCwdToSend) agentContextSentRef.current = true;
		wsStore.setActiveSessionId(sessionId);
		send({
			type: "chat",
			text,
			session_id: sessionId,
			attachments: attachments.length > 0 ? attachments : undefined,
			agent_cwd: agentCwdToSend,
			plan_mode: planMode || undefined,
		});
		clearDraft();
		setInput("");
		clearPendingAttachments();
	}, [
		input,
		setInput,
		sessionState,
		send,
		sessionId,
		pendingAttachments,
		agentSkillContext,
		clearDraft,
		clearPendingAttachments,
		planMode,
	]);

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
		[input, setInput, pendingAttachments.length, setPendingAttachments],
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
		[chatQueue],
	);

	const handleClear = useCallback(() => {
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
	}, [send, clearDraft]);

	// ─── Scroll management ────────────────────────────────────────────────────

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			atBottomRef.current =
				el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: messages is trigger
	useEffect(() => {
		if (atBottomRef.current) {
			bottomRef.current?.scrollIntoView({ behavior: "smooth" });
		}
	}, [messages]);

	// ─── Textarea auto-resize ─────────────────────────────────────────────────

	// biome-ignore lint/correctness/useExhaustiveDependencies: input length triggers resize
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		const maxH = window.innerWidth < 768 ? 240 : 480;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
	}, [input]);

	// ─── Model popup dismiss ──────────────────────────────────────────────────

	// Dismiss the model detail popup on any click outside the badge.
	useEffect(() => {
		if (!showModelPopup) return;
		const handleClick = (e: MouseEvent) => {
			if (
				modelBadgeRef.current &&
				!modelBadgeRef.current.contains(e.target as Node)
			) {
				setShowModelPopup(false);
			}
		};
		document.addEventListener("click", handleClick);
		return () => document.removeEventListener("click", handleClick);
	}, [showModelPopup]);

	// ─── Derived state ────────────────────────────────────────────────────────

	const hasInput =
		(input.trim().length > 0 || pendingAttachments.length > 0) &&
		uploadingCount === 0 &&
		wsStatus === "connected";
	const canSend = hasInput && !isRunning;
	const canQueue = hasInput && isRunning;

	const modelShort = model ? fmtModel(model) : null;
	const agentModel =
		(agentSkillContext &&
			agentList.find((a) => a.path === agentSkillContext)?.model) ||
		null;
	const { effectiveActualModel, mismatch: modelMismatch } = deriveModelMismatch(
		model,
		actualModel,
		agentModel,
	);
	const actualModelShort = effectiveActualModel
		? fmtModel(effectiveActualModel)
		: null;

	// ─── Render ───────────────────────────────────────────────────────────────

	return (
		<div className="h-full flex flex-col">
			<UsageWindowsPanel
				initial={initialUsageWindows}
				liveQueryCount={liveStats?.queries ?? 0}
				rateLimit={rateLimit}
				fetchFn={getUsageWindowsFn}
				tail={<ContextWindowSection stats={liveStats} />}
			/>

			{/* Messages, inner min-h-full + justify-end anchors messages to bottom */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden">
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

			{/* Bottom bar, wrapper is relative so model badge floats above entire block */}
			<div className="shrink-0 relative">
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
				{modelShort && (
					<div ref={modelBadgeRef} className="absolute -top-5 right-3 z-10">
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								if (modelMismatch) setShowModelPopup((v) => !v);
							}}
							className={`text-[9px] tracking-widest px-2 py-0.5 uppercase bg-background border ${
								modelMismatch
									? "text-amber-500/80 border-amber-500/60 cursor-pointer"
									: "text-muted-foreground/50 border-border/70 cursor-default"
							}`}
						>
							{actualModelShort ?? modelShort}
						</button>
						{showModelPopup && modelMismatch && (
							<div className="absolute bottom-full right-0 mb-1.5 bg-background border border-amber-500/40 px-3 py-2 text-[9px] tracking-widest uppercase whitespace-nowrap space-y-0.5">
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

				{/* Input */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone wraps the input, interactive children handle keyboard input */}
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
					{gitignoreHint && (
						<div className="px-4 py-2 flex items-start gap-2 border-b border-border/40 bg-yellow-500/5">
							<div className="flex-1 text-[10px] text-foreground/70 leading-relaxed">
								<span className="text-yellow-500/80">tip:</span> attachments
								stored at{" "}
								<code className="text-[10px] font-mono text-foreground/90">
									{gitignoreHint.agent_root}/.hlid/
								</code>
								. Add{" "}
								<code className="text-[10px] font-mono text-foreground/90">
									.hlid/
								</code>{" "}
								to <code className="text-[10px] font-mono">.gitignore</code> if
								this is a git repo.
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
					{messages.length === 0 && (
						<div className="flex items-center gap-3 px-4 py-1.5 border-b border-border/40">
							{agentList.length > 0 && (
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
								title="Enable plan mode — Claude plans before acting"
								className={`flex items-center gap-1.5 text-[9px] tracking-widest uppercase transition-colors shrink-0 ${
									planMode
										? "text-primary border-b border-primary/50"
										: "text-muted-foreground/40 hover:text-muted-foreground/70"
								}`}
							>
								<ShieldCheck className="w-3 h-3" />
								plan
							</button>
						</div>
					)}
					<div className="flex items-start">
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
							onKeyDown={(e) => {
								const isTouch =
									typeof window !== "undefined" &&
									window.matchMedia("(pointer: coarse)").matches;
								if (
									e.key === "Enter" &&
									!e.shiftKey &&
									!isTouch &&
									config.ui.enter_to_submit
								) {
									e.preventDefault();
									handleSend();
								}
							}}
							rows={1}
							placeholder={
								wsStatus !== "connected"
									? "connecting…"
									: isRunning
										? "type to queue next…"
										: "speak to the watcher…"
							}
							disabled={wsStatus !== "connected"}
							className={`flex-1 resize-none bg-transparent py-3 pr-2 text-sm text-foreground focus:outline-none disabled:opacity-30 overflow-y-hidden min-h-[60px] md:min-h-[120px] ${wsStatus !== "connected" ? "placeholder:text-foreground/50" : "placeholder:text-muted-foreground/35"}`}
						/>
						{isRunning && (
							<button
								type="button"
								onClick={() => send({ type: "abort" })}
								className="px-4 py-3 text-[10px] tracking-widest text-destructive/70 hover:text-destructive transition-colors shrink-0 uppercase font-bold"
								aria-label="Abort"
							>
								STOP
							</button>
						)}
						{isRunning ? (
							<button
								type="button"
								onClick={handleSend}
								disabled={!canQueue}
								className="px-4 py-3 text-[10px] tracking-widest text-muted-foreground/50 hover:text-primary disabled:text-muted-foreground/20 transition-colors shrink-0 uppercase font-bold"
								aria-label="Queue message"
							>
								Q→
							</button>
						) : (
							<button
								type="button"
								onClick={handleSend}
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
					</div>
				</div>
			</div>
		</div>
	);
}
