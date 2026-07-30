import { describe, expect, it } from "vitest";
import { resolveDevServerPort } from "./devServerPort";

describe("resolveDevServerPort", () => {
	it("keeps the configured port when no preview override is supplied", () => {
		expect(resolveDevServerPort(3000, undefined)).toBe(3000);
		expect(resolveDevServerPort(4177, "  ")).toBe(4177);
	});

	it("uses a valid preview port", () => {
		expect(resolveDevServerPort(3000, "4177")).toBe(4177);
	});

	it.each([
		"not-a-port",
		"0",
		"65535",
		"4.2",
	])("rejects invalid override %s", (override) => {
		expect(() => resolveDevServerPort(3000, override)).toThrow(/HLID_DEV_PORT/);
	});
});
