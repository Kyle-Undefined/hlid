import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
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
import { PNG } from "pngjs";
import type { HlidConfig } from "../config";
import * as db from "../db";
import {
	configuredObsidianCapture,
	obsidianCaptureTimestamp,
} from "../lib/obsidianCapture";
import { expandTilde, pathStartsWith, toHostRuntimePath } from "../lib/paths";
import { resolveAgentMetadataPath } from "./agentPaths";
import { optimizeManagedImage } from "./imageOptimization";
import {
	artifactDirectory,
	artifactPath,
	artifactsDirectory,
	planStagingDirectory,
	prepareLibrary,
	storageKey,
	visualizationStagingDirectory,
} from "./libraryStore";
import {
	contentLengthExceeds,
	MULTIPART_OVERHEAD_BYTES,
	payloadTooLarge,
	readRequestBodyLimited,
} from "./requestLimits";

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

const GENERATED_IMAGE_MAX_PIXELS = 12_000_000;
const STANDARD_BASE64_RE =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type IngestedGeneratedImage = {
	id: string;
	filename: string;
	mime: "image/png";
	sizeBytes: number;
	width: number;
	height: number;
};

function generatedImageFilename(itemId: string, providerPath?: string): string {
	const providerName = providerPath
		? basename(providerPath.replaceAll("\\", "/"))
		: "";
	if (providerName.toLowerCase().endsWith(".png")) {
		return sanitizeFilename(providerName);
	}
	const safeId = sanitizeFilename(itemId)
		.replace(/\.png$/i, "")
		.slice(0, 160);
	return `${safeId || "generated-image"}.png`;
}

function decodeGeneratedImageBase64(value: string, maxBytes: number): Buffer {
	const encoded = value.trim();
	if (!encoded) throw new Error("The provider returned no image data.");
	if (
		encoded.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
		!STANDARD_BASE64_RE.test(encoded)
	) {
		throw new Error("The provider returned invalid or oversized image data.");
	}
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.byteLength === 0) {
		throw new Error("The provider returned no image data.");
	}
	if (bytes.byteLength > maxBytes) {
		throw new Error(`Generated image exceeds the ${maxBytes} byte limit.`);
	}
	return bytes;
}

function generatedPngDimensions(bytes: Buffer): {
	width: number;
	height: number;
} {
	if (
		sniffMime(bytes) !== "image/png" ||
		bytes.byteLength < 24 ||
		bytes.toString("ascii", 12, 16) !== "IHDR"
	) {
		throw new Error("The generated image is not a PNG.");
	}
	const headerWidth = bytes.readUInt32BE(16);
	const headerHeight = bytes.readUInt32BE(20);
	if (
		headerWidth <= 0 ||
		headerHeight <= 0 ||
		headerWidth * headerHeight > GENERATED_IMAGE_MAX_PIXELS
	) {
		throw new Error("The generated PNG dimensions are unsupported.");
	}
	let decoded: { width: number; height: number };
	try {
		decoded = PNG.sync.read(bytes);
	} catch {
		throw new Error("The generated PNG is corrupt.");
	}
	const { width, height } = decoded;
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width <= 0 ||
		height <= 0 ||
		width * height > GENERATED_IMAGE_MAX_PIXELS ||
		width !== headerWidth ||
		height !== headerHeight
	) {
		throw new Error("The generated PNG dimensions are unsupported.");
	}
	return { width, height };
}

/**
 * Retain a provider-produced PNG in Hlid's artifact library without ever
 * placing its base64 result in transcript text. Generated images are durable
 * Relics immediately, while their tool event keeps session and item provenance.
 */
export async function ingestGeneratedImage(opts: {
	dataBase64: string;
	providerItemId: string;
	providerPath?: string;
	sessionId: string;
	messageSeq: number;
	agentCwd?: string;
	maxBytes: number;
	allowedMimes: readonly string[];
}): Promise<IngestedGeneratedImage> {
	if (!opts.allowedMimes.includes("image/png")) {
		throw new Error("Generated PNG images are disabled by attachment policy.");
	}
	const sourceBytes = decodeGeneratedImageBase64(
		opts.dataBase64,
		opts.maxBytes,
	);
	const { width, height } = generatedPngDimensions(sourceBytes);
	const optimized = optimizeManagedImage(sourceBytes, "image/png");
	const bytes = optimized.buffer;
	const id = randomUUID();
	const filename = generatedImageFilename(
		opts.providerItemId,
		opts.providerPath,
	);
	await prepareLibrary();
	const directory = artifactDirectory(id);
	const path = artifactPath(id, filename);
	let attachmentCreated = false;
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
		await db.createAttachment({
			id,
			session_id: opts.sessionId,
			kind: "ephemeral",
			filename,
			path,
			mime: "image/png",
			size_bytes: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			storage_key: storageKey(path),
			category: "media",
			retention: "retained",
			origin: "generated",
			agent_cwd: opts.agentCwd ?? null,
			image_optimized_at: Math.floor(Date.now() / 1000),
			original_size_bytes: optimized.originalBytes,
		});
		attachmentCreated = true;
		const linked = await db.linkAttachmentToMessage(
			id,
			opts.sessionId,
			opts.messageSeq,
		);
		if (!linked)
			throw new Error("Generated image could not be linked to its turn.");
		return {
			id,
			filename,
			mime: "image/png",
			sizeBytes: bytes.byteLength,
			width,
			height,
		};
	} catch (error) {
		if (attachmentCreated) await db.deleteAttachment(id).catch(() => {});
		await unlink(path).catch(() => {});
		await rmdir(directory).catch(() => {});
		throw error;
	}
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
	const imageOptimization = optimizeManagedImage(buf, mime);
	buf = imageOptimization.buffer;

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
			...(mime === "image/png"
				? {
						image_optimized_at: Math.floor(Date.now() / 1000),
						original_size_bytes: imageOptimization.originalBytes,
					}
				: {}),
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
		? (resolveAgentMetadataPath(config, agentCwdRaw) ?? null)
		: null;
	if (agentCwdRaw && !agentRoot) {
		return new Response("Agent path is not registered", { status: 403 });
	}

	let buf: Buffer = Buffer.from(await file.arrayBuffer());

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
	const imageOptimization = optimizeManagedImage(buf, mime);
	buf = imageOptimization.buffer;

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
			...(mime === "image/png"
				? {
						image_optimized_at: Math.floor(Date.now() / 1000),
						original_size_bytes: imageOptimization.originalBytes,
					}
				: {}),
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

const VISUALIZATION_STATIC_SOURCES = [
	"blob:",
	"data:",
	"https://cdnjs.cloudflare.com",
	"https://cdn.jsdelivr.net",
	"https://esm.sh",
	"https://fonts.bunny.net",
	"https://fonts.googleapis.com",
	"https://fonts.gstatic.com",
	"https://unpkg.com",
].join(" ");

// Visualize's renderer produces an iframe shell. Mirror its shell CSP so the
// srcdoc frame and blob-backed runtime work while external resources remain
// restricted to the bundled skill's fixed CDN allowlist.
const VISUALIZATION_HTML_ATTACHMENT_CSP = [
	"sandbox allow-scripts",
	"default-src 'none'",
	`script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${VISUALIZATION_STATIC_SOURCES}`,
	`style-src 'unsafe-inline' ${VISUALIZATION_STATIC_SOURCES}`,
	`img-src ${VISUALIZATION_STATIC_SOURCES}`,
	`font-src ${VISUALIZATION_STATIC_SOURCES}`,
	`media-src ${VISUALIZATION_STATIC_SOURCES}`,
	"worker-src blob:",
	"connect-src blob: data:",
	"frame-src 'self'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");

const VISUALIZATION_ZOOM_RELAY = `<script data-hlid-visualization-zoom-relay>
(() => {
  const MESSAGE_TYPE = "hlid:visualization-zoom";
  let lastZoom = null;
  const valid = (data) =>
    data &&
    data.type === MESSAGE_TYPE &&
    data.version === 1 &&
    typeof data.zoom === "number" &&
    Number.isFinite(data.zoom) &&
    data.zoom >= 0.5 &&
    data.zoom <= 1.5;
  const send = (frame) => {
    if (!lastZoom) return;
    frame.contentWindow?.postMessage(lastZoom, "*");
  };
  addEventListener("message", (event) => {
    if (event.source !== parent || !valid(event.data)) return;
    lastZoom = event.data;
    for (const frame of document.querySelectorAll("iframe")) send(frame);
  });
  addEventListener("load", (event) => {
    if (event.target instanceof HTMLIFrameElement) send(event.target);
  }, true);
  document.currentScript?.remove();
})();
</script>`;

/** Relay Hlid zoom messages from the rendered shell into its sandboxed frame. */
export function applyVisualizationZoomRelay(html: string): string {
	const bodyCloseIndex = html.toLowerCase().lastIndexOf("</body>");
	if (bodyCloseIndex === -1) {
		return `${html.trimEnd()}\n${VISUALIZATION_ZOOM_RELAY}\n`;
	}
	return `${html.slice(0, bodyCloseIndex)}${VISUALIZATION_ZOOM_RELAY}\n${html.slice(bodyCloseIndex)}`;
}

export async function serveAttachment(
	id: string,
	opts: { visualizationSessionId?: string } = {},
): Promise<Response> {
	const row = await db.getAttachment(id);
	if (!row) return new Response("Not found", { status: 404 });
	if (
		(row.category === "visualization" && !opts.visualizationSessionId) ||
		(opts.visualizationSessionId !== undefined &&
			(row.session_id !== opts.visualizationSessionId ||
				row.kind !== "ephemeral" ||
				row.category !== "visualization" ||
				row.retention !== "session" ||
				row.origin !== "generated" ||
				row.mime !== "text/html"))
	) {
		return new Response("Not found", { status: 404 });
	}
	const file = Bun.file(row.path);
	if (!(await file.exists())) {
		return new Response("File missing on disk", { status: 410 });
	}
	let body: BodyInit = file;
	if (row.category === "visualization") {
		try {
			const bytes = Buffer.from(await readFile(row.path));
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			if (bytes.byteLength !== row.size_bytes || sha256 !== row.sha256) {
				return new Response("Attachment integrity check failed", {
					status: 410,
				});
			}
			body = Uint8Array.from(bytes);
		} catch {
			return new Response("File missing on disk", { status: 410 });
		}
	}
	const safeName = row.filename.replace(/[\r\n\\"]/g, "");
	const encodedName = encodeURIComponent(row.filename);
	const htmlCsp =
		row.mime !== "text/html"
			? null
			: row.category === "visualization"
				? VISUALIZATION_HTML_ATTACHMENT_CSP
				: HTML_ATTACHMENT_CSP;
	return new Response(body, {
		headers: {
			"content-type": row.mime,
			"content-disposition": `inline; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
			"x-content-type-options": "nosniff",
			...(htmlCsp ? { "content-security-policy": htmlCsp } : {}),
		},
	});
}

// The selected Visualize skill caps its source fragment at 2 MiB. Its bundled
// renderer embeds and HTML-escapes that fragment into a standalone shell, so
// the trusted rendered document needs bounded expansion headroom.
const VISUALIZATION_HTML_MAX_BYTES = 16 * 1024 * 1024;
const PLAN_HTML_MAX_BYTES = 5 * 1024 * 1024;

function visualizationFilename(sourcePath: string, title?: string): string {
	const requested = title?.trim();
	const stem = requested
		? requested.replace(/\.html?$/i, "")
		: basename(sourcePath, extname(sourcePath));
	const normalized = stem
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 180)
		.replace(/-+$/g, "");
	return `${normalized || "visualization"}.html`;
}

async function persistGeneratedHtmlAttachment(opts: {
	buf: Buffer;
	sessionId: string;
	filename: string;
	category: "plan" | "visualization";
	retention: "retained" | "session";
	agentCwd?: string;
}): Promise<{ id: string; path: string; filename: string }> {
	const id = randomUUID();
	await prepareLibrary();
	const targetDir = artifactDirectory(id);
	await mkdir(targetDir, { recursive: true, mode: 0o700 });
	const path = artifactPath(id, opts.filename);
	let created = false;
	try {
		await writeFile(path, opts.buf, { flag: "wx", mode: 0o600 });
		await db.createAttachment({
			id,
			session_id: opts.sessionId,
			kind: "ephemeral",
			filename: basename(path),
			path,
			mime: "text/html",
			size_bytes: opts.buf.byteLength,
			sha256: createHash("sha256").update(opts.buf).digest("hex"),
			storage_key: storageKey(path),
			category: opts.category,
			retention: opts.retention,
			origin: "generated",
			...(opts.agentCwd ? { agent_cwd: opts.agentCwd } : {}),
		});
		created = true;
		return { id, path, filename: basename(path) };
	} catch (error) {
		if (created) await db.deleteAttachment(id).catch(() => {});
		await unlink(path).catch(() => {});
		throw error;
	}
}

/**
 * Consume trusted, rendered Visualize HTML from Hlid-owned staging and persist
 * it as a session-scoped generated attachment. The source remains unlinked
 * from the transcript and is removed only after persistence succeeds.
 */
export async function ingestVisualizationHtml(opts: {
	sourcePath: string;
	sessionId: string;
	title?: string;
	agentCwd?: string;
}): Promise<{ id: string; filename: string } | null> {
	try {
		const stat = await lstat(opts.sourcePath);
		if (!stat.isFile()) return null;
		if (stat.size === 0 || stat.size > VISUALIZATION_HTML_MAX_BYTES) {
			console.warn(
				`[attachments] visualization html rejected: size ${stat.size} outside (0, ${VISUALIZATION_HTML_MAX_BYTES}]`,
			);
			return null;
		}

		const [real, stagingRoot] = await Promise.all([
			realpath(opts.sourcePath),
			realpath(visualizationStagingDirectory()),
		]);
		if (!pathStartsWith(stagingRoot, real)) {
			console.warn(
				`[attachments] visualization html rejected: ${real} escapes Hlid visualization staging`,
			);
			return null;
		}

		const sourceBytes = Buffer.from(await readFile(real));
		if (
			sourceBytes.byteLength === 0 ||
			sourceBytes.byteLength > VISUALIZATION_HTML_MAX_BYTES
		) {
			console.warn(
				`[attachments] visualization html rejected after read: size ${sourceBytes.byteLength} outside (0, ${VISUALIZATION_HTML_MAX_BYTES}]`,
			);
			return null;
		}
		let renderedHtml: string;
		try {
			renderedHtml = new TextDecoder("utf-8", { fatal: true }).decode(
				sourceBytes,
			);
		} catch {
			console.warn(
				"[attachments] visualization html rejected: rendered document is not valid UTF-8",
			);
			return null;
		}
		const buf = Buffer.from(applyVisualizationZoomRelay(renderedHtml));
		if (buf.byteLength > VISUALIZATION_HTML_MAX_BYTES) {
			console.warn(
				`[attachments] visualization html rejected after host bridge: size ${buf.byteLength} exceeds ${VISUALIZATION_HTML_MAX_BYTES}`,
			);
			return null;
		}

		const filename = visualizationFilename(real, opts.title);
		const persisted = await persistGeneratedHtmlAttachment({
			buf,
			sessionId: opts.sessionId,
			filename,
			category: "visualization",
			retention: "session",
			agentCwd: opts.agentCwd?.trim() || undefined,
		});
		await unlink(real).catch(() => {});
		return { id: persisted.id, filename: persisted.filename };
	} catch (err) {
		console.warn("[attachments] visualization html ingestion failed:", err);
		return null;
	}
}

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
	let persisted: Awaited<
		ReturnType<typeof persistGeneratedHtmlAttachment>
	> | null = null;
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
		persisted = await persistGeneratedHtmlAttachment({
			buf,
			sessionId: opts.sessionId,
			filename: `plan-${opts.planSeq}.html`,
			category: "plan",
			retention: "retained",
		});
		const linked = await db.linkAttachmentToMessage(
			persisted.id,
			opts.sessionId,
			opts.planSeq,
		);
		if (!linked) throw new Error("plan attachment could not be linked");
		await unlink(real).catch(() => {});
		return persisted.id;
	} catch (err) {
		if (persisted) await db.deleteAttachment(persisted.id).catch(() => {});
		if (persisted) await unlink(persisted.path).catch(() => {});
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
	if (row.category === "visualization") {
		return attachmentPromotionError(
			"Visualizations stay attached to their Raven session and cannot be promoted to Obsidian.",
			409,
		);
	}
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
	const artifactsRoot = resolve(artifactsDirectory());
	await Promise.all(
		paths.map(async (p) => {
			const absolute = resolve(p);
			try {
				await unlink(absolute);
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					await db
						.failPendingFileDeletion(
							absolute,
							err instanceof Error ? err.message : String(err),
						)
						.catch(() => {});
					console.warn(`[attachments] unlink failed for ${absolute}:`, err);
					return;
				}
			}
			await db.completePendingFileDeletion(absolute).catch(() => {});
			const parent = dirname(absolute);
			if (parent !== artifactsRoot && pathStartsWith(artifactsRoot, parent)) {
				await rmdir(parent).catch(() => {});
			}
		}),
	);
}
