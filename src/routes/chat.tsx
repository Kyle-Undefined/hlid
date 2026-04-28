import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
	Check,
	ChevronRight,
	File as FileIcon,
	Paperclip,
	SquarePen,
	X,
} from "lucide-react";
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
	ChatAttachment,
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
	attachments?: import("#/db").AttachmentRow[];
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
	attachments?: ChatAttachment[];
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
	| {
			type: "ADD_USER";
			id: string;
			text: string;
			attachments?: ChatAttachment[];
	  }
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
				attachments?: ChatAttachment[];
			}>;
	  }
	| { type: "CLEAR" };

function reducer(state: ChatMessage[], action: Action): ChatMessage[] {
	switch (action.type) {
		case "ADD_USER":
			return [
				...state,
				{
					id: action.id,
					role: "user",
					text: action.text,
					attachments: action.attachments,
				},
			];
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
					? {
							id: m.id,
							role: "user" as const,
							text: m.text,
							attachments: m.attachments,
						}
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

function AttachmentChip({ a }: { a: ChatAttachment }) {
	const isImage = a.mime.startsWith("image/");
	const href = `/api/attachments/${a.id}/raw`;
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="inline-flex items-center gap-1.5 max-w-[200px] border border-border/60 bg-secondary/30 hover:bg-secondary/60 transition-colors px-2 py-1 text-[10px] text-foreground/80"
			title={`${a.filename} (${a.kind})`}
		>
			{isImage ? (
				<img
					src={href}
					alt={a.filename}
					className="w-6 h-6 object-cover shrink-0"
				/>
			) : (
				<FileIcon className="w-3 h-3 shrink-0 opacity-60" />
			)}
			<span className="truncate font-mono">{a.filename}</span>
			{a.kind === "vault" && (
				<span className="text-[8px] tracking-widest uppercase text-primary/60 shrink-0">
					V
				</span>
			)}
		</a>
	);
}

function UserMsg({ message }: { message: UserMessage }) {
	return (
		<div className="flex items-start justify-end gap-3 py-3 border-b border-border/40">
			<div className="flex flex-col items-end gap-1.5 min-w-0 max-w-[78%]">
				{message.attachments && message.attachments.length > 0 && (
					<div className="flex flex-wrap gap-1.5 justify-end">
						{message.attachments.map((a) => (
							<AttachmentChip key={a.id} a={a} />
						))}
					</div>
				)}
				{message.text && (
					<div
						className="text-sm text-foreground whitespace-pre-wrap text-right leading-relaxed w-full"
						style={{ overflowWrap: "anywhere" }}
					>
						{message.text}
					</div>
				)}
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
	const [pendingAttachments, setPendingAttachments] = useState<
		ChatAttachment[]
	>([]);
	const [defaultKind, setDefaultKind] = useState<"ephemeral" | "vault">(
		"ephemeral",
	);
	const [uploadingCount, setUploadingCount] = useState(0);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
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
						attachments: r.attachments?.map((a) => ({
							id: a.id,
							path: a.path,
							filename: a.filename,
							mime: a.mime,
							kind: a.kind,
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

	const uploadFiles = useCallback(
		async (files: FileList | File[]) => {
			const list = Array.from(files);
			if (list.length === 0) return;
			setUploadError(null);
			setUploadingCount((c) => c + list.length);
			try {
				const uploaded = await Promise.all(
					list.map(async (file) => {
						const fd = new FormData();
						fd.append("file", file);
						fd.append("kind", defaultKind);
						fd.append("session_id", sessionIdRef.current);
						const res = await fetch("/api/attachments/upload", {
							method: "POST",
							body: fd,
						});
						if (!res.ok) {
							let msg = `upload failed (${res.status})`;
							try {
								const body = (await res.json()) as { error?: string };
								if (body.error) msg = body.error;
							} catch {}
							throw new Error(`${file.name}: ${msg}`);
						}
						return (await res.json()) as ChatAttachment & {
							size_bytes: number;
						};
					}),
				);
				setPendingAttachments((prev) => [
					...prev,
					...uploaded.map((u) => ({
						id: u.id,
						path: u.path,
						filename: u.filename,
						mime: u.mime,
						kind: u.kind,
					})),
				]);
			} catch (err) {
				setUploadError(err instanceof Error ? err.message : "upload failed");
			} finally {
				setUploadingCount((c) => Math.max(0, c - list.length));
			}
		},
		[defaultKind],
	);

	const removePending = useCallback((id: string) => {
		setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
	}, []);

	const handleSend = useCallback(() => {
		const text = input.trim();
		if (sessionState === "running") return;
		if (!text && pendingAttachments.length === 0) return;
		atBottomRef.current = true;
		const id = uid();
		const attachments = pendingAttachments;
		dispatch({ type: "ADD_USER", id, text, attachments });
		send({
			type: "chat",
			text,
			session_id: sessionId,
			attachments: attachments.length > 0 ? attachments : undefined,
		});
		setInput("");
		setPendingAttachments([]);
	}, [input, sessionState, send, sessionId, pendingAttachments]);

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
		(input.trim().length > 0 || pendingAttachments.length > 0) &&
		uploadingCount === 0 &&
		!isRunning &&
		wsStatus === "connected";

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
			<div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden">
				<div className="min-h-full flex flex-col justify-end px-5 py-2 min-w-0">
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

			{/* Bottom bar — wrapper is relative so model badge floats above entire block */}
			<div className="shrink-0 relative">
				{modelShort && (
					<span className="absolute -top-5 right-3 text-[9px] tracking-widest text-muted-foreground/50 border border-border/70 px-2 py-0.5 uppercase bg-background z-10">
						{modelShort}
					</span>
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
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone wraps the input — interactive children handle keyboard input */}
				<div
					className={`border-t border-border bg-background transition-colors ${
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
					{(pendingAttachments.length > 0 ||
						uploadingCount > 0 ||
						uploadError) && (
						<div className="px-4 py-2 flex flex-wrap items-center gap-1.5 border-b border-border/40">
							{pendingAttachments.map((a) => (
								<span
									key={a.id}
									className="inline-flex items-center gap-1.5 max-w-[220px] border border-border/60 bg-secondary/30 px-2 py-1 text-[10px] text-foreground/80"
								>
									{a.mime.startsWith("image/") ? (
										<img
											src={`/api/attachments/${a.id}/raw`}
											alt={a.filename}
											className="w-5 h-5 object-cover shrink-0"
										/>
									) : (
										<FileIcon className="w-3 h-3 shrink-0 opacity-60" />
									)}
									<span className="truncate font-mono">{a.filename}</span>
									{a.kind === "vault" && (
										<span className="text-[8px] tracking-widest uppercase text-primary/60 shrink-0">
											V
										</span>
									)}
									<button
										type="button"
										onClick={() => removePending(a.id)}
										className="opacity-50 hover:opacity-100 shrink-0"
										aria-label={`Remove ${a.filename}`}
									>
										<X className="w-3 h-3" />
									</button>
								</span>
							))}
							{uploadingCount > 0 && (
								<span className="text-[10px] tracking-widest text-muted-foreground/60 uppercase">
									uploading {uploadingCount}…
								</span>
							)}
							{uploadError && (
								<span className="text-[10px] text-destructive/80">
									{uploadError}
								</span>
							)}
							<div className="ml-auto flex items-center gap-2 text-[9px] tracking-widest uppercase text-muted-foreground/60">
								<span>save:</span>
								<button
									type="button"
									onClick={() => setDefaultKind("ephemeral")}
									className={`px-2 py-0.5 border ${
										defaultKind === "ephemeral"
											? "border-primary/60 text-primary/80"
											: "border-border/60 hover:border-border"
									}`}
								>
									ref
								</button>
								<button
									type="button"
									onClick={() => setDefaultKind("vault")}
									className={`px-2 py-0.5 border ${
										defaultKind === "vault"
											? "border-primary/60 text-primary/80"
											: "border-border/60 hover:border-border"
									}`}
								>
									vault
								</button>
							</div>
						</div>
					)}
					<div className="flex items-center">
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
							disabled={wsStatus !== "connected" || isRunning}
							className="px-2 py-3 text-muted-foreground/45 hover:text-muted-foreground transition-colors shrink-0 disabled:opacity-30"
							aria-label="Attach file"
							title={`Attach (default: ${defaultKind})`}
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
		</div>
	);
}
