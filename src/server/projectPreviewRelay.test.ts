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
	projectPreviewSelectionCookieHeader,
	projectPreviewSelectionRedirect,
	projectPreviewUpstreamTarget,
	projectPreviewWebSocketProtocols,
	selectedProjectPreviewId,
	selectedProjectPreviewRelayUrl,
} from "./projectPreviewRelay";

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
		},
	): Promise<number> {
		const server = createServer((request, response) => {
			const result = handler(request.url ?? "/", request.headers);
			response.writeHead(200, {
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
			body: '<!doctype html><head></head><script>window.$_TSR={router:{manifest:{routes:{__root__:{preloads:["/assets/app.js"],scripts:[{attrs:{type:"module",src:"/assets/app.js"}}]}}}}}</script><script type="module" src="/assets/app.js"></script><link href="/src/app.css">',
		}));
		const response = await handleProjectPreviewRelayRequest(
			new URL(
				"http://hlid/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/",
			),
			new Request("http://hlid/relay"),
			() => ({ port }),
		);
		const text = await response?.text();
		expect(response?.status).toBe(200);
		expect(text).toContain(
			'src="/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/assets/app.js"',
		);
		expect(text).not.toContain('src:"/assets/app.js"');
		expect(text).toContain(
			'src:"/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/assets/app.js"',
		);
		expect(text).toContain("NativeWebSocket");
		expect(text).toContain(
			'url.pathname==="/ws"||url.pathname.startsWith("/ws/")',
		);
		expect(text).toContain(
			'url.pathname=p+(backendSocket?"/__hlid_backend__":"")+url.pathname',
		);
		expect(text).toContain("hlid:project-preview-state");
		expect(text).toContain("scroll_x");
		expect(text).toContain("document.currentScript?.remove()");
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

	it("rewrites module imports without corrupting regular expressions", async () => {
		const port = await upstream(() => ({
			contentType: "text/javascript",
			body: 'import value from "/src/value.js"; const fenced = /```[\\s\\S]*?```/g; export default value;',
		}));
		const response = await handleProjectPreviewRelayRequest(
			new URL(
				"http://hlid/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/src/main.js",
			),
			new Request("http://hlid/relay"),
			() => ({ port }),
		);
		const text = await response?.text();
		expect(text).toContain(
			'import value from "/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/src/value.js"',
		);
		expect(text).toContain("const fenced = /```[\\s\\S]*?```/g");
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
			() => ({ port }),
		);
		const second = await handleProjectPreviewRelayRequest(
			url,
			new Request("http://hlid/relay"),
			() => ({ port }),
		);

		expect(await first?.text()).toContain("export default 1");
		expect(await second?.text()).toContain("export default 1");
		expect(requests).toBe(2);

		disposeProjectPreviewRelay(previewId);
		const afterDispose = await handleProjectPreviewRelayRequest(
			url,
			new Request("http://hlid/relay"),
			() => ({ port }),
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
			() => ({ port: address.port }),
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
				upstreamHeaders: { cookie: "app_session=preview-secret" },
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
				},
			}),
			() => ({ port }),
		);
		expect(receivedHeaders.authorization).toBeUndefined();
		expect(receivedHeaders.cookie).toBeUndefined();
		expect(receivedHeaders["x-hlid-internal"]).toBeUndefined();
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
			() => ({ port }),
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
			() => ({ port }),
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
