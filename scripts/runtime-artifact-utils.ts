import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type StrictRuntimeManifestEntry = {
	path: string;
	sha256: string;
	size: number;
};

export type RuntimeManifestAssertion = (
	condition: unknown,
	message: string,
) => asserts condition;

export function sha256Digest(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function fileSha256(path: string): string {
	return sha256Digest(readFileSync(path));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return (
		actual.length === wanted.length &&
		actual.every((key, index) => key === wanted[index])
	);
}

export function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function createRuntimeManifestAssertion(
	runtimeName: string,
): RuntimeManifestAssertion {
	return (condition, message): asserts condition => {
		if (!condition)
			throw new Error(`invalid ${runtimeName} runtime manifest: ${message}`);
	};
}

export function parseStrictRuntimeManifestEntries(
	value: unknown,
	{
		expectedPaths,
		maxFileBytes,
		maxTotalBytes,
		assertManifest,
	}: {
		expectedPaths: readonly string[];
		maxFileBytes: number;
		maxTotalBytes: number;
		assertManifest: RuntimeManifestAssertion;
	},
): StrictRuntimeManifestEntry[] {
	const assert: RuntimeManifestAssertion = assertManifest;
	assert(Array.isArray(value), "files must be an array");
	assert(value.length === expectedPaths.length, "runtime file count mismatch");
	let totalSize = 0;
	const files = value.map((candidate, index) => {
		assert(isRecord(candidate), `file ${index} must be an object`);
		assert(
			hasExactKeys(candidate, ["path", "sha256", "size"]),
			`file ${index} has unexpected or missing fields`,
		);
		assert(
			candidate.path === expectedPaths[index],
			`file ${index} path mismatch`,
		);
		assert(isSha256(candidate.sha256), `file ${index} SHA-256`);
		assert(
			Number.isSafeInteger(candidate.size) &&
				typeof candidate.size === "number" &&
				candidate.size > 0 &&
				candidate.size <= maxFileBytes,
			`file ${index} size`,
		);
		totalSize += candidate.size;
		return {
			path: candidate.path,
			sha256: candidate.sha256,
			size: candidate.size,
		};
	});
	assert(
		Number.isSafeInteger(totalSize) && totalSize <= maxTotalBytes,
		"runtime files exceed the size limit",
	);
	return files;
}

export function manifestEntriesFromTree(
	runtimeRoot: string,
	paths: readonly string[],
): StrictRuntimeManifestEntry[] {
	return paths.map((path) => {
		const file = join(runtimeRoot, path);
		const stat = lstatSync(file);
		if (!stat.isFile()) throw new Error(`runtime file not found: ${file}`);
		return { path, sha256: fileSha256(file), size: stat.size };
	});
}
