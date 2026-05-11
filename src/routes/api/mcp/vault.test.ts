import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleGetVaultMcp,
	handlePostVaultMcp,
	handleToggleVaultMcp,
} from "./vault";

vi.mock("#/server/config", () => ({ loadConfig: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));
vi.mock("#/lib/vaultMcp", () => ({
	readVaultMcpFile: vi.fn(),
	writeVaultMcpFile: vi.fn(),
	toggleVaultMcpFile: vi.fn(),
}));

const { loadConfig } = await import("#/server/config");
const { forbiddenResponse } = await import("#/lib/originGate");
const { readVaultMcpFile, writeVaultMcpFile, toggleVaultMcpFile } =
	await import("#/lib/vaultMcp");

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);
const mockRead = vi.mocked(readVaultMcpFile);
const mockWrite = vi.mocked(writeVaultMcpFile);
const mockToggle = vi.mocked(toggleVaultMcpFile);

function req(method: string, body?: unknown): Request {
	return new Request("http://localhost/api/mcp/vault", {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
}

function withVault() {
	mockLoadConfig.mockReturnValue({ vault: { path: "/v" } } as never);
}

function noVault() {
	mockLoadConfig.mockReturnValue({ vault: {} } as never);
}

beforeEach(() => {
	vi.resetAllMocks();
	mockForbiddenResponse.mockReturnValue(null);
});

// ─── GET ─────────────────────────────────────────────────────────────────────

describe("handleGetVaultMcp", () => {
	it("returns 400 when no vault path configured", async () => {
		noVault();
		const res = await handleGetVaultMcp(req("GET"));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: expect.any(String) });
	});

	it("delegates to readVaultMcpFile and returns servers", async () => {
		withVault();
		const servers = [{ name: "fs", config: {}, disabled: false }];
		mockRead.mockReturnValue({ servers });
		const res = await handleGetVaultMcp(req("GET"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ servers });
		expect(mockRead).toHaveBeenCalledWith("/v");
	});

	it("returns 403 when origin is blocked", async () => {
		mockForbiddenResponse.mockReturnValue(new Response("x", { status: 403 }));
		const res = await handleGetVaultMcp(req("GET"));
		expect(res.status).toBe(403);
	});
});

// ─── POST (write) ─────────────────────────────────────────────────────────────

describe("handlePostVaultMcp", () => {
	it("returns 400 when no vault path configured", async () => {
		noVault();
		const res = await handlePostVaultMcp(req("POST", { servers: {} }));
		expect(res.status).toBe(400);
	});

	it("delegates to writeVaultMcpFile and returns ok", async () => {
		withVault();
		const servers = { filesystem: { command: "npx" } };
		const res = await handlePostVaultMcp(req("POST", { servers }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(mockWrite).toHaveBeenCalledWith("/v", servers);
	});

	it("returns 400 on invalid body", async () => {
		withVault();
		const res = await handlePostVaultMcp(
			new Request("http://localhost/api/mcp/vault", {
				method: "POST",
				body: "not-json",
			}),
		);
		expect(res.status).toBe(400);
	});
});

// ─── POST /toggle ─────────────────────────────────────────────────────────────

describe("handleToggleVaultMcp", () => {
	it("returns 400 when no vault path", async () => {
		noVault();
		const res = await handleToggleVaultMcp(
			req("POST", { name: "fs", disabled: true }),
		);
		expect(res.status).toBe(400);
	});

	it("delegates to toggleVaultMcpFile and returns ok", async () => {
		withVault();
		const res = await handleToggleVaultMcp(
			req("POST", { name: "filesystem", disabled: true }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(mockToggle).toHaveBeenCalledWith("/v", "filesystem", true);
	});

	it("returns 400 on invalid body", async () => {
		withVault();
		const res = await handleToggleVaultMcp(
			new Request("http://localhost/api/mcp/vault/toggle", {
				method: "POST",
				body: "bad",
			}),
		);
		expect(res.status).toBe(400);
	});
});
