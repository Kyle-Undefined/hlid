import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { HlidConfig } from "../config";
import * as db from "../db";
import { expandTilde, pathStartsWith, samePath } from "../lib/paths";
import {
	contentLengthExceeds,
	MULTIPART_OVERHEAD_BYTES,
	payloadTooLarge,
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

async function checkGitignore(
	agentRoot: string,
): Promise<{ has_gitignore: boolean; covers_hlid: boolean }> {
	try {
		const text = await readFile(join(agentRoot, ".gitignore"), "utf-8");
		const covers = text
			.split("\n")
			.map((l) => l.trim())
			.some(
				(l) =>
					l === ".hlid" || l === ".hlid/" || l === "/.hlid" || l === "/.hlid/",
			);
		return { has_gitignore: true, covers_hlid: covers };
	} catch {
		return { has_gitignore: false, covers_hlid: false };
	}
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

function ensureWithin(parent: string, child: string): void {
	if (!pathStartsWith(parent, child)) {
		throw new Error("path escapes allowed root");
	}
}

async function writeUnique(
	dir: string,
	filename: string,
	data: Buffer,
): Promise<string> {
	const ext = extname(filename);
	const stem = filename.slice(0, filename.length - ext.length);
	let candidate = join(dir, filename);
	let n = 1;
	while (true) {
		ensureWithin(dir, candidate);
		try {
			await writeFile(candidate, data, { flag: "wx" });
			return candidate;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			candidate = join(dir, `${stem}-${n}${ext}`);
			n++;
		}
	}
}

export type UploadResult = {
	id: string;
	session_id: string | null;
	kind: db.AttachmentKind;
	filename: string;
	path: string;
	mime: string;
	size_bytes: number;
	sha256: string;
	created_at: number;
	gitignore_suggestion?: { agent_root: string; missing_entry: ".hlid/" };
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
	const vaultPath = config.vault.path;
	if (!vaultPath) {
		return new Response("Vault path not configured", { status: 400 });
	}
	const vaultRoot = resolve(vaultPath);

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

	const mime = (file.type || "application/octet-stream").split(";")[0].trim();
	if (!config.attachments.allowed_mimes.includes(mime)) {
		return Response.json({ error: "mime_not_allowed", mime }, { status: 415 });
	}

	const filename = sanitizeFilename(file.name);
	const kind: db.AttachmentKind = "ephemeral";

	const sub = sessionIdStr ? sanitizeFilename(sessionIdStr) : "_unsessioned";

	const agentCwdField = form.get("agent_cwd");
	const agentCwdRaw =
		typeof agentCwdField === "string" && agentCwdField.length > 0
			? agentCwdField
			: null;
	const agentRoot = agentCwdRaw
		? resolveRegisteredAgent(config, agentCwdRaw)
		: null;

	const storageRoot = agentRoot ?? vaultRoot;
	const targetDir = resolve(storageRoot, ".hlid", "attachments", sub);
	ensureWithin(storageRoot, targetDir);
	await mkdir(targetDir, { recursive: true });

	const buf = Buffer.from(await file.arrayBuffer());

	// For binary types, verify declared MIME matches actual file bytes.
	const isBinaryMime = mime.startsWith("image/") || mime === "application/pdf";
	if (isBinaryMime) {
		const sniffed = sniffMime(buf);
		if (sniffed !== mime) {
			return Response.json(
				{ error: "mime_mismatch", declared: mime, detected: sniffed },
				{ status: 415 },
			);
		}
	}

	const finalPath = await writeUnique(targetDir, filename, buf);

	const sha256 = createHash("sha256").update(buf).digest("hex");
	const id = randomUUID();

	await db.createAttachment({
		id,
		session_id: sessionIdStr,
		kind,
		filename: basename(finalPath),
		path: finalPath,
		mime,
		size_bytes: buf.byteLength,
		sha256,
	});

	let gitignoreSuggestion: UploadResult["gitignore_suggestion"];
	if (agentRoot) {
		const gi = await checkGitignore(agentRoot);
		if (!gi.covers_hlid) {
			gitignoreSuggestion = { agent_root: agentRoot, missing_entry: ".hlid/" };
		}
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
		...(gitignoreSuggestion
			? { gitignore_suggestion: gitignoreSuggestion }
			: {}),
	};
	onUploaded?.(id, kind);
	return Response.json(result);
}

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
		},
	});
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
