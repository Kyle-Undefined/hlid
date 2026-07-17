import { describe, expect, it, vi } from "vitest";
import { loaderValueOrFallback, optionalLoaderValue } from "./loaderFallback";

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

describe("optionalLoaderValue", () => {
	it("reports a value that resolves inside the navigation budget", async () => {
		await expect(
			optionalLoaderValue(Promise.resolve("ready"), "fallback", 50),
		).resolves.toEqual({ status: "ready", value: "ready" });
	});

	it("reports when navigation used the fallback", async () => {
		vi.useFakeTimers();
		try {
			const pending = optionalLoaderValue(
				new Promise<string>(() => {}),
				"fallback",
				50,
			);
			await vi.advanceTimersByTimeAsync(50);
			await expect(pending).resolves.toEqual({
				status: "unavailable",
				value: "fallback",
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
