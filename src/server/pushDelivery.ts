import {
	consumePushNotificationOneShot,
	disableExpiredPushSubscriptions,
	type EffectivePushSessionPolicy,
	getEffectivePushSessionPolicy,
	getPushSessionOverride,
	listDeliverablePushSubscriptions,
	pushSessionPolicyTargetsDevice,
	pushSubscriptionWantsNotification,
	recordPushDeliveryFailure,
	recordPushDeliverySuccess,
	type StoredPushSubscription,
} from "../db";
import type {
	PushNotificationTestScenario,
	SessionNotificationMode,
	WebPushNotificationPayload,
} from "../lib/pushNotificationSchemas";
import {
	PUSH_NOTIFICATION_TEST_URL,
	safePushNotificationUrl,
	safeRoutineNotificationUrl,
} from "../lib/pushNotificationSchemas";
import {
	loadOrCreateVapidKeys,
	sendWebPush,
	type VapidKeys,
	type WebPushSendResult,
} from "./webPush";

const ATTENTION_TTL_MS = 30 * 60 * 1_000;
const FINISHED_TTL_MS = 4 * 60 * 60 * 1_000;
const TEST_TTL_MS = 5 * 60 * 1_000;
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 5_000] as const;
const sessionDeliveryTails = new Map<string, Promise<void>>();

export type PushEvent = {
	kind: "needs_attention" | "work_finished";
	sourceKind?: "session" | "routine";
	sessionId: string;
	routineId?: string;
	routineRunId?: string;
	label?: string | null;
	reason?: string | null;
	pendingCount?: number;
	pendingReasonCount?: number;
	title?: string | null;
	url?: string;
	runtimeMs?: number;
	createdAt?: number;
	expiresAt?: number;
	/** A durable per-device delivery row used for worker receipts. */
	deliveryId?: string;
	/** A durable completion group shared by the batch landing view. */
	batchId?: string;
};

export type PushDeliverySummary = {
	subscriptions: number;
	attempted: number;
	delivered: number;
	failed: number;
	disabled: number;
	suppressed: number;
};

export type PushTestDeliveryResult = {
	accepted: boolean;
	subscriptionRemoved: boolean;
};

export type PushDeliveryDependencies = {
	now: () => number;
	disableExpired: (nowMs: number) => Promise<number>;
	listSubscriptions: (nowMs: number) => Promise<StoredPushSubscription[]>;
	getOverride: (sessionId: string) => Promise<SessionNotificationMode>;
	getPolicy: (sessionId: string) => Promise<EffectivePushSessionPolicy>;
	revalidateEvents?: (
		subscription: StoredPushSubscription,
		events: PushEvent[],
		context: {
			nowMs: number;
			policies: ReadonlyMap<string, EffectivePushSessionPolicy>;
		},
	) => Promise<PushEvent[]>;
	onSubscriptionUnavailable?: (
		subscriptionId: string,
		events: PushEvent[],
		nowMs: number,
	) => Promise<void> | void;
	/** Outbox callbacks persist correctness-critical receipts and must surface. */
	strictCallbacks?: boolean;
	clearOneShot: (
		sessionId: string,
		mode: "notify_once" | "notify_completion_once",
		policyUpdatedAt?: number,
	) => Promise<boolean>;
	loadVapidKeys: () => VapidKeys;
	send: (
		subscription: StoredPushSubscription,
		payload: WebPushNotificationPayload,
		options: { vapidKeys: VapidKeys; nowMs: number },
	) => Promise<WebPushSendResult>;
	recordSuccess: (endpoint: string) => Promise<void>;
	recordFailure: (endpoint: string, permanent: boolean) => Promise<void>;
	onResult?: (
		subscription: StoredPushSubscription,
		events: PushEvent[],
		result: WebPushSendResult,
	) => Promise<void> | void;
	onAttempt?: (
		subscription: StoredPushSubscription,
		events: PushEvent[],
		result: WebPushSendResult,
		context: { attempt: number; attemptedAt: number },
	) => Promise<void> | void;
	sleep: (delayMs: number) => Promise<void>;
};

const defaultDependencies: PushDeliveryDependencies = {
	now: Date.now,
	disableExpired: disableExpiredPushSubscriptions,
	listSubscriptions: listDeliverablePushSubscriptions,
	getOverride: getPushSessionOverride,
	getPolicy: getEffectivePushSessionPolicy,
	clearOneShot: consumePushNotificationOneShot,
	loadVapidKeys: loadOrCreateVapidKeys,
	send: (subscription, payload, options) =>
		sendWebPush(subscription, payload, options),
	recordSuccess: recordPushDeliverySuccess,
	recordFailure: recordPushDeliveryFailure,
	sleep: (delayMs) =>
		new Promise((resolve) => {
			setTimeout(resolve, delayMs);
		}),
};

function isTransientFailure(result: WebPushSendResult): boolean {
	return (
		result.outcome === "failed" &&
		(result.statusCode === null ||
			result.statusCode === 408 ||
			result.statusCode === 429 ||
			result.statusCode >= 500)
	);
}

async function sendWithTransientRetry(
	subscription: StoredPushSubscription,
	payload: WebPushNotificationPayload,
	events: PushEvent[],
	vapidKeys: VapidKeys,
	expiresAt: number,
	dependencies: PushDeliveryDependencies,
): Promise<WebPushSendResult> {
	let result: WebPushSendResult = { outcome: "failed", statusCode: null };
	for (
		let attempt = 0;
		attempt <= TRANSIENT_RETRY_DELAYS_MS.length;
		attempt++
	) {
		const attemptedAt = dependencies.now();
		try {
			result = await dependencies.send(subscription, payload, {
				vapidKeys,
				nowMs: attemptedAt,
			});
		} catch {
			result = { outcome: "failed", statusCode: null };
		}
		await Promise.resolve(
			dependencies.onAttempt?.(subscription, events, result, {
				attempt: attempt + 1,
				attemptedAt,
			}),
		).catch(() => {});
		const configuredDelayMs = TRANSIENT_RETRY_DELAYS_MS[attempt];
		const delayMs =
			configuredDelayMs === undefined
				? undefined
				: Math.max(
						configuredDelayMs,
						result.outcome === "failed" ? (result.retryAfterMs ?? 0) : 0,
					);
		if (
			!isTransientFailure(result) ||
			delayMs === undefined ||
			dependencies.now() + delayMs >= expiresAt
		) {
			return result;
		}
		await dependencies.sleep(delayMs);
	}
	return result;
}

function bounded(value: string | null | undefined, max: number): string | null {
	const normalized = value?.trim();
	if (!normalized) return null;
	return normalized.slice(0, max);
}

function genericContent(
	kind: PushEvent["kind"],
	count = 1,
): {
	title: string;
	body: string;
} {
	if (kind === "needs_attention") {
		return {
			title: "Hlid needs your attention",
			body:
				count > 1 ? `${count} items are waiting.` : "Open Hlid to continue.",
		};
	}
	return count > 1
		? { title: "Work finished", body: `${count} Hlid sessions are ready.` }
		: { title: "Work finished", body: "A Hlid session is ready." };
}

function attentionReason(reason: string | null | undefined): string {
	switch (reason) {
		case "permission":
			return "Approval required";
		case "question":
			return "Question waiting";
		case "plan_review":
			return "Plan review waiting";
		case "error":
			return "Session error";
		case "background_failed":
			return "Background work failed";
		case "goal_blocked":
			return "Goal blocked";
		case "goal_budget":
			return "Goal budget reached";
		case "routine_action_required":
			return "Routine needs action";
		case "routine_delivery_error":
			return "Routine delivery failed";
		case "routine_failed":
			return "Routine failed";
		case "routine_unavailable":
		case "routine_provider_unavailable":
			return "Routine unavailable";
		case "delegation_interrupted":
			return "Delegated session was interrupted";
		default:
			return "Needs your attention";
	}
}

function formattedRuntime(runtimeMs: number | undefined): string | null {
	if (
		runtimeMs === undefined ||
		!Number.isSafeInteger(runtimeMs) ||
		runtimeMs < 0
	)
		return null;
	const seconds = Math.max(1, Math.round(runtimeMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function detailedSingleContent(event: PushEvent): {
	title: string;
	body: string;
} {
	const label = bounded(event.label, 160) ?? "Session";
	if (event.kind === "needs_attention") {
		const pendingCount = event.pendingReasonCount ?? 1;
		if (pendingCount > 1) {
			const title =
				event.reason === "permission"
					? `${pendingCount} approvals waiting`
					: event.reason === "question"
						? `${pendingCount} questions waiting`
						: event.reason === "plan_review"
							? `${pendingCount} plan reviews waiting`
							: `${pendingCount} items waiting`;
			return { title, body: label };
		}
		return { title: attentionReason(event.reason), body: label };
	}
	const runtime = formattedRuntime(event.runtimeMs);
	return {
		title: "Work finished",
		body: runtime ? `${label} · ${runtime}` : label,
	};
}

function payloadForEvents(
	events: PushEvent[],
	subscription: StoredPushSubscription,
	createdAt: number,
	expiresAt: number,
): WebPushNotificationPayload {
	const primary = events[0];
	if (!primary) throw new Error("Cannot create an empty Web Push payload");
	if (events.length === 1) {
		const detailed = subscription.preferences.privacy === "detailed";
		const reason = detailed ? bounded(primary.reason, 64) : null;
		const sessionLabel = detailed ? bounded(primary.label, 160) : null;
		const content = detailed
			? detailedSingleContent(primary)
			: genericContent(primary.kind, primary.pendingCount ?? 1);
		if (
			primary.sourceKind === "routine" &&
			primary.routineId &&
			primary.routineRunId
		) {
			const routinePayload = {
				version: 1 as const,
				source: "routine" as const,
				routineId: primary.routineId,
				routineRunId: primary.routineRunId,
				...(primary.deliveryId ? { deliveryId: primary.deliveryId } : {}),
				...content,
				url: safeRoutineNotificationUrl(
					primary.routineId,
					primary.routineRunId,
					primary.url,
				),
				...(reason ? { reason } : {}),
				createdAt,
				expiresAt,
			};
			return primary.kind === "needs_attention"
				? { ...routinePayload, kind: "needs_attention" as const }
				: { ...routinePayload, kind: "work_finished" as const };
		}
		const sessionPayload = {
			version: 1 as const,
			...(primary.deliveryId ? { deliveryId: primary.deliveryId } : {}),
			sessionId: primary.sessionId,
			...content,
			url: safePushNotificationUrl(primary.sessionId, primary.url),
			...(reason ? { reason } : {}),
			...(sessionLabel ? { sessionLabel } : {}),
			...(detailed && primary.runtimeMs !== undefined
				? { durationMs: primary.runtimeMs }
				: {}),
			createdAt,
			expiresAt,
		};
		return primary.kind === "needs_attention"
			? { ...sessionPayload, kind: "needs_attention" as const }
			: { ...sessionPayload, kind: "work_finished" as const };
	}
	const labels = events
		.map((event) => bounded(event.label, 160))
		.filter((label): label is string => Boolean(label));
	const content =
		subscription.preferences.privacy === "detailed"
			? {
					title: `${events.length} sessions finished`,
					body:
						bounded(labels.join(", "), 500) ??
						`${events.length} Hlid sessions are ready.`,
				}
			: genericContent("work_finished", events.length);
	const batchId = primary.batchId as string;
	const deliveryIds = events.flatMap((event) =>
		event.deliveryId ? [event.deliveryId] : [],
	);
	return {
		version: 1,
		kind: "work_finished",
		...(deliveryIds.length === events.length ? { deliveryIds } : {}),
		sessionId: primary.sessionId,
		sessionIds: events.map((event) => event.sessionId),
		batchId,
		...content,
		url: `/raven?${new URLSearchParams({ notification_batch: batchId })}`,
		createdAt,
		expiresAt,
	};
}

function validatedEvents(
	events: PushEvent[],
	nowMs: number,
	allowExpired = false,
): PushEvent[] {
	if (events.length === 0 || events.length > 10) {
		throw new Error("Invalid Web Push event batch");
	}
	const kind = events[0]?.kind;
	if (events.length > 1 && kind !== "work_finished") {
		throw new Error("Only completion events can be batched");
	}
	if (
		events.length > 1 &&
		(!events[0]?.batchId ||
			events.some((event) => event.batchId !== events[0]?.batchId))
	) {
		throw new Error("Completion batches require one durable batch ID");
	}
	const seen = new Set<string>();
	for (const event of events) {
		const createdAt = event.createdAt ?? nowMs;
		const expiresAt =
			event.expiresAt ??
			createdAt +
				(event.kind === "needs_attention" ? ATTENTION_TTL_MS : FINISHED_TTL_MS);
		if (
			event.kind !== kind ||
			!event.sessionId ||
			event.sessionId.length > 256 ||
			seen.has(event.sessionId) ||
			!Number.isSafeInteger(createdAt) ||
			!Number.isSafeInteger(expiresAt) ||
			createdAt > nowMs + 5 * 60 * 1_000 ||
			(!allowExpired && expiresAt <= nowMs) ||
			expiresAt - createdAt > 24 * 60 * 60 * 1_000 ||
			(event.runtimeMs !== undefined &&
				(!Number.isSafeInteger(event.runtimeMs) || event.runtimeMs < 0)) ||
			(event.pendingCount !== undefined &&
				(!Number.isSafeInteger(event.pendingCount) ||
					event.pendingCount < 1 ||
					event.pendingCount > 999)) ||
			(event.pendingReasonCount !== undefined &&
				(!Number.isSafeInteger(event.pendingReasonCount) ||
					event.pendingReasonCount < 1 ||
					event.pendingReasonCount > 999)) ||
			(event.sourceKind === "routine" &&
				(!event.routineId || !event.routineRunId || events.length !== 1))
		) {
			throw new Error("Invalid Web Push event");
		}
		seen.add(event.sessionId);
	}
	return events;
}

/**
 * Deliver one attention event or a short completion batch. Eligibility is
 * evaluated per event and per device before aggregation, preserving Mute,
 * Notify, Notify once, pause, category, and duration-threshold semantics.
 */
async function deliverPushEventsUnlocked(
	events: PushEvent[],
	overrides: Partial<PushDeliveryDependencies> = {},
): Promise<PushDeliverySummary> {
	const dependencies = { ...defaultDependencies, ...overrides };
	const overrideGetter = overrides.getOverride;
	const getPolicy =
		overrides.getPolicy ??
		(overrideGetter
			? async (sessionId: string): Promise<EffectivePushSessionPolicy> => ({
					requestedSessionId: sessionId,
					sourceSessionId: sessionId,
					mode: await overrideGetter(sessionId),
					scope: "session",
					targetDeviceIds: null,
					inherited: false,
				})
			: dependencies.getPolicy);
	const nowMs = dependencies.now();
	validatedEvents(events, nowMs, dependencies.revalidateEvents !== undefined);
	await dependencies.disableExpired(nowMs);
	const [subscriptions, policyEntries] = await Promise.all([
		dependencies.listSubscriptions(nowMs),
		Promise.all(
			events.map(
				async (event) =>
					[event.sessionId, await getPolicy(event.sessionId)] as const,
			),
		),
	]);
	const policies = new Map(policyEntries);
	const candidates = subscriptions
		.map((subscription) => {
			const eligible = events.filter((event) => {
				const policy = policies.get(event.sessionId);
				return (
					(!policy ||
						pushSessionPolicyTargetsDevice(policy, subscription.id)) &&
					pushSubscriptionWantsNotification(
						subscription,
						event.kind,
						policy?.mode ?? "default",
						{ reason: event.reason, runtimeMs: event.runtimeMs, nowMs },
					)
				);
			});
			const exactInput =
				eligible.length === events.length &&
				eligible.every(
					(event, index) =>
						event.sessionId === events[index]?.sessionId &&
						event.deliveryId === events[index]?.deliveryId,
				);
			return {
				subscription,
				deliveryGroups: exactInput
					? [eligible]
					: eligible.map((event) => [{ ...event, batchId: undefined }]),
			};
		})
		.filter((candidate) => candidate.deliveryGroups.length > 0);
	const summary: PushDeliverySummary = {
		subscriptions: subscriptions.length,
		attempted: 0,
		delivered: 0,
		failed: 0,
		disabled: 0,
		suppressed: subscriptions.length,
	};
	if (candidates.length === 0) return summary;
	const vapidKeys = dependencies.loadVapidKeys();
	const acceptedOneShots = new Map<
		string,
		{
			sourceSessionId: string;
			mode: "notify_once" | "notify_completion_once";
			policyUpdatedAt?: number;
		}
	>();
	const attemptedSubscriptionIds = new Set<string>();
	const deliverCandidate = async ({
		subscription,
		deliveryGroups,
	}: (typeof candidates)[number]) => {
		const queue = [...deliveryGroups];
		while (queue.length > 0) {
			const initialQueued = queue.shift();
			if (!initialQueued || initialQueued.length === 0) continue;
			let queued: PushEvent[] = initialQueued;
			let attempt = 0;
			let finalDelivery:
				| {
						subscription: StoredPushSubscription;
						events: PushEvent[];
						policies: Map<string, EffectivePushSessionPolicy>;
						result: WebPushSendResult;
						callbackError?: unknown;
				  }
				| undefined;
			for (;;) {
				const deliveryNow = dependencies.now();
				const [refreshedSubscriptions, refreshedPolicyEntries]: [
					StoredPushSubscription[],
					ReadonlyArray<readonly [string, EffectivePushSessionPolicy]>,
				] = await Promise.all([
					dependencies.listSubscriptions(deliveryNow),
					Promise.all(
						queued.map(
							async (event) =>
								[event.sessionId, await getPolicy(event.sessionId)] as const,
						),
					),
				]);
				const liveSubscription: StoredPushSubscription | undefined =
					refreshedSubscriptions.find(
						(candidate) => candidate.id === subscription.id,
					);
				if (!liveSubscription) {
					const unavailable = Promise.resolve(
						dependencies.onSubscriptionUnavailable?.(
							subscription.id,
							queued,
							deliveryNow,
						),
					);
					if (dependencies.strictCallbacks) await unavailable;
					else await unavailable.catch(() => {});
					break;
				}
				const livePolicies = new Map(refreshedPolicyEntries);
				const revalidated: PushEvent[] = dependencies.revalidateEvents
					? await dependencies.revalidateEvents(liveSubscription, queued, {
							nowMs: deliveryNow,
							policies: livePolicies,
						})
					: queued;
				if (revalidated.length > 0) {
					validatedEvents(revalidated, dependencies.now());
				}
				const eligible = revalidated.filter((event) => {
					const policy = livePolicies.get(event.sessionId);
					return (
						(!policy ||
							pushSessionPolicyTargetsDevice(policy, liveSubscription.id)) &&
						pushSubscriptionWantsNotification(
							liveSubscription,
							event.kind,
							policy?.mode ?? "default",
							{
								reason: event.reason,
								runtimeMs: event.runtimeMs,
								nowMs: deliveryNow,
							},
						)
					);
				});
				const exactQueued =
					eligible.length === queued.length &&
					eligible.every(
						(event, index) =>
							event.sessionId === queued[index]?.sessionId &&
							event.deliveryId === queued[index]?.deliveryId,
					);
				if (!exactQueued && queued.length > 1) {
					queue.unshift(
						...eligible.map((event) => [{ ...event, batchId: undefined }]),
					);
					break;
				}
				if (eligible.length === 0) break;
				queued = eligible;
				const expiresAt = Math.min(
					...eligible.map(
						(event) =>
							event.expiresAt ??
							(event.createdAt ?? deliveryNow) +
								(event.kind === "needs_attention"
									? ATTENTION_TTL_MS
									: FINISHED_TTL_MS),
					),
				);
				const payload = payloadForEvents(
					eligible,
					liveSubscription,
					deliveryNow,
					expiresAt,
				);
				attempt += 1;
				if (attempt === 1) summary.attempted += 1;
				attemptedSubscriptionIds.add(liveSubscription.id);
				let result: WebPushSendResult;
				try {
					result = await dependencies.send(liveSubscription, payload, {
						vapidKeys,
						nowMs: deliveryNow,
					});
				} catch {
					result = { outcome: "failed", statusCode: null };
				}
				const attemptCallback = Promise.resolve(
					dependencies.onAttempt?.(liveSubscription, eligible, result, {
						attempt,
						attemptedAt: deliveryNow,
					}),
				);
				let callbackError: unknown;
				if (dependencies.strictCallbacks) {
					try {
						await attemptCallback;
					} catch (error) {
						callbackError = error;
					}
				} else await attemptCallback.catch(() => {});
				const configuredDelayMs = TRANSIENT_RETRY_DELAYS_MS[attempt - 1];
				const delayMs =
					configuredDelayMs === undefined
						? undefined
						: Math.max(
								configuredDelayMs,
								result.outcome === "failed" ? (result.retryAfterMs ?? 0) : 0,
							);
				if (
					callbackError === undefined &&
					isTransientFailure(result) &&
					delayMs !== undefined &&
					dependencies.now() + delayMs < expiresAt
				) {
					await dependencies.sleep(delayMs);
					continue;
				}
				finalDelivery = {
					subscription: liveSubscription,
					events: eligible,
					policies: livePolicies,
					result,
				};
				if (callbackError !== undefined)
					finalDelivery.callbackError = callbackError;
				break;
			}
			if (!finalDelivery) continue;
			const {
				subscription: liveSubscription,
				events: eligible,
				policies: livePolicies,
				result,
			} = finalDelivery;
			if (result.outcome === "delivered") {
				summary.delivered += 1;
				for (const event of eligible) {
					const policy = livePolicies.get(event.sessionId);
					if (
						policy?.sourceSessionId &&
						(policy.mode === "notify_once" ||
							(policy.mode === "notify_completion_once" &&
								event.kind === "work_finished"))
					) {
						acceptedOneShots.set(
							`${policy.sourceSessionId}\0${policy.mode}\0${policy.sourceUpdatedAt ?? 0}`,
							{
								sourceSessionId: policy.sourceSessionId,
								mode: policy.mode,
								...(typeof policy.sourceUpdatedAt === "number" &&
								policy.sourceUpdatedAt > 0
									? { policyUpdatedAt: policy.sourceUpdatedAt }
									: {}),
							},
						);
					}
				}
				await dependencies
					.recordSuccess(liveSubscription.endpoint)
					.catch(() => {});
			} else if (result.outcome === "gone") {
				summary.disabled += 1;
				await dependencies
					.recordFailure(liveSubscription.endpoint, true)
					.catch(() => {});
			} else {
				summary.failed += 1;
				await dependencies
					.recordFailure(liveSubscription.endpoint, false)
					.catch(() => {});
			}
			const resultCallback = Promise.resolve(
				dependencies.onResult?.(liveSubscription, eligible, result),
			);
			if (dependencies.strictCallbacks) await resultCallback;
			else await resultCallback.catch(() => {});
			if ("callbackError" in finalDelivery) throw finalDelivery.callbackError;
		}
	};
	// Keep provider fan-out bounded when an installation has many retained
	// browsers. A small batch preserves concurrency without a request storm.
	for (let index = 0; index < candidates.length; index += 8) {
		await Promise.all(candidates.slice(index, index + 8).map(deliverCandidate));
	}
	summary.suppressed = Math.max(
		0,
		subscriptions.length - attemptedSubscriptionIds.size,
	);
	await Promise.all(
		Array.from(acceptedOneShots.values(), (oneShot) =>
			(oneShot.policyUpdatedAt
				? dependencies.clearOneShot(
						oneShot.sourceSessionId,
						oneShot.mode,
						oneShot.policyUpdatedAt,
					)
				: dependencies.clearOneShot(oneShot.sourceSessionId, oneShot.mode)
			).catch(() => false),
		),
	);
	return summary;
}

async function withSessionDeliveryLocks<T>(
	sessionIds: string[],
	operation: () => Promise<T>,
): Promise<T> {
	const ids = Array.from(new Set(sessionIds)).sort();
	const previous = ids.map(
		(sessionId) => sessionDeliveryTails.get(sessionId) ?? Promise.resolve(),
	);
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = Promise.all(previous).then(() => gate);
	for (const sessionId of ids) sessionDeliveryTails.set(sessionId, tail);
	await Promise.all(previous);
	try {
		return await operation();
	} finally {
		release();
		for (const sessionId of ids) {
			if (sessionDeliveryTails.get(sessionId) === tail) {
				sessionDeliveryTails.delete(sessionId);
			}
		}
	}
}

/** Serialize overlapping session deliveries so Notify once is consumed once. */
// fallow-ignore-next-line unused-export -- Vitest exercises the process-lock delivery contract independently of the durable outbox.
export async function deliverPushEvents(
	events: PushEvent[],
	overrides: Partial<PushDeliveryDependencies> = {},
): Promise<PushDeliverySummary> {
	return withSessionDeliveryLocks(
		events.map((event) => event.sessionId),
		() => deliverPushEventsUnlocked(events, overrides),
	);
}

/**
 * Outbox-only entry point. The durable outbox owns one drain and defers
 * one-shot clearing until its bounded device fan-out settles, so taking the
 * process-wide session lock here would only serialize independent devices.
 */
export async function deliverPushEventsWithinOutbox(
	events: PushEvent[],
	overrides: Partial<PushDeliveryDependencies> = {},
): Promise<PushDeliverySummary> {
	return deliverPushEventsUnlocked(events, overrides);
}

/** Send a real provider request only to the exact currently-owned endpoint. */
function testNotificationContent(
	scenario: PushNotificationTestScenario,
	privacy: StoredPushSubscription["preferences"]["privacy"],
): { title: string; body: string } {
	if (scenario === "delivery") {
		return {
			title: "Hlid test notification",
			body: "Notifications are working on this device.",
		};
	}
	if (scenario === "work_finished_batch") {
		return privacy === "detailed"
			? {
					title: "3 sessions finished",
					body: "Preview one, Preview two, Preview three",
				}
			: genericContent("work_finished", 3);
	}
	if (scenario === "work_finished") {
		return privacy === "detailed"
			? detailedSingleContent({
					kind: "work_finished",
					sessionId: "notification-preview",
					label: "Notification preview",
					runtimeMs: 2 * 60_000,
				})
			: genericContent("work_finished");
	}
	const reason = scenario === "problem" ? "error" : scenario;
	return privacy === "detailed"
		? detailedSingleContent({
				kind: "needs_attention",
				sessionId: "notification-preview",
				label: "Notification preview",
				reason,
			})
		: genericContent("needs_attention");
}

export async function deliverTestPushNotification(
	subscription: StoredPushSubscription,
	overrides: Partial<PushDeliveryDependencies> = {},
	scenario: PushNotificationTestScenario = "delivery",
): Promise<PushTestDeliveryResult> {
	const dependencies = { ...defaultDependencies, ...overrides };
	const nowMs = dependencies.now();
	const expiresAt = nowMs + TEST_TTL_MS;
	const content = testNotificationContent(
		scenario,
		subscription.preferences.privacy,
	);
	const payload: WebPushNotificationPayload = {
		version: 1,
		kind: "test",
		...content,
		url: PUSH_NOTIFICATION_TEST_URL,
		createdAt: nowMs,
		expiresAt,
	};
	let result: WebPushSendResult;
	try {
		result = await sendWithTransientRetry(
			subscription,
			payload,
			[],
			dependencies.loadVapidKeys(),
			expiresAt,
			dependencies,
		);
	} catch {
		result = { outcome: "failed", statusCode: null };
	}
	if (result.outcome === "delivered") {
		await dependencies.recordSuccess(subscription.endpoint).catch(() => {});
		return { accepted: true, subscriptionRemoved: false };
	}
	const permanent = result.outcome === "gone";
	await dependencies
		.recordFailure(subscription.endpoint, permanent)
		.catch(() => {});
	return { accepted: false, subscriptionRemoved: permanent };
}
