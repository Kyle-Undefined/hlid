import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrency } from "./asyncPool";

describe("mapWithConcurrency", () => {
	it("preserves result order while bounding active work", async () => {
		let active = 0;
		let maximumActive = 0;
		const result = await mapWithConcurrency(
			[30, 5, 15, 1],
			2,
			async (delay, index) => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await new Promise((resolve) => setTimeout(resolve, delay));
				active -= 1;
				return index;
			},
		);

		expect(result).toEqual([0, 1, 2, 3]);
		expect(maximumActive).toBe(2);
	});

	it("does not invoke the mapper for an empty input", async () => {
		const mapper = vi.fn(async () => "unused");

		await expect(mapWithConcurrency([], 4, mapper)).resolves.toEqual([]);
		expect(mapper).not.toHaveBeenCalled();
	});

	it("uses one worker when the requested limit is not positive", async () => {
		let active = 0;
		let maximumActive = 0;
		await mapWithConcurrency([1, 2, 3], 0, async () => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await Promise.resolve();
			active -= 1;
		});

		expect(maximumActive).toBe(1);
	});

	it("rejects when a mapper rejects", async () => {
		await expect(
			mapWithConcurrency([1], 1, async () => {
				throw new Error("mapper failed");
			}),
		).rejects.toThrow("mapper failed");
	});
});
