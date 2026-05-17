import { useEffect, useMemo, useRef, useState } from "react";
import type {
	ProviderUsageSnapshot,
	ProviderWindowEntry,
	UsageWindows,
} from "#/db";
import type { LiveStats } from "#/hooks/wsStore";
import { fmtResetTime } from "#/lib/formatters";
import type { RateLimitMessage } from "#/server/protocol";
import { PrivacyMask } from "./PrivacyMask";

// ─── Merge logic ─────────────────────────────────────────────────────────────

/**
 * Apply a rate_limit WS event to the local UsageWindows state.
 * Returns `prev` unchanged for unknown rateLimitType values so stale data is
 * never clobbered by an event we don't understand (e.g. "overage").
 */
export function applyRateLimitToWindowData(
	prev: UsageWindows | null,
	rateLimit: Pick<
		RateLimitMessage,
		"rateLimitType" | "utilization" | "resetsAt"
	>,
): UsageWindows | null {
	if (!prev || rateLimit.utilization == null) return prev;
	const update = {
		utilization: rateLimit.utilization ?? null,
		resetsAt: rateLimit.resetsAt ?? null,
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
	if (rateLimit.rateLimitType === "weekly")
		return { ...prev, weekly: { ...prev.weekly, ...update } };
	// Unknown rateLimitType (e.g. "seven_day_opus", "overage") — leave unchanged
	return prev;
}

export function mergeUsageWindows(
	fresh: UsageWindows,
	prev: UsageWindows | null,
): UsageWindows {
	if (!prev) return fresh;
	const now = Date.now() / 1000;
	const keep = (
		freshWin: UsageWindows["fiveHour"],
		prevWin: UsageWindows["fiveHour"],
	) => {
		// Only prefer prev when the server has no utilization data at all. When
		// the server returns a valid utilization it comes from the in-memory mark
		// overlay and is authoritative — even if it's lower (e.g. external reset).
		const prevValid =
			prevWin.utilization != null &&
			prevWin.resetsAt != null &&
			prevWin.resetsAt > now &&
			freshWin.utilization == null &&
			(freshWin.resetsAt == null || freshWin.resetsAt === prevWin.resetsAt);
		return {
			...freshWin,
			utilization: prevValid ? prevWin.utilization : freshWin.utilization,
			resetsAt: prevValid ? prevWin.resetsAt : freshWin.resetsAt,
		};
	};
	const prevSonnetValid =
		prev.weeklySonnet?.utilization != null &&
		prev.weeklySonnet?.resetsAt != null &&
		prev.weeklySonnet.resetsAt > now &&
		fresh.weeklySonnet?.utilization == null &&
		(fresh.weeklySonnet?.resetsAt == null ||
			fresh.weeklySonnet.resetsAt === prev.weeklySonnet.resetsAt);
	return {
		...fresh,
		fiveHour: keep(fresh.fiveHour, prev.fiveHour),
		weekly: keep(fresh.weekly, prev.weekly),
		weeklySonnet:
			fresh.weeklySonnet != null
				? prevSonnetValid
					? {
							...fresh.weeklySonnet,
							utilization: prev.weeklySonnet?.utilization ?? null,
							resetsAt: prev.weeklySonnet?.resetsAt ?? null,
						}
					: fresh.weeklySonnet
				: null,
	};
}

// ─── Shared section cells ─────────────────────────────────────────────────────

export function UsageWindowSection({
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
		win != null ? Math.min((win.utilization ?? 0) * 100, 100) : null;
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
					<PrivacyMask
						inline
						className="text-[9px] tabular-nums text-foreground/50"
					>
						${(win?.cost ?? 0).toFixed(2)}
					</PrivacyMask>
					<span className="text-muted-foreground/25 hidden md:inline">·</span>
					<PrivacyMask
						inline
						className="text-[8px] tracking-widest text-muted-foreground/40"
					>
						<span className="md:hidden">{win?.queries ?? 0}q</span>
						<span className="hidden md:inline">
							{win?.queries ?? 0} queries
						</span>
					</PrivacyMask>
					<span className="text-muted-foreground/25 hidden md:inline">·</span>
					<PrivacyMask
						inline
						className="text-[8px] tracking-widest text-muted-foreground/40"
					>
						<span className="md:hidden">{win?.sessions ?? 0}s</span>
						<span className="hidden md:inline">
							{win?.sessions ?? 0} sessions
						</span>
					</PrivacyMask>
				</div>
			)}
		</div>
	);
}

export function ContextWindowSection({ stats }: { stats: LiveStats }) {
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

export function RoutinesWindowSection() {
	return (
		<div className="flex-1 px-4 py-2.5 min-w-0">
			<div className="text-[9px] tracking-widest text-muted-foreground/40 uppercase mb-1.5">
				ROUTINES
			</div>
			<span className="text-[10px] tracking-widest text-muted-foreground/50">
				no routines configured
			</span>
		</div>
	);
}

// ─── Stateful panel ───────────────────────────────────────────────────────────

export function UsageWindowsPanel({
	initial,
	liveQueryCount,
	rateLimit,
	tail,
	fetchFn,
}: {
	initial: UsageWindows | null;
	liveQueryCount: number;
	rateLimit: RateLimitMessage | null;
	/** Extra section appended after the standard windows (e.g. ContextWindowSection or RoutinesWindowSection). */
	tail?: React.ReactNode;
	/** Called to refresh usage data; should resolve to the latest UsageWindows. */
	fetchFn: () => Promise<UsageWindows | null>;
}) {
	const [data, setData] = useState<UsageWindows | null>(initial);
	const fetchFnRef = useRef(fetchFn);
	fetchFnRef.current = fetchFn;

	useEffect(() => {
		if (liveQueryCount === 0) return;
		void fetchFnRef
			.current()
			.then((d) => {
				if (d) setData((prev) => mergeUsageWindows(d, prev));
			})
			.catch(() => {});
	}, [liveQueryCount]);

	useEffect(() => {
		const id = setInterval(
			() =>
				void fetchFnRef
					.current()
					.then((d) => {
						if (d) setData((prev) => mergeUsageWindows(d, prev));
					})
					.catch(() => {}),
			60_000,
		);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		if (!rateLimit || rateLimit.utilization == null) return;
		setData((prev) => applyRateLimitToWindowData(prev, rateLimit));
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
			{tail}
		</div>
	);
}

// ─── ProviderUsageStrip ───────────────────────────────────────────────────────

const PROVIDER_STRIP_KEY = "hlid_active_provider";

function ProviderWindowCell({ win }: { win: ProviderWindowEntry }) {
	const hasUtil = win.utilization != null;
	const hasRemaining =
		win.remaining != null && win.limit != null && win.limit > 0;
	const utilPct = hasUtil
		? Math.min((win.utilization as number) * 100, 100)
		: hasRemaining
			? Math.min(
					(1 - (win.remaining as number) / (win.limit as number)) * 100,
					100,
				)
			: null;

	return (
		<div className="flex-1 px-2 py-2 md:px-4 md:py-2.5 min-w-0 space-y-1">
			<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-0.5 md:gap-2">
				<div className="flex items-center gap-1.5 md:gap-2 min-w-0">
					<span className="text-[8px] md:text-[9px] tracking-widest text-muted-foreground/40 uppercase truncate leading-none">
						{win.label}
					</span>
					{utilPct != null && (
						<span className="text-[9px] md:text-[10px] tabular-nums font-medium text-foreground/60 shrink-0 leading-none">
							{hasUtil
								? `${Math.floor(utilPct)}%`
								: `${win.remaining?.toLocaleString()} left`}
						</span>
					)}
				</div>
				{win.resetsAt != null && (
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
			<div className="flex items-center flex-wrap gap-x-1.5 gap-y-0">
				<PrivacyMask
					inline
					className="text-[9px] tabular-nums text-foreground/50"
				>
					${(win.cost ?? 0).toFixed(2)}
				</PrivacyMask>
				<span className="text-muted-foreground/25 hidden md:inline">·</span>
				<PrivacyMask
					inline
					className="text-[8px] tracking-widest text-muted-foreground/40"
				>
					<span className="md:hidden">{win.queries}q</span>
					<span className="hidden md:inline">{win.queries} queries</span>
				</PrivacyMask>
			</div>
		</div>
	);
}

export function mergeProviderSnapshot(
	fresh: ProviderUsageSnapshot,
	prev: ProviderUsageSnapshot | undefined,
	rateLimit: RateLimitMessage | null,
): ProviderUsageSnapshot {
	if (!prev) {
		return applyRateLimitToSnapshot(fresh, rateLimit);
	}
	const now = Date.now() / 1000;
	const windows = fresh.windows.map((win) => {
		const prevWin = prev.windows.find((w) => w.windowId === win.windowId);
		// Only prefer prev when the server has no utilization data. A valid
		// fresh utilization comes from the in-memory mark overlay and is
		// authoritative — external Anthropic resets can lower it mid-window.
		const prevValid =
			prevWin?.utilization != null &&
			prevWin?.resetsAt != null &&
			prevWin.resetsAt > now &&
			win.utilization == null &&
			(win.resetsAt == null || win.resetsAt === prevWin.resetsAt);
		return {
			...win,
			utilization: prevValid
				? (prevWin?.utilization ?? win.utilization)
				: win.utilization,
			resetsAt: prevValid ? (prevWin?.resetsAt ?? win.resetsAt) : win.resetsAt,
		};
	});
	return applyRateLimitToSnapshot({ ...fresh, windows }, rateLimit);
}

function applyRateLimitToSnapshot(
	snapshot: ProviderUsageSnapshot,
	rateLimit: RateLimitMessage | null,
): ProviderUsageSnapshot {
	if (!rateLimit || rateLimit.providerId !== snapshot.providerId)
		return snapshot;
	if (rateLimit.utilization == null) return snapshot;
	const windowId = rateLimit.rateLimitType;
	if (!windowId) return snapshot;
	return {
		...snapshot,
		windows: snapshot.windows.map((w) =>
			w.windowId === windowId
				? {
						...w,
						utilization: rateLimit.utilization ?? w.utilization,
						resetsAt: rateLimit.resetsAt ?? w.resetsAt,
					}
				: w,
		),
	};
}

export function ProviderUsageStrip({
	initial,
	liveQueryCount,
	rateLimit,
	tail,
	fetchFn,
}: {
	initial: ProviderUsageSnapshot[];
	liveQueryCount: number;
	rateLimit: RateLimitMessage | null;
	tail?: React.ReactNode;
	fetchFn: () => Promise<ProviderUsageSnapshot[]>;
}) {
	const [snapshots, setSnapshots] = useState<ProviderUsageSnapshot[]>(initial);
	const fetchFnRef = useRef(fetchFn);
	fetchFnRef.current = fetchFn;

	const providerIds = useMemo(
		() => snapshots.map((s) => s.providerId),
		[snapshots],
	);
	const [activeProvider, setActiveProvider] = useState<string>(() => {
		try {
			const stored = localStorage.getItem(PROVIDER_STRIP_KEY);
			if (stored && providerIds.includes(stored)) return stored;
		} catch {}
		return providerIds[0] ?? "claude";
	});

	const activeSnapshot = snapshots.find((s) => s.providerId === activeProvider);

	const refreshRef = useRef(() => {
		void fetchFnRef
			.current()
			.then((fresh) => {
				setSnapshots((prev) =>
					fresh.map((f) => {
						const p = prev.find((p) => p.providerId === f.providerId);
						return mergeProviderSnapshot(f, p, null);
					}),
				);
			})
			.catch(() => {});
	});

	useEffect(() => {
		if (liveQueryCount === 0) return;
		refreshRef.current();
	}, [liveQueryCount]);

	useEffect(() => {
		const id = setInterval(() => refreshRef.current(), 60_000);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		if (!rateLimit) return;
		setSnapshots((prev) =>
			prev.map((s) => applyRateLimitToSnapshot(s, rateLimit)),
		);
		// Auto-select the provider that emitted the rate limit
		if (rateLimit.providerId && providerIds.includes(rateLimit.providerId)) {
			setActiveProvider(rateLimit.providerId);
		}
	}, [rateLimit, providerIds]);

	function handleProviderSelect(id: string) {
		setActiveProvider(id);
		try {
			localStorage.setItem(PROVIDER_STRIP_KEY, id);
		} catch {}
	}

	const showTabs = snapshots.length > 1;

	return (
		<div className="border-b border-border shrink-0">
			{showTabs && (
				<div className="flex items-center gap-1 px-3 pt-1.5 pb-0 border-b border-border/30">
					{snapshots.map((s) => (
						<button
							key={s.providerId}
							type="button"
							onClick={() => handleProviderSelect(s.providerId)}
							className={`text-[8px] tracking-widest uppercase px-2 py-0.5 transition-colors ${
								s.providerId === activeProvider
									? "text-foreground/70 border-b border-primary/60"
									: "text-muted-foreground/40 hover:text-muted-foreground/60"
							}`}
						>
							{s.providerLabel}
						</button>
					))}
				</div>
			)}
			<div className="flex divide-x divide-border/40">
				{(activeSnapshot?.windows ?? []).map((win) => (
					<ProviderWindowCell key={win.windowId} win={win} />
				))}
				{tail}
			</div>
		</div>
	);
}
