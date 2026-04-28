import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { HlidConfig } from "../config";
import * as db from "../db";

const FILENAME_SAFE = /[^a-zA-Z0-9._-]+/g;

function sanitizeFilename(name: string): string {
	const base = basename(name).slice(0, 200);
	const cleaned = base.replace(FILENAME_SAFE, "_").replace(/^\.+/, "_");
	return cleaned || "file";
}

function ensureWithin(parent: string, child: string): void {
	const p = resolve(parent);
	const c = resolve(child);
	if (c !== p && !c.startsWith(`${p}/`)) {
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
};

export async function handleUpload(
	req: Request,
	config: HlidConfig,
): Promise<Response> {
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

	const kindRaw = String(form.get("kind") ?? "ephemeral");
	const kind: db.AttachmentKind = kindRaw === "vault" ? "vault" : "ephemeral";
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

	let targetDir: string;
	if (kind === "vault") {
		targetDir = resolve(vaultRoot, config.attachments.vault_folder);
	} else {
		const sub = sessionIdStr ? sanitizeFilename(sessionIdStr) : "_unsessioned";
		targetDir = resolve(vaultRoot, ".hlid", "attachments", sub);
	}
	ensureWithin(vaultRoot, targetDir);
	await mkdir(targetDir, { recursive: true });

	const buf = Buffer.from(await file.arrayBuffer());
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
	};
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
	opts: { confirmVault?: boolean } = {},
): Promise<Response> {
	const row = await db.getAttachment(id);
	if (!row) return new Response("Not found", { status: 404 });
	if (row.kind === "vault" && !opts.confirmVault) {
		return Response.json(
			{ error: "vault_delete_requires_confirm", id },
			{ status: 409 },
		);
	}
	await db.deleteAttachment(id);
	try {
		await unlink(row.path);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`[attachments] unlink failed for ${row.path}:`, err);
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
