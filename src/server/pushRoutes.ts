import {
	cancelPushNotificationOneShotDeliveries,
	deletePushSubscription,
	getEffectivePushSessionPolicy,
	getPushNotificationBatch,
	getPushNotificationEvent,
	getPushSessionPolicy,
	getPushSubscription,
	listPushNotificationBatchMembers,
	listPushNotificationHistory,
	listPushSubscriptionDevices,
	markPushNotificationBatchMemberRead,
	markPushNotificationBatchRead,
	type PushNotificationBatchMember,
	type PushNotificationBatchRecord,
	type PushNotificationEventRecord,
	type PushNotificationHistoryEntry,
	type PushSessionPolicy,
	type PushSubscriptionDevice,
	recordPushNotificationClientReceipt,
	revokePushSubscriptionDevice,
	setPushSessionOverride,
	setPushSessionPolicy,
	updatePushSubscriptionDevice,
	updatePushSubscriptionPreferences,
	upsertPushSubscription,
} from "../db";
import {
	deletePushDeviceSchema,
	listPushDevicesSchema,
	type PushNotificationTestScenario,
	type PushPreferences,
	pushDeliveryReceiptSchema,
	pushEndpointSchema,
	pushNotificationBatchIdSchema,
	pushNotificationBatchReadSchema,
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
	updateDevice: typeof updatePushSubscriptionDevice;
	revokeDevice: typeof revokePushSubscriptionDevice;
	setSessionOverride: typeof setPushSessionOverride;
	getSessionPolicy: typeof getPushSessionPolicy;
	getEffectiveSessionPolicy: typeof getEffectivePushSessionPolicy;
	setSessionPolicy: typeof setPushSessionPolicy;
	cancelOneShotDeliveries: typeof cancelPushNotificationOneShotDeliveries;
	recordClientReceipt: typeof recordPushNotificationClientReceipt;
	listHistory: typeof listPushNotificationHistory;
	getBatch: typeof getPushNotificationBatch;
	listBatchMembers: typeof listPushNotificationBatchMembers;
	getEvent: typeof getPushNotificationEvent;
	markBatchRead: typeof markPushNotificationBatchRead;
	markBatchMemberRead: typeof markPushNotificationBatchMemberRead;
	onDeliveryStateChanged: () => void | Promise<void>;
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
	updateDevice: updatePushSubscriptionDevice,
	revokeDevice: revokePushSubscriptionDevice,
	setSessionOverride: setPushSessionOverride,
	getSessionPolicy: getPushSessionPolicy,
	getEffectiveSessionPolicy: getEffectivePushSessionPolicy,
	setSessionPolicy: setPushSessionPolicy,
	cancelOneShotDeliveries: cancelPushNotificationOneShotDeliveries,
	recordClientReceipt: recordPushNotificationClientReceipt,
	listHistory: listPushNotificationHistory,
	getBatch: getPushNotificationBatch,
	listBatchMembers: listPushNotificationBatchMembers,
	getEvent: getPushNotificationEvent,
	markBatchRead: markPushNotificationBatchRead,
	markBatchMemberRead: markPushNotificationBatchMemberRead,
	onDeliveryStateChanged: () => {},
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

async function ownedSubscription(
	endpoint: string,
	request: Request,
	dependencies: Pick<
		PushRouteDependencies,
		"authSessionHash" | "getSubscription" | "now" | "validateEndpoint"
	>,
): Promise<
	| {
			authSessionHash: string;
			nowMs: number;
			subscription: Awaited<ReturnType<typeof getPushSubscription>>;
	  }
	| { response: Response }
> {
	const owner = await endpointOwner(endpoint, request, dependencies);
	if ("response" in owner) return owner;
	const nowMs = dependencies.now();
	return {
		authSessionHash: owner.authSessionHash,
		nowMs,
		subscription: await dependencies.getSubscription(
			endpoint,
			owner.authSessionHash,
			nowMs,
		),
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
		preferences: wirePreferences(device.preferences),
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
		quiet_hours:
			preferences.quiet_hours === null
				? null
				: { ...preferences.quiet_hours, catch_up: false as const },
		// Cached v1 clients can keep reading their single attention toggle during a
		// rolling PWA/service-worker update. New clients use the split categories.
		needs_attention: preferences.requests || preferences.problems,
		// The immediately previous PWA required these fields. Keep inert,
		// response-only values so an already-open client can survive the server
		// update; new clients discard them and no runtime scheduling reads them.
		catch_up_after_pause: false as const,
		reminder_minutes: 0 as const,
	};
}

function wireSessionPolicy(policy: PushSessionPolicy | null) {
	return policy
		? {
				session_id: policy.sessionId,
				mode: policy.mode,
				scope: policy.scope,
				target_device_ids: policy.targetDeviceIds,
				updated_at: policy.updatedAt,
			}
		: null;
}

function wireEffectiveSessionPolicy(
	policy: Awaited<ReturnType<typeof getEffectivePushSessionPolicy>>,
) {
	return {
		requested_session_id: policy.requestedSessionId,
		source_session_id: policy.sourceSessionId,
		mode: policy.mode,
		scope: policy.scope,
		target_device_ids: policy.targetDeviceIds,
		inherited: policy.inherited,
	};
}

function wireEventSummary(event: PushNotificationEventRecord) {
	return {
		id: event.id,
		source_kind: event.sourceKind,
		source_id: event.sourceId,
		category: event.category,
		reason: event.reason,
		label: event.label,
		url: event.url,
		runtime_ms: event.runtimeMs,
		pending_count: event.pendingCount,
		occurred_at: event.occurredAt,
		expires_at: event.expiresAt,
		group_key: event.groupKey,
		batch_id: event.batchId,
		status: event.status,
		status_reason: event.statusReason,
		next_attempt_at: event.nextAttemptAt,
	};
}

function wireHistoryEvent(event: PushNotificationHistoryEntry) {
	return {
		...wireEventSummary(event),
		deliveries: event.deliveries.map((delivery) => ({
			id: delivery.id,
			device_id: delivery.deviceId,
			device: delivery.deviceSnapshot,
			status: delivery.status,
			reason: delivery.reason,
			next_attempt_at: delivery.nextAttemptAt,
			attempt_count: delivery.attemptCount,
			provider_status: delivery.providerStatus,
			receipt_at: delivery.receiptAt,
			displayed_at: delivery.displayedAt,
			opened_at: delivery.openedAt,
			dismissed_at: delivery.dismissedAt,
			created_at: delivery.createdAt,
			updated_at: delivery.updatedAt,
		})),
	};
}

function wireBatch(batch: PushNotificationBatchRecord) {
	return {
		id: batch.id,
		category: batch.category,
		group_key: batch.groupKey,
		status: batch.status,
		created_at: batch.createdAt,
		updated_at: batch.updatedAt,
		sent_at: batch.sentAt,
		read_at: batch.readAt,
	};
}

function wireBatchMember(
	member: PushNotificationBatchMember,
	event: PushNotificationEventRecord | null,
) {
	return {
		event_id: member.eventId,
		session_id: member.sessionId,
		position: member.position,
		added_at: member.addedAt,
		read_at: member.readAt,
		event: event ? wireEventSummary(event) : null,
	};
}

async function notifyDeliveryStateChanged(
	dependencies: Pick<PushRouteDependencies, "onDeliveryStateChanged">,
): Promise<void> {
	try {
		await dependencies.onDeliveryStateChanged();
	} catch {
		// Durable rows remain recoverable by the dispatcher's normal polling loop.
	}
}

/** Routes run behind Hlid's shared authenticated request policy. */
export function createPushRouteHandler(
	overrides: Partial<PushRouteDependencies> = {},
) {
	const dependencies = { ...defaultDependencies, ...overrides };
	const testPushCooldowns = new Map<string, number>();
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
			const owned = await ownedSubscription(
				parsed.data.endpoint,
				request,
				dependencies,
			);
			if ("response" in owned) return owned.response;
			const { nowMs, subscription } = owned;
			return json({
				available: true,
				subscribed:
					subscription?.enabled === true &&
					(subscription.expirationTime === null ||
						subscription.expirationTime > nowMs),
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
					if (parsed.data.replaces_endpoint) {
						dependencies.validateEndpoint(parsed.data.replaces_endpoint);
					}
				} catch {
					return invalidRequest();
				}
				const browser = await authenticatedBrowser(request, dependencies);
				if ("response" in browser) return browser.response;
				const replacedEndpoint =
					parsed.data.replaces_endpoint !== parsed.data.subscription.endpoint
						? parsed.data.replaces_endpoint
						: undefined;
				const replaced = replacedEndpoint
					? await dependencies.getSubscription(
							replacedEndpoint,
							browser.authSessionHash,
							dependencies.now(),
						)
					: null;
				let subscription: Awaited<ReturnType<typeof upsertPushSubscription>>;
				try {
					subscription = replacedEndpoint
						? await dependencies.upsertSubscription(
								parsed.data.subscription,
								browser.authSessionHash,
								parsed.data.preferences ?? replaced?.preferences,
								parsed.data.device_name ?? replaced?.name,
								replacedEndpoint,
							)
						: await dependencies.upsertSubscription(
								parsed.data.subscription,
								browser.authSessionHash,
								parsed.data.preferences,
								parsed.data.device_name,
							);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (message.includes("to replace was not found")) {
						return json({ error: message }, { status: 404 });
					}
					if (
						message.includes("ambiguous") ||
						message.includes("already registered")
					) {
						return json({ error: message }, { status: 409 });
					}
					return json(
						{ error: "Could not save the Push subscription" },
						{ status: 500 },
					);
				}
				if (replacedEndpoint) {
					await dependencies.deleteSubscription(
						replacedEndpoint,
						browser.authSessionHash,
					);
				}
				await notifyDeliveryStateChanged(dependencies);
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
				if (subscription) {
					await notifyDeliveryStateChanged(dependencies);
					return json({
						ok: true,
						preferences: wirePreferences(subscription.preferences),
					});
				}
				return json({ error: "Push subscription not found" }, { status: 404 });
			}
			if (request.method === "DELETE") {
				const owner = await endpointOwnerFromBody(request, dependencies);
				if ("response" in owner) return owner.response;
				const removed = await dependencies.deleteSubscription(
					owner.endpoint,
					owner.authSessionHash,
				);
				if (removed) await notifyDeliveryStateChanged(dependencies);
				return json({
					ok: true,
					removed,
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
				const device = await dependencies.updateDevice(
					parsed.data.id,
					browser.authSessionHash,
					{
						...(parsed.data.name === undefined
							? {}
							: { name: parsed.data.name }),
						...(parsed.data.preferences === undefined
							? {}
							: { preferences: parsed.data.preferences }),
					},
					parsed.data.endpoint,
				);
				if (!device) {
					return json({ error: "Push device not found" }, { status: 404 });
				}
				if (parsed.data.preferences) {
					await notifyDeliveryStateChanged(dependencies);
				}
				return json({ ok: true, device: wireDevice(device) });
			}
			if (request.method === "DELETE") {
				const parsed = await parseRequestBody(request, deletePushDeviceSchema);
				if ("response" in parsed) return parsed.response;
				const removed = await dependencies.revokeDevice(
					parsed.data.id,
					browser.authSessionHash,
				);
				if (removed) await notifyDeliveryStateChanged(dependencies);
				return json({
					ok: true,
					removed,
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
			const owned = await ownedSubscription(
				parsed.data.endpoint,
				request,
				dependencies,
			);
			if ("response" in owned) return owned.response;
			const { authSessionHash, nowMs, subscription } = owned;
			if (!subscription) {
				return json({ error: "Push subscription not found" }, { status: 404 });
			}
			const cooldownKey = `${authSessionHash}\0${parsed.data.endpoint}`;
			const nextAllowedAt = testPushCooldowns.get(cooldownKey) ?? 0;
			if (nextAllowedAt > nowMs) {
				const retryAfterSeconds = Math.ceil((nextAllowedAt - nowMs) / 1_000);
				return json(
					{
						error: "Test notification cooldown is active",
						retry_after_seconds: retryAfterSeconds,
					},
					{
						status: 429,
						headers: { "retry-after": String(retryAfterSeconds) },
					},
				);
			}
			if (testPushCooldowns.size >= 1_000) {
				for (const [key, expiresAt] of testPushCooldowns) {
					if (expiresAt <= nowMs) testPushCooldowns.delete(key);
				}
				if (testPushCooldowns.size >= 1_000) {
					const oldestKey = testPushCooldowns.keys().next().value;
					if (oldestKey !== undefined) testPushCooldowns.delete(oldestKey);
				}
			}
			testPushCooldowns.set(cooldownKey, nowMs + 10_000);
			const result = await dependencies.testPush(
				subscription,
				parsed.data.scenario ?? "delivery",
			);
			const at = Math.floor(nowMs / 1_000);
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
				if (!parsed.success) return invalidRequest();
				const [policy, effective] = await Promise.all([
					dependencies.getSessionPolicy(parsed.data),
					dependencies.getEffectiveSessionPolicy(parsed.data),
				]);
				return json({
					policy: wireSessionPolicy(policy),
					effective: wireEffectiveSessionPolicy(effective),
				});
			}
			if (request.method === "PATCH") {
				const parsed = await parseRequestBody(
					request,
					updatePushSessionOverrideSchema,
				);
				if ("response" in parsed) return parsed.response;
				let policy: PushSessionPolicy | null;
				if (parsed.data.mode === "default") {
					const mode = await dependencies.setSessionOverride(
						parsed.data.session_id,
						"default",
					);
					if (mode === null) {
						return json({ error: "Session not found" }, { status: 404 });
					}
					policy = null;
				} else {
					policy = await dependencies.setSessionPolicy(parsed.data.session_id, {
						mode: parsed.data.mode,
						...(parsed.data.scope === undefined
							? {}
							: { scope: parsed.data.scope }),
						...(parsed.data.target_device_ids === undefined
							? {}
							: { targetDeviceIds: parsed.data.target_device_ids }),
					});
					if (!policy) {
						return json({ error: "Session not found" }, { status: 404 });
					}
				}
				if (parsed.data.mode === "default" || parsed.data.mode === "mute") {
					await dependencies.cancelOneShotDeliveries(
						parsed.data.session_id,
						dependencies.now(),
					);
				}
				const effective = await dependencies.getEffectiveSessionPolicy(
					parsed.data.session_id,
				);
				await notifyDeliveryStateChanged(dependencies);
				return json({
					ok: true,
					policy: wireSessionPolicy(policy),
					effective: wireEffectiveSessionPolicy(effective),
				});
			}
			return json({ error: "Method not allowed" }, { status: 405 });
		}

		if (url.pathname === "/api/push/receipts") {
			if (request.method !== "POST") {
				return json({ error: "Method not allowed" }, { status: 405 });
			}
			const browser = await authenticatedBrowser(request, dependencies);
			if ("response" in browser) return browser.response;
			const parsed = await parseRequestBody(request, pushDeliveryReceiptSchema);
			if ("response" in parsed) return parsed.response;
			const receipt = await dependencies.recordClientReceipt(
				parsed.data.delivery_id,
				parsed.data.status,
				dependencies.now(),
			);
			return json({ ok: true, recorded: receipt !== null });
		}

		if (url.pathname === "/api/push/history") {
			if (request.method !== "GET") {
				return json({ error: "Method not allowed" }, { status: 405 });
			}
			const browser = await authenticatedBrowser(request, dependencies);
			if ("response" in browser) return browser.response;
			const rawLimit = url.searchParams.get("limit");
			const limit = rawLimit === null ? 20 : Number(rawLimit);
			if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
				return invalidRequest();
			}
			const events = await dependencies.listHistory(limit);
			return json({ events: events.map(wireHistoryEvent) });
		}

		if (url.pathname === "/api/push/batches") {
			const browser = await authenticatedBrowser(request, dependencies);
			if ("response" in browser) return browser.response;
			if (request.method === "GET") {
				const parsed = pushNotificationBatchIdSchema.safeParse(
					url.searchParams.get("batch_id"),
				);
				if (!parsed.success) return invalidRequest();
				const batch = await dependencies.getBatch(parsed.data);
				if (!batch) {
					return json(
						{ error: "Notification batch not found" },
						{ status: 404 },
					);
				}
				const members = [
					...(await dependencies.listBatchMembers(parsed.data)),
				].sort(
					(left, right) =>
						left.position - right.position ||
						left.eventId.localeCompare(right.eventId),
				);
				const events = await Promise.all(
					members.map((member) => dependencies.getEvent(member.eventId)),
				);
				return json({
					batch: wireBatch(batch),
					members: members.map((member, index) =>
						wireBatchMember(member, events[index] ?? null),
					),
				});
			}
			if (request.method === "POST") {
				const parsed = await parseRequestBody(
					request,
					pushNotificationBatchReadSchema,
				);
				if ("response" in parsed) return parsed.response;
				const at = dependencies.now();
				const marked = parsed.data.session_id
					? await dependencies.markBatchMemberRead(
							parsed.data.batch_id,
							parsed.data.session_id,
							at,
						)
					: await dependencies.markBatchRead(parsed.data.batch_id, at);
				return marked
					? json({ ok: true, read_at: at })
					: json({ error: "Notification batch not found" }, { status: 404 });
			}
			return json({ error: "Method not allowed" }, { status: 405 });
		}

		return null;
	};
}
