import { describe, expect, it, vi } from "vitest";
import {
	createAuthenticatedRouteHandler,
	createServerRequestPolicy,
} from "./serverRequestPolicy";

function request(path = "/resource", method = "GET", origin?: string) {
	return new Request(`http://localhost${path}`, {
		method,
		headers: origin ? { origin } : undefined,
	});
}

describe("authenticated route precedence", () => {
	function operations() {
		return {
			getStatus: vi.fn().mockReturnValue({ state: "idle" }),
			getApiIndex: vi.fn().mockReturnValue([{ path: "/status" }]),
			orderedHandlers: [vi.fn(), vi.fn()],
			getMcpStatus: vi.fn().mockReturnValue([]),
			handleDb: vi.fn(),
			handleAttachment: vi.fn(),
		};
	}

	it("serves fixed endpoints without invoking general route handlers", async () => {
		const ops = operations();
		const handler = createAuthenticatedRouteHandler(ops);
		expect(
			await (
				await handler(new URL("http://localhost/status"), request("/status"))
			).json(),
		).toEqual({ state: "idle" });
		expect(
			await (
				await handler(
					new URL("http://localhost/api-index"),
					request("/api-index"),
				)
			).json(),
		).toEqual([{ path: "/status" }]);
		expect(ops.orderedHandlers[0]).not.toHaveBeenCalled();
		expect(ops.handleDb).not.toHaveBeenCalled();
	});

	it("stops at the first specialized handler response", async () => {
		const ops = operations();
		const response = Response.json({ provider: true });
		vi.mocked(ops.orderedHandlers[0]).mockResolvedValue(response);
		const result = await createAuthenticatedRouteHandler(ops)(
			new URL("http://localhost/providers"),
			request("/providers"),
		);
		expect(result).toBe(response);
		expect(ops.orderedHandlers[1]).not.toHaveBeenCalled();
		expect(ops.handleDb).not.toHaveBeenCalled();
	});

	it("tries DB before attachments and stops when DB handles the route", async () => {
		const ops = operations();
		const response = Response.json({ rows: [] });
		vi.mocked(ops.handleDb).mockResolvedValue(response);
		const result = await createAuthenticatedRouteHandler(ops)(
			new URL("http://localhost/db/sessions"),
			request("/db/sessions"),
		);
		expect(result).toBe(response);
		expect(ops.handleAttachment).not.toHaveBeenCalled();
	});

	it("falls through to attachments and then a stable 404", async () => {
		const ops = operations();
		const attachment = new Response("file");
		vi.mocked(ops.handleAttachment).mockResolvedValueOnce(attachment);
		const handler = createAuthenticatedRouteHandler(ops);
		expect(
			await handler(
				new URL("http://localhost/attachments/a"),
				request("/attachments/a"),
			),
		).toBe(attachment);
		const missing = await handler(
			new URL("http://localhost/missing"),
			request("/missing"),
		);
		expect(missing.status).toBe(404);
		expect(await missing.text()).toBe("Not found");
	});
});

describe("server request security ordering", () => {
	function operations() {
		return {
			isPeerAllowed: vi.fn().mockReturnValue(true),
			isMutationOriginAllowed: vi.fn().mockReturnValue(true),
			handleWebSocket: vi.fn().mockResolvedValue(null),
			authorize: vi.fn().mockResolvedValue(true),
			handleAuthenticated: vi.fn().mockResolvedValue(new Response("ok")),
		};
	}

	it("rejects forbidden peers before origin, WebSocket, or authentication work", async () => {
		const ops = operations();
		ops.isPeerAllowed.mockReturnValue(false);
		const response = await createServerRequestPolicy(ops)(
			request(),
			"10.0.0.2",
			undefined,
		);
		expect(response?.status).toBe(403);
		expect(ops.isMutationOriginAllowed).not.toHaveBeenCalled();
		expect(ops.handleWebSocket).not.toHaveBeenCalled();
		expect(ops.authorize).not.toHaveBeenCalled();
		expect(ops.handleAuthenticated).not.toHaveBeenCalled();
	});

	it("checks mutation origins before WebSocket or authentication work", async () => {
		const ops = operations();
		ops.isMutationOriginAllowed.mockReturnValue(false);
		const response = await createServerRequestPolicy(ops)(
			request("/db/session", "POST", "https://attacker.example"),
			"127.0.0.1",
			undefined,
		);
		expect(response?.status).toBe(403);
		expect(ops.handleWebSocket).not.toHaveBeenCalled();
		expect(ops.authorize).not.toHaveBeenCalled();
	});

	it("does not require an Origin header for safe methods", async () => {
		const ops = operations();
		await createServerRequestPolicy(ops)(
			request("/status", "HEAD"),
			"127.0.0.1",
			undefined,
		);
		expect(ops.isMutationOriginAllowed).not.toHaveBeenCalled();
		expect(ops.authorize).toHaveBeenCalled();
	});

	it("returns WebSocket results without entering HTTP authentication", async () => {
		const ops = operations();
		const upgradeRequired = new Response("upgrade", { status: 426 });
		ops.handleWebSocket.mockResolvedValue(upgradeRequired);
		const response = await createServerRequestPolicy(ops)(
			request("/ws"),
			"127.0.0.1",
			undefined,
		);
		expect(response).toBe(upgradeRequired);
		expect(ops.authorize).not.toHaveBeenCalled();
		expect(ops.handleAuthenticated).not.toHaveBeenCalled();
	});

	it("returns a non-cacheable 401 before any authenticated route", async () => {
		const ops = operations();
		ops.authorize.mockResolvedValue(false);
		const response = await createServerRequestPolicy(ops)(
			request(),
			"127.0.0.1",
			undefined,
		);
		expect(response?.status).toBe(401);
		expect(response?.headers.get("cache-control")).toBe("no-store");
		expect(await response?.json()).toEqual({ error: "Unauthorized" });
		expect(ops.handleAuthenticated).not.toHaveBeenCalled();
	});

	it("reaches authenticated routing only after every security gate passes", async () => {
		const ops = operations();
		const response = await createServerRequestPolicy(ops)(
			request("/db/sessions"),
			"127.0.0.1",
			undefined,
		);
		expect(await response?.text()).toBe("ok");
		expect(ops.handleAuthenticated).toHaveBeenCalledOnce();
	});
});
