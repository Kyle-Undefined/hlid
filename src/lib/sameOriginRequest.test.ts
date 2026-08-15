import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./token", () => ({
	loadToken: vi.fn(() => "server-token"),
	verifyToken: vi.fn(() => false),
}));

import { isExactSameOriginMutation } from "./sameOriginRequest";
import { verifyToken } from "./token";

function request(
	origin: string | null,
	headers: Record<string, string> = {},
): Request {
	return new Request("http://127.0.0.1:3000/api/speech/synthesize", {
		method: "POST",
		headers: {
			...(origin ? { origin } : {}),
			...headers,
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(verifyToken).mockReturnValue(false);
});

describe("isExactSameOriginMutation", () => {
	it("accepts an exact browser origin and same-origin fetch metadata", () => {
		expect(
			isExactSameOriginMutation(
				request("http://127.0.0.1:3000", {
					"sec-fetch-site": "same-origin",
				}),
			),
		).toBe(true);
	});

	it.each([
		["missing origin", null, {}],
		["different origin", "http://localhost:3000", {}],
		[
			"cross-site metadata",
			"http://127.0.0.1:3000",
			{ "sec-fetch-site": "cross-site" },
		],
	] as const)("rejects %s", (_name, origin, headers) => {
		expect(isExactSameOriginMutation(request(origin, headers))).toBe(false);
	});

	it("accepts the exact public HTTPS origin from the authenticated proxy", () => {
		vi.mocked(verifyToken).mockReturnValue(true);
		expect(
			isExactSameOriginMutation(
				request("https://hlid.example.test", {
					"x-hlid-forwarded-host": "hlid.example.test",
					"x-hlid-forwarded-proto": "https",
					"x-hlid-proxy-token": "trusted",
					"sec-fetch-site": "same-origin",
				}),
			),
		).toBe(true);
	});

	it.each([
		["untrusted proxy", false, "https", "hlid.example.test"],
		["non-HTTPS forwarding", true, "http", "hlid.example.test"],
		["malformed forwarded host", true, "https", "user@hlid.example.test"],
	] as const)("rejects a public origin through an %s", (_name, trusted, proto, host) => {
		vi.mocked(verifyToken).mockReturnValue(trusted);
		expect(
			isExactSameOriginMutation(
				request("https://hlid.example.test", {
					"x-hlid-forwarded-host": host,
					"x-hlid-forwarded-proto": proto,
					"x-hlid-proxy-token": "candidate",
				}),
			),
		).toBe(false);
	});
});
