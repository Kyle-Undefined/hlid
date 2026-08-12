import { describe, expect, it, vi } from "vitest";
import { createAcpManagedInstallRequestHandlers } from "./installations";

vi.mock("#/lib/token", () => ({
	loadToken: () => "internal-secret",
	verifyToken: (candidate: string | null | undefined, expected: string) =>
		candidate === expected,
}));

function request(body: unknown): Request {
	return new Request("http://localhost/api/acp/installations", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: "http://localhost",
			"sec-fetch-site": "same-origin",
		},
		body: JSON.stringify(body),
	});
}

describe("ACP managed installation UI route", () => {
	it("checks origin and peer access before forwarding a typed action", async () => {
		const mutate = vi.fn(async () =>
			Response.json({ ok: true, data: { id: "operation" } }, { status: 202 }),
		);
		const handlers = createAcpManagedInstallRequestHandlers({
			forbidden: () => null,
			access: () => null,
			mutate,
		});

		const response = await handlers.POST({
			request: request({
				action: "install",
				agentId: "opencode",
				targetId: "wsl-safe",
				revision: "a".repeat(64),
			}),
		});

		expect(response.status).toBe(202);
		expect(mutate).toHaveBeenCalledWith({
			action: "install",
			agentId: "opencode",
			targetId: "wsl-safe",
			revision: "a".repeat(64),
		});
	});

	it("rejects disallowed peers before parsing or forwarding", async () => {
		const mutate = vi.fn();
		const handlers = createAcpManagedInstallRequestHandlers({
			forbidden: () => null,
			access: () => Response.json({ ok: false }, { status: 403 }),
			mutate,
		});
		const response = await handlers.POST({ request: request({}) });
		expect(response.status).toBe(403);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("rejects arbitrary commands, URLs, and unknown actions", async () => {
		const mutate = vi.fn();
		const handlers = createAcpManagedInstallRequestHandlers({
			forbidden: () => null,
			access: () => null,
			mutate,
		});
		const response = await handlers.POST({
			request: request({
				action: "run",
				agentId: "opencode",
				targetId: "wsl-safe",
				command: "rm",
				url: "https://attacker.invalid/archive",
			}),
		});
		expect(response.status).toBe(400);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("rejects cross-origin and simple-content browser posts", async () => {
		const mutate = vi.fn();
		const handlers = createAcpManagedInstallRequestHandlers({
			forbidden: () => null,
			access: () => null,
			mutate,
		});
		const crossOrigin = new Request("http://localhost/api/acp/installations", {
			method: "POST",
			headers: {
				"content-type": "text/plain",
				origin: "http://localhost:9999",
				"sec-fetch-site": "same-site",
			},
			body: JSON.stringify({
				action: "install",
				agentId: "opencode",
				targetId: "wsl-safe",
				revision: "a".repeat(64),
			}),
		});
		expect((await handlers.POST({ request: crossOrigin })).status).toBe(415);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("accepts the exact browser origin preserved by the trusted TLS proxy", async () => {
		const mutate = vi.fn(async () =>
			Response.json({ ok: true, data: { id: "operation" } }, { status: 202 }),
		);
		const handlers = createAcpManagedInstallRequestHandlers({
			forbidden: () => null,
			access: () => null,
			mutate,
		});
		const proxied = new Request("http://127.0.0.1:3000/api/acp/installations", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://hlid.example.ts.net",
				"sec-fetch-site": "same-origin",
				"x-hlid-forwarded-host": "hlid.example.ts.net",
				"x-hlid-forwarded-proto": "https",
				"x-hlid-proxy-token": "internal-secret",
			},
			body: JSON.stringify({
				action: "install",
				agentId: "opencode",
				targetId: "wsl-safe",
				revision: "a".repeat(64),
			}),
		});

		expect((await handlers.POST({ request: proxied })).status).toBe(202);
		expect(mutate).toHaveBeenCalledOnce();
	});
});
