import { createServerFn } from "@tanstack/react-start";
import { dbFetch, requireDbOk } from "#/lib/dbClient";
import {
	type PushPreferences,
	pushEndpointSchema,
	pushSessionIdSchema,
	pushStatusSchema,
	type SessionNotificationMode,
	subscribePushSchema,
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
