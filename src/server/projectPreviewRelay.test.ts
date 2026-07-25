import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createProjectPreviewRelayWsHandlers,
	handleProjectPreviewRelayRequest,
	parseProjectPreviewRelayPath,
	parseProjectPreviewRelayWebSocket,
} from "./projectPreviewRelay";

describe("Project Preview relay", () => {
	const servers: ReturnType<typeof createServer>[] = [];

	afterEach(async () => {
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
		) => { body: string; contentType: string },
	): Promise<number> {
		const server = createServer((request, response) => {
			const result = handler(request.url ?? "/", request.headers);
			response.writeHead(200, { "content-type": result.contentType });
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

	it("rewrites root assets and injects the WebSocket relay bootstrap", async () => {
		const port = await upstream(() => ({
			contentType: "text/html; charset=utf-8",
			body: '<!doctype html><head></head><script type="module" src="/@vite/client"></script><link href="/src/app.css">',
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
			'src="/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/@vite/client"',
		);
		expect(text).toContain("NativeWebSocket");
	});

	it("relays queued and live hot-reload messages in both directions", () => {
		type FakeBackend = {
			readyState: number;
			sent: Array<string | ArrayBuffer>;
			closed: boolean;
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
			onopen: (() => void) | null = null;
			onmessage: ((event: { data: string }) => void) | null = null;
			onclose: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor(_url: string) {
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
			},
			readyState: FakeWebSocket.OPEN,
			send: vi.fn(),
			close: vi.fn(),
		};

		handlers.open(front as never);
		const backend = backends[0];
		if (!backend) throw new Error("Preview backend was not opened.");
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
