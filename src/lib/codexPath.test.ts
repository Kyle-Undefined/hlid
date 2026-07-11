import { afterEach, describe, expect, it, vi } from "vitest";

const { exists } = vi.hoisted(() => ({
	exists: vi.fn<(path: string) => boolean>(),
}));

vi.mock("node:fs", () => ({ existsSync: exists }));

import {
	__resetCacheForTesting,
	findCodexExecutable,
	resolveCodexExecutable,
} from "./codexPath";

afterEach(() => {
	__resetCacheForTesting();
	vi.unstubAllEnvs();
	exists.mockReset();
});

describe("findCodexExecutable", () => {
	it("prefers a valid explicit override over PATH", () => {
		expect(
			findCodexExecutable({
				platform: "linux",
				override: "/custom/codex",
				path: "/usr/bin:/bin",
				exists: (path) => path === "/custom/codex" || path === "/usr/bin/codex",
			}),
		).toBe("/custom/codex");
	});

	it("falls back from an invalid override to the first PATH match", () => {
		expect(
			findCodexExecutable({
				platform: "linux",
				override: "/missing/codex",
				path: ":/first::/second:",
				exists: (path) => path === "/first/codex" || path === "/second/codex",
			}),
		).toBe("/first/codex");
	});

	it("uses Windows separators and prefers the executable over the command shim", () => {
		const checked: string[] = [];
		expect(
			findCodexExecutable({
				platform: "win32",
				path: "C:\\Tools;D:\\Bin",
				exists: (path) => {
					checked.push(path);
					return path === "C:\\Tools\\codex.cmd";
				},
			}),
		).toBe("C:\\Tools\\codex.cmd");
		expect(checked).toEqual(["C:\\Tools\\codex.exe", "C:\\Tools\\codex.cmd"]);
	});

	it("returns undefined when no candidate exists", () => {
		expect(
			findCodexExecutable({
				platform: "linux",
				path: "/usr/bin:/bin",
				exists: () => false,
			}),
		).toBeUndefined();
	});
});

describe("resolveCodexExecutable cache", () => {
	it("caches a successful resolution until reset", () => {
		vi.stubEnv("HLID_CODEX_EXE", "/custom/codex");
		exists.mockReturnValue(true);
		expect(resolveCodexExecutable()).toBe("/custom/codex");
		exists.mockReturnValue(false);
		expect(resolveCodexExecutable()).toBe("/custom/codex");
		expect(exists).toHaveBeenCalledOnce();
		__resetCacheForTesting();
		expect(resolveCodexExecutable()).toBeUndefined();
	});

	it("caches a miss until reset", () => {
		vi.stubEnv("HLID_CODEX_EXE", "/custom/codex");
		vi.stubEnv("PATH", "");
		exists.mockReturnValue(false);
		expect(resolveCodexExecutable()).toBeUndefined();
		exists.mockReturnValue(true);
		expect(resolveCodexExecutable()).toBeUndefined();
		__resetCacheForTesting();
		expect(resolveCodexExecutable()).toBe("/custom/codex");
	});
});
