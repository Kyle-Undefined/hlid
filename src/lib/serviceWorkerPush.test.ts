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
	notification: { data: unknown; close(): void };
};

type HandlerMap = {
	activate?: (event: WaitableEvent) => void;
	message?: (event: WaitableEvent & { data: unknown; ports: never[] }) => void;
	push?: (event: PushEvent) => void;
	notificationclick?: (event: NotificationClickEvent) => void;
};

function loadWorker(
	windowClients: Array<Record<string, unknown>> = [],
	displayedNotifications: Array<Record<string, unknown>> = [],
) {
	const handlers: HandlerMap = {};
	const showNotification = vi.fn().mockResolvedValue(undefined);
	const openWindow = vi.fn().mockResolvedValue(undefined);
	const setAppBadge = vi.fn().mockResolvedValue(undefined);
	const clearAppBadge = vi.fn().mockResolvedValue(undefined);
	const getNotifications = vi.fn(async ({ tag }: { tag?: string } = {}) =>
		tag
			? displayedNotifications.filter(
					(notification) => notification.tag === tag,
				)
			: displayedNotifications,
	);
	const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
	runInNewContext(source, {
		URL,
		Response,
		Promise,
		fetch: vi.fn(),
		setTimeout,
		clearTimeout,
		caches: {
			match: vi.fn().mockResolvedValue(undefined),
			open: vi.fn().mockResolvedValue({ add: vi.fn(), put: vi.fn() }),
			keys: vi.fn().mockResolvedValue([]),
			delete: vi.fn(),
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
	if (!handlers.push || !handlers.notificationclick)
		throw new Error("service worker notification handlers were not registered");
	return {
		handlers: handlers as Required<HandlerMap>,
		showNotification,
		getNotifications,
		openWindow,
		setAppBadge,
		clearAppBadge,
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
): Promise<void> {
	let work: Promise<unknown> | undefined;
	handler({
		data,
		ports: [],
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
): Promise<{ close: ReturnType<typeof vi.fn> }> {
	let work: Promise<unknown> | undefined;
	const close = vi.fn();
	handler({
		notification: { data, close },
		waitUntil(promise) {
			work = promise;
		},
	});
	if (work) await work;
	return { close };
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
		expect(worker.setAppBadge).not.toHaveBeenCalled();
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

		expect(expired.close).toHaveBeenCalledTimes(3);
		expect(current.close).not.toHaveBeenCalled();
	});

	it("replaces an unsafe payload URL with an exact same-origin Raven link", async () => {
		const worker = loadWorker();

		await dispatchPush(
			worker.handlers.push,
			validPayload({ url: "https://attacker.test/raven?session=session-1" }),
		);

		expect(worker.showNotification.mock.calls[0]?.[1]?.data.url).toBe(
			"/raven?session=session-1",
		);
	});

	it("navigates and focuses an existing Hlid window on click", async () => {
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
		expect(worker.openWindow).not.toHaveBeenCalled();
		expect(worker.clearAppBadge).not.toHaveBeenCalled();
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
			"/raven?session=session+%2F+two",
		);
	});
});
