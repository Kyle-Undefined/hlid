import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import { loadAcpRegistry } from "./acp";

vi.mock("#/lib/dbClient", () => ({
	dbFetch: vi.fn(),
	dbJson: vi.fn(),
	requireDbOk: vi.fn(),
}));

describe("ACP registry server function", () => {
	beforeEach(() => vi.resetAllMocks());

	it("keeps ordinary reads soft and process-free", async () => {
		vi.mocked(dbJson).mockResolvedValue({ agents: [] });

		await expect(loadAcpRegistry()).resolves.toEqual([]);

		expect(dbJson).toHaveBeenCalledWith("/acp/registry", { agents: [] });
		expect(dbFetch).not.toHaveBeenCalled();
	});

	it("uses a hard, extended read for explicit refreshes", async () => {
		const response = Response.json({
			agents: [{ id: "opencode", name: "OpenCode" }],
		});
		vi.mocked(dbFetch).mockResolvedValue(response);
		vi.mocked(requireDbOk).mockResolvedValue(response);

		await expect(loadAcpRegistry(true)).resolves.toEqual([
			{ id: "opencode", name: "OpenCode" },
		]);

		expect(dbFetch).toHaveBeenCalledWith(
			"/acp/registry?refresh=1",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(requireDbOk).toHaveBeenCalledWith(response, "refresh ACP registry");
		expect(dbJson).not.toHaveBeenCalled();
	});

	it("rejects an invalid explicit refresh instead of erasing the catalog", async () => {
		const response = Response.json({ agents: null });
		vi.mocked(dbFetch).mockResolvedValue(response);
		vi.mocked(requireDbOk).mockResolvedValue(response);

		await expect(loadAcpRegistry(true)).rejects.toThrow("invalid catalog");
	});
});
