import { describe, expect, it, vi } from "vitest";
import { probeExistingInstance } from "./startupProbe";

describe("probeExistingInstance", () => {
	it("returns the local UI URL when an instance responds successfully", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("ok"));

		await expect(probeExistingInstance(4321, fetchImpl)).resolves.toBe(
			"http://127.0.0.1:4321/",
		);
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:4321/",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it.each([
		[
			"non-success response",
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response("busy", { status: 503 })),
		],
		[
			"connection failure",
			vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
		],
	])("returns null for a %s", async (_label, fetchImpl) => {
		await expect(probeExistingInstance(3000, fetchImpl)).resolves.toBeNull();
	});
});
