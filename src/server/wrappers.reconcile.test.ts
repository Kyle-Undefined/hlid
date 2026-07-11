import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWslUnc } from "../lib/paths";
import { syncWrappers, writeWrapper } from "./wrappers";

vi.mock("node:fs", () => ({
	mkdirSync: vi.fn(),
	readdirSync: vi.fn(),
	unlinkSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock("../lib/paths", () => ({
	APP_DIR: "/app",
	parseWslUnc: vi.fn((path: string) =>
		path.startsWith("wsl:")
			? { distro: "Ubuntu", posixPath: `/home/${path.slice(4)}` }
			: null,
	),
}));

afterEach(() => {
	vi.clearAllMocks();
	vi.mocked(parseWslUnc).mockImplementation((path: string) =>
		path.startsWith("wsl:")
			? { distro: "Ubuntu", posixPath: `/home/${path.slice(4)}` }
			: null,
	);
});

describe("wrapper filesystem reconciliation", () => {
	it("returns null when an on-demand wrapper cannot be written", () => {
		vi.mocked(writeFileSync).mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		expect(writeWrapper("wsl:agent", "codex")).toBeNull();
		expect(mkdirSync).toHaveBeenCalled();
	});

	it("contains wrapper-directory creation failures", () => {
		vi.mocked(mkdirSync).mockImplementationOnce(() => {
			throw new Error("access denied");
		});

		expect(() => syncWrappers([{ path: "wsl:agent" } as never])).not.toThrow();
		expect(writeFileSync).not.toHaveBeenCalled();
		expect(readdirSync).not.toHaveBeenCalled();
	});

	it("continues reconciliation after one wrapper write fails", () => {
		vi.mocked(writeFileSync)
			.mockImplementationOnce(() => {
				throw new Error("locked");
			})
			.mockReturnValueOnce(undefined);
		vi.mocked(readdirSync).mockReturnValue(["stale.cmd", "notes.txt"] as never);

		expect(() =>
			syncWrappers([
				{ path: "wsl:first" } as never,
				{ path: "wsl:second" } as never,
			]),
		).not.toThrow();
		expect(writeFileSync).toHaveBeenCalledTimes(2);
		expect(unlinkSync).toHaveBeenCalledWith("/app/wrappers/stale.cmd");
		expect(unlinkSync).not.toHaveBeenCalledWith("/app/wrappers/notes.txt");
	});

	it("preserves desired wrapper names when listing the directory fails", () => {
		vi.mocked(readdirSync).mockImplementationOnce(() => {
			throw new Error("busy");
		});

		expect(() => syncWrappers([{ path: "wsl:agent" } as never])).not.toThrow();
		expect(writeFileSync).toHaveBeenCalledOnce();
		expect(unlinkSync).not.toHaveBeenCalled();
	});
});
