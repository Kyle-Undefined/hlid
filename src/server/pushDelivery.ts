import {
	disableExpiredPushSubscriptions,
	getPushSessionOverride,
	listDeliverablePushSubscriptions,
	pushSubscriptionWantsNotification,
	recordPushDeliveryFailure,
	recordPushDeliverySuccess,
	type StoredPushSubscription,
} from "../db";
import type {
	SessionNotificationMode,
	WebPushNotificationPayload,
} from "../lib/pushNotificationSchemas";
import { safePushNotificationUrl } from "../lib/pushNotificationSchemas";
import {
	loadOrCreateVapidKeys,
	sendWebPush,
	type VapidKeys,
	type WebPushSendResult,
} from "./webPush";

const ATTENTION_TTL_MS = 30 * 60 * 1_000;
const FINISHED_TTL_MS = 4 * 60 * 60 * 1_000;
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 5_000] as const;

export type PushEvent = {
	kind: WebPushNotificationPayload["kind"];
	sessionId: string;
	label?: string | null;
	reason?: string | null;
	title?: string | null;
	url?: string;
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

type PushDeliveryDependencies = {
	now: () => number;
	disableExpired: (nowMs: number) => Promise<number>;
	listSubscriptions: (nowMs: number) => Promise<StoredPushSubscription[]>;
	getOverride: (sessionId: string) => Promise<SessionNotificationMode>;
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

function genericContent(kind: PushEvent["kind"]): {
	title: string;
	body: string;
} {
	return kind === "needs_attention"
		? {
				title: "Hlid needs your attention",
				body: "Open Hlid to continue.",
			}
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
		case "delegated_child_attention":
			return "Delegated work needs attention";
		default:
			return "Needs your attention";
	}
}

function detailedContent(event: PushEvent): { title: string; body: string } {
	const generic = genericContent(event.kind);
	const title = bounded(event.title, 160) ?? generic.title;
	const label = bounded(event.label, 160);
	if (event.kind === "work_finished") {
		return {
			title,
			body: label ? `Work finished in ${label}.` : generic.body,
		};
	}
	const reason = attentionReason(event.reason);
	return { title, body: label ? `${label}: ${reason}` : reason };
}

function payloadFor(
	event: PushEvent,
	subscription: StoredPushSubscription,
	createdAt: number,
	expiresAt: number,
): WebPushNotificationPayload {
	const content =
		subscription.preferences.privacy === "detailed"
			? detailedContent(event)
			: genericContent(event.kind);
	return {
		version: 1,
		kind: event.kind,
		sessionId: event.sessionId,
		...content,
		url: safePushNotificationUrl(event.sessionId, event.url),
		createdAt,
		expiresAt,
	};
}

/**
 * Deliver one meaningful server-owned attention transition. The caller owns
 * transition detection; this function owns preferences, privacy, encryption,
 * endpoint lifecycle, and delivery bookkeeping.
 */
export async function deliverPushEvent(
	event: PushEvent,
	overrides: Partial<PushDeliveryDependencies> = {},
): Promise<PushDeliverySummary> {
	const dependencies = { ...defaultDependencies, ...overrides };
	const nowMs = dependencies.now();
	const createdAt = event.createdAt ?? nowMs;
	const expiresAt =
		event.expiresAt ??
		createdAt +
			(event.kind === "needs_attention" ? ATTENTION_TTL_MS : FINISHED_TTL_MS);
	if (
		!event.sessionId ||
		event.sessionId.length > 256 ||
		!Number.isSafeInteger(createdAt) ||
		!Number.isSafeInteger(expiresAt) ||
		createdAt > nowMs + 5 * 60 * 1_000 ||
		expiresAt <= nowMs ||
		expiresAt - createdAt > 24 * 60 * 60 * 1_000
	) {
		throw new Error("Invalid Web Push event");
	}
	await dependencies.disableExpired(nowMs);
	const [subscriptions, mode] = await Promise.all([
		dependencies.listSubscriptions(nowMs),
		dependencies.getOverride(event.sessionId),
	]);
	const candidates = subscriptions.filter((subscription) =>
		pushSubscriptionWantsNotification(subscription, event.kind, mode),
	);
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
	await Promise.all(
		candidates.map(async (subscription) => {
			const result = await sendWithTransientRetry(
				subscription,
				payloadFor(event, subscription, createdAt, expiresAt),
				vapidKeys,
				expiresAt,
				dependencies,
			);
			if (result.outcome === "delivered") {
				summary.delivered += 1;
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
	return summary;
}
