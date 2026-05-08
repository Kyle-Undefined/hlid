/**
 * forbiddenResponse — IP gate + CORS method gate.
 * Mocks getRequestIP, loadConfig, and the allowedOrigin helpers so this
 * tests only the branching logic in originGate.ts, not the underlying
 * allowlist rules (already covered by allowedOrigin.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks (declared before import) ───────────────────────────────────────────

vi.mock("@tanstack/react-start/server", () => ({
	getRequestIP: vi.fn(),
}));

vi.mock("#/server/config", () => ({
	loadConfig: vi.fn(),
}));

vi.mock("./allowedOrigin", () => ({
	isAllowedOrigin: vi.fn(),
	isAllowedOriginHeader: vi.fn(),
}));

import { getRequestIP } from "@tanstack/react-start/server";
import { loadConfig } from "#/server/config";
import { isAllowedOrigin, isAllowedOriginHeader } from "./allowedOrigin";
import { forbiddenResponse } from "./originGate";

const mockGetIP = vi.mocked(getRequestIP);
const mockLoadConfig = vi.mocked(loadConfig);
const mockIsAllowedOrigin = vi.mocked(isAllowedOrigin);
const mockIsAllowedOriginHeader = vi.mocked(isAllowedOriginHeader);

function setupConfig(localNetworkAccess = false) {
	mockLoadConfig.mockReturnValue({
		server: { local_network_access: localNetworkAccess },
	} as ReturnType<typeof loadConfig>);
}

beforeEach(() => {
	vi.clearAllMocks();
	setupConfig(false);
	mockGetIP.mockReturnValue("127.0.0.1");
	mockIsAllowedOrigin.mockReturnValue(true);
	mockIsAllowedOriginHeader.mockReturnValue(true);
});

// ── IP gate ───────────────────────────────────────────────────────────────────

describe("forbiddenResponse — IP gate", () => {
	it("returns null when IP is allowed", () => {
		mockIsAllowedOrigin.mockReturnValue(true);
		expect(forbiddenResponse()).toBeNull();
	});

	it("returns 403 when IP is not allowed", () => {
		mockIsAllowedOrigin.mockReturnValue(false);
		const res = forbiddenResponse();
		expect(res?.status).toBe(403);
	});

	it("passes local_network_access flag to isAllowedOrigin", () => {
		setupConfig(true);
		forbiddenResponse();
		expect(mockIsAllowedOrigin).toHaveBeenCalledWith(expect.anything(), true);
	});

	it("passes local_network_access=false by default", () => {
		setupConfig(false);
		forbiddenResponse();
		expect(mockIsAllowedOrigin).toHaveBeenCalledWith(expect.anything(), false);
	});
});

// ── CORS method gate ──────────────────────────────────────────────────────────

describe("forbiddenResponse — CORS origin gate", () => {
	it("skips origin check for GET requests", () => {
		const req = new Request("http://localhost/", { method: "GET" });
		forbiddenResponse(req);
		expect(mockIsAllowedOriginHeader).not.toHaveBeenCalled();
	});

	it("skips origin check for HEAD requests", () => {
		const req = new Request("http://localhost/", { method: "HEAD" });
		forbiddenResponse(req);
		expect(mockIsAllowedOriginHeader).not.toHaveBeenCalled();
	});

	it("checks origin for POST requests", () => {
		const req = new Request("http://localhost/", { method: "POST" });
		forbiddenResponse(req);
		expect(mockIsAllowedOriginHeader).toHaveBeenCalled();
	});

	it("returns 403 when origin header forbidden on POST", () => {
		mockIsAllowedOriginHeader.mockReturnValue(false);
		const req = new Request("http://localhost/api", {
			method: "POST",
			headers: { origin: "http://evil.example.com" },
		});
		const res = forbiddenResponse(req);
		expect(res?.status).toBe(403);
	});

	it("returns null when origin header allowed on POST", () => {
		mockIsAllowedOriginHeader.mockReturnValue(true);
		const req = new Request("http://localhost/api", {
			method: "POST",
			headers: { origin: "http://localhost" },
		});
		expect(forbiddenResponse(req)).toBeNull();
	});

	it("passes origin header value to isAllowedOriginHeader", () => {
		const req = new Request("http://localhost/", {
			method: "PUT",
			headers: { origin: "http://192.168.1.5:3000" },
		});
		forbiddenResponse(req);
		expect(mockIsAllowedOriginHeader).toHaveBeenCalledWith(
			"http://192.168.1.5:3000",
			false,
		);
	});

	it("skips origin check when no request argument", () => {
		forbiddenResponse();
		expect(mockIsAllowedOriginHeader).not.toHaveBeenCalled();
	});
});
