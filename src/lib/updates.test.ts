/**
 * updates.ts — version comparison, update status, staging cleanup.
 *
 * Strategy: mock node:fs, node:fs/promises, ./install, ./version, and the
 * global fetch so every test runs without touching disk or the network.
 * compareVersions and checksumFor are private but their logic surfaces
 * through the public getStatus / downloadUpdate API.
 *
 * Mock hygiene:
 *   - afterEach: vi.resetAllMocks() clears all implementations + queued
 *     Once values; vi.unstubAllGlobals() removes fetch stubs.
 *   - beforeEach: re-applies the default return values that resetAllMocks
 *     would otherwise strip.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock("./install", () => ({
	canonicalInstallDir: vi.fn(),
}));

vi.mock("./version", () => ({
	CURRENT_VERSION: "1.0.0",
}));

vi.mock("../server/cliUpdates", () => ({
	getCliUpdateStatuses: vi.fn().mockResolvedValue([]),
}));

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
	createWriteStream: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readdirSync: vi.fn(),
	realpathSync: vi.fn(),
	rmSync: vi.fn(),
	unlinkSync: vi.fn(),
}));

vi.mock("node:stream/promises", () => ({
	pipeline: vi.fn(),
}));

vi.mock("node:stream", () => ({
	Readable: { fromWeb: vi.fn() },
}));

// ── imports after mocks ───────────────────────────────────────────────────────

import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { getCliUpdateStatuses } from "../server/cliUpdates";
import { canonicalInstallDir } from "./install";
import {
	applyUpdate,
	cleanupStagingDir,
	downloadUpdate,
	getStatus,
} from "./updates";

// ── global test fixtures ──────────────────────────────────────────────────────

const FRESH_TS = Date.now() - 60_000; // 1 min ago — within 24h TTL
const STALE_TS = 0; // epoch — definitely stale

beforeEach(() => {
	// Re-apply defaults wiped by vi.resetAllMocks()
	vi.mocked(canonicalInstallDir).mockReturnValue("/tmp/test-hlid-install");
	vi.mocked(writeFile).mockResolvedValue(undefined as never);
	vi.mocked(existsSync).mockReturnValue(false);
	vi.mocked(mkdirSync).mockReturnValue(undefined as never);
	vi.mocked(readdirSync).mockReturnValue([] as never);
	vi.mocked(realpathSync).mockImplementation((path) => String(path));
	vi.mocked(rmSync).mockReturnValue(undefined);
	vi.mocked(unlinkSync).mockReturnValue(undefined);
	vi.mocked(getCliUpdateStatuses).mockResolvedValue([]);
});

afterEach(() => {
	vi.resetAllMocks(); // removes all mockReturnValue / mockResolvedValueOnce queues
	vi.unstubAllGlobals();
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCacheJson(
	latestVersion: string | null,
	overrides: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		schemaVersion: 2,
		lastCheckedAt: FRESH_TS,
		latestVersion,
		latestExeUrl: latestVersion
			? `https://example.com/hlid-v${latestVersion}-windows-x64.exe`
			: null,
		latestExeName: latestVersion
			? `hlid-v${latestVersion}-windows-x64.exe`
			: null,
		latestChecksumUrl: latestVersion
			? "https://example.com/hlid-checksums.txt"
			: null,
		latestReleaseName: latestVersion ? `v${latestVersion}` : null,
		latestReleasePublishedAt: latestVersion ? "2026-07-13T20:04:40Z" : null,
		latestReleaseUrl: latestVersion
			? `https://github.com/Kyle-Undefined/hlid/releases/tag/v${latestVersion}`
			: null,
		latestReleaseNotes: latestVersion
			? "## Highlights\n\n- Better Forge."
			: null,
		etag: null,
		...overrides,
	});
}

function makeGithubRelease(tag: string) {
	const ver = tag.replace(/^v/, "");
	return {
		tag_name: tag,
		name: tag,
		published_at: "2026-07-13T20:04:40Z",
		html_url: `https://github.com/Kyle-Undefined/hlid/releases/tag/${tag}`,
		body: "## Highlights\n\n- Better Forge.",
		prerelease: false,
		assets: [
			{
				name: `hlid-v${ver}-windows-x64.exe`,
				browser_download_url: `https://example.com/${tag}.exe`,
			},
			{
				name: "hlid-checksums.txt",
				browser_download_url: "https://example.com/checksums.txt",
			},
		],
	};
}

// ── getStatus — fresh cache (no network call) ─────────────────────────────────

describe("getStatus — fresh cache", () => {
	it("returns cached version without hitting the network", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(makeCacheJson("2.0.0") as never);
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const status = await getStatus();

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(status.latest).toBe("2.0.0");
		expect(status.current).toBe("1.0.0");
		expect(status.release).toMatchObject({
			version: "2.0.0",
			name: "v2.0.0",
			notes: "## Highlights\n\n- Better Forge.",
		});
	});

	it("migrates a fresh legacy cache so release notes are not hidden by its ETag", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(
			makeCacheJson("2.0.0", {
				schemaVersion: 0,
				etag: '"legacy"',
				latestReleaseUrl: null,
				latestReleaseNotes: null,
			}) as never,
		);
		const fetchMock = vi.fn().mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ etag: '"current"' }),
			json: async () => makeGithubRelease("v2.0.0"),
		});
		vi.stubGlobal("fetch", fetchMock);

		const status = await getStatus();

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(
			(fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers,
		).not.toMatchObject({ "If-None-Match": '"legacy"' });
		expect(status.release?.notes).toContain("Better Forge");
	});

	it("available: true when latest > current", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(makeCacheJson("2.0.0") as never);
		const status = await getStatus();
		expect(status.available).toBe(true);
	});

	it("available: false when latest === current", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(makeCacheJson("1.0.0") as never);
		const status = await getStatus();
		expect(status.available).toBe(false);
	});

	it("available: false when latest < current", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(makeCacheJson("0.9.9") as never);
		const status = await getStatus();
		expect(status.available).toBe(false);
	});

	it("available: false when latest is null (no info yet)", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(makeCacheJson(null) as never);
		const status = await getStatus();
		expect(status.available).toBe(false);
		expect(status.latest).toBeNull();
	});
});

// ── getStatus — version string edge cases ─────────────────────────────────────

describe("getStatus — version comparison edge cases", () => {
	it("patch increment makes update available", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(makeCacheJson("1.0.1") as never);
		const status = await getStatus();
		expect(status.available).toBe(true);
	});

	it("minor increment makes update available", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(makeCacheJson("1.1.0") as never);
		const status = await getStatus();
		expect(status.available).toBe(true);
	});

	it("major increment makes update available", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(makeCacheJson("10.0.0") as never);
		const status = await getStatus();
		expect(status.available).toBe(true);
	});

	it("older patch version is not available", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(makeCacheJson("0.9.9") as never);
		const status = await getStatus();
		expect(status.available).toBe(false);
	});
});

// ── getStatus — stale cache triggers network refresh ──────────────────────────

describe("getStatus — stale cache", () => {
	it("fetches GitHub when cache is stale and updates available field", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(
			JSON.stringify({
				lastCheckedAt: STALE_TS,
				latestVersion: "1.5.0",
				latestExeUrl: "https://example.com/old.exe",
				latestExeName: "hlid-v1.5.0-windows-x64.exe",
				latestChecksumUrl: "https://example.com/old-checksums.txt",
				etag: null,
			}) as never,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: new Headers({ etag: '"newetag"' }),
				json: async () => makeGithubRelease("v3.0.0"),
			}),
		);

		const status = await getStatus();
		expect(status.latest).toBe("3.0.0");
		expect(status.available).toBe(true);
	});

	it("handles 304 Not Modified by refreshing lastCheckedAt without re-fetching", async () => {
		const cache = {
			lastCheckedAt: STALE_TS,
			latestVersion: "2.0.0",
			latestExeUrl: "https://example.com/exe",
			latestExeName: "hlid-v2.0.0-windows-x64.exe",
			latestChecksumUrl: "https://example.com/checksums.txt",
			etag: '"abc"',
		};
		vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(cache) as never);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({ ok: false, status: 304 }),
		);

		const status = await getStatus();
		expect(status.latest).toBe("2.0.0");
	});

	it("soft-fails on network error without clearing cached version", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(
			JSON.stringify({
				lastCheckedAt: STALE_TS,
				latestVersion: "2.0.0",
				latestExeUrl: "https://example.com/exe",
				latestExeName: "hlid-v2.0.0-windows-x64.exe",
				latestChecksumUrl: "https://example.com/checksums.txt",
				etag: null,
			}) as never,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValueOnce(new Error("network unavailable")),
		);

		const status = await getStatus();
		expect(status.latest).toBe("2.0.0");
		expect(status.error).toContain("network");
	});

	it("soft-fails on GitHub 5xx without clearing cached version", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(
			JSON.stringify({
				lastCheckedAt: STALE_TS,
				latestVersion: "1.5.0",
				latestExeUrl: "https://example.com/exe",
				latestExeName: "hlid-v1.5.0-windows-x64.exe",
				latestChecksumUrl: "https://example.com/checksums.txt",
				etag: null,
			}) as never,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: false,
				status: 503,
				headers: new Headers(),
			}),
		);

		const status = await getStatus();
		expect(status.latest).toBe("1.5.0");
		expect(status.error).toContain("github 503");
	});

	it("rejects a prerelease as 'latest'", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(
			JSON.stringify({
				lastCheckedAt: STALE_TS,
				latestVersion: null,
				latestExeUrl: null,
				latestExeName: null,
				latestChecksumUrl: null,
				etag: null,
			}) as never,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: new Headers(),
				json: async () => ({
					tag_name: "v2.0.0-beta.1",
					prerelease: true,
					assets: [],
				}),
			}),
		);

		const status = await getStatus();
		expect(status.error).toContain("prerelease");
	});

	it("returns rate-limit error string for 429 response", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(
			JSON.stringify({
				lastCheckedAt: STALE_TS,
				latestVersion: null,
				latestExeUrl: null,
				latestExeName: null,
				latestChecksumUrl: null,
				etag: null,
			}) as never,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: false,
				status: 429,
				headers: new Headers({ "x-ratelimit-remaining": "0" }),
			}),
		);

		const status = await getStatus();
		expect(status.error).toContain("rate-limited");
	});
});

// ── getStatus — force refresh ─────────────────────────────────────────────────

describe("getStatus — force refresh", () => {
	it("bypasses TTL and fetches network when force:true", async () => {
		// Cache is fresh but force=true bypasses TTL
		vi.mocked(readFile).mockResolvedValueOnce(makeCacheJson("1.0.0") as never);
		const fetchMock = vi.fn().mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ etag: '"x"' }),
			json: async () => makeGithubRelease("v1.0.0"),
		});
		vi.stubGlobal("fetch", fetchMock);

		await getStatus({ force: true });
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});

// ── getStatus — cache file edge cases ────────────────────────────────────────

describe("getStatus — cache file edge cases", () => {
	it("handles missing cache file (ENOENT) gracefully", async () => {
		vi.mocked(readFile).mockRejectedValueOnce(
			Object.assign(new Error("no such file"), { code: "ENOENT" }) as never,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: new Headers(),
				json: async () => makeGithubRelease("v2.0.0"),
			}),
		);

		const status = await getStatus();
		expect(status.latest).toBe("2.0.0");
	});

	it("handles corrupt cache JSON gracefully", async () => {
		vi.mocked(readFile).mockResolvedValueOnce("not-json{{{" as never);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")));

		const status = await getStatus();
		expect(status.latest).toBeNull();
	});
});

// ── downloadUpdate — early exits ──────────────────────────────────────────────

describe("downloadUpdate — early exits", () => {
	it("cannot apply a caller-selected path without a server-verified artifact", async () => {
		const result = await (
			applyUpdate as unknown as (
				ignoredPath: string,
			) => ReturnType<typeof applyUpdate>
		)("/tmp/caller-selected.exe");
		expect(result).toEqual({
			ok: false,
			error: "no verified staged update; re-download",
		});
	});

	it("revalidates the server-held artifact checksum immediately before apply", async () => {
		const filename = "hlid-v2.0.0-windows-x64.exe";
		const verifiedBytes = Buffer.from("verified release");
		const digest = createHash("sha256").update(verifiedBytes).digest("hex");
		vi.mocked(readFile)
			.mockResolvedValueOnce(makeCacheJson("2.0.0") as never)
			.mockResolvedValueOnce(`${digest}  ${filename}\n` as never)
			.mockResolvedValueOnce(verifiedBytes as never);
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					body: new ReadableStream<Uint8Array>(),
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					body: new ReadableStream<Uint8Array>(),
				}),
		);

		expect((await downloadUpdate()).ok).toBe(true);
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFile).mockResolvedValueOnce(Buffer.from("tampered") as never);

		const result = await applyUpdate();
		expect(result).toEqual({
			ok: false,
			error: "staged exe checksum changed; re-download",
		});
	});

	it("returns error when cache has no update info", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(
			JSON.stringify({
				lastCheckedAt: FRESH_TS,
				latestVersion: null,
				latestExeUrl: null,
				latestExeName: null,
				latestChecksumUrl: null,
				etag: null,
			}) as never,
		);
		const result = await downloadUpdate();
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error).toBe("no update info; run check first");
	});

	it("returns error when already on latest version (equal)", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(
			makeCacheJson("1.0.0") as never, // same as CURRENT_VERSION mock
		);
		const result = await downloadUpdate();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("already on latest");
	});

	it("returns error when installed version is newer than latest (no downgrade)", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(
			makeCacheJson("0.5.0") as never, // older than CURRENT_VERSION "1.0.0"
		);
		const result = await downloadUpdate();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("already on latest");
	});

	it("returns error when cache readFile fails", async () => {
		vi.mocked(readFile).mockRejectedValueOnce(
			Object.assign(new Error("I/O error"), { code: "EIO" }) as never,
		);
		const result = await downloadUpdate();
		expect(result.ok).toBe(false);
		// Falls back to EMPTY_CACHE (null fields) → "no update info"
		if (!result.ok)
			expect(result.error).toBe("no update info; run check first");
	});
});

// ── cleanupStagingDir ─────────────────────────────────────────────────────────

describe("cleanupStagingDir", () => {
	it("is a no-op when staging dir does not exist", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		cleanupStagingDir();
		expect(rmSync).not.toHaveBeenCalled();
	});

	it("removes all files when staging dir exists", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readdirSync).mockReturnValue([
			"hlid-v2.0.0-windows-x64.exe",
			"hlid-checksums.txt",
		] as unknown as ReturnType<typeof readdirSync>);

		cleanupStagingDir();

		expect(rmSync).toHaveBeenCalledTimes(2);
		const calls = vi.mocked(rmSync).mock.calls.map((c) => c[0] as string);
		expect(calls.some((p) => p.includes("hlid-v2.0.0"))).toBe(true);
		expect(calls.some((p) => p.includes("hlid-checksums"))).toBe(true);
	});

	it("does not throw if rmSync fails on an individual file", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readdirSync).mockReturnValue([
			"corrupted.tmp",
		] as unknown as ReturnType<typeof readdirSync>);
		vi.mocked(rmSync).mockImplementationOnce(() => {
			throw new Error("permission denied");
		});

		expect(() => cleanupStagingDir()).not.toThrow();
	});

	it("does not throw if readdirSync fails", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readdirSync).mockImplementationOnce(() => {
			throw new Error("I/O error");
		});

		expect(() => cleanupStagingDir()).not.toThrow();
	});

	it("does not call rmSync when dir exists but is empty", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readdirSync).mockReturnValue([] as never);

		cleanupStagingDir();
		expect(rmSync).not.toHaveBeenCalled();
	});
});
