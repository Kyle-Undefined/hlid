import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyAcpManagedArchive,
	downloadVerifiedAcpArchive,
	extractAcpManagedArchive,
	normalizeAcpManagedCommand,
} from "./acpManagedArchive";

const temporaryDirectories: string[] = [];
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1) {
		crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return crc >>> 0;
});

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "hlid-acp-archive-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function writeTarOctal(
	header: Buffer,
	offset: number,
	length: number,
	value: number,
): void {
	const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
	header.write(encoded, offset, length, "ascii");
}

function tarEntry(
	name: string,
	content: Buffer | string,
	type: "0" | "2" | "5" = "0",
): Buffer {
	const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	writeTarOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
	writeTarOctal(header, 108, 8, 0);
	writeTarOctal(header, 116, 8, 0);
	writeTarOctal(header, 124, 12, type === "0" ? bytes.length : 0);
	writeTarOctal(header, 136, 12, 0);
	header.fill(0x20, 148, 156);
	header.write(type, 156, 1, "ascii");
	header.write("ustar\0", 257, 6, "ascii");
	header.write("00", 263, 2, "ascii");
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
	header[154] = 0;
	header[155] = 0x20;
	if (type !== "0") return header;
	const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
	return Buffer.concat([header, bytes, padding]);
}

function tarGzip(...entries: Buffer[]): Buffer {
	return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

type ZipTestEntry = {
	name: string;
	content?: Buffer | string;
	method?: 0 | 8;
	externalAttributes?: number;
	flags?: number;
	crc32Override?: number;
};

function zipArchive(...entries: ZipTestEntry[]): Buffer {
	const localRecords: Buffer[] = [];
	const centralRecords: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const content = Buffer.isBuffer(entry.content)
			? entry.content
			: Buffer.from(entry.content ?? "");
		const method = entry.method ?? 0;
		const compressed = method === 8 ? deflateRawSync(content) : content;
		const flags = (entry.flags ?? 0) | 0x800;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(entry.crc32Override ?? crc32(content), 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(content.length, 22);
		local.writeUInt16LE(name.length, 26);
		const localRecord = Buffer.concat([local, name, compressed]);
		localRecords.push(localRecord);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(entry.crc32Override ?? crc32(content), 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(content.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(
			entry.externalAttributes ??
				(entry.name.endsWith("/")
					? ((0o040755 << 16) | 0x10) >>> 0
					: (0o100644 << 16) >>> 0),
			38,
		);
		central.writeUInt32LE(offset, 42);
		centralRecords.push(Buffer.concat([central, name]));
		offset += localRecord.length;
	}
	const centralDirectory = Buffer.concat(centralRecords);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localRecords, centralDirectory, end]);
}

describe("managed ACP archive selection", () => {
	it("accepts HTTPS tar-gzip, zip, exe, and raw binaries", () => {
		expect(
			classifyAcpManagedArchive("https://releases.example/agent.tar.gz"),
		).toBe("tar-gzip");
		expect(
			classifyAcpManagedArchive("https://releases.example/agent.tgz"),
		).toBe("tar-gzip");
		expect(classifyAcpManagedArchive("https://releases.example/agent")).toBe(
			"raw",
		);
		expect(
			classifyAcpManagedArchive("https://releases.example/agent.zip"),
		).toBe("zip");
		expect(
			classifyAcpManagedArchive("https://releases.example/agent.exe"),
		).toBe("raw");
		expect(
			classifyAcpManagedArchive("http://releases.example/agent"),
		).toBeNull();
	});

	it("normalizes Windows registry command separators only when requested", () => {
		expect(
			normalizeAcpManagedCommand("bin\\agent.exe", { windowsPaths: true }),
		).toBe("bin/agent.exe");
		expect(() => normalizeAcpManagedCommand("bin\\agent.exe")).toThrow(
			/safe relative/,
		);
	});

	it("normalizes only strict relative Linux command paths", () => {
		expect(normalizeAcpManagedCommand("./bin/agent")).toBe("bin/agent");
		for (const unsafe of [
			"../agent",
			"/bin/agent",
			"bin\\agent",
			"C:/agent",
			"bin/agent:stream",
			"bin/CON",
			"bin/COM¹.exe",
			"bin/LPT².log",
			"bin/CONIN$.exe",
			"bin/CONOUT$.exe",
		]) {
			expect(() => normalizeAcpManagedCommand(unsafe)).toThrow(/safe relative/);
		}
	});
});

describe("managed ACP verified downloads", () => {
	it("streams an exact HTTPS payload to disk while hashing it", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("verified managed binary");
		const sha256 = createHash("sha256").update(payload).digest("hex");
		const progress = vi.fn();
		const destination = join(root, "archive.part");

		await expect(
			downloadVerifiedAcpArchive({
				url: "https://releases.example/agent",
				sha256,
				destination,
				fetcher: async () =>
					new Response(payload, {
						status: 200,
						headers: { "content-length": String(payload.length) },
					}),
				onProgress: progress,
			}),
		).resolves.toEqual({ bytes: payload.length, sha256 });
		expect(await readFile(destination)).toEqual(payload);
		expect(progress).toHaveBeenLastCalledWith({
			received: payload.length,
			total: payload.length,
		});
	});

	it("removes partial files on checksum or size failure", async () => {
		const root = await temporaryDirectory();
		const destination = join(root, "archive.part");
		await expect(
			downloadVerifiedAcpArchive({
				url: "https://releases.example/agent",
				sha256: "0".repeat(64),
				destination,
				maxBytes: 4,
				fetcher: async () => new Response("too large"),
			}),
		).rejects.toThrow(/safety limit/);
		await expect(access(destination)).rejects.toThrow();

		await expect(
			downloadVerifiedAcpArchive({
				url: "https://releases.example/agent",
				sha256: "0".repeat(64),
				destination,
				fetcher: async () => new Response("wrong digest"),
			}),
		).rejects.toThrow(/checksum/);
		await expect(access(destination)).rejects.toThrow();
	});

	it("rejects HTTPS downgrades and truncated declared bodies", async () => {
		const root = await temporaryDirectory();
		const destination = join(root, "archive.part");
		await expect(
			downloadVerifiedAcpArchive({
				url: "https://releases.example/agent",
				sha256: "0".repeat(64),
				destination,
				fetcher: async () =>
					new Response(null, {
						status: 302,
						headers: { location: "http://mirror.example/agent" },
					}),
			}),
		).rejects.toThrow(/HTTPS/);
		await expect(access(destination)).rejects.toThrow();

		const payload = Buffer.from("short");
		await expect(
			downloadVerifiedAcpArchive({
				url: "https://releases.example/agent",
				sha256: createHash("sha256").update(payload).digest("hex"),
				destination,
				fetcher: async () =>
					new Response(payload, {
						headers: { "content-length": "100" },
					}),
			}),
		).rejects.toThrow(/length/);
		await expect(access(destination)).rejects.toThrow();
	});
});

describe("managed ACP extraction", () => {
	it("extracts a regular tar-gzip executable without trusting archive modes", async () => {
		const root = await temporaryDirectory();
		const archivePath = join(root, "agent.tgz");
		await writeFile(
			archivePath,
			tarGzip(
				tarEntry("package/", "", "5"),
				tarEntry("package/agent", "#!/bin/sh\necho ready\n"),
			),
		);

		const result = await extractAcpManagedArchive({
			archivePath,
			archiveKind: "tar-gzip",
			destination: join(root, "payload"),
			command: "./package/agent",
		});
		expect(result.commandRelativePath).toBe("package/agent");
		expect(await readFile(result.executablePath, "utf8")).toContain("ready");
		expect((await stat(result.executablePath)).mode & 0o777).toBe(0o700);
		await expect(
			access(result.executablePath, constants.X_OK),
		).resolves.toBeUndefined();
	});

	it("rejects traversal and link entries and cleans the extraction root", async () => {
		const root = await temporaryDirectory();
		for (const [filename, entry, message] of [
			["traversal.tgz", tarEntry("../escape", "bad"), /unsafe path/],
			["link.tgz", tarEntry("agent", "", "2"), /link or unsupported/],
		] as const) {
			const archivePath = join(root, filename);
			const destination = join(root, `${filename}-payload`);
			await writeFile(archivePath, tarGzip(entry));
			await expect(
				extractAcpManagedArchive({
					archivePath,
					archiveKind: "tar-gzip",
					destination,
					command: "agent",
				}),
			).rejects.toThrow(message);
			await expect(access(destination)).rejects.toThrow();
		}
		await expect(access(join(root, "escape"))).rejects.toThrow();
	});

	it("copies a verified raw binary to the declared relative command", async () => {
		const root = await temporaryDirectory();
		const archivePath = join(root, "archive.part");
		await writeFile(archivePath, "raw binary");
		const result = await extractAcpManagedArchive({
			archivePath,
			archiveKind: "raw",
			destination: join(root, "payload"),
			command: "bin/agent",
		});
		expect(await readFile(result.executablePath, "utf8")).toBe("raw binary");
	});

	it("streams a Windows ZIP to its declared executable", async () => {
		const root = await temporaryDirectory();
		const archivePath = join(root, "agent.zip");
		await writeFile(
			archivePath,
			zipArchive(
				{ name: "package/" },
				{
					name: "package/agent.exe",
					content: "windows executable",
					method: 8,
				},
			),
		);
		const result = await extractAcpManagedArchive({
			archivePath,
			archiveKind: "zip",
			destination: join(root, "zip-payload"),
			command: "package\\agent.exe",
			windowsPaths: true,
		});
		expect(result.commandRelativePath).toBe("package/agent.exe");
		expect(await readFile(result.executablePath, "utf8")).toBe(
			"windows executable",
		);
	});

	it("rejects unsafe, colliding, linked, encrypted, and oversized ZIP entries", async () => {
		const root = await temporaryDirectory();
		const cases: Array<{
			name: string;
			archive: Buffer;
			message: RegExp;
			limits?: { maxExpandedBytes?: number; maxZipCompressionRatio?: number };
		}> = [
			{
				name: "traversal",
				archive: zipArchive({ name: "../agent.exe", content: "bad" }),
				message: /unsafe path|invalid relative path/,
			},
			{
				name: "backslash",
				archive: zipArchive({ name: "bin\\agent.exe", content: "bad" }),
				message: /invalid characters|unsafe path/,
			},
			{
				name: "case-collision",
				archive: zipArchive(
					{ name: "bin/agent.exe", content: "one" },
					{ name: "BIN/AGENT.EXE", content: "two" },
				),
				message: /duplicate or case-folded/,
			},
			{
				name: "unicode-collision",
				archive: zipArchive(
					{ name: "bin/café.exe", content: "one" },
					{ name: "bin/cafe\u0301.exe", content: "two" },
				),
				message: /duplicate or case-folded/,
			},
			{
				name: "file-prefix-collision",
				archive: zipArchive(
					{ name: "bin", content: "file" },
					{ name: "bin/agent.exe", content: "nested" },
				),
				message: /conflicting file paths/,
			},
			{
				name: "device",
				archive: zipArchive({ name: "bin/CON.exe", content: "bad" }),
				message: /unsafe path/,
			},
			{
				name: "superscript-device",
				archive: zipArchive({ name: "bin/COM¹.exe", content: "bad" }),
				message: /unsafe path/,
			},
			{
				name: "console-device",
				archive: zipArchive({ name: "bin/CONOUT$.exe", content: "bad" }),
				message: /unsafe path/,
			},
			{
				name: "symlink",
				archive: zipArchive({
					name: "agent.exe",
					content: "target",
					externalAttributes: (0o120777 << 16) >>> 0,
				}),
				message: /link or special/,
			},
			{
				name: "encrypted",
				archive: zipArchive({ name: "agent.exe", content: "bad", flags: 1 }),
				message: /encrypted|size mismatch/,
			},
			{
				name: "expanded-limit",
				archive: zipArchive({ name: "agent.exe", content: "0123456789" }),
				message: /per-file|expanded-size/,
				limits: { maxExpandedBytes: 4 },
			},
			{
				name: "ratio-limit",
				archive: zipArchive({
					name: "agent.exe",
					content: "0".repeat(10_000),
					method: 8,
				}),
				message: /compression-ratio/,
				limits: { maxZipCompressionRatio: 2 },
			},
			{
				name: "crc-mismatch",
				archive: zipArchive({
					name: "agent.exe",
					content: "payload",
					crc32Override: 0,
				}),
				message: /CRC-32/,
			},
		];
		for (const testCase of cases) {
			const archivePath = join(root, `${testCase.name}.zip`);
			const destination = join(root, `${testCase.name}-payload`);
			await writeFile(archivePath, testCase.archive);
			await expect(
				extractAcpManagedArchive({
					archivePath,
					archiveKind: "zip",
					destination,
					command: "agent.exe",
					windowsPaths: true,
					...testCase.limits,
				}),
			).rejects.toThrow(testCase.message);
			await expect(access(destination)).rejects.toThrow();
		}
	});

	it("applies NTFS path collision rules to Windows tar-gzip payloads", async () => {
		const root = await temporaryDirectory();
		const archivePath = join(root, "windows.tgz");
		await writeFile(
			archivePath,
			tarGzip(
				tarEntry("bin/agent.exe", "one"),
				tarEntry("BIN/AGENT.EXE", "two"),
			),
		);
		await expect(
			extractAcpManagedArchive({
				archivePath,
				archiveKind: "tar-gzip",
				destination: join(root, "windows-tar-payload"),
				command: "bin/agent.exe",
				windowsPaths: true,
			}),
		).rejects.toThrow(/duplicate or case-folded/);
	});

	it("rejects unsafe Windows device names in tar-gzip payloads", async () => {
		const root = await temporaryDirectory();
		for (const [index, device] of [
			"CON.exe",
			"LPT³.log",
			"CONIN$.exe",
		].entries()) {
			const archivePath = join(root, `windows-device-${index}.tgz`);
			await writeFile(archivePath, tarGzip(tarEntry(`bin/${device}`, "bad")));
			await expect(
				extractAcpManagedArchive({
					archivePath,
					archiveKind: "tar-gzip",
					destination: join(root, `windows-device-payload-${index}`),
					command: "bin/agent.exe",
					windowsPaths: true,
				}),
			).rejects.toThrow(/unsafe path/);
		}
	});
});
