import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	Area,
	AreaChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { FirstRunWizard } from "#/components/wizard/FirstRunWizard";
import { getConfig } from "#/config";
import type {
	AggStats,
	SessionRow,
	ThirtyDayStats,
	UsageWindows,
	WeeklyStats,
} from "#/db";
import { useWs } from "#/hooks/useWs";
import * as wsStore from "#/hooks/wsStore";
import { uid } from "#/lib/utils";
import type { Skill } from "#/lib/vault";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

// ─── server fns ──────────────────────────────────────────────────────────────

const getCockpitData = createServerFn({ method: "GET" }).handler(async () => {
	const [
		{ readdirSync },
		{ join, resolve },
		{ homedir },
		{ scanProjects, scanSkills },
	] = await Promise.all([
		import("node:fs"),
		import("node:path"),
		import("node:os"),
		import("#/lib/vault"),
	]);
	const config = await getConfig();
	const { vault, status_vocabulary } = config;

	let inboxCount = 0;
	if (vault.path && vault.inbox) {
		try {
			inboxCount = readdirSync(join(vault.path, vault.inbox)).filter((f) =>
				f.endsWith(".md"),
			).length;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn("Failed to read inbox directory:", err);
			}
		}
	}

	let activeCount = 0;
	let totalCount = 0;
	if (vault.path && vault.projects) {
		const projects = scanProjects(
			vault.path,
			vault.projects,
			status_vocabulary,
		);
		totalCount = projects.length;
		activeCount = projects.filter((p) => p.status === "active").length;
	}

	const { skills: vaultSkills, sectionOrder } =
		vault.path && vault.skills
			? scanSkills(vault.path, vault.skills, config.ui.hide_skills_index)
			: { skills: [], sectionOrder: [] };

	const claudeSkillsDir = resolve(homedir(), ".claude", "skills");
	const { skills: rawClaudeSkills } = scanSkills(claudeSkillsDir, "", false);
	const claudeSkills = rawClaudeSkills.map((s) => ({
		...s,
		section: "claude",
	}));

	const skills = [...vaultSkills, ...claudeSkills];
	const allSectionOrder =
		claudeSkills.length > 0 ? [...sectionOrder, "claude"] : sectionOrder;

	return {
		inboxCount,
		activeCount,
		totalCount,
		skills,
		sectionOrder: allSectionOrder,
	};
});

const getRecentSessionsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { server } = await getConfig();
		const res = await fetch(
			`http://localhost:${server.port + 1}/db/recent-sessions?limit=5`,
		);
		if (!res.ok) return [] as SessionRow[];
		return res.json() as Promise<SessionRow[]>;
	},
);

const getCurrentSessionIdFn = createServerFn({ method: "GET" }).handler(
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

const getCockpitStatsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { server } = await getConfig();
		const res = await fetch(`http://localhost:${server.port + 1}/db/stats`);
		if (!res.ok) {
			return {
				agg: {
					allTime: {
						cost: 0,
						queries: 0,
						input_tokens: 0,
						output_tokens: 0,
						cache_read_tokens: 0,
						cache_creation_tokens: 0,
						turns: 0,
					},
					today: { cost: 0, queries: 0, tokens: 0 },
					thisMonth: { cost: 0, queries: 0, tokens: 0 },
				},
			} as { agg: AggStats };
		}
		const data = (await res.json()) as {
			agg: AggStats;
			sessions: SessionRow[];
		};
		return { agg: data.agg };
	},
);

const getWeeklyStatsFn = createServerFn({ method: "GET" }).handler(async () => {
	const { server } = await getConfig();
	try {
		const res = await fetch(
			`http://localhost:${server.port + 1}/db/weekly-stats`,
		);
		if (!res.ok)
			return { total: 0, days: [0, 0, 0, 0, 0, 0, 0] } as WeeklyStats;
		return res.json() as Promise<WeeklyStats>;
	} catch {
		return { total: 0, days: [0, 0, 0, 0, 0, 0, 0] } as WeeklyStats;
	}
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

const getThirtyDayStatsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { server } = await getConfig();
		try {
			const res = await fetch(
				`http://localhost:${server.port + 1}/db/thirty-day-stats`,
			);
			if (!res.ok) return { days: [], total: 0 } as ThirtyDayStats;
			return res.json() as Promise<ThirtyDayStats>;
		} catch {
			return { days: [], total: 0 } as ThirtyDayStats;
		}
	},
);

type McpServerEntry = {
	name: string;
	displayName: string;
	source: "cloud" | "vault" | "global";
	status:
		| "connected"
		| "failed"
		| "needs-auth"
		| "pending"
		| "disabled"
		| "unknown";
};

const getMcpServersFn = createServerFn({ method: "GET" }).handler(async () => {
	const config = await getConfig();
	const serverPort = config.server.port + 1;

	// Try live status from the WS server (populated after any session runs)
	try {
		const res = await fetch(`http://127.0.0.1:${serverPort}/mcp-status`);
		if (res.ok) {
			const servers = (await res.json()) as Array<{
				name: string;
				status: string;
				scope?: string;
				error?: string;
			}>;
			if (servers.length > 0) {
				return servers.map(
					(s): McpServerEntry => ({
						name: s.name,
						displayName: s.name.startsWith("claude.ai ")
							? s.name.slice("claude.ai ".length)
							: s.name,
						source:
							s.scope === "claudeai"
								? "cloud"
								: s.scope === "project"
									? "vault"
									: "global",
						status: (s.status as McpServerEntry["status"]) ?? "unknown",
					}),
				);
			}
		}
	} catch {
		// Server not running yet; fall through to static file read
	}

	// Fallback: read static config files (no live status available)
	const [{ readFileSync }, { join }, { homedir }] = await Promise.all([
		import("node:fs"),
		import("node:path"),
		import("node:os"),
	]);

	type McpServersMap = Record<string, unknown>;

	function parseMcpServers(filePath: string): string[] {
		try {
			const content = readFileSync(filePath, "utf8");
			const parsed = JSON.parse(content) as { mcpServers?: McpServersMap };
			return Object.keys(parsed.mcpServers ?? {});
		} catch {
			return [];
		}
	}

	const globalPath = join(homedir(), ".claude", "settings.json");
	const globalServers = parseMcpServers(globalPath);

	const vaultServers: string[] = [];
	if (config.vault.path) {
		const vaultMcpPath = join(config.vault.path, ".mcp.json");
		vaultServers.push(...parseMcpServers(vaultMcpPath));
	}

	const seen = new Set<string>();
	const result: McpServerEntry[] = [];
	for (const name of vaultServers) {
		seen.add(name);
		result.push({
			name,
			displayName: name,
			source: "vault",
			status: "unknown",
		});
	}
	for (const name of globalServers) {
		if (!seen.has(name)) {
			result.push({
				name,
				displayName: name,
				source: "global",
				status: "unknown",
			});
		}
	}
	return result;
});

// ─── route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/")({
	loader: async () => {
		const [
			config,
			data,
			recentSessions,
			statsData,
			mcpServers,
			weeklyStats,
			usageWindows,
			thirtyDayStats,
		] = await Promise.all([
			getConfig(),
			getCockpitData(),
			getRecentSessionsFn(),
			getCockpitStatsFn(),
			getMcpServersFn(),
			getWeeklyStatsFn(),
			getUsageWindowsFn(),
			getThirtyDayStatsFn(),
		]);
		return {
			config,
			data,
			recentSessions,
			statsData,
			mcpServers,
			weeklyStats,
			usageWindows,
			thirtyDayStats,
		};
	},
	component: CockpitPage,
});

// ─── constants ───────────────────────────────────────────────────────────────

const MODEL_LABELS: Record<string, string> = {
	"claude-opus-4-7": "Opus 4.7",
	"claude-sonnet-4-6": "Sonnet 4.6",
	"claude-haiku-4-5-20251001": "Haiku 4.5",
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmtRunTime(unixSecs: number): string {
	const d = new Date(unixSecs * 1000);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function fmtMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function fmtResetTime(unixSecs: number): string {
	const diff = unixSecs - Date.now() / 1000;
	if (diff <= 0) return "now";
	const h = Math.floor(diff / 3600);
	const m = Math.floor((diff % 3600) / 60);
	if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function groupSkills(
	skills: Skill[],
	sectionOrder: string[],
): { section: string | null; skills: Skill[] }[] {
	const groups: { section: string | null; skills: Skill[] }[] = [];
	const seen = new Set<string>();
	for (const sec of sectionOrder) {
		const members = skills.filter((s) => s.section === sec);
		if (members.length === 0) continue;
		groups.push({
			section: sec,
			skills: [...members].sort((a, b) => a.name.localeCompare(b.name)),
		});
		for (const s of members) seen.add(s.file);
	}
	const unsectioned = skills.filter((s) => !seen.has(s.file));
	if (unsectioned.length > 0)
		groups.push({
			section: null,
			skills: [...unsectioned].sort((a, b) => a.name.localeCompare(b.name)),
		});
	groups.sort((a, b) => {
		if (a.section === null) return 1;
		if (b.section === null) return -1;
		if (a.section === "claude") return 1;
		if (b.section === "claude") return -1;
		return a.section.localeCompare(b.section);
	});
	return groups;
}

// ─── components ──────────────────────────────────────────────────────────────

function UtilBar({ value, max }: { value: number; max: number }) {
	const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
	const color =
		pct > 80 ? "bg-destructive" : pct > 60 ? "bg-yellow-600" : "bg-primary";
	return (
		<div className="h-1 bg-secondary overflow-hidden mt-1">
			<div
				className={`h-full transition-all ${color}`}
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"] as const;

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function WeekBarGraph({ days }: { days: number[] }) {
	const max = Math.max(...days, 1);
	const today = new Date().getDay();
	return (
		<div className="flex items-end gap-0.5">
			{days.map((count, i) => (
				<div
					key={DAY_KEYS[i]}
					className="flex flex-col items-center gap-0.5 flex-1 min-w-0"
				>
					<span className="text-[7px] tabular-nums text-muted-foreground/25 leading-none h-2 flex items-end">
						{count > 0 ? count : ""}
					</span>
					<div
						className="w-full flex items-end"
						style={{ height: "20px" }}
						aria-hidden
					>
						<div
							className={`w-full transition-all ${i === today ? "bg-primary/60" : "bg-primary/20"}`}
							style={{
								height: `${count > 0 ? Math.max((count / max) * 20, 2) : 0}px`,
							}}
						/>
					</div>
					<span
						className={`text-[8px] tracking-wider ${i === today ? "text-primary/50" : "text-muted-foreground/25"}`}
					>
						{DAY_LABELS[i]}
					</span>
				</div>
			))}
		</div>
	);
}

function DashboardHeader({
	stats,
	agg,
	isConnected,
}: {
	stats: wsStore.LiveStats;
	agg: AggStats;
	isConnected: boolean;
}) {
	const idle = stats.queries === 0;

	return (
		<div className="border-b border-border shrink-0">
			{/* Row 1 — primary windows */}
			<div className="grid grid-cols-3 divide-x divide-border border-b border-border">
				{/* SESSION */}
				<div className="px-3 md:px-5 py-3 md:py-4">
					<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase mb-1 md:mb-2">
						Session
					</div>
					<div
						className={`text-lg md:text-2xl font-bold tabular-nums leading-none ${idle && !isConnected ? "text-muted-foreground/20" : "text-[var(--data)]"}`}
					>
						{isConnected || stats.cost > 0 ? `$${stats.cost.toFixed(4)}` : "--"}
					</div>
					<div className="mt-1 md:mt-1.5 text-[9px] tracking-wider text-muted-foreground/40">
						{idle ? "idle" : `${stats.queries}q · ${fmtMs(stats.duration_ms)}`}
					</div>
				</div>

				{/* TODAY */}
				<div className="px-3 md:px-5 py-3 md:py-4">
					<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase mb-1 md:mb-2">
						Today
					</div>
					<div className="text-lg md:text-2xl font-bold tabular-nums leading-none text-[var(--data)]">
						${agg.today.cost.toFixed(4)}
					</div>
					<div className="mt-1 md:mt-1.5 text-[9px] tracking-wider text-muted-foreground/40">
						{agg.today.queries}q · {fmt(agg.today.tokens)} tok
					</div>
				</div>

				{/* THIS MONTH */}
				<div className="px-3 md:px-5 py-3 md:py-4">
					<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase mb-1 md:mb-2">
						This Month
					</div>
					<div className="text-lg md:text-2xl font-bold tabular-nums leading-none text-[var(--data)]">
						${agg.thisMonth.cost.toFixed(4)}
					</div>
					<div className="mt-1 md:mt-1.5 text-[9px] tracking-wider text-muted-foreground/40">
						{agg.thisMonth.queries}q · {fmt(agg.thisMonth.tokens)} tok
					</div>
				</div>
			</div>

			{/* Row 2 — all-time */}
			<div className="px-5 py-3 flex items-center gap-6">
				<div>
					<div className="text-[9px] tracking-widest text-muted-foreground/40 uppercase mb-1">
						All Time
					</div>
					<div className="text-sm font-bold tabular-nums text-foreground/60">
						${agg.allTime.cost.toFixed(2)}
					</div>
				</div>
				<div className="flex items-center gap-4 text-[9px] tracking-wider text-muted-foreground/40">
					<span>
						<span className="text-foreground/50 tabular-nums">
							{fmt(agg.allTime.queries)}
						</span>{" "}
						queries
					</span>
					<span>
						<span className="text-foreground/50 tabular-nums">
							{fmt(agg.allTime.turns)}
						</span>{" "}
						turns
					</span>
					<span>
						<span className="text-foreground/50 tabular-nums">
							{fmt(
								agg.allTime.input_tokens +
									agg.allTime.output_tokens +
									agg.allTime.cache_read_tokens,
							)}
						</span>{" "}
						tok
					</span>
				</div>
			</div>
		</div>
	);
}

function fmtTickDate(iso: string): string {
	const [, m, d] = iso.split("-");
	const month = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	][parseInt(m, 10) - 1];
	return `${month} ${parseInt(d, 10)}`;
}

function ThirtyDayGraph({ data }: { data: ThirtyDayStats }) {
	const points = useMemo(() => {
		let running = 0;
		return data.days.map((d) => {
			running += d.count;
			return { date: d.date, value: running };
		});
	}, [data.days]);

	const isEmpty = data.total === 0;

	const tickDates = useMemo(() => {
		if (data.days.length === 0) return [];
		// show ~4 ticks: day 0, ~10, ~20, last
		return [0, 9, 19, 29]
			.filter((i) => i < data.days.length)
			.map((i) => data.days[i].date);
	}, [data.days]);

	return (
		<div className="border-b border-border shrink-0 px-4 pt-2.5 pb-0">
			<div className="flex items-center justify-between mb-1">
				<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
					30D Activity
				</span>
				<span className="text-[9px] tabular-nums text-muted-foreground/50">
					{data.total} sessions
				</span>
			</div>
			<ResponsiveContainer width="100%" height={56}>
				<AreaChart
					data={points}
					margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
				>
					<defs>
						<linearGradient id="thirtyDayFill" x1="0" y1="0" x2="0" y2="1">
							<stop
								offset="0%"
								style={{ stopColor: "var(--data)" }}
								stopOpacity={0.2}
							/>
							<stop
								offset="100%"
								style={{ stopColor: "var(--data)" }}
								stopOpacity={0}
							/>
						</linearGradient>
					</defs>
					<XAxis
						dataKey="date"
						ticks={tickDates}
						tickFormatter={fmtTickDate}
						tickLine={false}
						axisLine={false}
						tick={{
							fontSize: 8,
							fill: "color-mix(in oklch, var(--muted-foreground) 45%, transparent)",
							fontFamily: "inherit",
						}}
						interval="preserveStartEnd"
						height={16}
					/>
					<YAxis hide domain={isEmpty ? [0, 1] : ["auto", "auto"]} />
					<Tooltip
						content={({ active, payload }) => {
							if (!active || !payload?.length) return null;
							const val = payload[0]?.value;
							if (val == null) return null;
							return (
								<div className="text-[9px] tabular-nums bg-background/90 border border-border px-1.5 py-0.5 rounded shadow-sm text-foreground/70">
									{val}
								</div>
							);
						}}
						cursor={{
							stroke: "var(--data)",
							strokeWidth: 1,
							strokeOpacity: 0.3,
						}}
					/>
					<Area
						type="monotone"
						dataKey="value"
						stroke="var(--data)"
						strokeWidth={1.5}
						fill="url(#thirtyDayFill)"
						dot={false}
						activeDot={{ r: 3, fill: "var(--data)", strokeWidth: 0 }}
						isAnimationActive={false}
					/>
				</AreaChart>
			</ResponsiveContainer>
		</div>
	);
}

function MobileStatsPanel({
	stats,
	agg,
	isConnected,
}: {
	stats: wsStore.LiveStats;
	agg: AggStats;
	isConnected: boolean;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="md:hidden shrink-0">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="w-full flex items-center justify-between px-4 py-2.5 border-b border-border hover:bg-accent/20 transition-colors"
			>
				<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
					Costs
				</span>
				<span
					className="text-[9px] text-muted-foreground/30 transition-transform"
					style={{ transform: open ? "rotate(180deg)" : undefined }}
				>
					▾
				</span>
			</button>
			{open && (
				<DashboardHeader stats={stats} agg={agg} isConnected={isConnected} />
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
		weeklySonnet: prev.weeklySonnet ?? fresh.weeklySonnet ?? null,
	};
}

function UsageWindowsPanel({
	initial,
	liveQueryCount,
	rateLimit,
}: {
	initial: UsageWindows | null;
	liveQueryCount: number;
	rateLimit: RateLimitMessage | null;
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
			const is5hr = rateLimit.rateLimitType === "five_hour";
			if (is5hr) return { ...prev, fiveHour: { ...prev.fiveHour, ...update } };
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
			<RoutinesWindowSection />
		</div>
	);
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

function MobileContextBand({ stats }: { stats: wsStore.LiveStats }) {
	const hasContext =
		stats.last_context_used != null && stats.context_window != null;
	if (!hasContext) return null;
	const contextUsed = stats.last_context_used ?? 0;
	const contextWindow = stats.context_window ?? 0;
	const contextPct =
		contextWindow > 0 ? ((contextUsed / contextWindow) * 100).toFixed(0) : "0";
	return (
		<div className="md:hidden border-b border-border shrink-0 px-4 py-2 flex items-center gap-3">
			<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
				Context
			</span>
			<div className="flex-1">
				<UtilBar value={contextUsed} max={contextWindow} />
			</div>
			<span className="text-[9px] tabular-nums text-muted-foreground/40 shrink-0">
				{contextPct}%
			</span>
		</div>
	);
}

function RoutinesWindowSection() {
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

const MCP_STATUS_ORDER: Record<McpServerEntry["status"], number> = {
	connected: 0,
	pending: 1,
	"needs-auth": 2,
	failed: 3,
	disabled: 4,
	unknown: 5,
};

function McpPanel({ servers }: { servers: McpServerEntry[] }) {
	const sorted = [...servers].sort(
		(a, b) => MCP_STATUS_ORDER[a.status] - MCP_STATUS_ORDER[b.status],
	);

	function dotClass(status: McpServerEntry["status"]): string {
		switch (status) {
			case "connected":
				return "bg-green-500/80";
			case "needs-auth":
				return "bg-amber-400/70";
			case "failed":
				return "bg-red-500/70";
			case "pending":
				return "bg-yellow-400/60 animate-pulse";
			default:
				return "bg-primary/30";
		}
	}

	return (
		<div className="border-b border-border shrink-0 flex items-center gap-3 px-4 py-2 overflow-x-auto">
			<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
				MCP
			</span>
			<span className="w-px h-3 bg-border/60 shrink-0" />
			{sorted.length === 0 ? (
				<span className="text-[9px] tracking-widest text-muted-foreground/50">
					no mcp configured
				</span>
			) : (
				sorted.map((s) => (
					<span key={s.name} className="flex items-center gap-1.5 shrink-0">
						<span
							className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass(s.status)}`}
						/>
						<span className="text-[9px] tracking-widest uppercase text-foreground/50">
							{s.displayName}
							{s.source === "vault" && (
								<span className="text-muted-foreground/30 ml-0.5">·v</span>
							)}
							{s.source === "global" && (
								<span className="text-muted-foreground/30 ml-0.5">·g</span>
							)}
						</span>
					</span>
				))
			)}
		</div>
	);
}

function SkillCard({
	skill,
	active,
	onSelect,
}: {
	skill: Skill;
	active: boolean;
	onSelect: (skill: Skill) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(skill)}
			className={`flex flex-col w-full px-3 py-2 border text-left transition-colors ${
				active
					? "border-primary/40 bg-primary/[0.08]"
					: "border-border bg-card hover:border-primary/20 hover:bg-primary/[0.03]"
			}`}
		>
			<span
				className={`text-[11px] tracking-wider font-medium uppercase ${
					active ? "text-primary" : "text-foreground/80"
				}`}
			>
				{skill.name}
			</span>
			{skill.description && (
				<span className="text-[9px] tracking-wider text-muted-foreground/40 truncate w-full mt-0.5">
					{skill.description}
				</span>
			)}
		</button>
	);
}

function RunList({
	runs,
	onRunClick,
}: {
	runs: SessionRow[];
	onRunClick: (sessionId: string) => void;
}) {
	if (runs.length === 0) {
		return (
			<div className="flex items-center justify-center py-4">
				<span className="text-[9px] tracking-widest text-muted-foreground/50">
					no runs yet
				</span>
			</div>
		);
	}
	return (
		<>
			{runs.map((run) => (
				<button
					key={run.id}
					type="button"
					onClick={() => onRunClick(run.id)}
					className="flex items-center gap-2 w-full px-4 py-2 border-b border-border/20 last:border-0 hover:bg-accent/30 transition-colors text-left group"
				>
					<span className="text-[9px] tabular-nums text-primary/50 shrink-0 font-mono w-9">
						{fmtRunTime(run.started_at)}
					</span>
					<span className="text-[10px] tracking-wider text-muted-foreground/60 truncate flex-1">
						{run.label ?? "—"}
					</span>
					<span className="text-[8px] tracking-widest text-muted-foreground/20 uppercase shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
						↗
					</span>
				</button>
			))}
		</>
	);
}

function ViewAllLink() {
	const navigate = useNavigate();
	return (
		<div className="px-4 py-2 border-t border-border/30">
			<button
				type="button"
				onClick={() => navigate({ to: "/stats", search: { page: 1 } })}
				className="text-[8px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors w-full text-left"
			>
				view all →
			</button>
		</div>
	);
}

function RecentRunsSidebar({
	runs,
	weeklyStats,
	onRunClick,
	stats,
	agg,
	isConnected,
	className = "",
}: {
	runs: SessionRow[];
	weeklyStats: WeeklyStats;
	onRunClick: (sessionId: string) => void;
	stats: wsStore.LiveStats;
	agg: AggStats;
	isConnected: boolean;
	className?: string;
}) {
	const idle = stats.queries === 0;
	const hasContext =
		stats.last_context_used != null && stats.context_window != null;
	const contextUsed = stats.last_context_used ?? 0;
	const contextWindow = stats.context_window ?? 0;
	const contextPct =
		hasContext && contextWindow > 0
			? ((contextUsed / contextWindow) * 100).toFixed(0)
			: "0";

	return (
		<div
			className={`w-72 border-l border-border flex flex-col shrink-0 overflow-hidden ${className}`}
		>
			{/* Stats block */}
			<div className="border-b border-border shrink-0">
				<div className="grid grid-cols-2 divide-x divide-border border-b border-border">
					<div className="px-3 py-3">
						<div className="text-[8px] tracking-widest text-muted-foreground/50 uppercase mb-1">
							Session
						</div>
						<div
							className={`text-sm font-bold tabular-nums leading-none ${idle && !isConnected ? "text-muted-foreground/20" : "text-[var(--data)]"}`}
						>
							{isConnected || stats.cost > 0
								? `$${stats.cost.toFixed(4)}`
								: "--"}
						</div>
						<div className="mt-1 text-[8px] tracking-wider text-muted-foreground/40">
							{idle
								? "idle"
								: `${stats.queries}q · ${fmtMs(stats.duration_ms)}`}
						</div>
					</div>
					<div className="px-3 py-3">
						<div className="text-[8px] tracking-widest text-muted-foreground/50 uppercase mb-1">
							Today
						</div>
						<div className="text-sm font-bold tabular-nums leading-none text-[var(--data)]">
							${agg.today.cost.toFixed(4)}
						</div>
						<div className="mt-1 text-[8px] tracking-wider text-muted-foreground/40">
							{agg.today.queries}q · {fmt(agg.today.tokens)} tok
						</div>
					</div>
				</div>
				<div className="grid grid-cols-2 divide-x divide-border border-b border-border">
					<div className="px-3 py-2.5">
						<div className="text-[8px] tracking-widest text-muted-foreground/50 uppercase mb-1">
							Month
						</div>
						<div className="text-sm font-bold tabular-nums leading-none text-[var(--data)]">
							${agg.thisMonth.cost.toFixed(4)}
						</div>
						<div className="mt-1 text-[8px] tracking-wider text-muted-foreground/40">
							{agg.thisMonth.queries}q · {fmt(agg.thisMonth.tokens)} tok
						</div>
					</div>
					<div className="px-3 py-2.5">
						<div className="text-[8px] tracking-widest text-muted-foreground/40 uppercase mb-1">
							All Time
						</div>
						<div className="text-sm font-bold tabular-nums text-foreground/60">
							${agg.allTime.cost.toFixed(2)}
						</div>
					</div>
				</div>
				{hasContext && (
					<div className="px-3 py-2 border-t border-border flex items-center gap-2">
						<span className="text-[8px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
							Ctx
						</span>
						<div className="flex-1">
							<UtilBar value={contextUsed} max={contextWindow} />
						</div>
						<span className="text-[8px] tabular-nums text-muted-foreground/40 shrink-0">
							{contextPct}%
						</span>
					</div>
				)}
			</div>

			<div className="px-4 py-2.5 border-b border-border shrink-0 flex items-center justify-between">
				<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
					Recent Runs
				</span>
				{runs.length > 0 && (
					<span className="text-[9px] tabular-nums text-muted-foreground/50">
						{runs.length}
					</span>
				)}
			</div>
			<div className="overflow-auto">
				<RunList runs={runs} onRunClick={onRunClick} />
				<ViewAllLink />
			</div>
			<div className="border-t border-border">
				<div className="px-4 py-2.5 border-b border-border/40 flex items-center justify-between">
					<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
						This Week
					</span>
					<span className="text-[9px] tabular-nums text-muted-foreground/30">
						{weeklyStats.total} runs
					</span>
				</div>
				<div className="px-4 py-3">
					<WeekBarGraph days={weeklyStats.days} />
				</div>
			</div>
		</div>
	);
}

function MobileRunsPanel({
	runs,
	weeklyStats,
	onRunClick,
}: {
	runs: SessionRow[];
	weeklyStats: WeeklyStats;
	onRunClick: (sessionId: string) => void;
}) {
	const [runsOpen, setRunsOpen] = useState(false);
	const [weekOpen, setWeekOpen] = useState(true);

	return (
		<div className="md:hidden border-b border-border shrink-0">
			{/* Recent runs — collapsed by default */}
			<button
				type="button"
				onClick={() => setRunsOpen((v) => !v)}
				className="w-full flex items-center justify-between px-4 py-2.5 border-b border-border/60 hover:bg-accent/20 transition-colors"
			>
				<div className="flex items-center gap-2">
					<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
						Recent Runs
					</span>
					{runs.length > 0 && (
						<span className="text-[9px] tabular-nums text-muted-foreground/25">
							{runs.length}
						</span>
					)}
				</div>
				<span
					className="text-[9px] text-muted-foreground/30 transition-transform"
					style={{ transform: runsOpen ? "rotate(180deg)" : undefined }}
				>
					▾
				</span>
			</button>
			{runsOpen && (
				<div className="border-b border-border/40">
					<RunList runs={runs} onRunClick={onRunClick} />
					<ViewAllLink />
				</div>
			)}

			{/* This week — open by default */}
			<button
				type="button"
				onClick={() => setWeekOpen((v) => !v)}
				className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-accent/20 transition-colors"
			>
				<div className="flex items-center gap-2">
					<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
						This Week
					</span>
					<span className="text-[9px] tabular-nums text-muted-foreground/30">
						{weeklyStats.total} runs
					</span>
				</div>
				<span
					className="text-[9px] text-muted-foreground/30 transition-transform"
					style={{ transform: weekOpen ? "rotate(180deg)" : undefined }}
				>
					▾
				</span>
			</button>
			{weekOpen && (
				<div className="px-4 pb-3 pt-1">
					<WeekBarGraph days={weeklyStats.days} />
				</div>
			)}
		</div>
	);
}

// ─── page ────────────────────────────────────────────────────────────────────

function CockpitPage() {
	const {
		config,
		data,
		recentSessions,
		statsData,
		mcpServers: initialMcpServers,
		weeklyStats: initialWeeklyStats,
		usageWindows: initialUsageWindows,
		thirtyDayStats: initialThirtyDayStats,
	} = Route.useLoaderData();
	const router = useRouter();
	const navigate = useNavigate();
	const liveStats = useSyncExternalStore(
		wsStore.subscribeStats,
		wsStore.getLiveStats,
		wsStore.getLiveStats,
	);
	const [prompt, setPrompt] = useState("");
	const [activeSkill, setActiveSkill] = useState<{
		name: string;
		section?: string;
		filePath: string;
	} | null>(null);
	const [background, setBackground] = useState(false);
	const [sameSession, setSameSession] = useState(false);
	const [recentRuns, setRecentRuns] = useState<SessionRow[]>(recentSessions);
	const [agg, setAgg] = useState<AggStats>(statsData.agg);
	const [weeklyStats, setWeeklyStats] =
		useState<WeeklyStats>(initialWeeklyStats);
	const [thirtyDayStats, setThirtyDayStats] = useState<ThirtyDayStats>(
		initialThirtyDayStats,
	);
	const [mcpServers, setMcpServers] =
		useState<McpServerEntry[]>(initialMcpServers);
	const [runError, setRunError] = useState<string | null>(null);
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const { wsStatus, sessionState, model, send } = useWs(
		(msg: ServerMessage) => {
			if (msg.type === "done") {
				setRunError(null);
				getRecentSessionsFn().then(setRecentRuns);
				getCockpitStatsFn().then((d) => setAgg(d.agg));
				getWeeklyStatsFn().then(setWeeklyStats);
				getThirtyDayStatsFn().then(setThirtyDayStats);
			}
			if (msg.type === "error") {
				setRunError(msg.message);
			}
			if (msg.type === "rate_limit") {
				setRateLimit(msg);
			}
			if (msg.type === "mcp_status") {
				setMcpServers(
					msg.servers.map((s) => ({
						name: s.name,
						displayName: s.name.startsWith("claude.ai ")
							? s.name.slice("claude.ai ".length)
							: s.name,
						source:
							s.scope === "claudeai"
								? "cloud"
								: s.scope === "project"
									? "vault"
									: "global",
						status: (s.status as McpServerEntry["status"]) ?? "unknown",
					})),
				);
			}
		},
	);

	useEffect(() => {
		send({ type: "sync_mcp_list" });
	}, [send]);

	const skillGroups = useMemo(
		() => groupSkills(data.skills, data.sectionOrder),
		[data.skills, data.sectionOrder],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: prompt length triggers resize
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
	}, [prompt]);

	if (!config.vault.path) {
		return <FirstRunWizard onComplete={() => router.invalidate()} />;
	}

	function handleSkillSelect(skill: Skill) {
		setPrompt("");
		setActiveSkill({
			name: skill.name,
			section: skill.section,
			filePath: skill.filePath,
		});
		setTimeout(() => {
			const el = textareaRef.current;
			if (!el) return;
			el.focus();
			el.selectionStart = el.selectionEnd = 0;
		}, 0);
	}

	function handleClear() {
		setPrompt("");
		setActiveSkill(null);
	}

	async function handleRun() {
		const typed = prompt.trim();
		let skillContext: string | undefined;
		let text: string;

		if (activeSkill) {
			if (activeSkill.section === "claude") {
				// Claude skill: pass as slash command, CLI handles it natively
				text = typed
					? `/${activeSkill.name}: ${typed}`
					: `/${activeSkill.name}`;
			} else {
				// Vault skill: pass file path, server instructs Claude to read it
				skillContext = activeSkill.filePath;
				text = typed
					? `/${activeSkill.name}: ${typed}`
					: `/${activeSkill.name}`;
			}
		} else if (typed.startsWith("/")) {
			const slashName = typed.slice(1).split(/[:\s]/)[0].toLowerCase();
			const match = data.skills.find((s) => s.name.toLowerCase() === slashName);
			if (match) {
				if (match.section !== "claude") {
					skillContext = match.filePath;
					text = typed.slice(match.name.length + 2).trim(); // strip "/name: "
				} else {
					text = typed; // Claude skill: keep slash, CLI handles
				}
			} else {
				text = typed;
			}
		} else {
			text = typed;
		}
		if (!text || isRunning || wsStatus !== "connected") return;
		setRunError(null);
		let sessionId: string;
		if (sameSession) {
			const currentId = await getCurrentSessionIdFn();
			sessionId = currentId ?? uid();
		} else {
			sessionId = uid();
		}
		if (!sameSession) wsStore.resetLiveStats();
		send({
			type: "chat",
			text,
			session_id: sessionId,
			skill_context: skillContext,
		});
		setPrompt("");
		setActiveSkill(null);
		if (!background) {
			wsStore.setPendingPrompt(text);
			navigate({
				to: "/chat",
				search: { session: sessionId, agent: undefined },
			});
		}
	}

	const isConnected = wsStatus === "connected";
	const isRunning = isConnected && sessionState === "running";
	const canRun =
		(!!activeSkill || prompt.trim().length > 0) && !isRunning && isConnected;

	const modelShort = model
		? (MODEL_LABELS[model] ??
			model.replace("claude-", "").replace(/-\d{8}$/, ""))
		: null;

	return (
		<div className="flex flex-col md:h-full">
			{/* Header strip */}
			<div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0">
				<span className="text-[11px] tracking-widest text-primary uppercase">
					{config.vault.name || "HLID"}
				</span>
				{modelShort && (
					<>
						<span className="text-muted-foreground/25">·</span>
						<span className="text-[10px] tracking-widest text-muted-foreground/40">
							{modelShort}
						</span>
					</>
				)}
			</div>

			{/* Usage windows */}
			<UsageWindowsPanel
				initial={initialUsageWindows}
				liveQueryCount={liveStats?.queries ?? 0}
				rateLimit={rateLimit}
			/>

			{/* Mobile context band — shows context % when active */}
			<MobileContextBand stats={liveStats} />

			{/* 30-day activity graph */}
			<ThirtyDayGraph data={thirtyDayStats} />

			{/* Stats — desktop: right sidebar; mobile: collapsible section */}
			<MobileStatsPanel stats={liveStats} agg={agg} isConnected={isConnected} />

			{/* MCP panel */}
			<McpPanel servers={mcpServers} />

			{/* Mobile: collapsible recent runs + this week graph */}
			<MobileRunsPanel
				runs={recentRuns}
				weeklyStats={weeklyStats}
				onRunClick={(id) =>
					navigate({ to: "/chat", search: { session: id, agent: undefined } })
				}
			/>

			{/* Two-column body */}
			<div className="flex md:flex-1 md:overflow-hidden">
				{/* Main column */}
				<div className="flex flex-col flex-1 md:overflow-auto">
					{/* Prompt area */}
					<div className="p-4 border-b border-border space-y-2 shrink-0">
						<div className="flex items-center justify-between mb-1">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								PROMPT
								{activeSkill && (
									<span className="text-primary/50 ml-2">
										· {activeSkill.name}
									</span>
								)}
							</div>
						</div>

						<div
							className={`border bg-card transition-colors ${isConnected ? "border-border focus-within:border-primary/30" : "border-border/40"}`}
						>
							<div className="flex items-start">
								<span className="text-primary text-sm px-3 py-2.5 shrink-0 select-none">
									›
								</span>
								<textarea
									ref={textareaRef}
									value={prompt}
									onChange={(e) => {
										setPrompt(e.target.value);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
											e.preventDefault();
											handleRun();
											return;
										}
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
											handleRun();
										}
									}}
									rows={3}
									placeholder={
										!isConnected
											? "server offline…"
											: activeSkill
												? "add context… (optional)"
												: "type a prompt, or pick a skill below"
									}
									disabled={!isConnected}
									className="flex-1 resize-none bg-transparent py-2.5 pr-3 text-sm text-foreground placeholder:text-muted-foreground/25 focus:outline-none disabled:opacity-30 overflow-hidden min-h-[72px]"
								/>
							</div>
							<div className="flex items-center justify-between px-3 py-2 border-t border-border/60">
								<div className="flex items-center gap-3">
									<label className="flex items-center gap-1.5 cursor-pointer select-none group">
										<input
											type="checkbox"
											checked={background}
											onChange={(e) => setBackground(e.target.checked)}
											className="sr-only"
										/>
										<span
											className={`w-3 h-3 border flex items-center justify-center shrink-0 transition-colors ${background ? "border-primary bg-primary/20" : "border-border bg-secondary group-hover:border-primary/40"}`}
										>
											{background && (
												<span className="w-1.5 h-1.5 bg-primary block" />
											)}
										</span>
										<span className="text-[9px] tracking-wider text-muted-foreground/40 uppercase">
											Background
										</span>
									</label>
									<label className="flex items-center gap-1.5 cursor-pointer select-none group">
										<input
											type="checkbox"
											checked={sameSession}
											onChange={(e) => setSameSession(e.target.checked)}
											className="sr-only"
										/>
										<span
											className={`w-3 h-3 border flex items-center justify-center shrink-0 transition-colors ${sameSession ? "border-primary bg-primary/20" : "border-border bg-secondary group-hover:border-primary/40"}`}
										>
											{sameSession && (
												<span className="w-1.5 h-1.5 bg-primary block" />
											)}
										</span>
										<span className="text-[9px] tracking-wider text-muted-foreground/40 uppercase">
											Same Session
										</span>
									</label>
								</div>
								<div className="flex gap-2">
									{(prompt || activeSkill) && (
										<button
											type="button"
											onClick={handleClear}
											className="px-3 py-1 border border-border text-[10px] tracking-widest text-muted-foreground/50 hover:text-foreground hover:border-border/80 transition-colors uppercase"
										>
											CLEAR
										</button>
									)}
									<button
										type="button"
										onClick={handleRun}
										disabled={!canRun}
										className="px-3 py-1 bg-primary text-primary-foreground text-[10px] tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-25 uppercase"
									>
										RUN →
									</button>
								</div>
							</div>
						</div>
					</div>

					{/* Background run error */}
					{runError && (
						<div className="px-4 py-2 border-b border-destructive/20 bg-destructive/5 shrink-0">
							<span className="text-[10px] tracking-wider text-destructive/80">
								ERR: {runError}
							</span>
						</div>
					)}

					{/* Skills */}
					{data.skills.length > 0 ? (
						<div className="p-4 grid grid-cols-1 md:grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-4 gap-y-5">
							{skillGroups.map((g) => (
								<div
									key={g.section ?? "__unsectioned__"}
									className="space-y-2 min-w-0"
								>
									<div className="flex items-center gap-2">
										<span className="w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0" />
										<span className="text-[10px] tracking-widest text-muted-foreground uppercase">
											{g.section ?? "SKILLS"}
										</span>
										<span className="text-[10px] text-muted-foreground/50">
											{g.skills.length}
										</span>
									</div>
									<div className="grid grid-cols-2 gap-2 md:grid-cols-1">
										{g.skills.map((skill) => (
											<SkillCard
												key={skill.file}
												skill={skill}
												active={activeSkill?.name === skill.name}
												onSelect={(s) => handleSkillSelect(s)}
											/>
										))}
									</div>
								</div>
							))}
						</div>
					) : (
						<div className="flex-1 flex items-center justify-center">
							<div className="text-center space-y-2">
								<div className="text-[10px] tracking-widest text-muted-foreground/30 uppercase">
									no skills yet
								</div>
								<div className="text-[9px] tracking-wider text-muted-foreground/20">
									drop .md files into your vault skills folder
								</div>
							</div>
						</div>
					)}
				</div>

				{/* Recent runs sidebar — desktop only */}
				<RecentRunsSidebar
					runs={recentRuns}
					weeklyStats={weeklyStats}
					onRunClick={(id) =>
						navigate({ to: "/chat", search: { session: id, agent: undefined } })
					}
					stats={liveStats}
					agg={agg}
					isConnected={isConnected}
					className="hidden md:flex"
				/>
			</div>
		</div>
	);
}
