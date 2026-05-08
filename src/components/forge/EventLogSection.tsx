import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import type { LogCounts, LogLevel, LogRow } from "#/db";
import { dbFetch } from "#/lib/dbClient";
import { Section } from "./fields";

// ─── Server functions ─────────────────────────────────────────────────────────

export const getLogsFn = createServerFn({ method: "GET" })
	.inputValidator(
		(raw: unknown) => raw as { page: number; size: number; level: string },
	)
	.handler(async ({ data }) => {
		const params = new URLSearchParams({
			page: String(data.page),
			size: String(data.size),
			level: data.level,
		});
		const res = await dbFetch(`/db/logs?${params}`);
		if (!res.ok)
			return {
				logs: [] as LogRow[],
				total: 0,
				counts: { error: 0, warn: 0, info: 0 } as LogCounts,
			};
		return res.json() as Promise<{
			logs: LogRow[];
			total: number;
			counts: LogCounts;
		}>;
	});

export const clearLogsFn = createServerFn({ method: "POST" }).handler(
	async () => {
		const res = await dbFetch("/db/logs", { method: "DELETE" });
		if (!res.ok) throw new Error(`Failed to clear logs: ${res.status}`);
		return { ok: true };
	},
);

// ─── Constants ────────────────────────────────────────────────────────────────

const LOG_PAGE_SIZE = 50;
const LEVEL_TABS = ["all", "error", "warn", "info"] as const;
type LevelTab = (typeof LEVEL_TABS)[number];

const LEVEL_COLORS: Record<LogLevel, string> = {
	error: "text-destructive",
	warn: "text-yellow-500",
	info: "text-muted-foreground",
};

// ─── Components ───────────────────────────────────────────────────────────────

function LogEntryRow({ entry }: { entry: LogRow }) {
	const [expanded, setExpanded] = useState(false);
	const d = new Date(entry.timestamp * 1000);
	const tsShort = d.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const tsFull = d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	return (
		<div className="border-b border-border last:border-0">
			<button
				type="button"
				onClick={() => entry.detail != null && setExpanded((p) => !p)}
				tabIndex={entry.detail != null ? undefined : -1}
				aria-expanded={entry.detail != null ? expanded : undefined}
				className={`w-full flex items-start gap-3 px-4 py-2.5 text-left ${entry.detail != null ? "hover:bg-accent/20 cursor-pointer" : "cursor-default"} transition-colors`}
			>
				<span className="text-[9px] tabular-nums text-muted-foreground/40 shrink-0 pt-0.5 w-16 sm:w-28">
					<span className="sm:hidden">{tsShort}</span>
					<span className="hidden sm:inline">{tsFull}</span>
				</span>
				<span
					className={`text-[9px] tracking-widest uppercase shrink-0 w-10 pt-0.5 ${LEVEL_COLORS[entry.level]}`}
				>
					{entry.level}
				</span>
				<span className="hidden sm:inline text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0 w-14 pt-0.5">
					{entry.source}
				</span>
				<span className="text-xs text-foreground/80 flex-1 min-w-0 break-words">
					{entry.message}
				</span>
				{entry.detail != null && (
					<span className="text-[9px] text-muted-foreground/30 shrink-0">
						{expanded ? "▲" : "▼"}
					</span>
				)}
			</button>
			{expanded && entry.detail != null && (
				<div className="px-4 pb-2.5">
					<pre className="text-[10px] font-mono text-muted-foreground bg-secondary p-2 overflow-x-auto whitespace-pre-wrap break-all">
						{(() => {
							try {
								return JSON.stringify(
									JSON.parse(entry.detail as string),
									null,
									2,
								);
							} catch {
								return entry.detail;
							}
						})()}
					</pre>
				</div>
			)}
		</div>
	);
}

export function EventLogSection() {
	const [activeTab, setActiveTab] = useState<LevelTab>("all");
	const [page, setPage] = useState(1);
	const [data, setData] = useState<{
		logs: LogRow[];
		total: number;
		counts: LogCounts;
	} | null>(null);
	const [loading, setLoading] = useState(false);

	const load = useCallback(async (tab: LevelTab, p: number) => {
		setLoading(true);
		try {
			const result = await getLogsFn({
				data: { page: p, size: LOG_PAGE_SIZE, level: tab },
			});
			setData(result);
		} catch (err) {
			console.error("[logs] load failed:", err);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load(activeTab, page);
	}, [load, activeTab, page]);

	function handleTabChange(tab: LevelTab) {
		setActiveTab(tab);
		setPage(1);
	}

	async function handleClear() {
		try {
			await clearLogsFn();
			if (page === 1) {
				void load(activeTab, 1);
			} else {
				setPage(1); // useEffect watching page will trigger load
			}
		} catch (e) {
			console.error("[logs] clear failed:", e);
		}
	}

	const total = data?.total ?? 0;
	const counts = data?.counts ?? { error: 0, warn: 0, info: 0 };
	const totalPages = Math.ceil(total / LOG_PAGE_SIZE);

	return (
		<Section title="Event Log">
			<div className="border-b border-border">
				<div className="flex items-center justify-between px-4 py-2">
					<div className="flex items-center gap-3">
						{LEVEL_TABS.map((tab) => {
							const count =
								tab === "all"
									? counts.error + counts.warn + counts.info
									: (counts[tab as LogLevel] ?? 0);
							return (
								<button
									key={tab}
									type="button"
									onClick={() => handleTabChange(tab)}
									className={`text-[9px] tracking-widest uppercase transition-colors ${
										activeTab === tab
											? "text-foreground"
											: "text-muted-foreground/40 hover:text-muted-foreground/70"
									}`}
								>
									{tab}
									{count > 0 && (
										<span className="ml-1 tabular-nums text-muted-foreground/40">
											{count}
										</span>
									)}
								</button>
							);
						})}
					</div>
					{total > 0 && (
						<ConfirmAction
							label="clear all?"
							onConfirm={handleClear}
							trigger={(open) => (
								<button
									type="button"
									onClick={open}
									className="text-[8px] tracking-widest text-muted-foreground/30 hover:text-muted-foreground/60 uppercase transition-colors"
								>
									clear
								</button>
							)}
						/>
					)}
				</div>
			</div>

			{loading ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
					loading…
				</div>
			) : !data || data.logs.length === 0 ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/30">
					no logs
				</div>
			) : (
				data.logs.map((entry) => <LogEntryRow key={entry.id} entry={entry} />)
			)}

			{totalPages > 1 && (
				<div className="px-4 py-2.5 border-t border-border flex items-center justify-between">
					<button
						type="button"
						disabled={page <= 1 || loading}
						onClick={() => setPage((p) => p - 1)}
						className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
					>
						← prev
					</button>
					<span className="text-[9px] tabular-nums text-muted-foreground/30">
						{page} / {totalPages}
					</span>
					<button
						type="button"
						disabled={page >= totalPages || loading}
						onClick={() => setPage((p) => p + 1)}
						className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
					>
						next →
					</button>
				</div>
			)}
		</Section>
	);
}
