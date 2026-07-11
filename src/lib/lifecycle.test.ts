import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { restart } from "./lifecycle";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	spawnMock.mockReset();
});

describe("restart", () => {
	it("detaches a replacement that waits for the current process", () => {
		vi.useFakeTimers();
		const unref = vi.fn();
		spawnMock.mockReturnValue({ unref });
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);

		expect(restart()).toEqual({ ok: true });
		vi.advanceTimersByTime(250);

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
		expect(exit).toHaveBeenCalledWith(0);
	});
});
