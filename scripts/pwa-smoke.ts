import { existsSync } from "node:fs";
import { chromium, type CDPSession } from "playwright";

const CLIENT_DIR = new URL("../dist/client/", import.meta.url);
const WORKER_PATH = new URL("sw.js", CLIENT_DIR);
const OFFLINE_PATH = new URL("offline.html", CLIENT_DIR);
const TIMEOUT_MS = 15_000;

function requireBuildArtifact(url: URL): void {
	if (!existsSync(url)) {
		throw new Error(`Missing production PWA artifact: ${url.pathname}`);
	}
}

async function waitFor<T>(
	read: () => T | undefined | Promise<T | undefined>,
	label: string,
): Promise<T> {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

type WorkerRegistration = {
	registrationId: string;
	scopeURL: string;
	isDeleted: boolean;
};

async function registrationIdFor(
	cdp: CDPSession,
	origin: string,
	register: () => Promise<void>,
): Promise<string> {
	let matching: WorkerRegistration | undefined;
	cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => {
		matching = event.registrations.find(
			(candidate) =>
				!candidate.isDeleted && candidate.scopeURL === `${origin}/`,
		);
	});
	await cdp.send("ServiceWorker.enable");
	await register();
	return waitFor(() => matching?.registrationId, "service-worker registration");
}

requireBuildArtifact(WORKER_PATH);
requireBuildArtifact(OFFLINE_PATH);

const workerSource = await Bun.file(WORKER_PATH).text();
const build = workerSource.match(/^const BUILD = "([^"]+)";/m)?.[1];
if (!build || build === "__HLID_BUILD__") {
	throw new Error("The production service worker does not have a build stamp.");
}

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/sw.js") {
			return new Response(Bun.file(WORKER_PATH), {
				headers: {
					"content-type": "text/javascript; charset=utf-8",
					"service-worker-allowed": "/",
				},
			});
		}
		if (url.pathname === "/offline.html") {
			return new Response(Bun.file(OFFLINE_PATH), {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}
		if (url.pathname === "/api/push/receipts") {
			return new Response(null, { status: 204 });
		}
		if (url.pathname === "/notification-badge.svg" || url.pathname === "/logo192.png") {
			return new Response(null, { status: 204 });
		}
		return new Response(
			`<!doctype html><meta charset="utf-8"><title>Hlid PWA smoke</title><main data-smoke="online">online</main>`,
			{ headers: { "content-type": "text/html; charset=utf-8" } },
		);
	},
});

const origin = `http://${server.hostname}:${server.port}`;
// Playwright's minimal headless shell does not provide the App Badge service
// that the production worker probes during activation. The installed Chromium
// channel uses the full browser service surface while remaining headless.
const browser = await chromium.launch({ headless: true, channel: "chromium" });
let serverStopped = false;

try {
	const context = await browser.newContext();
	await context.grantPermissions(["notifications"], { origin });
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await page.goto(origin);

	const registrationId = await registrationIdFor(cdp, origin, async () => {
		await page.evaluate(async () => {
			await navigator.serviceWorker.register("/sw.js");
			await navigator.serviceWorker.ready;
		});
	});
	await waitFor(
		async () =>
			(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
				? true
				: undefined,
		"controlled page",
	);

	const reportedBuild = await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.ready;
		const worker = registration.active;
		if (!worker) return undefined;
		return new Promise<string | undefined>((resolve) => {
			const channel = new MessageChannel();
			const timeout = setTimeout(() => resolve(undefined), 2_000);
			channel.port1.onmessage = (event) => {
				clearTimeout(timeout);
				resolve(event.data?.build);
			};
			worker.postMessage({ type: "hlid:get-build" }, [channel.port2]);
		});
	});
	if (reportedBuild !== build) {
		throw new Error(`Worker reported build ${reportedBuild ?? "none"}; expected ${build}.`);
	}

	const now = Date.now();
	const payload = {
		version: 1,
		kind: "needs_attention",
		sessionId: "pwa-smoke-session",
		deliveryId: "00000000-0000-4000-8000-000000000001",
		reason: "question",
		title: "Hlid PWA smoke",
		body: "Real browser push delivery",
		createdAt: now,
		expiresAt: now + 60_000,
		url: "/raven?session=pwa-smoke-session&attention=question&attention_id=smoke-1",
	};
	await cdp.send("ServiceWorker.deliverPushMessage", {
		origin,
		registrationId,
		data: JSON.stringify(payload),
	});

	const notification = await waitFor(
		() =>
			page.evaluate(async () => {
				const registration = await navigator.serviceWorker.ready;
				const [item] = await registration.getNotifications({
					tag: "hlid-session:pwa-smoke-session",
				});
				if (!item) return undefined;
				return { title: item.title, tag: item.tag, data: item.data };
			}),
		"displayed push notification",
	);
	if (
		notification.title !== payload.title ||
		notification.tag !== "hlid-session:pwa-smoke-session" ||
		notification.data?.url !== payload.url
	) {
		throw new Error("The displayed push notification did not preserve its exact Raven target.");
	}

	await server.stop(true);
	serverStopped = true;
	await page.goto(`${origin}/offline-smoke`);
	const offlineText = await page.locator("body").innerText();
	if (!/unavailable|can't reach/i.test(offlineText)) {
		throw new Error("The service worker did not recover navigation with offline.html.");
	}

	console.log(
		JSON.stringify(
			{
				status: "passed",
				build,
				serviceWorker: "active",
				push: "displayed",
				target: notification.data.url,
				offlineNavigation: "recovered",
			},
			null,
			2,
		),
	);
} finally {
	await browser.close();
	if (!serverStopped) await server.stop(true);
}
