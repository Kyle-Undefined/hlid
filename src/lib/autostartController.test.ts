import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutostartController } from "./autostartController";

describe("autostart controller", () => {
	const runPowerShell = vi.fn();
	let windows = true;
	let exe = "C:\\Program Files\\Hlid\\hlid.exe";

	beforeEach(() => {
		runPowerShell.mockReset();
		runPowerShell.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
		windows = true;
		exe = "C:\\Program Files\\Hlid\\hlid.exe";
	});

	function controller() {
		return createAutostartController({
			isWindows: () => windows,
			execPath: () => exe,
			runPowerShell,
		});
	}

	it("reports unsupported without spawning on non-Windows", async () => {
		windows = false;
		await expect(controller().get()).resolves.toEqual({
			ok: true,
			data: { enabled: false, supported: false },
		});
		expect(runPowerShell).not.toHaveBeenCalled();
	});

	it("caches registry reads until a mutation", async () => {
		runPowerShell.mockResolvedValue({
			stdout: '"C:\\Hlid\\hlid.exe" --background',
			stderr: "",
			code: 0,
		});
		const subject = controller();
		await expect(subject.get()).resolves.toEqual({
			ok: true,
			data: {
				enabled: true,
				supported: true,
				path: '"C:\\Hlid\\hlid.exe" --background',
			},
		});
		await subject.get();
		expect(runPowerShell).toHaveBeenCalledTimes(1);
	});

	it("rejects dev-mode autostart", async () => {
		exe = "C:\\repo\\bun.exe.js";
		await expect(controller().install()).resolves.toEqual({
			ok: false,
			error: "Cannot install autostart in dev mode (not running from .exe)",
		});
		expect(runPowerShell).not.toHaveBeenCalled();
	});

	it("escapes apostrophes in the PowerShell registry value", async () => {
		exe = "C:\\Users\\O'Brien\\Hlid\\hlid.exe";
		await expect(controller().install()).resolves.toEqual({
			ok: true,
			data: { command: '"C:\\Users\\O\'Brien\\Hlid\\hlid.exe" --background' },
		});
		expect(runPowerShell).toHaveBeenCalledWith(
			expect.stringContaining("O''Brien"),
		);
	});

	it("surfaces registry write and delete failures", async () => {
		runPowerShell.mockResolvedValue({
			stdout: "",
			stderr: "access denied",
			code: 1,
		});
		await expect(controller().install()).resolves.toEqual({
			ok: false,
			error: "registry write failed: access denied",
		});
		await expect(controller().uninstall()).resolves.toEqual({
			ok: false,
			error: "registry delete failed: access denied",
		});
	});
});
