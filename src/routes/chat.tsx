import { createFileRoute } from "@tanstack/react-router";
import { Check, ChevronRight, SquarePen, X } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StatusDot } from "#/components/nav/StatusDot";
import { getConfig } from "#/config";
import { useWs } from "#/hooks/useWs";
import * as wsStore from "#/hooks/wsStore";
import { uid } from "#/lib/utils";
import type {
	PermissionRequestMessage,
	ServerMessage,
	ToolEventMessage,
} from "#/server/protocol";

function normalizeMd(text: string): string {
	// CommonMark: "** text **" doesn't bold (space after opener). Normalize.
	return text.replace(/\*\*\s+((?:[^*\n]|\*(?!\*))+?)\s+\*\*/g, "**$1**");
}

export const Route = createFileRoute("/chat")({
	loader: () => getConfig(),
	component: ChatPage,
});

// ─── Message types ────────────────────────────────────────────────────────────

type UserMessage = {
	id: string;
	role: "user";
	text: string;
};

type AssistantMessage = {
	id: string;
	role: "assistant";
	text: string;
	toolEvents: ToolEventMessage[];
	streaming: boolean;
	cost: number | null;
};

type PermissionMessage = {
	id: string;
	role: "permission";
	toolName: string;
	title: string;
	displayName?: string;
	description?: string;
	decision: "pending" | "approved" | "denied";
};

type ChatMessage = UserMessage | AssistantMessage | PermissionMessage;

// ─── Reducer ─────────────────────────────────────────────────────────────────

type Action =
	| { type: "ADD_USER"; id: string; text: string }
	| { type: "ADD_ASSISTANT"; id: string }
	| { type: "APPEND_CHUNK"; id: string; text: string }
	| { type: "ADD_TOOL_EVENT"; id: string; event: ToolEventMessage }
	| { type: "DONE"; id: string; cost: number | null }
	| { type: "ADD_PERMISSION"; msg: PermissionRequestMessage }
	| { type: "RESOLVE_PERMISSION"; id: string; decision: "approved" | "denied" }
	| { type: "CLEAR" };

function reducer(state: ChatMessage[], action: Action): ChatMessage[] {
	switch (action.type) {
		case "ADD_USER":
			return [...state, { id: action.id, role: "user", text: action.text }];
		case "ADD_ASSISTANT":
			return [
				...state,
				{
					id: action.id,
					role: "assistant",
					text: "",
					toolEvents: [],
					streaming: true,
					cost: null,
				},
			];
		case "APPEND_CHUNK":
			return state.map((m) =>
				m.id === action.id && m.role === "assistant"
					? { ...m, text: m.text + action.text }
					: m,
			);
		case "ADD_TOOL_EVENT":
			return state.map((m) =>
				m.id === action.id && m.role === "assistant"
					? { ...m, toolEvents: [...m.toolEvents, action.event] }
					: m,
			);
		case "DONE":
			return state.map((m) =>
				m.id === action.id && m.role === "assistant"
					? { ...m, streaming: false, cost: action.cost }
					: m,
			);
		case "ADD_PERMISSION":
			return [
				...state,
				{
					id: action.msg.id,
					role: "permission",
					toolName: action.msg.toolName,
					title: action.msg.title,
					displayName: action.msg.displayName,
					description: action.msg.description,
					decision: "pending",
				},
			];
		case "RESOLVE_PERMISSION":
			return state.map((m) =>
				m.id === action.id && m.role === "permission"
					? { ...m, decision: action.decision }
					: m,
			);
		case "CLEAR":
			return [];
	}
}

// ─── Components ───────────────────────────────────────────────────────────────

function ToolBlock({ event }: { event: ToolEventMessage }) {
	const [open, setOpen] = useState(false);
	const pills = Object.entries(event.input ?? {}).slice(0, 3);

	return (
		<div className="my-0.5">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center gap-2.5 w-full px-3 py-1.5 group hover:bg-primary/[0.03] transition-colors text-left"
			>
				<ChevronRight
					className={`w-3 h-3 shrink-0 text-sky-600/60 group-hover:text-sky-500/80 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
				/>
				<span className="text-[11px] font-medium tracking-wider text-sky-400/70 group-hover:text-sky-400/90 shrink-0">
					{event.name}
				</span>
				<div className="flex gap-1.5 flex-wrap">
					{pills.map(([k, v]) => (
						<span
							key={k}
							className="text-[9px] tracking-wide border border-sky-900/40 text-sky-600/50 px-1.5 py-0.5 font-mono"
						>
							{k}: {String(v).slice(0, 24)}
							{String(v).length > 24 ? "…" : ""}
						</span>
					))}
				</div>
			</button>
			{open && (
				<div className="mx-3 mb-1.5 border border-[var(--tool-panel-border)] bg-[var(--tool-panel)]">
					<pre className="text-[11px] text-sky-300/60 font-mono leading-relaxed p-3 overflow-auto max-h-48">
						{JSON.stringify(event.input, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}

function PermissionCard({
	message,
	onDecide,
}: {
	message: PermissionMessage;
	onDecide: (id: string, approved: boolean) => void;
}) {
	const pending = message.decision === "pending";

	if (!pending) {
		return (
			<div className="flex gap-0">
				<div className="w-12 shrink-0 text-[9px] tracking-widest text-muted-foreground/30 pt-0.5 uppercase">
					PERM
				</div>
				<div className="flex items-center gap-2 text-xs text-muted-foreground/50">
					{message.decision === "approved" ? (
						<Check className="w-3 h-3 text-green-600/60" />
					) : (
						<X className="w-3 h-3 text-destructive/60" />
					)}
					<span className="tracking-wider text-[10px]">
						{(message.displayName ?? message.toolName).toUpperCase()}{" "}
						{message.decision === "approved" ? "APPROVED" : "DENIED"}
					</span>
				</div>
			</div>
		);
	}

	return (
		<div className="flex gap-0">
			<div className="w-12 shrink-0 text-[9px] tracking-widest text-primary/40 pt-0.5 uppercase">
				PERM
			</div>
			<div className="flex-1 border border-border bg-card">
				<div className="px-4 py-3 border-b border-border">
					<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase mb-1">
						PERMISSION REQUEST
					</div>
					<div className="text-sm text-foreground">{message.title}</div>
					{message.description && (
						<div className="text-xs text-muted-foreground/60 mt-1">
							{message.description}
						</div>
					)}
				</div>
				<div className="flex divide-x divide-border">
					<button
						type="button"
						onClick={() => onDecide(message.id, false)}
						className="flex-1 flex items-center justify-center gap-2 py-2 text-[10px] tracking-widest text-destructive/70 hover:bg-destructive/5 transition-colors uppercase"
					>
						<X className="w-3 h-3" />
						DENY
					</button>
					<button
						type="button"
						onClick={() => onDecide(message.id, true)}
						className="flex-1 flex items-center justify-center gap-2 py-2 text-[10px] tracking-widest text-green-500/70 hover:bg-green-500/5 transition-colors uppercase"
					>
						<Check className="w-3 h-3" />
						APPROVE
					</button>
				</div>
			</div>
		</div>
	);
}

// inspo.png flat-row style: right-aligned with "YOU" label on far right
function UserMsg({ message }: { message: UserMessage }) {
	return (
		<div className="flex items-start gap-3 py-3 border-b border-border/40">
			<div className="flex-1" />
			<div className="text-sm text-foreground/90 whitespace-pre-wrap text-right max-w-[78%] leading-relaxed">
				{message.text}
			</div>
			<div className="text-[9px] tracking-widest text-primary/40 shrink-0 pt-0.5 w-11 text-right">
				ME
			</div>
		</div>
	);
}

// inspo.png flat-row: left label, text block, right cost metadata
function AssistantMsg({ message }: { message: AssistantMessage }) {
	return (
		<div className="py-3 border-b border-border/40 space-y-1.5">
			{message.toolEvents.map((e) => (
				<ToolBlock key={e.id} event={e} />
			))}
			{(message.text || message.streaming) && (
				<div className="flex items-start gap-0">
					<div className="shrink-0 pt-0.5 w-12 flex">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 32 32"
							className="w-4 h-4 opacity-40"
							role="img"
							aria-label="Hlid"
						>
							<path
								d="M2 16 C7 6 25 6 30 16 C25 26 7 26 2 16Z"
								fill="none"
								stroke="#38bdf8"
								strokeWidth="1.5"
								strokeLinejoin="round"
							/>
							<circle
								cx="16"
								cy="16"
								r="5.5"
								fill="none"
								stroke="#38bdf8"
								strokeWidth="1.5"
							/>
							<circle cx="16" cy="16" r="2" fill="#38bdf8" />
						</svg>
					</div>
					<div className="flex-1 text-sm text-foreground/90 leading-relaxed pr-4 min-w-0">
						<Markdown
							remarkPlugins={[remarkGfm]}
							components={{
								p: ({ children }) => (
									<p className="mb-3 last:mb-0">{children}</p>
								),
								h1: ({ children }) => (
									<h1 className="text-base font-bold mb-2 mt-4 first:mt-0">
										{children}
									</h1>
								),
								h2: ({ children }) => (
									<h2 className="text-sm font-bold mb-2 mt-4 first:mt-0 tracking-wide">
										{children}
									</h2>
								),
								h3: ({ children }) => (
									<h3 className="text-sm font-semibold mb-1.5 mt-3 first:mt-0">
										{children}
									</h3>
								),
								ul: ({ children }) => (
									<ul className="list-disc pl-5 mb-3 space-y-0.5">
										{children}
									</ul>
								),
								ol: ({ children }) => (
									<ol className="list-decimal pl-5 mb-3 space-y-0.5">
										{children}
									</ol>
								),
								li: ({ children }) => (
									<li className="leading-relaxed">{children}</li>
								),
								code: ({ children, className }) => {
									const isBlock = className?.startsWith("language-");
									return isBlock ? (
										<code className="block bg-secondary/60 border border-border rounded-none px-3 py-2 text-xs font-mono text-foreground/80 overflow-x-auto whitespace-pre mb-3">
											{children}
										</code>
									) : (
										<code className="bg-secondary/80 px-1.5 py-0.5 text-[11px] font-mono text-primary/80 rounded-none">
											{children}
										</code>
									);
								},
								pre: ({ children }) => <pre className="mb-3">{children}</pre>,
								blockquote: ({ children }) => (
									<blockquote className="border-l-2 border-primary/30 pl-3 text-foreground/60 italic mb-3">
										{children}
									</blockquote>
								),
								a: ({ href, children }) => (
									<a
										href={href}
										className="text-primary underline underline-offset-2 hover:text-primary/80"
										target="_blank"
										rel="noreferrer"
									>
										{children}
									</a>
								),
								strong: ({ children }) => (
									<strong className="font-semibold text-foreground">
										{children}
									</strong>
								),
								hr: () => <hr className="border-border my-3" />,
								table: ({ children }) => (
									<div className="overflow-x-auto mb-3">
										<table className="text-xs w-full border-collapse">
											{children}
										</table>
									</div>
								),
								th: ({ children }) => (
									<th className="border border-border px-3 py-1.5 text-left text-[10px] tracking-wider text-muted-foreground bg-secondary/40">
										{children}
									</th>
								),
								td: ({ children }) => (
									<td className="border border-border px-3 py-1.5">
										{children}
									</td>
								),
							}}
						>
							{normalizeMd(message.text)}
						</Markdown>
						{message.streaming && (
							<span className="inline-block w-[7px] h-[1em] ml-0.5 align-middle bg-primary/50 cursor-blink" />
						)}
					</div>
					{!message.streaming && message.cost !== null && (
						<div className="text-[9px] tabular-nums text-muted-foreground/25 shrink-0 pt-0.5 font-mono">
							${message.cost.toFixed(4)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function ChatPage() {
	const { ui } = Route.useLoaderData();
	const [messages, dispatch] = useReducer(reducer, []);
	const [input, setInput] = useState("");
	const pendingIdRef = useRef<string | null>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const handleWsMessage = useCallback((msg: ServerMessage) => {
		const id = pendingIdRef.current;

		if (msg.type === "status" && msg.state === "running" && !id) {
			const newId = uid();
			pendingIdRef.current = newId;
			dispatch({ type: "ADD_ASSISTANT", id: newId });
			return;
		}

		if (msg.type === "permission_request") {
			dispatch({ type: "ADD_PERMISSION", msg });
			return;
		}

		if (!id && (msg.type === "chunk" || msg.type === "tool_event")) {
			const newId = uid();
			pendingIdRef.current = newId;
			dispatch({ type: "ADD_ASSISTANT", id: newId });
		}

		const activeId = pendingIdRef.current;
		if (!activeId) return;

		if (msg.type === "chunk") {
			dispatch({ type: "APPEND_CHUNK", id: activeId, text: msg.text });
		} else if (msg.type === "tool_event") {
			dispatch({ type: "ADD_TOOL_EVENT", id: activeId, event: msg });
		} else if (msg.type === "done") {
			dispatch({ type: "DONE", id: activeId, cost: msg.cost });
			pendingIdRef.current = null;
		} else if (msg.type === "error") {
			dispatch({
				type: "APPEND_CHUNK",
				id: activeId,
				text: `\n\n[ERROR: ${msg.message}]`,
			});
			dispatch({ type: "DONE", id: activeId, cost: null });
			pendingIdRef.current = null;
		}
	}, []);

	const { wsStatus, sessionState, send } = useWs(handleWsMessage);

	useEffect(() => {
		const p = wsStore.claimPendingPrompt();
		if (p) dispatch({ type: "ADD_USER", id: uid(), text: p });
	}, []);

	const handleDecide = useCallback(
		(id: string, approved: boolean) => {
			dispatch({
				type: "RESOLVE_PERMISSION",
				id,
				decision: approved ? "approved" : "denied",
			});
			send({ type: "permission_response", id, approved });
		},
		[send],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: messages is trigger
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: input length triggers resize
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	}, [input]);

	const handleSend = useCallback(() => {
		const text = input.trim();
		if (!text || sessionState === "running") return;
		const id = uid();
		dispatch({ type: "ADD_USER", id, text });
		send({ type: "chat", text });
		setInput("");
	}, [input, sessionState, send]);

	const handleClear = useCallback(() => {
		pendingIdRef.current = null;
		dispatch({ type: "CLEAR" });
		send({ type: "clear" });
	}, [send]);

	const isRunning = sessionState === "running";
	const canSend =
		input.trim().length > 0 && !isRunning && wsStatus === "connected";

	return (
		<div className="h-full flex flex-col">
			{/* Messages */}
			<div className="flex-1 overflow-auto px-5 py-2">
				{messages.length === 0 && (
					<div className="h-full flex flex-col items-center justify-center gap-3">
						<div className="text-2xl font-bold tracking-widest text-foreground/8 uppercase select-none">
							{wsStatus !== "connected" ? "CONNECTING" : "READY WHEN YOU ARE"}
						</div>
						{wsStatus === "connected" && (
							<div className="text-[9px] tracking-[0.35em] text-muted-foreground/20">
								↵ send · ⇧↵ newline
							</div>
						)}
					</div>
				)}
				{messages.map((m) => {
					if (m.role === "user") return <UserMsg key={m.id} message={m} />;
					if (m.role === "permission")
						return (
							<PermissionCard key={m.id} message={m} onDecide={handleDecide} />
						);
					return <AssistantMsg key={m.id} message={m} />;
				})}
				<div ref={bottomRef} />
			</div>

			{/* Input */}
			<div className="shrink-0 border-t border-border bg-background">
				<div className="flex items-center">
					<span className="text-primary text-sm px-4 py-3 shrink-0 select-none">
						›
					</span>
					<textarea
						ref={textareaRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							const isTouch =
								typeof window !== "undefined" &&
								window.matchMedia("(pointer: coarse)").matches;
							if (
								e.key === "Enter" &&
								!e.shiftKey &&
								!isTouch &&
								ui.enter_to_submit
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
									? "running…"
									: "message claude"
						}
						disabled={wsStatus !== "connected" || isRunning}
						className="flex-1 resize-none bg-transparent py-3 pr-2 text-sm text-foreground placeholder:text-muted-foreground/20 focus:outline-none disabled:opacity-30 overflow-hidden"
					/>
					<button
						type="button"
						onClick={handleSend}
						disabled={!canSend}
						className="px-4 py-3 text-[10px] tracking-widest text-primary/50 hover:text-primary disabled:text-muted-foreground/20 transition-colors shrink-0 uppercase font-bold"
						aria-label="Send"
					>
						RUN
					</button>
					{messages.length > 0 && (
						<button
							type="button"
							onClick={handleClear}
							className="px-3 py-3 text-muted-foreground/25 hover:text-muted-foreground transition-colors shrink-0"
							aria-label="New chat"
						>
							<SquarePen className="w-3.5 h-3.5" />
						</button>
					)}
					<div className="px-2 shrink-0">
						<StatusDot />
					</div>
				</div>
			</div>
		</div>
	);
}
