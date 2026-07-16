import { describe, expect, it } from "vitest";
import { shouldRevalidateRouteData } from "./routeDataRevalidation";

describe("shouldRevalidateRouteData", () => {
	it("refreshes dashboards for their authoritative domains", () => {
		expect(shouldRevalidateRouteData("/", ["stats"])).toBe(true);
		expect(shouldRevalidateRouteData("/ledger", ["sessions"])).toBe(true);
		expect(shouldRevalidateRouteData("/vault", ["vault"])).toBe(true);
		expect(shouldRevalidateRouteData("/forge", ["storage"])).toBe(true);
	});

	it("does not wake unrelated hidden routes", () => {
		expect(shouldRevalidateRouteData("/ledger", ["vault"])).toBe(false);
		expect(shouldRevalidateRouteData("/forge", ["stats"])).toBe(false);
		expect(shouldRevalidateRouteData("/relics", ["relics"])).toBe(false);
	});

	it("does not reload Raven transcripts for session activity", () => {
		expect(shouldRevalidateRouteData("/raven", ["stats", "sessions"])).toBe(
			false,
		);
		expect(shouldRevalidateRouteData("/raven", ["providers"])).toBe(true);
	});
});
