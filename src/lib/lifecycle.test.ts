import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
	buildRestartAppArgs,
	registerShutdownCleanup,
	restart,
	shutdown,
} from "./lifecycle";

beforeEach(() => {
	registerShutdownCleanup(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	spawnMock.mockReset();
});

describe("restart", () => {
	it("lets the Windows trampoline own the complete parent wait", () => {
		expect(
			buildRestartAppArgs({
				execPath: "C:\\Users\\kyleu\\AppData\\Local\\Hlid\\hlid.exe",
				argv: ["hlid.exe"],
				pid: 1234,
				platform: "win32",
			}),
		).toEqual(["--restart", "--background"]);
	});

	it("keeps the child-side parent wait for non-Windows restarts", () => {
		expect(
			buildRestartAppArgs({
				execPath: "/opt/hlid/hlid",
				argv: ["/opt/hlid/hlid"],
				pid: 1234,
				platform: "linux",
			}),
		).toEqual(["--restart", "--background", "--restart-parent=1234"]);
	});

	it("detaches a replacement and cleans up before exiting", async () => {
		vi.useFakeTimers();
		const unref = vi.fn();
		const cleanup = vi.fn();
		registerShutdownCleanup(cleanup);
		spawnMock.mockReturnValue({ unref });
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);

		expect(restart()).toEqual({ ok: true });
		await vi.advanceTimersByTimeAsync(250);

		expect(spawnMock).toHaveBeenCalledWith(
			process.execPath,
			expect.arrayContaining([
				"--restart",
				"--background",
				`--restart-parent=${process.pid}`,
			]),
			expect.objectContaining({ detached: true, stdio: "ignore" }),
		);
		expect(unref).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledWith(0);
	});
});

describe("shutdown", () => {
	it("cleans up once after acknowledging the request", async () => {
		vi.useFakeTimers();
		const cleanup = vi.fn();
		registerShutdownCleanup(cleanup);
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);

		expect(shutdown()).toEqual({ ok: true });
		await vi.advanceTimersByTimeAsync(250);

		expect(cleanup).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledWith(0);
	});
});
