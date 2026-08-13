import {
	deletePushSubscription,
	getPushSessionOverride,
	getPushSubscription,
	listPushSubscriptionDevices,
	type PushSubscriptionDevice,
	renamePushSubscriptionDevice,
	revokePushSubscriptionDevice,
	setPushSessionOverride,
	updatePushSubscriptionPreferences,
	upsertPushSubscription,
} from "../db";
import {
	deletePushDeviceSchema,
	listPushDevicesSchema,
	type PushNotificationTestScenario,
	type PushPreferences,
	pushEndpointSchema,
	pushSessionIdSchema,
	pushStatusSchema,
	pushTestSchema,
	subscribePushSchema,
	updatePushDeviceSchema,
	updatePushSessionOverrideSchema,
	updatePushSubscriptionSchema,
} from "../lib/pushNotificationSchemas";
import { authenticatedSessionHash } from "./auth";
import {
	deliverTestPushNotification,
	type PushTestDeliveryResult,
} from "./pushDelivery";
import {
	loadOrCreateVapidKeys,
	validateBrowserPushSubscription,
	validatePushServiceEndpoint,
} from "./webPush";

type PushRouteDependencies = {
	publicKey: () => string;
	now: () => number;
	authSessionHash: (request: Request) => Promise<string | null>;
	getSubscription: typeof getPushSubscription;
	upsertSubscription: typeof upsertPushSubscription;
	updatePreferences: typeof updatePushSubscriptionPreferences;
	deleteSubscription: typeof deletePushSubscription;
	listDevices: typeof listPushSubscriptionDevices;
	renameDevice: typeof renamePushSubscriptionDevice;
	revokeDevice: typeof revokePushSubscriptionDevice;
	getSessionOverride: typeof getPushSessionOverride;
	setSessionOverride: typeof setPushSessionOverride;
	testPush: (
		subscription: NonNullable<Awaited<ReturnType<typeof getPushSubscription>>>,
		scenario: PushNotificationTestScenario,
	) => Promise<PushTestDeliveryResult>;
	validateSubscription: typeof validateBrowserPushSubscription;
	validateEndpoint: typeof validatePushServiceEndpoint;
};

const defaultDependencies: PushRouteDependencies = {
	publicKey: () => loadOrCreateVapidKeys().publicKey,
	now: Date.now,
	authSessionHash: authenticatedSessionHash,
	getSubscription: getPushSubscription,
	upsertSubscription: upsertPushSubscription,
	updatePreferences: updatePushSubscriptionPreferences,
	deleteSubscription: deletePushSubscription,
	listDevices: listPushSubscriptionDevices,
	renameDevice: renamePushSubscriptionDevice,
	revokeDevice: revokePushSubscriptionDevice,
	getSessionOverride: getPushSessionOverride,
	setSessionOverride: setPushSessionOverride,
	testPush: (subscription, scenario) =>
		deliverTestPushNotification(subscription, {}, scenario),
	validateSubscription: validateBrowserPushSubscription,
	validateEndpoint: validatePushServiceEndpoint,
};

function json(value: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("cache-control", "private, no-store");
	return Response.json(value, { ...init, headers });
}

async function body(request: Request): Promise<unknown> {
	try {
		const text = await request.text();
		if (text.length > 16 * 1_024) throw new Error("too large");
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function invalidRequest(): Response {
	return json({ error: "Invalid Web Push request" }, { status: 400 });
}

type RequestBodySchema<T> = {
	safeParse: (
		value: unknown,
	) => { success: true; data: T } | { success: false };
};

async function parseRequestBody<T>(
	request: Request,
	schema: RequestBodySchema<T>,
): Promise<{ data: T } | { response: Response }> {
	const parsed = schema.safeParse(await body(request));
	return parsed.success
		? { data: parsed.data }
		: { response: invalidRequest() };
}

function browserSessionRequired(): Response {
	return json(
		{ error: "A signed-in browser session is required" },
		{ status: 403 },
	);
}

async function authenticatedBrowser(
	request: Request,
	dependencies: Pick<PushRouteDependencies, "authSessionHash">,
): Promise<{ authSessionHash: string } | { response: Response }> {
	const authSessionHash = await dependencies.authSessionHash(request);
	return authSessionHash
		? { authSessionHash }
		: { response: browserSessionRequired() };
}

async function endpointOwner(
	endpoint: string,
	request: Request,
	dependencies: Pick<
		PushRouteDependencies,
		"authSessionHash" | "validateEndpoint"
	>,
): Promise<{ authSessionHash: string } | { response: Response }> {
	try {
		dependencies.validateEndpoint(endpoint);
	} catch {
		return { response: invalidRequest() };
	}
	return authenticatedBrowser(request, dependencies);
}

async function endpointOwnerFromBody(
	request: Request,
	dependencies: Pick<
		PushRouteDependencies,
		"authSessionHash" | "validateEndpoint"
	>,
): Promise<
	{ endpoint: string; authSessionHash: string } | { response: Response }
> {
	const parsed = await parseRequestBody(request, pushEndpointSchema);
	if ("response" in parsed) return parsed;
	const owner = await endpointOwner(
		parsed.data.endpoint,
		request,
		dependencies,
	);
	return "response" in owner
		? owner
		: {
				endpoint: parsed.data.endpoint,
				authSessionHash: owner.authSessionHash,
			};
}

async function parseDeviceBody<T extends { endpoint?: string }>(
	request: Request,
	schema: RequestBodySchema<T>,
	dependencies: Pick<PushRouteDependencies, "validateEndpoint">,
): Promise<{ data: T } | { response: Response }> {
	const parsed = await parseRequestBody(request, schema);
	if ("response" in parsed) return parsed;
	if (parsed.data.endpoint) {
		try {
			dependencies.validateEndpoint(parsed.data.endpoint);
		} catch {
			return { response: invalidRequest() };
		}
	}
	return parsed;
}

function wireDevice(device: PushSubscriptionDevice) {
	return {
		id: device.id,
		name: device.name,
		current: device.current,
		enabled: device.enabled,
		paused_until: device.pausedUntil,
		paused_indefinitely: device.pausedIndefinitely,
		created_at: device.createdAt,
		updated_at: device.updatedAt,
		last_success_at: device.lastSuccessAt,
		last_failure_at: device.lastFailureAt,
		failure_count: device.failureCount,
	};
}

function wirePreferences(preferences: PushPreferences) {
	return {
		...preferences,
		// Cached v1 clients can keep reading their single attention toggle during a
		// rolling PWA/service-worker update. New clients use the split categories.
		needs_attention: preferences.requests || preferences.problems,
	};
}

/** Routes run behind Hlid's shared authenticated request policy. */
export function createPushRouteHandler(
	overrides: Partial<PushRouteDependencies> = {},
) {
	const dependencies = { ...defaultDependencies, ...overrides };
	return async (url: URL, request: Request): Promise<Response | null> => {
		if (!url.pathname.startsWith("/api/push/")) return null;

		if (url.pathname === "/api/push/config") {
			if (request.method !== "GET") {
				return json({ error: "Method not allowed" }, { status: 405 });
			}
			try {
				return json({ available: true, publicKey: dependencies.publicKey() });
			} catch {
				return json({ available: false, publicKey: null });
			}
		}

		if (url.pathname === "/api/push/status") {
			if (request.method !== "POST") {
				return json({ error: "Method not allowed" }, { status: 405 });
			}
			const parsed = await parseRequestBody(request, pushStatusSchema);
			if ("response" in parsed) return parsed.response;
			if (!parsed.data.endpoint) {
				return json({
					available: true,
					subscribed: false,
					preferences: null,
					device_name: null,
				});
			}
			const owner = await endpointOwner(
				parsed.data.endpoint,
				request,
				dependencies,
			);
			if ("response" in owner) return owner.response;
			const subscription = await dependencies.getSubscription(
				parsed.data.endpoint,
				owner.authSessionHash,
				dependencies.now(),
			);
			return json({
				available: true,
				subscribed:
					subscription?.enabled === true &&
					(subscription.expirationTime === null ||
						subscription.expirationTime > dependencies.now()),
				preferences: subscription
					? wirePreferences(subscription.preferences)
					: null,
				device_name: subscription?.name ?? null,
			});
		}

		if (url.pathname === "/api/push/subscriptions") {
			if (request.method === "POST") {
				const parsed = await parseRequestBody(request, subscribePushSchema);
				if ("response" in parsed) return parsed.response;
				try {
					dependencies.validateSubscription(parsed.data.subscription);
				} catch {
					return invalidRequest();
				}
				const browser = await authenticatedBrowser(request, dependencies);
				if ("response" in browser) return browser.response;
				const subscription = await dependencies.upsertSubscription(
					parsed.data.subscription,
					browser.authSessionHash,
					parsed.data.preferences,
					parsed.data.device_name,
				);
				return json({
					ok: true,
					preferences: wirePreferences(subscription.preferences),
				});
			}
			if (request.method === "PATCH") {
				const parsed = await parseRequestBody(
					request,
					updatePushSubscriptionSchema,
				);
				if ("response" in parsed) return parsed.response;
				const owner = await endpointOwner(
					parsed.data.endpoint,
					request,
					dependencies,
				);
				if ("response" in owner) return owner.response;
				const subscription = await dependencies.updatePreferences(
					parsed.data.endpoint,
					owner.authSessionHash,
					parsed.data.preferences,
				);
				return subscription
					? json({
							ok: true,
							preferences: wirePreferences(subscription.preferences),
						})
					: json({ error: "Push subscription not found" }, { status: 404 });
			}
			if (request.method === "DELETE") {
				const owner = await endpointOwnerFromBody(request, dependencies);
				if ("response" in owner) return owner.response;
				return json({
					ok: true,
					removed: await dependencies.deleteSubscription(
						owner.endpoint,
						owner.authSessionHash,
					),
				});
			}
			return json({ error: "Method not allowed" }, { status: 405 });
		}

		if (url.pathname === "/api/push/devices") {
			const browser = await authenticatedBrowser(request, dependencies);
			if ("response" in browser) return browser.response;
			if (request.method === "POST") {
				const parsed = await parseDeviceBody(
					request,
					listPushDevicesSchema,
					dependencies,
				);
				if ("response" in parsed) return parsed.response;
				const devices = await dependencies.listDevices(
					browser.authSessionHash,
					parsed.data.endpoint,
					dependencies.now(),
				);
				return json({ devices: devices.map(wireDevice) });
			}
			if (request.method === "PATCH") {
				const parsed = await parseDeviceBody(
					request,
					updatePushDeviceSchema,
					dependencies,
				);
				if ("response" in parsed) return parsed.response;
				const device = await dependencies.renameDevice(
					parsed.data.id,
					parsed.data.name,
					browser.authSessionHash,
					parsed.data.endpoint,
				);
				return device
					? json({ ok: true, device: wireDevice(device) })
					: json({ error: "Push device not found" }, { status: 404 });
			}
			if (request.method === "DELETE") {
				const parsed = await parseRequestBody(request, deletePushDeviceSchema);
				if ("response" in parsed) return parsed.response;
				return json({
					ok: true,
					removed: await dependencies.revokeDevice(
						parsed.data.id,
						browser.authSessionHash,
					),
				});
			}
			return json({ error: "Method not allowed" }, { status: 405 });
		}

		if (url.pathname === "/api/push/test") {
			if (request.method !== "POST") {
				return json({ error: "Method not allowed" }, { status: 405 });
			}
			const parsed = await parseRequestBody(request, pushTestSchema);
			if ("response" in parsed) return parsed.response;
			const owner = await endpointOwner(
				parsed.data.endpoint,
				request,
				dependencies,
			);
			if ("response" in owner) return owner.response;
			const subscription = await dependencies.getSubscription(
				parsed.data.endpoint,
				owner.authSessionHash,
				dependencies.now(),
			);
			if (!subscription) {
				return json({ error: "Push subscription not found" }, { status: 404 });
			}
			const result = await dependencies.testPush(
				subscription,
				parsed.data.scenario ?? "delivery",
			);
			const at = Math.floor(dependencies.now() / 1_000);
			return json({
				accepted: result.accepted,
				accepted_at: result.accepted ? at : null,
				failure_at: result.accepted ? null : at,
				failure_count: result.accepted ? 0 : subscription.failureCount + 1,
				subscription_removed: result.subscriptionRemoved,
			});
		}

		if (url.pathname === "/api/push/session-overrides") {
			if (request.method === "GET") {
				const parsed = pushSessionIdSchema.safeParse(
					url.searchParams.get("session_id"),
				);
				return parsed.success
					? json({
							mode: await dependencies.getSessionOverride(parsed.data),
						})
					: invalidRequest();
			}
			if (request.method === "PATCH") {
				const parsed = await parseRequestBody(
					request,
					updatePushSessionOverrideSchema,
				);
				if ("response" in parsed) return parsed.response;
				const mode = await dependencies.setSessionOverride(
					parsed.data.session_id,
					parsed.data.mode,
				);
				return mode
					? json({ ok: true, mode })
					: json({ error: "Session not found" }, { status: 404 });
			}
			return json({ error: "Method not allowed" }, { status: 405 });
		}

		return null;
	};
}

export const handlePushRoute = createPushRouteHandler();
