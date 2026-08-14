import { describe, expect, it, vi } from "vitest";
import type {
	EffectivePushSessionPolicy,
	PushNotificationBatchMember,
	PushNotificationBatchRecord,
	PushNotificationDeliveryRecord,
	PushNotificationEventRecord,
	StoredPushSubscription,
} from "../db";
import type { PushPreferences } from "../lib/pushNotificationSchemas";
import {
	deliverPushEventsWithinOutbox,
	type PushDeliveryDependencies,
	type PushEvent,
} from "./pushDelivery";
import { PushNotificationOutbox } from "./pushNotificationOutbox";
import type { WebPushSendResult } from "./webPush";

const NOW = Date.UTC(2026, 7, 13, 12);

function preferences(patch: Partial<PushPreferences> = {}): PushPreferences {
	return {
		requests: true,
		problems: true,
		work_finished: false,
		privacy: "generic",
		completion_min_runtime_minutes: 0,
		paused_until: null,
		paused_indefinitely: false,
		quiet_hours: null,
		...patch,
	};
}

function subscription(selected = preferences()): StoredPushSubscription {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		authSessionHash: "auth",
		endpoint: "https://fcm.googleapis.com/fcm/send/device",
		keys: { p256dh: "public", auth: "auth" },
		expirationTime: null,
		name: "Phone",
		preferences: selected,
		enabled: true,
		createdAt: NOW,
		updatedAt: NOW,
		lastSuccessAt: null,
		lastFailureAt: null,
		failureCount: 0,
	};
}

function event(
	patch: Partial<PushNotificationEventRecord> = {},
): PushNotificationEventRecord {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		sourceKind: "session",
		sourceId: "session-1",
		category: "request",
		reason: "permission",
		label: "Release Hlid",
		url: "/raven?session=session-1&attention=permission",
		runtimeMs: null,
		pendingCount: 1,
		occurredAt: NOW - 1_000,
		expiresAt: NOW + 15 * 60_000,
		groupKey: "session-1",
		batchId: null,
		status: "pending",
		statusReason: null,
		nextAttemptAt: null,
		metadata: { sessionAliases: ["pool-1", "session-1"] },
		dedupeKey: "event-1",
		createdAt: NOW - 1_000,
		updatedAt: NOW - 1_000,
		...patch,
	};
}

function policy(
	patch: Partial<EffectivePushSessionPolicy> = {},
): EffectivePushSessionPolicy {
	return {
		requestedSessionId: "session-1",
		sourceSessionId: null,
		mode: "default",
		scope: "session",
		targetDeviceIds: null,
		inherited: false,
		...patch,
	};
}

function delivery(
	device: StoredPushSubscription,
	status: PushNotificationDeliveryRecord["status"],
	patch: Partial<PushNotificationDeliveryRecord> = {},
): PushNotificationDeliveryRecord {
	return {
		id: "33333333-3333-4333-8333-333333333333",
		eventId: "22222222-2222-4222-8222-222222222222",
		deviceId: device.id,
		deviceSnapshot: {
			id: device.id,
			name: device.name,
			privacy: device.preferences.privacy,
			preferences: device.preferences,
		},
		status,
		reason: null,
		nextAttemptAt: null,
		attemptCount: 0,
		providerStatus: null,
		receiptAt: null,
		displayedAt: null,
		openedAt: null,
		dismissedAt: null,
		createdAt: NOW,
		updatedAt: NOW,
		...patch,
	};
}

function harness(options: {
	event?: PushNotificationEventRecord;
	device?: StoredPushSubscription;
	liveDevice?: StoredPushSubscription | null;
	existingDelivery?: PushNotificationDeliveryRecord;
	policy?: EffectivePushSessionPolicy;
	result?: WebPushSendResult;
	preserveSentHistory?: boolean;
}) {
	const selectedEvent = options.event ?? event();
	const selectedDevice = options.device ?? subscription();
	const selectedPolicy = options.policy ?? policy();
	const liveDevice = Object.hasOwn(options, "liveDevice")
		? (options.liveDevice ?? null)
		: selectedDevice;
	const deliveryResult: WebPushSendResult = options.result ?? {
		outcome: "delivered",
		statusCode: 201,
	};
	const rows = new Map<string, PushNotificationDeliveryRecord>();
	if (options.existingDelivery) {
		rows.set(options.existingDelivery.deviceId, options.existingDelivery);
	}
	const recordDecision = vi.fn(
		async (input: {
			device: {
				id: string;
				name: string;
				privacy: PushPreferences["privacy"];
				preferences?: PushPreferences;
				oneShot?: PushNotificationDeliveryRecord["deviceSnapshot"]["oneShot"];
			};
			status: string;
			reason?: string;
			nextAttemptAt?: number | null;
		}) => {
			const current = rows.get(input.device.id);
			const row = {
				...(current ??
					delivery(
						selectedDevice,
						input.status as PushNotificationDeliveryRecord["status"],
					)),
				deviceSnapshot: {
					id: input.device.id,
					name: input.device.name,
					privacy: input.device.privacy,
					...(input.device.preferences
						? { preferences: input.device.preferences }
						: {}),
					...(input.device.oneShot ? { oneShot: input.device.oneShot } : {}),
				},
				status:
					options.preserveSentHistory && current?.status === "sent"
						? "sent"
						: (input.status as PushNotificationDeliveryRecord["status"]),
				reason: input.reason ?? null,
				nextAttemptAt: input.nextAttemptAt ?? null,
			};
			rows.set(input.device.id, row);
			return row;
		},
	);
	const recordReceipt = vi.fn(
		async (input: {
			status: "sent" | "failed" | "gone" | "expired";
			reason?: string;
			nextAttemptAt?: number | null;
			providerStatus?: number | null;
		}) => {
			const current = rows.get(selectedDevice.id);
			if (!current) return null;
			const next = {
				...current,
				status: input.status,
				reason: input.reason ?? null,
				nextAttemptAt: input.nextAttemptAt ?? null,
				providerStatus: input.providerStatus ?? null,
			};
			rows.set(selectedDevice.id, next);
			return next;
		},
	);
	const updateEvent = vi.fn(async () => selectedEvent);
	const recordAttempt = vi.fn(async () => null);
	const clearOneShot = vi.fn(async () => true);
	const reconcileOneShots = vi.fn(async () => 0);
	const deliver = vi.fn(
		async (
			events: PushEvent[],
			overrides: {
				onAttempt?: (
					device: StoredPushSubscription,
					events: PushEvent[],
					result: WebPushSendResult,
					context: { attempt: number; attemptedAt: number },
				) => Promise<void> | void;
				onResult?: (
					device: StoredPushSubscription,
					events: PushEvent[],
					result: WebPushSendResult,
				) => Promise<void> | void;
			},
		) => {
			const providerDevice = liveDevice ?? selectedDevice;
			await overrides.onAttempt?.(providerDevice, events, deliveryResult, {
				attempt: 1,
				attemptedAt: NOW,
			});
			await overrides.onResult?.(providerDevice, events, deliveryResult);
			return {
				subscriptions: 1,
				attempted: 1,
				delivered: deliveryResult.outcome === "delivered" ? 1 : 0,
				failed: deliveryResult.outcome === "failed" ? 1 : 0,
				disabled: deliveryResult.outcome === "gone" ? 1 : 0,
				suppressed: 0,
			};
		},
	);
	const listEvents = vi
		.fn()
		.mockResolvedValueOnce([selectedEvent])
		.mockResolvedValue([]);
	const outbox = new PushNotificationOutbox({
		now: () => NOW,
		listEvents,
		listPendingDeliveries: vi.fn(async () => []),
		listSubscriptions: vi
			.fn()
			.mockResolvedValueOnce([selectedDevice])
			.mockImplementation(async () => (liveDevice ? [liveDevice] : [])),
		listDeliveries: vi.fn(async () => Array.from(rows.values())),
		getPolicy: vi.fn(async () => selectedPolicy),
		updateEvent,
		recordDecision: recordDecision as never,
		recordAttempt: recordAttempt as never,
		recordReceipt: recordReceipt as never,
		clearOneShot: clearOneShot as never,
		reconcileOneShots,
		deliver: deliver as never,
		visibleUntil: () => null,
		isRelevant: () => true,
	});
	return {
		outbox,
		selectedDevice,
		rows,
		recordDecision,
		recordReceipt,
		updateEvent,
		deliver,
		recordAttempt,
		clearOneShot,
		reconcileOneShots,
	};
}

function namedSubscription(
	id: string,
	name: string,
	selected = preferences(),
): StoredPushSubscription {
	return {
		...subscription(selected),
		id,
		name,
		endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
	};
}

function batch(
	patch: Partial<PushNotificationBatchRecord> = {},
): PushNotificationBatchRecord {
	return {
		id: "44444444-4444-4444-8444-444444444444",
		category: "completion",
		groupKey: "session-completions",
		status: "ready",
		createdAt: NOW - 1_000,
		updatedAt: NOW - 1_000,
		sentAt: null,
		readAt: null,
		...patch,
	};
}

function batchMember(
	eventRow: PushNotificationEventRecord,
	batchId: string,
	position: number,
): PushNotificationBatchMember {
	return {
		batchId,
		eventId: eventRow.id,
		sessionId: eventRow.sourceId,
		position,
		addedAt: NOW - 1_000,
		readAt: null,
	};
}

function timerHandle(): ReturnType<typeof setTimeout> {
	return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("PushNotificationOutbox", () => {
	it("journals a device decision before delivery and records acceptance", async () => {
		const test = harness({});
		test.outbox.start();
		await vi.waitFor(() => expect(test.deliver).toHaveBeenCalledOnce());
		test.outbox.close();

		expect(test.recordDecision).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending", reason: "eligible" }),
		);
		expect(test.deliver.mock.calls[0]?.[0][0]).toMatchObject({
			deliveryId: "33333333-3333-4333-8333-333333333333",
			sessionId: "session-1",
		});
		expect(test.recordReceipt).toHaveBeenCalledWith(
			expect.objectContaining({ status: "sent", providerStatus: 201 }),
		);
		expect(test.recordAttempt).toHaveBeenCalledWith({
			deliveryId: "33333333-3333-4333-8333-333333333333",
			attemptedAt: NOW,
			outcome: "delivered",
			providerStatus: 201,
			retryAfterMs: null,
			reasonCode: "provider_accepted",
		});
		expect(test.updateEvent).toHaveBeenLastCalledWith(
			"22222222-2222-4222-8222-222222222222",
			expect.objectContaining({ status: "processed" }),
		);
	});

	it("consumes Notify once after accepted delivery", async () => {
		const test = harness({
			device: subscription(preferences({ requests: false })),
			policy: policy({
				sourceSessionId: "session-1",
				mode: "notify_once",
			}),
		});
		test.outbox.start();
		await vi.waitFor(() => expect(test.recordReceipt).toHaveBeenCalled());
		test.outbox.close();

		expect(test.recordReceipt).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "sent",
				reason: "accepted",
				nextAttemptAt: null,
				oneShot: { sourceSessionId: "session-1", mode: "notify_once" },
			}),
		);
		expect(test.clearOneShot).toHaveBeenCalledWith("session-1", "notify_once");
	});

	it("suppresses quiet-hour alerts without contacting the provider", async () => {
		const test = harness({
			device: subscription(
				preferences({
					quiet_hours: {
						timezone: "UTC",
						start: "11:00",
						end: "13:00",
						weekdays: [4],
						allow_requests: false,
						allow_problems: false,
					},
				}),
			),
		});
		test.outbox.start();
		await vi.waitFor(() =>
			expect(test.recordDecision).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "suppressed",
					reason: "quiet_hours",
				}),
			),
		);
		test.outbox.close();
		expect(test.deliver).not.toHaveBeenCalled();
		expect(test.updateEvent).toHaveBeenLastCalledWith(
			"22222222-2222-4222-8222-222222222222",
			expect.objectContaining({ status: "processed" }),
		);
	});

	it("fails closed when an exact target no longer exists", async () => {
		const test = harness({
			policy: policy({
				sourceSessionId: "session-1",
				mode: "notify",
				targetDeviceIds: ["99999999-9999-4999-8999-999999999999"],
			}),
		});
		test.outbox.start();
		await vi.waitFor(() =>
			expect(test.recordDecision).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "suppressed",
					reason: "device_target",
				}),
			),
		);
		test.outbox.close();
		expect(test.deliver).not.toHaveBeenCalled();
	});

	it.each([
		{ statusCode: 400, retryAfterMs: undefined, nextAttemptAt: null },
		{ statusCode: 429, retryAfterMs: 120_000, nextAttemptAt: NOW + 120_000 },
	] as const)("only schedules an outer retry for transient provider status $statusCode", async ({
		statusCode,
		retryAfterMs,
		nextAttemptAt,
	}) => {
		const test = harness({
			result: {
				outcome: "failed",
				statusCode,
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			},
		});
		test.outbox.start();
		await vi.waitFor(() =>
			expect(test.recordReceipt).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "failed",
					providerStatus: statusCode,
					nextAttemptAt,
				}),
			),
		);
		test.outbox.close();
	});

	it("requeues a stable device when its endpoint rotates during a gone send", async () => {
		const selectedEvent = event({ expiresAt: NOW + 24 * 60 * 60_000 });
		const original = subscription();
		const rotated = {
			...original,
			endpoint: "https://fcm.googleapis.com/fcm/send/rotated-after-send",
			keys: { p256dh: "rotated-public", auth: "rotated-auth" },
			updatedAt: NOW + 1,
		};
		let liveDevice = original;
		let row: PushNotificationDeliveryRecord | undefined;
		const recordDecision = vi.fn(
			async (input: {
				device: PushNotificationDeliveryRecord["deviceSnapshot"];
				status: PushNotificationDeliveryRecord["status"];
				reason?: string | null;
				nextAttemptAt?: number | null;
			}) => {
				row = delivery(original, input.status, {
					...(row ?? {}),
					deviceSnapshot: input.device,
					status: input.status,
					reason: input.reason ?? null,
					nextAttemptAt: input.nextAttemptAt ?? null,
				});
				return row;
			},
		);
		const recordReceipt = vi.fn(async () => row ?? null);
		const send = vi.fn<PushDeliveryDependencies["send"]>(async (device) => {
			expect(device.endpoint).toBe(original.endpoint);
			liveDevice = rotated;
			return { outcome: "gone", statusCode: 410 };
		});
		const deliver = vi.fn(
			(events: PushEvent[], overrides: Partial<PushDeliveryDependencies>) =>
				deliverPushEventsWithinOutbox(events, {
					...overrides,
					disableExpired: async () => 0,
					loadVapidKeys: () => ({ publicKey: "public", privateKey: "private" }),
					send,
					recordSuccess: async () => {},
					recordFailure: async () => {},
					sleep: async () => {},
				}),
		);
		const outbox = new PushNotificationOutbox({
			now: () => NOW,
			listEvents: vi
				.fn()
				.mockResolvedValueOnce([selectedEvent])
				.mockResolvedValue([]),
			listPendingDeliveries: vi.fn(async () => []),
			reconcileOneShots: vi.fn(async () => 0),
			listSubscriptions: vi.fn(async () => [liveDevice]),
			listDeliveries: vi.fn(async () => (row ? [row] : [])),
			getPolicy: vi.fn(async () =>
				policy({ sourceSessionId: selectedEvent.sourceId, mode: "notify" }),
			),
			updateEvent: vi.fn(async () => selectedEvent),
			recordDecision: recordDecision as never,
			recordAttempt: vi.fn(async () => null) as never,
			recordReceipt: recordReceipt as never,
			deliver: deliver as never,
			visibleUntil: () => null,
			isRelevant: () => true,
			schedule: vi.fn(() => timerHandle()) as never,
			cancel: vi.fn(),
		});

		outbox.start();
		await vi.waitFor(() =>
			expect(recordDecision).toHaveBeenCalledWith(
				expect.objectContaining({
					device: expect.objectContaining({ id: original.id }),
					status: "pending",
					reason: "endpoint_rotated",
					nextAttemptAt: NOW,
				}),
			),
		);
		outbox.close();
		expect(send).toHaveBeenCalledOnce();
		expect(row).toMatchObject({
			status: "pending",
			reason: "endpoint_rotated",
			nextAttemptAt: NOW,
			deviceSnapshot: {
				id: original.id,
				preferences: rotated.preferences,
			},
		});
		expect(recordReceipt).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "gone" }),
		);
	});

	it("honors an atomic Default cancellation at locked revalidation", async () => {
		const selectedEvent = event({ expiresAt: NOW + 24 * 60 * 60_000 });
		const selectedDevice = subscription(preferences({ requests: false }));
		let row = delivery(selectedDevice, "queued", {
			nextAttemptAt: NOW,
			deviceSnapshot: {
				id: selectedDevice.id,
				name: selectedDevice.name,
				privacy: selectedDevice.preferences.privacy,
				preferences: selectedDevice.preferences,
				oneShot: {
					sourceSessionId: selectedEvent.sourceId,
					mode: "notify_once",
					policyUpdatedAt: 41,
				},
			},
		});
		let decisionCalls = 0;
		const recordDecision = vi.fn(
			async (input: {
				device: PushNotificationDeliveryRecord["deviceSnapshot"];
				status: PushNotificationDeliveryRecord["status"];
				reason?: string | null;
				nextAttemptAt?: number | null;
			}) => {
				decisionCalls += 1;
				row = {
					...row,
					deviceSnapshot: input.device,
					status: decisionCalls >= 3 ? "suppressed" : input.status,
					reason:
						decisionCalls >= 3 ? "one_shot_cancelled" : (input.reason ?? null),
					nextAttemptAt:
						decisionCalls >= 3 ? null : (input.nextAttemptAt ?? null),
				};
				return row;
			},
		);
		const send = vi.fn<PushDeliveryDependencies["send"]>(async () => ({
			outcome: "delivered",
			statusCode: 201,
		}));
		const deliver = vi.fn(
			(events: PushEvent[], overrides: Partial<PushDeliveryDependencies>) =>
				deliverPushEventsWithinOutbox(events, {
					...overrides,
					disableExpired: async () => 0,
					loadVapidKeys: () => ({ publicKey: "public", privateKey: "private" }),
					send,
					recordSuccess: async () => {},
					recordFailure: async () => {},
					sleep: async () => {},
				}),
		);
		const outbox = new PushNotificationOutbox({
			now: () => NOW,
			listEvents: vi
				.fn()
				.mockResolvedValueOnce([selectedEvent])
				.mockResolvedValue([]),
			listPendingDeliveries: vi.fn(async () => []),
			reconcileOneShots: vi.fn(async () => 0),
			listSubscriptions: vi.fn(async () => [selectedDevice]),
			listDeliveries: vi.fn(async () => [row]),
			getPolicy: vi.fn(async () => policy()),
			updateEvent: vi.fn(async () => selectedEvent),
			recordDecision: recordDecision as never,
			deliver: deliver as never,
			visibleUntil: () => null,
			isRelevant: () => true,
			schedule: vi.fn(() => timerHandle()) as never,
			cancel: vi.fn(),
		});

		outbox.start();
		await vi.waitFor(() => expect(decisionCalls).toBe(3));
		outbox.close();
		expect(send).not.toHaveBeenCalled();
		expect(row).toMatchObject({
			status: "suppressed",
			reason: "one_shot_cancelled",
			nextAttemptAt: null,
		});
	});

	it("does not send when Default wins before the first device decision", async () => {
		const selectedEvent = event({ expiresAt: NOW + 24 * 60 * 60_000 });
		const selectedDevice = subscription(preferences({ requests: false }));
		const recordDecision = vi.fn(async () =>
			delivery(selectedDevice, "suppressed", {
				deviceSnapshot: {
					id: selectedDevice.id,
					name: selectedDevice.name,
					privacy: selectedDevice.preferences.privacy,
					preferences: selectedDevice.preferences,
					oneShot: {
						sourceSessionId: selectedEvent.sourceId,
						mode: "notify_once",
						policyUpdatedAt: 41,
					},
				},
				reason: "one_shot_cancelled",
				nextAttemptAt: null,
			}),
		);
		const deliver = vi.fn();
		const outbox = new PushNotificationOutbox({
			now: () => NOW,
			listEvents: vi
				.fn()
				.mockResolvedValueOnce([selectedEvent])
				.mockResolvedValue([]),
			listPendingDeliveries: vi.fn(async () => []),
			reconcileOneShots: vi.fn(async () => 0),
			listSubscriptions: vi.fn(async () => [selectedDevice]),
			listDeliveries: vi.fn(async () => []),
			getPolicy: vi.fn(async () =>
				policy({
					sourceSessionId: selectedEvent.sourceId,
					sourceUpdatedAt: 41,
					mode: "notify_once",
				}),
			),
			updateEvent: vi.fn(async () => selectedEvent),
			recordDecision: recordDecision as never,
			deliver: deliver as never,
			visibleUntil: () => null,
			isRelevant: () => true,
			schedule: vi.fn(() => timerHandle()) as never,
			cancel: vi.fn(),
		});

		outbox.start();
		await vi.waitFor(() => expect(recordDecision).toHaveBeenCalledOnce());
		outbox.close();
		expect(deliver).not.toHaveBeenCalled();
	});
});

describe("PushNotificationOutbox scheduling regressions", () => {
	it("runs another drain when wake is requested during an active drain", async () => {
		const firstDrain = deferred<PushNotificationEventRecord[]>();
		const listEvents = vi
			.fn()
			.mockImplementationOnce(() => firstDrain.promise)
			.mockResolvedValue([]);
		const outbox = new PushNotificationOutbox({
			now: () => NOW,
			listEvents,
			listPendingDeliveries: vi.fn(async () => []),
			reconcileOneShots: vi.fn(async () => 0),
			schedule: vi.fn(() => timerHandle()) as never,
			cancel: vi.fn(),
		});

		outbox.start();
		await vi.waitFor(() => expect(listEvents).toHaveBeenCalledOnce());
		outbox.wake();
		firstDrain.resolve([]);
		await vi.waitFor(() => expect(listEvents).toHaveBeenCalledTimes(2));
		outbox.close();
	});

	it("retains later wake times after the earliest timer fires", async () => {
		let now = NOW;
		type Scheduled = {
			callback: () => void;
			delay: number;
			handle: ReturnType<typeof setTimeout>;
			cancelled: boolean;
		};
		const scheduled: Scheduled[] = [];
		const schedule = vi.fn((callback: () => void, delay = 0) => {
			const handle = timerHandle();
			scheduled.push({ callback, delay, handle, cancelled: false });
			return handle;
		});
		const cancel = vi.fn((handle: ReturnType<typeof setTimeout>) => {
			const timer = scheduled.find((candidate) => candidate.handle === handle);
			if (timer) timer.cancelled = true;
		});
		const first = event({
			id: "22222222-2222-4222-8222-222222222221",
			sourceId: "session-early",
			metadata: { sessionAliases: ["session-early"] },
		});
		const second = event({
			id: "22222222-2222-4222-8222-222222222223",
			sourceId: "session-later",
			metadata: { sessionAliases: ["session-later"] },
		});
		const listEvents = vi
			.fn()
			.mockResolvedValueOnce([first, second])
			.mockResolvedValue([]);
		const updateEvent = vi.fn(async () => first);
		const outbox = new PushNotificationOutbox({
			now: () => now,
			listEvents,
			listPendingDeliveries: vi.fn(async () => []),
			reconcileOneShots: vi.fn(async () => 0),
			updateEvent,
			visibleUntil: (aliases) =>
				aliases.includes("session-early") ? NOW + 1_000 : NOW + 2_000,
			schedule: schedule as never,
			cancel: cancel as never,
		});

		outbox.start();
		await vi.waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(2));
		const earliest = scheduled.find(
			(timer) => !timer.cancelled && timer.delay === 1_020,
		);
		expect(earliest).toBeDefined();

		now = NOW + 1_020;
		if (!earliest) throw new Error("Earliest wake was not scheduled");
		earliest.cancelled = true;
		earliest.callback();
		await vi.waitFor(() => expect(listEvents).toHaveBeenCalledTimes(2));
		expect(
			scheduled.some(
				(timer) =>
					timer !== earliest && !timer.cancelled && timer.delay === 1_000,
			),
		).toBe(true);
		outbox.close();
	});
});

function oneShotFanoutHarness() {
	let now = NOW;
	const immediate = namedSubscription(
		"11111111-1111-4111-8111-111111111111",
		"Phone",
		preferences({ requests: false }),
	);
	const quiet = namedSubscription(
		"11111111-1111-4111-8111-222222222222",
		"Tablet",
		preferences({
			requests: false,
			quiet_hours: {
				timezone: "UTC",
				start: "11:00",
				end: "13:00",
				weekdays: [4],
				allow_requests: false,
				allow_problems: false,
			},
		}),
	);
	let selectedEvents = [event({ expiresAt: NOW + 24 * 60 * 60_000 })];
	let selectedPolicy = policy({
		sourceSessionId: "session-1",
		mode: "notify_once",
	});
	const rows = new Map<string, PushNotificationDeliveryRecord>();
	const rowKey = (eventId: string, deviceId: string) =>
		`${eventId}:${deviceId}`;
	const recordDecision = vi.fn(
		async (input: {
			eventId: string;
			device: PushNotificationDeliveryRecord["deviceSnapshot"];
			status: "pending" | "queued" | "suppressed";
			reason?: string | null;
			nextAttemptAt?: number | null;
		}) => {
			const selectedDevice = [immediate, quiet].find(
				(device) => device.id === input.device.id,
			);
			if (!selectedDevice) throw new Error("Unknown one-shot test device");
			const key = rowKey(input.eventId, selectedDevice.id);
			const previous = rows.get(key);
			const row = delivery(selectedDevice, input.status, {
				...(previous ?? {}),
				id: previous?.id ?? `${input.eventId}:${selectedDevice.id}:delivery`,
				eventId: input.eventId,
				deviceId: selectedDevice.id,
				deviceSnapshot: { ...input.device },
				status: previous?.status === "sent" ? "sent" : input.status,
				reason: input.reason ?? null,
				nextAttemptAt: input.nextAttemptAt ?? null,
			});
			rows.set(key, row);
			return row;
		},
	);
	const recordReceipt = vi.fn(
		async (input: {
			eventId: string;
			deviceId: string;
			status: "sent" | "failed" | "gone" | "expired";
			reason?: string | null;
			nextAttemptAt?: number | null;
			providerStatus?: number | null;
		}) => {
			const key = rowKey(input.eventId, input.deviceId);
			const previous = rows.get(key);
			if (!previous) return null;
			const next = {
				...previous,
				status: input.status,
				reason: input.reason ?? null,
				nextAttemptAt: input.nextAttemptAt ?? null,
				providerStatus: input.providerStatus ?? null,
				attemptCount: previous.attemptCount + 1,
				receiptAt: now,
			};
			rows.set(key, next);
			return next;
		},
	);
	const updateEvent = vi.fn(
		async (
			eventId: string,
			patch: {
				status: PushNotificationEventRecord["status"];
				reason?: string | null;
				nextAttemptAt?: number | null;
			},
		) => {
			const selected = selectedEvents.find(
				(candidate) => candidate.id === eventId,
			);
			if (!selected) return null;
			selected.status = patch.status;
			selected.statusReason = patch.reason ?? null;
			selected.nextAttemptAt = patch.nextAttemptAt ?? null;
			return selected;
		},
	);
	const providerDevices: string[] = [];
	const send = vi.fn<PushDeliveryDependencies["send"]>(async (device) => {
		providerDevices.push(device.id);
		return { outcome: "delivered", statusCode: 201 };
	});
	const deliver = vi.fn(
		(events: PushEvent[], overrides: Partial<PushDeliveryDependencies>) =>
			deliverPushEventsWithinOutbox(events, {
				...overrides,
				disableExpired: async () => 0,
				loadVapidKeys: () => ({ publicKey: "public", privateKey: "private" }),
				send,
				recordSuccess: async () => {},
				recordFailure: async () => {},
				sleep: async () => {},
			}),
	);
	const clearOneShot = vi.fn(async () => {
		selectedPolicy = policy();
		return true;
	});
	const reconcileOneShots = vi.fn(async () => 0);
	const outbox = new PushNotificationOutbox({
		now: () => now,
		listEvents: vi.fn(async () => selectedEvents),
		listPendingDeliveries: vi.fn(async () => []),
		reconcileOneShots,
		listSubscriptions: vi.fn(async () => [immediate, quiet]),
		listDeliveries: vi.fn(async (eventId: string) =>
			Array.from(rows.values()).filter((row) => row.eventId === eventId),
		),
		getPolicy: vi.fn(async () => selectedPolicy),
		updateEvent: updateEvent as never,
		recordDecision: recordDecision as never,
		recordAttempt: vi.fn(async () => null) as never,
		recordReceipt: recordReceipt as never,
		clearOneShot: clearOneShot as never,
		deliver: deliver as never,
		visibleUntil: () => null,
		isRelevant: () => true,
		schedule: vi.fn(() => timerHandle()) as never,
		cancel: vi.fn(),
	});
	return {
		outbox,
		immediate,
		quiet,
		rows,
		recordDecision,
		recordReceipt,
		clearOneShot,
		reconcileOneShots,
		send,
		providerDevices,
		setNow(value: number) {
			now = value;
		},
		setPolicy(value: EffectivePushSessionPolicy) {
			selectedPolicy = value;
		},
		setEvents(value: PushNotificationEventRecord[]) {
			selectedEvents = value;
		},
	};
}

describe("PushNotificationOutbox durable one-shot fanout", () => {
	it("delivers an immediate target without reviving a quiet-hour suppression", async () => {
		const test = oneShotFanoutHarness();
		test.outbox.start();
		await vi.waitFor(() => expect(test.send).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(test.reconcileOneShots).toHaveBeenCalledTimes(1),
		);
		expect(test.providerDevices).toEqual([test.immediate.id]);
		expect(test.clearOneShot).toHaveBeenCalledOnce();
		expect(test.rows.get(`${event().id}:${test.quiet.id}`)).toMatchObject({
			status: "suppressed",
			deviceSnapshot: {
				oneShot: { sourceSessionId: "session-1", mode: "notify_once" },
			},
		});

		test.setNow(NOW + 2 * 60 * 60_000);
		test.outbox.wake();
		await vi.waitFor(() =>
			expect(test.reconcileOneShots).toHaveBeenCalledTimes(2),
		);
		expect(test.send).toHaveBeenCalledOnce();
		expect(test.providerDevices).toEqual([test.immediate.id]);

		const unrelated = event({
			id: "22222222-2222-4222-8222-999999999999",
			dedupeKey: "unrelated",
			occurredAt: NOW + 2 * 60 * 60_000,
			expiresAt: NOW + 24 * 60 * 60_000,
		});
		test.setEvents([unrelated]);
		test.outbox.wake();
		await vi.waitFor(() =>
			expect(test.recordDecision).toHaveBeenCalledWith(
				expect.objectContaining({
					eventId: unrelated.id,
					status: "suppressed",
					reason: "preference",
				}),
			),
		);
		test.outbox.close();
		expect(test.send).toHaveBeenCalledOnce();
	});
});

async function runSlowDeliveryRevalidation(
	change: (controls: {
		setNow: (value: number) => void;
		setRelevant: (value: boolean) => void;
		setVisibleUntil: (value: number | null) => void;
		revokeTarget: () => void;
		updateTarget: (patch: Partial<StoredPushSubscription>) => void;
		event: PushNotificationEventRecord;
	}) => void,
) {
	let now = NOW;
	let relevant = true;
	let visibleUntil: number | null = null;
	const selectedEvent = event({ expiresAt: NOW + 10_000 });
	const devices = Array.from({ length: 9 }, (_, index) =>
		namedSubscription(
			`11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
			index === 8 ? "Tablet" : `Device ${index + 1}`,
		),
	);
	const firstDevice = devices[0] as StoredPushSubscription;
	const secondDevice = devices[8] as StoredPushSubscription;
	let liveDevices = devices;
	const rows = new Map<string, PushNotificationDeliveryRecord>();
	const recordDecision = vi.fn(
		async (input: {
			eventId: string;
			device: { id: string; name: string; preferences?: PushPreferences };
			status: "pending" | "suppressed" | "queued";
			reason?: string | null;
			nextAttemptAt?: number | null;
		}) => {
			const selectedDevice = devices.find(
				(device) => device.id === input.device.id,
			);
			if (!selectedDevice) throw new Error("Unknown delivery test device");
			const previous = rows.get(input.device.id);
			const row = delivery(selectedDevice, input.status, {
				id: `${input.device.id}:delivery`,
				eventId: input.eventId,
				reason: input.reason ?? null,
				nextAttemptAt: input.nextAttemptAt ?? null,
				attemptCount: previous?.attemptCount ?? 0,
			});
			rows.set(input.device.id, row);
			return row;
		},
	);
	const recordReceipt = vi.fn(
		async (input: {
			eventId: string;
			deviceId: string;
			status: "sent" | "failed" | "gone" | "expired";
			reason?: string | null;
			nextAttemptAt?: number | null;
			providerStatus?: number | null;
		}) => {
			const previous = rows.get(input.deviceId);
			if (!previous) return null;
			const next = {
				...previous,
				status: input.status,
				reason: input.reason ?? null,
				nextAttemptAt: input.nextAttemptAt ?? null,
				providerStatus: input.providerStatus ?? null,
				attemptCount: previous.attemptCount + 1,
			};
			rows.set(input.deviceId, next);
			return next;
		},
	);
	const providerGate = deferred<void>();
	const providerStarted = deferred<void>();
	let providerCalls = 0;
	const providerDevices: StoredPushSubscription[] = [];
	const deliver = vi.fn(
		async (
			events: PushEvent[],
			overrides: {
				listSubscriptions?: () => Promise<StoredPushSubscription[]>;
				onResult?: (
					device: StoredPushSubscription,
					events: PushEvent[],
					result: { outcome: "delivered"; statusCode: number },
				) => Promise<void> | void;
			},
		) => {
			const callNumber = ++providerCalls;
			const device = (await overrides.listSubscriptions?.())?.[0];
			if (!device) throw new Error("Delivery test did not receive a device");
			providerDevices.push(device);
			if (callNumber <= 8) {
				if (callNumber === 8) providerStarted.resolve();
				await providerGate.promise;
			}
			await overrides.onResult?.(device, events, {
				outcome: "delivered",
				statusCode: 201,
			});
			return {
				subscriptions: 1,
				attempted: 1,
				delivered: 1,
				failed: 0,
				disabled: 0,
				suppressed: 0,
			};
		},
	);
	const updateEvent = vi.fn(async () => selectedEvent);
	const outbox = new PushNotificationOutbox({
		now: () => now,
		listEvents: vi
			.fn()
			.mockResolvedValueOnce([selectedEvent])
			.mockResolvedValue([]),
		listPendingDeliveries: vi.fn(async () => []),
		reconcileOneShots: vi.fn(async () => 0),
		listSubscriptions: vi.fn(async () => liveDevices),
		listDeliveries: vi.fn(async () => Array.from(rows.values())),
		getPolicy: vi.fn(async () => policy()),
		updateEvent,
		recordDecision: recordDecision as never,
		recordReceipt: recordReceipt as never,
		deliver: deliver as never,
		visibleUntil: () => visibleUntil,
		isRelevant: () => relevant,
		schedule: vi.fn(() => timerHandle()) as never,
		cancel: vi.fn(),
	});

	outbox.start();
	await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
	await providerStarted.promise;
	change({
		setNow: (value) => {
			now = value;
		},
		setRelevant: (value) => {
			relevant = value;
		},
		setVisibleUntil: (value) => {
			visibleUntil = value;
		},
		revokeTarget: () => {
			liveDevices = liveDevices.filter(
				(device) => device.id !== secondDevice.id,
			);
		},
		updateTarget: (patch) => {
			liveDevices = liveDevices.map((device) =>
				device.id === secondDevice.id ? { ...device, ...patch } : device,
			);
		},
		event: selectedEvent,
	});
	providerGate.resolve();
	return {
		outbox,
		event: selectedEvent,
		firstDevice,
		secondDevice,
		deliver,
		recordDecision,
		recordReceipt,
		updateEvent,
		providerDevices,
	};
}

describe("PushNotificationOutbox per-device revalidation", () => {
	it("rechecks relevance after a slow delivery before contacting another device", async () => {
		const test = await runSlowDeliveryRevalidation(({ setRelevant }) => {
			setRelevant(false);
		});
		await vi.waitFor(() =>
			expect(test.updateEvent).toHaveBeenCalledWith(
				test.event.id,
				expect.objectContaining({
					status: "cancelled",
					reason: "state_resolved",
				}),
			),
		);
		test.outbox.close();
		expect(test.deliver).toHaveBeenCalledTimes(8);
	});

	it("rechecks expiry after a slow delivery before contacting another device", async () => {
		const test = await runSlowDeliveryRevalidation(({ setNow, event }) => {
			setNow(event.expiresAt);
		});
		await vi.waitFor(() =>
			expect(test.recordReceipt).toHaveBeenCalledWith(
				expect.objectContaining({
					deviceId: test.secondDevice.id,
					status: "expired",
					reason: "event_expired",
				}),
			),
		);
		test.outbox.close();
		expect(test.deliver).toHaveBeenCalledTimes(8);
	});

	it("rechecks visibility after a slow delivery before contacting another device", async () => {
		const test = await runSlowDeliveryRevalidation(
			({ setNow, setVisibleUntil }) => {
				setNow(NOW + 1_000);
				setVisibleUntil(NOW + 60_000);
			},
		);
		await vi.waitFor(() =>
			expect(test.recordDecision).toHaveBeenCalledWith(
				expect.objectContaining({
					device: expect.objectContaining({ id: test.secondDevice.id }),
					status: "queued",
					reason: "visible",
				}),
			),
		);
		test.outbox.close();
		expect(test.deliver).toHaveBeenCalledTimes(8);
	});

	it("marks a device revoked while all worker slots are busy unavailable", async () => {
		const test = await runSlowDeliveryRevalidation(({ revokeTarget }) => {
			revokeTarget();
		});
		await vi.waitFor(() =>
			expect(test.recordReceipt).toHaveBeenCalledWith(
				expect.objectContaining({
					deviceId: test.secondDevice.id,
					status: "expired",
					reason: "device_unavailable",
				}),
			),
		);
		test.outbox.close();
		expect(test.deliver).toHaveBeenCalledTimes(8);
	});

	it("uses privacy changed while all worker slots are busy", async () => {
		const detailedPreferences = preferences({ privacy: "detailed" });
		const test = await runSlowDeliveryRevalidation(({ updateTarget }) => {
			updateTarget({
				endpoint: "https://fcm.googleapis.com/fcm/send/rotated-target",
				keys: { p256dh: "rotated-public", auth: "rotated-auth" },
				preferences: detailedPreferences,
			});
		});
		await vi.waitFor(() =>
			expect(test.providerDevices).toContainEqual(
				expect.objectContaining({
					id: test.secondDevice.id,
					endpoint: "https://fcm.googleapis.com/fcm/send/rotated-target",
					preferences: expect.objectContaining({ privacy: "detailed" }),
				}),
			),
		);
		test.outbox.close();
		expect(test.deliver).toHaveBeenCalledTimes(9);
		expect(test.recordDecision).toHaveBeenCalledWith(
			expect.objectContaining({
				device: expect.objectContaining({
					id: test.secondDevice.id,
					privacy: "detailed",
				}),
				status: "pending",
			}),
		);
	});
});

describe("PushNotificationOutbox persistence", () => {
	it("keeps newly persisted attention events for durable provider retries", async () => {
		const enqueue = vi.fn(
			async (input: {
				expiresAt: number;
				nextAttemptAt?: number | null;
				statusReason?: string | null;
			}) =>
				event({
					expiresAt: input.expiresAt,
					nextAttemptAt: input.nextAttemptAt ?? null,
					statusReason: input.statusReason ?? null,
				}),
		);
		const outbox = new PushNotificationOutbox({
			now: () => NOW,
			enqueue: enqueue as never,
			reconcileOneShots: vi.fn(async () => 0),
			schedule: vi.fn(() => timerHandle()) as never,
			cancel: vi.fn(),
		});

		outbox.persistSessionEvent({
			kind: "needs_attention",
			sessionId: "session-1",
			sessionAliases: ["session-1"],
			category: "request",
			reason: "permission",
			label: "Release Hlid",
			url: "/raven?session=session-1&attention=permission",
			tag: "hlid-session:session-1",
			pendingCount: 1,
			occurredAt: NOW,
			expiresAt: NOW + 5 * 60_000,
		});
		await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
		outbox.close();
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				expiresAt: NOW + 24 * 60 * 60_000,
			}),
		);
	});
});

describe("PushNotificationOutbox completion batching", () => {
	it("delivers a live three-to-two candidate shrink as individual notifications", async () => {
		const selectedBatch = batch();
		const events = [
			event({
				id: "22222222-2222-4222-8222-222222222221",
				sourceId: "session-short",
				category: "completion",
				reason: "ready",
				runtimeMs: 60_000,
				batchId: selectedBatch.id,
				status: "batched",
				metadata: { sessionAliases: ["session-short"] },
			}),
			event({
				id: "22222222-2222-4222-8222-222222222222",
				sourceId: "session-long-one",
				category: "completion",
				reason: "ready",
				runtimeMs: 600_000,
				batchId: selectedBatch.id,
				status: "batched",
				metadata: { sessionAliases: ["session-long-one"] },
			}),
			event({
				id: "22222222-2222-4222-8222-222222222223",
				sourceId: "session-long-two",
				category: "completion",
				reason: "ready",
				runtimeMs: 700_000,
				batchId: selectedBatch.id,
				status: "batched",
				metadata: { sessionAliases: ["session-long-two"] },
			}),
		];
		const initialDevice = subscription(
			preferences({ work_finished: true, completion_min_runtime_minutes: 0 }),
		);
		const liveDevice = {
			...initialDevice,
			preferences: preferences({
				work_finished: true,
				completion_min_runtime_minutes: 5,
			}),
		};
		const rows = new Map<string, PushNotificationDeliveryRecord>();
		const recordDecision = vi.fn(
			async (input: {
				eventId: string;
				device: {
					id: string;
					name: string;
					privacy: PushPreferences["privacy"];
					preferences?: PushPreferences;
				};
				status: "pending" | "suppressed" | "queued";
				reason?: string | null;
			}) => {
				const previous = rows.get(input.eventId);
				const row = delivery(liveDevice, input.status, {
					...previous,
					id: previous?.id ?? `${input.eventId}:delivery`,
					eventId: input.eventId,
					status: input.status,
					reason: input.reason ?? null,
				});
				rows.set(input.eventId, row);
				return row;
			},
		);
		const deliver = vi.fn(async (_events: PushEvent[]) => ({
			subscriptions: 1,
			attempted: 1,
			delivered: 1,
			failed: 0,
			disabled: 0,
			suppressed: 0,
		}));
		const listSubscriptions = vi
			.fn()
			.mockResolvedValueOnce([initialDevice])
			.mockResolvedValue([liveDevice]);
		const outbox = new PushNotificationOutbox({
			now: () => NOW,
			listEvents: vi.fn().mockResolvedValueOnce(events).mockResolvedValue([]),
			listPendingDeliveries: vi.fn(async () => []),
			reconcileOneShots: vi.fn(async () => 0),
			listSubscriptions,
			listDeliveries: vi.fn(async (eventId: string) => {
				const row = rows.get(eventId);
				return row ? [row] : [];
			}),
			listBatchMembers: vi.fn(async () =>
				events.map((eventRow, index) =>
					batchMember(eventRow, selectedBatch.id, index),
				),
			),
			getEvent: vi.fn(
				async (eventId: string) =>
					events.find((eventRow) => eventRow.id === eventId) ?? null,
			),
			getBatch: vi.fn(async () => selectedBatch),
			getPolicy: vi.fn(async (sessionId: string) =>
				policy({ requestedSessionId: sessionId }),
			),
			updateEvent: vi.fn(async () => events[0] as PushNotificationEventRecord),
			recordDecision: recordDecision as never,
			deliver: deliver as never,
			visibleUntil: () => null,
			isRelevant: () => true,
			schedule: vi.fn(() => timerHandle()) as never,
			cancel: vi.fn(),
		});

		outbox.start();
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
		outbox.close();
		expect(recordDecision).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: events[0]?.id,
				status: "suppressed",
				reason: "preference",
			}),
		);
		for (const [deliveredEvents] of deliver.mock.calls) {
			expect(deliveredEvents).toHaveLength(1);
			expect(deliveredEvents[0]?.batchId).toBeUndefined();
		}
	});

	it("does not share a batch across overlapping but unequal target sets", async () => {
		const firstDevice = namedSubscription(
			"11111111-1111-4111-8111-111111111111",
			"Phone",
			preferences({ work_finished: true }),
		);
		const secondDevice = namedSubscription(
			"55555555-5555-4555-8555-555555555555",
			"Tablet",
			preferences({ work_finished: true }),
		);
		const firstEvent = event({
			id: "22222222-2222-4222-8222-222222222221",
			sourceId: "session-one",
			category: "completion",
			reason: "ready",
			groupKey: "session-completions",
			metadata: { sessionAliases: ["session-one"] },
		});
		const secondEvent = event({
			id: "22222222-2222-4222-8222-222222222223",
			sourceId: "session-two",
			category: "completion",
			reason: "ready",
			groupKey: "session-completions",
			metadata: { sessionAliases: ["session-two"] },
		});
		const rows = new Map<string, PushNotificationDeliveryRecord>();
		const rowKey = (eventId: string, deviceId: string) =>
			`${eventId}:${deviceId}`;
		const recordDecision = vi.fn(
			async (input: {
				eventId: string;
				device: { id: string };
				status: "pending" | "suppressed" | "queued";
				reason?: string | null;
			}) => {
				const selectedDevice =
					input.device.id === firstDevice.id ? firstDevice : secondDevice;
				const key = rowKey(input.eventId, input.device.id);
				const row = delivery(selectedDevice, input.status, {
					id: `${key}:delivery`,
					eventId: input.eventId,
					reason: input.reason ?? null,
					attemptCount: rows.get(key)?.attemptCount ?? 0,
				});
				rows.set(key, row);
				return row;
			},
		);
		const recordReceipt = vi.fn(
			async (input: {
				eventId: string;
				deviceId: string;
				status: "sent" | "failed" | "gone" | "expired";
				reason?: string | null;
				nextAttemptAt?: number | null;
				providerStatus?: number | null;
			}) => {
				const key = rowKey(input.eventId, input.deviceId);
				const previous = rows.get(key);
				if (!previous) return null;
				const next = {
					...previous,
					status: input.status,
					reason: input.reason ?? null,
					nextAttemptAt: input.nextAttemptAt ?? null,
					providerStatus: input.providerStatus ?? null,
					attemptCount: previous.attemptCount + 1,
				};
				rows.set(key, next);
				return next;
			},
		);
		const policies = new Map([
			[
				firstEvent.sourceId,
				policy({
					requestedSessionId: firstEvent.sourceId,
					sourceSessionId: firstEvent.sourceId,
					mode: "notify",
					targetDeviceIds: [firstDevice.id],
				}),
			],
			[
				secondEvent.sourceId,
				policy({
					requestedSessionId: secondEvent.sourceId,
					sourceSessionId: secondEvent.sourceId,
					mode: "notify",
					targetDeviceIds: [firstDevice.id, secondDevice.id],
				}),
			],
		]);
		const deliver = vi.fn(
			async (
				events: PushEvent[],
				overrides: {
					listSubscriptions?: () => Promise<StoredPushSubscription[]>;
					onResult?: (
						device: StoredPushSubscription,
						events: PushEvent[],
						result: { outcome: "delivered"; statusCode: number },
					) => Promise<void> | void;
				},
			) => {
				const device = (await overrides.listSubscriptions?.())?.[0];
				if (!device) throw new Error("Batch test did not receive a device");
				await overrides.onResult?.(device, events, {
					outcome: "delivered",
					statusCode: 201,
				});
				return {
					subscriptions: 1,
					attempted: 1,
					delivered: 1,
					failed: 0,
					disabled: 0,
					suppressed: 0,
				};
			},
		);
		const createBatch = vi.fn(async () => batch());
		const outbox = new PushNotificationOutbox({
			now: () => NOW,
			listEvents: vi
				.fn()
				.mockResolvedValueOnce([firstEvent, secondEvent])
				.mockResolvedValue([]),
			listPendingDeliveries: vi.fn(async () => []),
			reconcileOneShots: vi.fn(async () => 0),
			listSubscriptions: vi.fn(async () => [firstDevice, secondDevice]),
			listDeliveries: vi.fn(async (eventId: string) =>
				Array.from(rows.values()).filter((row) => row.eventId === eventId),
			),
			getPolicy: vi.fn(async (sessionId: string) => {
				const selected = policies.get(sessionId);
				if (!selected) throw new Error(`Missing policy for ${sessionId}`);
				return selected;
			}),
			updateEvent: vi.fn(async () => firstEvent),
			recordDecision: recordDecision as never,
			recordReceipt: recordReceipt as never,
			createBatch: createBatch as never,
			addBatchMembers: vi.fn(async () => []) as never,
			deliver: deliver as never,
			visibleUntil: () => null,
			isRelevant: () => true,
			schedule: vi.fn(() => timerHandle()) as never,
			cancel: vi.fn(),
		});

		outbox.start();
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
		outbox.close();
		expect(createBatch).not.toHaveBeenCalled();
		for (const [deliveredEvents] of deliver.mock.calls) {
			expect(deliveredEvents).toHaveLength(1);
			expect(deliveredEvents[0]?.batchId).toBeUndefined();
		}
	});

	it("finalizes a recovered ready batch with sent deliveries without resending", async () => {
		const selectedBatch = batch();
		const firstEvent = event({
			id: "22222222-2222-4222-8222-222222222221",
			sourceId: "session-one",
			category: "completion",
			reason: "ready",
			batchId: selectedBatch.id,
			status: "batched",
		});
		const secondEvent = event({
			id: "22222222-2222-4222-8222-222222222223",
			sourceId: "session-two",
			category: "completion",
			reason: "ready",
			batchId: selectedBatch.id,
			status: "batched",
		});
		const selectedDevice = subscription(preferences({ work_finished: true }));
		const rows = new Map([
			[
				firstEvent.id,
				delivery(selectedDevice, "sent", {
					eventId: firstEvent.id,
					attemptCount: 1,
					reason: "batch_accepted",
					deviceSnapshot: {
						id: selectedDevice.id,
						name: selectedDevice.name,
						privacy: selectedDevice.preferences.privacy,
						oneShot: {
							sourceSessionId: firstEvent.sourceId,
							mode: "notify_completion_once",
							policyUpdatedAt: 41,
						},
					},
				}),
			],
			[
				secondEvent.id,
				delivery(selectedDevice, "sent", {
					id: "66666666-6666-4666-8666-666666666666",
					eventId: secondEvent.id,
					attemptCount: 1,
					reason: "batch_accepted",
				}),
			],
		]);
		const deliver = vi.fn();
		const updateBatch = vi.fn(async () => selectedBatch);
		const outbox = new PushNotificationOutbox({
			now: () => NOW,
			listEvents: vi
				.fn()
				.mockResolvedValueOnce([firstEvent, secondEvent])
				.mockResolvedValue([]),
			listPendingDeliveries: vi.fn(async () => []),
			reconcileOneShots: vi.fn(async () => 0),
			listSubscriptions: vi.fn(async () => [selectedDevice]),
			listDeliveries: vi.fn(async (eventId: string) => {
				const row = rows.get(eventId);
				return row ? [row] : [];
			}),
			listBatchMembers: vi.fn(async () => [
				batchMember(firstEvent, selectedBatch.id, 0),
				batchMember(secondEvent, selectedBatch.id, 1),
			]),
			getEvent: vi.fn(async (eventId: string) =>
				eventId === firstEvent.id ? firstEvent : secondEvent,
			),
			getBatch: vi.fn(async () => selectedBatch),
			getPolicy: vi.fn(async (sessionId: string) =>
				policy({ requestedSessionId: sessionId, mode: "notify" }),
			),
			updateEvent: vi.fn(async () => firstEvent),
			updateBatch: updateBatch as never,
			deliver: deliver as never,
			visibleUntil: () => null,
			isRelevant: () => true,
			schedule: vi.fn(() => timerHandle()) as never,
			cancel: vi.fn(),
		});

		outbox.start();
		await vi.waitFor(() =>
			expect(updateBatch).toHaveBeenCalledWith(selectedBatch.id, "sent", NOW),
		);
		outbox.close();
		expect(deliver).not.toHaveBeenCalled();
	});

	it("reconciles every member after a crash persisted only one batch receipt", async () => {
		const selectedBatch = batch({ status: "sent", sentAt: NOW - 100 });
		const firstEvent = event({
			id: "22222222-2222-4222-8222-222222222221",
			sourceId: "session-one",
			category: "completion",
			reason: "ready",
			batchId: selectedBatch.id,
			status: "batched",
		});
		const secondEvent = event({
			id: "22222222-2222-4222-8222-222222222223",
			sourceId: "session-two",
			category: "completion",
			reason: "ready",
			batchId: selectedBatch.id,
			status: "batched",
		});
		const selectedDevice = subscription(preferences({ work_finished: true }));
		const rows = new Map([
			[
				firstEvent.id,
				delivery(selectedDevice, "sent", {
					eventId: firstEvent.id,
					attemptCount: 1,
					reason: "batch_accepted",
				}),
			],
			[
				secondEvent.id,
				delivery(selectedDevice, "pending", {
					id: "66666666-6666-4666-8666-666666666666",
					eventId: secondEvent.id,
					deviceSnapshot: {
						id: selectedDevice.id,
						name: selectedDevice.name,
						privacy: selectedDevice.preferences.privacy,
						oneShot: {
							sourceSessionId: secondEvent.sourceId,
							mode: "notify_completion_once",
							policyUpdatedAt: 42,
						},
					},
				}),
			],
		]);
		const recordReceipt = vi.fn(
			async (input: {
				eventId: string;
				deviceId: string;
				status: "sent" | "failed" | "gone" | "expired";
				reason?: string | null;
				nextAttemptAt?: number | null;
			}) => {
				const previous = rows.get(input.eventId);
				if (!previous) return null;
				const next = {
					...previous,
					status: input.status,
					reason: input.reason ?? null,
					nextAttemptAt: input.nextAttemptAt ?? null,
				};
				rows.set(input.eventId, next);
				return next;
			},
		);
		const recoveredRecordDecision = vi.fn(
			async (input: { eventId: string }) =>
				rows.get(input.eventId) as PushNotificationDeliveryRecord,
		);
		const deliver = vi.fn();
		const updateBatch = vi.fn(async () => selectedBatch);
		const outbox = new PushNotificationOutbox({
			now: () => NOW,
			listEvents: vi
				.fn()
				.mockResolvedValueOnce([firstEvent, secondEvent])
				.mockResolvedValue([]),
			listPendingDeliveries: vi.fn(async () => []),
			reconcileOneShots: vi.fn(async () => 0),
			listSubscriptions: vi.fn(async () => [selectedDevice]),
			listDeliveries: vi.fn(async (eventId: string) => {
				const row = rows.get(eventId);
				return row ? [row] : [];
			}),
			listBatchMembers: vi.fn(async () => [
				batchMember(firstEvent, selectedBatch.id, 0),
				batchMember(secondEvent, selectedBatch.id, 1),
			]),
			getEvent: vi.fn(async (eventId: string) =>
				eventId === firstEvent.id ? firstEvent : secondEvent,
			),
			getBatch: vi.fn(async () => selectedBatch),
			getPolicy: vi.fn(async (sessionId: string) =>
				policy({ requestedSessionId: sessionId, mode: "notify" }),
			),
			updateEvent: vi.fn(async () => firstEvent),
			updateBatch: updateBatch as never,
			recordDecision: recoveredRecordDecision as never,
			recordReceipt: recordReceipt as never,
			deliver: deliver as never,
			visibleUntil: () => null,
			isRelevant: () => true,
			schedule: vi.fn(() => timerHandle()) as never,
			cancel: vi.fn(),
		});

		outbox.start();
		await vi.waitFor(() =>
			expect(recordReceipt).toHaveBeenCalledWith({
				eventId: secondEvent.id,
				deviceId: selectedDevice.id,
				status: "sent",
				reason: "batch_accepted",
				nextAttemptAt: null,
				oneShot: {
					sourceSessionId: secondEvent.sourceId,
					mode: "notify_completion_once",
					policyUpdatedAt: 42,
				},
			}),
		);
		outbox.close();
		expect(rows.get(secondEvent.id)).toMatchObject({
			status: "sent",
			reason: "batch_accepted",
		});
		expect(deliver).not.toHaveBeenCalled();
		expect(updateBatch).toHaveBeenCalledWith(selectedBatch.id, "sent", NOW);
	});

	it("expires a recovered ready batch when all deliveries are terminal failures", async () => {
		const selectedBatch = batch();
		const firstEvent = event({
			id: "22222222-2222-4222-8222-222222222221",
			sourceId: "session-one",
			category: "completion",
			reason: "ready",
			batchId: selectedBatch.id,
			status: "batched",
		});
		const secondEvent = event({
			id: "22222222-2222-4222-8222-222222222223",
			sourceId: "session-two",
			category: "completion",
			reason: "ready",
			batchId: selectedBatch.id,
			status: "batched",
		});
		const selectedDevice = subscription(preferences({ work_finished: true }));
		const rows = new Map([
			[
				firstEvent.id,
				delivery(selectedDevice, "failed", {
					eventId: firstEvent.id,
					reason: "provider_failure",
					attemptCount: 3,
				}),
			],
			[
				secondEvent.id,
				delivery(selectedDevice, "gone", {
					id: "66666666-6666-4666-8666-666666666666",
					eventId: secondEvent.id,
					reason: "provider_failure",
					attemptCount: 1,
				}),
			],
		]);
		const deliver = vi.fn();
		const updateBatch = vi.fn(async () => selectedBatch);
		const outbox = new PushNotificationOutbox({
			now: () => NOW,
			listEvents: vi
				.fn()
				.mockResolvedValueOnce([firstEvent, secondEvent])
				.mockResolvedValue([]),
			listPendingDeliveries: vi.fn(async () => []),
			reconcileOneShots: vi.fn(async () => 0),
			listSubscriptions: vi.fn(async () => [selectedDevice]),
			listDeliveries: vi.fn(async (eventId: string) => {
				const row = rows.get(eventId);
				return row ? [row] : [];
			}),
			listBatchMembers: vi.fn(async () => [
				batchMember(firstEvent, selectedBatch.id, 0),
				batchMember(secondEvent, selectedBatch.id, 1),
			]),
			getEvent: vi.fn(async (eventId: string) =>
				eventId === firstEvent.id ? firstEvent : secondEvent,
			),
			getBatch: vi.fn(async () => selectedBatch),
			getPolicy: vi.fn(async (sessionId: string) =>
				policy({ requestedSessionId: sessionId, mode: "notify" }),
			),
			updateEvent: vi.fn(async () => firstEvent),
			updateBatch: updateBatch as never,
			deliver: deliver as never,
			visibleUntil: () => null,
			isRelevant: () => true,
			schedule: vi.fn(() => timerHandle()) as never,
			cancel: vi.fn(),
		});

		outbox.start();
		await vi.waitFor(() =>
			expect(updateBatch).toHaveBeenCalledWith(
				selectedBatch.id,
				"expired",
				NOW,
			),
		);
		outbox.close();
		expect(deliver).not.toHaveBeenCalled();
	});
});

describe("PushNotificationOutbox pagination", () => {
	it("immediately follows a full page with another drain", async () => {
		const selectedEvent = event();
		const listEvents = vi
			.fn()
			.mockResolvedValueOnce(Array.from({ length: 100 }, () => selectedEvent))
			.mockResolvedValue([]);
		const outbox = new PushNotificationOutbox({
			now: () => NOW,
			listEvents,
			listPendingDeliveries: vi.fn(async () => []),
			reconcileOneShots: vi.fn(async () => 0),
			listSubscriptions: vi.fn(async () => []),
			listDeliveries: vi.fn(async () => []),
			getPolicy: vi.fn(async () => policy()),
			updateEvent: vi.fn(async () => selectedEvent),
			visibleUntil: () => null,
			isRelevant: () => true,
			schedule: vi.fn(() => timerHandle()) as never,
			cancel: vi.fn(),
		});

		outbox.start();
		await vi.waitFor(() => expect(listEvents).toHaveBeenCalledTimes(2));
		outbox.close();
	});
});
