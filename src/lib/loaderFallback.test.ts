import { describe, expect, it, vi } from "vitest";
import { loaderValueOrFallback } from "./loaderFallback";

describe("loaderValueOrFallback", () => {
	it("returns a resolved optional value", async () => {
		await expect(
			loaderValueOrFallback(Promise.resolve("live"), "fallback", 500),
		).resolves.toBe("live");
	});

	it("falls back when optional work stalls", async () => {
		vi.useFakeTimers();
		try {
			const pending = loaderValueOrFallback(
				new Promise<string>(() => {}),
				"fallback",
				500,
			);
			await vi.advanceTimersByTimeAsync(500);
			await expect(pending).resolves.toBe("fallback");
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back when optional work rejects", async () => {
		await expect(
			loaderValueOrFallback(Promise.reject(new Error("down")), [], 500),
		).resolves.toEqual([]);
	});
});
