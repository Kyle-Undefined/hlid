import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	downloadVerifiedArchive,
	type RuntimeManifestEntry,
	verifyRuntimeTree,
} from "./bundle-whisper-assets";

const tempDirs: string[] = [];

function fixtureDir(): string {
	const dir = join(tmpdir(), `hlid-whisper-test-${randomUUID()}`);
	mkdirSync(dir);
	tempDirs.push(dir);
	return dir;
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
		const manifest: RuntimeManifestEntry[] = [
			{
				path: "Release/server.exe",
				sha256: createHash("sha256").update("reviewed").digest("hex"),
			},
		];

		expect(verifyRuntimeTree(dir, manifest)).toBe(true);
		writeFileSync(join(dir, "Release", "server.exe"), "tampered");
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
});

describe("downloadVerifiedArchive", () => {
	it("writes a response only after its digest is verified", async () => {
		const dir = fixtureDir();
		const destination = join(dir, "runtime.zip");
		const bytes = new TextEncoder().encode("reviewed archive");
		const digest = createHash("sha256").update(bytes).digest("hex");

		await downloadVerifiedArchive(
			"https://example.invalid/runtime.zip",
			destination,
			digest,
			1024,
			async () => new Response(bytes),
		);

		expect(readFileSync(destination)).toEqual(Buffer.from(bytes));
	});

	it("rejects mismatched archives without writing them", async () => {
		const dir = fixtureDir();
		const destination = join(dir, "runtime.zip");

		await expect(
			downloadVerifiedArchive(
				"https://example.invalid/runtime.zip",
				destination,
				"0".repeat(64),
				1024,
				async () => new Response("tampered"),
			),
		).rejects.toThrow("SHA-256 mismatch");
		expect(() => readFileSync(destination)).toThrow();
	});

	it("stops streamed downloads that exceed the strict size cap", async () => {
		const dir = fixtureDir();
		const destination = join(dir, "runtime.zip");
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(6));
				controller.enqueue(new Uint8Array(6));
				controller.close();
			},
		});

		await expect(
			downloadVerifiedArchive(
				"https://example.invalid/runtime.zip",
				destination,
				"0".repeat(64),
				10,
				async () => new Response(body),
			),
		).rejects.toThrow("exceeds 10 byte limit");
	});
});
