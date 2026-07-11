import { describe, expect, it, vi } from "vitest";
import { runSelfInstall } from "./install";

type Operations = Parameters<typeof runSelfInstall>[0];

function operations(overrides: Partial<Operations> = {}): Operations {
	return {
		platform: "win32",
		execPath: "/downloads/hlid-v1.exe",
		canonicalPath: "/install/hlid.exe",
		exists: () => false,
		readAutostart: vi.fn().mockResolvedValue(null),
		readPort: vi.fn().mockResolvedValue(3000),
		isRunning: vi.fn().mockResolvedValue(false),
		shutdown: vi.fn().mockResolvedValue(undefined),
		waitForExit: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn(),
		migrate: vi.fn(),
		waitForUnlock: vi.fn().mockResolvedValue(undefined),
		copyExecutable: vi.fn(),
		writeAutostart: vi.fn().mockResolvedValue(undefined),
		createShortcut: vi.fn().mockResolvedValue(undefined),
		refreshIconCache: vi.fn().mockResolvedValue(undefined),
		sleepBeforeRestart: vi.fn().mockResolvedValue(undefined),
		restart: vi.fn(),
		exit: vi.fn(),
		...overrides,
	};
}

describe("runSelfInstall", () => {
	it.each([
		["a non-Windows process", { platform: "linux" }],
		["a development runtime", { execPath: "/downloads/bun" }],
		["the already-canonical executable", { execPath: "/install/hlid.exe" }],
	])("does nothing for %s", async (_label, override) => {
		const ops = operations(override);
		await runSelfInstall(ops);
		expect(ops.readAutostart).not.toHaveBeenCalled();
		expect(ops.copyExecutable).not.toHaveBeenCalled();
		expect(ops.restart).not.toHaveBeenCalled();
		expect(ops.exit).not.toHaveBeenCalled();
	});

	it("orders shutdown, migration, replacement, and restart safely", async () => {
		const events: string[] = [];
		const canonical = "/install/hlid.exe";
		const legacyExe = "C:\\Legacy\\hlid.exe";
		const ops = operations({
			canonicalPath: canonical,
			exists: (path) => path === canonical || path === legacyExe,
			readAutostart: async () => {
				events.push("read-autostart");
				return `"${legacyExe}" --background`;
			},
			readPort: async (dir) => {
				events.push(`read-port:${dir}`);
				return dir === "/install" ? 3000 : 4000;
			},
			isRunning: async (port) => {
				events.push(`probe:${port}`);
				return true;
			},
			shutdown: async (port) => {
				events.push(`shutdown:${port}`);
			},
			waitForExit: async (port) => {
				events.push(`wait-exit:${port}`);
			},
			mkdir: (dir) => events.push(`mkdir:${dir}`),
			migrate: (legacy, destination) =>
				events.push(`migrate:${legacy}->${destination}`),
			waitForUnlock: async (path) => {
				events.push(`wait-unlock:${path}`);
			},
			copyExecutable: (source, destination) =>
				events.push(`copy:${source}->${destination}`),
			writeAutostart: async (path) => {
				events.push(`write-autostart:${path}`);
			},
			createShortcut: async (path) => {
				events.push(`shortcut:${path}`);
			},
			refreshIconCache: async () => {
				events.push("refresh-icons");
			},
			sleepBeforeRestart: async () => {
				events.push("restart-delay");
			},
			restart: (path) => events.push(`restart:${path}`),
			exit: () => events.push("exit"),
		});

		await runSelfInstall(ops);

		expect(events).toEqual([
			"read-autostart",
			"read-port:/install",
			"probe:3000",
			"shutdown:3000",
			"wait-exit:3000",
			"read-port:C:\\Legacy",
			"probe:4000",
			"shutdown:4000",
			"wait-exit:4000",
			"mkdir:/install",
			"migrate:C:\\Legacy->/install",
			"wait-unlock:/install/hlid.exe",
			"copy:/downloads/hlid-v1.exe->/install/hlid.exe",
			"write-autostart:/install/hlid.exe",
			"shortcut:/install/hlid.exe",
			"refresh-icons",
			"restart-delay",
			"restart:/install/hlid.exe",
			"exit",
		]);
	});

	it("does not mutate files or restart when shutdown does not complete", async () => {
		const failure = new Error("old process did not exit");
		const ops = operations({
			exists: (path) => path === "/install/hlid.exe",
			isRunning: vi.fn().mockResolvedValue(true),
			waitForExit: vi.fn().mockRejectedValue(failure),
		});

		await expect(runSelfInstall(ops)).rejects.toThrow(failure);
		expect(ops.mkdir).not.toHaveBeenCalled();
		expect(ops.migrate).not.toHaveBeenCalled();
		expect(ops.copyExecutable).not.toHaveBeenCalled();
		expect(ops.restart).not.toHaveBeenCalled();
		expect(ops.exit).not.toHaveBeenCalled();
	});

	it("does not rewrite autostart when no entry existed", async () => {
		const ops = operations();
		await runSelfInstall(ops);
		expect(ops.writeAutostart).not.toHaveBeenCalled();
		expect(ops.restart).toHaveBeenCalledWith("/install/hlid.exe");
		expect(ops.exit).toHaveBeenCalledOnce();
	});
});
