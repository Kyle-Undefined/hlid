import { describe, expect, it } from "vitest";
import { deferred } from "./utils";

describe("deferred", () => {
	it("exposes native promise resolvers", async () => {
		const resolved = deferred<number>();
		resolved.resolve(42);
		await expect(resolved.promise).resolves.toBe(42);

		const rejected = deferred<never>();
		rejected.reject(new Error("nope"));
		await expect(rejected.promise).rejects.toThrow("nope");
	});
});
