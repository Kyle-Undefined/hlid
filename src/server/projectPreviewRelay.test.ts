import {
	createServer,
	type IncomingHttpHeaders,
	type OutgoingHttpHeaders,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createProjectPreviewRelayWsHandlers,
	disposeProjectPreviewRelay,
	handleProjectPreviewRelayRequest,
	parseProjectPreviewRelayPath,
	parseProjectPreviewRelayWebSocket,
	projectPreviewRelayWebSocketHeaders,
	projectPreviewSelectionCookieHeader,
	projectPreviewSelectionRedirect,
	projectPreviewUpstreamTarget,
	projectPreviewWebSocketProtocols,
	selectedProjectPreviewId,
	selectedProjectPreviewRelayUrl,
} from "./projectPreviewRelay";
import { PROJECT_PREVIEW_AUTH_HEADER } from "./projectPreviewTrust";

const capability = { token: "preview-auth-test-token" };

describe("Project Preview relay", () => {
	const servers: ReturnType<typeof createServer>[] = [];

	afterEach(async () => {
		disposeProjectPreviewRelay();
		await Promise.all(
			servers.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
		);
		servers.length = 0;
		vi.unstubAllGlobals();
	});

	async function upstream(
		handler: (
			path: string,
			headers: IncomingHttpHeaders,
		) => {
			body: string;
			contentType: string;
			headers?: OutgoingHttpHeaders;
			status?: number;
		},
	): Promise<number> {
		const server = createServer((request, response) => {
			const result = handler(request.url ?? "/", request.headers);
			response.writeHead(result.status ?? 200, {
				"content-type": result.contentType,
				...result.headers,
			});
			response.end(result.body);
		});
		servers.push(server);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", () => resolve()),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No port");
		return address.port;
	}

	it("parses only a preview-scoped relay path", () => {
		expect(
			parseProjectPreviewRelayPath(
				"/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/src/main.ts",
			),
		).toEqual({
			previewId: "123e4567-e89b-12d3-a456-426614174000",
			targetPath: "/src/main.ts",
			prefix:
				"/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay",
		});
		expect(
			parseProjectPreviewRelayPath("/api/project-previews/relay"),
		).toBeNull();
	});

	it("leaves ordinary HTTP relay requests for the HTTP handler", () => {
		const path =
			"/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/";
		expect(
			parseProjectPreviewRelayWebSocket(
				new Request(`http://hlid${path}`),
				path,
			),
		).toBeNull();
		expect(
			parseProjectPreviewRelayWebSocket(
				new Request(`http://hlid${path}`, {
					headers: { upgrade: "websocket" },
				}),
				path,
			),
		).toEqual(
			expect.objectContaining({
				previewId: "123e4567-e89b-12d3-a456-426614174000",
				targetPath: "/",
			}),
		);
	});

	it("preserves WebSocket subprotocols for hot-reload relays", () => {
		expect(
			projectPreviewWebSocketProtocols(
				new Request("http://hlid/relay", {
					headers: { "sec-websocket-protocol": "vite-hmr, vite-ping" },
				}),
			),
		).toEqual(["vite-hmr", "vite-ping"]);
		expect(
			projectPreviewWebSocketProtocols(new Request("http://hlid/relay")),
		).toBeUndefined();
	});

	it("rewrites root assets and injects the WebSocket relay bootstrap", async () => {
		const port = await upstream(() => ({
			contentType: "text/html; charset=utf-8",
			body: '<!doctype html><head></head><body><a href="/settings">Settings</a><script class = "$tsr">window.$_TSR={router:{manifest:$R[1]={routes:{__root__:{preloads:$R[4]=["/@id/virtual:tanstack-start-dev-client-entry","/assets/app.js"],scripts:[{attrs:{type:"module",src:"/@id/virtual:tanstack-start-dev-client-entry"}}],css:[{href:"/@tanstack-start/styles.css?routes=__root__"}]}}},matches:$R[10]=[$R[11]={loaderData:$R[12]={href:"/docs",src:"/avatar.png",preloads:["/semantic"]}}]}}</script><script type="module" src="/@id/virtual:tanstack-start-dev-client-entry"></script><script src="/assets/app.js"></script><link href="/src/app.css"></body>',
		}));
		const response = await handleProjectPreviewRelayRequest(
			new URL(
				"http://hlid/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/",
			),
			new Request("http://hlid/relay"),
			() => ({ port, capability }),
		);
		const text = await response?.text();
		expect(response?.status).toBe(200);
		expect(text).toContain(
			'src="/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/assets/app.js"',
		);
		expect(text).toContain(
			'href="/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/settings"',
		);
		expect(text).not.toContain('src:"/assets/app.js"');
		expect(text).toContain(
			'preloads:$R[4]=["/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/@id/virtual:tanstack-start-dev-client-entry","/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/assets/app.js"]',
		);
		expect(text).not.toContain(
			'src:"/@id/virtual:tanstack-start-dev-client-entry"',
		);
		expect(text).toContain(
			'src:"/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/@id/virtual:tanstack-start-dev-client-entry"',
		);
		expect(text).not.toContain(
			'href:"/@tanstack-start/styles.css?routes=__root__"',
		);
		expect(text).toContain(
			'href:"/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/@tanstack-start/styles.css?routes=__root__"',
		);
		expect(text).toContain(
			'loaderData:$R[12]={href:"/docs",src:"/avatar.png",preloads:["/semantic"]}',
		);
		expect(text).toContain("NativeWebSocket");
		expect(text).toContain(
			'url.pathname==="/ws"||url.pathname.startsWith("/ws/")',
		);
		expect(text).toContain('b=c?"/__hlid_backend__":p+"/__hlid_backend__"');
		expect(text).toContain("url.pathname=b+url.pathname");
		expect(text).toContain("hlid:project-preview-state");
		expect(text).toContain("scroll_x");
		expect(text?.match(/document\.currentScript\?\.remove\(\)/g)).toHaveLength(
			2,
		);
		expect(text).toContain(
			"Service workers are disabled in Hlid Project Preview.",
		);
		expect(text).toContain("registration.unregister()");
		const guardIndex =
			text?.indexOf("Service workers are disabled in Hlid Project Preview.") ??
			-1;
		const appScriptIndex = text?.indexOf('src="/api/project-previews/') ?? -1;
		expect(guardIndex).toBeGreaterThanOrEqual(0);
		expect(guardIndex).toBeLessThan(appScriptIndex);
	});

	it("keeps isolated-origin SSR URLs app-local through hydration", async () => {
		const previewId = "123e4567-e89b-12d3-a456-426614174000";
		const relayPrefix = `/api/project-previews/${previewId}/relay`;
		const port = await upstream(() => ({
			contentType: "text/html; charset=utf-8",
			body: '<!doctype html><html><head><link rel="stylesheet" href="/src/app.css"></head><body><a href="/settings">Settings</a><form action="/save"><button>Save</button></form><script class="$tsr">window.$_TSR={router:{manifest:$R[1]={routes:{__root__:{preloads:$R[4]=["/@id/client","/assets/app.js"],scripts:[{attrs:{src:"/@id/client"}}],css:[{href:"/src/app.css"}]}}}}}</script><script type="module" src="/@id/client"></script></body></html>',
		}));
		const response = await handleProjectPreviewRelayRequest(
			new URL(`http://hlid${relayPrefix}/settings`),
			new Request("https://preview.test/settings", {
				headers: { "x-hlid-preview-origin": "1" },
			}),
			() => ({ port, capability }),
		);
		const text = await response?.text();

		expect(response?.status).toBe(200);
		expect(text).toContain('<link rel="stylesheet" href="/src/app.css">');
		expect(text).toContain('<a href="/settings">Settings</a>');
		expect(text).toContain('<form action="/save">');
		expect(text).toContain('<script type="module" src="/@id/client">');
		expect(text).toContain('preloads:$R[4]=["/@id/client","/assets/app.js"]');
		expect(text).toContain('scripts:[{attrs:{src:"/@id/client"}}]');
		expect(text).toContain('css:[{href:"/src/app.css"}]');
		expect(text).toContain(
			`const p=${JSON.stringify(relayPrefix)},i=${JSON.stringify(previewId)},c=true`,
		);
		expect(text).toContain('b=c?"/__hlid_backend__":p+"/__hlid_backend__"');
		expect(text).toContain("url.pathname=b+url.pathname");
		expect(text).toContain("if(!c&&!url.pathname.startsWith(p))");
		expect(text).toContain("preview_id:i");
		expect(text).toContain(
			'const pathname=!c&&location.pathname.startsWith(p)?location.pathname.slice(p.length)||"/":location.pathname',
		);
	});

	it("rewrites module imports without corrupting regular expressions", async () => {
		const port = await upstream(() => ({
			contentType: "text/javascript",
			body: 'import value from "/src/value.js"; const $$splitComponentImporter=()=>import("/src/routes/login.tsx?tsr-split=component"); const fenced = /```[\\s\\S]*?```/g; export default value;',
		}));
		const response = await handleProjectPreviewRelayRequest(
			new URL(
				"http://hlid/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/src/main.js",
			),
			new Request("http://hlid/relay"),
			() => ({ port, capability }),
		);
		const text = await response?.text();
		expect(text).toContain(
			'import value from "/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/src/value.js"',
		);
		expect(text).toContain(
			'import("/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/src/routes/login.tsx?tsr-split=component")',
		);
		expect(text).toContain("const fenced = /```[\\s\\S]*?```/g");
	});

	it("keeps isolated module URLs app-local without sharing prefixed cache entries", async () => {
		const previewId = "123e4567-e89b-12d3-a456-426614174000";
		const relayPrefix = `/api/project-previews/${previewId}/relay`;
		let requests = 0;
		const port = await upstream(() => {
			requests++;
			return {
				contentType: "text/javascript",
				body: 'import value from "/src/value.js"; export default value;',
				headers: { etag: '"shared-between-relay-modes"' },
			};
		});
		const url = new URL(`http://hlid${relayPrefix}/src/main.js`);
		const isolated = await handleProjectPreviewRelayRequest(
			url,
			new Request("https://preview.test/src/main.js", {
				headers: { "x-hlid-preview-origin": "1" },
			}),
			() => ({ port, capability }),
		);
		const prefixed = await handleProjectPreviewRelayRequest(
			url,
			new Request("http://hlid/relay/src/main.js"),
			() => ({ port, capability }),
		);

		expect(await isolated?.text()).toContain(
			'import value from "/src/value.js"',
		);
		expect(await prefixed?.text()).toContain(
			`import value from "${relayPrefix}/src/value.js"`,
		);
		expect(requests).toBe(2);
	});

	it("keeps isolated root redirects app-local", async () => {
		const previewId = "123e4567-e89b-12d3-a456-426614174000";
		const relayPrefix = `/api/project-previews/${previewId}/relay`;
		const port = await upstream(() => ({
			status: 302,
			contentType: "text/plain; charset=utf-8",
			body: "",
			headers: { location: "/login?next=%2Fsettings" },
		}));
		const isolated = await handleProjectPreviewRelayRequest(
			new URL(`http://hlid${relayPrefix}/settings`),
			new Request("https://preview.test/settings", {
				headers: { "x-hlid-preview-origin": "1" },
			}),
			() => ({ port, capability }),
		);
		const prefixed = await handleProjectPreviewRelayRequest(
			new URL(`http://hlid${relayPrefix}/settings`),
			new Request("http://hlid/relay/settings"),
			() => ({ port, capability }),
		);

		expect(isolated?.headers.get("location")).toBe("/login?next=%2Fsettings");
		expect(prefixed?.headers.get("location")).toBe(
			`${relayPrefix}/login?next=%2Fsettings`,
		);
	});

	it("reuses bounded transformed modules while the upstream ETag is stable", async () => {
		const previewId = "123e4567-e89b-12d3-a456-426614174000";
		let requests = 0;
		const port = await upstream(() => {
			requests++;
			return {
				contentType: "text/javascript",
				body: `export default ${requests};`,
				headers: { etag: '"stable-module"' },
			};
		});
		const url = new URL(
			`http://hlid/api/project-previews/${previewId}/relay/src/main.js`,
		);
		const first = await handleProjectPreviewRelayRequest(
			url,
			new Request("http://hlid/relay"),
			() => ({ port, capability }),
		);
		const second = await handleProjectPreviewRelayRequest(
			url,
			new Request("http://hlid/relay"),
			() => ({ port, capability }),
		);

		expect(await first?.text()).toContain("export default 1");
		expect(await second?.text()).toContain("export default 1");
		expect(requests).toBe(2);

		disposeProjectPreviewRelay(previewId);
		const afterDispose = await handleProjectPreviewRelayRequest(
			url,
			new Request("http://hlid/relay"),
			() => ({ port, capability }),
		);
		expect(await afterDispose?.text()).toContain("export default 3");
	});

	it("aborts outstanding upstream work when a preview is disposed", async () => {
		const previewId = "123e4567-e89b-12d3-a456-426614174000";
		let requestStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});
		const server = createServer(() => {
			requestStarted?.();
			// Deliberately leave the response open until relay disposal aborts fetch.
		});
		servers.push(server);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", () => resolve()),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No port");
		const pending = handleProjectPreviewRelayRequest(
			new URL(
				`http://hlid/api/project-previews/${previewId}/relay/src/slow.js`,
			),
			new Request("http://hlid/relay"),
			() => ({ port: address.port, capability }),
		);
		await started;
		disposeProjectPreviewRelay(previewId);

		expect((await pending)?.status).toBe(499);
	});

	it("relays queued and live hot-reload messages in both directions", () => {
		type FakeBackend = {
			readyState: number;
			sent: Array<string | ArrayBuffer>;
			closed: boolean;
			headers: Record<string, string>;
			protocols?: string[];
			onopen: (() => void) | null;
			onmessage: ((event: { data: string }) => void) | null;
			onclose: (() => void) | null;
			onerror: (() => void) | null;
			send: (message: string | ArrayBuffer) => void;
			close: () => void;
		};
		const backends: FakeBackend[] = [];
		class FakeWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSED = 3;
			readyState = FakeWebSocket.CONNECTING;
			sent: Array<string | ArrayBuffer> = [];
			closed = false;
			headers: Record<string, string>;
			protocols?: string[];
			onopen: (() => void) | null = null;
			onmessage: ((event: { data: string }) => void) | null = null;
			onclose: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor(
				_url: string,
				options?: {
					headers: Record<string, string>;
					protocols?: string[];
				},
			) {
				this.headers = options?.headers ?? {};
				this.protocols = options?.protocols;
				backends.push(this);
			}
			send(message: string | ArrayBuffer) {
				this.sent.push(message);
			}
			close() {
				this.closed = true;
				this.readyState = FakeWebSocket.CLOSED;
			}
		}
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const handlers = createProjectPreviewRelayWsHandlers();
		const front = {
			data: {
				isProjectPreviewRelay: true as const,
				wsTarget: "ws://127.0.0.1:5173/hmr",
				back: null,
				queue: [],
				upstreamHeaders: projectPreviewRelayWebSocketHeaders(
					new Request("http://hlid/relay", {
						headers: {
							cookie:
								"__hlid_preview_123e4567e89b12d3a456426614174000__app_session=preview-secret",
							[PROJECT_PREVIEW_AUTH_HEADER]: "spoofed",
						},
					}),
					"123e4567-e89b-12d3-a456-426614174000",
					capability,
				),
				protocols: ["vite-hmr"],
			},
			readyState: FakeWebSocket.OPEN,
			send: vi.fn(),
			close: vi.fn(),
		};

		handlers.open(front as never);
		const backend = backends[0];
		if (!backend) throw new Error("Preview backend was not opened.");
		expect(backend.headers).toEqual({
			cookie: "app_session=preview-secret",
			[PROJECT_PREVIEW_AUTH_HEADER]: capability.token,
		});
		expect(backend.protocols).toEqual(["vite-hmr"]);
		handlers.message(front as never, "before-open");
		expect(front.data.queue).toEqual(["before-open"]);

		backend.readyState = FakeWebSocket.OPEN;
		backend.onopen?.();
		expect(backend.sent).toEqual(["before-open"]);
		expect(front.data.queue).toEqual([]);

		handlers.message(front as never, "source-changed");
		expect(backend.sent).toEqual(["before-open", "source-changed"]);
		backend.onmessage?.({ data: "hmr-update" });
		expect(front.send).toHaveBeenCalledWith("hmr-update");

		handlers.close(front as never);
		expect(backend.closed).toBe(true);
	});

	it("does not forward Hlid credentials to the development server", async () => {
		let receivedHeaders: IncomingHttpHeaders = {};
		const port = await upstream((_path, headers) => {
			receivedHeaders = headers;
			return { contentType: "application/json", body: "{}" };
		});
		await handleProjectPreviewRelayRequest(
			new URL(
				"http://hlid/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/api",
			),
			new Request("http://hlid/relay", {
				headers: {
					authorization: "Bearer secret",
					cookie: "hlid_session=secret",
					"x-hlid-internal": "secret",
					[PROJECT_PREVIEW_AUTH_HEADER]: "spoofed",
				},
			}),
			() => ({ port, capability }),
		);
		expect(receivedHeaders.authorization).toBeUndefined();
		expect(receivedHeaders.cookie).toBeUndefined();
		expect(receivedHeaders["x-hlid-internal"]).toBeUndefined();
		expect(receivedHeaders[PROJECT_PREVIEW_AUTH_HEADER]).toBe(capability.token);
		expect(receivedHeaders.origin).toBe(`http://127.0.0.1:${port}`);
	});

	it("isolates preview app cookies and returns them to the upstream app", async () => {
		const previewId = "123e4567-e89b-12d3-a456-426614174000";
		const relayPrefix = `/api/project-previews/${previewId}/relay`;
		let receivedHeaders: IncomingHttpHeaders = {};
		const port = await upstream((_path, headers) => {
			receivedHeaders = headers;
			return {
				contentType: "application/json",
				body: "{}",
				headers: {
					"set-cookie": [
						"app_session=preview-secret; Path=/; HttpOnly; SameSite=Lax",
						"theme=dark; Path=/settings; Domain=example.test",
					],
				},
			};
		});
		const initial = await handleProjectPreviewRelayRequest(
			new URL(`http://hlid${relayPrefix}/login`),
			new Request("http://hlid/relay"),
			() => ({ port, capability }),
		);
		const setCookies = (
			initial?.headers as Headers & { getSetCookie?: () => string[] }
		).getSetCookie?.();
		expect(setCookies).toEqual([
			expect.stringContaining(
				"__hlid_preview_123e4567e89b12d3a456426614174000__app_session=preview-secret",
			),
			expect.stringContaining(
				"__hlid_preview_123e4567e89b12d3a456426614174000__theme=dark",
			),
		]);
		for (const value of setCookies ?? []) {
			expect(value).toContain("Path=/");
			expect(value).not.toMatch(/\bDomain=/i);
		}

		await handleProjectPreviewRelayRequest(
			new URL(`http://hlid${relayPrefix}/api/me`),
			new Request("http://hlid/relay", {
				headers: {
					cookie:
						"hlid_session=parent-secret; __hlid_preview_123e4567e89b12d3a456426614174000__app_session=preview-secret; unrelated=private",
				},
			}),
			() => ({ port, capability }),
		);
		expect(receivedHeaders.cookie).toBe("app_session=preview-secret");
	});

	it("selects a preview for root-path navigation on the isolated origin", () => {
		const previewId = "123e4567-e89b-12d3-a456-426614174000";
		const opening = new URL(
			`http://hlid/api/project-previews/${previewId}/relay/settings?__hlid_preview_open=1&tab=display`,
		);
		const redirect = projectPreviewSelectionRedirect(opening, () => ({
			port: 4173,
			capability,
		}));
		expect(redirect?.status).toBe(302);
		expect(redirect?.headers.get("location")).toBe("/settings?tab=display");
		const cookie = redirect?.headers.get("set-cookie") ?? "";
		expect(selectedProjectPreviewId(cookie)).toBe(previewId);

		const selected = selectedProjectPreviewRelayUrl(
			new URL("http://hlid/settings?tab=display"),
			cookie,
		);
		expect(selected?.pathname).toBe(
			`/api/project-previews/${previewId}/relay/settings`,
		);
		expect(selected?.search).toBe("?tab=display");
	});

	it("replaces a stale preview selection while preserving other cookies", () => {
		expect(
			projectPreviewSelectionCookieHeader(
				"hlid_session=parent; __hlid_preview_selection=old; theme=dark",
				"123e4567-e89b-12d3-a456-426614174000",
			),
		).toBe(
			"hlid_session=parent; theme=dark; __hlid_preview_selection=123e4567-e89b-12d3-a456-426614174000",
		);
	});

	it("routes an adjacent full-stack backend through the same preview", () => {
		expect(projectPreviewUpstreamTarget(4173, "/__hlid_backend__/ws")).toEqual({
			port: 4174,
			path: "/ws",
		});
		expect(projectPreviewUpstreamTarget(4173, "/src/main.ts")).toEqual({
			port: 4173,
			path: "/src/main.ts",
		});
	});

	it("refuses a relay ID that is not owned by a live preview", async () => {
		const response = await handleProjectPreviewRelayRequest(
			new URL(
				"http://hlid/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/",
			),
			new Request("http://hlid/relay"),
			() => {
				throw new Error("Project preview is not running.");
			},
		);
		expect(response?.status).toBe(404);
	});
});
