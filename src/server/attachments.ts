import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import type { HlidConfig } from "../config";
import * as db from "../db";
import {
	configuredObsidianCapture,
	obsidianCaptureTimestamp,
} from "../lib/obsidianCapture";
import {
	expandTilde,
	pathStartsWith,
	samePath,
	toHostRuntimePath,
} from "../lib/paths";
import {
	artifactDirectory,
	artifactPath,
	planStagingDirectory,
	prepareLibrary,
	storageKey,
} from "./libraryStore";
import {
	contentLengthExceeds,
	MULTIPART_OVERHEAD_BYTES,
	payloadTooLarge,
	readRequestBodyLimited,
} from "./requestLimits";

function resolveRegisteredAgent(
	config: HlidConfig,
	requested: string,
): string | null {
	let real: string;
	try {
		real = realpathSync(resolve(expandTilde(requested)));
	} catch {
		return null;
	}
	for (const a of config.agents ?? []) {
		try {
			const candidate = realpathSync(resolve(expandTilde(a.path)));
			if (samePath(candidate, real)) return real;
		} catch {
			// skip missing
		}
	}
	return null;
}

const FILENAME_SAFE = /[^a-zA-Z0-9._-]+/g;

// Sniff MIME type from magic bytes. Only covers binary types where spoofing is
// meaningful; text/* types are safe with x-content-type-options: nosniff.
// WEBP uses a two-segment signature: RIFF at offset 0, WEBP at offset 8.
type MimeSig = {
	mime: string;
	sig: number[];
	offset2?: number;
	sig2?: number[];
};

const MIME_SIGNATURES: MimeSig[] = [
	{ mime: "image/png", sig: [0x89, 0x50, 0x4e, 0x47] },
	{ mime: "image/jpeg", sig: [0xff, 0xd8, 0xff] },
	{ mime: "image/gif", sig: [0x47, 0x49, 0x46] },
	{ mime: "application/pdf", sig: [0x25, 0x50, 0x44, 0x46] },
	{
		mime: "image/webp",
		sig: [0x52, 0x49, 0x46, 0x46],
		offset2: 8,
		sig2: [0x57, 0x45, 0x42, 0x50],
	},
	{
		mime: "audio/wav",
		sig: [0x52, 0x49, 0x46, 0x46],
		offset2: 8,
		sig2: [0x57, 0x41, 0x56, 0x45],
	},
];

function sniffMime(buf: Buffer): string | null {
	if (buf.length < 4) return null;
	for (const { mime, sig, offset2, sig2 } of MIME_SIGNATURES) {
		if (!sig.every((b, i) => buf[i] === b)) continue;
		if (offset2 !== undefined && sig2) {
			if (buf.length < offset2 + sig2.length) continue;
			if (!sig2.every((b, i) => buf[offset2 + i] === b)) continue;
		}
		return mime;
	}
	return null;
}

function sanitizeFilename(name: string): string {
	const base = basename(name).slice(0, 200);
	const cleaned = base.replace(FILENAME_SAFE, "_").replace(/^\.+/, "_");
	return cleaned || "file";
}

const GENERATED_RELIC_MIMES: Record<string, string> = {
	".csv": "text/csv",
	".gif": "image/gif",
	".htm": "text/html",
	".html": "text/html",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".json": "application/json",
	".md": "text/markdown",
	".pdf": "application/pdf",
	".png": "image/png",
	".txt": "text/plain",
	".webp": "image/webp",
};

function generatedRelicMime(filename: string, requested?: string): string {
	const inferred = GENERATED_RELIC_MIMES[extname(filename).toLowerCase()];
	const declared = requested?.split(";")[0].trim().toLowerCase();
	if (declared && inferred && declared !== inferred) {
		throw new Error(
			`Declared MIME ${declared} does not match the filename type ${inferred}.`,
		);
	}
	return declared || inferred || "application/octet-stream";
}

type GeneratedRelicRequest = {
	runtime_cwd?: string;
	session_id?: string;
	source_path?: string;
	filename?: string;
	content?: string;
	mime?: string;
	category?: "report" | "other";
};

type GeneratedRelicResult = {
	id: string;
	filename: string;
	mime: string;
	size_bytes: number;
	category: "report" | "other";
	open_url: string;
};

function generatedRelicError(
	error: string,
	message: string,
	status = 400,
): Response {
	return Response.json({ error, message }, { status });
}

/**
 * Publish an agent-generated deliverable into Hlid-owned Relics. This is
 * intentionally separate from browser uploads and HTML plan ingestion: it
 * creates a durable generated artifact without entering the plan lifecycle.
 */
export async function handleGeneratedRelicPublish(
	req: Request,
	config: HlidConfig,
	onPublished?: (id: string) => void | Promise<void>,
): Promise<Response> {
	const maxBodyBytes = config.attachments.max_bytes * 2 + 64 * 1024;
	const limited = await readRequestBodyLimited(req, maxBodyBytes);
	if (!limited.ok) return limited.response;

	let input: GeneratedRelicRequest;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(limited.body));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("invalid JSON object");
		}
		input = parsed as GeneratedRelicRequest;
	} catch {
		return generatedRelicError("invalid_request", "Expected a JSON body.");
	}

	const hasSource =
		typeof input.source_path === "string" &&
		input.source_path.trim().length > 0;
	const hasContent = typeof input.content === "string";
	if (hasSource === hasContent) {
		return generatedRelicError(
			"invalid_source",
			"Provide exactly one of source_path or content.",
		);
	}
	if (hasContent && !input.content) {
		return generatedRelicError(
			"empty_content",
			"Generated Relic content cannot be empty.",
		);
	}

	let buf: Buffer;
	let requestedFilename = input.filename?.trim() ?? "";
	try {
		if (hasSource) {
			const runtimeCwd = input.runtime_cwd?.trim();
			if (!runtimeCwd) {
				return generatedRelicError(
					"missing_runtime_cwd",
					"A provider working directory is required for source_path.",
				);
			}
			const source = toHostRuntimePath(runtimeCwd, input.source_path as string);
			const [root, realSource] = await Promise.all([
				realpath(runtimeCwd),
				realpath(source),
			]);
			if (!pathStartsWith(root, realSource)) {
				return generatedRelicError(
					"source_outside_workspace",
					"Generated Relics must come from the active workspace.",
					403,
				);
			}
			const stat = await lstat(realSource);
			if (!stat.isFile()) {
				return generatedRelicError(
					"invalid_source",
					"The generated Relic source must be a regular file.",
				);
			}
			if (stat.size === 0) {
				return generatedRelicError(
					"empty_content",
					"Generated Relic files cannot be empty.",
				);
			}
			if (stat.size > config.attachments.max_bytes) {
				return generatedRelicError(
					"file_too_large",
					`Generated Relic exceeds the ${config.attachments.max_bytes} byte limit.`,
					413,
				);
			}
			requestedFilename ||= basename(realSource);
			buf = Buffer.from(await readFile(realSource));
			if (buf.byteLength > config.attachments.max_bytes) {
				return generatedRelicError(
					"file_too_large",
					`Generated Relic exceeds the ${config.attachments.max_bytes} byte limit.`,
					413,
				);
			}
		} else {
			if (!requestedFilename) {
				return generatedRelicError(
					"missing_filename",
					"A filename is required when publishing direct content.",
				);
			}
			buf = Buffer.from(input.content as string, "utf8");
			if (buf.byteLength > config.attachments.max_bytes) {
				return generatedRelicError(
					"file_too_large",
					`Generated Relic exceeds the ${config.attachments.max_bytes} byte limit.`,
					413,
				);
			}
		}
	} catch (cause) {
		return generatedRelicError(
			"source_unavailable",
			cause instanceof Error
				? cause.message
				: "Could not read the generated Relic source.",
			404,
		);
	}

	const filename = sanitizeFilename(requestedFilename);
	let mime: string;
	try {
		mime = generatedRelicMime(filename, input.mime);
	} catch (cause) {
		return generatedRelicError(
			"mime_mismatch",
			cause instanceof Error ? cause.message : "MIME type mismatch.",
			415,
		);
	}
	const allowedMimes = new Set([
		...config.attachments.allowed_mimes,
		"application/octet-stream",
		"text/html",
	]);
	if (!allowedMimes.has(mime)) {
		return generatedRelicError(
			"mime_not_allowed",
			`Generated Relics do not allow ${mime}.`,
			415,
		);
	}
	if (mime.startsWith("image/") || mime === "application/pdf") {
		const sniffed = sniffMime(buf);
		if (sniffed !== mime) {
			return generatedRelicError(
				"mime_mismatch",
				`Generated Relic bytes do not match ${mime}.`,
				415,
			);
		}
	}

	const id = randomUUID();
	const category = input.category === "other" ? "other" : "report";
	let finalPath: string | null = null;
	let created = false;
	try {
		await prepareLibrary();
		await mkdir(artifactDirectory(id), { recursive: true, mode: 0o700 });
		finalPath = artifactPath(id, filename);
		await writeFile(finalPath, buf, { flag: "wx", mode: 0o600 });
		await db.createAttachment({
			id,
			session_id:
				typeof input.session_id === "string" && input.session_id
					? input.session_id
					: null,
			kind: "ephemeral",
			filename: basename(finalPath),
			path: finalPath,
			mime,
			size_bytes: buf.byteLength,
			sha256: createHash("sha256").update(buf).digest("hex"),
			storage_key: storageKey(finalPath),
			category,
			retention: "retained",
			origin: "generated",
			agent_cwd: input.runtime_cwd?.trim() || null,
		});
		created = true;
		await onPublished?.(id);
		const result: GeneratedRelicResult = {
			id,
			filename: basename(finalPath),
			mime,
			size_bytes: buf.byteLength,
			category,
			open_url: `/api/attachments/${id}/raw`,
		};
		return Response.json(result);
	} catch (cause) {
		if (created) await db.deleteAttachment(id).catch(() => {});
		if (finalPath) await unlink(finalPath).catch(() => {});
		return generatedRelicError(
			"publish_failed",
			cause instanceof Error
				? cause.message
				: "Could not publish the generated Relic.",
			500,
		);
	}
}

type UploadResult = {
	id: string;
	session_id: string | null;
	kind: db.AttachmentKind;
	filename: string;
	path: string;
	mime: string;
	size_bytes: number;
	sha256: string;
	created_at: number;
	storage_key: string;
	category: "upload";
	retention: "session";
	origin: "upload";
	agent_cwd: string | null;
};

export async function handleUpload(
	req: Request,
	config: HlidConfig,
	onUploaded?: (id: string, kind: "ephemeral") => void,
): Promise<Response> {
	const maxBodyBytes = config.attachments.max_bytes + MULTIPART_OVERHEAD_BYTES;
	if (contentLengthExceeds(req, maxBodyBytes)) {
		return payloadTooLarge(maxBodyBytes);
	}
	let form: FormData;
	try {
		form = await req.formData();
	} catch {
		return new Response("Invalid multipart body", { status: 400 });
	}

	const file = form.get("file");
	if (!(file instanceof File)) {
		return new Response("Missing file", { status: 400 });
	}

	const sessionId = form.get("session_id");
	const sessionIdStr =
		typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;

	if (file.size > config.attachments.max_bytes) {
		return Response.json(
			{
				error: "file_too_large",
				max_bytes: config.attachments.max_bytes,
				size_bytes: file.size,
			},
			{ status: 413 },
		);
	}

	const filename = sanitizeFilename(file.name);
	const declaredMime = (file.type || "application/octet-stream")
		.split(";")[0]
		.trim()
		.toLowerCase();
	const wavMimeAliases = new Set([
		"audio/wav",
		"audio/x-wav",
		"audio/wave",
		"audio/vnd.wave",
		"application/octet-stream",
	]);
	const isWavUpload =
		extname(filename).toLowerCase() === ".wav" &&
		wavMimeAliases.has(declaredMime);
	const mime = isWavUpload ? "audio/wav" : declaredMime;
	if (!config.attachments.allowed_mimes.includes(mime) && !isWavUpload) {
		return Response.json(
			{ error: "mime_not_allowed", mime: declaredMime },
			{ status: 415 },
		);
	}

	const kind: db.AttachmentKind = "ephemeral";

	const agentCwdField = form.get("agent_cwd");
	const agentCwdRaw =
		typeof agentCwdField === "string" && agentCwdField.length > 0
			? agentCwdField
			: null;
	const agentRoot = agentCwdRaw
		? resolveRegisteredAgent(config, agentCwdRaw)
		: null;
	if (agentCwdRaw && !agentRoot) {
		return new Response("Agent path is not registered", { status: 403 });
	}

	const buf = Buffer.from(await file.arrayBuffer());

	// For binary types, verify declared MIME matches actual file bytes.
	const isBinaryMime =
		mime.startsWith("image/") ||
		mime === "application/pdf" ||
		mime === "audio/wav";
	if (isBinaryMime) {
		const sniffed = sniffMime(buf);
		if (sniffed !== mime) {
			return Response.json(
				{ error: "mime_mismatch", declared: mime, detected: sniffed },
				{ status: 415 },
			);
		}
	}

	const sha256 = createHash("sha256").update(buf).digest("hex");
	const id = randomUUID();
	await prepareLibrary();
	const targetDir = artifactDirectory(id);
	await mkdir(targetDir, { recursive: true, mode: 0o700 });
	const finalPath = artifactPath(id, filename);
	await writeFile(finalPath, buf, { flag: "wx", mode: 0o600 });

	try {
		await db.createAttachment({
			id,
			session_id: sessionIdStr,
			kind,
			filename: basename(finalPath),
			path: finalPath,
			mime,
			size_bytes: buf.byteLength,
			sha256,
			storage_key: storageKey(finalPath),
			category: "upload",
			retention: "session",
			origin: "upload",
			agent_cwd: agentRoot,
		});
	} catch (error) {
		await unlink(finalPath).catch(() => {});
		throw error;
	}

	const result: UploadResult = {
		id,
		session_id: sessionIdStr,
		kind,
		filename: basename(finalPath),
		path: finalPath,
		mime,
		size_bytes: buf.byteLength,
		sha256,
		created_at: Math.floor(Date.now() / 1000),
		storage_key: storageKey(finalPath),
		category: "upload",
		retention: "session",
		origin: "upload",
		agent_cwd: agentRoot,
	};
	onUploaded?.(id, kind);
	return Response.json(result);
}

// HTML attachments (plan documents) render in sandboxed iframes. The CSP
// sandbox directive gives the document an opaque origin even when navigated
// to directly, so its scripts can never reach hlid cookies or APIs; the
// fetch directives block all network egress (plan docs are self-contained).
const HTML_ATTACHMENT_CSP = [
	"sandbox allow-scripts",
	"default-src 'none'",
	"style-src 'unsafe-inline'",
	"script-src 'unsafe-inline'",
	"img-src data: blob:",
	"font-src data:",
	"media-src data:",
].join("; ");

export async function serveAttachment(id: string): Promise<Response> {
	const row = await db.getAttachment(id);
	if (!row) return new Response("Not found", { status: 404 });
	const file = Bun.file(row.path);
	if (!(await file.exists())) {
		return new Response("File missing on disk", { status: 410 });
	}
	const safeName = row.filename.replace(/[\r\n\\"]/g, "");
	const encodedName = encodeURIComponent(row.filename);
	return new Response(file, {
		headers: {
			"content-type": row.mime,
			"content-disposition": `inline; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
			"x-content-type-options": "nosniff",
			...(row.mime === "text/html"
				? { "content-security-policy": HTML_ATTACHMENT_CSP }
				: {}),
		},
	});
}

const PLAN_HTML_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Ingest an agent-written HTML plan document as an ephemeral attachment.
 * Validates the source file (regular file, size cap, resolved path contained
 * in plansDir), copies it into the session's attachment dir, records the DB
 * row, and unlinks the source. Returns the attachment id, or null on any
 * failure — callers fall back to the markdown plan silently.
 */
export async function ingestPlanHtml(opts: {
	sourcePath: string;
	sessionId: string;
	planSeq: number;
	maxBytes: number;
}): Promise<string | null> {
	let finalPath: string | null = null;
	let createdId: string | null = null;
	try {
		const stat = await lstat(opts.sourcePath);
		if (!stat.isFile()) return null;
		const cap = Math.min(opts.maxBytes, PLAN_HTML_MAX_BYTES);
		if (stat.size === 0 || stat.size > cap) {
			console.warn(
				`[attachments] plan html rejected: size ${stat.size} outside (0, ${cap}]`,
			);
			return null;
		}
		const real = await realpath(opts.sourcePath);
		if (!pathStartsWith(planStagingDirectory(), real)) {
			console.warn(
				`[attachments] plan html rejected: ${real} escapes Hlid plan staging`,
			);
			return null;
		}

		const buf = Buffer.from(await readFile(real));
		const id = randomUUID();
		await prepareLibrary();
		const targetDir = artifactDirectory(id);
		await mkdir(targetDir, { recursive: true, mode: 0o700 });
		finalPath = artifactPath(id, `plan-${opts.planSeq}.html`);
		await writeFile(finalPath, buf, { flag: "wx", mode: 0o600 });
		await db.createAttachment({
			id,
			session_id: opts.sessionId,
			kind: "ephemeral",
			filename: basename(finalPath),
			path: finalPath,
			mime: "text/html",
			size_bytes: buf.byteLength,
			sha256: createHash("sha256").update(buf).digest("hex"),
			storage_key: storageKey(finalPath),
			category: "plan",
			retention: "retained",
			origin: "generated",
		});
		createdId = id;
		const linked = await db.linkAttachmentToMessage(
			id,
			opts.sessionId,
			opts.planSeq,
		);
		if (!linked) throw new Error("plan attachment could not be linked");
		await unlink(real).catch(() => {});
		return id;
	} catch (err) {
		if (createdId) await db.deleteAttachment(createdId).catch(() => {});
		if (finalPath) await unlink(finalPath).catch(() => {});
		console.warn("[attachments] plan html ingestion failed:", err);
		return null;
	}
}

export async function removeAttachment(
	id: string,
	config?: HlidConfig,
): Promise<Response> {
	const row = await db.getAttachment(id);
	if (!row) return new Response("Not found", { status: 404 });
	await db.deleteAttachment(id);
	// Ephemeral attachments: always delete the file (it belongs to hlid).
	// Vault attachments: only delete the file when delete_vault_attachments is
	// explicitly enabled — by default vault files are owned by the vault, not
	// hlid, so removing the DB record is sufficient.
	const shouldUnlink =
		row.kind === "ephemeral" ||
		(row.kind === "vault" && (config?.vault.delete_vault_attachments ?? false));
	if (shouldUnlink) {
		try {
			await unlink(row.path);
			const dir = dirname(row.path);
			const remaining = await readdir(dir).catch(() => null);
			if (remaining?.length === 0) {
				await rmdir(dir).catch(() => {});
			}
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn(`[attachments] unlink failed for ${row.path}:`, err);
			}
		}
	}
	return Response.json({ ok: true, id });
}

function attachmentPromotionError(message: string, status = 400): Response {
	return Response.json(
		{ error: "attachment_promotion_failed", message },
		{ status },
	);
}

async function configuredVaultRoot(config: HlidConfig): Promise<string> {
	const configured = resolve(expandTilde(config.vault.path));
	try {
		return await realpath(configured);
	} catch {
		throw new Error("Hlid's configured vault path was not found.");
	}
}

async function vaultRelativeAttachmentPath(
	path: string,
	config: HlidConfig,
): Promise<string> {
	const root = await configuredVaultRoot(config);
	const file = await realpath(path);
	if (!pathStartsWith(root, file)) {
		throw new Error("This Relic is not inside Hlid's configured vault.");
	}
	return relative(root, file).replaceAll("\\", "/");
}

async function copyIntoCaptureFolder(
	source: string,
	directory: string,
	filename: string,
): Promise<string> {
	const extension = extname(filename);
	const stem = basename(filename, extension);
	for (let attempt = 0; attempt < 4; attempt++) {
		const candidate =
			attempt === 0
				? filename
				: `${stem} ${obsidianCaptureTimestamp(new Date())} ${randomUUID().slice(0, 8)}${extension}`;
		const target = resolve(directory, candidate);
		try {
			await copyFile(source, target, constants.COPYFILE_EXCL);
			return target;
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
		}
	}
	throw new Error("Could not create a unique filename in the capture folder.");
}

export async function promoteAttachmentToObsidian(
	id: string,
	config: HlidConfig,
): Promise<Response> {
	const row = await db.getAttachment(id);
	if (!row) return new Response("Not found", { status: 404 });
	const destination = configuredObsidianCapture(config.vault);
	if (!destination) {
		return attachmentPromotionError(
			"This workspace does not have an Obsidian Inbox or Raw folder configured.",
			409,
		);
	}
	if (row.kind === "vault") {
		try {
			return Response.json({
				ok: true,
				id,
				path: await vaultRelativeAttachmentPath(row.path, config),
				destination: destination.label,
				alreadyPromoted: true,
			});
		} catch (cause) {
			return attachmentPromotionError(
				cause instanceof Error
					? cause.message
					: "Could not resolve this Relic.",
				409,
			);
		}
	}

	let source: string;
	let captureDirectory: string;
	try {
		const sourceInfo = await lstat(row.path);
		if (!sourceInfo.isFile()) {
			return attachmentPromotionError(
				"Only regular Relic files can be promoted.",
			);
		}
		source = await realpath(row.path);
		const root = await configuredVaultRoot(config);
		const requestedDirectory = resolve(root, destination.folder);
		if (!pathStartsWith(root, requestedDirectory)) {
			return attachmentPromotionError(
				"The configured capture folder must stay inside the vault.",
			);
		}
		await mkdir(requestedDirectory, { recursive: true });
		captureDirectory = await realpath(requestedDirectory);
		if (!pathStartsWith(root, captureDirectory)) {
			return attachmentPromotionError(
				"The configured capture folder resolves outside the vault.",
			);
		}
	} catch (cause) {
		return attachmentPromotionError(
			cause instanceof Error ? cause.message : "Could not prepare this Relic.",
		);
	}

	let promotedPath: string | null = null;
	try {
		promotedPath = await copyIntoCaptureFolder(
			source,
			captureDirectory,
			sanitizeFilename(row.filename),
		);
		const promoted = await db.promoteAttachmentToVault(id, {
			filename: basename(promotedPath),
			path: promotedPath,
		});
		if (!promoted) {
			await unlink(promotedPath).catch(() => {});
			return attachmentPromotionError("This Relic was already promoted.", 409);
		}
	} catch (cause) {
		if (promotedPath) await unlink(promotedPath).catch(() => {});
		return attachmentPromotionError(
			cause instanceof Error ? cause.message : "Could not promote this Relic.",
			500,
		);
	}

	await unlink(source).catch((cause) => {
		console.warn(
			`[attachments] promoted source cleanup failed for ${source}:`,
			cause,
		);
	});
	const sourceDirectory = dirname(source);
	const remaining = await readdir(sourceDirectory).catch(() => null);
	if (remaining?.length === 0) await rmdir(sourceDirectory).catch(() => {});

	return Response.json({
		ok: true,
		id,
		path: relative(await configuredVaultRoot(config), promotedPath).replaceAll(
			"\\",
			"/",
		),
		destination: destination.label,
		alreadyPromoted: false,
	});
}

export async function openAttachmentInObsidian(
	id: string,
	config: HlidConfig,
): Promise<Response> {
	const row = await db.getAttachment(id);
	if (!row) return new Response("Not found", { status: 404 });
	if (row.kind !== "vault") {
		return attachmentPromotionError(
			"Promote this Relic to the vault before opening it in Obsidian.",
			409,
		);
	}
	try {
		const path = await vaultRelativeAttachmentPath(row.path, config);
		const { openObsidianNote } = await import("./obsidianCli");
		await openObsidianNote(config.vault.name, path);
		return Response.json({ ok: true, id, path });
	} catch (cause) {
		return attachmentPromotionError(
			cause instanceof Error
				? cause.message
				: "Could not open this Relic in Obsidian.",
			500,
		);
	}
}

export async function unlinkPaths(paths: string[]): Promise<void> {
	await Promise.all(
		paths.map(async (p) => {
			try {
				await unlink(p);
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					console.warn(`[attachments] unlink failed for ${p}:`, err);
				}
			}
		}),
	);
}
