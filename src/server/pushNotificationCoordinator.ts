import { getNotificationVisibleUntil } from "./notificationPresence";
import type { SessionAttentionReason, SessionStatusEntry } from "./protocol";

export type PushNotificationKind = "needs_attention" | "work_finished";

export type PushNotificationEvent = {
	kind: PushNotificationKind;
	sessionId: string;
	sessionAliases: string[];
	label: string;
	reason: SessionAttentionReason;
	url: string;
	tag: string;
	occurredAt: number;
	expiresAt: number;
};

export type PushNotificationDelivery = (
	event: PushNotificationEvent,
) => void | Promise<void>;

type AttentionState = Pick<
	NonNullable<SessionStatusEntry["attention"]>,
	"bucket" | "reason" | "since"
> & {
	dbSessionId: string | null;
	delegated: boolean;
};

const ATTENTION_TTL_MS = 15 * 60_000;
const FINISHED_TTL_MS = 5 * 60_000;
const TRANSITION_SETTLE_MS = 750;
const COMPLETION_REASONS = new Set<SessionAttentionReason>([
	"ready",
	"background_completed",
]);

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
	};
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
	const delegated = hasDelegatedProvenance(session) || previous.delegated;
	if (
		current.bucket === "needs_attention" &&
		previous.bucket !== "needs_attention"
	) {
		// Descendant attention is represented by the exact child row. The same
		// rollup can reach ancestors in a later broadcast, so suppress it here
		// rather than relying on same-snapshot ancestry filtering.
		if (current.reason === "delegated_child_attention") return null;
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
	}
	if (!kind) return null;

	const sessionAliases = Array.from(new Set([session.session_id, sessionId]));
	return {
		kind,
		sessionId,
		sessionAliases,
		label: sessionLabel(session),
		reason: current.reason,
		url: `/raven?session=${encodeURIComponent(sessionId)}`,
		tag: `hlid-session-${sessionId}`,
		occurredAt: now,
		expiresAt: now + ttl,
	};
}

export class PushNotificationTransitionTracker {
	private previous = new Map<string, AttentionState | undefined>();

	observe(
		sessions: SessionStatusEntry[],
		now = Date.now(),
	): PushNotificationEvent[] {
		const events: PushNotificationEvent[] = [];
		const currentIds = new Set<string>();
		for (const session of sessions) {
			currentIds.add(session.session_id);
			const previous = this.previous.get(session.session_id);
			if (this.previous.has(session.session_id) && previous) {
				const event = eventForTransition(session, previous, now);
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

type CoordinatorOptions = {
	deliver: PushNotificationDelivery;
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
	private readonly deliver: PushNotificationDelivery;
	private readonly now: () => number;
	private readonly visibleUntil: NonNullable<
		CoordinatorOptions["visibleUntil"]
	>;
	private readonly schedule: NonNullable<CoordinatorOptions["schedule"]>;
	private readonly cancel: NonNullable<CoordinatorOptions["cancel"]>;

	constructor(options: CoordinatorOptions) {
		this.deliver = options.deliver;
		this.now = options.now ?? Date.now;
		this.visibleUntil =
			options.visibleUntil ??
			((sessionAliases, now) =>
				getNotificationVisibleUntil(sessionAliases, now));
		this.schedule = options.schedule ?? setTimeout;
		this.cancel = options.cancel ?? clearTimeout;
	}

	observe(sessions: SessionStatusEntry[]): void {
		const now = this.now();
		const events = this.tracker.observe(sessions, now);
		const currentIds = new Set<string>();
		for (const session of sessions) {
			currentIds.add(session.session_id);
			this.latest.set(session.session_id, snapshotAttention(session));
		}
		for (const sessionId of this.latest.keys()) {
			if (!currentIds.has(sessionId)) this.latest.delete(sessionId);
		}
		for (const [sessionId, scheduled] of this.pending) {
			if (!this.eventStillRelevant(scheduled.event)) {
				this.clearPending(sessionId);
			}
		}
		for (const event of events) {
			const key = event.sessionAliases[0] ?? event.sessionId;
			this.clearPending(key);
			this.pending.set(key, { event, timer: null });
			this.tryDeliver(key);
		}
	}

	close(): void {
		for (const key of Array.from(this.pending.keys())) this.clearPending(key);
	}

	private eventStillRelevant(event: PushNotificationEvent): boolean {
		const state = this.latest.get(event.sessionAliases[0] ?? event.sessionId);
		if (!state) return event.kind === "work_finished";
		if (state.dbSessionId !== event.sessionId) return false;
		if (event.kind === "needs_attention") {
			return state.bucket === "needs_attention";
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
			!this.eventStillRelevant(scheduled.event)
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
		void Promise.resolve(this.deliver(scheduled.event)).catch((error) => {
			console.error(
				"[push] notification delivery failed:",
				error instanceof Error ? error.message : String(error),
			);
		});
	}

	private clearPending(key: string): void {
		const scheduled = this.pending.get(key);
		if (scheduled?.timer) this.cancel(scheduled.timer);
		this.pending.delete(key);
	}
}
