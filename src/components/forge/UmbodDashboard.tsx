import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useState,
} from "react";

type ToolUsage = {
	totals?: {
		entries?: number;
		sessions?: number;
		agents?: string[];
		projects?: string[];
	};
	byTool?: {
		agent: string;
		tool: string;
		count: number;
		decisions: { allow: number; approve: number; block: number };
	}[];
};

type RuleAnalysis = {
	rules?: {
		pattern: string;
		decision: string;
		status: string;
		matchCount: number;
	}[];
};

type CallEntry = {
	id: number;
	timestamp: string;
	agent: string;
	tool: string;
	command: string;
	decision: string;
	classification: string;
	matchedRule?: string;
	workingDirectory?: string;
	sessionId?: string;
	reason?: string;
	inputs?: Record<string, unknown>;
};

type CallPage = {
	entries: CallEntry[];
	page: number;
	total: number;
	totalPages: number;
};

type CallFilters = typeof EMPTY_FILTERS;

const EMPTY_FILTERS = {
	search: "",
	agent: "",
	tool: "",
	decision: "",
	classification: "",
	project: "",
};

const fieldClass =
	"min-h-11 w-full min-w-0 bg-secondary border border-border px-2 py-1.5 text-xs @lg:min-h-0";

function chipClass(value: string): string {
	if (value === "allow" || value === "active")
		return "border-status-success/40 bg-status-success/10 text-status-success";
	if (value === "approve" || value === "stale")
		return "border-status-warning/40 bg-status-warning/10 text-status-warning";
	if (value === "block" || value === "invalid")
		return "border-destructive/40 bg-destructive/10 text-destructive";
	return "border-border bg-secondary text-muted-foreground";
}

function Chip({ value, label = value }: { value: string; label?: string }) {
	return (
		<span
			className={`inline-flex border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${chipClass(value)}`}
		>
			{label}
		</span>
	);
}

function ruleStatusLabel(status: string): string {
	switch (status) {
		case "active":
			return "Matched";
		case "stale":
			return "Not matched recently";
		case "dead":
			return "Never matched";
		case "shadowed":
			return "Shadowed";
		case "invalid":
			return "Invalid pattern";
		default:
			return status;
	}
}

function Totals({ tools, loading }: { tools?: ToolUsage; loading: boolean }) {
	return (
		<div className="flex gap-4 text-right">
			<div>
				<div className="text-lg">
					{loading ? "…" : (tools?.totals?.entries ?? 0)}
				</div>
				<div className="text-[9px] uppercase tracking-wider text-muted-foreground">
					Calls
				</div>
			</div>
			<div>
				<div className="text-lg">
					{loading ? "…" : (tools?.totals?.sessions ?? 0)}
				</div>
				<div className="text-[9px] uppercase tracking-wider text-muted-foreground">
					Sessions
				</div>
			</div>
		</div>
	);
}

function ToolUsagePanel({
	tools,
	loading,
}: {
	tools?: ToolUsage;
	loading: boolean;
}) {
	return (
		<div className="border border-border p-3 space-y-3">
			<div className="flex items-center justify-between">
				<h4 className="text-xs font-medium">Tool use</h4>
				<div className="flex gap-2 text-[9px] uppercase tracking-wider">
					<span className="text-status-success">Allow</span>
					<span className="text-status-warning">Review</span>
					<span className="text-destructive">Block</span>
				</div>
			</div>
			{tools?.byTool?.slice(0, 8).map((row) => (
				<div
					key={`${row.agent}:${row.tool}`}
					className="grid grid-cols-[7rem_1fr_2rem] items-center gap-2 text-xs"
				>
					<div className="min-w-0">
						<div className="truncate" title={row.tool}>
							{row.tool}
						</div>
						<div className="text-[9px] text-muted-foreground">{row.agent}</div>
					</div>
					<div className="flex h-1.5 overflow-hidden bg-secondary">
						<span
							className="bg-status-success"
							style={{ width: `${(row.decisions.allow / row.count) * 100}%` }}
						/>
						<span
							className="bg-status-warning"
							style={{ width: `${(row.decisions.approve / row.count) * 100}%` }}
						/>
						<span
							className="bg-destructive"
							style={{ width: `${(row.decisions.block / row.count) * 100}%` }}
						/>
					</div>
					<div className="text-right text-muted-foreground">{row.count}</div>
				</div>
			))}
			{loading && !tools?.byTool?.length && (
				<p className="text-xs text-muted-foreground">Loading tool analytics…</p>
			)}
			{!loading && !tools?.byTool?.length && (
				<p className="text-xs text-muted-foreground">No tool history yet.</p>
			)}
		</div>
	);
}

function RuleHealthPanel({
	rules,
	loading,
}: {
	rules?: RuleAnalysis;
	loading: boolean;
}) {
	return (
		<div className="border border-border p-3 space-y-2">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h4 className="text-xs font-medium">Rule analysis</h4>
					<p className="mt-1 text-[10px] text-muted-foreground">
						Matched, Not matched recently, and Never matched reflect recorded
						calls, not manifest validation.
					</p>
				</div>
				<span className="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">
					{loading ? "…" : (rules?.rules?.length ?? 0)} rules
				</span>
			</div>
			{rules?.rules?.map((rule) => (
				<div
					key={rule.pattern}
					className="flex items-center justify-between gap-3 border-t border-border/60 pt-2 text-xs first:border-0 first:pt-0"
				>
					<code className="min-w-0 truncate" title={rule.pattern}>
						{rule.pattern}
					</code>
					<div className="flex shrink-0 items-center gap-2">
						<span className="text-muted-foreground">{rule.matchCount}</span>
						<Chip value={rule.status} label={ruleStatusLabel(rule.status)} />
					</div>
				</div>
			))}
			{loading && !rules?.rules?.length && (
				<p className="text-xs text-muted-foreground">Loading rule analytics…</p>
			)}
			{!loading && !rules?.rules?.length && (
				<p className="text-xs text-muted-foreground">No rules to inspect.</p>
			)}
		</div>
	);
}

function FilterSelect({
	label,
	value,
	onChange,
	blankLabel,
	options,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	blankLabel: string;
	options: readonly (string | [string, string])[];
}) {
	return (
		<select
			aria-label={label}
			value={value}
			onChange={(event) => onChange(event.target.value)}
			className={fieldClass}
		>
			<option value="">{blankLabel}</option>
			{options.map((option) => {
				const [optionValue, optionLabel] = Array.isArray(option)
					? option
					: [option, option];
				return (
					<option key={optionValue} value={optionValue}>
						{optionLabel}
					</option>
				);
			})}
		</select>
	);
}

function FilterBar({
	filters,
	setFilters,
	tools,
}: {
	filters: CallFilters;
	setFilters: Dispatch<SetStateAction<CallFilters>>;
	tools?: ToolUsage;
}) {
	const toolNames = [
		...new Set(tools?.byTool?.map((row) => row.tool) ?? []),
	].sort();
	const set = (patch: Partial<CallFilters>) =>
		setFilters((value) => ({ ...value, ...patch }));
	return (
		<div className="grid gap-2 @sm:grid-cols-2 @3xl:grid-cols-4 @4xl:grid-cols-7">
			<input
				aria-label="Search commands"
				placeholder="Command contains…"
				value={filters.search}
				onChange={(event) => set({ search: event.target.value })}
				className={`${fieldClass} @3xl:col-span-2`}
			/>
			<FilterSelect
				label="Filter tool"
				value={filters.tool}
				onChange={(tool) => set({ tool })}
				blankLabel="All tools"
				options={toolNames}
			/>
			<FilterSelect
				label="Filter agent"
				value={filters.agent}
				onChange={(agent) => set({ agent })}
				blankLabel="All agents"
				options={tools?.totals?.agents ?? []}
			/>
			<FilterSelect
				label="Filter classification"
				value={filters.classification}
				onChange={(classification) => set({ classification })}
				blankLabel="All types"
				options={["readonly", "stateful", "external", "destructive", "unknown"]}
			/>
			<FilterSelect
				label="Filter decision"
				value={filters.decision}
				onChange={(decision) => set({ decision })}
				blankLabel="All outcomes"
				options={[
					["allow", "Allowed"],
					["approve", "Approval"],
					["block", "Blocked"],
				]}
			/>
			<FilterSelect
				label="Filter project"
				value={filters.project}
				onChange={(project) => set({ project })}
				blankLabel="All projects"
				options={tools?.totals?.projects ?? []}
			/>
		</div>
	);
}

function CallDetail({ entry }: { entry: CallEntry }) {
	return (
		<div className="border-t border-border bg-secondary/40 p-3 space-y-3 text-xs">
			<dl className="grid gap-3 @sm:grid-cols-2 @3xl:grid-cols-4">
				{[
					["Agent", entry.agent],
					["Project", entry.workingDirectory || "—"],
					["Session", entry.sessionId || "—"],
					["Matched rule", entry.matchedRule || "fallback / automatic"],
				].map(([label, value]) => (
					<div key={label} className="min-w-0">
						<dt className="text-[9px] uppercase tracking-wider text-muted-foreground">
							{label}
						</dt>
						<dd className="mt-1 truncate" title={value}>
							{value}
						</dd>
					</div>
				))}
			</dl>
			{entry.reason && <p className="text-muted-foreground">{entry.reason}</p>}
			<pre className="max-h-64 overflow-auto border border-border bg-background p-3 text-[10px]">
				{JSON.stringify(entry.inputs ?? {}, null, 2)}
			</pre>
		</div>
	);
}

function CallRow({
	entry,
	open,
	onToggle,
}: {
	entry: CallEntry;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<article>
			<button
				type="button"
				onClick={onToggle}
				className="grid min-h-11 w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-2 p-3 text-left text-xs hover:bg-accent/40 @lg:grid-cols-[5rem_minmax(0,1fr)_6rem_5rem_10rem]"
			>
				<span className="font-medium truncate">{entry.tool}</span>
				<code className="truncate" title={entry.command}>
					{entry.command}
				</code>
				<span className="hidden text-muted-foreground @lg:block">
					{entry.classification}
				</span>
				<span className="hidden @lg:block">
					<Chip value={entry.decision} />
				</span>
				<time className="hidden text-right text-muted-foreground @lg:block">
					{new Date(entry.timestamp).toLocaleString()}
				</time>
			</button>
			{open && <CallDetail entry={entry} />}
		</article>
	);
}

function Pagination({
	calls,
	loading,
	onPage,
}: {
	calls: CallPage | null;
	loading: boolean;
	onPage: (page: number) => void;
}) {
	return (
		<div className="flex items-center justify-between gap-3 text-xs">
			<button
				type="button"
				disabled={!calls || calls.page <= 1 || loading}
				onClick={() => onPage((calls?.page ?? 1) - 1)}
				className="min-h-11 min-w-11 disabled:opacity-40 @lg:min-h-0 @lg:min-w-0"
			>
				Previous
			</button>
			<span className="text-muted-foreground">
				Page {calls?.page ?? 1} of {calls?.totalPages ?? 1}
			</span>
			<button
				type="button"
				disabled={!calls || calls.page >= calls.totalPages || loading}
				onClick={() => onPage((calls?.page ?? 1) + 1)}
				className="min-h-11 min-w-11 disabled:opacity-40 @lg:min-h-0 @lg:min-w-0"
			>
				Next
			</button>
		</div>
	);
}

function useCallExplorer(filters: CallFilters) {
	const [calls, setCalls] = useState<CallPage | null>(null);
	const [loading, setLoading] = useState(false);
	const [openId, setOpenId] = useState<number | null>(null);

	const loadCalls = useCallback(
		async (page = 1) => {
			setLoading(true);
			const params = new URLSearchParams({
				view: "calls",
				page: String(page),
				pageSize: "25",
			});
			for (const [key, value] of Object.entries(filters))
				if (value) params.set(key, value);
			try {
				const response = await fetch(`/api/umbod?${params}`);
				setCalls((await response.json()) as CallPage);
				setOpenId(null);
			} finally {
				setLoading(false);
			}
		},
		[filters],
	);

	useEffect(() => {
		const timer = window.setTimeout(() => void loadCalls(), 300);
		return () => window.clearTimeout(timer);
	}, [loadCalls]);

	return { calls, loading, openId, setOpenId, loadCalls };
}

function CallExplorer({ tools }: { tools?: ToolUsage }) {
	const [filters, setFilters] = useState(EMPTY_FILTERS);
	const { calls, loading, openId, setOpenId, loadCalls } =
		useCallExplorer(filters);

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<h4 className="text-xs font-medium">Call explorer</h4>
					<p className="text-[10px] text-muted-foreground">
						Expand a call for policy context, project, session, and raw inputs.
					</p>
				</div>
				<span className="text-[10px] text-muted-foreground">
					{loading ? "Loading…" : `${calls?.total ?? 0} matches`}
				</span>
			</div>
			<FilterBar filters={filters} setFilters={setFilters} tools={tools} />
			<button
				type="button"
				onClick={() => setFilters(EMPTY_FILTERS)}
				className="min-h-11 text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground @lg:min-h-0"
			>
				Reset filters
			</button>

			<div className="border border-border divide-y divide-border">
				{calls?.entries.map((entry) => (
					<CallRow
						key={entry.id}
						entry={entry}
						open={openId === entry.id}
						onToggle={() =>
							setOpenId((current) => (current === entry.id ? null : entry.id))
						}
					/>
				))}
				{!loading && calls?.entries.length === 0 && (
					<div className="p-6 text-center text-xs text-muted-foreground">
						No calls match these filters.
					</div>
				)}
			</div>
			<Pagination calls={calls} loading={loading} onPage={loadCalls} />
		</div>
	);
}

export function UmbodDashboard({
	tools,
	rules,
	loading = false,
	error,
}: {
	tools?: ToolUsage;
	rules?: RuleAnalysis;
	loading?: boolean;
	error?: string;
}) {
	return (
		<section className="border border-border bg-card p-4 space-y-5">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h3 className="text-sm font-medium">Umbod activity</h3>
					<p className="text-xs text-muted-foreground mt-1">
						Policy insights and concrete audited operations from Umbod.
					</p>
				</div>
				<Totals tools={tools} loading={loading} />
			</div>

			{error && (
				<p className="border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
					Analytics unavailable: {error}
				</p>
			)}

			<div className="grid gap-3 @2xl:grid-cols-2">
				<ToolUsagePanel tools={tools} loading={loading} />
				<RuleHealthPanel rules={rules} loading={loading} />
			</div>

			<CallExplorer tools={tools} />
		</section>
	);
}
