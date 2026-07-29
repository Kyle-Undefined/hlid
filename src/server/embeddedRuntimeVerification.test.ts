import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRuntimeDirectory } from "./embeddedRuntime";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("verifyRuntimeDirectory", () => {
	it("requires a matching hash and every requested file", () => {
		const directory = temporaryDirectory("hlid-runtime-");
		writeFileSync(join(directory, ".hash"), "current");
		writeFileSync(join(directory, "runtime.exe"), "runtime");

		expect(verifyRuntimeDirectory(directory, "current", ["runtime.exe"])).toBe(
			directory,
		);
		expect(
			verifyRuntimeDirectory(directory, "stale", ["runtime.exe"]),
		).toBeNull();
		expect(
			verifyRuntimeDirectory(directory, "current", ["missing.dll"]),
		).toBeNull();
	});

	it("can require regular files contained by the runtime directory", () => {
		const directory = temporaryDirectory("hlid-runtime-");
		writeFileSync(join(directory, ".hash"), "current");
		mkdirSync(join(directory, "runtime.exe"));

		expect(
			verifyRuntimeDirectory(directory, "current", ["runtime.exe"], {
				requireContainedRegularFiles: true,
			}),
		).toBeNull();
	});

	it.skipIf(process.platform === "win32")(
		"rejects a required file that escapes through a linked directory",
		() => {
			const directory = temporaryDirectory("hlid-runtime-");
			const outside = temporaryDirectory("hlid-runtime-outside-");
			writeFileSync(join(directory, ".hash"), "current");
			writeFileSync(join(outside, "runtime.exe"), "runtime");
			symlinkSync(outside, join(directory, "linked"), "dir");

			expect(
				verifyRuntimeDirectory(directory, "current", ["linked/runtime.exe"], {
					requireContainedRegularFiles: true,
				}),
			).toBeNull();
		},
	);
});
