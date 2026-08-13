import {
	deletePushSubscription,
	getPushSessionOverride,
	getPushSubscription,
	setPushSessionOverride,
	updatePushSubscriptionPreferences,
	upsertPushSubscription,
} from "../db";
import {
	pushEndpointSchema,
	pushSessionIdSchema,
	pushStatusSchema,
	subscribePushSchema,
	updatePushSessionOverrideSchema,
	updatePushSubscriptionSchema,
} from "../lib/pushNotificationSchemas";
import { authenticatedSessionHash } from "./auth";
import {
	loadOrCreateVapidKeys,
	validateBrowserPushSubscription,
	validatePushServiceEndpoint,
} from "./webPush";

type PushRouteDependencies = {
	publicKey: () => string;
	authSessionHash: (request: Request) => Promise<string | null>;
	getSubscription: typeof getPushSubscription;
	upsertSubscription: typeof upsertPushSubscription;
	updatePreferences: typeof updatePushSubscriptionPreferences;
	deleteSubscription: typeof deletePushSubscription;
	getSessionOverride: typeof getPushSessionOverride;
	setSessionOverride: typeof setPushSessionOverride;
	validateSubscription: typeof validateBrowserPushSubscription;
	validateEndpoint: typeof validatePushServiceEndpoint;
};

const defaultDependencies: PushRouteDependencies = {
	publicKey: () => loadOrCreateVapidKeys().publicKey,
	authSessionHash: authenticatedSessionHash,
	getSubscription: getPushSubscription,
	upsertSubscription: upsertPushSubscription,
	updatePreferences: updatePushSubscriptionPreferences,
	deleteSubscription: deletePushSubscription,
	getSessionOverride: getPushSessionOverride,
	setSessionOverride: setPushSessionOverride,
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

function browserSessionRequired(): Response {
	return json(
		{ error: "A signed-in browser session is required" },
		{ status: 403 },
	);
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
	const authSessionHash = await dependencies.authSessionHash(request);
	return authSessionHash
		? { authSessionHash }
		: { response: browserSessionRequired() };
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
			const parsed = pushStatusSchema.safeParse(await body(request));
			if (!parsed.success) return invalidRequest();
			if (!parsed.data.endpoint) {
				return json({ available: true, subscribed: false, preferences: null });
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
			);
			return json({
				available: true,
				subscribed: subscription?.enabled === true,
				preferences: subscription?.preferences ?? null,
			});
		}

		if (url.pathname === "/api/push/subscriptions") {
			if (request.method === "POST") {
				const parsed = subscribePushSchema.safeParse(await body(request));
				if (!parsed.success) return invalidRequest();
				try {
					dependencies.validateSubscription(parsed.data.subscription);
				} catch {
					return invalidRequest();
				}
				const authSessionHash = await dependencies.authSessionHash(request);
				if (!authSessionHash) return browserSessionRequired();
				const subscription = await dependencies.upsertSubscription(
					parsed.data.subscription,
					authSessionHash,
					parsed.data.preferences,
				);
				return json({ ok: true, preferences: subscription.preferences });
			}
			if (request.method === "PATCH") {
				const parsed = updatePushSubscriptionSchema.safeParse(
					await body(request),
				);
				if (!parsed.success) return invalidRequest();
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
					? json({ ok: true, preferences: subscription.preferences })
					: json({ error: "Push subscription not found" }, { status: 404 });
			}
			if (request.method === "DELETE") {
				const parsed = pushEndpointSchema.safeParse(await body(request));
				if (!parsed.success) return invalidRequest();
				const owner = await endpointOwner(
					parsed.data.endpoint,
					request,
					dependencies,
				);
				if ("response" in owner) return owner.response;
				return json({
					ok: true,
					removed: await dependencies.deleteSubscription(
						parsed.data.endpoint,
						owner.authSessionHash,
					),
				});
			}
			return json({ error: "Method not allowed" }, { status: 405 });
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
				const parsed = updatePushSessionOverrideSchema.safeParse(
					await body(request),
				);
				if (!parsed.success) return invalidRequest();
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
