import { afterEach, describe, expect, it, vi } from "vitest";
import { installAuthRedirect, shouldRedirectUnauthorized } from "./authClient";

afterEach(() => vi.unstubAllGlobals());

describe("client authentication redirect policy", () => {
	it("redirects same-origin protected 401 responses", () => {
		expect(
			shouldRedirectUnauthorized(
				401,
				"/_serverFn/private-loader",
				"https://device.tailnet.ts.net/vault",
			),
		).toBe(true);
		expect(
			shouldRedirectUnauthorized(
				401,
				"/api/config",
				"https://device.tailnet.ts.net/forge",
			),
		).toBe(true);
	});

	it("does not redirect auth failures, external requests, or non-401 responses", () => {
		expect(
			shouldRedirectUnauthorized(
				401,
				"/api/auth/login",
				"https://device.tailnet.ts.net/login",
			),
		).toBe(false);
		expect(
			shouldRedirectUnauthorized(
				401,
				"https://example.com/data",
				"https://device.tailnet.ts.net/vault",
			),
		).toBe(false);
		expect(
			shouldRedirectUnauthorized(
				403,
				"/api/config",
				"https://device.tailnet.ts.net/forge",
			),
		).toBe(false);
	});

	it("installs a fetch interceptor that replaces the page on protected 401s", async () => {
		const replace = vi.fn();
		const fetch = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 401 }));
		const fakeWindow = { fetch };
		vi.stubGlobal("window", fakeWindow);
		vi.stubGlobal("location", {
			href: "https://device.tailnet.ts.net/vault",
			replace,
		});

		installAuthRedirect();
		await fakeWindow.fetch("/api/config");

		expect(replace).toHaveBeenCalledWith("/login");
	});
});
