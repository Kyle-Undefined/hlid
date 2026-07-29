import { describe, expect, it } from "vitest";
import { normalizeWindowsPathEnvCasing } from "./windowsEnv";

describe("normalizeWindowsPathEnvCasing", () => {
	it("renames an uppercase PATH key to native Windows casing", () => {
		const env: Record<string, string | undefined> = {
			PATH: "C:\\Windows\\System32",
			SYSTEMROOT: "C:\\Windows",
		};
		normalizeWindowsPathEnvCasing(env, "win32");
		expect(env).toEqual({
			Path: "C:\\Windows\\System32",
			SYSTEMROOT: "C:\\Windows",
		});
	});

	it("leaves native Path casing untouched", () => {
		const env: Record<string, string | undefined> = { Path: "C:\\Windows" };
		normalizeWindowsPathEnvCasing(env, "win32");
		expect(env).toEqual({ Path: "C:\\Windows" });
	});

	it("does nothing off Windows", () => {
		const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
		normalizeWindowsPathEnvCasing(env, "linux");
		expect(env).toEqual({ PATH: "/usr/bin" });
	});

	it("drops an undefined PATH entry without creating Path", () => {
		const env: Record<string, string | undefined> = { PATH: undefined };
		normalizeWindowsPathEnvCasing(env, "win32");
		expect(Object.hasOwn(env, "PATH")).toBe(false);
		expect(Object.hasOwn(env, "Path")).toBe(false);
	});
});
