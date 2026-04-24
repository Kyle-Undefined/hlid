import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { getConfig } from "#/config";
import { useWs } from "#/hooks/useWs";
import type { DoneMessage, ServerMessage } from "#/server/protocol";

export const Route = createFileRoute("/stats")({
	loader: () => getConfig(),
	component: StatsPage,
});

type SessionStats = {
	turns: number;
	cost: number;
	duration_ms: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	context_window: number | null;
	max_output_tokens: number | null;
	queries: number;
};

const EMPTY: SessionStats = {
	turns: 0,
	cost: 0,
	duration_ms: 0,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
	context_window: null,
	max_output_tokens: null,
	queries: 0,
};

function accumulate(prev: SessionStats, msg: DoneMessage): SessionStats {
	return {
		turns: prev.turns + msg.turns,
		cost: prev.cost + (msg.cost ?? 0),
		duration_ms: prev.duration_ms + msg.duration_ms,
		input_tokens: prev.input_tokens + msg.input_tokens,
		output_tokens: prev.output_tokens + msg.output_tokens,
		cache_read_tokens: prev.cache_read_tokens + msg.cache_read_tokens,
		cache_creation_tokens:
			prev.cache_creation_tokens + msg.cache_creation_tokens,
		// keep last known context window (most recent call is most meaningful)
		context_window: msg.context_window ?? prev.context_window,
		max_output_tokens: msg.max_output_tokens ?? prev.max_output_tokens,
		queries: prev.queries + 1,
	};
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

function Stat({
	label,
	value,
	sub,
}: {
	label: string;
	value: string;
	sub?: string;
}) {
	return (
		<div className="p-4 rounded-lg border border-border bg-card">
			<div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
				{label}
			</div>
			<div className="text-2xl font-semibold text-foreground tabular-nums">
				{value}
			</div>
			{sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
		</div>
	);
}

function Bar({
	value,
	max,
	label,
}: {
	value: number;
	max: number;
	label: string;
}) {
	const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
	const color =
		pct > 80 ? "bg-destructive" : pct > 60 ? "bg-yellow-400" : "bg-primary";
	return (
		<div className="space-y-1.5">
			<div className="flex justify-between text-xs">
				<span className="text-muted-foreground">{label}</span>
				<span className="text-foreground tabular-nums">
					{fmt(value)} / {fmt(max)} ({pct.toFixed(0)}%)
				</span>
			</div>
			<div className="h-2 bg-secondary rounded-full overflow-hidden">
				<div
					className={`h-full rounded-full transition-all ${color}`}
					style={{ width: `${pct}%` }}
				/>
			</div>
		</div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between py-2.5 border-b border-border last:border-0">
			<span className="text-sm text-muted-foreground">{label}</span>
			<span className="text-sm font-medium text-foreground tabular-nums">
				{value}
			</span>
		</div>
	);
}

function StatsPage() {
	const config = Route.useLoaderData();
	const [stats, setStats] = useState<SessionStats>(EMPTY);
	const { wsStatus, sessionState, model } = useWs((msg: ServerMessage) => {
		if (msg.type === "done") setStats((prev) => accumulate(prev, msg));
	});

	const totalInput =
		stats.input_tokens + stats.cache_read_tokens + stats.cache_creation_tokens;
	const cacheHitPct =
		totalInput > 0
			? ((stats.cache_read_tokens / totalInput) * 100).toFixed(0)
			: "0";
	const avgCostPerQuery = stats.queries > 0 ? stats.cost / stats.queries : 0;
	const connected = wsStatus === "connected";
	const idle = stats.queries === 0;

	return (
		<div className="p-6 max-w-2xl mx-auto space-y-6">
			<div className="flex items-start justify-between">
				<div>
					<h1 className="text-xl font-semibold text-foreground tracking-tight">
						Stats
					</h1>
					<p className="text-sm text-muted-foreground mt-0.5">
						Current session · resets on page reload
					</p>
				</div>
				<div
					className={`flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary text-xs font-medium ${
						!connected
							? "text-muted-foreground"
							: sessionState === "running"
								? "text-foreground"
								: "text-foreground"
					}`}
				>
					<div
						className={`w-1.5 h-1.5 rounded-full ${
							!connected
								? "bg-muted-foreground/40"
								: sessionState === "running"
									? "bg-yellow-400 animate-pulse"
									: "bg-green-400"
						}`}
					/>
					{!connected
						? "Offline"
						: sessionState === "running"
							? "Running"
							: "Ready"}
				</div>
			</div>

			{/* top stat cards */}
			<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
				<Stat
					label="Cost"
					value={
						connected || stats.cost > 0 ? `$${stats.cost.toFixed(4)}` : "--"
					}
					sub={
						stats.queries > 0
							? `$${avgCostPerQuery.toFixed(4)}/query`
							: undefined
					}
				/>
				<Stat
					label="Queries"
					value={idle ? "--" : String(stats.queries)}
					sub={stats.turns > 0 ? `${stats.turns} turns` : undefined}
				/>
				<Stat label="Duration" value={idle ? "--" : fmtMs(stats.duration_ms)} />
				<Stat
					label="Model"
					value={
						model ? model.replace("claude-", "").replace(/-\d{8}$/, "") : "--"
					}
					sub={model || undefined}
				/>
			</div>

			{/* context window */}
			{stats.context_window != null && stats.max_output_tokens != null && (
				<div className="rounded-lg border border-border bg-card p-4 space-y-3">
					<div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
						Context (last query)
					</div>
					<Bar
						label="Context used"
						value={stats.context_window}
						max={200_000}
					/>
					<Bar
						label="Output cap"
						value={stats.max_output_tokens}
						max={64_000}
					/>
				</div>
			)}

			{/* token breakdown */}
			<div className="rounded-lg border border-border bg-card divide-y divide-border">
				<div className="px-4 py-3">
					<div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
						Token usage (cumulative)
					</div>
				</div>
				<Row label="Input" value={idle ? "--" : fmt(stats.input_tokens)} />
				<Row label="Output" value={idle ? "--" : fmt(stats.output_tokens)} />
				<Row
					label="Cache read"
					value={idle ? "--" : fmt(stats.cache_read_tokens)}
				/>
				<Row
					label="Cache creation"
					value={idle ? "--" : fmt(stats.cache_creation_tokens)}
				/>
				<Row label="Cache hit rate" value={idle ? "--" : `${cacheHitPct}%`} />
				<Row
					label="Total tokens"
					value={idle ? "--" : fmt(stats.input_tokens + stats.output_tokens)}
				/>
			</div>

			{/* session info */}
			<div className="rounded-lg border border-border bg-card divide-y divide-border">
				<div className="px-4 py-3">
					<div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
						Session
					</div>
				</div>
				<Row label="Vault" value={config.vault.name || "--"} />
				<Row
					label="Permission mode"
					value={
						config.claude.permission_mode === "default"
							? "Ask for approval"
							: config.claude.permission_mode === "acceptEdits"
								? "Auto-approve edits"
								: "Auto-approve all"
					}
				/>
				<Row
					label="Server"
					value={`${config.server.host}:${config.server.port}`}
				/>
			</div>
		</div>
	);
}
