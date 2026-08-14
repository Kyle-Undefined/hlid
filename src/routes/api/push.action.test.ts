import { describe, expect, it, vi } from "vitest";
import { handlePushBridge } from "./push.$action";

function dependencies(authenticated = true) {
	return {
		forbidden: vi.fn(() => null),
		authenticate: vi.fn(async () => authenticated),
		forward: vi.fn(async (_path: string, _init?: RequestInit) =>
			Response.json({ ok: true }, { headers: { "cache-control": "no-store" } }),
		),
	};
}

describe("service-worker Push bridge", () => {
	it("authenticates and forwards only the exact config GET", async () => {
		const deps = dependencies();
		const response = await handlePushBridge(
			new Request("https://hlid.test/api/push/config", {
				headers: { cookie: "hlid_session=secret" },
			}),
			"config",
			deps,
		);

		expect(response.status).toBe(200);
		expect(deps.forward).toHaveBeenCalledWith(
			"/api/push/config",
			expect.objectContaining({ method: "GET" }),
		);
		const forwarded = deps.forward.mock.calls[0]?.[1];
		expect(new Headers(forwarded?.headers).get("cookie")).toBe(
			"hlid_session=secret",
		);
	});

	it("forwards bounded subscription and receipt POST bodies", async () => {
		for (const action of ["subscriptions", "receipts"] as const) {
			const deps = dependencies();
			const body = JSON.stringify({ action });
			const response = await handlePushBridge(
				new Request(`https://hlid.test/api/push/${action}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						cookie: "hlid_session=secret",
						origin: "https://hlid.test",
					},
					body,
				}),
				action,
				deps,
			);
			expect(response.status).toBe(200);
			const init = deps.forward.mock.calls[0]?.[1];
			expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(body);
			expect(new Headers(init?.headers).get("origin")).toBe(
				"https://hlid.test",
			);
		}
	});

	it("rejects unauthenticated, unknown, and oversized requests", async () => {
		const unauthenticated = dependencies(false);
		expect(
			(
				await handlePushBridge(
					new Request("https://hlid.test/api/push/config"),
					"config",
					unauthenticated,
				)
			).status,
		).toBe(401);
		expect(unauthenticated.forward).not.toHaveBeenCalled();

		const unknown = dependencies();
		expect(
			(
				await handlePushBridge(
					new Request("https://hlid.test/api/push/devices"),
					"devices",
					unknown,
				)
			).status,
		).toBe(404);

		const oversized = dependencies();
		const response = await handlePushBridge(
			new Request("https://hlid.test/api/push/receipts", {
				method: "POST",
				body: "x".repeat(16 * 1024 + 1),
			}),
			"receipts",
			oversized,
		);
		expect(response.status).toBe(413);
		expect(oversized.forward).not.toHaveBeenCalled();
	});
});
