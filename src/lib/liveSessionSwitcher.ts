import type { SessionRow } from "#/db";
import type {
	SessionAttentionBucket,
	SessionAttentionReason,
	SessionStatusEntry,
} from "#/server/protocol";

export type LiveSessionState = SessionAttentionBucket;

export type LiveSessionSwitcherRow = {
	session: SessionStatusEntry;
	dbSessionId: string;
	state: LiveSessionState;
	pinned: boolean;
	workspaceLabel: string | null;
	forkLabel: string | null;
	delegationLabel: string | null;
};

const STATE_PRIORITY: Record<LiveSessionState, number> = {
	needs_attention: 0,
	working: 1,
	queued: 2,
	recent: 3,
};

export function liveSessionState(
	session: SessionStatusEntry,
): LiveSessionState {
	if (session.attention) return session.attention.bucket;
	if (session.hasPendingPermissions || session.state === "error") {
		return "needs_attention";
	}
	if (session.state === "running") return "working";
	return "recent";
}

/**
 * A Raven switch target must be attached to a real database chat. This includes
 * durable restart-interrupted delegation attention, while fresh pool
 * placeholders remain excluded.
 */
export function deriveLiveSessionSwitcherRows(
	sessions: SessionStatusEntry[],
): LiveSessionSwitcherRow[] {
	const candidates = sessions
		.map((session, sourceIndex) => ({ session, sourceIndex }))
		.filter(
			(
				entry,
			): entry is {
				session: SessionStatusEntry & { db_session_id: string };
				sourceIndex: number;
			} => entry.session.hasDbSession && Boolean(entry.session.db_session_id),
		)
		.map(({ session, sourceIndex }) => ({
			session,
			sourceIndex,
			dbSessionId: session.db_session_id,
			state: liveSessionState(session),
			pinned: session.pinned ?? false,
		}));
	const workspaceIds = ambiguousWorkspaceIds(
		candidates.map(({ session }) => ({
			id: session.session_id,
			label: session.lastLabel?.trim() || session.agent_name,
			cwd: session.agent_cwd,
		})),
	);
	return candidates
		.map((row) => ({
			...row,
			workspaceLabel: workspaceIds.has(row.session.session_id)
				? compactWorkspaceLabel(row.session.agent_cwd)
				: null,
			forkLabel: compactForkLabel(
				row.session.fork_parent_label,
				row.session.fork_parent_session_id,
				row.session.fork_kind,
			),
			delegationLabel: compactDelegationLabel(
				row.session.delegation_parent_label,
				row.session.delegation_parent_session_id,
			),
		}))
		.sort(
			(left, right) =>
				STATE_PRIORITY[left.state] - STATE_PRIORITY[right.state] ||
				Number(right.pinned) - Number(left.pinned) ||
				left.sourceIndex - right.sourceIndex,
		)
		.map(({ sourceIndex: _sourceIndex, ...row }) => row);
}

type WorkspaceCandidate = {
	id: string;
	label: string;
	cwd: string | null | undefined;
};

function ambiguousWorkspaceIds(rows: WorkspaceCandidate[]): Set<string> {
	const byLabel = new Map<string, WorkspaceCandidate[]>();
	for (const row of rows) {
		const key = row.label.trim().toLocaleLowerCase();
		const matching = byLabel.get(key);
		if (matching) matching.push(row);
		else byLabel.set(key, [row]);
	}
	const ambiguous = new Set<string>();
	for (const matching of byLabel.values()) {
		const workspaces = new Set(
			matching.map((row) => row.cwd?.trim()).filter(Boolean),
		);
		if (workspaces.size < 2) continue;
		for (const row of matching) ambiguous.add(row.id);
	}
	return ambiguous;
}

export function compactWorkspaceLabel(
	cwd: string | null | undefined,
	preferred?: string | null,
): string | null {
	const named = preferred?.trim();
	if (named) return named;
	const normalized = cwd?.trim().replace(/[\\/]+$/, "");
	if (!normalized) return null;
	return normalized.split(/[\\/]/).filter(Boolean).pop() ?? normalized;
}

export function compactForkLabel(
	parentLabel: string | null | undefined,
	parentSessionId: string | null | undefined,
	kind: "exact" | "recap" | null | undefined,
): string | null {
	if (!parentSessionId) return null;
	const source = parentLabel?.trim() || "source session";
	return `${kind === "recap" ? "Recap from" : "Fork of"} ${source}`;
}

export function compactDelegationLabel(
	parentLabel: string | null | undefined,
	parentSessionId: string | null | undefined,
): string | null {
	if (!parentSessionId) return null;
	return `Delegated from ${parentLabel?.trim() || "parent session"}`;
}

export type PersistedRecentSessionRow = {
	session: SessionRow;
	workspaceLabel: string | null;
	forkLabel: string | null;
	delegationLabel: string | null;
};

export function derivePersistedRecentSessionRows(
	sessions: SessionRow[],
	liveSessions: SessionStatusEntry[] = [],
): PersistedRecentSessionRow[] {
	const liveActionableIds = new Set(
		deriveLiveSessionSwitcherRows(liveSessions)
			.filter((row) => row.state !== "recent")
			.map((row) => row.dbSessionId),
	);
	const candidates = sessions.filter(
		(session) => !liveActionableIds.has(session.id),
	);
	const workspaceIds = ambiguousWorkspaceIds(
		candidates.map((session) => ({
			id: session.id,
			label: session.label?.trim() || "untitled",
			cwd: session.agent_cwd,
		})),
	);
	return candidates
		.map((session, sourceIndex) => ({
			session,
			sourceIndex,
			workspaceLabel: workspaceIds.has(session.id)
				? compactWorkspaceLabel(session.agent_cwd)
				: null,
			forkLabel: compactForkLabel(
				session.fork_parent_label,
				session.fork_parent_session_id,
				session.fork_kind,
			),
			delegationLabel: compactDelegationLabel(
				session.delegation_parent_label,
				session.delegation_parent_session_id,
			),
		}))
		.sort(
			(left, right) =>
				Number(right.session.pinned === 1) -
					Number(left.session.pinned === 1) ||
				(right.session.ended_at ?? right.session.started_at) -
					(left.session.ended_at ?? left.session.started_at) ||
				left.sourceIndex - right.sourceIndex,
		)
		.map(({ sourceIndex: _sourceIndex, ...row }) => row);
}

export type LiveSessionAttentionSummary = {
	total: number;
	needsAttention: number;
	working: number;
	queued: number;
	recent: number;
};

export function summarizeLiveSessionAttention(
	sessions: SessionStatusEntry[],
): LiveSessionAttentionSummary {
	const rows = deriveLiveSessionSwitcherRows(sessions);
	return {
		total: rows.length,
		needsAttention: rows.filter((row) => row.state === "needs_attention")
			.length,
		working: rows.filter((row) => row.state === "working").length,
		queued: rows.filter((row) => row.state === "queued").length,
		recent: rows.filter((row) => row.state === "recent").length,
	};
}

export type LiveSessionToggleTone =
	| "empty"
	| "needs_attention"
	| "working"
	| "queued"
	| "recent";

export function liveSessionToggleTone(
	rows: LiveSessionSwitcherRow[],
): LiveSessionToggleTone {
	if (rows.length === 0) return "empty";
	if (rows.some((row) => row.state === "needs_attention"))
		return "needs_attention";
	if (rows.some((row) => row.state === "working")) return "working";
	if (rows.some((row) => row.state === "queued")) return "queued";
	return "recent";
}

export function liveSessionStateLabel(state: LiveSessionState): string {
	if (state === "needs_attention") return "Needs attention";
	if (state === "working") return "Working";
	if (state === "queued") return "Queued";
	return "Recent";
}

const REASON_LABELS: Record<SessionAttentionReason, string> = {
	permission: "Approval",
	question: "Question",
	plan_review: "Plan review",
	error: "Error",
	provider_turn: "Working",
	terminal: "Terminal",
	queued_prompt: "Queued",
	goal_active: "Goal active",
	goal_blocked: "Goal blocked",
	goal_budget: "Goal budget",
	goal_paused: "Goal paused",
	goal_usage_wait: "Usage wait",
	routine_running: "Routine",
	routine_queued: "Routine queued",
	routine_action_required: "Routine action",
	routine_delivery_error: "Delivery error",
	routine_failed: "Routine failed",
	routine_unavailable: "Provider unavailable",
	routine_recent: "Routine settled",
	delegation_interrupted: "Restart interrupted",
	delegated_child_attention: "Child needs attention",
	delegated_child_working: "Children working",
	delegated_child_queued: "Children queued",
	ready: "Ready",
};

export function attentionReasonLabel(reason: SessionAttentionReason): string {
	return REASON_LABELS[reason];
}

export function liveSessionReasonLabel(session: SessionStatusEntry): string {
	if (session.attention) return attentionReasonLabel(session.attention.reason);
	if (session.hasPendingPermissions) return "Approval";
	if (session.state === "error") return "Error";
	if (session.state === "running") return "Working";
	return "Ready";
}

export function liveSessionQueueLabel(
	session: SessionStatusEntry,
): string | null {
	const count = session.attention?.queue_count ?? 0;
	if (count === 0) return null;
	return `${count} queued`;
}

export function liveDelegationRollupLabel(
	session: SessionStatusEntry,
): string | null {
	const rollup = session.delegated_attention;
	if (!rollup || rollup.descendant_count === 0) return null;
	return [
		`${rollup.descendant_count} delegated`,
		rollup.needs_attention_count > 0
			? `${rollup.needs_attention_count} needs you`
			: null,
		rollup.working_count > 0 ? `${rollup.working_count} working` : null,
		rollup.queued_count > 0 ? `${rollup.queued_count} queued` : null,
		rollup.waiting_count > 0 ? `${rollup.waiting_count} waiting` : null,
		rollup.completed_count > 0 ? `${rollup.completed_count} completed` : null,
		rollup.failed_count > 0 ? `${rollup.failed_count} failed` : null,
	]
		.filter((part): part is string => part !== null)
		.join(" · ");
}

function compactDelegationCount(value: number): string {
	const safeValue = Math.max(0, value);
	if (safeValue < 1_000) return `${Math.floor(safeValue)}`;
	if (safeValue < 1_000_000) {
		return `${Number((safeValue / 1_000).toFixed(1))}k`;
	}
	return `${Number((safeValue / 1_000_000).toFixed(1))}m`;
}

function compactDelegationCost(value: number): string {
	const safeValue = Math.max(0, value);
	if (safeValue === 0) return "$0";
	if (safeValue < 0.01) return `$${safeValue.toFixed(4)}`;
	if (safeValue < 1) return `$${safeValue.toFixed(3)}`;
	return `$${safeValue.toFixed(2)}`;
}

function compactDelegationDuration(seconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(seconds));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const remainderSeconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return `${totalMinutes}m${remainderSeconds ? ` ${remainderSeconds}s` : ""}`;
	}
	const totalHours = Math.floor(totalMinutes / 60);
	const remainderMinutes = totalMinutes % 60;
	return `${totalHours}h${remainderMinutes ? ` ${remainderMinutes}m` : ""}`;
}

/**
 * Compact descendant-wide resource totals for a delegation roll-up. Tokens and
 * cost are additive; duration is the wall-clock orchestration span.
 */
export function liveDelegationUsageLabel(
	session: SessionStatusEntry,
): string | null {
	const rollup = session.delegated_attention;
	if (!rollup || rollup.descendant_count === 0) return null;
	const parts = [
		rollup.total_tokens !== undefined
			? `${compactDelegationCount(rollup.total_tokens)} tokens`
			: null,
		rollup.total_cost !== undefined
			? compactDelegationCost(rollup.total_cost)
			: null,
		rollup.elapsed_duration_seconds !== undefined
			? `${compactDelegationDuration(rollup.elapsed_duration_seconds)} elapsed`
			: null,
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" · ") : null;
}

export function liveSessionContext(
	session: SessionStatusEntry,
	workspaceLabel?: string | null,
): string {
	return [
		workspaceLabel,
		session.provider_id,
		session.model,
		session.mode === "terminal" ? "terminal" : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
}
