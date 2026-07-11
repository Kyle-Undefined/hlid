import { describe, expect, it } from "vitest";
import {
	AUTH_COOKIE,
	authorizeServiceRequest,
	clearSessionCookie,
	effectivePeerIp,
	isLoopback,
	isSecureRequest,
	readCookie,
	sessionCookie,
} from "./auth";

describe("authentication request primitives", () => {
	it("recognizes only loopback peers", () => {
		expect(isLoopback("127.0.0.1")).toBe(true);
		expect(isLoopback("::1")).toBe(true);
		expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopback("100.64.0.2")).toBe(false);
	});

	it("accepts the internal token only from loopback", async () => {
		const request = new Request("http://localhost/status", {
			headers: { "x-hlid-internal": "service-secret" },
		});
		expect(
			await authorizeServiceRequest(request, "127.0.0.1", "service-secret"),
		).toBe(true);
		expect(
			await authorizeServiceRequest(request, "100.64.0.2", "service-secret"),
		).toBe(false);
	});

	it("trusts a forwarded client address only from the authenticated loopback proxy", () => {
		const request = new Request("http://localhost/login", {
			headers: {
				"x-hlid-proxy-token": "service-secret",
				"x-hlid-forwarded-client-ip": "100.64.0.9",
			},
		});
		expect(effectivePeerIp(request, "127.0.0.1", "service-secret")).toBe(
			"100.64.0.9",
		);
		expect(effectivePeerIp(request, "192.168.1.5", "service-secret")).toBe(
			"192.168.1.5",
		);
		expect(effectivePeerIp(request, "127.0.0.1", "wrong-secret")).toBe(
			"127.0.0.1",
		);
	});

	it("trusts the TLS marker only from loopback proxy traffic", () => {
		const forwarded = new Request("http://localhost/login", {
			headers: { "x-hlid-forwarded-proto": "https" },
		});
		expect(isSecureRequest(forwarded, "127.0.0.1")).toBe(true);
		expect(isSecureRequest(forwarded, "100.64.0.2")).toBe(false);
		expect(isSecureRequest(new Request("https://hlid.test/login"))).toBe(true);
	});

	it("issues HttpOnly strict cookies and parses them without exposing tokens", () => {
		const value = sessionCookie("raw secret", true);
		expect(value).toContain(`${AUTH_COOKIE}=raw%20secret`);
		expect(value).toContain("HttpOnly");
		expect(value).toContain("SameSite=Strict");
		expect(value).toContain("Secure");
		expect(
			readCookie(
				new Request("http://localhost", { headers: { cookie: value } }),
			),
		).toBe("raw secret");
		expect(clearSessionCookie(false)).toContain("Max-Age=0");
	});
});
