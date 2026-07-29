import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	replaceRuntimeDirectory,
	stageRuntimeDirectory,
} from "./embeddedRuntime";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	lstatSync: vi.fn(),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	realpathSync: vi.fn(),
	renameSync: vi.fn(),
	rmSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

function fsError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

afterEach(() => vi.clearAllMocks());

describe("stageRuntimeDirectory", () => {
	it("populates a clean sibling directory before writing its hash and swapping", async () => {
		const populate = vi.fn(async () => {});

		await stageRuntimeDirectory("runtime", "runtime-hash", populate);

		expect(rmSync).toHaveBeenCalledWith("runtime.tmp", {
			recursive: true,
			force: true,
		});
		expect(mkdirSync).toHaveBeenCalledWith("runtime.tmp", { recursive: true });
		expect(populate).toHaveBeenCalledWith("runtime.tmp");
		expect(writeFileSync).toHaveBeenCalledWith(
			join("runtime.tmp", ".hash"),
			"runtime-hash",
			"utf8",
		);
		expect(renameSync).toHaveBeenCalledWith("runtime.tmp", "runtime");
	});

	it("does not mark or swap a partially populated runtime", async () => {
		const error = new Error("population failed");

		await expect(
			stageRuntimeDirectory("runtime", "runtime-hash", async () => {
				throw error;
			}),
		).rejects.toThrow(error);

		expect(writeFileSync).not.toHaveBeenCalled();
		expect(renameSync).not.toHaveBeenCalled();
	});
});

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
