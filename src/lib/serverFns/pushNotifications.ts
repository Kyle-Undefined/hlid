import { createServerFn } from "@tanstack/react-start";
import { dbFetch, requireDbOk } from "#/lib/dbClient";
import {
	deletePushDeviceSchema,
	listPushDevicesSchema,
	type PushPreferences,
	pushEndpointSchema,
	pushSessionIdSchema,
	pushStatusSchema,
	pushTestSchema,
	type SessionNotificationMode,
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
	paused_until: number | null;
	paused_indefinitely: boolean;
	created_at: number;
	updated_at: number;
	last_success_at: number | null;
	last_failure_at: number | null;
	failure_count: number;
};

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
			"Rename notification device",
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
		internalJson<{ mode: SessionNotificationMode }>(
			`/api/push/session-overrides?session_id=${encodeURIComponent(data)}`,
			"Read session notification preference",
		),
	);

export const setSessionNotificationOverrideFn = createServerFn({
	method: "POST",
})
	.validator((raw) => updatePushSessionOverrideSchema.parse(raw))
	.handler(({ data }) =>
		internalJson<{ ok: true; mode: SessionNotificationMode }>(
			"/api/push/session-overrides",
			"Update session notification preference",
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			},
		),
	);
