/**
 * resolveShell — tests the WSL / native-Windows / Unix branches.
 *
 * `isWindows` in resolveShell.ts (and parseWslUnc's own copy in paths.ts) is
 * a module-level const baked from process.platform at import time, so it
 * can't be stubbed mid-test — same constraint claudePath.test.ts works around
 * with describe.skipIf(). Windows/WSL branches are gated the same way here
 * and only run on an actual Windows CI runner or dev machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn().mockReturnValue(false),
}));

import { existsSync } from "node:fs";
import { resolveShell } from "./resolveShell";

const mockExists = vi.mocked(existsSync);
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_SHELL = process.env.SHELL;
const ORIGINAL_SYSTEMROOT = process.env.SystemRoot;

const isWin32 = process.platform === "win32";

beforeEach(() => {
	mockExists.mockReset().mockReturnValue(false);
});

afterEach(() => {
	process.env.PATH = ORIGINAL_PATH;
	process.env.SHELL = ORIGINAL_SHELL;
	process.env.SystemRoot = ORIGINAL_SYSTEMROOT;
});

describe.skipIf(!isWin32)("resolveShell — WSL UNC cwd (Windows host)", () => {
	beforeEach(() => {
		process.env.SystemRoot = "C:\\Windows";
	});

	it("bridges into WSL via wsl.exe with a login bash", () => {
		const result = resolveShell("\\\\wsl$\\Ubuntu\\home\\kyle\\proj");
		expect(result.executable).toBe("C:\\Windows\\System32\\wsl.exe");
		expect(result.args).toEqual([
			"-d",
			"Ubuntu",
			"--cd",
			"/home/kyle/proj",
			"--",
			"bash",
			"-l",
		]);
	});

	it("handles wsl.localhost UNC form the same way", () => {
		const result = resolveShell("\\\\wsl.localhost\\Ubuntu\\home\\kyle\\proj");
		expect(result.args).toContain("Ubuntu");
		expect(result.args).toContain("/home/kyle/proj");
	});
});

describe.skipIf(!isWin32)("resolveShell — native Windows cwd", () => {
	beforeEach(() => {
		process.env.PATH = "C:\\tools";
	});

	it("prefers pwsh.exe when found on PATH", () => {
		mockExists.mockImplementation(
			(path) => String(path) === "C:\\tools\\pwsh.exe",
		);
		const result = resolveShell("C:\\Users\\kyle\\proj");
		expect(result.executable).toBe("C:\\tools\\pwsh.exe");
		expect(result.args).toEqual([]);
	});

	it("falls back to powershell.exe when pwsh isn't found", () => {
		const result = resolveShell("C:\\Users\\kyle\\proj");
		expect(result.executable).toBe("powershell.exe");
		expect(result.args).toEqual([]);
	});
});

describe.skipIf(isWin32)("resolveShell — non-Windows host", () => {
	it("uses $SHELL as a login shell when set", () => {
		process.env.SHELL = "/usr/bin/zsh";
		const result = resolveShell("/home/kyle/proj");
		expect(result.executable).toBe("/usr/bin/zsh");
		expect(result.args).toEqual(["-l"]);
	});

	it("falls back to /bin/bash when $SHELL is unset", () => {
		delete process.env.SHELL;
		const result = resolveShell("/home/kyle/proj");
		expect(result.executable).toBe("/bin/bash");
		expect(result.args).toEqual(["-l"]);
	});

	it("never treats a WSL UNC-looking path as WSL on a non-Windows host", () => {
		delete process.env.SHELL;
		const result = resolveShell("\\\\wsl$\\Ubuntu\\home\\kyle\\proj");
		expect(result.executable).toBe("/bin/bash");
	});
});
