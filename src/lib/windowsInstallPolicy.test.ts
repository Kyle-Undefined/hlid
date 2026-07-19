import { describe, expect, it, vi } from "vitest";
import {
	migrateInstallData,
	parseAutostartExecutable,
	selectLegacyInstallDir,
	waitForCondition,
	windowsPathEquals,
} from "./windowsInstallPolicy";

describe("Windows install policy", () => {
	it("compares Windows paths case-insensitively across separators", () => {
		expect(
			windowsPathEquals("C:/Users/Kyle/Hlid", "c:\\users\\kyle\\hlid"),
		).toBe(true);
	});

	it("parses quoted and bare autostart executables", () => {
		expect(
			parseAutostartExecutable(
				'"C:\\Program Files\\Hlid\\hlid.exe" --background',
			),
		).toBe("C:\\Program Files\\Hlid\\hlid.exe");
		expect(parseAutostartExecutable("C:\\Hlid\\hlid.exe --background")).toBe(
			"C:\\Hlid\\hlid.exe",
		);
		expect(parseAutostartExecutable("  ")).toBeNull();
	});

	it("prefers an existing autostart install and falls back to a versioned DB", () => {
		const existing = new Set([
			"C:\\Old Hlid\\hlid.exe",
			"D:\\Download\\hlid.db",
		]);
		expect(
			selectLegacyInstallDir({
				autostartCommand: '"C:\\Old Hlid\\hlid.exe" --background',
				versionedDir: "D:\\Download",
				exists: (path) => existing.has(path),
			}),
		).toBe("C:\\Old Hlid");
		expect(
			selectLegacyInstallDir({
				autostartCommand: null,
				versionedDir: "D:\\Download",
				exists: (path) => existing.has(path),
			}),
		).toBe("D:\\Download");
	});

	it("copies every existing sidecar on first migration", () => {
		const copy = vi.fn();
		const existing = new Set([
			"C:\\Legacy\\hlid.config.toml",
			"C:\\Legacy\\pricing-overrides.toml",
			"C:\\Legacy\\hlid.db",
			"C:\\Legacy\\hlid.db-wal",
		]);
		expect(
			migrateInstallData({
				legacyDir: "C:\\Legacy",
				canonicalDir: "C:\\Canonical",
				exists: (path) => existing.has(path),
				copy,
			}),
		).toEqual([
			"hlid.config.toml",
			"hlid.db",
			"hlid.db-wal",
			"pricing-overrides.toml",
		]);
		expect(copy).toHaveBeenCalledTimes(4);
	});

	it("copies an existing Hlid library with the legacy install", () => {
		const copyTree = vi.fn();
		expect(
			migrateInstallData({
				legacyDir: "C:\\Legacy",
				canonicalDir: "C:\\Canonical",
				exists: (path) =>
					path === "C:\\Legacy\\hlid.db" || path === "C:\\Legacy\\library",
				copy: vi.fn(),
				copyTree,
			}),
		).toContain("library/");
		expect(copyTree).toHaveBeenCalledWith(
			"C:\\Legacy\\library",
			"C:\\Canonical\\library",
		);
	});

	it("does not overwrite an established canonical database", () => {
		const copy = vi.fn();
		migrateInstallData({
			legacyDir: "C:\\Legacy",
			canonicalDir: "C:\\Canonical",
			exists: (path) => path === "C:\\Canonical\\hlid.db",
			copy,
		});
		expect(copy).not.toHaveBeenCalled();
	});

	it("propagates copy failures instead of relaunching with partial data", () => {
		expect(() =>
			migrateInstallData({
				legacyDir: "C:\\Legacy",
				canonicalDir: "C:\\Canonical",
				exists: (path) => path === "C:\\Legacy\\hlid.db",
				copy: () => {
					throw new Error("database is locked");
				},
			}),
		).toThrow("database is locked");
	});

	it("reports success and timeout deterministically", async () => {
		let now = 0;
		let attempts = 0;
		const options = {
			intervalMs: 10,
			now: () => now,
			sleep: async (milliseconds: number) => {
				now += milliseconds;
			},
		};
		await expect(
			waitForCondition(() => ++attempts === 3, 100, options),
		).resolves.toBe(true);
		attempts = 0;
		now = 0;
		await expect(waitForCondition(() => false, 25, options)).resolves.toBe(
			false,
		);
	});
});
