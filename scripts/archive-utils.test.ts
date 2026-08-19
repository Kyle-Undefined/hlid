import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractZipArchive, listZipEntries } from "./archive-utils";

const ZIP_FIXTURE =
	"UEsDBBQAAAAIANm4El17DKbVCQAAAAcAAAATAAAAcGFja2FnZS9ydW50aW1lLmJpbisqzSvJzE0FAFBLAwQUAAAACADZuBJdGfRoVwkAAAAHAAAADwAAAHBhY2thZ2UvTElDRU5TRcvJTE7NK04FAFBLAQIUAxQAAAAIANm4El17DKbVCQAAAAcAAAATAAAAAAAAAAAAAACAAQAAAABwYWNrYWdlL3J1bnRpbWUuYmluUEsBAhQDFAAAAAgA2bgSXRn0aFcJAAAABwAAAA8AAAAAAAAAAAAAAIABOgAAAHBhY2thZ2UvTElDRU5TRVBLBQYAAAAAAgACAH4AAABwAAAAAAA=";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "hlid-archive-utils-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("bundled ZIP handling", () => {
	it("lists and extracts an archive without platform archive executables", async () => {
		const root = temporaryDirectory();
		const archive = join(root, "runtime.zip");
		const destination = join(root, "extracted");
		writeFileSync(archive, Buffer.from(ZIP_FIXTURE, "base64"));

		await expect(listZipEntries(archive, "inspect failed")).resolves.toEqual([
			"package/runtime.bin",
			"package/LICENSE",
		]);
		await extractZipArchive(archive, destination, "extract failed");
		expect(readFileSync(join(destination, "package/runtime.bin"), "utf8")).toBe(
			"runtime",
		);
		expect(readFileSync(join(destination, "package/LICENSE"), "utf8")).toBe(
			"license",
		);
	});
});
