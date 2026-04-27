import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Check, ChevronRight, SquarePen, X } from "lucide-react";
import {
	useCallback,
	useEffect,
	useReducer,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getConfig } from "#/config";
import type { UsageWindows } from "#/db";
import { useWs } from "#/hooks/useWs";
import * as wsStore from "#/hooks/wsStore";
import { uid } from "#/lib/utils";
import type {
	PermissionRequestMessage,
	RateLimitMessage,
	ServerMessage,
	ToolEventMessage,
} from "#/server/protocol";

function normalizeMd(text: string): string {
	// CommonMark: "** text **" doesn't bold (space after opener). Normalize.
	return text.replace(/\*\*\s+((?:[^*\n]|\*(?!\*))+?)\s+\*\*/g, "**$1**");
}

// ─── server fns ──────────────────────────────────────────────────────────────

type EnrichedMessageRow = import("#/db").MessageRow & {
	toolEvents?: import("#/db").ToolEventRow[];
};

const getSessionDataFn = createServerFn({ method: "GET" })
	.inputValidator((sessionId: string) => sessionId)
	.handler(async ({ data: sessionId }) => {
		const { server } = await getConfig();
		const res = await fetch(
			`http://localhost:${server.port + 1}/db/session-messages?session_id=${encodeURIComponent(sessionId)}`,
		);
		if (!res.ok) return [] as EnrichedMessageRow[];
		return res.json() as Promise<EnrichedMessageRow[]>;
	});

const getUsageWindowsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { server } = await getConfig();
		try {
			const res = await fetch(
				`http://localhost:${server.port + 1}/db/usage-windows`,
			);
			if (!res.ok) return null as UsageWindows | null;
			return res.json() as Promise<UsageWindows>;
		} catch {
			return null as UsageWindows | null;
		}
	},
);

const getCurrentSessionFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { server } = await getConfig();
		try {
			const res = await fetch(
				`http://localhost:${server.port + 1}/db/current-session`,
			);
			if (!res.ok) return null as string | null;
			const data = (await res.json()) as { session_id: string | null };
			return data.session_id;
		} catch {
			return null as string | null;
		}
	},
);

const MODEL_LABELS: Record<string, string> = {
	"claude-opus-4-7": "Opus 4.7",
	"claude-sonnet-4-6": "Sonnet 4.6",
	"claude-haiku-4-5-20251001": "Haiku 4.5",
};

// ─── route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/chat")({
	validateSearch: (search: Record<string, unknown>) => ({
		session: typeof search.session === "string" ? search.session : undefined,
	}),
	loaderDeps: ({ search: { session } }) => ({ session }),
	loader: async ({ deps: { session } }) => {
		const [config, dbSessionId, usageWindows] = await Promise.all([
			getConfig(),
			session ? Promise.resolve(null) : getCurrentSessionFn(),
			getUsageWindowsFn(),
		]);
		return { config, existingSessionId: session ?? dbSessionId, usageWindows };
	},
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
	input?: Record<string, unknown>;
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
	| {
			type: "LOAD_HISTORY";
			messages: Array<{
				id: string;
				role: string;
				text: string;
				toolEvents?: ToolEventMessage[];
			}>;
	  }
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
					input: action.msg.input,
					decision: "pending",
				},
			];
		case "RESOLVE_PERMISSION":
			return state.map((m) =>
				m.id === action.id && m.role === "permission"
					? { ...m, decision: action.decision }
					: m,
			);
		case "LOAD_HISTORY":
			return action.messages.map((m) =>
				m.role === "user"
					? { id: m.id, role: "user" as const, text: m.text }
					: {
							id: m.id,
							role: "assistant" as const,
							text: m.text,
							toolEvents: m.toolEvents ?? [],
							streaming: false,
							cost: null,
						},
			);
		case "CLEAR":
			return [];
	}
}

// ─── Usage windows ────────────────────────────────────────────────────────────

function fmtResetTime(unixSecs: number): string {
	const diff = unixSecs - Date.now() / 1000;
	if (diff <= 0) return "now";
	const h = Math.floor(diff / 3600);
	const m = Math.floor((diff % 3600) / 60);
	if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function UsageWindowSection({
	label,
	win,
	hideStats,
}: {
	label: string;
	win: {
		queries: number;
		sessions: number;
		cost: number;
		utilization: number | null;
		resetsAt: number | null;
	} | null;
	hideStats?: boolean;
}) {
	const utilPct =
		win?.utilization != null ? Math.min(win.utilization * 100, 100) : null;
	return (
		<div className="flex-1 px-2 py-2 md:px-4 md:py-2.5 min-w-0 space-y-1">
			<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-0.5 md:gap-2">
				<div className="flex items-center gap-1.5 md:gap-2 min-w-0">
					<span className="text-[8px] md:text-[9px] tracking-widest text-muted-foreground/40 uppercase truncate leading-none">
						{label}
					</span>
					{utilPct != null && (
						<span className="text-[9px] md:text-[10px] tabular-nums font-medium text-foreground/60 shrink-0 leading-none">
							{Math.floor(utilPct)}%
						</span>
					)}
				</div>
				{win?.resetsAt != null && (
					<span className="text-[8px] tracking-widest text-muted-foreground/50 truncate">
						{fmtResetTime(win.resetsAt)}
					</span>
				)}
			</div>
			<div className="h-1 bg-secondary/40 overflow-hidden">
				<div
					className="h-full bg-primary/60 transition-all duration-500"
					style={{ width: utilPct != null ? `${utilPct}%` : "0%" }}
				/>
			</div>
			{!hideStats && (
				<div className="flex items-center flex-wrap gap-x-1.5 gap-y-0">
					<span className="text-[9px] tabular-nums text-foreground/50">
						${(win?.cost ?? 0).toFixed(2)}
					</span>
					<span className="text-muted-foreground/25 hidden md:inline">·</span>
					<span className="text-[8px] tracking-widest text-muted-foreground/40">
						<span className="md:hidden">{win?.queries ?? 0}q</span>
						<span className="hidden md:inline">
							{win?.queries ?? 0} queries
						</span>
					</span>
					<span className="text-muted-foreground/25 hidden md:inline">·</span>
					<span className="text-[8px] tracking-widest text-muted-foreground/40">
						<span className="md:hidden">{win?.sessions ?? 0}s</span>
						<span className="hidden md:inline">
							{win?.sessions ?? 0} sessions
						</span>
					</span>
				</div>
			)}
		</div>
	);
}

function ContextWindowSection({ stats }: { stats: wsStore.LiveStats }) {
	const hasContext =
		stats.last_context_used != null && stats.context_window != null;
	const contextUsed = stats.last_context_used ?? 0;
	const contextWindow = stats.context_window ?? 0;
	const utilPct =
		hasContext && contextWindow > 0
			? Math.min((contextUsed / contextWindow) * 100, 100)
			: null;

	return (
		<div className="flex-1 px-2 py-2 md:px-4 md:py-2.5 min-w-0 space-y-1">
			<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-0.5 md:gap-2">
				<div className="flex items-center gap-1.5 md:gap-2 min-w-0">
					<span className="text-[8px] md:text-[9px] tracking-widest text-muted-foreground/40 uppercase truncate leading-none">
						CONTEXT
					</span>
					{utilPct != null && (
						<span className="text-[9px] md:text-[10px] tabular-nums font-medium text-foreground/60 shrink-0 leading-none">
							{Math.floor(utilPct)}%
						</span>
					)}
				</div>
				{hasContext && (
					<span className="text-[8px] tracking-widest text-muted-foreground/50 truncate">
						{contextUsed.toLocaleString()} / {contextWindow.toLocaleString()}
					</span>
				)}
			</div>
			<div className="h-1 bg-secondary/40 overflow-hidden">
				<div
					className={`h-full transition-all duration-500 ${utilPct != null && utilPct > 80 ? "bg-destructive/60" : utilPct != null && utilPct > 60 ? "bg-yellow-600/60" : "bg-primary/60"}`}
					style={{ width: utilPct != null ? `${utilPct}%` : "0%" }}
				/>
			</div>
			{!hasContext && (
				<span className="text-[8px] tracking-widest text-muted-foreground/20">
					no active context
				</span>
			)}
		</div>
	);
}

function mergeUsageWindows(
	fresh: UsageWindows,
	prev: UsageWindows | null,
): UsageWindows {
	if (!prev) return fresh;
	const keep = (
		freshWin: UsageWindows["fiveHour"],
		prevWin: UsageWindows["fiveHour"],
	) => ({
		...freshWin,
		utilization: prevWin.utilization ?? freshWin.utilization,
		resetsAt:
			prevWin.utilization != null ? prevWin.resetsAt : freshWin.resetsAt,
	});
	return {
		...fresh,
		fiveHour: keep(fresh.fiveHour, prev.fiveHour),
		weekly: keep(fresh.weekly, prev.weekly),
		weeklySonnet:
			fresh.weeklySonnet != null
				? prev.weeklySonnet?.utilization != null
					? {
							...fresh.weeklySonnet,
							utilization: prev.weeklySonnet.utilization,
							resetsAt: prev.weeklySonnet.resetsAt,
						}
					: fresh.weeklySonnet
				: null,
	};
}

function ChatUsageWindowsPanel({
	initial,
	liveQueryCount,
	rateLimit,
	liveStats,
}: {
	initial: UsageWindows | null;
	liveQueryCount: number;
	rateLimit: RateLimitMessage | null;
	liveStats: wsStore.LiveStats;
}) {
	const [data, setData] = useState<UsageWindows | null>(initial);

	useEffect(() => {
		if (liveQueryCount === 0) return;
		void getUsageWindowsFn().then((d) => {
			if (d) setData((prev) => mergeUsageWindows(d, prev));
		});
	}, [liveQueryCount]);

	useEffect(() => {
		const id = setInterval(
			() =>
				void getUsageWindowsFn().then((d) => {
					if (d) setData((prev) => mergeUsageWindows(d, prev));
				}),
			60_000,
		);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		if (!rateLimit || rateLimit.utilization == null) return;
		setData((prev) => {
			if (!prev) return prev;
			const update = {
				utilization: rateLimit.utilization ?? null,
				resetsAt: rateLimit.resetsAt ?? null,
				rateLimitType: rateLimit.rateLimitType ?? null,
			};
			if (rateLimit.rateLimitType === "five_hour")
				return { ...prev, fiveHour: { ...prev.fiveHour, ...update } };
			if (rateLimit.rateLimitType === "weekly_sonnet")
				return {
					...prev,
					weeklySonnet: {
						utilization: update.utilization,
						resetsAt: update.resetsAt,
					},
				};
			return { ...prev, weekly: { ...prev.weekly, ...update } };
		});
	}, [rateLimit]);

	return (
		<div className="border-b border-border shrink-0 flex divide-x divide-border/40">
			<UsageWindowSection label="5-HOUR" win={data?.fiveHour ?? null} />
			<UsageWindowSection label="7-DAY" win={data?.weekly ?? null} />
			{data?.weeklySonnet != null && (
				<UsageWindowSection
					label="SONNET"
					win={{ queries: 0, sessions: 0, cost: 0, ...data.weeklySonnet }}
					hideStats
				/>
			)}
			<ContextWindowSection stats={liveStats} />
		</div>
	);
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
					className={`w-3 h-3 shrink-0 text-primary/50 group-hover:text-primary/80 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
				/>
				<span className="text-[11px] font-medium tracking-wider text-primary/70 group-hover:text-primary/90 shrink-0">
					{event.name}
				</span>
				<div className="flex gap-1.5 flex-wrap">
					{pills.map(([k, v]) => (
						<span
							key={k}
							className="text-[9px] tracking-wide border border-primary/20 text-primary/50 px-1.5 py-0.5 font-mono"
						>
							{k}: {String(v).slice(0, 24)}
							{String(v).length > 24 ? "…" : ""}
						</span>
					))}
				</div>
			</button>
			{open && (
				<div className="mx-3 mb-1.5 border border-[var(--tool-panel-border)] bg-[var(--tool-panel)]">
					<pre className="text-[11px] text-primary/60 font-mono leading-relaxed p-3 overflow-auto max-h-48">
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
				<div className="w-12 shrink-0 text-[9px] tracking-widest text-muted-foreground/50 pt-0.5 uppercase">
					PERM
				</div>
				<div className="flex items-center gap-2 text-xs text-muted-foreground/65">
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

	const inputPreview = message.input
		? ((message.input.command as string | undefined) ??
			(message.input.file_path as string | undefined) ??
			(message.input.path as string | undefined) ??
			Object.values(message.input).find((v) => typeof v === "string"))
		: undefined;

	return (
		<div className="flex gap-0">
			<div className="w-12 shrink-0 text-[9px] tracking-widest text-primary/60 pt-0.5 uppercase">
				PERM
			</div>
			<div className="flex-1 border border-border bg-card">
				<div className="px-4 py-3 border-b border-border">
					<div className="text-[9px] tracking-widest text-muted-foreground/65 uppercase mb-1">
						PERMISSION REQUEST
					</div>
					<div className="text-sm text-foreground">{message.title}</div>
					{inputPreview && (
						<div className="mt-2 px-2 py-1.5 bg-secondary/60 border border-border font-mono text-[11px] text-foreground/80 break-all">
							{inputPreview}
						</div>
					)}
					{message.description && (
						<div className="text-xs text-muted-foreground/75 mt-1">
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

function UserMsg({ message }: { message: UserMessage }) {
	return (
		<div className="flex items-start gap-3 py-3 border-b border-border/40">
			<div className="flex-1" />
			<div className="text-sm text-foreground whitespace-pre-wrap text-right max-w-[78%] leading-relaxed">
				{message.text}
			</div>
			<div className="text-[9px] tracking-widest text-primary/60 shrink-0 pt-0.5 w-11 text-right">
				ME
			</div>
		</div>
	);
}

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
							className="w-4 h-4 opacity-60"
							role="img"
							aria-label="Hlid"
						>
							<path
								d="M2 16 C7 6 25 6 30 16 C25 26 7 26 2 16Z"
								fill="none"
								style={{ stroke: "var(--data)" }}
								strokeWidth="1.5"
								strokeLinejoin="round"
							/>
							<circle
								cx="16"
								cy="16"
								r="5.5"
								fill="none"
								style={{ stroke: "var(--data)" }}
								strokeWidth="1.5"
							/>
							<circle cx="16" cy="16" r="2" style={{ fill: "var(--data)" }} />
						</svg>
					</div>
					<div className="flex-1 text-sm text-foreground leading-relaxed pr-4 min-w-0">
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
										<code className="block bg-secondary/60 border border-border rounded-none px-3 py-2 text-xs font-mono text-foreground/90 overflow-x-auto whitespace-pre mb-3">
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
									<blockquote className="border-l-2 border-primary/30 pl-3 text-foreground/75 italic mb-3">
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
						<div className="text-[9px] tabular-nums text-muted-foreground/40 shrink-0 pt-0.5 font-mono">
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
	const {
		config,
		existingSessionId,
		usageWindows: initialUsageWindows,
	} = Route.useLoaderData();
	const [sessionId, setSessionId] = useState(() => existingSessionId ?? uid());
	const sessionIdRef = useRef(sessionId);
	useEffect(() => {
		sessionIdRef.current = sessionId;
	}, [sessionId]);

	const liveStats = useSyncExternalStore(
		wsStore.subscribeStats,
		wsStore.getLiveStats,
		wsStore.getLiveStats,
	);
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const [messages, dispatch] = useReducer(reducer, []);
	const [input, setInput] = useState("");
	const pendingIdRef = useRef<string | null>(null);
	// Tracks whether initial history load is done so the isRunning effect doesn't race it
	const historyReadyRef = useRef(!existingSessionId);
	const bottomRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const atBottomRef = useRef(true);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const handleWsMessage = useCallback((msg: ServerMessage) => {
		// Cross-device: show user message from another client if it matches our session
		if (msg.type === "rate_limit") {
			setRateLimit(msg);
			return;
		}

		if (msg.type === "user_message") {
			if (msg.session_id === sessionIdRef.current) {
				dispatch({ type: "ADD_USER", id: uid(), text: msg.text });
			}
			return;
		}

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
			const errorId =
				activeId ??
				(() => {
					const newId = uid();
					dispatch({ type: "ADD_ASSISTANT", id: newId });
					return newId;
				})();
			dispatch({
				type: "APPEND_CHUNK",
				id: errorId,
				text: `\n\n[ERROR: ${msg.message}]`,
			});
			dispatch({ type: "DONE", id: errorId, cost: null });
			pendingIdRef.current = null;
		}
	}, []);

	// Load history for existing sessions, then claim any pending prompt
	useEffect(() => {
		if (!existingSessionId) {
			const p = wsStore.claimPendingPrompt();
			if (p) dispatch({ type: "ADD_USER", id: uid(), text: p });
			historyReadyRef.current = true;
			wsStore.clearMessageBuffer();
			wsStore.send({ type: "sync" });
			return;
		}
		getSessionDataFn({ data: existingSessionId })
			.then((rows) => {
				dispatch({
					type: "LOAD_HISTORY",
					messages: rows.map((r) => ({
						id: uid(),
						role: r.role,
						text: r.text,
						toolEvents: r.toolEvents?.map((te) => ({
							type: "tool_event" as const,
							id: te.tool_id,
							name: te.name,
							input: (() => {
								try {
									return JSON.parse(te.input_json) as unknown;
								} catch {
									return {};
								}
							})(),
						})),
					})),
				});
				const p = wsStore.claimPendingPrompt();
				if (p) {
					const lastRow = rows[rows.length - 1];
					if (!lastRow || lastRow.role !== "user" || lastRow.text !== p) {
						dispatch({ type: "ADD_USER", id: uid(), text: p });
					}
				}
				historyReadyRef.current = true;
				// If session is running, add pending bubble before draining so chunks attach to it
				if (
					wsStore.getSnapshot().sessionState === "running" &&
					!pendingIdRef.current
				) {
					const newId = uid();
					pendingIdRef.current = newId;
					dispatch({ type: "ADD_ASSISTANT", id: newId });
				}
				// Replay messages that arrived while component was unmounted (tool events, chunks)
				for (const msg of wsStore.drainMessageBuffer()) {
					handleWsMessage(msg);
				}
				// Sync with server — replays pending permissions in case WS didn't reconnect (SPA nav)
				wsStore.send({ type: "sync" });
			})
			.catch(console.error);
	}, [existingSessionId, handleWsMessage]);

	const { wsStatus, sessionState, model, send } = useWs(handleWsMessage);

	// If session is running but no pending assistant turn exists, add one.
	// Guard with historyReadyRef so we don't race the initial DB load.
	const isRunning = sessionState === "running";
	useEffect(() => {
		if (!isRunning || !historyReadyRef.current || pendingIdRef.current) return;
		const newId = uid();
		pendingIdRef.current = newId;
		dispatch({ type: "ADD_ASSISTANT", id: newId });
	}, [isRunning]);

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
		atBottomRef.current = true;
		const id = uid();
		dispatch({ type: "ADD_USER", id, text });
		send({ type: "chat", text, session_id: sessionId });
		setInput("");
	}, [input, sessionState, send, sessionId]);

	const handleClear = useCallback(() => {
		pendingIdRef.current = null;
		dispatch({ type: "CLEAR" });
		send({ type: "clear" });
		wsStore.resetLiveStats();
		wsStore.clearMessageBuffer();
		const newId = uid();
		setSessionId(newId);
		sessionIdRef.current = newId;
	}, [send]);

	const canSend =
		input.trim().length > 0 && !isRunning && wsStatus === "connected";

	const modelShort = model
		? (MODEL_LABELS[model] ??
			model.replace("claude-", "").replace(/-\d{8}$/, ""))
		: null;

	return (
		<div className="h-full flex flex-col">
			<ChatUsageWindowsPanel
				initial={initialUsageWindows}
				liveQueryCount={liveStats?.queries ?? 0}
				rateLimit={rateLimit}
				liveStats={liveStats}
			/>

			{/* Messages — inner min-h-full + justify-end anchors messages to bottom */}
			<div ref={scrollRef} className="flex-1 overflow-auto">
				<div className="min-h-full flex flex-col justify-end px-5 py-2">
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
						<>
							{messages.map((m) => {
								if (m.role === "user")
									return <UserMsg key={m.id} message={m} />;
								if (m.role === "permission")
									return (
										<PermissionCard
											key={m.id}
											message={m}
											onDecide={handleDecide}
										/>
									);
								return <AssistantMsg key={m.id} message={m} />;
							})}
							<div ref={bottomRef} />
						</>
					)}
				</div>
			</div>

			{/* Input */}
			<div className="shrink-0 border-t border-border bg-background relative">
				{modelShort && (
					<span className="absolute -top-5 right-3 text-[9px] tracking-widest text-muted-foreground/50 border border-border/70 px-2 py-0.5 uppercase bg-background">
						{modelShort}
					</span>
				)}
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
									? "running…"
									: "speak to the watcher…"
						}
						disabled={wsStatus !== "connected" || isRunning}
						className="flex-1 resize-none bg-transparent py-3 pr-2 text-sm text-foreground placeholder:text-muted-foreground/35 focus:outline-none disabled:opacity-30 overflow-hidden"
					/>
					{isRunning ? (
						<button
							type="button"
							onClick={() => send({ type: "abort" })}
							className="px-4 py-3 text-[10px] tracking-widest text-destructive/70 hover:text-destructive transition-colors shrink-0 uppercase font-bold"
							aria-label="Abort"
						>
							STOP
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
	);
}
