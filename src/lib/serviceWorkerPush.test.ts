import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

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
		fetch: vi.fn(),
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
		!handlers.notificationclick ||
		!handlers.notificationclose
	)
		throw new Error("service worker notification handlers were not registered");
	return {
		handlers: handlers as Required<HandlerMap>,
		showNotification,
		getNotifications,
		openWindow,
		setAppBadge,
		clearAppBadge,
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
			validPayload({ body: "The same session still needs attention." }),
		);

		expect(worker.showNotification).toHaveBeenCalledTimes(2);
		const [title, options] = worker.showNotification.mock.calls[0] ?? [];
		expect(title).toBe("Hlid needs your attention");
		expect(options).toMatchObject({
			body: "A session is waiting for you.",
			tag: "hlid-session:session-1",
			renotify: false,
			data: {
				sessionId: "session-1",
				url: "/raven?session=session-1",
			},
		});
		expect(options).not.toHaveProperty("actions");
		expect(worker.showNotification.mock.calls[1]?.[1]?.tag).toBe(
			"hlid-session:session-1",
		);
		expect(worker.setAppBadge).toHaveBeenLastCalledWith(1);
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

	it("groups a completion batch as one badge item and opens Raven overview", async () => {
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
					batchId: "batch-test-123",
					url: "/raven",
				}),
			}),
		);
		expect(worker.setAppBadge).toHaveBeenLastCalledWith(1);

		await dispatchClick(worker.handlers.notificationclick, shown?.data, shown);

		expect(existingClient.navigate).toHaveBeenCalledWith("/raven");
		expect(worker.clearAppBadge).toHaveBeenCalled();
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

		await dispatchPush(
			worker.handlers.push,
			validPayload({
				kind: "work_finished",
				sessionIds: ["session-2", "session-2"],
			}),
		);

		expect(worker.showNotification).toHaveBeenCalledWith(
			"Hlid notification",
			expect.objectContaining({ tag: "hlid-generic" }),
		);
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

	it("navigates a reported standalone PWA before any browser window", async () => {
		const focusedPwa = { focus: vi.fn().mockResolvedValue(undefined) };
		const standaloneClient = {
			id: "standalone-client-1",
			url: "https://hlid.test/forge",
			navigate: vi.fn().mockResolvedValue(focusedPwa),
			focus: vi.fn(),
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

		expect(standaloneClient.navigate).toHaveBeenCalledWith(
			"/raven?session=session-1",
		);
		expect(focusedPwa.focus).toHaveBeenCalledOnce();
		expect(websiteClient.navigate).not.toHaveBeenCalled();
		expect(worker.openWindow).not.toHaveBeenCalled();
	});

	it("lets the browser launch or reuse the installed PWA before a website tab", async () => {
		const installedClient = { focus: vi.fn().mockResolvedValue(undefined) };
		const websiteClient = {
			url: "https://hlid.test/forge",
			navigate: vi.fn(),
			focus: vi.fn(),
		};
		const worker = loadWorker([websiteClient]);
		worker.openWindow.mockResolvedValue(installedClient);

		await dispatchClick(worker.handlers.notificationclick, {
			sessionId: "session-1",
			url: "/raven?session=session-1",
		});

		expect(worker.openWindow).toHaveBeenCalledWith("/raven?session=session-1");
		expect(installedClient.focus).toHaveBeenCalledOnce();
		expect(websiteClient.navigate).not.toHaveBeenCalled();
		expect(websiteClient.focus).not.toHaveBeenCalled();
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
			"/raven?session=session-1",
		);
		expect(focusedClient.focus).toHaveBeenCalledOnce();
		expect(worker.openWindow).toHaveBeenCalledWith("/raven?session=session-1");
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
		expect(worker.openWindow).toHaveBeenCalledWith("/");
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
			"/raven?session=session+%2F+two",
		);
	});

	it("declares navigate-existing launch handling for installed PWAs", () => {
		const manifest = JSON.parse(
			readFileSync(resolve(process.cwd(), "public/manifest.json"), "utf8"),
		) as { launch_handler?: { client_mode?: string } };

		expect(manifest.launch_handler?.client_mode).toBe("navigate-existing");
	});
});
