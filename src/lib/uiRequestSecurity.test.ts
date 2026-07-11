import { describe, expect, it, vi } from "vitest";
import {
	type UiSecurityDependencies,
	uiSecurityRejection,
} from "./uiRequestSecurity";

function dependencies(
	overrides: Partial<UiSecurityDependencies> = {},
): UiSecurityDependencies {
	return {
		effectivePeerIp: (_request, peerIp) => peerIp,
		isInternal: () => false,
		authenticate: async () => false,
		...overrides,
	};
}

describe("uiSecurityRejection", () => {
	it("rejects disallowed peers before authentication", async () => {
		const authenticate = vi.fn(async () => true);
		const result = await uiSecurityRejection(
			new Request("http://hlid.test/api/config"),
			"203.0.113.9",
			false,
			dependencies({ authenticate }),
		);
		expect(result?.status).toBe(403);
		expect(authenticate).not.toHaveBeenCalled();
	});

	it("rejects cross-origin mutations before authentication", async () => {
		const authenticate = vi.fn(async () => true);
		const result = await uiSecurityRejection(
			new Request("http://hlid.test/api/config", {
				method: "POST",
				headers: { origin: "https://evil.example" },
			}),
			"127.0.0.1",
			false,
			dependencies({ authenticate }),
		);
		expect(result?.status).toBe(403);
		expect(authenticate).not.toHaveBeenCalled();
	});

	it("allows public authentication routes without a session", async () => {
		const result = await uiSecurityRejection(
			new Request("http://hlid.test/api/auth/login", { method: "POST" }),
			"127.0.0.1",
			false,
			dependencies(),
		);
		expect(result).toBeNull();
	});

	it("redirects unauthenticated documents but returns 401 for APIs", async () => {
		const documentResult = await uiSecurityRejection(
			new Request("http://hlid.test/raven", {
				headers: { accept: "text/html" },
			}),
			"127.0.0.1",
			false,
			dependencies(),
		);
		expect(documentResult?.status).toBe(302);
		expect(documentResult?.headers.get("location")).toBe("/login");

		const apiResult = await uiSecurityRejection(
			new Request("http://hlid.test/api/config"),
			"127.0.0.1",
			false,
			dependencies(),
		);
		expect(apiResult?.status).toBe(401);
		expect(await apiResult?.json()).toEqual({ error: "Unauthorized" });
	});

	it("allows authenticated and trusted internal requests", async () => {
		const authenticated = await uiSecurityRejection(
			new Request("http://hlid.test/api/config"),
			"127.0.0.1",
			false,
			dependencies({ authenticate: async () => true }),
		);
		const internal = await uiSecurityRejection(
			new Request("http://hlid.test/api/config"),
			"127.0.0.1",
			false,
			dependencies({ isInternal: () => true }),
		);
		expect(authenticated).toBeNull();
		expect(internal).toBeNull();
	});

	it("redirects an authenticated login request to the application", async () => {
		const result = await uiSecurityRejection(
			new Request("http://hlid.test/login/"),
			"127.0.0.1",
			false,
			dependencies({ authenticate: async () => true }),
		);
		expect(result?.status).toBe(302);
		expect(result?.headers.get("location")).toBe("/");
	});

	it("allows only the explicit build-time login shell peer bypass", async () => {
		const build = await uiSecurityRejection(
			new Request("http://hlid.test/login", {
				headers: { "x-hlid-login-shell": "build" },
			}),
			undefined,
			false,
			dependencies(),
		);
		const ordinary = await uiSecurityRejection(
			new Request("http://hlid.test/login"),
			undefined,
			false,
			dependencies(),
		);
		expect(build).toBeNull();
		expect(ordinary?.status).toBe(403);
	});
});
