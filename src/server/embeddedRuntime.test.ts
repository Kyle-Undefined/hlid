import { renameSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceRuntimeDirectory } from "./embeddedRuntime";

vi.mock("node:fs", () => ({ renameSync: vi.fn(), rmSync: vi.fn() }));

function fsError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

afterEach(() => vi.clearAllMocks());

describe("replaceRuntimeDirectory", () => {
	it("installs directly when no runtime exists", () => {
		replaceRuntimeDirectory("runtime.tmp", "runtime");
		expect(renameSync).toHaveBeenCalledWith("runtime.tmp", "runtime");
		expect(rmSync).not.toHaveBeenCalled();
	});

	it("swaps through a backup when the runtime already exists", () => {
		vi.mocked(renameSync)
			.mockImplementationOnce(() => {
				throw fsError("EEXIST");
			})
			.mockReturnValue(undefined);

		replaceRuntimeDirectory("runtime.tmp", "runtime");

		expect(vi.mocked(renameSync).mock.calls).toEqual([
			["runtime.tmp", "runtime"],
			["runtime", "runtime.bak"],
			["runtime.tmp", "runtime"],
		]);
		expect(rmSync).toHaveBeenNthCalledWith(1, "runtime.bak", {
			recursive: true,
			force: true,
		});
		expect(rmSync).toHaveBeenNthCalledWith(2, "runtime.bak", {
			recursive: true,
			force: true,
		});
	});

	it("restores the working runtime when installing the replacement fails", () => {
		const replacementError = fsError("EACCES");
		vi.mocked(renameSync)
			.mockImplementationOnce(() => {
				throw fsError("EPERM");
			})
			.mockReturnValueOnce(undefined)
			.mockImplementationOnce(() => {
				throw replacementError;
			})
			.mockReturnValueOnce(undefined);

		expect(() => replaceRuntimeDirectory("runtime.tmp", "runtime")).toThrow(
			replacementError,
		);
		expect(renameSync).toHaveBeenLastCalledWith("runtime.bak", "runtime");
		expect(rmSync).toHaveBeenCalledTimes(1);
	});

	it("preserves both failures when replacement and rollback fail", () => {
		vi.mocked(renameSync)
			.mockImplementationOnce(() => {
				throw fsError("ENOTEMPTY");
			})
			.mockReturnValueOnce(undefined)
			.mockImplementationOnce(() => {
				throw fsError("EACCES");
			})
			.mockImplementationOnce(() => {
				throw fsError("EBUSY");
			});

		expect(() => replaceRuntimeDirectory("runtime.tmp", "runtime")).toThrow(
			"runtime replacement and rollback failed",
		);
		expect(rmSync).toHaveBeenCalledTimes(1);
	});

	it("does not touch the active runtime for an unrelated rename error", () => {
		const error = fsError("EACCES");
		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw error;
		});

		expect(() => replaceRuntimeDirectory("runtime.tmp", "runtime")).toThrow(
			error,
		);
		expect(renameSync).toHaveBeenCalledOnce();
		expect(rmSync).not.toHaveBeenCalled();
	});
});
