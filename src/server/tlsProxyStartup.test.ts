import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({
	X509Certificate: class {
		subjectAltName = "DNS:hlid.test";
	},
}));

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(() => Buffer.from("test certificate")),
}));

vi.mock("../lib/lifecycle", () => ({
	registerBunServer: vi.fn(),
}));

vi.mock("./auth", () => ({
	authenticateRequest: vi.fn(),
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
		back: TestBackendSocket | null;
		queue: (string | ArrayBuffer)[];
	};
	close: ReturnType<typeof vi.fn>;
};

let captured: CapturedServerOptions;
let upstreamFetch: ReturnType<typeof vi.fn>;

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
			captured = options;
			return { stop: vi.fn() };
		}),
	});
	vi.mocked(authenticateRequest).mockResolvedValue(true);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("TLS proxy server boundary", () => {
	it("starts with the configured TLS and request limits", () => {
		start();

		expect(Bun.serve).toHaveBeenCalledOnce();
		expect(captured).toMatchObject({
			port: 3443,
			hostname: "127.0.0.1",
			idleTimeout: 75,
			maxRequestBodySize: 4096,
		});
		expect(registerBunServer).toHaveBeenCalledOnce();
	});

	it("enforces peer, origin, authentication, and WebSocket route checks", async () => {
		start();

		const forbiddenPeer = await captured.fetch(
			websocketRequest("/ws"),
			requestServer("203.0.113.4"),
		);
		expect(forbiddenPeer?.status).toBe(403);

		const wrongRoute = await captured.fetch(
			websocketRequest("/not-websocket"),
			requestServer(),
		);
		expect(wrongRoute?.status).toBe(400);

		const forbiddenOrigin = await captured.fetch(
			websocketRequest("/ws", "https://evil.example"),
			requestServer(),
		);
		expect(forbiddenOrigin?.status).toBe(403);

		vi.mocked(authenticateRequest).mockResolvedValueOnce(false);
		const unauthorized = await captured.fetch(
			websocketRequest("/ws/session-1", "https://localhost"),
			requestServer(),
		);
		expect(unauthorized?.status).toBe(401);

		const failedUpgradeServer = requestServer("127.0.0.1", false);
		const failedUpgrade = await captured.fetch(
			websocketRequest("/ws/session-1?tail=1", "https://localhost"),
			failedUpgradeServer,
		);
		expect(failedUpgrade?.status).toBe(500);

		const upgradedServer = requestServer();
		const upgraded = await captured.fetch(
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
		const response = await captured.fetch(
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
		captured.websocket.message(client, "hello");
		expect(openBackend.send).toHaveBeenCalledWith("hello");

		const connectingBackend: TestBackendSocket = {
			readyState: WebSocket.CONNECTING,
			send: vi.fn(),
			close: vi.fn(),
		};
		client.data.back = connectingBackend;
		for (let index = 0; index < 101; index++) {
			captured.websocket.message(client, new Uint8Array([index]));
		}
		expect(client.data.queue).toHaveLength(100);
		expect(client.data.queue[0]).toBeInstanceOf(ArrayBuffer);

		client.data.back = {
			readyState: WebSocket.CLOSED,
			send: vi.fn(),
			close: vi.fn(),
		};
		captured.websocket.message(client, "late");
		expect(client.close).toHaveBeenCalledOnce();

		captured.websocket.close(client);
		expect(client.data.back.close).toHaveBeenCalledOnce();
	});
});
