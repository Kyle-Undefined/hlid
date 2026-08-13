import { createHash } from "node:crypto";
import {
	clearPushSessionNotifyOnce,
	disableExpiredPushSubscriptions,
	getPushSessionOverride,
	listDeliverablePushSubscriptions,
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
	sessionId: string;
	label?: string | null;
	reason?: string | null;
	title?: string | null;
	url?: string;
	runtimeMs?: number;
	createdAt?: number;
	expiresAt?: number;
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

type PushDeliveryDependencies = {
	now: () => number;
	disableExpired: (nowMs: number) => Promise<number>;
	listSubscriptions: (nowMs: number) => Promise<StoredPushSubscription[]>;
	getOverride: (sessionId: string) => Promise<SessionNotificationMode>;
	clearNotifyOnce: (sessionId: string) => Promise<boolean>;
	loadVapidKeys: () => VapidKeys;
	send: (
		subscription: StoredPushSubscription,
		payload: WebPushNotificationPayload,
		options: { vapidKeys: VapidKeys; nowMs: number },
	) => Promise<WebPushSendResult>;
	recordSuccess: (endpoint: string) => Promise<void>;
	recordFailure: (endpoint: string, permanent: boolean) => Promise<void>;
	sleep: (delayMs: number) => Promise<void>;
};

const defaultDependencies: PushDeliveryDependencies = {
	now: Date.now,
	disableExpired: disableExpiredPushSubscriptions,
	listSubscriptions: listDeliverablePushSubscriptions,
	getOverride: getPushSessionOverride,
	clearNotifyOnce: clearPushSessionNotifyOnce,
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
		try {
			result = await dependencies.send(subscription, payload, {
				vapidKeys,
				nowMs: dependencies.now(),
			});
		} catch {
			result = { outcome: "failed", statusCode: null };
		}
		const delayMs = TRANSIENT_RETRY_DELAYS_MS[attempt];
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
			body: "Open Hlid to continue.",
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
			: genericContent(primary.kind);
		return {
			version: 1,
			kind: primary.kind,
			sessionId: primary.sessionId,
			...content,
			url: safePushNotificationUrl(
				primary.sessionId,
				detailed
					? primary.url
					: `/raven?${new URLSearchParams({ session: primary.sessionId })}`,
			),
			...(reason ? { reason } : {}),
			...(sessionLabel ? { sessionLabel } : {}),
			...(detailed && primary.runtimeMs !== undefined
				? { durationMs: primary.runtimeMs }
				: {}),
			createdAt,
			expiresAt,
		};
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
	return {
		version: 1,
		kind: "work_finished",
		sessionId: primary.sessionId,
		sessionIds: events.map((event) => event.sessionId),
		batchId: createHash("sha256")
			.update(
				events
					.map((event) => `${event.sessionId}\0${event.createdAt ?? createdAt}`)
					.join("\0"),
			)
			.digest("base64url")
			.slice(0, 24),
		...content,
		url: "/raven",
		createdAt,
		expiresAt,
	};
}

function validatedEvents(events: PushEvent[], nowMs: number): PushEvent[] {
	if (events.length === 0 || events.length > 10) {
		throw new Error("Invalid Web Push event batch");
	}
	const kind = events[0]?.kind;
	if (events.length > 1 && kind !== "work_finished") {
		throw new Error("Only completion events can be batched");
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
			expiresAt <= nowMs ||
			expiresAt - createdAt > 24 * 60 * 60 * 1_000 ||
			(event.runtimeMs !== undefined &&
				(!Number.isSafeInteger(event.runtimeMs) || event.runtimeMs < 0))
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
	const nowMs = dependencies.now();
	validatedEvents(events, nowMs);
	await dependencies.disableExpired(nowMs);
	const [subscriptions, modeEntries] = await Promise.all([
		dependencies.listSubscriptions(nowMs),
		Promise.all(
			events.map(
				async (event) =>
					[
						event.sessionId,
						await dependencies.getOverride(event.sessionId),
					] as const,
			),
		),
	]);
	const modes = new Map(modeEntries);
	const candidates = subscriptions
		.map((subscription) => ({
			subscription,
			events: events.filter((event) =>
				pushSubscriptionWantsNotification(
					subscription,
					event.kind,
					modes.get(event.sessionId) ?? "default",
					{ reason: event.reason, runtimeMs: event.runtimeMs, nowMs },
				),
			),
		}))
		.filter((candidate) => candidate.events.length > 0);
	const summary: PushDeliverySummary = {
		subscriptions: subscriptions.length,
		attempted: candidates.length,
		delivered: 0,
		failed: 0,
		disabled: 0,
		suppressed: subscriptions.length - candidates.length,
	};
	if (candidates.length === 0) return summary;
	const vapidKeys = dependencies.loadVapidKeys();
	const acceptedNotifyOnce = new Set<string>();
	await Promise.all(
		candidates.map(async ({ subscription, events: eligible }) => {
			const expiresAt = Math.min(
				...eligible.map(
					(event) =>
						event.expiresAt ??
						(event.createdAt ?? nowMs) +
							(event.kind === "needs_attention"
								? ATTENTION_TTL_MS
								: FINISHED_TTL_MS),
				),
			);
			const payload = payloadForEvents(
				eligible,
				subscription,
				nowMs,
				expiresAt,
			);
			const result = await sendWithTransientRetry(
				subscription,
				payload,
				vapidKeys,
				expiresAt,
				dependencies,
			);
			if (result.outcome === "delivered") {
				summary.delivered += 1;
				for (const event of eligible) {
					if (modes.get(event.sessionId) === "notify_once") {
						acceptedNotifyOnce.add(event.sessionId);
					}
				}
				await dependencies.recordSuccess(subscription.endpoint).catch(() => {});
				return;
			}
			if (result.outcome === "gone") {
				summary.disabled += 1;
				await dependencies
					.recordFailure(subscription.endpoint, true)
					.catch(() => {});
				return;
			}
			summary.failed += 1;
			await dependencies
				.recordFailure(subscription.endpoint, false)
				.catch(() => {});
		}),
	);
	await Promise.all(
		Array.from(acceptedNotifyOnce, (sessionId) =>
			dependencies.clearNotifyOnce(sessionId).catch(() => false),
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
export async function deliverPushEvents(
	events: PushEvent[],
	overrides: Partial<PushDeliveryDependencies> = {},
): Promise<PushDeliverySummary> {
	return withSessionDeliveryLocks(
		events.map((event) => event.sessionId),
		() => deliverPushEventsUnlocked(events, overrides),
	);
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
