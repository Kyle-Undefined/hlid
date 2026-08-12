import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	open,
	realpath,
	rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { createGunzip } from "node:zlib";
import * as yauzl from "yauzl";

const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_PATH_BYTES = 1_024;
const DEFAULT_MAX_ZIP_COMPRESSION_RATIO = 1_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_REDIRECTS = 5;
const TAR_BLOCK_BYTES = 512;
const SHA256_RE = /^[a-f0-9]{64}$/;
const WINDOWS_DEVICE_NAME_RE =
	/^(?:con|prn|aux|nul|conin\$|conout\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/i;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1) {
		crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return crc >>> 0;
});

export type AcpManagedArchiveKind = "tar-gzip" | "zip" | "raw";

export type AcpManagedDownloadProgress = {
	received: number;
	total: number | null;
};

export type AcpManagedArchiveLimits = {
	maxDownloadBytes?: number;
	maxExpandedBytes?: number;
	maxFileBytes?: number;
	maxEntries?: number;
	maxPathBytes?: number;
	maxZipCompressionRatio?: number;
};

export type AcpManagedFetcher = (
	input: string,
	init: RequestInit,
) => Promise<Response>;

export type AcpManagedDownloadOptions = {
	url: string;
	sha256: string;
	destination: string;
	signal?: AbortSignal;
	fetcher?: AcpManagedFetcher;
	maxBytes?: number;
	timeoutMs?: number;
	onProgress?: (progress: AcpManagedDownloadProgress) => void;
	onVerifying?: () => void;
};

export type AcpManagedDownloadResult = {
	bytes: number;
	sha256: string;
};

export type AcpManagedExtractOptions = AcpManagedArchiveLimits & {
	archivePath: string;
	archiveKind: AcpManagedArchiveKind;
	destination: string;
	command: string;
	windowsPaths?: boolean;
	signal?: AbortSignal;
};

export type AcpManagedExtractResult = {
	commandRelativePath: string;
	executablePath: string;
	extractedBytes: number;
	entries: number;
};

function abortIfNeeded(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}

function positiveLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("archive safety limits must be positive integers");
	}
	return value;
}

function archiveExtractionLimits(options: AcpManagedExtractOptions): {
	maxExpandedBytes: number;
	maxFileBytes: number;
	maxEntries: number;
	maxPathBytes: number;
} {
	return {
		maxExpandedBytes: positiveLimit(
			options.maxExpandedBytes,
			DEFAULT_MAX_EXPANDED_BYTES,
		),
		maxFileBytes: positiveLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
		maxEntries: positiveLimit(options.maxEntries, DEFAULT_MAX_ENTRIES),
		maxPathBytes: positiveLimit(options.maxPathBytes, DEFAULT_MAX_PATH_BYTES),
	};
}

async function writeAll(
	handle: Awaited<ReturnType<typeof open>>,
	chunk: Buffer,
): Promise<void> {
	let offset = 0;
	while (offset < chunk.length) {
		const { bytesWritten } = await handle.write(
			chunk,
			offset,
			chunk.length - offset,
		);
		if (bytesWritten <= 0) throw new Error("managed ACP file write stalled");
		offset += bytesWritten;
	}
}

function updateCrc32(crc: number, chunk: Buffer): number {
	let next = crc;
	for (const byte of chunk) {
		next = (CRC32_TABLE[(next ^ byte) & 0xff] ?? 0) ^ (next >>> 8);
	}
	return next >>> 0;
}

function unsafeManagedPathComponent(component: string): boolean {
	const hasControlCharacter = [...component].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 0x20 || code === 0x7f;
	});
	return (
		!component ||
		component === "." ||
		component === ".." ||
		hasControlCharacter ||
		/[<>:"|?*]/.test(component) ||
		/[. ]$/.test(component) ||
		WINDOWS_DEVICE_NAME_RE.test(component)
	);
}

function validateHttpsUrl(value: string | URL): URL {
	let url: URL;
	try {
		url = value instanceof URL ? value : new URL(value);
	} catch {
		throw new Error("managed ACP distribution URL is invalid");
	}
	if (url.protocol !== "https:") {
		throw new Error("managed ACP distributions must use HTTPS");
	}
	if (url.username || url.password) {
		throw new Error("managed ACP distribution URLs cannot contain credentials");
	}
	return url;
}

async function fetchWithVerifiedRedirects(
	initialUrl: URL,
	fetcher: AcpManagedFetcher,
	signal: AbortSignal,
): Promise<Response> {
	let current = initialUrl;
	for (let redirects = 0; redirects <= MAX_DOWNLOAD_REDIRECTS; redirects += 1) {
		const response = await fetcher(current.href, {
			headers: {
				Accept: "application/octet-stream",
				"User-Agent": "hlid-acp-managed-installer",
			},
			redirect: "manual",
			signal,
		});
		if (![301, 302, 303, 307, 308].includes(response.status)) {
			if (response.url) validateHttpsUrl(response.url);
			return response;
		}
		await response.body?.cancel().catch(() => {});
		if (redirects === MAX_DOWNLOAD_REDIRECTS) {
			throw new Error("managed ACP download has too many redirects");
		}
		const location = response.headers.get("location");
		if (!location) {
			throw new Error("managed ACP download redirect has no location");
		}
		try {
			current = validateHttpsUrl(new URL(location, current));
		} catch (error) {
			if (error instanceof Error && /HTTPS|credentials/.test(error.message)) {
				throw error;
			}
			throw new Error("managed ACP download redirect is invalid");
		}
	}
	throw new Error("managed ACP download has too many redirects");
}

/**
 * The first managed slice accepts only formats that can be extracted without
 * invoking a platform shell. Unknown archive-looking suffixes fail closed;
 * extensionless and ordinary binary filenames are treated as raw executables.
 */
export function classifyAcpManagedArchive(
	archiveUrl: string,
): AcpManagedArchiveKind | null {
	let filename: string;
	try {
		const url = new URL(archiveUrl);
		if (url.protocol !== "https:") return null;
		filename = decodeURIComponent(basename(url.pathname)).toLowerCase();
	} catch {
		return null;
	}
	if (!filename || filename === "." || filename === "..") return null;
	if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) {
		return "tar-gzip";
	}
	if (filename.endsWith(".zip")) return "zip";
	if (filename.endsWith(".exe")) return "raw";
	if (/\.(?:tar|gz|bz2|xz|7z|tbz2?|txz|dmg|pkg|deb|rpm|msi)$/i.test(filename)) {
		return null;
	}
	return "raw";
}

/** Return a strict slash-delimited command path safe on Linux and Windows. */
export function normalizeAcpManagedCommand(
	command: string,
	options: { windowsPaths?: boolean } = {},
): string {
	let normalized = command.trim();
	if (options.windowsPaths) normalized = normalized.replaceAll("\\", "/");
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	if (
		!normalized ||
		normalized.includes("\0") ||
		normalized.includes("\\") ||
		normalized.startsWith("/") ||
		/^[A-Za-z]:/.test(normalized) ||
		Buffer.byteLength(normalized) > DEFAULT_MAX_PATH_BYTES
	) {
		throw new Error("managed ACP command must be a safe relative path");
	}
	const components = normalized.split("/");
	if (components.some(unsafeManagedPathComponent)) {
		throw new Error("managed ACP command must be a safe relative path");
	}
	return components.join("/");
}

export async function downloadVerifiedAcpArchive(
	options: AcpManagedDownloadOptions,
): Promise<AcpManagedDownloadResult> {
	const expected = options.sha256.trim().toLowerCase();
	if (!SHA256_RE.test(expected)) {
		throw new Error(
			"managed ACP distribution requires an exact SHA-256 digest",
		);
	}
	const source = validateHttpsUrl(options.url);
	const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_DOWNLOAD_BYTES);
	const timeoutMs = positiveLimit(
		options.timeoutMs,
		DEFAULT_DOWNLOAD_TIMEOUT_MS,
	);
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeoutSignal])
		: timeoutSignal;
	const fetcher = options.fetcher ?? fetch;
	await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 });
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		abortIfNeeded(signal);
		const response = await fetchWithVerifiedRedirects(source, fetcher, signal);
		if (!response.ok || !response.body) {
			throw new Error(
				`managed ACP download failed with HTTP ${response.status}`,
			);
		}
		const declaredHeader = response.headers.get("content-length");
		const declared = declaredHeader === null ? null : Number(declaredHeader);
		if (
			declared !== null &&
			(!Number.isSafeInteger(declared) || declared < 0)
		) {
			throw new Error("managed ACP download has an invalid content length");
		}
		if (declared !== null && declared > maxBytes) {
			throw new Error("managed ACP download exceeds the safety limit");
		}

		handle = await open(options.destination, "wx", 0o600);
		const digest = createHash("sha256");
		const reader = response.body.getReader();
		let received = 0;
		try {
			for (;;) {
				abortIfNeeded(signal);
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > maxBytes) {
					await reader.cancel();
					throw new Error("managed ACP download exceeds the safety limit");
				}
				const chunk = Buffer.from(value);
				digest.update(chunk);
				await writeAll(handle, chunk);
				options.onProgress?.({ received, total: declared });
			}
		} finally {
			reader.releaseLock();
		}
		if (declared !== null && received !== declared) {
			throw new Error(
				"managed ACP download length did not match Content-Length",
			);
		}
		await handle.sync();
		await handle.close();
		handle = undefined;
		options.onVerifying?.();
		const actual = digest.digest("hex");
		if (actual !== expected) {
			throw new Error(
				"managed ACP archive checksum did not match the registry",
			);
		}
		return { bytes: received, sha256: actual };
	} catch (error) {
		await handle?.close().catch(() => {});
		await rm(options.destination, { force: true }).catch(() => {});
		throw error;
	}
}

function parseTarString(field: Buffer, label: string): string {
	const nul = field.indexOf(0);
	const bytes = nul === -1 ? field : field.subarray(0, nul);
	const value = bytes.toString("utf8");
	if (value.includes("\uFFFD"))
		throw new Error(`tar ${label} is not valid UTF-8`);
	return value;
}

function parseTarNumber(field: Buffer, label: string): number {
	if ((field[0] ?? 0) & 0x80) {
		throw new Error(`tar ${label} uses an unsupported base-256 value`);
	}
	const value = parseTarString(field, label).trim();
	if (!value) return 0;
	if (!/^[0-7]+$/.test(value)) throw new Error(`tar ${label} is invalid`);
	const parsed = Number.parseInt(value, 8);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`tar ${label} exceeds the safety limit`);
	}
	return parsed;
}

function verifyTarChecksum(header: Buffer): void {
	const expected = parseTarNumber(header.subarray(148, 156), "checksum");
	let actual = 0;
	for (let index = 0; index < header.length; index += 1) {
		actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
	}
	if (actual !== expected) throw new Error("tar header checksum is invalid");
}

function normalizeArchiveEntryPath(
	raw: string,
	maxPathBytes: number,
	archive: "tar" | "zip",
): string {
	let value = raw;
	while (value.startsWith("./")) value = value.slice(2);
	while (value.endsWith("/")) value = value.slice(0, -1);
	if (
		!value ||
		value.includes("\0") ||
		value.includes("\\") ||
		value.startsWith("/") ||
		/^[A-Za-z]:/.test(value) ||
		Buffer.byteLength(value) > maxPathBytes ||
		(archive === "zip" && Buffer.from(value, "utf8").toString("utf8") !== value)
	) {
		throw new Error(`${archive} entry has an unsafe path`);
	}
	const components = value.split("/");
	if (components.some(unsafeManagedPathComponent)) {
		throw new Error(`${archive} entry has an unsafe path`);
	}
	return components.join("/");
}

function destinationPath(root: string, archivePath: string): string {
	return join(root, ...archivePath.split("/"));
}

function claimWindowsArchivePath(
	claims: ZipPathClaims | undefined,
	archivePath: string,
	kind: ZipEntryKind,
): void {
	claims?.claim(archivePath, kind);
}

async function extractTarGzip(
	options: AcpManagedExtractOptions,
): Promise<{ entries: number; extractedBytes: number }> {
	const { maxExpandedBytes, maxFileBytes, maxEntries, maxPathBytes } =
		archiveExtractionLimits(options);
	const stream = createReadStream(options.archivePath).pipe(createGunzip());
	let pending = Buffer.alloc(0);
	let zeroBlocks = 0;
	let ended = false;
	let entries = 0;
	let extractedBytes = 0;
	let expandedStreamBytes = 0;
	const windowsClaims = options.windowsPaths ? new ZipPathClaims() : undefined;
	let current:
		| {
				handle: Awaited<ReturnType<typeof open>>;
				remaining: number;
				padding: number;
				mode: number;
		  }
		| undefined;

	try {
		for await (const value of stream) {
			abortIfNeeded(options.signal);
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			expandedStreamBytes += chunk.length;
			if (expandedStreamBytes > maxExpandedBytes) {
				throw new Error("tar archive exceeds the expanded-size safety limit");
			}
			pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			for (;;) {
				abortIfNeeded(options.signal);
				if (ended) {
					if (pending.some((byte) => byte !== 0)) {
						throw new Error("tar archive has data after its end marker");
					}
					pending = Buffer.alloc(0);
					break;
				}
				if (current) {
					if (current.remaining > 0) {
						if (pending.length === 0) break;
						const count = Math.min(current.remaining, pending.length);
						await writeAll(current.handle, pending.subarray(0, count));
						pending = pending.subarray(count);
						current.remaining -= count;
						if (current.remaining > 0) break;
						await current.handle.sync();
						await current.handle.chmod(current.mode);
						await current.handle.close();
					}
					if (pending.length < current.padding) break;
					const padding = pending.subarray(0, current.padding);
					if (padding.some((byte) => byte !== 0)) {
						throw new Error("tar entry padding is invalid");
					}
					pending = pending.subarray(current.padding);
					current = undefined;
					continue;
				}
				if (pending.length < TAR_BLOCK_BYTES) break;
				const header = pending.subarray(0, TAR_BLOCK_BYTES);
				pending = pending.subarray(TAR_BLOCK_BYTES);
				if (header.every((byte) => byte === 0)) {
					zeroBlocks += 1;
					if (zeroBlocks === 2) ended = true;
					continue;
				}
				if (zeroBlocks !== 0) {
					throw new Error("tar archive has an incomplete end marker");
				}
				verifyTarChecksum(header);
				const name = parseTarString(header.subarray(0, 100), "name");
				const prefix = parseTarString(header.subarray(345, 500), "prefix");
				const archivePath = normalizeArchiveEntryPath(
					prefix ? `${prefix}/${name}` : name,
					maxPathBytes,
					"tar",
				);
				const size = parseTarNumber(header.subarray(124, 136), "size");
				const archiveMode = parseTarNumber(header.subarray(100, 108), "mode");
				const type = header[156] ?? 0;
				entries += 1;
				if (entries > maxEntries) {
					throw new Error("tar archive has too many entries");
				}
				if (size > maxFileBytes) {
					throw new Error("tar entry exceeds the per-file safety limit");
				}
				extractedBytes += size;
				if (extractedBytes > maxExpandedBytes) {
					throw new Error("tar archive exceeds the expanded-size safety limit");
				}
				const outputPath = destinationPath(options.destination, archivePath);
				if (type === 0x35) {
					if (size !== 0) throw new Error("tar directory entry has content");
					claimWindowsArchivePath(windowsClaims, archivePath, "directory");
					await mkdir(outputPath, { recursive: true, mode: 0o700 });
					continue;
				}
				if (type !== 0 && type !== 0x30) {
					throw new Error(
						"tar archive contains a link or unsupported entry type",
					);
				}
				claimWindowsArchivePath(windowsClaims, archivePath, "file");
				await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
				const handle = await open(outputPath, "wx", 0o600);
				current = {
					handle,
					remaining: size,
					padding:
						(TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES,
					mode: archiveMode & 0o111 ? 0o700 : 0o600,
				};
				if (size === 0) {
					await handle.sync();
					await handle.chmod(current.mode);
					await handle.close();
				}
			}
		}
	} catch (error) {
		stream.destroy();
		await current?.handle.close().catch(() => {});
		throw error;
	}
	if (current || !ended || entries === 0) {
		await current?.handle.close().catch(() => {});
		throw new Error("tar archive is truncated or empty");
	}
	return { entries, extractedBytes };
}

type ZipEntryKind = "directory" | "file";

function zipEntryKind(entry: yauzl.Entry): ZipEntryKind {
	const madeByPlatform = entry.versionMadeBy >>> 8;
	const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
	const unixType = unixMode & 0o170000;
	const dosAttributes = entry.externalFileAttributes & 0xff;
	const hasDirectorySuffix = entry.fileName.endsWith("/");
	const hasDosDirectoryAttribute = (dosAttributes & 0x10) !== 0;

	if ((dosAttributes & 0x08) !== 0) {
		throw new Error("zip archive contains a special entry type");
	}
	if (madeByPlatform === 3 && unixType !== 0) {
		if (unixType !== 0o100000 && unixType !== 0o040000) {
			throw new Error("zip archive contains a link or special entry type");
		}
		const unixDirectory = unixType === 0o040000;
		if (
			unixDirectory !== hasDirectorySuffix ||
			unixDirectory !== hasDosDirectoryAttribute
		) {
			throw new Error("zip entry type metadata is inconsistent");
		}
		return unixDirectory ? "directory" : "file";
	}
	if (hasDirectorySuffix !== hasDosDirectoryAttribute) {
		throw new Error("zip entry type metadata is inconsistent");
	}
	return hasDirectorySuffix ? "directory" : "file";
}

function windowsPathKey(path: string): string {
	return path
		.split("/")
		.map((component) => component.normalize("NFC").toLowerCase())
		.join("/");
}

class ZipPathClaims {
	private readonly spellings = new Map<string, string>();
	private readonly entries = new Set<string>();
	private readonly filePaths = new Set<string>();
	private readonly parentPaths = new Set<string>();

	claim(path: string, kind: ZipEntryKind): void {
		const components = path.split("/");
		const fullKey = windowsPathKey(path);
		if (this.entries.has(fullKey)) {
			throw new Error("zip archive contains duplicate or case-folded paths");
		}
		for (let length = 1; length <= components.length; length += 1) {
			const spelling = components.slice(0, length).join("/");
			const key = windowsPathKey(spelling);
			const priorSpelling = this.spellings.get(key);
			if (priorSpelling !== undefined && priorSpelling !== spelling) {
				throw new Error("zip archive contains duplicate or case-folded paths");
			}
			this.spellings.set(key, spelling);
			if (length < components.length) {
				if (this.filePaths.has(key)) {
					throw new Error("zip archive contains conflicting file paths");
				}
				this.parentPaths.add(key);
			}
		}
		if (kind === "file" && this.parentPaths.has(fullKey)) {
			throw new Error("zip archive contains conflicting file paths");
		}
		this.entries.add(fullKey);
		if (kind === "file") this.filePaths.add(fullKey);
	}
}

function validateZipEntryEncoding(entry: yauzl.Entry): void {
	if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x2041) !== 0) {
		throw new Error("zip archive contains an encrypted entry");
	}
	if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
		throw new Error("zip archive uses an unsupported compression method");
	}
	if (!entry.canDecodeFileData()) {
		throw new Error("zip archive contains an unsupported entry encoding");
	}
}

async function extractZip(
	options: AcpManagedExtractOptions,
): Promise<{ entries: number; extractedBytes: number }> {
	const { maxExpandedBytes, maxFileBytes, maxEntries, maxPathBytes } =
		archiveExtractionLimits(options);
	const maxCompressionRatio = positiveLimit(
		options.maxZipCompressionRatio,
		DEFAULT_MAX_ZIP_COMPRESSION_RATIO,
	);
	const zip = await yauzl.openPromise(options.archivePath, {
		autoClose: false,
		lazyEntries: true,
		decodeStrings: true,
		validateEntrySizes: true,
		strictFileNames: true,
	});
	const claims = new ZipPathClaims();
	let entries = 0;
	let extractedBytes = 0;
	try {
		if (zip.entryCount <= 0) throw new Error("zip archive is empty");
		if (zip.entryCount > maxEntries) {
			throw new Error("zip archive has too many entries");
		}
		for await (const entry of zip.eachEntry()) {
			abortIfNeeded(options.signal);
			entries += 1;
			if (entries > maxEntries) {
				throw new Error("zip archive has too many entries");
			}
			validateZipEntryEncoding(entry);
			if (
				!Number.isSafeInteger(entry.compressedSize) ||
				entry.compressedSize < 0 ||
				!Number.isSafeInteger(entry.uncompressedSize) ||
				entry.uncompressedSize < 0
			) {
				throw new Error("zip entry size exceeds the safety limit");
			}
			const kind = zipEntryKind(entry);
			const archivePath = normalizeArchiveEntryPath(
				entry.fileName,
				maxPathBytes,
				"zip",
			);
			claims.claim(archivePath, kind);
			if (kind === "directory") {
				if (entry.compressedSize !== 0 || entry.uncompressedSize !== 0) {
					throw new Error("zip directory entry has content");
				}
				await mkdir(destinationPath(options.destination, archivePath), {
					recursive: true,
					mode: 0o700,
				});
				continue;
			}
			if (entry.uncompressedSize > maxFileBytes) {
				throw new Error("zip entry exceeds the per-file safety limit");
			}
			if (
				entry.uncompressedSize > 0 &&
				(entry.compressedSize === 0 ||
					entry.uncompressedSize / entry.compressedSize > maxCompressionRatio)
			) {
				throw new Error("zip entry exceeds the compression-ratio safety limit");
			}
			extractedBytes += entry.uncompressedSize;
			if (extractedBytes > maxExpandedBytes) {
				throw new Error("zip archive exceeds the expanded-size safety limit");
			}

			const outputPath = destinationPath(options.destination, archivePath);
			await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
			const handle = await open(outputPath, "wx", 0o600);
			let stream:
				| Awaited<ReturnType<typeof zip.openReadStreamPromise>>
				| undefined;
			let written = 0;
			let crc32 = 0xffffffff;
			try {
				stream = await zip.openReadStreamPromise(entry);
				for await (const value of stream) {
					abortIfNeeded(options.signal);
					const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
					written += chunk.length;
					if (
						written > entry.uncompressedSize ||
						written > maxFileBytes ||
						extractedBytes - entry.uncompressedSize + written > maxExpandedBytes
					) {
						throw new Error("zip entry exceeds the expanded-size safety limit");
					}
					crc32 = updateCrc32(crc32, chunk);
					await writeAll(handle, chunk);
				}
				if (written !== entry.uncompressedSize) {
					throw new Error(
						"zip entry size did not match its directory metadata",
					);
				}
				if ((crc32 ^ 0xffffffff) >>> 0 !== entry.crc32 >>> 0) {
					throw new Error(
						"zip entry CRC-32 did not match its directory metadata",
					);
				}
				await handle.sync();
				await handle.close();
			} catch (error) {
				stream?.destroy();
				await handle.close().catch(() => {});
				throw error;
			}
		}
		if (entries === 0) throw new Error("zip archive is empty");
		return { entries, extractedBytes };
	} finally {
		if (zip.isOpen) zip.close();
	}
}

async function assertContainedRegularFile(
	root: string,
	path: string,
): Promise<void> {
	const [rootReal, pathReal] = await Promise.all([
		realpath(root),
		realpath(path),
	]);
	const within = relative(rootReal, pathReal);
	if (
		!within ||
		within === ".." ||
		within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(within)
	) {
		throw new Error("managed ACP executable escaped the extraction directory");
	}
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("managed ACP command is not a regular file");
	}
}

export async function extractAcpManagedArchive(
	options: AcpManagedExtractOptions,
): Promise<AcpManagedExtractResult> {
	const commandRelativePath = normalizeAcpManagedCommand(options.command, {
		windowsPaths: options.windowsPaths,
	});
	await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 });
	await mkdir(options.destination, { mode: 0o700 });
	try {
		abortIfNeeded(options.signal);
		let result: { entries: number; extractedBytes: number };
		if (options.archiveKind === "tar-gzip") {
			result = await extractTarGzip(options);
		} else if (options.archiveKind === "zip") {
			result = await extractZip(options);
		} else {
			const executable = destinationPath(
				options.destination,
				commandRelativePath,
			);
			await mkdir(dirname(executable), { recursive: true, mode: 0o700 });
			await copyFile(options.archivePath, executable, constants.COPYFILE_EXCL);
			const metadata = await lstat(executable);
			const maxFileBytes = positiveLimit(
				options.maxFileBytes,
				DEFAULT_MAX_FILE_BYTES,
			);
			const maxExpandedBytes = positiveLimit(
				options.maxExpandedBytes,
				DEFAULT_MAX_EXPANDED_BYTES,
			);
			if (
				!metadata.isFile() ||
				metadata.size > maxFileBytes ||
				metadata.size > maxExpandedBytes
			) {
				throw new Error("managed ACP binary exceeds the safety limit");
			}
			result = { entries: 1, extractedBytes: metadata.size };
		}
		abortIfNeeded(options.signal);
		const executablePath = destinationPath(
			options.destination,
			commandRelativePath,
		);
		await assertContainedRegularFile(options.destination, executablePath);
		await chmod(executablePath, 0o700);
		return { commandRelativePath, executablePath, ...result };
	} catch (error) {
		await rm(options.destination, { recursive: true, force: true }).catch(
			() => {},
		);
		throw error;
	}
}
