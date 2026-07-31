import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	copyVerifiedArchive,
	parseRuntimeArtifactManifest,
	resolveLocalRuntimeArtifact,
	type RuntimeArtifactManifest,
	type RuntimeManifestEntry,
	verifyRuntimeTree,
	WHISPER_BUILD_FLAGS,
	WHISPER_LICENSE_SHA256,
	WHISPER_RUNTIME_ARTIFACT,
	WHISPER_RUNTIME_PATHS,
	WHISPER_SOURCE_COMMIT,
	WHISPER_VERSION,
	WHISPER_VULKAN_SDK_VERSION,
} from "./bundle-whisper-assets";

const tempDirs: string[] = [];

function fixtureDir(): string {
	const dir = join(tmpdir(), `hlid-whisper-test-${randomUUID()}`);
	mkdirSync(dir);
	tempDirs.push(dir);
	return dir;
}

function runtimeArtifactManifest(): RuntimeArtifactManifest {
	return {
		schemaVersion: 1,
		whisperVersion: WHISPER_VERSION,
		whisperSourceCommit: WHISPER_SOURCE_COMMIT,
		vulkanSdkVersion: WHISPER_VULKAN_SDK_VERSION,
		buildFlags: [...WHISPER_BUILD_FLAGS],
		archive: WHISPER_RUNTIME_ARTIFACT,
		archiveSha256: "a".repeat(64),
		files: WHISPER_RUNTIME_PATHS.map((path) => ({
			path,
			sha256:
				path === "Release/LICENSE"
					? WHISPER_LICENSE_SHA256
					: "b".repeat(64),
			size: 1,
		})),
	};
}

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("verifyRuntimeTree", () => {
	it("requires every reviewed file to match its SHA-256 digest", () => {
		const dir = fixtureDir();
		mkdirSync(join(dir, "Release"));
		writeFileSync(join(dir, "Release", "server.exe"), "reviewed");
		writeFileSync(join(dir, "Release", "LICENSE"), "license");
		const manifest: RuntimeManifestEntry[] = [
			{
				path: "Release/server.exe",
				sha256: createHash("sha256").update("reviewed").digest("hex"),
			},
			{
				path: "Release/LICENSE",
				sha256: createHash("sha256").update("license").digest("hex"),
			},
		];

		expect(verifyRuntimeTree(dir, manifest)).toBe(true);
		writeFileSync(join(dir, "Release", "server.exe"), "tampered");
		expect(verifyRuntimeTree(dir, manifest)).toBe(false);
	});

	it("requires the reviewed license and rejects a tampered copy", () => {
		const dir = fixtureDir();
		mkdirSync(join(dir, "Release"));
		writeFileSync(join(dir, "Release", "server.exe"), "reviewed");
		writeFileSync(join(dir, "Release", "LICENSE"), "license");
		const manifest: RuntimeManifestEntry[] = [
			{
				path: "Release/server.exe",
				sha256: createHash("sha256").update("reviewed").digest("hex"),
			},
			{
				path: "Release/LICENSE",
				sha256: createHash("sha256").update("license").digest("hex"),
			},
		];

		rmSync(join(dir, "Release", "LICENSE"));
		expect(verifyRuntimeTree(dir, manifest)).toBe(false);
		writeFileSync(join(dir, "Release", "LICENSE"), "tampered");
		expect(verifyRuntimeTree(dir, manifest)).toBe(false);
	});

	it("rejects symlinks even when their target has the expected bytes", () => {
		const dir = fixtureDir();
		mkdirSync(join(dir, "Release"));
		writeFileSync(join(dir, "target.exe"), "reviewed");
		symlinkSync(join(dir, "target.exe"), join(dir, "Release", "server.exe"));
		const manifest: RuntimeManifestEntry[] = [
			{
				path: "Release/server.exe",
				sha256: createHash("sha256").update("reviewed").digest("hex"),
			},
		];

		expect(verifyRuntimeTree(dir, manifest)).toBe(false);
	});

	it("rejects unreviewed executable and driver DLL payloads", () => {
		const dir = fixtureDir();
		mkdirSync(join(dir, "Release"));
		writeFileSync(join(dir, "Release", "server.exe"), "reviewed");
		const manifest: RuntimeManifestEntry[] = [
			{
				path: "Release/server.exe",
				sha256: createHash("sha256").update("reviewed").digest("hex"),
			},
		];
		writeFileSync(join(dir, "Release", "amdvlk64.dll"), "vendor driver");

		expect(verifyRuntimeTree(dir, manifest)).toBe(false);
	});

	it("rejects unreviewed non-binary runtime files", () => {
		const dir = fixtureDir();
		mkdirSync(join(dir, "Release"));
		writeFileSync(join(dir, "Release", "server.exe"), "reviewed");
		const manifest: RuntimeManifestEntry[] = [
			{
				path: "Release/server.exe",
				sha256: createHash("sha256").update("reviewed").digest("hex"),
			},
		];
		writeFileSync(join(dir, "Release", "notes.txt"), "unreviewed");

		expect(verifyRuntimeTree(dir, manifest)).toBe(false);
	});

	it("checks reviewed file sizes when the release manifest provides them", () => {
		const dir = fixtureDir();
		mkdirSync(join(dir, "Release"));
		writeFileSync(join(dir, "Release", "server.exe"), "reviewed");
		const manifest: RuntimeManifestEntry[] = [
			{
				path: "Release/server.exe",
				sha256: createHash("sha256").update("reviewed").digest("hex"),
				size: 7,
			},
		];

		expect(verifyRuntimeTree(dir, manifest)).toBe(false);
		manifest[0].size = 8;
		expect(verifyRuntimeTree(dir, manifest)).toBe(true);
	});
});

describe("parseRuntimeArtifactManifest", () => {
	it("accepts the pinned automatic-release contract", () => {
		expect(parseRuntimeArtifactManifest(runtimeArtifactManifest())).toEqual(
			runtimeArtifactManifest(),
		);
	});

	it("rejects unknown fields and changed provenance", () => {
		const extra = { ...runtimeArtifactManifest(), unexpected: true };
		expect(() => parseRuntimeArtifactManifest(extra)).toThrow("top-level");

		const changedSource = runtimeArtifactManifest();
		changedSource.whisperSourceCommit = "0".repeat(40);
		expect(() => parseRuntimeArtifactManifest(changedSource)).toThrow(
			"source commit",
		);
	});

	it("rejects reordered paths, invalid sizes, and a changed license", () => {
		const reordered = runtimeArtifactManifest();
		[reordered.files[0], reordered.files[1]] = [
			reordered.files[1],
			reordered.files[0],
		];
		expect(() => parseRuntimeArtifactManifest(reordered)).toThrow("path mismatch");

		const invalidSize = runtimeArtifactManifest();
		invalidSize.files[0].size = 0;
		expect(() => parseRuntimeArtifactManifest(invalidSize)).toThrow("size");

		const changedLicense = runtimeArtifactManifest();
		changedLicense.files.at(-1)!.sha256 = "c".repeat(64);
		expect(() => parseRuntimeArtifactManifest(changedLicense)).toThrow(
			"license mismatch",
		);
	});
});

describe("copyVerifiedArchive", () => {
	it("accepts the same reviewed digest contract for local validation", () => {
		const dir = fixtureDir();
		const source = join(dir, "source.zip");
		const destination = join(dir, "runtime.zip");
		writeFileSync(source, "reviewed archive");
		const digest = createHash("sha256")
			.update("reviewed archive")
			.digest("hex");

		copyVerifiedArchive(source, destination, digest, 1024);

		expect(readFileSync(destination, "utf8")).toBe("reviewed archive");
	});

	it("rejects a local archive that does not match the reviewed digest", () => {
		const dir = fixtureDir();
		const source = join(dir, "source.zip");
		writeFileSync(source, "different archive");

		expect(() =>
			copyVerifiedArchive(source, join(dir, "runtime.zip"), "0".repeat(64)),
		).toThrow("SHA-256 mismatch");
	});
});

describe("resolveLocalRuntimeArtifact", () => {
	it("requires explicit archive and manifest overrides together", () => {
		expect(
			resolveLocalRuntimeArtifact(
				"/tmp/override.zip",
				"/tmp/manifest.json",
				"/tmp/cache.zip",
				"/tmp/cache.json",
				() => true,
			),
		).toEqual({
			archive: "/tmp/override.zip",
			manifest: "/tmp/manifest.json",
		});
		expect(() =>
			resolveLocalRuntimeArtifact(
				"/tmp/override.zip",
				undefined,
				"/tmp/cache.zip",
				"/tmp/cache.json",
				() => true,
			),
		).toThrow("provided together");
	});

	it("uses the ignored dev cache only when the pair exists", () => {
		expect(
			resolveLocalRuntimeArtifact(
				undefined,
				undefined,
				"/tmp/cache.zip",
				"/tmp/cache.json",
				() => true,
			),
		).toEqual({
			archive: "/tmp/cache.zip",
			manifest: "/tmp/cache.json",
		});
	});

	it("ignores a partial cache", () => {
		expect(
			resolveLocalRuntimeArtifact(
				undefined,
				undefined,
				"/tmp/cache.zip",
				"/tmp/cache.json",
				(path) => path.endsWith(".zip"),
			),
		).toBeUndefined();
	});
});
