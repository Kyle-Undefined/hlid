import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webPushNotificationPayloadSchema } from "./pushNotificationSchemas";

type WaitableEvent = {
	waitUntil(promise: Promise<unknown>): void;
};

type PushEvent = WaitableEvent & {
	data?: { text(): string };
	notification?: Record<string, unknown>;
};

type NotificationClickEvent = WaitableEvent & {
	notification: { tag?: string; data: unknown; close(): void };
};

type PushSubscriptionChangeEvent = WaitableEvent & {
	oldSubscription?: { endpoint?: string };
	newSubscription?: unknown;
};

type HandlerMap = {
	activate?: (event: WaitableEvent) => void;
	message?: (
		event: WaitableEvent & {
			data: unknown;
			ports: never[];
			source?: Record<string, unknown>;
		},
	) => void;
	push?: (event: PushEvent) => void;
	pushsubscriptionchange?: (event: PushSubscriptionChangeEvent) => void;
	notificationclick?: (event: NotificationClickEvent) => void;
	notificationclose?: (event: NotificationClickEvent) => void;
};

function loadWorker(
	windowClients: Array<Record<string, unknown>> = [],
	displayedNotifications: Array<Record<string, unknown>> = [],
) {
	const handlers: HandlerMap = {};
	const activeNotifications = [...displayedNotifications];
	for (const notification of activeNotifications) {
		const originalClose = notification.close as (() => unknown) | undefined;
		notification.close = vi.fn(() => {
			originalClose?.();
			const index = activeNotifications.indexOf(notification);
			if (index >= 0) activeNotifications.splice(index, 1);
		});
	}
	const showNotification = vi.fn(
		async (title: string, options: Record<string, unknown>) => {
			const existingIndex = activeNotifications.findIndex(
				(notification) => notification.tag === options.tag,
			);
			if (existingIndex >= 0) activeNotifications.splice(existingIndex, 1);
			const shown: Record<string, unknown> = {
				title,
				...options,
			};
			shown.close = vi.fn(() => {
				const index = activeNotifications.indexOf(shown);
				if (index >= 0) activeNotifications.splice(index, 1);
			});
			activeNotifications.push(shown);
		},
	);
	const openWindow = vi.fn().mockResolvedValue(undefined);
	const setAppBadge = vi.fn().mockResolvedValue(undefined);
	const clearAppBadge = vi.fn().mockResolvedValue(undefined);
	const pushSubscribe = vi.fn();
	const fetchMock = vi.fn().mockResolvedValue(
		new Response("{}", {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);
	const getNotifications = vi.fn(async ({ tag }: { tag?: string } = {}) =>
		tag
			? activeNotifications.filter((notification) => notification.tag === tag)
			: activeNotifications,
	);
	const cacheStores = new Map<string, Map<string, Response>>();
	const cacheKey = (input: unknown) => {
		const candidate =
			typeof input === "string"
				? input
				: ((input as { url?: unknown } | null)?.url ?? "");
		return new URL(String(candidate), "https://hlid.test").href;
	};
	const openCache = vi.fn(async (name: string) => {
		const store = cacheStores.get(name) ?? new Map<string, Response>();
		cacheStores.set(name, store);
		return {
			add: vi.fn(),
			put: vi.fn(async (input: unknown, response: Response) => {
				store.set(cacheKey(input), response.clone());
			}),
			match: vi.fn(async (input: unknown) =>
				store.get(cacheKey(input))?.clone(),
			),
			delete: vi.fn(async (input: unknown) => store.delete(cacheKey(input))),
		};
	});
	const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
	runInNewContext(source, {
		URL,
		Response,
		Promise,
		MessageChannel,
		atob,
		fetch: fetchMock,
		setTimeout,
		clearTimeout,
		caches: {
			match: vi.fn(async (input: unknown) => {
				for (const store of cacheStores.values()) {
					const response = store.get(cacheKey(input));
					if (response) return response.clone();
				}
			}),
			open: openCache,
			keys: vi.fn(async () => [...cacheStores.keys()]),
			delete: vi.fn(async (name: string) => cacheStores.delete(name)),
		},
		self: {
			location: { origin: "https://hlid.test" },
			registration: {
				getNotifications,
				showNotification,
				pushManager: { subscribe: pushSubscribe },
				navigationPreload: { enable: vi.fn() },
			},
			navigator: { setAppBadge, clearAppBadge },
			addEventListener(type: keyof HandlerMap, callback: unknown) {
				handlers[type] = callback as never;
			},
			skipWaiting: vi.fn(),
			clients: {
				claim: vi.fn(),
				matchAll: vi.fn().mockResolvedValue(windowClients),
				openWindow,
			},
		},
	});
	if (
		!handlers.push ||
		!handlers.pushsubscriptionchange ||
		!handlers.notificationclick ||
		!handlers.notificationclose
	)
		throw new Error("service worker notification handlers were not registered");
	return {
		handlers: handlers as Required<HandlerMap>,
		showNotification,
		fetchMock,
		getNotifications,
		openWindow,
		setAppBadge,
		clearAppBadge,
		pushSubscribe,
		activeNotifications,
	};
}

async function dispatchWaitable(
	handler: (event: WaitableEvent) => void,
): Promise<void> {
	let work: Promise<unknown> | undefined;
	handler({
		waitUntil(promise) {
			work = promise;
		},
	});
	if (work) await work;
}

async function dispatchMessage(
	handler: NonNullable<HandlerMap["message"]>,
	data: unknown,
	source?: Record<string, unknown>,
): Promise<void> {
	let work: Promise<unknown> | undefined;
	handler({
		data,
		ports: [],
		...(source ? { source } : {}),
		waitUntil(promise) {
			work = promise;
		},
	});
	if (work) await work;
}

async function dispatchPush(
	handler: (event: PushEvent) => void,
	payload: unknown,
): Promise<void> {
	let work: Promise<unknown> | undefined;
	handler({
		data: { text: () => JSON.stringify(payload) },
		waitUntil(promise) {
			work = promise;
		},
	});
	if (!work) throw new Error("push event did not extend its lifetime");
	await work;
}

async function dispatchRawPush(
	handler: (event: PushEvent) => void,
	raw?: string,
	notification?: Record<string, unknown>,
): Promise<void> {
	let work: Promise<unknown> | undefined;
	handler({
		...(raw === undefined ? {} : { data: { text: () => raw } }),
		...(notification ? { notification } : {}),
		waitUntil(promise) {
			work = promise;
		},
	});
	if (!work) throw new Error("push event did not extend its lifetime");
	await work;
}

async function dispatchClick(
	handler: (event: NotificationClickEvent) => void,
	data: unknown,
	shownNotification?: Record<string, unknown>,
): Promise<{ close: ReturnType<typeof vi.fn> }> {
	let work: Promise<unknown> | undefined;
	const close =
		(shownNotification?.close as ReturnType<typeof vi.fn<() => void>>) ??
		vi.fn<() => void>();
	handler({
		notification: shownNotification
			? ({
					...shownNotification,
					data,
					close,
				} as NotificationClickEvent["notification"])
			: { data, close: close as () => void },
		waitUntil(promise) {
			work = promise;
		},
	});
	if (work) await work;
	return { close };
}

async function dispatchClose(
	handler: NonNullable<HandlerMap["notificationclose"]>,
	notification: Record<string, unknown>,
): Promise<void> {
	let work: Promise<unknown> | undefined;
	handler({
		notification:
			notification as unknown as NotificationClickEvent["notification"],
		waitUntil(promise) {
			work = promise;
		},
	});
	if (work) await work;
}

async function dispatchSubscriptionChange(
	handler: NonNullable<HandlerMap["pushsubscriptionchange"]>,
	oldSubscription?: { endpoint?: string },
	newSubscription?: unknown,
): Promise<void> {
	let work: Promise<unknown> | undefined;
	handler({
		...(oldSubscription ? { oldSubscription } : {}),
		...(newSubscription ? { newSubscription } : {}),
		waitUntil(promise) {
			work = promise;
		},
	});
	if (!work) throw new Error("subscription change did not extend its lifetime");
	await work;
}

function validPayload(overrides: Record<string, unknown> = {}) {
	const now = Date.now();
	return {
		version: 1,
		kind: "needs_attention",
		sessionId: "session-1",
		title: "Hlid needs your attention",
		body: "A session is waiting for you.",
		url: "/raven?session=session-1",
		createdAt: now - 1_000,
		expiresAt: now + 60_000,
		...overrides,
	};
}

function navigationAcknowledgement() {
	return vi.fn((_message: unknown, transfer: readonly MessagePort[]) => {
		transfer[0]?.postMessage({
			type: "hlid:navigate-notification-ack",
			accepted: true,
		});
	});
}

const DELIVERY_ID = "019ffa8b-0df1-7c63-8d03-e428cbae240f";
const DELIVERY_ID_2 = "019ffa8b-0df1-7c63-bd03-e428cbae240f";
const DELIVERY_ID_3 = "019ffa8b-0df1-7c63-ad04-e428cbae240f";
const ROUTINE_ID = "019ffa8b-0df1-7c63-9d03-e428cbae240f";
const ROUTINE_RUN_ID = "019ffa8b-0df1-7c63-ad03-e428cbae240f";

function validRoutinePayload(overrides: Record<string, unknown> = {}) {
	const now = Date.now();
	return {
		version: 1,
		source: "routine",
		kind: "needs_attention",
		routineId: ROUTINE_ID,
		routineRunId: ROUTINE_RUN_ID,
		title: "Routine unavailable",
		body: "Daily review could not start.",
		reason: "routine_provider_unavailable",
		url: `/?routine=${ROUTINE_ID}&routine_run=${ROUTINE_RUN_ID}`,
		createdAt: now - 1_000,
		expiresAt: now + 60_000,
		...overrides,
	};
}

function declarativePayload(overrides: Record<string, unknown> = {}) {
	const payload = validPayload();
	return {
		web_push: 8030,
		notification: {
			title: payload.title,
			body: payload.body,
			navigate: payload.url,
			tag: `hlid-session:${payload.sessionId}`,
			timestamp: payload.createdAt,
			mutable: true,
			data: payload,
			...overrides,
		},
	};
}

afterEach(() => vi.restoreAllMocks());

describe("service worker push notifications", () => {
	it("shows the supplied bounded content and groups replacements by session", async () => {
		const worker = loadWorker();

		await dispatchPush(worker.handlers.push, validPayload());
		await dispatchPush(
			worker.handlers.push,
			validPayload({
				body: "The same session still needs attention.",
				reminder: true,
			}),
		);

		expect(worker.showNotification).toHaveBeenCalledTimes(2);
		const [title, options] = worker.showNotification.mock.calls[0] ?? [];
		expect(title).toBe("Hlid needs your attention");
		expect(options).toMatchObject({
			body: "A session is waiting for you.",
			badge: "/notification-badge.svg",
			tag: "hlid-session:session-1",
			renotify: false,
			data: {
				sessionId: "session-1",
				url: "/raven?session=session-1",
			},
		});
		expect(options).not.toHaveProperty("actions");
		const replacementOptions = worker.showNotification.mock.calls[1]?.[1];
		expect(replacementOptions).toMatchObject({
			tag: "hlid-session:session-1",
			renotify: false,
		});
		expect(replacementOptions?.data).not.toHaveProperty("reminder");
		expect(worker.setAppBadge).toHaveBeenLastCalledWith(1);
	});

	it("reports validated delivery lifecycle receipts without gating notification UX", async () => {
		const focusedClient = { focus: vi.fn().mockResolvedValue(undefined) };
		const existingClient = {
			url: "https://hlid.test/forge",
			navigate: vi.fn().mockResolvedValue(focusedClient),
		};
		const worker = loadWorker([existingClient]);

		await dispatchPush(
			worker.handlers.push,
			validPayload({ deliveryId: DELIVERY_ID }),
		);
		const shown = worker.activeNotifications[0];
		if (!shown) throw new Error("notification was not displayed");
		expect(shown.data).toMatchObject({ deliveryId: DELIVERY_ID });

		worker.fetchMock.mockRejectedValueOnce(new Error("receipt unavailable"));
		await dispatchClick(worker.handlers.notificationclick, shown.data, shown);
		await dispatchClose(worker.handlers.notificationclose, shown);

		const receipts = worker.fetchMock.mock.calls
			.filter(([path]) => path === "/api/push/receipts")
			.map(([, init]) => JSON.parse(String(init?.body)));
		expect(receipts).toEqual([
			{ delivery_id: DELIVERY_ID, status: "displayed" },
			{ delivery_id: DELIVERY_ID, status: "opened" },
			{ delivery_id: DELIVERY_ID, status: "dismissed" },
		]);
		expect(existingClient.navigate).toHaveBeenCalledWith(
			"/raven?session=session-1&notification_open=1",
		);
		expect(focusedClient.focus).toHaveBeenCalledOnce();
	});

	it("opens a provider-unavailable Routine in Cockpit without fabricating a Raven session", async () => {
		const focusedClient = { focus: vi.fn().mockResolvedValue(undefined) };
		const existingClient = {
			url: "https://hlid.test/raven?session=some-session",
			navigate: vi.fn().mockResolvedValue(focusedClient),
		};
		const worker = loadWorker([existingClient]);

		await dispatchPush(
			worker.handlers.push,
			validRoutinePayload({ deliveryId: DELIVERY_ID }),
		);

		const shown = worker.activeNotifications[0];
		if (!shown) throw new Error("Routine notification was not displayed");
		expect(worker.showNotification).toHaveBeenCalledWith(
			"Routine unavailable",
			expect.objectContaining({
				tag: `hlid-routine:${ROUTINE_RUN_ID}`,
				data: expect.objectContaining({
					source: "routine",
					routineId: ROUTINE_ID,
					routineRunId: ROUTINE_RUN_ID,
					deliveryId: DELIVERY_ID,
					url: `/?routine=${ROUTINE_ID}&routine_run=${ROUTINE_RUN_ID}`,
				}),
			}),
		);
		expect(shown.data).not.toHaveProperty("sessionId");
		expect(worker.setAppBadge).toHaveBeenLastCalledWith(1);

		await dispatchClick(worker.handlers.notificationclick, shown.data, shown);

		expect(existingClient.navigate).toHaveBeenCalledWith(
			`/?routine=${ROUTINE_ID}&routine_run=${ROUTINE_RUN_ID}`,
		);
		expect(existingClient.navigate).not.toHaveBeenCalledWith(
			expect.stringContaining("/raven"),
		);
		const receiptStatuses = worker.fetchMock.mock.calls
			.filter(([path]) => path === "/api/push/receipts")
			.map(([, init]) => JSON.parse(String(init?.body)).status);
		expect(receiptStatuses).toEqual(["displayed", "opened"]);
	});

	it("accepts a successful Routine outcome with the same Routine-specific contract", async () => {
		const worker = loadWorker();

		await dispatchPush(
			worker.handlers.push,
			validRoutinePayload({
				kind: "work_finished",
				title: "Routine finished",
				body: "Daily review finished successfully.",
				reason: "routine_succeeded",
			}),
		);

		expect(worker.showNotification).toHaveBeenCalledWith(
			"Routine finished",
			expect.objectContaining({
				tag: `hlid-routine:${ROUTINE_RUN_ID}`,
				data: expect.objectContaining({
					source: "routine",
					kind: "work_finished",
				}),
			}),
		);
	});

	it("visibly rejects malformed or session-shaped Routine payloads", async () => {
		const worker = loadWorker();
		const invalidPayloads = [
			validRoutinePayload({ routineId: undefined }),
			validRoutinePayload({ routineRunId: "not-a-uuid" }),
			validRoutinePayload({ url: undefined }),
			validRoutinePayload({
				url: `https://attacker.test/?routine=${ROUTINE_ID}&routine_run=${ROUTINE_RUN_ID}`,
			}),
			validRoutinePayload({
				url: `/?routine_run=${ROUTINE_RUN_ID}&routine=${ROUTINE_ID}`,
			}),
			validRoutinePayload({
				url: `/?routine=${ROUTINE_ID}&routine_run=${ROUTINE_RUN_ID}&extra=true`,
			}),
			validRoutinePayload({
				url: `/?routine=${ROUTINE_ID}&routine_run=${ROUTINE_RUN_ID}#details`,
			}),
			validRoutinePayload({ sessionId: "fabricated-raven-session" }),
			validRoutinePayload({ deliveryIds: [DELIVERY_ID, DELIVERY_ID_2] }),
		];

		for (const payload of invalidPayloads) {
			await dispatchPush(worker.handlers.push, payload);
		}

		expect(worker.showNotification).toHaveBeenCalledTimes(
			invalidPayloads.length,
		);
		for (const [title, options] of worker.showNotification.mock.calls) {
			expect(title).toBe("Hlid notification");
			expect(options).toMatchObject({
				tag: "hlid-generic",
				data: { fallback: true, url: "/" },
			});
		}
		expect(worker.fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a malformed delivery id with the rest of its payload", async () => {
		const worker = loadWorker();

		await dispatchPush(
			worker.handlers.push,
			validPayload({ deliveryId: "not-a-delivery-id" }),
		);

		expect(worker.showNotification).toHaveBeenCalledWith(
			"Hlid notification",
			expect.objectContaining({
				badge: "/notification-badge.svg",
				tag: "hlid-generic",
			}),
		);
		expect(worker.fetchMock).not.toHaveBeenCalled();
	});

	it("preserves bounded detailed metadata while using authoritative copy", async () => {
		const worker = loadWorker();

		await dispatchPush(
			worker.handlers.push,
			validPayload({
				title: "Approval required",
				body: "Notification improvements",
				reason: "permission",
				sessionLabel: "Notification improvements",
				durationMs: 75_000,
			}),
		);

		expect(worker.showNotification).toHaveBeenCalledWith(
			"Approval required",
			expect.objectContaining({
				body: "Notification improvements",
				data: expect.objectContaining({
					reason: "permission",
					sessionLabel: "Notification improvements",
					durationMs: 75_000,
				}),
			}),
		);
	});

	it("parses the standards declarative envelope in legacy browsers", async () => {
		const worker = loadWorker();

		await dispatchPush(worker.handlers.push, declarativePayload());

		expect(worker.showNotification).toHaveBeenCalledWith(
			"Hlid needs your attention",
			expect.objectContaining({
				tag: "hlid-session:session-1",
				data: expect.objectContaining({ sessionId: "session-1" }),
			}),
		);
	});

	it("validates a mutable declarative notification when WebKit omits data", async () => {
		const worker = loadWorker();
		const envelope = declarativePayload();

		await dispatchRawPush(
			worker.handlers.push,
			undefined,
			envelope.notification,
		);

		expect(worker.showNotification).toHaveBeenCalledWith(
			"Hlid needs your attention",
			expect.objectContaining({ tag: "hlid-session:session-1" }),
		);
	});

	it("shows a bounded generic fallback for empty, malformed, and stale pushes", async () => {
		const worker = loadWorker();
		const now = Date.now();

		await dispatchRawPush(worker.handlers.push);
		await dispatchRawPush(worker.handlers.push, "{not-json");
		await dispatchPush(
			worker.handlers.push,
			validPayload({ expiresAt: now - 1 }),
		);
		await dispatchPush(
			worker.handlers.push,
			validPayload({
				createdAt: now - 25 * 60 * 60 * 1_000,
				expiresAt: now + 1_000,
			}),
		);
		await dispatchPush(worker.handlers.push, {
			...validPayload(),
			title: "x".repeat(161),
		});

		expect(worker.showNotification).toHaveBeenCalledTimes(5);
		for (const [title, options] of worker.showNotification.mock.calls) {
			expect(title).toBe("Hlid notification");
			expect(options).toMatchObject({
				body: "Open Hlid to check for updates.",
				tag: "hlid-generic",
				data: { fallback: true, url: "/" },
			});
			expect(options).not.toHaveProperty("actions");
		}
		expect(worker.setAppBadge).not.toHaveBeenCalled();
		expect(worker.clearAppBadge).toHaveBeenCalled();
	});

	it("shows a test notification without adding it to the app badge", async () => {
		const worker = loadWorker();

		await dispatchPush(worker.handlers.push, {
			...validPayload(),
			kind: "test",
			sessionId: undefined,
			title: "Hlid test notification",
			body: "Notifications are working on this device.",
			url: "https://attacker.test/forge",
		});

		expect(worker.showNotification).toHaveBeenCalledWith(
			"Hlid test notification",
			expect.objectContaining({
				tag: "hlid-test",
				data: expect.objectContaining({
					kind: "test",
					url: "/forge?category=experience&section=notifications",
				}),
			}),
		);
		expect(worker.setAppBadge).not.toHaveBeenCalled();
		expect(worker.clearAppBadge).toHaveBeenCalled();
	});

	it("groups a completion batch as one badge item and opens its exact Raven batch", async () => {
		const existingClient = {
			url: "https://hlid.test/forge",
			navigate: vi.fn().mockResolvedValue({
				focus: vi.fn().mockResolvedValue(undefined),
			}),
		};
		const worker = loadWorker([existingClient]);

		await dispatchPush(
			worker.handlers.push,
			validPayload({
				kind: "work_finished",
				sessionIds: ["session-1", "session-2", "session-3"],
				deliveryIds: [DELIVERY_ID, DELIVERY_ID_2, DELIVERY_ID_3],
				batchId: "batch-test-123",
				url: "https://attacker.test/raven?session=session-1",
			}),
		);

		const shown = worker.activeNotifications[0];
		expect(worker.showNotification).toHaveBeenCalledWith(
			"Hlid needs your attention",
			expect.objectContaining({
				tag: "hlid-work-finished-batch:batch-test-123",
				data: expect.objectContaining({
					sessionIds: ["session-1", "session-2", "session-3"],
					deliveryIds: [DELIVERY_ID, DELIVERY_ID_2, DELIVERY_ID_3],
					batchId: "batch-test-123",
					url: "/raven?notification_batch=batch-test-123",
				}),
			}),
		);
		expect(worker.setAppBadge).toHaveBeenLastCalledWith(1);

		await dispatchClick(worker.handlers.notificationclick, shown?.data, shown);
		if (!shown) throw new Error("batch notification was not displayed");
		await dispatchClose(worker.handlers.notificationclose, shown);

		expect(existingClient.navigate).toHaveBeenCalledWith(
			"/raven?notification_batch=batch-test-123&notification_open=1",
		);
		expect(worker.clearAppBadge).toHaveBeenCalled();
		const receipts = worker.fetchMock.mock.calls
			.filter(([path]) => path === "/api/push/receipts")
			.map(([, init]) => JSON.parse(String(init?.body)));
		expect(receipts).toEqual(
			["displayed", "opened", "dismissed"].flatMap((status) =>
				[DELIVERY_ID, DELIVERY_ID_2, DELIVERY_ID_3].map((delivery_id) => ({
					delivery_id,
					status,
				})),
			),
		);
	});

	it("keeps lifecycle receipt compatibility for an older batch with one delivery id", async () => {
		const worker = loadWorker();

		await dispatchPush(
			worker.handlers.push,
			validPayload({
				kind: "work_finished",
				sessionIds: ["session-1", "session-2"],
				batchId: "batch-legacy-123",
				deliveryId: DELIVERY_ID,
			}),
		);
		const shown = worker.activeNotifications[0];
		if (!shown) throw new Error("legacy batch notification was not displayed");
		await dispatchClick(worker.handlers.notificationclick, shown.data, shown);
		await dispatchClose(worker.handlers.notificationclose, shown);

		expect(
			worker.fetchMock.mock.calls
				.filter(([path]) => path === "/api/push/receipts")
				.map(([, init]) => JSON.parse(String(init?.body))),
		).toEqual(
			["displayed", "opened", "dismissed"].map((status) => ({
				delivery_id: DELIVERY_ID,
				status,
			})),
		);
	});

	it("preserves grouped completion batches when one member becomes visible", async () => {
		const matchingDirect = {
			tag: "hlid-session:session-1",
			data: validPayload({ sessionId: "session-1" }),
			close: vi.fn(),
		};
		const matchingBatch = {
			tag: "hlid-work-finished-batch:batch-test-123",
			data: validPayload({
				kind: "work_finished",
				sessionIds: ["session-1", "session-2"],
				batchId: "batch-test-123",
			}),
			close: vi.fn(),
		};
		const otherBatch = {
			tag: "hlid-work-finished-batch:batch-other-456",
			data: validPayload({
				kind: "work_finished",
				sessionId: "session-2",
				sessionIds: ["session-2", "session-3"],
				batchId: "batch-other-456",
			}),
			close: vi.fn(),
		};
		const worker = loadWorker([], [matchingDirect, matchingBatch, otherBatch]);

		await dispatchMessage(worker.handlers.message, {
			type: "hlid:close-session-notifications",
			sessionId: "session-1",
		});

		expect(matchingDirect.close).toHaveBeenCalledOnce();
		expect(matchingBatch.close).not.toHaveBeenCalled();
		expect(otherBatch.close).not.toHaveBeenCalled();
		expect(worker.setAppBadge).toHaveBeenLastCalledWith(2);
	});

	it("replaces retries of one batch without replacing independent batches", async () => {
		const worker = loadWorker();
		const firstBatch = validPayload({
			kind: "work_finished",
			sessionIds: ["session-1", "session-2"],
			batchId: "batch-first-123",
		});
		const secondBatch = validPayload({
			kind: "work_finished",
			sessionIds: ["session-1", "session-3"],
			batchId: "batch-second-456",
		});

		await dispatchPush(worker.handlers.push, firstBatch);
		await dispatchPush(worker.handlers.push, {
			...firstBatch,
			body: "Retry copy",
		});
		await dispatchPush(worker.handlers.push, secondBatch);

		expect(worker.activeNotifications).toHaveLength(2);
		expect(worker.activeNotifications.map(({ tag }) => tag)).toEqual([
			"hlid-work-finished-batch:batch-first-123",
			"hlid-work-finished-batch:batch-second-456",
		]);
		expect(worker.setAppBadge).toHaveBeenLastCalledWith(2);
	});

	it("rejects malformed completion batches without exposing their content", async () => {
		const worker = loadWorker();

		for (const malformed of [
			{
				kind: "work_finished",
				sessionIds: ["session-2", "session-2"],
			},
			{
				kind: "work_finished",
				sessionIds: ["session-1", "session-2"],
				deliveryIds: [DELIVERY_ID, DELIVERY_ID_2, DELIVERY_ID_3],
				batchId: "batch-test-123",
			},
			{
				kind: "work_finished",
				sessionIds: ["session-1", "session-2"],
				deliveryIds: [DELIVERY_ID, DELIVERY_ID],
				batchId: "batch-test-123",
			},
			{
				kind: "work_finished",
				sessionIds: ["session-1", "session-2"],
				deliveryIds: [DELIVERY_ID, DELIVERY_ID_2],
				deliveryId: DELIVERY_ID,
				batchId: "batch-test-123",
			},
			{
				kind: "work_finished",
				deliveryIds: [DELIVERY_ID, DELIVERY_ID_2],
			},
		]) {
			await dispatchPush(worker.handlers.push, validPayload(malformed));
		}

		expect(worker.showNotification).toHaveBeenCalledTimes(5);
		for (const [title, options] of worker.showNotification.mock.calls) {
			expect(title).toBe("Hlid notification");
			expect(options).toMatchObject({ tag: "hlid-generic" });
		}
	});

	it("falls back when displaying validated content fails", async () => {
		const worker = loadWorker();
		worker.showNotification
			.mockRejectedValueOnce(new Error("unsupported option"))
			.mockResolvedValueOnce(undefined);

		await dispatchPush(worker.handlers.push, validPayload());

		expect(worker.showNotification).toHaveBeenCalledTimes(2);
		expect(worker.showNotification.mock.calls[1]).toEqual([
			"Hlid notification",
			expect.objectContaining({
				body: "Open Hlid to check for updates.",
				tag: "hlid-generic",
			}),
		]);
	});

	it("closes only the validated notification tag for the opened session", async () => {
		const matching = {
			tag: "hlid-session:session-1",
			data: validPayload(),
			close: vi.fn(),
		};
		const forgedData = {
			tag: "hlid-session:session-1",
			data: validPayload({ sessionId: "session-2" }),
			close: vi.fn(),
		};
		const other = {
			tag: "hlid-session:session-2",
			data: validPayload({ sessionId: "session-2" }),
			close: vi.fn(),
		};
		const worker = loadWorker([], [matching, forgedData, other]);

		await dispatchMessage(worker.handlers.message, {
			type: "hlid:close-session-notifications",
			sessionId: "session-1",
		});

		expect(worker.getNotifications).toHaveBeenCalledWith({
			tag: "hlid-session:session-1",
		});
		expect(matching.close).toHaveBeenCalledOnce();
		expect(forgedData.close).not.toHaveBeenCalled();
		expect(other.close).not.toHaveBeenCalled();
		expect(worker.setAppBadge).toHaveBeenLastCalledWith(1);
	});

	it("reconciles the badge from displayed Hlid notifications on app focus", async () => {
		const current = {
			tag: "hlid-session:session-1",
			data: validPayload(),
			close: vi.fn(),
		};
		const test = {
			tag: "hlid-test",
			data: { ...validPayload(), kind: "test", sessionId: undefined },
			close: vi.fn(),
		};
		const worker = loadWorker([], [current, test]);

		await dispatchMessage(worker.handlers.message, {
			type: "hlid:reconcile-notification-badge",
		});

		expect(worker.setAppBadge).toHaveBeenLastCalledWith(1);
	});

	it("rejects invalid close-session messages", async () => {
		const displayed = {
			tag: "hlid-session:session-1",
			data: validPayload(),
			close: vi.fn(),
		};
		const worker = loadWorker([], [displayed]);

		await dispatchMessage(worker.handlers.message, {
			type: "hlid:close-session-notifications",
			sessionId: "bad\nidentifier",
		});

		expect(displayed.close).not.toHaveBeenCalled();
	});

	it("clears the badge when app presence closes the final session alert", async () => {
		const matching = {
			tag: "hlid-session:session-1",
			data: validPayload(),
			close: vi.fn(),
		};
		const worker = loadWorker([], [matching]);

		await dispatchMessage(worker.handlers.message, {
			type: "hlid:close-session-notifications",
			sessionId: "session-1",
		});

		expect(matching.close).toHaveBeenCalledOnce();
		expect(worker.clearAppBadge).toHaveBeenCalled();
	});

	it("prunes expired Hlid notifications whenever the worker wakes", async () => {
		const expired = {
			tag: "hlid-session:expired",
			data: validPayload({ sessionId: "expired", expiresAt: Date.now() - 1 }),
			close: vi.fn(),
		};
		const current = {
			tag: "hlid-session:current",
			data: validPayload({ sessionId: "current" }),
			close: vi.fn(),
		};
		const worker = loadWorker([], [expired, current]);

		await dispatchWaitable(worker.handlers.activate);
		await dispatchPush(worker.handlers.push, validPayload());
		await dispatchClick(worker.handlers.notificationclick, {
			sessionId: "session-1",
			url: "/raven?session=session-1",
		});

		expect(expired.close).toHaveBeenCalledOnce();
		expect(current.close).not.toHaveBeenCalled();
	});

	it("clears the badge after the final displayed notification is dismissed", async () => {
		const worker = loadWorker();
		await dispatchPush(worker.handlers.push, validPayload());
		const shown = worker.activeNotifications[0];
		if (!shown) throw new Error("notification was not displayed");

		(shown.close as () => void)();
		await dispatchClose(worker.handlers.notificationclose, shown);

		expect(worker.clearAppBadge).toHaveBeenCalled();
	});

	it("replaces an unsafe payload URL with an exact same-origin Raven link", async () => {
		const worker = loadWorker();

		await dispatchPush(
			worker.handlers.push,
			validPayload({ url: "https://attacker.test/raven?session=session-1" }),
		);

		const options = worker.showNotification.mock.calls[0]?.[1] as
			| { data?: { url?: string } }
			| undefined;
		expect(options?.data?.url).toBe("/raven?session=session-1");
	});

	it("keeps only a bounded attention-card target on Raven links", async () => {
		const worker = loadWorker();

		await dispatchPush(
			worker.handlers.push,
			validPayload({
				url: "/raven?session=session-1&attention=plan_review&agent=child#prompt",
			}),
		);

		const options = worker.showNotification.mock.calls[0]?.[1] as
			| { data?: { url?: string } }
			| undefined;
		expect(options?.data?.url).toBe(
			"/raven?session=session-1&attention=plan_review",
		);
	});

	it("uses the live router in a reported standalone PWA without reloading it", async () => {
		const standaloneClient = {
			id: "standalone-client-1",
			url: "https://hlid.test/forge",
			navigate: vi.fn(),
			focus: vi.fn().mockResolvedValue(undefined),
			postMessage: navigationAcknowledgement(),
		};
		const websiteClient = {
			id: "browser-client-1",
			url: "https://hlid.test/raven",
			navigate: vi.fn(),
			focus: vi.fn(),
		};
		const worker = loadWorker([websiteClient, standaloneClient]);
		await dispatchMessage(
			worker.handlers.message,
			{ type: "hlid:client-presentation", standalone: true },
			standaloneClient,
		);
		await dispatchWaitable(worker.handlers.activate);

		await dispatchClick(worker.handlers.notificationclick, {
			sessionId: "session-1",
			url: "/raven?session=session-1",
		});

		expect(standaloneClient.focus).toHaveBeenCalledOnce();
		expect(standaloneClient.postMessage).toHaveBeenCalledWith(
			{
				type: "hlid:navigate-notification",
				version: 1,
				url: "/raven?session=session-1",
			},
			expect.arrayContaining([expect.anything()]),
		);
		expect(standaloneClient.navigate).not.toHaveBeenCalled();
		expect(websiteClient.navigate).not.toHaveBeenCalled();
		expect(worker.openWindow).not.toHaveBeenCalled();
	});

	it("falls back to WindowClient navigation when a live page does not acknowledge", async () => {
		const websiteClient = {
			url: "https://hlid.test/forge",
			navigate: vi.fn().mockResolvedValue(undefined),
			focus: vi.fn().mockResolvedValue(undefined),
			postMessage: vi.fn(),
		};
		const worker = loadWorker([websiteClient]);

		vi.useFakeTimers();
		const click = dispatchClick(worker.handlers.notificationclick, {
			sessionId: "session-1",
			url: "/raven?session=session-1",
		});
		await vi.advanceTimersByTimeAsync(2_001);
		await click;
		vi.useRealTimers();

		expect(websiteClient.focus).toHaveBeenCalledOnce();
		expect(websiteClient.postMessage).toHaveBeenCalledOnce();
		expect(websiteClient.navigate).toHaveBeenCalledWith(
			"/raven?session=session-1&notification_open=1",
		);
		expect(worker.openWindow).not.toHaveBeenCalled();
	});

	it("keeps a background PWA focused when its direct navigation handle is stale", async () => {
		const backgroundPwa = {
			url: "https://hlid.test/forge",
			focus: vi.fn(),
			navigate: vi.fn().mockRejectedValue(new Error("stale window handle")),
			postMessage: vi.fn(() => {
				throw new Error("stale message handle");
			}),
		};
		backgroundPwa.focus.mockResolvedValue(backgroundPwa);
		const worker = loadWorker([backgroundPwa]);

		await dispatchClick(worker.handlers.notificationclick, {
			sessionId: "session-1",
			url: "/raven?session=session-1",
		});

		expect(backgroundPwa.focus).toHaveBeenCalledOnce();
		expect(backgroundPwa.navigate).toHaveBeenCalledWith(
			"/raven?session=session-1&notification_open=1",
		);
		expect(backgroundPwa.postMessage).toHaveBeenCalledWith(
			{
				type: "hlid:navigate-notification",
				version: 1,
				url: "/raven?session=session-1",
			},
			expect.arrayContaining([expect.anything()]),
		);
		expect(worker.openWindow).not.toHaveBeenCalled();
	});

	it("opens a safe window only after a stale client cannot focus or navigate", async () => {
		const staleClient = {
			url: "https://hlid.test/forge",
			focus: vi.fn().mockRejectedValue(new Error("gone")),
			navigate: vi.fn().mockRejectedValue(new Error("gone")),
			postMessage: vi.fn(() => {
				throw new Error("gone");
			}),
		};
		const worker = loadWorker([staleClient]);

		await dispatchClick(worker.handlers.notificationclick, {
			sessionId: "session-1",
			url: "/raven?session=session-1",
		});

		expect(staleClient.focus).toHaveBeenCalledOnce();
		expect(staleClient.navigate).toHaveBeenCalledWith(
			"/raven?session=session-1&notification_open=1",
		);
		expect(worker.openWindow).toHaveBeenCalledWith(
			"https://hlid.test/raven?session=session-1&notification_open=1",
		);
	});

	it("falls back to navigating and focusing an existing Hlid website", async () => {
		const focusedClient = { focus: vi.fn().mockResolvedValue(undefined) };
		const existingClient = {
			url: "https://hlid.test/forge",
			navigate: vi.fn().mockResolvedValue(focusedClient),
			focus: vi.fn(),
		};
		const worker = loadWorker([existingClient]);

		const { close } = await dispatchClick(worker.handlers.notificationclick, {
			sessionId: "session-1",
			url: "/raven?session=session-1",
		});

		expect(close).toHaveBeenCalledOnce();
		expect(existingClient.navigate).toHaveBeenCalledWith(
			"/raven?session=session-1&notification_open=1",
		);
		expect(focusedClient.focus).toHaveBeenCalledOnce();
		expect(worker.openWindow).not.toHaveBeenCalled();
		expect(worker.clearAppBadge).toHaveBeenCalled();
	});

	it("opens the safe Hlid root from a generic fallback", async () => {
		const focusedClient = { focus: vi.fn().mockResolvedValue(undefined) };
		const existingClient = {
			url: "https://hlid.test/raven?session=session-1",
			navigate: vi.fn().mockResolvedValue(focusedClient),
			focus: vi.fn(),
		};
		const worker = loadWorker([existingClient]);
		await dispatchRawPush(worker.handlers.push);
		const fallbackData = worker.showNotification.mock.calls[0]?.[1]?.data;

		await dispatchClick(worker.handlers.notificationclick, fallbackData);

		expect(existingClient.navigate).toHaveBeenCalledWith("/");
		expect(focusedClient.focus).toHaveBeenCalledOnce();
		expect(worker.openWindow).not.toHaveBeenCalled();
	});

	it("opens a new exact Raven window when no Hlid window exists", async () => {
		const worker = loadWorker([
			{ url: "https://elsewhere.test/", focus: vi.fn() },
		]);

		await dispatchClick(worker.handlers.notificationclick, {
			sessionId: "session / two",
			url: "javascript:alert(1)",
		});

		expect(worker.openWindow).toHaveBeenCalledWith(
			"https://hlid.test/raven?session=session+%2F+two&notification_open=1",
		);
	});

	it("best-effort resubscribes after a browser subscription rotation", async () => {
		const worker = loadWorker();
		const publicKeyBytes = Uint8Array.from({ length: 65 }, (_, index) =>
			index === 0 ? 4 : index,
		);
		const publicKey = Buffer.from(publicKeyBytes).toString("base64url");
		const replacement = {
			toJSON: () => ({
				endpoint: "https://push.test/replacement",
				expirationTime: null,
				keys: { p256dh: "new-p256dh", auth: "new-auth" },
			}),
		};
		worker.pushSubscribe.mockResolvedValue(replacement);
		worker.fetchMock.mockImplementation(async (path) => {
			if (path === "/api/push/config") {
				return new Response(JSON.stringify({ available: true, publicKey }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		await dispatchSubscriptionChange(worker.handlers.pushsubscriptionchange, {
			endpoint: "https://push.test/original",
		});

		const subscribeOptions = worker.pushSubscribe.mock.calls[0]?.[0];
		expect(subscribeOptions?.userVisibleOnly).toBe(true);
		expect(
			Array.from(
				new Uint8Array(subscribeOptions?.applicationServerKey as ArrayBuffer),
			),
		).toEqual(Array.from(publicKeyBytes));
		const postCall = worker.fetchMock.mock.calls.find(
			([path]) => path === "/api/push/subscriptions",
		);
		expect(postCall?.[1]).toMatchObject({
			method: "POST",
			credentials: "same-origin",
		});
		expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
			subscription: {
				endpoint: "https://push.test/replacement",
				expirationTime: null,
				keys: { p256dh: "new-p256dh", auth: "new-auth" },
			},
			replaces_endpoint: "https://push.test/original",
		});
	});

	it("registers a browser-provided replacement when old details are unavailable", async () => {
		const worker = loadWorker();
		const replacement = {
			toJSON: () => ({
				endpoint: "https://push.test/replacement",
				expirationTime: null,
				keys: { p256dh: "new-p256dh", auth: "new-auth" },
			}),
		};
		worker.fetchMock.mockResolvedValue(
			Response.json({ ok: true }, { status: 200 }),
		);

		await dispatchSubscriptionChange(
			worker.handlers.pushsubscriptionchange,
			undefined,
			replacement,
		);

		expect(worker.pushSubscribe).not.toHaveBeenCalled();
		expect(worker.fetchMock).toHaveBeenCalledTimes(1);
		const postCall = worker.fetchMock.mock.calls[0];
		expect(postCall?.[0]).toBe("/api/push/subscriptions");
		expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
			subscription: {
				endpoint: "https://push.test/replacement",
				expirationTime: null,
				keys: { p256dh: "new-p256dh", auth: "new-auth" },
			},
		});
	});

	it("prefers a browser-provided replacement over creating another one", async () => {
		const worker = loadWorker();
		const replacement = {
			endpoint: "https://push.test/replacement",
			expirationTime: null,
			keys: { p256dh: "new-p256dh", auth: "new-auth" },
		};
		worker.fetchMock.mockResolvedValue(
			Response.json({ ok: true }, { status: 200 }),
		);

		await dispatchSubscriptionChange(
			worker.handlers.pushsubscriptionchange,
			{ endpoint: "https://push.test/original" },
			replacement,
		);

		expect(worker.pushSubscribe).not.toHaveBeenCalled();
		expect(worker.fetchMock).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse(String(worker.fetchMock.mock.calls[0]?.[1]?.body)),
		).toEqual({
			subscription: replacement,
			replaces_endpoint: "https://push.test/original",
		});
	});

	it.each([
		undefined,
		{},
		{ endpoint: "http://push.test/original" },
		{ endpoint: "https://user:secret@push.test/original" },
		{ endpoint: "https://push.test/original#fragment" },
	])("does not rotate without a validated old endpoint", async (oldSubscription) => {
		const worker = loadWorker();

		await dispatchSubscriptionChange(
			worker.handlers.pushsubscriptionchange,
			oldSubscription,
		);

		expect(worker.fetchMock).not.toHaveBeenCalled();
		expect(worker.pushSubscribe).not.toHaveBeenCalled();
	});

	it("checks a failed replacement response before leaving foreground repair in charge", async () => {
		const worker = loadWorker();
		const publicKeyBytes = Uint8Array.from({ length: 65 }, (_, index) =>
			index === 0 ? 4 : index,
		);
		const publicKey = Buffer.from(publicKeyBytes).toString("base64url");
		let registrationStatusChecked = false;
		worker.pushSubscribe.mockResolvedValue({
			toJSON: () => ({
				endpoint: "https://push.test/replacement",
				expirationTime: null,
				keys: { p256dh: "new-p256dh", auth: "new-auth" },
			}),
		});
		worker.fetchMock.mockImplementation(async (path) => {
			if (path === "/api/push/config") {
				return new Response(JSON.stringify({ available: true, publicKey }), {
					status: 200,
				});
			}
			return {
				get ok() {
					registrationStatusChecked = true;
					return false;
				},
			} as Response;
		});

		await dispatchSubscriptionChange(worker.handlers.pushsubscriptionchange, {
			endpoint: "https://push.test/original",
		});

		expect(registrationStatusChecked).toBe(true);
		expect(worker.fetchMock).toHaveBeenCalledWith(
			"/api/push/subscriptions",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("keeps the shared schema aligned with the worker's session source contract", () => {
		expect(
			webPushNotificationPayloadSchema.safeParse(validPayload()).success,
		).toBe(true);
		expect(
			webPushNotificationPayloadSchema.safeParse(
				validPayload({ source: "session" }),
			).success,
		).toBe(false);
		expect(
			webPushNotificationPayloadSchema.safeParse(
				validPayload({ reminder: true }),
			).success,
		).toBe(false);
	});

	it("leaves subscription rotation to foreground reconciliation after failures", async () => {
		const worker = loadWorker();
		worker.fetchMock.mockRejectedValue(new Error("offline"));

		await expect(
			dispatchSubscriptionChange(worker.handlers.pushsubscriptionchange, {
				endpoint: "https://push.test/original",
			}),
		).resolves.toBeUndefined();
		expect(worker.pushSubscribe).not.toHaveBeenCalled();
	});

	it("ships a transparent monochrome badge asset", () => {
		const badge = readFileSync(
			resolve(process.cwd(), "public/notification-badge.svg"),
			"utf8",
		);

		expect(badge).toContain("<svg");
		expect(badge).not.toMatch(/(?:fill|stroke)=["']#[0-9a-f]+["']/i);
	});

	it("declares navigate-existing launch handling for installed PWAs", () => {
		const manifest = JSON.parse(
			readFileSync(resolve(process.cwd(), "public/manifest.json"), "utf8"),
		) as { launch_handler?: { client_mode?: string } };

		expect(manifest.launch_handler?.client_mode).toBe("navigate-existing");
	});
});
