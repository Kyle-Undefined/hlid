import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { Server } from "bun";
import { chromium } from "playwright";
import {
	createProjectPreviewAgentRelay,
	PROJECT_PREVIEW_AGENT_RELAY_MAX_REQUEST_BYTES,
	type ProjectPreviewAgentRelay,
} from "./projectPreviewAgentRelay";
import { PROJECT_PREVIEW_AUTH_HEADER } from "./projectPreviewTrust";

type BackendWebSocketData = {
	auth: string | null;
	cookie: string | null;
	path: string;
};

async function childServers(): Promise<{
	ui: Server<undefined>;
	uiPort: number;
	backend: Server<BackendWebSocketData>;
	httpHeaders: () => Headers;
	backendData: () => BackendWebSocketData | null;
}> {
	return childServersWithHtml(
		"<!doctype html><html><head></head><body>child ui</body></html>",
	);
}

async function childServersWithHtml(
	html: string,
	workerScript?: string,
): Promise<{
	ui: Server<undefined>;
	uiPort: number;
	backend: Server<BackendWebSocketData>;
	httpHeaders: () => Headers;
	backendData: () => BackendWebSocketData | null;
}> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		let seenHttpHeaders = new Headers();
		let seenBackendData: BackendWebSocketData | null = null;
		const ui = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				seenHttpHeaders = new Headers(request.headers);
				if (new URL(request.url).pathname === "/worker.js" && workerScript) {
					return new Response(workerScript, {
						headers: {
							"content-type": "text/javascript; charset=utf-8",
						},
					});
				}
				return new Response(html, {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			},
		});
		const uiPort = ui.port;
		if (!uiPort || uiPort >= 65_535) {
			ui.stop(true);
			continue;
		}
		try {
			const backend = Bun.serve<BackendWebSocketData>({
				hostname: "127.0.0.1",
				port: uiPort + 1,
				fetch(request, server) {
					const url = new URL(request.url);
					seenBackendData = {
						auth: request.headers.get(PROJECT_PREVIEW_AUTH_HEADER),
						cookie: request.headers.get("cookie"),
						path: url.pathname,
					};
					if (
						request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
						server.upgrade(request, {
							data: {
								...seenBackendData,
							},
						})
					) {
						return undefined;
					}
					return new Response("Upgrade required", { status: 426 });
				},
				websocket: {
					open(socket) {
						socket.send("ready");
					},
					message() {},
				},
			});
			return {
				ui,
				uiPort,
				backend,
				httpHeaders: () => new Headers(seenHttpHeaders),
				backendData: () => seenBackendData,
			};
		} catch {
			ui.stop(true);
		}
	}
	throw new Error("Could not allocate adjacent child preview ports.");
}

describe("Project Preview agent relay integration", () => {
	test("injects child auth into real HTTP and adjacent-port WebSocket upgrades", async () => {
		const child = await childServers();
		const capability = { token: "private-child-capability" };
		let relay: ProjectPreviewAgentRelay | null = null;
		let socket: WebSocket | null = null;
		try {
			relay = await createProjectPreviewAgentRelay({
				targetPort: child.uiPort,
				capability,
			});
			const { browserAccess } = relay;
			const cookie = `${browserAccess.cookieName}=${browserAccess.cookieToken}; app_session=visible`;

			const unauthorized = await fetch(browserAccess.origin);
			expect(unauthorized.status).toBe(401);

			const response = await fetch(`${browserAccess.origin}/settings`, {
				headers: {
					cookie,
					[PROJECT_PREVIEW_AUTH_HEADER]: "spoofed",
					"x-hlid-internal": "spoofed",
					"x-hlid-proxy-token": "spoofed",
				},
			});
			const html = await response.text();
			expect(response.status).toBe(200);
			expect(child.httpHeaders().get(PROJECT_PREVIEW_AUTH_HEADER)).toBe(
				capability.token,
			);
			expect(child.httpHeaders().get("cookie")).toBe("app_session=visible");
			expect(child.httpHeaders().get("x-hlid-internal")).toBeNull();
			expect(child.httpHeaders().get("x-hlid-proxy-token")).toBeNull();
			expect(html).toContain("/__hlid_backend__");
			expect(html).not.toContain(capability.token);
			expect(html).not.toContain(browserAccess.cookieName);
			expect(html).not.toContain(browserAccess.cookieToken);
			expect(response.headers.get("content-security-policy")).toContain(
				"connect-src 'self'",
			);
			const oversized = await fetch(`${browserAccess.origin}/api/prompt`, {
				method: "POST",
				headers: { cookie },
				body: new Uint8Array(PROJECT_PREVIEW_AGENT_RELAY_MAX_REQUEST_BYTES + 1),
			});
			expect(oversized.status).toBe(413);

			const WebSocketWithHeaders = WebSocket as unknown as new (
				url: string,
				options: { headers: Record<string, string> },
			) => WebSocket;
			socket = new WebSocketWithHeaders(
				`${browserAccess.origin.replace(/^http/, "ws")}/__hlid_backend__/ws`,
				{
					headers: {
						cookie,
						[PROJECT_PREVIEW_AUTH_HEADER]: "spoofed",
					},
				},
			);
			const message = await new Promise<string>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("Timed out waiting for relayed WebSocket")),
					5_000,
				);
				socket?.addEventListener("message", (event) => {
					clearTimeout(timeout);
					resolve(String(event.data));
				});
				socket?.addEventListener("error", () => {
					clearTimeout(timeout);
					reject(new Error("Relayed WebSocket failed"));
				});
			});
			expect(message).toBe("ready");
			expect(child.backendData()).toEqual({
				auth: capability.token,
				cookie: "app_session=visible",
				path: "/ws",
			});
		} finally {
			socket?.close();
			await relay?.close();
			child.backend.stop(true);
			child.ui.stop(true);
		}
	});

	test.skipIf(!existsSync(chromium.executablePath()))(
		"uses the random localhost relay and rewrites a child Hlid port+1 WebSocket in Chromium",
		async () => {
			let externalRequests = 0;
			const external = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request, server) {
					externalRequests++;
					if (server.upgrade(request)) return undefined;
					return new Response("Upgrade required", { status: 426 });
				},
				websocket: {
					open() {},
					message() {},
				},
			});
			const externalPort = external.port;
			if (!externalPort) throw new Error("External test port was unavailable");
			const externalUrl = `ws://127.0.0.1:${externalPort}/escape`;
			const child = await childServersWithHtml(
				`<!doctype html><html><head></head><body>child ui<script>const socket=new WebSocket("ws://"+location.hostname+":"+(Number(location.port)+1)+"/ws");socket.onmessage=(event)=>document.body.dataset.ws=event.data;socket.onerror=()=>document.body.dataset.ws="error";const external=new WebSocket(${JSON.stringify(externalUrl)});external.onopen=()=>document.body.dataset.external="opened";external.onerror=()=>document.body.dataset.external="blocked";const worker=new Worker("/worker.js");worker.onmessage=(event)=>document.body.dataset.worker=event.data;worker.onerror=()=>document.body.dataset.worker="error";</script></body></html>`,
				`const socket=new WebSocket(${JSON.stringify(externalUrl)});socket.onopen=()=>postMessage("opened");socket.onerror=()=>postMessage("blocked");`,
			);
			const capability = { token: "private-browser-child-capability" };
			let relay: ProjectPreviewAgentRelay | null = null;
			const browser = await chromium.launch({ headless: true });
			try {
				relay = await createProjectPreviewAgentRelay({
					targetPort: child.uiPort,
					capability,
				});
				const { browserAccess } = relay;
				const context = await browser.newContext();
				await context.addCookies([
					{
						name: browserAccess.cookieName,
						value: browserAccess.cookieToken,
						url: browserAccess.origin,
						httpOnly: true,
						sameSite: "Strict",
					},
				]);
				const page = await context.newPage();
				const response = await page.goto(browserAccess.origin, {
					waitUntil: "domcontentloaded",
				});
				expect(response?.status()).toBe(200);
				await page.waitForFunction(
					() =>
						document.body.dataset.ws === "ready" &&
						document.body.dataset.external === "blocked" &&
						document.body.dataset.worker === "blocked",
					undefined,
					{ timeout: 5_000 },
				);

				expect(child.httpHeaders().get(PROJECT_PREVIEW_AUTH_HEADER)).toBe(
					capability.token,
				);
				expect(child.backendData()).toEqual({
					auth: capability.token,
					cookie: null,
					path: "/ws",
				});
				expect(await page.evaluate(() => document.cookie)).not.toContain(
					browserAccess.cookieName,
				);
				const content = await page.content();
				expect(content).not.toContain(capability.token);
				expect(content).not.toContain(browserAccess.cookieName);
				expect(content).not.toContain(browserAccess.cookieToken);
				expect(externalRequests).toBe(0);
				await context.close();
			} finally {
				await browser.close();
				await relay?.close();
				child.backend.stop(true);
				child.ui.stop(true);
				external.stop(true);
			}
		},
		20_000,
	);
});
