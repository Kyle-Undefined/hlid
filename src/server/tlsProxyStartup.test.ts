import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		X509Certificate: class {
			subjectAltName = "DNS:hlid.test";
		},
	};
});

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(() => Buffer.from("test certificate")),
}));

vi.mock("../lib/lifecycle", () => ({
	registerBunServer: vi.fn(),
}));

vi.mock("./auth", () => ({
	authenticateRequest: vi.fn(),
	readCookie: vi.fn((request: Request, name = "hlid_session") => {
		for (const cookie of (request.headers.get("cookie") ?? "").split(/;\s*/)) {
			const equals = cookie.indexOf("=");
			if (equals >= 0 && cookie.slice(0, equals) === name) {
				return cookie.slice(equals + 1);
			}
		}
		return null;
	}),
}));

import { registerBunServer } from "../lib/lifecycle";
import { authenticateRequest } from "./auth";
import { startTlsProxy } from "./tlsProxy";

type CapturedServerOptions = {
	port: number;
	hostname: string;
	idleTimeout: number;
	maxRequestBodySize: number;
	fetch: (
		request: Request,
		server: {
			requestIP: (request: Request) => { address: string } | null;
			upgrade: (request: Request, options: unknown) => boolean;
		},
	) => Promise<Response | undefined>;
	websocket: {
		open: (ws: TestClientSocket) => void;
		message: (ws: TestClientSocket, data: string | Uint8Array) => void;
		close: (ws: TestClientSocket) => void;
	};
};

type TestBackendSocket = {
	readyState: number;
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
};

type TestClientSocket = {
	data: {
		wsTarget?: string;
		back: TestBackendSocket | null;
		queue: (string | ArrayBuffer)[];
		forwardHeaders?: Record<string, string>;
		protocols?: string[];
	};
	close: ReturnType<typeof vi.fn>;
};

let captured: CapturedServerOptions[];
let upstreamFetch: ReturnType<typeof vi.fn>;

function mainServer(): CapturedServerOptions {
	const server = captured.find(({ port }) => port === 3443);
	if (!server) throw new Error("Main TLS server was not started.");
	return server;
}

function previewServer(): CapturedServerOptions {
	const server = captured.find(({ port }) => port === 3444);
	if (!server) throw new Error("Preview TLS server was not started.");
	return server;
}

function start(): void {
	startTlsProxy({
		tlsPort: 3443,
		uiPort: 3000,
		wsPort: 3001,
		bindHost: "127.0.0.1",
		certPath: "/tmp/test-cert.pem",
		keyPath: "/tmp/test-key.pem",
		localNetworkAccess: false,
		internalToken: "internal-secret",
		maxBodyBytes: 4096,
	});
}

function requestServer(address = "127.0.0.1", upgraded = true) {
	return {
		requestIP: vi.fn(() => ({ address })),
		upgrade: vi.fn(() => upgraded),
	};
}

function websocketRequest(path: string, origin?: string): Request {
	return new Request(`https://hlid.test${path}`, {
		headers: {
			upgrade: "websocket",
			...(origin ? { origin } : {}),
		},
	});
}

beforeEach(() => {
	captured = [];
	upstreamFetch = vi.fn(async () => new Response("forwarded"));
	vi.stubGlobal("fetch", upstreamFetch);
	vi.stubGlobal("WebSocket", {
		CONNECTING: 0,
		OPEN: 1,
		CLOSING: 2,
		CLOSED: 3,
	});
	vi.stubGlobal("Bun", {
		file: vi.fn((path: string) => path),
		serve: vi.fn((options: CapturedServerOptions) => {
			captured.push(options);
			return { stop: vi.fn() };
		}),
	});
	vi.mocked(authenticateRequest).mockResolvedValue(true);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("TLS proxy server boundary", () => {
	it("starts with the configured TLS and request limits", () => {
		start();

		expect(Bun.serve).toHaveBeenCalledTimes(2);
		expect(mainServer()).toMatchObject({
			port: 3443,
			hostname: "127.0.0.1",
			idleTimeout: 75,
			maxRequestBodySize: 4096,
		});
		expect(previewServer()).toMatchObject({
			port: 3444,
			hostname: "127.0.0.1",
			idleTimeout: 75,
			maxRequestBodySize: 4096,
		});
		expect(registerBunServer).toHaveBeenCalledTimes(2);
	});

	it("enforces peer, origin, authentication, and WebSocket route checks", async () => {
		start();
		const main = mainServer();

		const forbiddenPeer = await main.fetch(
			websocketRequest("/ws"),
			requestServer("203.0.113.4"),
		);
		expect(forbiddenPeer?.status).toBe(403);

		const wrongRoute = await main.fetch(
			websocketRequest("/not-websocket"),
			requestServer(),
		);
		expect(wrongRoute?.status).toBe(400);

		const forbiddenOrigin = await main.fetch(
			websocketRequest("/ws", "https://evil.example"),
			requestServer(),
		);
		expect(forbiddenOrigin?.status).toBe(403);

		vi.mocked(authenticateRequest).mockResolvedValueOnce(false);
		const unauthorized = await main.fetch(
			websocketRequest("/ws/session-1", "https://localhost"),
			requestServer(),
		);
		expect(unauthorized?.status).toBe(401);

		const failedUpgradeServer = requestServer("127.0.0.1", false);
		const failedUpgrade = await main.fetch(
			websocketRequest("/ws/session-1?tail=1", "https://localhost"),
			failedUpgradeServer,
		);
		expect(failedUpgrade?.status).toBe(500);

		const upgradedServer = requestServer();
		const upgraded = await main.fetch(
			websocketRequest("/ws/session-1?tail=1", "https://localhost"),
			upgradedServer,
		);
		expect(upgraded).toBeUndefined();
		expect(upgradedServer.upgrade).toHaveBeenCalledWith(expect.any(Request), {
			data: {
				wsTarget: "ws://127.0.0.1:3001/ws/session-1?tail=1",
				back: null,
				queue: [],
			},
		});
	});

	it("forwards an allowed HTTP request with trusted proxy metadata", async () => {
		start();
		const response = await mainServer().fetch(
			new Request("https://hlid.test/api/private?view=full"),
			requestServer(),
		);

		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe("forwarded");
		expect(upstreamFetch).toHaveBeenCalledOnce();
		const [target, init] = upstreamFetch.mock.calls[0];
		expect(target).toBe("http://127.0.0.1:3000/api/private?view=full");
		const headers = new Headers(init.headers);
		expect(headers.get("x-hlid-forwarded-client-ip")).toBe("127.0.0.1");
		expect(headers.get("x-hlid-proxy-token")).toBe("internal-secret");
		expect(headers.get("accept-encoding")).toBe("identity");
	});

	it("sends, bounds, and closes WebSocket bridge messages by backend state", () => {
		start();
		const client: TestClientSocket = {
			data: { back: null, queue: [] },
			close: vi.fn(),
		};
		const openBackend: TestBackendSocket = {
			readyState: WebSocket.OPEN,
			send: vi.fn(),
			close: vi.fn(),
		};
		client.data.back = openBackend;
		mainServer().websocket.message(client, "hello");
		expect(openBackend.send).toHaveBeenCalledWith("hello");

		const connectingBackend: TestBackendSocket = {
			readyState: WebSocket.CONNECTING,
			send: vi.fn(),
			close: vi.fn(),
		};
		client.data.back = connectingBackend;
		for (let index = 0; index < 101; index++) {
			mainServer().websocket.message(client, new Uint8Array([index]));
		}
		expect(client.data.queue).toHaveLength(100);
		expect(client.data.queue[0]).toBeInstanceOf(ArrayBuffer);

		client.data.back = {
			readyState: WebSocket.CLOSED,
			send: vi.fn(),
			close: vi.fn(),
		};
		mainServer().websocket.message(client, "late");
		expect(client.close).toHaveBeenCalledOnce();

		mainServer().websocket.close(client);
		expect(client.data.back.close).toHaveBeenCalledOnce();
	});

	it("opens the WebSocket bridge with internal headers and times out a stalled backend", () => {
		vi.useFakeTimers();
		const backends: Array<{
			url: string;
			options: {
				headers: Record<string, string>;
				protocols?: string[];
			};
			readyState: number;
			send: ReturnType<typeof vi.fn>;
			close: ReturnType<typeof vi.fn>;
			onopen: (() => void) | null;
		}> = [];
		class FakeWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readonly url: string;
			readonly options: {
				headers: Record<string, string>;
				protocols?: string[];
			};
			readyState = FakeWebSocket.CONNECTING;
			send = vi.fn();
			close = vi.fn();
			onopen: (() => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onclose: (() => void) | null = null;
			onerror: (() => void) | null = null;

			constructor(
				url: string,
				options: {
					headers: Record<string, string>;
					protocols?: string[];
				},
			) {
				this.url = url;
				this.options = options;
				backends.push(this);
			}
		}
		vi.stubGlobal("WebSocket", FakeWebSocket);
		start();

		const connectedClient: TestClientSocket = {
			data: {
				wsTarget: "ws://127.0.0.1:3001/ws/connected",
				back: null,
				queue: ["queued"],
				forwardHeaders: { cookie: "hlid_session=preview" },
				protocols: ["vite-hmr"],
			},
			close: vi.fn(),
		};
		mainServer().websocket.open(connectedClient);
		const connectedBackend = backends[0];
		expect(connectedBackend).toMatchObject({
			url: "ws://127.0.0.1:3001/ws/connected",
			options: {
				headers: {
					"x-hlid-internal": "internal-secret",
					cookie: "hlid_session=preview",
				},
				protocols: ["vite-hmr"],
			},
		});
		connectedBackend?.onopen?.();
		expect(connectedBackend?.send).toHaveBeenCalledWith("queued");
		expect(connectedClient.data.queue).toEqual([]);

		const stalledClient: TestClientSocket = {
			data: {
				wsTarget: "ws://127.0.0.1:3001/ws/stalled",
				back: null,
				queue: ["stale"],
			},
			close: vi.fn(),
		};
		mainServer().websocket.open(stalledClient);
		const stalledBackend = backends[1];
		vi.advanceTimersByTime(10_000);
		expect(stalledClient.data.queue).toEqual([]);
		expect(stalledBackend?.close).toHaveBeenCalledOnce();
		expect(stalledClient.close).toHaveBeenCalledOnce();
	});

	it("isolates authenticated preview relay traffic on the adjacent TLS port", async () => {
		start();
		const preview = previewServer();

		const wrongRoute = await preview.fetch(
			new Request("https://hlid.test/api/private"),
			requestServer(),
		);
		expect(wrongRoute?.status).toBe(404);

		vi.mocked(authenticateRequest).mockResolvedValueOnce(false);
		const unauthorized = await preview.fetch(
			new Request(
				"https://hlid.test/api/project-previews/11111111-1111-4111-8111-111111111111/relay/",
			),
			requestServer(),
		);
		expect(unauthorized?.status).toBe(401);

		const response = await preview.fetch(
			new Request(
				"https://hlid.test/api/project-previews/11111111-1111-4111-8111-111111111111/relay/app",
			),
			requestServer(),
		);
		expect(response?.status).toBe(200);
		expect(upstreamFetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3001/api/project-previews/11111111-1111-4111-8111-111111111111/relay/app",
			expect.any(Object),
		);

		const selectedRoot = await preview.fetch(
			new Request("https://hlid.test/settings", {
				headers: {
					cookie:
						"hlid_session=parent; __hlid_preview_selection=11111111-1111-4111-8111-111111111111",
				},
			}),
			requestServer(),
		);
		expect(selectedRoot?.status).toBe(200);
		expect(upstreamFetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3001/settings",
			expect.any(Object),
		);

		await preview.fetch(
			new Request(
				"https://hlid.test/api/project-previews/22222222-2222-4222-8222-222222222222/relay/login?__hlid_preview_open=1",
				{ headers: { cookie: "hlid_session=mobile" } },
			),
			requestServer(),
		);
		const mobileRoot = await preview.fetch(
			new Request("https://hlid.test/login", {
				headers: { cookie: "hlid_session=mobile" },
			}),
			requestServer(),
		);
		expect(mobileRoot?.status).toBe(200);
		expect(upstreamFetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3001/login",
			expect.objectContaining({
				headers: expect.any(Headers),
				redirect: "manual",
			}),
		);
		const mobileHeaders = new Headers(
			upstreamFetch.mock.lastCall?.[1]?.headers,
		);
		expect(mobileHeaders.get("cookie")).toContain(
			"__hlid_preview_selection=22222222-2222-4222-8222-222222222222",
		);
		expect(mobileHeaders.get("x-hlid-preview-origin")).toBe("1");

		const upgradeServer = requestServer();
		const upgraded = await preview.fetch(
			new Request(
				"https://hlid.test/api/project-previews/11111111-1111-4111-8111-111111111111/relay/ws",
				{
					headers: {
						upgrade: "websocket",
						origin: "https://localhost",
						"sec-websocket-protocol": "vite-hmr",
						cookie:
							"hlid_session=parent; __hlid_preview_11111111111141118111111111111111__app_session=preview",
					},
				},
			),
			upgradeServer,
		);
		expect(upgraded).toBeUndefined();
		expect(upgradeServer.upgrade).toHaveBeenCalledWith(expect.any(Request), {
			data: {
				wsTarget:
					"ws://127.0.0.1:3001/api/project-previews/11111111-1111-4111-8111-111111111111/relay/ws",
				back: null,
				queue: [],
				protocols: ["vite-hmr"],
				forwardHeaders: {
					cookie:
						"hlid_session=parent; __hlid_preview_11111111111141118111111111111111__app_session=preview",
					"x-hlid-preview-origin": "1",
				},
			},
		});
	});
});
