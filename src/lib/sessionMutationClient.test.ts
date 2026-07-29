import { beforeEach, describe, expect, it, vi } from "vitest";

const dbClient = vi.hoisted(() => ({
	dbFetch: vi.fn(),
	requireDbOk: vi.fn(),
}));

vi.mock("./dbClient", () => dbClient);

import { patchSession } from "./sessionMutationClient";

describe("patchSession", () => {
	beforeEach(() => {
		dbClient.dbFetch.mockReset();
		dbClient.requireDbOk.mockReset();
	});

	it("patches the encoded session and preserves the operation label", async () => {
		const response = new Response(null, { status: 204 });
		dbClient.dbFetch.mockResolvedValue(response);
		dbClient.requireDbOk.mockResolvedValue(response);

		await expect(
			patchSession("session/with spaces", { pinned: true }, "pin session"),
		).resolves.toEqual({ ok: true });

		expect(dbClient.dbFetch).toHaveBeenCalledWith(
			"/db/session?id=session%2Fwith%20spaces",
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pinned: true }),
			},
		);
		expect(dbClient.requireDbOk).toHaveBeenCalledWith(response, "pin session");
	});

	it("propagates database failures", async () => {
		const response = new Response(null, { status: 500 });
		const error = new Error("rename session failed");
		dbClient.dbFetch.mockResolvedValue(response);
		dbClient.requireDbOk.mockRejectedValue(error);

		await expect(
			patchSession("session-1", { label: "Renamed" }, "rename session"),
		).rejects.toBe(error);
	});
});
