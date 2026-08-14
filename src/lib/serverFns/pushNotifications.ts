import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { dbFetch, requireDbOk } from "#/lib/dbClient";
import {
	deletePushDeviceSchema,
	listPushDevicesSchema,
	type PushPreferences,
	pushEndpointSchema,
	pushNotificationBatchIdSchema,
	pushNotificationBatchReadSchema,
	pushSessionIdSchema,
	pushStatusSchema,
	pushTestSchema,
	type SessionNotificationMode,
	type SessionNotificationScope,
	subscribePushSchema,
	updatePushDeviceSchema,
	updatePushSessionOverrideSchema,
	updatePushSubscriptionSchema,
} from "#/lib/pushNotificationSchemas";

export type PushConfigResponse =
	| { available: true; publicKey: string }
	| { available: false; publicKey: null };

export type PushStatusResponse = {
	available: true;
	subscribed: boolean;
	preferences: PushPreferences | null;
	device_name: string | null;
};

export type PushDeviceResponse = {
	id: string;
	name: string;
	current: boolean;
	enabled: boolean;
	preferences: PushPreferences;
	paused_until: number | null;
	paused_indefinitely: boolean;
	created_at: number;
	updated_at: number;
	last_success_at: number | null;
	last_failure_at: number | null;
	failure_count: number;
};

export type PushSessionPolicyResponse = {
	session_id: string;
	mode: Exclude<SessionNotificationMode, "default">;
	scope: SessionNotificationScope;
	target_device_ids: string[] | null;
	updated_at: number;
};

export type EffectivePushSessionPolicyResponse = {
	requested_session_id: string;
	source_session_id: string | null;
	mode: SessionNotificationMode;
	scope: SessionNotificationScope;
	target_device_ids: string[] | null;
	inherited: boolean;
};

export type PushSessionPolicyStateResponse = {
	policy: PushSessionPolicyResponse | null;
	effective: EffectivePushSessionPolicyResponse;
};

export type PushNotificationEventSummaryResponse = {
	id: string;
	source_kind: "session" | "routine" | "system";
	source_id: string;
	category: "request" | "problem" | "completion";
	reason: string | null;
	label: string | null;
	url: string | null;
	runtime_ms: number | null;
	pending_count: number;
	occurred_at: number;
	expires_at: number;
	group_key: string | null;
	batch_id: string | null;
	status:
		| "pending"
		| "deferred"
		| "batched"
		| "processed"
		| "expired"
		| "cancelled";
	status_reason: string | null;
	next_attempt_at: number | null;
};

export type PushNotificationHistoryEventResponse =
	PushNotificationEventSummaryResponse & {
		deliveries: Array<{
			id: string;
			device_id: string;
			device: {
				id: string;
				name: string;
				privacy: "generic" | "detailed";
				preferences?: PushPreferences;
			};
			status:
				| "pending"
				| "suppressed"
				| "queued"
				| "sent"
				| "failed"
				| "gone"
				| "expired";
			reason: string | null;
			next_attempt_at: number | null;
			attempt_count: number;
			provider_status: number | null;
			receipt_at: number | null;
			displayed_at: number | null;
			opened_at: number | null;
			dismissed_at: number | null;
			created_at: number;
			updated_at: number;
		}>;
	};

export type PushNotificationBatchResponse = {
	id: string;
	category: "request" | "problem" | "completion";
	group_key: string | null;
	status: "open" | "ready" | "sent" | "read" | "expired";
	created_at: number;
	updated_at: number;
	sent_at: number | null;
	read_at: number | null;
};

export type PushNotificationBatchMemberResponse = {
	event_id: string;
	session_id: string;
	position: number;
	added_at: number;
	read_at: number | null;
	event: PushNotificationEventSummaryResponse | null;
};

const pushNotificationHistoryLimitSchema = z.number().int().min(1).max(100);

async function internalJson<T>(
	path: string,
	label: string,
	init?: RequestInit,
): Promise<T> {
	const headers = new Headers(init?.headers);
	// The loopback data route uses the durable auth-session hash as the device
	// owner. Forward the outer HttpOnly cookie only inside this authenticated
	// server-function hop; it is never returned to or read by browser JavaScript.
	const { getRequestHeader } = await import("@tanstack/react-start/server");
	const cookie = getRequestHeader("cookie");
	if (cookie) headers.set("cookie", cookie);
	const response = await requireDbOk(
		await dbFetch(path, { ...init, headers }),
		label,
	);
	return (await response.json()) as T;
}

export const getPushConfigFn = createServerFn({ method: "GET" }).handler(() =>
	internalJson<PushConfigResponse>(
		"/api/push/config",
		"Read notification setup",
	),
);

export const getPushStatusFn = createServerFn({ method: "POST" })
	.validator((raw) => pushStatusSchema.parse(raw ?? {}))
	.handler(({ data }) =>
		internalJson<PushStatusResponse>(
			"/api/push/status",
			"Read notification status",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			},
		),
	);

export const subscribeToPushFn = createServerFn({ method: "POST" })
	.validator((raw) => subscribePushSchema.parse(raw))
	.handler(({ data }) =>
		internalJson<{ ok: true; preferences: PushPreferences }>(
			"/api/push/subscriptions",
			"Enable notifications",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			},
		),
	);

export const updatePushPreferencesFn = createServerFn({ method: "POST" })
	.validator((raw) => updatePushSubscriptionSchema.parse(raw))
	.handler(({ data }) =>
		internalJson<{ ok: true; preferences: PushPreferences }>(
			"/api/push/subscriptions",
			"Update notification preferences",
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			},
		),
	);

export const unsubscribeFromPushFn = createServerFn({ method: "POST" })
	.validator((raw) => pushEndpointSchema.parse(raw))
	.handler(({ data }) =>
		internalJson<{ ok: true; removed: boolean }>(
			"/api/push/subscriptions",
			"Disable notifications",
			{
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			},
		),
	);

export const listPushDevicesFn = createServerFn({ method: "POST" })
	.validator((raw) => listPushDevicesSchema.parse(raw ?? {}))
	.handler(({ data }) =>
		internalJson<{ devices: PushDeviceResponse[] }>(
			"/api/push/devices",
			"List notification devices",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			},
		),
	);

export const updatePushDeviceFn = createServerFn({ method: "POST" })
	.validator((raw) => updatePushDeviceSchema.parse(raw))
	.handler(({ data }) =>
		internalJson<{ ok: true; device: PushDeviceResponse }>(
			"/api/push/devices",
			"Update notification device",
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			},
		),
	);

export const deletePushDeviceFn = createServerFn({ method: "POST" })
	.validator((raw) => deletePushDeviceSchema.parse(raw))
	.handler(({ data }) =>
		internalJson<{ ok: true; removed: boolean }>(
			"/api/push/devices",
			"Revoke notification device",
			{
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			},
		),
	);

export const getPushNotificationHistoryFn = createServerFn({ method: "GET" })
	.validator((raw) => pushNotificationHistoryLimitSchema.parse(raw ?? 20))
	.handler(({ data }) =>
		internalJson<{ events: PushNotificationHistoryEventResponse[] }>(
			`/api/push/history?limit=${data}`,
			"Read notification history",
		),
	);

export const getPushNotificationBatchFn = createServerFn({ method: "GET" })
	.validator((raw) => pushNotificationBatchIdSchema.parse(raw))
	.handler(({ data }) =>
		internalJson<{
			batch: PushNotificationBatchResponse;
			members: PushNotificationBatchMemberResponse[];
		}>(
			`/api/push/batches?batch_id=${encodeURIComponent(data)}`,
			"Read notification batch",
		),
	);

export const markPushNotificationBatchReadFn = createServerFn({
	method: "POST",
})
	.validator((raw) => pushNotificationBatchReadSchema.parse(raw))
	.handler(({ data }) =>
		internalJson<{ ok: true; read_at: number }>(
			"/api/push/batches",
			"Mark notification batch read",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			},
		),
	);

export const sendTestPushNotificationFn = createServerFn({ method: "POST" })
	.validator((raw) => pushTestSchema.parse(raw))
	.handler(({ data }) =>
		internalJson<{
			accepted: boolean;
			accepted_at: number | null;
			failure_at: number | null;
			failure_count: number;
			subscription_removed: boolean;
		}>("/api/push/test", "Send test notification", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(data),
		}),
	);

export const getSessionNotificationOverrideFn = createServerFn({
	method: "GET",
})
	.validator((raw) => pushSessionIdSchema.parse(raw))
	.handler(({ data }) =>
		internalJson<PushSessionPolicyStateResponse>(
			`/api/push/session-overrides?session_id=${encodeURIComponent(data)}`,
			"Read session notification preference",
		),
	);

export const setSessionNotificationOverrideFn = createServerFn({
	method: "POST",
})
	.validator((raw) => updatePushSessionOverrideSchema.parse(raw))
	.handler(({ data }) =>
		internalJson<{ ok: true } & PushSessionPolicyStateResponse>(
			"/api/push/session-overrides",
			"Update session notification preference",
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			},
		),
	);
