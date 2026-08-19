import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";

function safeZipEntry(entry: yauzl.Entry): {
	directory: boolean;
	relativePath: string;
} {
	if (
		entry.isEncrypted() ||
		(entry.generalPurposeBitFlag & 0x2041) !== 0 ||
		!entry.canDecodeFileData()
	) {
		throw new Error("zip archive contains an unsupported entry encoding");
	}
	if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
		throw new Error("zip archive uses an unsupported compression method");
	}

	const directory = entry.fileName.endsWith("/");
	const components = entry.fileName.split("/");
	if (directory) components.pop();
	if (
		components.length === 0 ||
		components.some(
			(component) =>
				!component ||
				component === "." ||
				component === ".." ||
				component.includes("\0"),
		) ||
		entry.fileName.startsWith("/") ||
		/^[A-Za-z]:/.test(entry.fileName)
	) {
		throw new Error("zip archive contains an unsafe path");
	}

	const madeByPlatform = entry.versionMadeBy >>> 8;
	const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
	if (
		madeByPlatform === 3 &&
		unixType !== 0 &&
		unixType !== 0o100000 &&
		unixType !== 0o040000
	) {
		throw new Error("zip archive contains a link or special entry type");
	}
	if (
		madeByPlatform === 3 &&
		unixType !== 0 &&
		(directory ? unixType !== 0o040000 : unixType !== 0o100000)
	) {
		throw new Error("zip entry type metadata is inconsistent");
	}
	return { directory, relativePath: components.join("/") };
}

async function openZip(archive: string): Promise<yauzl.ZipFile> {
	return yauzl.openPromise(archive, {
		autoClose: false,
		lazyEntries: true,
		decodeStrings: true,
		validateEntrySizes: true,
		strictFileNames: true,
	});
}

export async function listZipEntries(
	archive: string,
	errorMessage: string,
): Promise<string[]> {
	let zip: yauzl.ZipFile | undefined;
	try {
		zip = await openZip(archive);
		const entries: string[] = [];
		for await (const entry of zip.eachEntry()) {
			safeZipEntry(entry);
			entries.push(entry.fileName);
		}
		return entries;
	} catch (cause) {
		throw new Error(errorMessage, { cause });
	} finally {
		if (zip?.isOpen) zip.close();
	}
}

export async function extractZipArchive(
	archive: string,
	destination: string,
	errorMessage: string,
): Promise<void> {
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true });
	let zip: yauzl.ZipFile | undefined;
	try {
		zip = await openZip(archive);
		for await (const entry of zip.eachEntry()) {
			const validated = safeZipEntry(entry);
			const outputPath = join(destination, ...validated.relativePath.split("/"));
			if (validated.directory) {
				mkdirSync(outputPath, { recursive: true });
				continue;
			}
			mkdirSync(dirname(outputPath), { recursive: true });
			const input = await zip.openReadStreamPromise(entry);
			await pipeline(
				input,
				createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
			);
		}
	} catch (cause) {
		rmSync(destination, { recursive: true, force: true });
		throw new Error(errorMessage, { cause });
	} finally {
		if (zip?.isOpen) zip.close();
	}
}
