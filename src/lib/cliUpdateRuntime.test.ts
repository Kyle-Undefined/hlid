import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.hoisted(() => vi.fn());
const loadToken = vi.hoisted(() => vi.fn());

vi.mock("#/server/config", () => ({ loadConfig }));
vi.mock("./token", () => ({ loadToken }));

import {
	drainCliRuntime,
	heartbeatCliRuntimeLease,
	reconcileAcpCliRuntime,
} from "./cliUpdateRuntime";

beforeEach(() => {
	vi.restoreAllMocks();
	loadConfig.mockReturnValue({ server: { port: 3_000 } });
	loadToken.mockReturnValue("internal-token");
});

describe("CLI update owner-runtime bridge", () => {
	it("authenticates and parses an owner runtime drain", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			Response.json({
				ok: true,
				data: { sessions: 2, appServers: 1, leaseId: "lease-1" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(drainCliRuntime()).resolves.toEqual({
			sessions: 2,
			appServers: 1,
			leaseId: "lease-1",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:3001/internal/cli-updates/drain",
			expect.objectContaining({
				method: "POST",
				headers: { "x-hlid-internal": "internal-token" },
			}),
		);
	});

	it("awaits owner ACP reconciliation and reports a partial update failure", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ ok: true }))
			.mockResolvedValueOnce(new Response("failed", { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(reconcileAcpCliRuntime("lease-1")).resolves.toBeUndefined();
		await expect(reconcileAcpCliRuntime("lease-1")).rejects.toThrow(
			"CLI updated, but Hlid could not refresh its runtime (HTTP 503)",
		);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://127.0.0.1:3001/internal/cli-updates/reconcile-acp",
		);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			leaseId: "lease-1",
		});
	});

	it("authenticates an exact owner lease heartbeat", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(heartbeatCliRuntimeLease("lease-1")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:3001/internal/cli-updates/heartbeat",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"x-hlid-internal": "internal-token",
				}),
				body: JSON.stringify({ leaseId: "lease-1" }),
			}),
		);
	});
});
