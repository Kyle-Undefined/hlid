import { createFileRoute } from "@tanstack/react-router";
import { Check, ChevronRight, Send, SquarePen, X } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useWs } from "#/hooks/useWs";
import type {
	PermissionRequestMessage,
	ServerMessage,
	ToolEventMessage,
} from "#/server/protocol";

export const Route = createFileRoute("/chat")({
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
	return (
		<div className="border border-border rounded-md overflow-hidden text-xs font-mono">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/40 text-muted-foreground hover:bg-muted transition-colors text-left"
			>
				<ChevronRight
					className={`w-3 h-3 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
				/>
				<span className="text-foreground/60 font-sans font-medium">
					{event.name}
				</span>
			</button>
			{open && (
				<pre className="px-3 py-2 text-xs overflow-auto max-h-48 bg-card/40 text-foreground/60 leading-relaxed">
					{JSON.stringify(event.input, null, 2)}
				</pre>
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
			<div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-card text-xs text-muted-foreground">
				{message.decision === "approved" ? (
					<Check className="w-3.5 h-3.5 text-green-400 shrink-0" />
				) : (
					<X className="w-3.5 h-3.5 text-destructive shrink-0" />
				)}
				<span>
					{message.displayName ?? message.toolName}{" "}
					{message.decision === "approved" ? "approved" : "denied"}
				</span>
			</div>
		);
	}

	return (
		<div className="rounded-xl border border-border bg-card overflow-hidden">
			<div className="px-4 py-3 space-y-1">
				<div className="text-sm font-medium text-foreground">
					{message.title}
				</div>
				{message.description && (
					<div className="text-xs text-muted-foreground">
						{message.description}
					</div>
				)}
			</div>
			<div className="flex border-t border-border divide-x divide-border">
				<button
					type="button"
					onClick={() => onDecide(message.id, false)}
					className="flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
				>
					<X className="w-4 h-4" />
					Deny
				</button>
				<button
					type="button"
					onClick={() => onDecide(message.id, true)}
					className="flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium text-green-400 hover:bg-green-400/10 transition-colors"
				>
					<Check className="w-4 h-4" />
					Approve
				</button>
			</div>
		</div>
	);
}

function UserMsg({ message }: { message: UserMessage }) {
	return (
		<div className="flex justify-end">
			<div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-sm bg-primary text-primary-foreground text-sm whitespace-pre-wrap">
				{message.text}
			</div>
		</div>
	);
}

function AssistantMsg({ message }: { message: AssistantMessage }) {
	return (
		<div className="flex flex-col gap-2 max-w-[90%]">
			{message.toolEvents.length > 0 && (
				<div className="space-y-1">
					{message.toolEvents.map((e) => (
						<ToolBlock key={e.id} event={e} />
					))}
				</div>
			)}
			{(message.text || message.streaming) && (
				<div className="px-4 py-2.5 rounded-2xl rounded-bl-sm bg-card border border-border text-sm text-foreground whitespace-pre-wrap">
					{message.text}
					{message.streaming && (
						<span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-foreground/40 animate-pulse rounded-sm" />
					)}
				</div>
			)}
			{!message.streaming && message.cost !== null && (
				<div className="text-[10px] text-muted-foreground/60 px-1">
					${message.cost.toFixed(4)}
				</div>
			)}
		</div>
	);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function ChatPage() {
	const [messages, dispatch] = useReducer(reducer, []);
	const [input, setInput] = useState("");
	const pendingIdRef = useRef<string | null>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const handleWsMessage = useCallback((msg: ServerMessage) => {
		const id = pendingIdRef.current;

		if (msg.type === "status" && msg.state === "running" && !id) {
			const newId = crypto.randomUUID();
			pendingIdRef.current = newId;
			dispatch({ type: "ADD_ASSISTANT", id: newId });
			return;
		}

		if (msg.type === "permission_request") {
			dispatch({ type: "ADD_PERMISSION", msg });
			return;
		}

		if (!id) return;

		if (msg.type === "chunk") {
			dispatch({ type: "APPEND_CHUNK", id, text: msg.text });
		} else if (msg.type === "tool_event") {
			dispatch({ type: "ADD_TOOL_EVENT", id, event: msg });
		} else if (msg.type === "done") {
			dispatch({ type: "DONE", id, cost: msg.cost });
			pendingIdRef.current = null;
		} else if (msg.type === "error") {
			dispatch({
				type: "APPEND_CHUNK",
				id,
				text: `\n\n[Error: ${msg.message}]`,
			});
			dispatch({ type: "DONE", id, cost: null });
			pendingIdRef.current = null;
		}
	}, []);

	const { wsStatus, sessionState, send } = useWs(handleWsMessage);

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

	// biome-ignore lint/correctness/useExhaustiveDependencies: messages is the trigger
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: input length change triggers resize
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	}, [input]);

	const handleSend = useCallback(() => {
		const text = input.trim();
		if (!text || sessionState === "running") return;

		const id = crypto.randomUUID();
		dispatch({ type: "ADD_USER", id, text });
		send({ type: "chat", text });
		setInput("");
	}, [input, sessionState, send]);

	const handleClear = useCallback(() => {
		pendingIdRef.current = null;
		dispatch({ type: "CLEAR" });
		send({ type: "clear" });
	}, [send]);

	const canSend =
		input.trim().length > 0 &&
		sessionState !== "running" &&
		wsStatus === "connected";

	return (
		<div className="h-full flex flex-col">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
				<h1 className="text-sm font-semibold text-foreground">Chat</h1>
				{messages.length > 0 && (
					<button
						type="button"
						onClick={handleClear}
						className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
					>
						<SquarePen className="w-3.5 h-3.5" />
						New conversation
					</button>
				)}
			</div>

			{/* Messages */}
			<div className="flex-1 overflow-auto px-4 py-4 space-y-4">
				{messages.length === 0 && (
					<div className="h-full flex items-center justify-center">
						<p className="text-sm text-muted-foreground">
							{wsStatus !== "connected"
								? "Connecting to session…"
								: "What's on your mind?"}
						</p>
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
			<div className="shrink-0 border-t border-border bg-background px-4 py-3">
				<div className="flex gap-2 items-end">
					<textarea
						ref={textareaRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								handleSend();
							}
						}}
						rows={1}
						placeholder={
							wsStatus !== "connected"
								? "Connecting…"
								: "Message Claude… (↵ send, ⇧↵ newline)"
						}
						disabled={wsStatus !== "connected"}
						className="flex-1 resize-none bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 overflow-hidden"
					/>
					<button
						type="button"
						onClick={handleSend}
						disabled={!canSend}
						className="p-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 transition-opacity shrink-0"
						aria-label="Send"
					>
						<Send className="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>
	);
}
