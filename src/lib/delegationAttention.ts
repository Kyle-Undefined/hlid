import type {
	DelegatedAttentionRollup,
	SessionAttentionBucket,
	SessionAttentionSnapshot,
	SessionStatusEntry,
} from "../server/protocol";

const PRIORITY: Record<SessionAttentionBucket, number> = {
	needs_attention: 3,
	working: 2,
	queued: 1,
	recent: 0,
};

type MutableRollup = {
	directIds: Set<string>;
	descendantIds: Set<string>;
	needsAttentionIds: Set<string>;
	workingIds: Set<string>;
	queuedIds: Set<string>;
	recentIds: Set<string>;
	attentionById: Map<string, SessionAttentionSnapshot>;
};

/**
 * Fixed-size durable lifecycle aggregate. The DB owns these counts; no child
 * IDs, task text, results, or errors enter the shared session-status payload.
 */
export type DelegatedLifecycleCounts = Pick<
	DelegatedAttentionRollup,
	| "direct_count"
	| "descendant_count"
	| "waiting_count"
	| "completed_count"
	| "failed_count"
	| "last_activity_at"
> &
	Partial<
		Pick<
			DelegatedAttentionRollup,
			"total_tokens" | "total_cost" | "elapsed_duration_seconds"
		>
	>;

function createMutableRollup(): MutableRollup {
	return {
		directIds: new Set(),
		descendantIds: new Set(),
		needsAttentionIds: new Set(),
		workingIds: new Set(),
		queuedIds: new Set(),
		recentIds: new Set(),
		attentionById: new Map(),
	};
}

function bucketSet(
	rollup: MutableRollup,
	bucket: SessionAttentionBucket,
): Set<string> {
	if (bucket === "needs_attention") return rollup.needsAttentionIds;
	if (bucket === "working") return rollup.workingIds;
	if (bucket === "queued") return rollup.queuedIds;
	return rollup.recentIds;
}

function boundedCount(value: number | undefined): number {
	if (!Number.isSafeInteger(value) || !value || value < 0) return 0;
	return value;
}

function boundedAmount(value: number | undefined): number {
	if (!Number.isFinite(value) || !value || value < 0) return 0;
	return value;
}

function finalized(
	rollup: MutableRollup,
	lifecycle?: DelegatedLifecycleCounts,
): DelegatedAttentionRollup {
	const leadingBucket: SessionAttentionBucket =
		rollup.needsAttentionIds.size > 0
			? "needs_attention"
			: rollup.workingIds.size > 0
				? "working"
				: rollup.queuedIds.size > 0
					? "queued"
					: "recent";
	const leadingIds = bucketSet(rollup, leadingBucket);
	const leadingAttention = [...leadingIds]
		.map((id) => rollup.attentionById.get(id))
		.filter(
			(attention): attention is SessionAttentionSnapshot =>
				attention !== undefined,
		);
	const allAttention = [...rollup.attentionById.values()];
	const rawLifecycleActivity = lifecycle?.last_activity_at ?? 0;
	const lifecycleActivity = Number.isFinite(rawLifecycleActivity)
		? Math.max(0, rawLifecycleActivity)
		: 0;
	const fallbackActivity = lifecycleActivity || Date.now();
	return {
		direct_count: Math.max(
			rollup.directIds.size,
			boundedCount(lifecycle?.direct_count),
		),
		descendant_count: Math.max(
			rollup.descendantIds.size,
			boundedCount(lifecycle?.descendant_count),
		),
		waiting_count: boundedCount(lifecycle?.waiting_count),
		completed_count: boundedCount(lifecycle?.completed_count),
		failed_count: boundedCount(lifecycle?.failed_count),
		total_tokens: boundedCount(lifecycle?.total_tokens),
		total_cost: boundedAmount(lifecycle?.total_cost),
		elapsed_duration_seconds: boundedAmount(
			lifecycle?.elapsed_duration_seconds,
		),
		needs_attention_count: rollup.needsAttentionIds.size,
		working_count: rollup.workingIds.size,
		queued_count: rollup.queuedIds.size,
		recent_count: rollup.recentIds.size,
		leading_bucket: leadingBucket,
		since:
			leadingAttention.length > 0
				? Math.min(...leadingAttention.map((attention) => attention.since))
				: fallbackActivity,
		last_activity_at:
			allAttention.length > 0
				? Math.max(
						lifecycleActivity,
						...allAttention.map((attention) => attention.last_activity_at),
					)
				: fallbackActivity,
	};
}

/**
 * Add cycle-safe descendant presentation to already-derived direct session
 * attention. Durable DB session IDs form the lineage; live pool IDs remain
 * navigation identities. The optional persisted lineage bridges delegated
 * ancestors that do not currently have a live or durable-only status row. The
 * fixed lifecycle map adds closed-child counts without projecting child rows.
 */
export function withDelegatedAttentionRollups(
	statuses: SessionStatusEntry[],
	durableLineage: ReadonlyMap<string, string> = new Map(),
	durableLifecycle: ReadonlyMap<string, DelegatedLifecycleCounts> = new Map(),
): SessionStatusEntry[] {
	const byDbSession = new Map<string, SessionStatusEntry>();
	const parentByDbSession = new Map(durableLineage);
	for (const status of statuses) {
		if (status.db_session_id && !byDbSession.has(status.db_session_id)) {
			byDbSession.set(status.db_session_id, status);
		}
		if (status.db_session_id && status.delegation_parent_session_id) {
			parentByDbSession.set(
				status.db_session_id,
				status.delegation_parent_session_id,
			);
		}
	}
	const mutable = new Map<string, MutableRollup>();
	for (const descendant of statuses) {
		const descendantId = descendant.db_session_id;
		const attention = descendant.attention;
		let parentId =
			descendant.delegation_parent_session_id ??
			(descendantId ? parentByDbSession.get(descendantId) : undefined) ??
			null;
		if (!descendantId || !attention || !parentId) continue;
		const seen = new Set<string>([descendantId]);
		let direct = true;
		while (parentId && !seen.has(parentId)) {
			seen.add(parentId);
			const parent = byDbSession.get(parentId);
			if (parent) {
				const rollup =
					mutable.get(parentId) ??
					(() => {
						const created = createMutableRollup();
						mutable.set(parentId, created);
						return created;
					})();
				if (direct) rollup.directIds.add(descendantId);
				rollup.descendantIds.add(descendantId);
				bucketSet(rollup, attention.bucket).add(descendantId);
				rollup.attentionById.set(descendantId, attention);
			}
			direct = false;
			parentId =
				parent?.delegation_parent_session_id ??
				parentByDbSession.get(parentId) ??
				null;
		}
	}

	return statuses.map((status) => {
		const dbSessionId = status.db_session_id;
		const raw = dbSessionId ? mutable.get(dbSessionId) : undefined;
		const lifecycle = dbSessionId
			? durableLifecycle.get(dbSessionId)
			: undefined;
		if (
			(!raw || raw.descendantIds.size === 0) &&
			(!lifecycle || boundedCount(lifecycle.descendant_count) === 0)
		) {
			return status;
		}
		const delegatedAttention = finalized(
			raw ?? createMutableRollup(),
			lifecycle,
		);
		const ownAttention = status.attention;
		if (
			!ownAttention ||
			PRIORITY[ownAttention.bucket] >=
				PRIORITY[delegatedAttention.leading_bucket]
		) {
			return { ...status, delegated_attention: delegatedAttention };
		}
		const reason =
			delegatedAttention.leading_bucket === "needs_attention"
				? "delegated_child_attention"
				: delegatedAttention.leading_bucket === "working"
					? "delegated_child_working"
					: "delegated_child_queued";
		return {
			...status,
			delegated_attention: delegatedAttention,
			attention: {
				...ownAttention,
				bucket: delegatedAttention.leading_bucket,
				reason,
				since: delegatedAttention.since,
				last_activity_at: Math.max(
					ownAttention.last_activity_at,
					delegatedAttention.last_activity_at,
				),
			},
		};
	});
}

export type DelegationLineageRow = {
	id: string;
	parentId: string | null;
};

/**
 * Return descendants that can be collapsed beneath a surviving live ancestor.
 * Missing parents and cycles keep their rows so Watch never hides every
 * navigable representative of malformed or partially loaded lineage.
 */
export function collapsibleDelegatedDescendantIds(
	rows: DelegationLineageRow[],
	replacedByAnotherRow: ReadonlySet<string> = new Set(),
): Set<string> {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const collapsible = new Set<string>();
	for (const row of rows) {
		if (!row.parentId) continue;
		const seen = new Set<string>([row.id]);
		let parentId: string | null = row.parentId;
		while (parentId) {
			if (seen.has(parentId)) break;
			seen.add(parentId);
			const parent = byId.get(parentId);
			if (!parent) break;
			if (
				replacedByAnotherRow.has(parent.id) ||
				!parent.parentId ||
				!byId.has(parent.parentId)
			) {
				collapsible.add(row.id);
				break;
			}
			parentId = parent.parentId;
		}
	}
	return collapsible;
}
