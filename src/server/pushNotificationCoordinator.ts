import type { PushNotificationCategory } from "../lib/pushNotificationSchemas";
import { getNotificationVisibleUntil } from "./notificationPresence";
import type { SessionAttentionReason, SessionStatusEntry } from "./protocol";

export type PushNotificationKind = "needs_attention" | "work_finished";

export type PushNotificationEvent = {
	kind: PushNotificationKind;
	category: PushNotificationCategory;
	sessionId: string;
	sessionAliases: string[];
	label: string;
	reason: SessionAttentionReason;
	url: string;
	tag: string;
	runtimeMs?: number;
	pendingCount?: number;
	pendingReasonCount?: number;
	attentionSince?: number;
	attentionId?: string;
	occurredAt: number;
	expiresAt: number;
};

export type PushNotificationDelivery = (
	event: PushNotificationEvent | PushNotificationEvent[],
) => void | Promise<void>;

type AttentionState = Pick<
	NonNullable<SessionStatusEntry["attention"]>,
	"bucket" | "reason" | "since" | "last_activity_at" | "pending_count"
> & {
	pending_ids?: string[];
	pending_reason_count?: number;
	dbSessionId: string | null;
	delegated: boolean;
	routineOwned: boolean;
	workingSince: number | null;
};

const ATTENTION_TTL_MS = 15 * 60_000;
const FINISHED_TTL_MS = 5 * 60_000;
const TRANSITION_SETTLE_MS = 750;
const COMPLETION_BATCH_WINDOW_MS = 20_000;
const MAX_COMPLETION_BATCH_SIZE = 10;
const COMPLETION_REASONS = new Set<SessionAttentionReason>([
	"ready",
	"background_completed",
]);
const DELEGATED_DIRECT_REQUEST_REASONS = new Set<SessionAttentionReason>([
	"permission",
	"question",
	"plan_review",
]);

const REQUEST_REASONS = new Set<SessionAttentionReason>([
	"permission",
	"question",
	"plan_review",
	"routine_action_required",
]);

function notificationCategory(
	kind: PushNotificationKind,
	reason: SessionAttentionReason,
): PushNotificationCategory {
	if (kind === "work_finished") return "completion";
	return REQUEST_REASONS.has(reason) ? "request" : "problem";
}

function hasDelegatedProvenance(session: SessionStatusEntry): boolean {
	return (
		Boolean(session.delegation_parent_session_id) ||
		(session.delegation_depth ?? 0) > 0
	);
}

function snapshotAttention(
	session: SessionStatusEntry,
	previous?: AttentionState,
): AttentionState | undefined {
	const attention = session.attention;
	if (!attention) return undefined;
	const sameDurableSession =
		Boolean(session.db_session_id) &&
		previous?.dbSessionId === session.db_session_id;
	return {
		bucket: attention.bucket,
		reason: attention.reason,
		since: attention.since,
		dbSessionId: session.db_session_id,
		delegated:
			hasDelegatedProvenance(session) ||
			(sameDurableSession && previous.delegated),
		routineOwned:
			session.routine_owned === true ||
			(session.routine_owned === undefined &&
				sameDurableSession &&
				previous?.routineOwned === true),
		workingSince:
			attention.bucket === "working"
				? sameDurableSession &&
					previous?.bucket === "working" &&
					previous.workingSince !== null
					? previous.workingSince
					: attention.since
				: null,
		last_activity_at: attention.last_activity_at,
		pending_count: attention.pending_count,
		...(attention.pending_reason_count !== undefined
			? { pending_reason_count: attention.pending_reason_count }
			: {}),
		...(attention.pending_ids ? { pending_ids: attention.pending_ids } : {}),
	};
}

function validAttentionId(value: string | undefined): value is string {
	return Boolean(
		value && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value),
	);
}

function newlyPendingAttentionId(
	current: NonNullable<SessionStatusEntry["attention"]>,
	previous: AttentionState,
): string | undefined {
	const priorIds = new Set(previous.pending_ids ?? []);
	return [...(current.pending_ids ?? [])]
		.reverse()
		.find((id) => !priorIds.has(id));
}

function sessionLabel(session: SessionStatusEntry): string {
	return (
		session.lastLabel?.trim() ||
		session.agent_name.trim() ||
		"Session"
	).slice(0, 160);
}

function eventForTransition(
	session: SessionStatusEntry,
	previous: AttentionState,
	now: number,
): PushNotificationEvent | null {
	const current = session.attention;
	const sessionId = session.db_session_id;
	if (
		!current ||
		!session.hasDbSession ||
		!sessionId ||
		previous.dbSessionId !== sessionId
	)
		return null;

	let kind: PushNotificationKind | null = null;
	let ttl = ATTENTION_TTL_MS;
	let runtimeMs: number | undefined;
	const delegated = hasDelegatedProvenance(session) || previous.delegated;
	const routineOwned =
		session.routine_owned === true ||
		(session.routine_owned === undefined && previous.routineOwned);
	if (routineOwned) return null;
	const newAttentionId = newlyPendingAttentionId(current, previous);
	const currentPendingIds = current.pending_ids ?? [];
	const previousPendingIds = previous.pending_ids ?? [];
	const attentionIdsChanged =
		currentPendingIds.length > 0 &&
		(currentPendingIds.length !== previousPendingIds.length ||
			currentPendingIds.some((id, index) => id !== previousPendingIds[index]));
	if (
		current.bucket === "needs_attention" &&
		(previous.bucket !== "needs_attention" ||
			previous.reason !== current.reason ||
			(current.pending_count ?? 0) > (previous.pending_count ?? 0) ||
			attentionIdsChanged)
	) {
		// Descendant attention is represented by the exact child row. The same
		// rollup can reach ancestors in a later broadcast, so suppress it here
		// rather than relying on same-snapshot ancestry filtering.
		if (current.reason === "delegated_child_attention") return null;
		if (delegated && !DELEGATED_DIRECT_REQUEST_REASONS.has(current.reason)) {
			return null;
		}
		kind = "needs_attention";
	} else if (
		// Durable delegated completion and failure counts are internal lifecycle.
		// The top-level Raven session owns the single user-facing outcome for the
		// whole work cascade. Remembered provenance makes metadata loss fail closed.
		!delegated &&
		previous.bucket === "working" &&
		current.bucket === "recent" &&
		COMPLETION_REASONS.has(current.reason)
	) {
		kind = "work_finished";
		ttl = FINISHED_TTL_MS;
		if (previous.workingSince !== null) {
			const completedAt =
				current.since >= previous.workingSince && current.since <= now
					? current.since
					: now;
			runtimeMs = completedAt - previous.workingSince;
		}
	}
	if (!kind) return null;

	const sessionAliases = Array.from(new Set([session.session_id, sessionId]));
	const selectedAttentionId =
		kind === "needs_attention" &&
		DELEGATED_DIRECT_REQUEST_REASONS.has(current.reason)
			? (newAttentionId ?? current.pending_ids?.at(-1))
			: undefined;
	const attentionId = validAttentionId(selectedAttentionId)
		? selectedAttentionId
		: undefined;
	const legacyAttention =
		kind === "needs_attention" &&
		DELEGATED_DIRECT_REQUEST_REASONS.has(current.reason) &&
		current.pending_ids === undefined;
	return {
		kind,
		category: notificationCategory(kind, current.reason),
		sessionId,
		sessionAliases,
		label: sessionLabel(session),
		reason: current.reason,
		url: `/raven?${new URLSearchParams({
			session: sessionId,
			...(attentionId
				? { attention: current.reason, attention_id: attentionId }
				: legacyAttention
					? { attention: current.reason }
					: {}),
		})}`,
		tag: `hlid-session-${sessionId}`,
		...(runtimeMs !== undefined ? { runtimeMs } : {}),
		...(kind === "needs_attention" && (current.pending_count ?? 0) > 0
			? { pendingCount: current.pending_count }
			: {}),
		...(kind === "needs_attention" && (current.pending_reason_count ?? 0) > 0
			? { pendingReasonCount: current.pending_reason_count }
			: {}),
		...(kind === "needs_attention" ? { attentionSince: current.since } : {}),
		...(attentionId ? { attentionId } : {}),
		occurredAt: now,
		expiresAt: now + ttl,
	};
}

export class PushNotificationTransitionTracker {
	private previous = new Map<string, AttentionState | undefined>();

	observe(
		sessions: SessionStatusEntry[],
		now = Date.now(),
		reconcileBaseline = false,
	): PushNotificationEvent[] {
		const events: PushNotificationEvent[] = [];
		const currentIds = new Set<string>();
		for (const session of sessions) {
			currentIds.add(session.session_id);
			const previous = this.previous.get(session.session_id);
			let transition: PushNotificationEvent | null = null;
			if (this.previous.has(session.session_id) && previous) {
				transition = eventForTransition(session, previous, now);
				if (transition) events.push(transition);
			}
			if (
				!transition &&
				reconcileBaseline &&
				session.attention?.bucket === "needs_attention" &&
				now - session.attention.since <= 24 * 60 * 60_000
			) {
				const baselinePrevious: AttentionState = {
					bucket: "recent",
					reason: "ready",
					since: session.attention.since,
					last_activity_at: session.attention.last_activity_at,
					pending_count: 0,
					dbSessionId: session.db_session_id,
					delegated: hasDelegatedProvenance(session),
					routineOwned: session.routine_owned === true,
					workingSince: null,
				};
				const event = eventForTransition(session, baselinePrevious, now);
				if (event) events.push(event);
			}
			this.previous.set(
				session.session_id,
				snapshotAttention(session, previous),
			);
		}
		for (const sessionId of this.previous.keys()) {
			if (!currentIds.has(sessionId)) this.previous.delete(sessionId);
		}
		return events;
	}
}

type ScheduledEvent = {
	event: PushNotificationEvent;
	timer: ReturnType<typeof setTimeout> | null;
};

export type PushNotificationRelevanceEvent = {
	kind: PushNotificationKind;
	sessionId: string;
	sessionAliases: string[];
	reason: string | null;
	pendingCount?: number;
	attentionSince?: number;
	attentionId?: string;
	occurredAt: number;
};

type CoordinatorOptions = {
	deliver: PushNotificationDelivery;
	persist?: (event: PushNotificationEvent) => void;
	cancelPersisted?: (event: PushNotificationEvent) => void;
	now?: () => number;
	visibleUntil?: (sessionAliases: string[], now: number) => number | null;
	schedule?: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof setTimeout>;
	cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};

/**
 * Converts authoritative attention bucket transitions into deduplicated push
 * events. The initial snapshot only establishes a baseline. Events that occur
 * while their Raven session is visible wait for the bounded presence lease;
 * they are cancelled if the state is no longer relevant before delivery.
 */
export class PushNotificationCoordinator {
	private readonly tracker = new PushNotificationTransitionTracker();
	private readonly latest = new Map<string, AttentionState | undefined>();
	private readonly pending = new Map<string, ScheduledEvent>();
	private startupBaselinePending = false;
	private startupReady = false;
	private completionBatch: PushNotificationEvent[] = [];
	private completionTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly deliver: PushNotificationDelivery;
	private readonly persist?: CoordinatorOptions["persist"];
	private readonly cancelPersisted?: CoordinatorOptions["cancelPersisted"];
	private readonly now: () => number;
	private readonly visibleUntil: NonNullable<
		CoordinatorOptions["visibleUntil"]
	>;
	private readonly schedule: NonNullable<CoordinatorOptions["schedule"]>;
	private readonly cancel: NonNullable<CoordinatorOptions["cancel"]>;

	constructor(options: CoordinatorOptions) {
		this.deliver = options.deliver;
		this.persist = options.persist;
		this.cancelPersisted = options.cancelPersisted;
		this.now = options.now ?? Date.now;
		this.visibleUntil =
			options.visibleUntil ??
			((sessionAliases, now) =>
				getNotificationVisibleUntil(sessionAliases, now));
		this.schedule = options.schedule ?? setTimeout;
		this.cancel = options.cancel ?? clearTimeout;
	}

	observeStartup(sessions: SessionStatusEntry[]): void {
		this.startupBaselinePending = true;
		this.startupReady = false;
		this.observeState(sessions, false);
	}

	completeStartup(sessions: SessionStatusEntry[]): void {
		this.startupReady = true;
		this.observeState(sessions, true);
		this.startupBaselinePending = false;
	}

	observe(sessions: SessionStatusEntry[]): void {
		this.observeState(sessions, false);
	}

	private observeState(
		sessions: SessionStatusEntry[],
		reconcileBaseline: boolean,
	): void {
		const now = this.now();
		const events = this.tracker.observe(sessions, now, reconcileBaseline);
		const currentIds = new Set<string>();
		for (const session of sessions) {
			currentIds.add(session.session_id);
			this.latest.set(
				session.session_id,
				snapshotAttention(session, this.latest.get(session.session_id)),
			);
		}
		for (const sessionId of this.latest.keys()) {
			if (!currentIds.has(sessionId)) {
				this.latest.delete(sessionId);
			}
		}
		for (const [sessionId, scheduled] of this.pending) {
			if (!this.isEventStillRelevant(scheduled.event)) {
				this.clearPending(sessionId);
			}
		}
		for (const event of events) {
			// Startup observations hydrate authoritative state only. The final
			// reconciliation below emits one durable baseline for every current
			// request after restoration has settled.
			if (this.startupBaselinePending && !reconcileBaseline) continue;
			const key = event.sessionAliases[0] ?? event.sessionId;
			this.clearPending(key);
			this.persist?.(event);
			this.pending.set(key, { event, timer: null });
			this.tryDeliver(key);
		}
	}

	close(): void {
		for (const key of Array.from(this.pending.keys()))
			this.clearPending(key, false);
		if (this.completionTimer) this.cancel(this.completionTimer);
		this.completionTimer = null;
		this.completionBatch = [];
	}

	isEventStillRelevant(event: PushNotificationRelevanceEvent): boolean {
		let state: AttentionState | undefined;
		for (const alias of event.sessionAliases) {
			const candidate = this.latest.get(alias);
			if (candidate?.dbSessionId === event.sessionId) {
				state = candidate;
				break;
			}
		}
		if (!state) {
			for (const candidate of this.latest.values()) {
				if (candidate?.dbSessionId === event.sessionId) {
					state = candidate;
					break;
				}
			}
		}
		if (!state) {
			if (!this.startupReady) return true;
			return event.kind === "work_finished";
		}
		if (event.kind === "needs_attention") {
			return (
				state.bucket === "needs_attention" &&
				state.reason === event.reason &&
				(event.attentionSince === undefined ||
					state.since === event.attentionSince) &&
				(event.pendingCount === undefined ||
					(state.pending_count ?? 0) <= event.pendingCount) &&
				(event.attentionId === undefined ||
					state.pending_ids?.includes(event.attentionId) === true)
			);
		}
		return (
			state.bucket === "recent" &&
			state.since <= event.occurredAt &&
			COMPLETION_REASONS.has(state.reason)
		);
	}

	private tryDeliver(key: string): void {
		const scheduled = this.pending.get(key);
		if (!scheduled) return;
		const now = this.now();
		if (
			now >= scheduled.event.expiresAt ||
			!this.isEventStillRelevant(scheduled.event)
		) {
			this.clearPending(key);
			return;
		}
		const settledAt = scheduled.event.occurredAt + TRANSITION_SETTLE_MS;
		if (settledAt > now) {
			if (scheduled.timer) this.cancel(scheduled.timer);
			scheduled.timer = this.schedule(
				() => this.tryDeliver(key),
				settledAt - now,
			);
			return;
		}
		const visibleUntil = this.visibleUntil(scheduled.event.sessionAliases, now);
		if (visibleUntil && visibleUntil > now) {
			if (scheduled.timer) this.cancel(scheduled.timer);
			scheduled.timer = this.schedule(
				() => this.tryDeliver(key),
				visibleUntil - now + 10,
			);
			return;
		}

		this.pending.delete(key);
		if (scheduled.event.kind === "work_finished") {
			this.enqueueCompletion(scheduled.event);
			return;
		}
		this.runDelivery(scheduled.event);
	}

	private enqueueCompletion(event: PushNotificationEvent): void {
		const existing = this.completionBatch.findIndex(
			(candidate) => candidate.sessionId === event.sessionId,
		);
		if (existing >= 0) {
			const superseded = this.completionBatch[existing];
			if (superseded) this.cancelPersisted?.(superseded);
			this.completionBatch[existing] = event;
		} else this.completionBatch.push(event);
		if (this.completionTimer) return;
		this.completionTimer = this.schedule(
			() => this.flushCompletions(),
			COMPLETION_BATCH_WINDOW_MS,
		);
	}

	private flushCompletions(): void {
		this.completionTimer = null;
		const now = this.now();
		const ready = this.completionBatch.filter((event) => {
			if (event.expiresAt <= now || !this.isEventStillRelevant(event)) {
				this.cancelPersisted?.(event);
				return false;
			}
			const visibleUntil = this.visibleUntil(event.sessionAliases, now);
			return !visibleUntil || visibleUntil <= now;
		});
		this.completionBatch = [];
		for (
			let index = 0;
			index < ready.length;
			index += MAX_COMPLETION_BATCH_SIZE
		) {
			this.runDelivery(ready.slice(index, index + MAX_COMPLETION_BATCH_SIZE));
		}
	}

	private runDelivery(
		event: PushNotificationEvent | PushNotificationEvent[],
	): void {
		void Promise.resolve(this.deliver(event)).catch((error) => {
			console.error(
				"[push] notification delivery failed:",
				error instanceof Error ? error.message : String(error),
			);
		});
	}

	private clearPending(key: string, cancelPersisted = true): void {
		const scheduled = this.pending.get(key);
		if (scheduled?.timer) this.cancel(scheduled.timer);
		if (scheduled && cancelPersisted) this.cancelPersisted?.(scheduled.event);
		this.pending.delete(key);
	}
}
