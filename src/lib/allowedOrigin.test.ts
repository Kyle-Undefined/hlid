/**
 * IP/origin allowlist tests — pure logic, no mocks needed.
 */
import { describe, expect, it } from "vitest";
import { isAllowedOrigin, isAllowedOriginHeader } from "./allowedOrigin";

// ── isAllowedOrigin ───────────────────────────────────────────────────────────

describe("isAllowedOrigin — always allowed", () => {
	it("allows IPv4 loopback", () => {
		expect(isAllowedOrigin("127.0.0.1")).toBe(true);
	});

	it("allows IPv6 loopback", () => {
		expect(isAllowedOrigin("::1")).toBe(true);
	});

	it("allows IPv4-mapped loopback (::ffff:127.0.0.1)", () => {
		expect(isAllowedOrigin("::ffff:127.0.0.1")).toBe(true);
	});

	it("allows Tailscale CGNAT range (100.64–127)", () => {
		expect(isAllowedOrigin("100.64.0.1")).toBe(true);
		expect(isAllowedOrigin("100.100.50.1")).toBe(true);
		expect(isAllowedOrigin("100.127.255.255")).toBe(true);
	});

	it("allows Tailscale CGNAT IPv4-mapped", () => {
		expect(isAllowedOrigin("::ffff:100.100.0.1")).toBe(true);
	});

	it("allows Tailscale CGNAT IPv6 prefix (fd7a:115c:a1e0:*)", () => {
		expect(isAllowedOrigin("fd7a:115c:a1e0::1")).toBe(true);
		expect(isAllowedOrigin("FD7A:115C:A1E0:abcd::1")).toBe(true); // case-insensitive
	});

	it("allows Tailscale MagicDNS hostname (.ts.net)", () => {
		expect(isAllowedOrigin("my-machine.tailnet.ts.net")).toBe(true);
		expect(isAllowedOrigin("HOST.TAILNET.TS.NET")).toBe(true); // case-insensitive
	});
});

describe("isAllowedOrigin — blocked by default", () => {
	it("blocks undefined", () => {
		expect(isAllowedOrigin(undefined)).toBe(false);
	});

	it("blocks Tailscale CGNAT edge: 100.63 (below range)", () => {
		expect(isAllowedOrigin("100.63.255.255")).toBe(false);
	});

	it("blocks Tailscale CGNAT edge: 100.128 (above range)", () => {
		expect(isAllowedOrigin("100.128.0.0")).toBe(false);
	});

	it("blocks RFC1918 10.x when allowLocalNetwork=false (default)", () => {
		expect(isAllowedOrigin("10.0.0.1")).toBe(false);
	});

	it("blocks RFC1918 172.16-31.x when allowLocalNetwork=false", () => {
		expect(isAllowedOrigin("172.16.0.1")).toBe(false);
		expect(isAllowedOrigin("172.31.255.255")).toBe(false);
	});

	it("blocks RFC1918 192.168.x when allowLocalNetwork=false", () => {
		expect(isAllowedOrigin("192.168.1.1")).toBe(false);
	});

	it("blocks non-RFC1918 public IP", () => {
		expect(isAllowedOrigin("8.8.8.8")).toBe(false);
	});

	it("blocks non-IPv4 non-special string", () => {
		expect(isAllowedOrigin("not-an-ip")).toBe(false);
	});

	it("blocks octet out of range", () => {
		expect(isAllowedOrigin("256.0.0.1")).toBe(false);
	});
});

describe("isAllowedOrigin — allowLocalNetwork=true", () => {
	it("allows RFC1918 10.x", () => {
		expect(isAllowedOrigin("10.0.0.1", true)).toBe(true);
		expect(isAllowedOrigin("10.255.255.255", true)).toBe(true);
	});

	it("allows RFC1918 172.16–31.x", () => {
		expect(isAllowedOrigin("172.16.0.1", true)).toBe(true);
		expect(isAllowedOrigin("172.31.0.1", true)).toBe(true);
	});

	it("blocks 172.15.x (outside 16-31 range)", () => {
		expect(isAllowedOrigin("172.15.0.1", true)).toBe(false);
	});

	it("blocks 172.32.x (outside 16-31 range)", () => {
		expect(isAllowedOrigin("172.32.0.1", true)).toBe(false);
	});

	it("allows RFC1918 192.168.x", () => {
		expect(isAllowedOrigin("192.168.0.1", true)).toBe(true);
	});

	it("still blocks public IP even with allowLocalNetwork", () => {
		expect(isAllowedOrigin("8.8.8.8", true)).toBe(false);
	});
});

// ── isAllowedOriginHeader ─────────────────────────────────────────────────────

describe("isAllowedOriginHeader", () => {
	it("allows null/absent origin (server-side call)", () => {
		expect(isAllowedOriginHeader(null)).toBe(true);
		expect(isAllowedOriginHeader("")).toBe(true);
	});

	it("allows http://localhost origin", () => {
		expect(isAllowedOriginHeader("http://localhost:3000")).toBe(true);
	});

	it("allows Tailscale CGNAT origin", () => {
		expect(isAllowedOriginHeader("http://100.100.0.1:3000")).toBe(true);
	});

	it("allows Tailscale ts.net hostname origin", () => {
		expect(isAllowedOriginHeader("https://my-box.tailnet.ts.net")).toBe(true);
	});

	it("blocks public IP origin", () => {
		expect(isAllowedOriginHeader("https://evil.com")).toBe(false);
	});

	it("blocks malformed URL", () => {
		expect(isAllowedOriginHeader("not a url")).toBe(false);
	});

	it("allows local network origin when allowLocalNetwork=true", () => {
		expect(isAllowedOriginHeader("http://192.168.1.50:3000", true)).toBe(true);
	});

	it("blocks local network origin when allowLocalNetwork=false", () => {
		expect(isAllowedOriginHeader("http://192.168.1.50:3000", false)).toBe(
			false,
		);
	});
});
