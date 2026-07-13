import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start/server", () => ({
	getRequestIP: vi.fn(() => "127.0.0.1"),
}));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));
vi.mock("#/lib/token", () => ({ loadToken: vi.fn(() => null) }));
vi.mock("#/server/config", () => ({
	loadConfig: vi.fn(() => ({ ui: { theme: "dark", mobile_theme: "dark" } })),
}));
vi.mock("#/server/auth", () => ({
	authState: vi.fn(),
	changePassword: vi.fn(),
	clearSessionCookie: vi.fn(() => "hlid_session=; Max-Age=0"),
	createInitialPassword: vi.fn(),
	createSession: vi.fn(async () => "tok-1"),
	effectivePeerIp: vi.fn(() => "127.0.0.1"),
	isLoopback: vi.fn(() => true),
	isSecureRequest: vi.fn(() => false),
	loginRetryAfterSeconds: vi.fn(() => 0),
	readCookie: vi.fn(() => "cookie-token"),
	revokeAllSessions: vi.fn(),
	revokeSession: vi.fn(),
	sessionCookie: vi.fn(() => "hlid_session=tok-1"),
	verifyLogin: vi.fn(),
}));

import { forbiddenResponse } from "#/lib/originGate";
import * as auth from "#/server/auth";
import { Route } from "./auth.$action";

type Handlers = {
	GET: (ctx: {
		request: Request;
		params: { action: string };
	}) => Promise<Response>;
	POST: (ctx: {
		request: Request;
		params: { action: string };
	}) => Promise<Response>;
};

const handlers = (
	Route.options as unknown as { server: { handlers: Handlers } }
).server.handlers;

function post(action: string, body?: unknown): Promise<Response> {
	return handlers.POST({
		request: new Request(`http://localhost/api/auth/${action}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		}),
		params: { action },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(forbiddenResponse).mockReturnValue(null);
	vi.mocked(auth.isLoopback).mockReturnValue(true);
	vi.mocked(auth.isSecureRequest).mockReturnValue(false);
	vi.mocked(auth.loginRetryAfterSeconds).mockReturnValue(0);
	vi.mocked(auth.effectivePeerIp).mockReturnValue("127.0.0.1");
	vi.mocked(auth.createSession).mockResolvedValue("tok-1");
	vi.mocked(auth.sessionCookie).mockReturnValue("hlid_session=tok-1");
	vi.mocked(auth.clearSessionCookie).mockReturnValue(
		"hlid_session=; Max-Age=0",
	);
	vi.mocked(auth.readCookie).mockReturnValue("cookie-token");
});

describe("GET /api/auth/:action", () => {
	it("returns auth state and themes for status", async () => {
		vi.mocked(auth.authState).mockResolvedValue("authenticated" as never);
		const res = await handlers.GET({
			request: new Request("http://localhost/api/auth/status"),
			params: { action: "status" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			state: "authenticated",
			theme: "dark",
			mobileTheme: "dark",
		});
	});

	it("404s for unknown GET action", async () => {
		const res = await handlers.GET({
			request: new Request("http://localhost/api/auth/other"),
			params: { action: "other" },
		});
		expect(res.status).toBe(404);
	});

	it("honors origin gate", async () => {
		vi.mocked(forbiddenResponse).mockReturnValue(
			new Response("Forbidden", { status: 403 }),
		);
		const res = await handlers.GET({
			request: new Request("http://localhost/api/auth/status"),
			params: { action: "status" },
		});
		expect(res.status).toBe(403);
	});
});

describe("POST /api/auth/setup", () => {
	it("rejects setup from non-loopback peers", async () => {
		vi.mocked(auth.isLoopback).mockReturnValue(false);
		const res = await post("setup", { password: "hunter2hunter2" });
		expect(res.status).toBe(403);
	});

	it("creates initial password and starts a session", async () => {
		const res = await post("setup", { password: "hunter2hunter2" });
		expect(res.status).toBe(200);
		expect(auth.createInitialPassword).toHaveBeenCalledWith("hunter2hunter2");
		expect(res.headers.get("set-cookie")).toBe("hlid_session=tok-1");
	});

	it("maps setup errors to 400 with message", async () => {
		vi.mocked(auth.createInitialPassword).mockRejectedValue(
			new Error("Password too short"),
		);
		const res = await post("setup", { password: "x" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Password too short" });
	});
});

describe("POST /api/auth/login", () => {
	it("requires HTTPS for remote logins", async () => {
		vi.mocked(auth.isLoopback).mockReturnValue(false);
		vi.mocked(auth.isSecureRequest).mockReturnValue(false);
		const res = await post("login", { password: "pw" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Remote login requires HTTPS" });
	});

	it("rate limits with retry-after header", async () => {
		vi.mocked(auth.loginRetryAfterSeconds).mockReturnValue(30);
		const res = await post("login", { password: "pw" });
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("30");
	});

	it("401s on wrong password", async () => {
		vi.mocked(auth.verifyLogin).mockResolvedValue(false);
		const res = await post("login", { password: "wrong" });
		expect(res.status).toBe(401);
	});

	it("sets a session cookie on success", async () => {
		vi.mocked(auth.verifyLogin).mockResolvedValue(true);
		const res = await post("login", { password: "right" });
		expect(res.status).toBe(200);
		expect(auth.verifyLogin).toHaveBeenCalledWith("right", "127.0.0.1");
		expect(res.headers.get("set-cookie")).toBe("hlid_session=tok-1");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});
});

describe("POST authenticated actions", () => {
	it("401s when not authenticated", async () => {
		vi.mocked(auth.authState).mockResolvedValue("unauthenticated" as never);
		const res = await post("logout");
		expect(res.status).toBe(401);
	});

	it("logout revokes the request session and clears the cookie", async () => {
		vi.mocked(auth.authState).mockResolvedValue("authenticated" as never);
		const res = await post("logout");
		expect(res.status).toBe(200);
		expect(auth.revokeSession).toHaveBeenCalledWith("cookie-token");
		expect(res.headers.get("set-cookie")).toBe("hlid_session=; Max-Age=0");
	});

	it("revoke-all revokes every session", async () => {
		vi.mocked(auth.authState).mockResolvedValue("authenticated" as never);
		const res = await post("revoke-all");
		expect(res.status).toBe(200);
		expect(auth.revokeAllSessions).toHaveBeenCalledOnce();
	});

	it("404s for unknown authenticated action", async () => {
		vi.mocked(auth.authState).mockResolvedValue("authenticated" as never);
		const res = await post("frobnicate");
		expect(res.status).toBe(404);
	});
});

describe("POST /api/auth/change-password", () => {
	beforeEach(() => {
		vi.mocked(auth.authState).mockResolvedValue("authenticated" as never);
	});

	it("rate limits before touching the password", async () => {
		vi.mocked(auth.loginRetryAfterSeconds).mockReturnValue(12);
		const res = await post("change-password", {
			currentPassword: "a",
			newPassword: "b",
		});
		expect(res.status).toBe(429);
		expect(auth.changePassword).not.toHaveBeenCalled();
	});

	it("401s on invalid current password", async () => {
		vi.mocked(auth.changePassword).mockResolvedValue(false);
		const res = await post("change-password", {
			currentPassword: "wrong",
			newPassword: "newpw",
		});
		expect(res.status).toBe(401);
	});

	it("changes the password and clears the session cookie", async () => {
		vi.mocked(auth.changePassword).mockResolvedValue(true);
		const res = await post("change-password", {
			currentPassword: "old",
			newPassword: "new-password",
		});
		expect(res.status).toBe(200);
		expect(auth.changePassword).toHaveBeenCalledWith(
			"old",
			"new-password",
			"127.0.0.1",
		);
		expect(res.headers.get("set-cookie")).toBe("hlid_session=; Max-Age=0");
	});

	it("maps thrown errors to 400", async () => {
		vi.mocked(auth.changePassword).mockRejectedValue(
			new Error("New password too short"),
		);
		const res = await post("change-password", {
			currentPassword: "old",
			newPassword: "x",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "New password too short" });
	});
});
