import {
	addPushNotificationBatchMembers,
	consumePushNotificationOneShot,
	createPushNotificationBatch,
	type EffectivePushSessionPolicy,
	enqueuePushNotificationEvent,
	getEffectivePushSessionPolicy,
	getPushNotificationBatch,
	getPushNotificationEvent,
	listDeliverablePushSubscriptions,
	listPendingPushNotificationDeliveries,
	listPendingPushNotificationEvents,
	listPushNotificationBatchMembers,
	listPushNotificationDeliveries,
	type PushNotificationDeliveryRecord,
	type PushNotificationEventRecord,
	pushSessionPolicyTargetsDevice,
	pushSubscriptionWantsNotification,
	reconcilePushNotificationOneShots,
	recordPushNotificationDecision,
	recordPushNotificationDeliveryAttempt,
	recordPushNotificationReceipt,
	terminatePushNotificationEvent,
	updatePushNotificationBatchStatus,
	updatePushNotificationEventStatus,
} from "../db";
import type { SessionNotificationMode } from "../lib/pushNotificationSchemas";
import { getNotificationAppVisibleUntil } from "./notificationPresence";
import {
	deliverPushEventsWithinOutbox,
	type PushDeliveryDependencies,
	type PushEvent,
} from "./pushDelivery";
import type { PushNotificationEvent } from "./pushNotificationCoordinator";
import { pushNotificationTiming } from "./pushNotificationSchedule";

const POLL_INTERVAL_MS = 30_000;
const MAX_DRAIN_EVENTS = 100;
const MAX_BATCH_SIZE = 10;
const ATTENTION_SETTLE_MS = 750;
const COMPLETION_BATCH_WINDOW_MS = 20_000;
const DURABLE_EVENT_LIFETIME_MS = 24 * 60 * 60_000;
const ATTENTION_PROVIDER_TTL_MS = 15 * 60_000;
const COMPLETION_PROVIDER_TTL_MS = 5 * 60_000;
const DEVICE_DELIVERY_CONCURRENCY = 8;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

type OutboxDependencies = {
	now: () => number;
	listEvents: typeof listPendingPushNotificationEvents;
	listPendingDeliveries: typeof listPendingPushNotificationDeliveries;
	listSubscriptions: typeof listDeliverablePushSubscriptions;
	listDeliveries: typeof listPushNotificationDeliveries;
	listBatchMembers: typeof listPushNotificationBatchMembers;
	getEvent: typeof getPushNotificationEvent;
	getPolicy: typeof getEffectivePushSessionPolicy;
	enqueue: typeof enqueuePushNotificationEvent;
	updateEvent: typeof updatePushNotificationEventStatus;
	terminateEvent: typeof terminatePushNotificationEvent;
	recordDecision: typeof recordPushNotificationDecision;
	recordAttempt: typeof recordPushNotificationDeliveryAttempt;
	recordReceipt: typeof recordPushNotificationReceipt;
	clearOneShot: typeof consumePushNotificationOneShot;
	reconcileOneShots: () => Promise<number>;
	createBatch: typeof createPushNotificationBatch;
	getBatch: typeof getPushNotificationBatch;
	addBatchMembers: typeof addPushNotificationBatchMembers;
	updateBatch: typeof updatePushNotificationBatchStatus;
	deliver: (
		events: PushEvent[],
		overrides: Partial<PushDeliveryDependencies>,
	) => ReturnType<typeof deliverPushEventsWithinOutbox>;
	visibleUntil: (aliases: string[], nowMs: number) => number | null;
	startupPresenceGraceMs: number;
	isRelevant: (
		event: PushNotificationEventRecord,
	) => boolean | Promise<boolean>;
	schedule: typeof setTimeout;
	cancel: typeof clearTimeout;
};

const defaultDependencies: OutboxDependencies = {
	now: Date.now,
	listEvents: listPendingPushNotificationEvents,
	listPendingDeliveries: listPendingPushNotificationDeliveries,
	listSubscriptions: listDeliverablePushSubscriptions,
	listDeliveries: listPushNotificationDeliveries,
	listBatchMembers: listPushNotificationBatchMembers,
	getEvent: getPushNotificationEvent,
	getPolicy: getEffectivePushSessionPolicy,
	enqueue: enqueuePushNotificationEvent,
	updateEvent: updatePushNotificationEventStatus,
	terminateEvent: terminatePushNotificationEvent,
	recordDecision: recordPushNotificationDecision,
	recordAttempt: recordPushNotificationDeliveryAttempt,
	recordReceipt: recordPushNotificationReceipt,
	clearOneShot: consumePushNotificationOneShot,
	reconcileOneShots: reconcilePushNotificationOneShots,
	createBatch: createPushNotificationBatch,
	getBatch: getPushNotificationBatch,
	addBatchMembers: addPushNotificationBatchMembers,
	updateBatch: updatePushNotificationBatchStatus,
	deliver: deliverPushEventsWithinOutbox,
	visibleUntil: (_aliases, nowMs) => getNotificationAppVisibleUntil(nowMs),
	startupPresenceGraceMs: 0,
	isRelevant: () => true,
	schedule: setTimeout,
	cancel: clearTimeout,
};

type ResolvedPolicy = EffectivePushSessionPolicy;
type DurableOneShot = NonNullable<
	PushNotificationDeliveryRecord["deviceSnapshot"]["oneShot"]
>;

function stringArray(value: unknown): string[] {
	return Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
		? value
		: [];
}

function metadataMode(value: unknown): SessionNotificationMode {
	return value === "notify" || value === "mute" ? value : "default";
}

function routinePolicy(event: PushNotificationEventRecord): ResolvedPolicy {
	const targetValue = event.metadata.targetDeviceIds;
	const targetDeviceIds =
		targetValue === null
			? null
			: Array.isArray(targetValue) &&
					targetValue.every((entry) => typeof entry === "string")
				? targetValue
				: [];
	return {
		requestedSessionId: event.sourceId,
		sourceSessionId: null,
		mode: metadataMode(event.metadata.notificationMode),
		scope: "session",
		targetDeviceIds,
		inherited: false,
	};
}

function oneShotForPolicy(
	policy: ResolvedPolicy,
	event: PushNotificationEventRecord,
): DurableOneShot | null {
	const mode =
		policy.mode === "notify_once"
			? "notify_once"
			: policy.mode === "notify_completion_once" &&
					event.category === "completion"
				? "notify_completion_once"
				: null;
	if (!mode) return null;
	return {
		sourceSessionId: policy.sourceSessionId ?? event.sourceId,
		mode,
		...(typeof policy.sourceUpdatedAt === "number" && policy.sourceUpdatedAt > 0
			? { policyUpdatedAt: policy.sourceUpdatedAt }
			: {}),
	};
}

/**
 * A consumed one-shot remains authorized only for device decisions already
 * journaled for this event. A later explicit mode (especially Mute) always
 * wins, while unrelated events have no durable snapshot to inherit.
 */
function policyForDelivery(
	policy: ResolvedPolicy,
	event: PushNotificationEventRecord,
	delivery?: PushNotificationDeliveryRecord,
): { policy: ResolvedPolicy; oneShot: DurableOneShot | null } {
	const currentOneShot = oneShotForPolicy(policy, event);
	if (policy.mode !== "default" || !delivery?.deviceSnapshot.oneShot) {
		return { policy, oneShot: currentOneShot };
	}
	const retained = delivery.deviceSnapshot.oneShot;
	if (
		retained.mode === "notify_completion_once" &&
		event.category !== "completion"
	) {
		return { policy, oneShot: null };
	}
	return {
		policy: {
			...policy,
			sourceSessionId: retained.sourceSessionId,
			mode: retained.mode,
		},
		oneShot: retained,
	};
}

function pushKind(event: PushNotificationEventRecord): PushEvent["kind"] {
	return event.category === "completion" ? "work_finished" : "needs_attention";
}

function pushEvent(
	event: PushNotificationEventRecord,
	deliveryId: string,
	nowMs: number,
	batchId?: string,
): PushEvent {
	const routineId =
		typeof event.metadata.routineId === "string"
			? event.metadata.routineId
			: undefined;
	const routineRunId =
		typeof event.metadata.routineRunId === "string"
			? event.metadata.routineRunId
			: undefined;
	return {
		kind: pushKind(event),
		sourceKind: event.sourceKind === "routine" ? "routine" : "session",
		sessionId: event.sourceId,
		...(routineId ? { routineId } : {}),
		...(routineRunId ? { routineRunId } : {}),
		label: event.label,
		reason: event.reason,
		...(event.pendingCount > 0
			? { pendingCount: Math.min(999, event.pendingCount) }
			: {}),
		...(typeof event.metadata.pendingReasonCount === "number"
			? {
					pendingReasonCount: Math.min(
						999,
						Math.max(1, event.metadata.pendingReasonCount),
					),
				}
			: {}),
		url: event.url ?? undefined,
		runtimeMs: event.runtimeMs ?? undefined,
		createdAt: event.occurredAt,
		expiresAt: Math.min(
			event.expiresAt,
			nowMs +
				(event.category === "completion"
					? COMPLETION_PROVIDER_TTL_MS
					: ATTENTION_PROVIDER_TTL_MS),
		),
		deliveryId,
		...(batchId ? { batchId } : {}),
	};
}

function eventAliases(event: PushNotificationEventRecord): string[] {
	const aliases = stringArray(event.metadata.sessionAliases);
	return aliases.length > 0 ? aliases : [event.sourceId];
}

function retryAt(
	delivery: PushNotificationDeliveryRecord,
	nowMs: number,
	expiresAt: number,
	retryAfterMs = 0,
): number | null {
	if (delivery.attemptCount >= RETRY_DELAYS_MS.length) return null;
	const configuredDelay =
		RETRY_DELAYS_MS[delivery.attemptCount] ?? RETRY_DELAYS_MS.at(-1);
	const delay =
		configuredDelay === undefined
			? undefined
			: Math.max(configuredDelay, retryAfterMs);
	if (delay === undefined || nowMs + delay >= expiresAt) return null;
	return nowMs + delay;
}

function deliveryIsDue(
	delivery: PushNotificationDeliveryRecord | undefined,
	nowMs: number,
): boolean {
	if (!delivery) return true;
	if (
		delivery.status === "suppressed" ||
		delivery.status === "gone" ||
		delivery.status === "expired"
	)
		return false;
	if (delivery.status === "pending") {
		return delivery.nextAttemptAt === null || delivery.nextAttemptAt <= nowMs;
	}
	if (delivery.status === "sent") return false;
	return delivery.nextAttemptAt !== null && delivery.nextAttemptAt <= nowMs;
}

function providerAttemptReason(
	result: Awaited<ReturnType<PushDeliveryDependencies["send"]>>,
): string {
	if (result.outcome === "delivered") return "provider_accepted";
	if (result.outcome === "gone") return "subscription_gone";
	if (result.statusCode === null) return "provider_unreachable";
	if (result.statusCode === 408) return "provider_timeout";
	if (result.statusCode === 429) return "provider_rate_limited";
	if (result.statusCode >= 500) return "provider_server_error";
	return "provider_rejected";
}

function isTransientProviderFailure(
	result: Awaited<ReturnType<PushDeliveryDependencies["send"]>>,
): boolean {
	return (
		result.outcome === "failed" &&
		(result.statusCode === null ||
			result.statusCode === 408 ||
			result.statusCode === 429 ||
			result.statusCode >= 500)
	);
}

function eventKey(event: PushNotificationEvent): string {
	return [
		"session",
		event.sessionId,
		event.category,
		event.reason,
		event.kind === "needs_attention"
			? (event.attentionId ?? event.attentionSince ?? event.occurredAt)
			: event.occurredAt,
		event.pendingCount ?? 0,
	].join(":");
}

/**
 * Durable Web Push dispatcher. Events are persisted before their settle/batch
 * window, and every device decision is journaled before provider I/O.
 */
export class PushNotificationOutbox {
	private readonly dependencies: OutboxDependencies;
	private readonly persisted = new Map<
		string,
		Promise<PushNotificationEventRecord>
	>();
	private readonly persistedExpiry = new Map<string, number>();
	private readonly latestAttentionBySession = new Map<
		string,
		PushNotificationEvent
	>();
	private drainPromise: Promise<void> | null = null;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private wakeTimer: ReturnType<typeof setTimeout> | null = null;
	private wakeAt: number | null = null;
	private readonly wakeTimes = new Set<number>();
	private wakeAfterDrain = false;
	private closed = true;
	private startedAt: number | null = null;
	private startupGraceUntil: number | null = null;

	constructor(overrides: Partial<OutboxDependencies> = {}) {
		this.dependencies = {
			...defaultDependencies,
			...overrides,
			terminateEvent:
				overrides.terminateEvent ??
				(overrides.updateEvent
					? (id, reason) =>
							overrides.updateEvent?.(id, {
								status: "cancelled",
								reason,
								onlyIfStatuses: ["pending", "deferred", "batched"],
							}) ?? Promise.resolve(null)
					: defaultDependencies.terminateEvent),
		};
	}

	start(): void {
		this.closed = false;
		this.startedAt = this.dependencies.now();
		this.startupGraceUntil =
			this.dependencies.startupPresenceGraceMs > 0
				? this.startedAt + this.dependencies.startupPresenceGraceMs
				: null;
		this.wake();
		if (this.startupGraceUntil !== null)
			this.scheduleWake(this.startupGraceUntil);
		this.schedulePoll();
	}

	close(): void {
		this.closed = true;
		if (this.pollTimer) this.dependencies.cancel(this.pollTimer);
		if (this.wakeTimer) this.dependencies.cancel(this.wakeTimer);
		this.pollTimer = null;
		this.wakeTimer = null;
		this.wakeAt = null;
		this.wakeTimes.clear();
		this.wakeAfterDrain = false;
		this.startedAt = null;
		this.startupGraceUntil = null;
		this.persisted.clear();
		this.persistedExpiry.clear();
		this.latestAttentionBySession.clear();
	}

	private cleanupTrackedEvent(
		event: Pick<
			PushNotificationEventRecord,
			"dedupeKey" | "sourceId" | "expiresAt"
		>,
	): void {
		const key = event.dedupeKey ?? "";
		if (key) {
			this.persisted.delete(key);
			this.persistedExpiry.delete(key);
		}
		const latest = this.latestAttentionBySession.get(event.sourceId);
		if (latest && eventKey(latest) === key) {
			this.latestAttentionBySession.delete(event.sourceId);
		}
	}

	private pruneTrackedEvents(nowMs: number): void {
		for (const [key, expiresAt] of this.persistedExpiry) {
			if (expiresAt <= nowMs) {
				this.persisted.delete(key);
				this.persistedExpiry.delete(key);
			}
		}
		for (const [sessionId, event] of this.latestAttentionBySession) {
			if (event.occurredAt + DURABLE_EVENT_LIFETIME_MS <= nowMs) {
				this.latestAttentionBySession.delete(sessionId);
			}
		}
	}

	persistSessionEvent(event: PushNotificationEvent): void {
		if (event.kind === "needs_attention") {
			const superseded = this.latestAttentionBySession.get(event.sessionId);
			if (superseded) this.cancelSessionEvent(superseded);
			this.latestAttentionBySession.set(event.sessionId, event);
		}
		const key = eventKey(event);
		const readyAt =
			event.occurredAt +
			(event.kind === "work_finished"
				? COMPLETION_BATCH_WINDOW_MS + ATTENTION_SETTLE_MS
				: ATTENTION_SETTLE_MS);
		const pending = this.dependencies
			.enqueue({
				sourceKind: "session",
				sourceId: event.sessionId,
				category: event.category,
				reason: event.reason,
				label: event.label,
				url: event.url,
				runtimeMs: event.runtimeMs ?? null,
				pendingCount: event.pendingCount ?? 0,
				occurredAt: event.occurredAt,
				expiresAt: Math.max(
					event.expiresAt,
					event.occurredAt + DURABLE_EVENT_LIFETIME_MS,
				),
				groupKey:
					event.kind === "work_finished"
						? "session-completions"
						: event.sessionId,
				status: "deferred",
				statusReason:
					event.kind === "work_finished" ? "batch_window" : "settle_window",
				nextAttemptAt: readyAt,
				metadata: {
					kind: event.kind,
					sessionAliases: event.sessionAliases,
					...(event.appFocusedAtOccurrence
						? { appFocusedAtOccurrence: true }
						: {}),
					...(event.attentionSince !== undefined
						? { attentionSince: event.attentionSince }
						: {}),
					...(event.attentionId ? { attentionId: event.attentionId } : {}),
					...(event.pendingReasonCount !== undefined
						? { pendingReasonCount: event.pendingReasonCount }
						: {}),
				},
				dedupeKey: key,
			})
			.then((record) => {
				this.persistedExpiry.set(key, record.expiresAt);
				if (
					record.status === "processed" ||
					record.status === "expired" ||
					record.status === "cancelled"
				) {
					this.cleanupTrackedEvent(record);
				}
				this.scheduleWake(readyAt);
				return record;
			});
		this.persisted.set(key, pending);
		void pending.catch((error) => {
			this.persisted.delete(key);
			this.persistedExpiry.delete(key);
			console.error(
				"[push] could not persist notification event:",
				error instanceof Error ? error.message : String(error),
			);
		});
	}

	cancelSessionEvent(
		event: PushNotificationEvent,
		reason = "state_resolved",
	): void {
		const pending = this.persisted.get(eventKey(event));
		if (!pending) return;
		void pending
			.then(async (record) => {
				await this.dependencies.terminateEvent(record.id, reason);
				this.cleanupTrackedEvent(record);
			})
			.catch(() => {});
	}

	wake(): void {
		if (this.closed) return;
		if (this.drainPromise) {
			this.wakeAfterDrain = true;
			return;
		}
		this.drainPromise = this.drain().finally(() => {
			this.drainPromise = null;
			if (this.wakeAfterDrain) {
				this.wakeAfterDrain = false;
				this.wake();
			}
		});
	}

	private schedulePoll(): void {
		if (this.closed || this.pollTimer) return;
		this.pollTimer = this.dependencies.schedule(() => {
			this.pollTimer = null;
			this.wake();
			this.schedulePoll();
		}, POLL_INTERVAL_MS);
		this.pollTimer.unref?.();
	}

	private scheduleWake(at: number): void {
		if (this.closed) return;
		this.wakeTimes.add(at);
		this.armNextWake();
	}

	private armNextWake(): void {
		if (this.closed || this.wakeTimes.size === 0) return;
		const at = Math.min(...this.wakeTimes);
		if (this.wakeAt !== null && this.wakeAt <= at) return;
		if (this.wakeTimer) this.dependencies.cancel(this.wakeTimer);
		this.wakeAt = at;
		this.wakeTimer = this.dependencies.schedule(
			() => {
				const firedAt = this.wakeAt;
				this.wakeTimer = null;
				this.wakeAt = null;
				if (firedAt !== null) this.wakeTimes.delete(firedAt);
				const nowMs = this.dependencies.now();
				for (const candidate of this.wakeTimes) {
					if (candidate <= nowMs + 10) this.wakeTimes.delete(candidate);
				}
				this.wake();
				this.armNextWake();
			},
			Math.max(0, at - this.dependencies.now() + 10),
		);
		this.wakeTimer.unref?.();
	}

	private async newestEventBySource(
		events: PushNotificationEventRecord[],
		reason: "superseded_attention" | "superseded_completion",
	): Promise<Map<string, PushNotificationEventRecord>> {
		const newestBySource = new Map<string, PushNotificationEventRecord>();
		for (const event of events) {
			const existing = newestBySource.get(event.sourceId);
			if (!existing) {
				newestBySource.set(event.sourceId, event);
				continue;
			}
			const newer =
				event.occurredAt > existing.occurredAt ||
				(event.occurredAt === existing.occurredAt && event.id > existing.id)
					? event
					: existing;
			const superseded = newer === event ? existing : event;
			await this.dependencies.terminateEvent(superseded.id, reason);
			this.cleanupTrackedEvent(superseded);
			newestBySource.set(event.sourceId, newer);
		}
		return newestBySource;
	}

	private async drain(): Promise<void> {
		try {
			const nowMs = this.dependencies.now();
			this.pruneTrackedEvents(nowMs);
			const [events, pendingDeliveries] = await Promise.all([
				this.dependencies.listEvents(nowMs, MAX_DRAIN_EVENTS),
				this.dependencies.listPendingDeliveries(nowMs, MAX_DRAIN_EVENTS),
			]);
			const byId = new Map(events.map((event) => [event.id, event]));
			for (const pending of pendingDeliveries) {
				byId.set(pending.event.id, pending.event);
			}
			const due = Array.from(byId.values()).filter(
				(event) => event.expiresAt > nowMs,
			);
			const attentionCandidates = due.filter(
				(event) => event.category !== "completion",
			);
			const attentionBySource = await this.newestEventBySource(
				attentionCandidates,
				"superseded_attention",
			);
			const attention = Array.from(attentionBySource.values());
			for (const event of attention) await this.process([event]);
			const routineCompletions = due.filter(
				(event) =>
					event.category === "completion" && event.sourceKind === "routine",
			);
			for (const event of routineCompletions) await this.process([event]);
			const completionCandidates = due.filter(
				(event) =>
					event.category === "completion" && event.sourceKind !== "routine",
			);
			const completionsBySource = await this.newestEventBySource(
				completionCandidates,
				"superseded_completion",
			);
			const completionGroups = new Map<string, PushNotificationEventRecord[]>();
			for (const event of completionsBySource.values()) {
				const key = event.batchId
					? `batch:${event.batchId}`
					: `group:${event.groupKey ?? "session-completions"}`;
				const group = completionGroups.get(key) ?? [];
				group.push(event);
				completionGroups.set(key, group);
			}
			for (const group of completionGroups.values()) {
				for (let index = 0; index < group.length; index += MAX_BATCH_SIZE) {
					await this.process(group.slice(index, index + MAX_BATCH_SIZE));
				}
			}
			if (
				events.length >= MAX_DRAIN_EVENTS ||
				pendingDeliveries.length >= MAX_DRAIN_EVENTS
			) {
				this.wakeAfterDrain = true;
			}
			await this.dependencies.reconcileOneShots();
		} catch (error) {
			console.error(
				"[push] durable notification drain failed:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private async policyFor(
		event: PushNotificationEventRecord,
	): Promise<ResolvedPolicy> {
		return event.sourceKind === "session"
			? this.dependencies.getPolicy(event.sourceId)
			: routinePolicy(event);
	}

	private recoveredEventGraceUntil(
		event: PushNotificationEventRecord,
		nowMs: number,
	): number | null {
		if (
			this.startedAt === null ||
			this.startupGraceUntil === null ||
			nowMs >= this.startupGraceUntil ||
			event.createdAt > this.startedAt
		) {
			return null;
		}
		return this.startupGraceUntil;
	}

	private completionWasFocusedAtOccurrence(
		event: PushNotificationEventRecord,
	): boolean {
		return (
			event.category === "completion" &&
			event.metadata.appFocusedAtOccurrence === true
		);
	}

	private async expireTerminalBatch(
		event: PushNotificationEventRecord,
		nowMs: number,
	): Promise<void> {
		if (!event.batchId) return;
		const members = await this.dependencies.listBatchMembers(event.batchId);
		const memberEvents = await Promise.all(
			members.map((member) => this.dependencies.getEvent(member.eventId)),
		);
		const allTerminal = memberEvents.every(
			(member) =>
				member === null ||
				member.status === "processed" ||
				member.status === "expired" ||
				member.status === "cancelled",
		);
		if (allTerminal) {
			await this.dependencies.updateBatch(event.batchId, "expired", nowMs);
		}
	}

	private async suppressFocusedCompletion(
		event: PushNotificationEventRecord,
		nowMs: number,
	): Promise<void> {
		await this.dependencies.terminateEvent(event.id, "app_focused");
		this.cleanupTrackedEvent(event);
		await this.expireTerminalBatch(event, nowMs);
	}

	private async process(input: PushNotificationEventRecord[]): Promise<void> {
		const nowMs = this.dependencies.now();
		const relevant: PushNotificationEventRecord[] = [];
		for (const event of input) {
			if (!(await this.dependencies.isRelevant(event))) {
				await this.dependencies.terminateEvent(event.id, "state_resolved");
				this.cleanupTrackedEvent(event);
				continue;
			}
			const startupGraceUntil = this.recoveredEventGraceUntil(event, nowMs);
			if (startupGraceUntil !== null) {
				await this.dependencies.updateEvent(event.id, {
					status: "deferred",
					reason: "startup_presence_grace",
					nextAttemptAt: startupGraceUntil,
				});
				this.scheduleWake(startupGraceUntil);
				continue;
			}
			const visibleUntil = this.dependencies.visibleUntil(
				eventAliases(event),
				nowMs,
			);
			if (
				event.category === "completion" &&
				(this.completionWasFocusedAtOccurrence(event) ||
					(visibleUntil !== null && visibleUntil > nowMs))
			) {
				await this.suppressFocusedCompletion(event, nowMs);
				continue;
			}
			if (visibleUntil !== null && visibleUntil > nowMs) {
				await this.dependencies.updateEvent(event.id, {
					status: "deferred",
					reason: "app_focused",
					nextAttemptAt: visibleUntil + 10,
				});
				this.scheduleWake(visibleUntil + 10);
				continue;
			}
			relevant.push(event);
		}
		if (relevant.length === 0) return;

		const subscriptions = await this.dependencies.listSubscriptions(nowMs);
		const activeIds = new Set(
			subscriptions.map((subscription) => subscription.id),
		);
		const policies = new Map<string, ResolvedPolicy>();
		const deliveries = new Map<
			string,
			Map<string, PushNotificationDeliveryRecord>
		>();
		for (const event of relevant) {
			policies.set(event.id, await this.policyFor(event));
			const rows = await this.dependencies.listDeliveries(event.id);
			deliveries.set(
				event.id,
				new Map(rows.map((delivery) => [delivery.deviceId, delivery])),
			);
			for (const row of rows) {
				if (
					!activeIds.has(row.deviceId) &&
					row.status !== "suppressed" &&
					row.status !== "gone" &&
					row.status !== "expired"
				) {
					await this.dependencies.recordReceipt({
						eventId: event.id,
						deviceId: row.deviceId,
						status: "expired",
						reason: "device_unavailable",
					});
				}
			}
		}

		type Candidate = {
			event: PushNotificationEventRecord;
			decision: PushNotificationDeliveryRecord;
			policy: ResolvedPolicy;
		};
		const byDevice = new Map<string, Candidate[]>();
		for (const subscription of subscriptions) {
			for (const event of relevant) {
				const previous = deliveries.get(event.id)?.get(subscription.id);
				// A processed event can re-enter through a durable retry belonging to
				// its original fan-out. Do not widen that history to a device that
				// subscribed after the original delivery decisions were journaled.
				if (event.status === "processed" && !previous) continue;
				if (!deliveryIsDue(previous, nowMs)) continue;
				const resolved = policyForDelivery(
					policies.get(event.id) ?? routinePolicy(event),
					event,
					previous,
				);
				const { policy, oneShot } = resolved;
				const device = {
					id: subscription.id,
					name: subscription.name,
					privacy: subscription.preferences.privacy,
					preferences: subscription.preferences,
					...(oneShot ? { oneShot } : {}),
				};
				if (!pushSessionPolicyTargetsDevice(policy, subscription.id)) {
					await this.dependencies.recordDecision({
						eventId: event.id,
						device,
						status: "suppressed",
						reason: "device_target",
					});
					continue;
				}
				if (policy.mode === "mute") {
					await this.dependencies.recordDecision({
						eventId: event.id,
						device,
						status: "suppressed",
						reason: "session_mute",
					});
					continue;
				}
				const timing = pushNotificationTiming(
					subscription.preferences,
					event.category,
					nowMs,
				);
				if (timing.action !== "deliver") {
					const decision = await this.dependencies.recordDecision({
						eventId: event.id,
						device,
						status: "suppressed",
						reason: timing.reason,
					});
					deliveries.get(event.id)?.set(subscription.id, decision);
					continue;
				}
				if (
					!pushSubscriptionWantsNotification(
						subscription,
						pushKind(event),
						policy.mode,
						{
							reason: event.reason,
							runtimeMs: event.runtimeMs ?? undefined,
							nowMs,
						},
					)
				) {
					await this.dependencies.recordDecision({
						eventId: event.id,
						device,
						status: "suppressed",
						reason: "preference",
					});
					continue;
				}
				const decision = await this.dependencies.recordDecision({
					eventId: event.id,
					device,
					status: "pending",
					reason: "eligible",
				});
				deliveries.get(event.id)?.set(subscription.id, decision);
				if (!deliveryIsDue(decision, nowMs)) continue;
				const candidates = byDevice.get(subscription.id) ?? [];
				candidates.push({ event, decision, policy });
				byDevice.set(subscription.id, candidates);
			}
		}

		type DeliveryGroup = {
			events: PushNotificationEventRecord[];
			deviceIds: string[];
		};
		type BatchTracker = {
			id: string;
			status: "open" | "ready" | "sent" | "read" | "expired";
			eventIds: Set<string>;
			accepted: boolean;
			acceptedDeviceIds: Set<string>;
			memberStatuses: Map<string, PushNotificationEventRecord["status"] | null>;
		};
		const groupsByTargetSet = new Map<string, DeliveryGroup>();
		for (const event of relevant) {
			const deviceIds = subscriptions
				.filter((subscription) =>
					(byDevice.get(subscription.id) ?? []).some(
						(candidate) => candidate.event.id === event.id,
					),
				)
				.map((subscription) => subscription.id);
			if (deviceIds.length === 0) continue;
			const key = deviceIds.join("\0");
			const group = groupsByTargetSet.get(key) ?? { events: [], deviceIds };
			group.events.push(event);
			groupsByTargetSet.set(key, group);
		}

		const batchTrackers = new Map<string, BatchTracker>();
		for (const batchId of new Set(
			relevant.flatMap((event) => (event.batchId ? [event.batchId] : [])),
		)) {
			const [batch, members] = await Promise.all([
				this.dependencies.getBatch(batchId),
				this.dependencies.listBatchMembers(batchId),
			]);
			if (batch) {
				const [memberDeliveries, memberEvents] = await Promise.all([
					Promise.all(
						members.map((member) =>
							this.dependencies.listDeliveries(member.eventId),
						),
					),
					Promise.all(
						members.map((member) => this.dependencies.getEvent(member.eventId)),
					),
				]);
				const acceptedDeviceIds = new Set(
					memberDeliveries.flatMap((rows) =>
						rows.flatMap((row) =>
							row.status === "sent" && row.reason === "batch_accepted"
								? [row.deviceId]
								: [],
						),
					),
				);
				batchTrackers.set(batch.id, {
					id: batch.id,
					status: batch.status,
					eventIds: new Set(members.map((member) => member.eventId)),
					accepted: batch.status === "sent" || acceptedDeviceIds.size > 0,
					acceptedDeviceIds,
					memberStatuses: new Map(
						members.map((member, index) => [
							member.eventId,
							memberEvents[index]?.status ?? null,
						]),
					),
				});
				for (const deviceId of acceptedDeviceIds) {
					for (const [index, member] of members.entries()) {
						const row = memberDeliveries[index]?.find(
							(candidate) => candidate.deviceId === deviceId,
						);
						if (row && row.status !== "sent") {
							await this.dependencies.recordReceipt({
								eventId: member.eventId,
								deviceId,
								status: "sent",
								reason: "batch_accepted",
								nextAttemptAt: null,
								...(row.deviceSnapshot.oneShot
									? { oneShot: row.deviceSnapshot.oneShot }
									: {}),
							});
						}
					}
					const remaining = (byDevice.get(deviceId) ?? []).filter(
						(candidate) =>
							!members.some((m) => m.eventId === candidate.event.id),
					);
					byDevice.set(deviceId, remaining);
				}
			}
		}
		const cancelledEventIds = new Set<string>();
		const acceptedOneShots = new Map<string, DurableOneShot>();

		for (const group of groupsByTargetSet.values()) {
			let groupBatchId: string | undefined;
			const existingBatchIds = new Set(
				group.events.flatMap((event) => (event.batchId ? [event.batchId] : [])),
			);
			if (group.events.length > 1 && existingBatchIds.size === 1) {
				const existingId = existingBatchIds.values().next().value;
				const tracker = existingId ? batchTrackers.get(existingId) : undefined;
				const exactMembers =
					tracker &&
					tracker.eventIds.size === group.events.length &&
					group.events.every((event) => tracker.eventIds.has(event.id));
				if (exactMembers) groupBatchId = tracker.id;
			}
			if (
				group.events.length > 1 &&
				!groupBatchId &&
				existingBatchIds.size === 0
			) {
				const batch = await this.dependencies.createBatch({
					category: "completion",
					groupKey: group.events[0]?.groupKey ?? "session-completions",
					status: "ready",
					createdAt: Math.min(...group.events.map((event) => event.occurredAt)),
				});
				await this.dependencies.addBatchMembers(
					batch.id,
					group.events.map((event) => ({
						eventId: event.id,
						sessionId: event.sourceId,
					})),
				);
				groupBatchId = batch.id;
				batchTrackers.set(batch.id, {
					id: batch.id,
					status: batch.status,
					eventIds: new Set(group.events.map((event) => event.id)),
					accepted: false,
					acceptedDeviceIds: new Set(),
					memberStatuses: new Map(
						group.events.map((event) => [event.id, event.status]),
					),
				});
			}

			const groupEventIds = new Set(group.events.map((event) => event.id));
			const deliverToDevice = async (deviceId: string): Promise<void> => {
				const originalCandidates = (byDevice.get(deviceId) ?? []).filter(
					(candidate) => groupEventIds.has(candidate.event.id),
				);
				if (originalCandidates.length === 0) return;
				const attemptNow = this.dependencies.now();
				const subscription = (
					await this.dependencies.listSubscriptions(attemptNow)
				).find((candidate) => candidate.id === deviceId);
				if (!subscription) {
					await Promise.all(
						originalCandidates.map((candidate) =>
							this.dependencies.recordReceipt({
								eventId: candidate.event.id,
								deviceId,
								status: "expired",
								reason: "device_unavailable",
							}),
						),
					);
					return;
				}
				const device = {
					id: subscription.id,
					name: subscription.name,
					privacy: subscription.preferences.privacy,
					preferences: subscription.preferences,
				};
				const candidates: Candidate[] = [];
				for (const candidate of originalCandidates) {
					const liveDecision = (
						await this.dependencies.listDeliveries(candidate.event.id)
					).find((row) => row.deviceId === deviceId);
					if (!liveDecision || !deliveryIsDue(liveDecision, attemptNow)) {
						continue;
					}
					candidate.decision = liveDecision;
					const refreshed = policyForDelivery(
						await this.policyFor(candidate.event),
						candidate.event,
						candidate.decision,
					);
					const refreshedPolicy = refreshed.policy;
					const decisionDevice = {
						...device,
						...(refreshed.oneShot ? { oneShot: refreshed.oneShot } : {}),
					};
					if (candidate.event.expiresAt <= attemptNow) {
						await this.dependencies.recordReceipt({
							eventId: candidate.event.id,
							deviceId,
							status: "expired",
							reason: "event_expired",
						});
						continue;
					}
					if (!(await this.dependencies.isRelevant(candidate.event))) {
						cancelledEventIds.add(candidate.event.id);
						await this.dependencies.terminateEvent(
							candidate.event.id,
							"state_resolved",
						);
						this.cleanupTrackedEvent(candidate.event);
						continue;
					}
					const visibleUntil = this.dependencies.visibleUntil(
						eventAliases(candidate.event),
						attemptNow,
					);
					if (
						candidate.event.category === "completion" &&
						(this.completionWasFocusedAtOccurrence(candidate.event) ||
							(visibleUntil !== null && visibleUntil > attemptNow))
					) {
						cancelledEventIds.add(candidate.event.id);
						await this.suppressFocusedCompletion(candidate.event, attemptNow);
						continue;
					}
					if (visibleUntil !== null && visibleUntil > attemptNow) {
						await this.dependencies.recordDecision({
							eventId: candidate.event.id,
							device: decisionDevice,
							status: "queued",
							reason: "app_focused",
							nextAttemptAt: visibleUntil + 10,
						});
						this.scheduleWake(visibleUntil + 10);
						continue;
					}
					if (
						refreshedPolicy.mode === "mute" ||
						!pushSessionPolicyTargetsDevice(refreshedPolicy, deviceId)
					) {
						await this.dependencies.recordDecision({
							eventId: candidate.event.id,
							device: decisionDevice,
							status: "suppressed",
							reason:
								refreshedPolicy.mode === "mute"
									? "session_mute"
									: "device_target",
						});
						continue;
					}
					const timing = pushNotificationTiming(
						subscription.preferences,
						candidate.event.category,
						attemptNow,
					);
					if (timing.action !== "deliver") {
						await this.dependencies.recordDecision({
							eventId: candidate.event.id,
							device: decisionDevice,
							status: "suppressed",
							reason: timing.reason,
						});
						continue;
					}
					if (
						!pushSubscriptionWantsNotification(
							subscription,
							pushKind(candidate.event),
							refreshedPolicy.mode,
							{
								reason: candidate.event.reason,
								runtimeMs: candidate.event.runtimeMs ?? undefined,
								nowMs: attemptNow,
							},
						)
					) {
						await this.dependencies.recordDecision({
							eventId: candidate.event.id,
							device: decisionDevice,
							status: "suppressed",
							reason: "preference",
						});
						continue;
					}
					const refreshedDecision = await this.dependencies.recordDecision({
						eventId: candidate.event.id,
						device: decisionDevice,
						status: "pending",
						reason: "eligible",
					});
					if (!deliveryIsDue(refreshedDecision, attemptNow)) continue;
					candidates.push({
						...candidate,
						decision: refreshedDecision,
						policy: refreshedPolicy,
					});
				}
				if (candidates.length === 0) return;
				const candidatePolicies = new Map(
					candidates.map(({ event, policy }) => [event.sourceId, policy]),
				);
				const useBatchId =
					groupBatchId && candidates.length === group.events.length
						? groupBatchId
						: undefined;
				const sentEvents = candidates.map(({ event, decision }) =>
					pushEvent(event, decision.id, attemptNow, useBatchId),
				);
				const deliveryGroups =
					useBatchId || sentEvents.length === 1
						? [sentEvents]
						: sentEvents.map((sentEvent) => [sentEvent]);
				let attempted = 0;
				const postLockHandledEventIds = new Set<string>();
				for (const deliveryEvents of deliveryGroups) {
					const summary = await this.dependencies.deliver(deliveryEvents, {
						now: () => this.dependencies.now(),
						strictCallbacks: true,
						listSubscriptions: async (deliveryNow) => {
							const live = (
								await this.dependencies.listSubscriptions(deliveryNow)
							).find((candidate) => candidate.id === deviceId);
							return live ? [live] : [];
						},
						onSubscriptionUnavailable: async (
							_unavailableDeviceId,
							unavailableEvents,
						) => {
							await Promise.all(
								unavailableEvents.flatMap((deliveredEvent) => {
									const candidate = candidates.find(
										(item) => item.decision.id === deliveredEvent.deliveryId,
									);
									if (!candidate) return [];
									postLockHandledEventIds.add(candidate.event.id);
									return [
										this.dependencies.recordReceipt({
											eventId: candidate.event.id,
											deviceId,
											status: "expired",
											reason: "device_unavailable",
										}),
									];
								}),
							);
						},
						getPolicy: async (sessionId) => {
							const candidate = candidates.find(
								(item) => item.event.sourceId === sessionId,
							);
							return candidate
								? policyForDelivery(
										await this.policyFor(candidate.event),
										candidate.event,
										candidate.decision,
									).policy
								: (candidatePolicies.get(sessionId) ??
										this.dependencies.getPolicy(sessionId));
						},
						revalidateEvents: async (
							liveSubscription,
							lockedEvents,
							context,
						) => {
							const lockedNow = this.dependencies.now();
							const stillEligible: PushEvent[] = [];
							for (const lockedEvent of lockedEvents) {
								const candidate = candidates.find(
									(item) => item.decision.id === lockedEvent.deliveryId,
								);
								if (!candidate) continue;
								const handle = (): void => {
									postLockHandledEventIds.add(candidate.event.id);
								};
								const lockedDecision = (
									await this.dependencies.listDeliveries(candidate.event.id)
								).find((row) => row.deviceId === deviceId);
								if (
									!lockedDecision ||
									!deliveryIsDue(lockedDecision, lockedNow)
								) {
									handle();
									continue;
								}
								candidate.decision = lockedDecision;
								const lockedResolved = policyForDelivery(
									context.policies.get(candidate.event.sourceId) ??
										(await this.policyFor(candidate.event)),
									candidate.event,
									candidate.decision,
								);
								const lockedDevice = {
									id: liveSubscription.id,
									name: liveSubscription.name,
									privacy: liveSubscription.preferences.privacy,
									preferences: liveSubscription.preferences,
									...(lockedResolved.oneShot
										? { oneShot: lockedResolved.oneShot }
										: {}),
								};
								if (candidate.event.expiresAt <= lockedNow) {
									handle();
									await this.dependencies.recordReceipt({
										eventId: candidate.event.id,
										deviceId,
										status: "expired",
										reason: "event_expired",
									});
									continue;
								}
								if (!(await this.dependencies.isRelevant(candidate.event))) {
									handle();
									cancelledEventIds.add(candidate.event.id);
									await this.dependencies.terminateEvent(
										candidate.event.id,
										"state_resolved",
									);
									this.cleanupTrackedEvent(candidate.event);
									continue;
								}
								const lockedVisibleUntil = this.dependencies.visibleUntil(
									eventAliases(candidate.event),
									lockedNow,
								);
								if (
									candidate.event.category === "completion" &&
									(this.completionWasFocusedAtOccurrence(candidate.event) ||
										(lockedVisibleUntil !== null &&
											lockedVisibleUntil > lockedNow))
								) {
									handle();
									cancelledEventIds.add(candidate.event.id);
									await this.suppressFocusedCompletion(
										candidate.event,
										lockedNow,
									);
									continue;
								}
								if (
									lockedVisibleUntil !== null &&
									lockedVisibleUntil > lockedNow
								) {
									handle();
									await this.dependencies.recordDecision({
										eventId: candidate.event.id,
										device: lockedDevice,
										status: "queued",
										reason: "app_focused",
										nextAttemptAt: lockedVisibleUntil + 10,
									});
									this.scheduleWake(lockedVisibleUntil + 10);
									continue;
								}
								const lockedPolicy = lockedResolved.policy;
								if (
									lockedPolicy.mode === "mute" ||
									!pushSessionPolicyTargetsDevice(lockedPolicy, deviceId)
								) {
									handle();
									await this.dependencies.recordDecision({
										eventId: candidate.event.id,
										device: lockedDevice,
										status: "suppressed",
										reason:
											lockedPolicy.mode === "mute"
												? "session_mute"
												: "device_target",
									});
									continue;
								}
								const lockedTiming = pushNotificationTiming(
									liveSubscription.preferences,
									candidate.event.category,
									lockedNow,
								);
								if (lockedTiming.action !== "deliver") {
									handle();
									await this.dependencies.recordDecision({
										eventId: candidate.event.id,
										device: lockedDevice,
										status: "suppressed",
										reason: lockedTiming.reason,
									});
									continue;
								}
								if (
									!pushSubscriptionWantsNotification(
										liveSubscription,
										pushKind(candidate.event),
										lockedPolicy.mode,
										{
											reason: candidate.event.reason,
											runtimeMs: candidate.event.runtimeMs ?? undefined,
											nowMs: lockedNow,
										},
									)
								) {
									handle();
									await this.dependencies.recordDecision({
										eventId: candidate.event.id,
										device: lockedDevice,
										status: "suppressed",
										reason: "preference",
									});
									continue;
								}
								candidate.decision = await this.dependencies.recordDecision({
									eventId: candidate.event.id,
									device: lockedDevice,
									status: "pending",
									reason: "eligible",
								});
								if (!deliveryIsDue(candidate.decision, lockedNow)) {
									handle();
									continue;
								}
								candidate.policy = lockedPolicy;
								stillEligible.push(
									pushEvent(
										candidate.event,
										candidate.decision.id,
										lockedNow,
										lockedEvent.batchId,
									),
								);
							}
							return stillEligible;
						},
						clearOneShot: async () => false,
						onAttempt: async (_device, delivered, result, context) => {
							const deliveredBatch =
								result.outcome === "delivered" &&
								delivered.length > 1 &&
								delivered[0]?.batchId !== undefined &&
								delivered.every(
									(event) => event.batchId === delivered[0]?.batchId,
								);
							await Promise.all(
								delivered.flatMap((deliveredEvent) =>
									deliveredEvent.deliveryId
										? [
												this.dependencies.recordAttempt({
													deliveryId: deliveredEvent.deliveryId,
													attemptedAt: context.attemptedAt,
													outcome: result.outcome,
													providerStatus: result.statusCode,
													retryAfterMs:
														result.outcome === "failed"
															? (result.retryAfterMs ?? null)
															: null,
													reasonCode: deliveredBatch
														? "batch_accepted"
														: providerAttemptReason(result),
												}),
											]
										: [],
								),
							);
						},
						onResult: async (deliveredSubscription, delivered, result) => {
							const resultNow = this.dependencies.now();
							if (result.outcome === "gone") {
								const rotatedSubscription = (
									await this.dependencies.listSubscriptions(resultNow)
								).find(
									(candidate) =>
										candidate.id === deliveredSubscription.id &&
										candidate.endpoint !== deliveredSubscription.endpoint,
								);
								if (rotatedSubscription) {
									let requeued = false;
									for (const deliveredEvent of delivered) {
										const candidate = candidates.find(
											(item) => item.decision.id === deliveredEvent.deliveryId,
										);
										if (!candidate) continue;
										const decision = await this.dependencies.recordDecision({
											eventId: candidate.event.id,
											device: {
												id: rotatedSubscription.id,
												name: rotatedSubscription.name,
												privacy: rotatedSubscription.preferences.privacy,
												preferences: rotatedSubscription.preferences,
												...(candidate.decision.deviceSnapshot.oneShot
													? {
															oneShot:
																candidate.decision.deviceSnapshot.oneShot,
														}
													: {}),
											},
											status: "pending",
											reason: "endpoint_rotated",
											nextAttemptAt: resultNow,
										});
										candidate.decision = decision;
										if (deliveryIsDue(decision, resultNow)) requeued = true;
									}
									if (requeued) this.scheduleWake(resultNow);
									return;
								}
							}
							const deliveredBatchId =
								delivered.length > 1 &&
								delivered[0]?.batchId &&
								delivered.every(
									(event) => event.batchId === delivered[0]?.batchId,
								)
									? delivered[0].batchId
									: undefined;
							for (const deliveredEvent of delivered) {
								const candidate = candidates.find(
									(item) => item.decision.id === deliveredEvent.deliveryId,
								);
								if (!candidate) continue;
								const oneShotMode =
									candidate.policy.mode === "notify_once"
										? "notify_once"
										: candidate.policy.mode === "notify_completion_once" &&
												candidate.event.category === "completion"
											? "notify_completion_once"
											: null;
								const acceptedOneShot =
									candidate.policy.sourceSessionId && oneShotMode
										? (candidate.decision.deviceSnapshot.oneShot ?? {
												sourceSessionId: candidate.policy.sourceSessionId,
												mode: oneShotMode,
												...(typeof candidate.policy.sourceUpdatedAt ===
													"number" && candidate.policy.sourceUpdatedAt > 0
													? {
															policyUpdatedAt: candidate.policy.sourceUpdatedAt,
														}
													: {}),
											})
										: null;
								const nextAttemptAt = isTransientProviderFailure(result)
									? retryAt(
											candidate.decision,
											resultNow,
											candidate.event.expiresAt,
											result.outcome === "failed"
												? (result.retryAfterMs ?? 0)
												: 0,
										)
									: null;
								await this.dependencies.recordReceipt({
									eventId: candidate.event.id,
									deviceId: deliveredSubscription.id,
									status:
										result.outcome === "delivered"
											? "sent"
											: result.outcome === "gone"
												? "gone"
												: "failed",
									reason:
										result.outcome === "delivered"
											? deliveredBatchId
												? "batch_accepted"
												: "accepted"
											: "provider_failure",
									providerStatus: result.statusCode,
									nextAttemptAt,
									...(result.outcome === "delivered" && acceptedOneShot
										? {
												oneShot: acceptedOneShot,
											}
										: {}),
								});
								if (nextAttemptAt !== null) this.scheduleWake(nextAttemptAt);
								if (
									result.outcome === "delivered" &&
									candidate.event.category === "completion"
								) {
									await this.dependencies.updateEvent(candidate.event.id, {
										status: "processed",
										reason: "provider_accepted",
									});
								}
								if (result.outcome === "delivered") {
									if (acceptedOneShot) {
										acceptedOneShots.set(
											`${acceptedOneShot.sourceSessionId}\0${acceptedOneShot.mode}\0${acceptedOneShot.policyUpdatedAt ?? 0}`,
											acceptedOneShot,
										);
									}
								}
							}
							if (result.outcome === "delivered" && deliveredBatchId) {
								const tracker = batchTrackers.get(deliveredBatchId);
								if (tracker) tracker.accepted = true;
								if (tracker) {
									tracker.acceptedDeviceIds.add(deliveredSubscription.id);
								}
								await this.dependencies.updateBatch(
									deliveredBatchId,
									"sent",
									resultNow,
								);
							}
						},
					});
					attempted += summary.attempted;
				}
				if (attempted === 0) {
					const liveSubscription = (
						await this.dependencies.listSubscriptions(this.dependencies.now())
					).some((candidate) => candidate.id === deviceId);
					for (const candidate of candidates) {
						if (postLockHandledEventIds.has(candidate.event.id)) continue;
						if (!liveSubscription) {
							await this.dependencies.recordReceipt({
								eventId: candidate.event.id,
								deviceId,
								status: "expired",
								reason: "device_unavailable",
							});
							continue;
						}
						await this.dependencies.recordDecision({
							eventId: candidate.event.id,
							device: {
								...device,
								...(candidate.decision.deviceSnapshot.oneShot
									? { oneShot: candidate.decision.deviceSnapshot.oneShot }
									: {}),
							},
							status: "suppressed",
							reason: "eligibility_changed",
						});
					}
				}
			};
			// Each worker claims its next device only after the preceding provider call
			// settles, keeping concurrency bounded while preserving per-slot revalidation.
			let nextDeviceIndex = 0;
			const worker = async (): Promise<void> => {
				for (;;) {
					const deviceId = group.deviceIds[nextDeviceIndex++];
					if (!deviceId) return;
					await deliverToDevice(deviceId);
				}
			};
			await Promise.all(
				Array.from(
					{
						length: Math.min(
							DEVICE_DELIVERY_CONCURRENCY,
							group.deviceIds.length,
						),
					},
					() => worker(),
				),
			);
		}

		await Promise.all(
			Array.from(acceptedOneShots.values(), (oneShot) =>
				(oneShot.policyUpdatedAt
					? this.dependencies.clearOneShot(
							oneShot.sourceSessionId,
							oneShot.mode,
							oneShot.policyUpdatedAt,
						)
					: this.dependencies.clearOneShot(
							oneShot.sourceSessionId,
							oneShot.mode,
						)
				).catch(() => false),
			),
		);

		const eventPending = new Map<string, boolean>();
		for (const event of relevant) {
			if (cancelledEventIds.has(event.id)) {
				eventPending.set(event.id, false);
				continue;
			}
			const rows = await this.dependencies.listDeliveries(event.id);
			const finalNow = this.dependencies.now();
			const pendingTimes = rows.flatMap((row) => {
				if (row.status === "pending")
					return [row.nextAttemptAt ?? finalNow + 1_000];
				if (
					(row.status === "queued" || row.status === "failed") &&
					row.nextAttemptAt !== null
				)
					return [row.nextAttemptAt];
				return [];
			});
			const dormant = rows.some(
				(row) => row.status === "queued" && row.nextAttemptAt === null,
			);
			const hasPending = pendingTimes.length > 0 || dormant;
			eventPending.set(event.id, hasPending);
			if (
				event.batchId &&
				rows.some(
					(row) => row.status === "sent" && row.reason === "batch_accepted",
				)
			) {
				const tracker = batchTrackers.get(event.batchId);
				if (tracker) tracker.accepted = true;
			}
			if (hasPending) {
				const nextAttemptAt =
					pendingTimes.length > 0 ? Math.min(...pendingTimes) : null;
				await this.dependencies.updateEvent(event.id, {
					status: "deferred",
					reason: dormant ? "pause" : "device_retry",
					nextAttemptAt,
				});
				if (nextAttemptAt !== null) this.scheduleWake(nextAttemptAt);
			} else {
				await this.dependencies.updateEvent(event.id, {
					status: "processed",
					reason:
						rows.length === 0 ? "no_subscribed_devices" : "delivery_complete",
				});
				this.cleanupTrackedEvent(event);
			}
		}
		for (const tracker of batchTrackers.values()) {
			if (tracker.accepted) {
				await this.dependencies.updateBatch(
					tracker.id,
					"sent",
					this.dependencies.now(),
				);
				continue;
			}
			const allTerminal = Array.from(tracker.eventIds).every((eventId) => {
				if (eventPending.has(eventId))
					return eventPending.get(eventId) === false;
				const status = tracker.memberStatuses.get(eventId);
				return (
					status === "processed" ||
					status === "expired" ||
					status === "cancelled"
				);
			});
			if (allTerminal) {
				await this.dependencies.updateBatch(
					tracker.id,
					"expired",
					this.dependencies.now(),
				);
			}
		}
	}
}
