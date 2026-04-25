import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { StatusDot } from "#/components/nav/StatusDot";
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

function StatCell({
	label,
	value,
	sub,
	dim,
}: {
	label: string;
	value: string;
	sub?: string;
	dim?: boolean;
}) {
	return (
		<div className="p-4 flex flex-col gap-1">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
				{label}
			</div>
			<div
				className={`text-xl font-bold tabular-nums ${dim ? "text-muted-foreground/20" : "text-[#38bdf8]"}`}
			>
				{value}
			</div>
			{sub && (
				<div className="text-[10px] text-muted-foreground tracking-wider">
					{sub}
				</div>
			)}
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
		pct > 80 ? "bg-destructive" : pct > 60 ? "bg-yellow-600" : "bg-primary";
	return (
		<div className="space-y-1.5">
			<div className="flex justify-between text-[10px] tracking-wider">
				<span className="text-muted-foreground uppercase">{label}</span>
				<span className="text-foreground tabular-nums">
					{fmt(value)} / {fmt(max)} ({pct.toFixed(0)}%)
				</span>
			</div>
			<div className="h-1.5 bg-secondary overflow-hidden">
				<div
					className={`h-full transition-all ${color}`}
					style={{ width: `${pct}%` }}
				/>
			</div>
		</div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0">
			<span className="text-[10px] tracking-widest text-muted-foreground uppercase">
				{label}
			</span>
			<span className="text-sm font-medium text-foreground tabular-nums">
				{value}
			</span>
		</div>
	);
}

function StatsPage() {
	const config = Route.useLoaderData();
	const [stats, setStats] = useState<SessionStats>(EMPTY);
	const { wsStatus, model } = useWs((msg: ServerMessage) => {
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
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-end px-5 py-3.5 border-b border-border shrink-0">
				<StatusDot />
			</div>

			<div className="flex-1 overflow-auto">
				{/* Stat grid */}
				<div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y divide-border border-b border-border">
					<StatCell
						label="COST"
						value={
							connected || stats.cost > 0 ? `$${stats.cost.toFixed(4)}` : "--"
						}
						sub={
							stats.queries > 0
								? `$${avgCostPerQuery.toFixed(4)}/query`
								: undefined
						}
						dim={!connected && stats.cost === 0}
					/>
					<StatCell
						label="QUERIES"
						value={idle ? "--" : String(stats.queries)}
						sub={stats.turns > 0 ? `${stats.turns} turns` : undefined}
						dim={idle}
					/>
					<StatCell
						label="DURATION"
						value={idle ? "--" : fmtMs(stats.duration_ms)}
						dim={idle}
					/>
					<StatCell
						label="MODEL"
						value={
							model
								? ({
										"claude-opus-4-7": "Opus 4.7",
										"claude-sonnet-4-6": "Sonnet 4.6",
										"claude-haiku-4-5-20251001": "Haiku 4.5",
									}[model] ??
									model.replace("claude-", "").replace(/-\d{8}$/, ""))
								: "--"
						}
						dim={!model}
					/>
				</div>

				<div className="p-5 space-y-5">
					{/* Context window */}
					{stats.context_window != null && stats.max_output_tokens != null && (
						<div className="border border-border bg-card p-4 space-y-4">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								CONTEXT · LAST QUERY
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

					{/* Token breakdown */}
					<div className="border border-border bg-card">
						<div className="px-4 py-3 border-b border-border">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								TOKEN USAGE · CUMULATIVE
							</div>
						</div>
						<Row label="Input" value={idle ? "--" : fmt(stats.input_tokens)} />
						<Row
							label="Output"
							value={idle ? "--" : fmt(stats.output_tokens)}
						/>
						<Row
							label="Cache read"
							value={idle ? "--" : fmt(stats.cache_read_tokens)}
						/>
						<Row
							label="Cache creation"
							value={idle ? "--" : fmt(stats.cache_creation_tokens)}
						/>
						<Row
							label="Cache hit rate"
							value={idle ? "--" : `${cacheHitPct}%`}
						/>
						<Row
							label="Total"
							value={
								idle ? "--" : fmt(stats.input_tokens + stats.output_tokens)
							}
						/>
					</div>

					{/* Session */}
					<div className="border border-border bg-card">
						<div className="px-4 py-3 border-b border-border">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								SESSION
							</div>
						</div>
						<Row label="Vault" value={config.vault.name || "--"} />
						<Row
							label="Permissions"
							value={
								config.claude.permission_mode === "default"
									? "ASK"
									: config.claude.permission_mode === "acceptEdits"
										? "AUTO EDITS"
										: "AUTO ALL"
							}
						/>
						<Row
							label="Server"
							value={`${config.server.host}:${config.server.port}`}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
