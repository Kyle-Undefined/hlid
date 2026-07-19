/**
 * attachments.ts — upload validation, MIME sniffing, path safety, and cleanup.
 *
 * Private helpers (sniffMime, sanitizeFilename, ensureWithin) are exercised
 * through the public handleUpload / unlinkPaths API surface.  DB and filesystem
 * calls are fully mocked so no disk I/O occurs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// ── module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock("../db", () => ({
	createAttachment: vi.fn().mockResolvedValue(undefined),
	getAttachment: vi.fn().mockResolvedValue(null),
	deleteAttachment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	unlink: vi.fn().mockResolvedValue(undefined),
	readdir: vi.fn().mockResolvedValue([]),
	rmdir: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(""),
}));

// realpathSync is only called inside resolveRegisteredAgent (when agent_cwd is
// present). For tests without an agent, we don't need this mock, but provide it
// to avoid "Bun.file" references pulling in unexpected module resolution.
vi.mock("node:fs", () => ({
	realpathSync: vi.fn().mockImplementation((p: string) => p),
}));

vi.mock("node:crypto", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
	const actual = require("node:crypto") as typeof import("node:crypto");
	return {
		...actual,
		randomUUID: vi.fn().mockReturnValue("00000000-0000-0000-0000-000000000001"),
	};
});

// ── imports after mocks ───────────────────────────────────────────────────────

import { mkdir, unlink } from "node:fs/promises";
import type { HlidConfig } from "../config";

import { DEFAULT_ATTACHMENTS_CONFIG } from "../config";
import * as db from "../db";
import { handleUpload, removeAttachment, unlinkPaths } from "./attachments";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(vaultPath = "/tmp/test-vault"): HlidConfig {
	return {
		vault: { name: "Test", path: vaultPath },
		server: {
			port: 3000,
			tls_proxy_port: 3443,
			local_network_access: false,
			allow_external_agents: false,
		},
		attachments: { ...DEFAULT_ATTACHMENTS_CONFIG },
		agents: [],
		claude: {
			model: "claude-test",
			effort: "medium",
			permission_mode: "default",
			turn_recaps: false,
		},
		ui: { enter_to_submit: true, hide_skills_index: true, theme: "tan" },
		status_vocabulary: { active: [], planning: [], done: [] },
	} as unknown as HlidConfig;
}

function makeFormData(file: File, extra?: Record<string, string>): FormData {
	const form = new FormData();
	form.append("file", file);
	if (extra) {
		for (const [k, v] of Object.entries(extra)) {
			form.append(k, v);
		}
	}
	return form;
}

function makeRequest(form: FormData): Request {
	return new Request("http://localhost/api/attachments/upload", {
		method: "POST",
		body: form,
	});
}

afterEach(() => vi.clearAllMocks());

// ── handleUpload — config / request validation ────────────────────────────────

describe("handleUpload — configuration guards", () => {
	it("stores uploads in the Hlid library even when no vault is configured", async () => {
		const config = makeConfig("");
		const form = makeFormData(
			new File(["hello"], "test.txt", { type: "text/plain" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).toBe(200);
	});
});

describe("handleUpload — request validation", () => {
	it("returns 400 for non-multipart body", async () => {
		const config = makeConfig();
		const req = new Request("http://localhost/", {
			method: "POST",
			body: "not-form-data",
			headers: { "content-type": "text/plain" },
		});
		const res = await handleUpload(req, config);
		expect(res.status).toBe(400);
	});

	it("returns 400 when file field is missing from form", async () => {
		const config = makeConfig();
		const form = new FormData();
		form.append("session_id", "abc");
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).toBe(400);
	});
});

// ── handleUpload — size limit ─────────────────────────────────────────────────

describe("handleUpload — size limit", () => {
	it("rejects an oversized declared body before multipart parsing", async () => {
		const config = makeConfig();
		const formData = vi.fn();
		const req = {
			headers: new Headers({
				"content-length": String(
					config.attachments.max_bytes + 1024 * 1024 + 1,
				),
			}),
			formData,
		} as unknown as Request;
		const res = await handleUpload(req, config);
		expect(res.status).toBe(413);
		expect(formData).not.toHaveBeenCalled();
	});

	it("returns 413 when file exceeds max_bytes", async () => {
		const config = makeConfig();
		const oversize = new Uint8Array(config.attachments.max_bytes + 1);
		const form = makeFormData(
			new File([oversize], "big.txt", { type: "text/plain" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).toBe(413);
		const body = await res.json();
		expect(body.error).toBe("file_too_large");
		expect(body.max_bytes).toBe(config.attachments.max_bytes);
	});

	it("accepts a file exactly at the byte limit", async () => {
		const config = makeConfig();
		// text/plain has no binary MIME sniffing — just write succeeds
		const exact = new Uint8Array(config.attachments.max_bytes);
		const form = makeFormData(
			new File([exact], "exact.txt", { type: "text/plain" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		// Should NOT be 413 (size check is strict greater-than)
		expect(res.status).not.toBe(413);
	});
});

// ── handleUpload — MIME allowlist ─────────────────────────────────────────────

describe("handleUpload — MIME allowlist", () => {
	it("returns 415 for a MIME type not in the allowed list", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File(["<html></html>"], "page.html", { type: "text/html" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).toBe(415);
		const body = await res.json();
		expect(body.error).toBe("mime_not_allowed");
		expect(body.mime).toBe("text/html");
	});

	it("returns 415 for application/javascript", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File(["alert(1)"], "evil.js", {
				type: "application/javascript",
			}),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).toBe(415);
	});

	it("strips MIME parameters before checking allowlist", async () => {
		// "text/plain; charset=utf-8" should be treated as "text/plain"
		const config = makeConfig();
		const form = makeFormData(
			new File(["hello"], "note.txt", {
				type: "text/plain; charset=utf-8",
			}),
		);
		const res = await handleUpload(makeRequest(form), config);
		// text/plain is allowed — should proceed past MIME check (mkdir/write mocked)
		expect(res.status).not.toBe(415);
	});
});

// ── handleUpload — MIME sniffing (binary magic bytes) ────────────────────────

describe("handleUpload — binary MIME sniffing", () => {
	// PNG magic: 89 50 4E 47 0D 0A 1A 0A
	const PNG_MAGIC = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	]);
	// JPEG magic: FF D8 FF
	const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
	// GIF magic: 47 49 46 38
	const GIF_MAGIC = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
	// PDF magic: 25 50 44 46
	const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e]);
	// WebP: RIFF at 0, WEBP at 8
	const WEBP_MAGIC = Buffer.concat([
		Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]),
		Buffer.from([0x57, 0x45, 0x42, 0x50]),
	]);

	it("returns 415 mime_mismatch when PNG bytes claimed as image/jpeg", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File([PNG_MAGIC], "sneaky.jpg", { type: "image/jpeg" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).toBe(415);
		const body = await res.json();
		expect(body.error).toBe("mime_mismatch");
		expect(body.declared).toBe("image/jpeg");
		expect(body.detected).toBe("image/png");
	});

	it("returns 415 mime_mismatch when JPEG bytes claimed as image/png", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File([JPEG_MAGIC], "sneaky.png", { type: "image/png" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).toBe(415);
		const body = await res.json();
		expect(body.error).toBe("mime_mismatch");
		expect(body.declared).toBe("image/png");
	});

	it("accepts genuine PNG bytes with image/png", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File([PNG_MAGIC], "real.png", { type: "image/png" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		// Not a 415 — sniffing passed
		expect(res.status).not.toBe(415);
	});

	it("accepts genuine JPEG bytes with image/jpeg", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File([JPEG_MAGIC], "real.jpg", { type: "image/jpeg" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).not.toBe(415);
	});

	it("accepts genuine GIF bytes with image/gif", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File([GIF_MAGIC], "real.gif", { type: "image/gif" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).not.toBe(415);
	});

	it("accepts genuine PDF bytes with application/pdf", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File([PDF_MAGIC], "real.pdf", { type: "application/pdf" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).not.toBe(415);
	});

	it("accepts genuine WebP bytes with image/webp", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File([WEBP_MAGIC], "real.webp", { type: "image/webp" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).not.toBe(415);
	});

	it("does NOT sniff text/plain (trusts declared type)", async () => {
		// Binary bytes but declared as text/plain — no sniffing for text/* types
		const config = makeConfig();
		const form = makeFormData(
			new File([PNG_MAGIC], "notes.txt", { type: "text/plain" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).not.toBe(415);
	});
});

// ── handleUpload — filename sanitisation ─────────────────────────────────────

describe("handleUpload — filename sanitisation", () => {
	it("records the sanitised filename in the DB row", async () => {
		const config = makeConfig();
		// Filename with path traversal and special chars
		const form = makeFormData(
			new File(["hello"], "../../etc/passwd.txt", { type: "text/plain" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).toBe(200);

		// createAttachment should have been called with a safe filename
		const call = vi.mocked(db.createAttachment).mock.calls[0]?.[0];
		expect(call).toBeDefined();
		// Must not contain path separators or .. sequences
		expect(call?.filename).not.toContain("/");
		expect(call?.filename).not.toContain("..");
		expect(call?.filename).not.toContain("\\");
	});

	it("replaces leading dots to prevent hidden files", async () => {
		const config = makeConfig();
		// Note: ".hidden_config" (no ext) loses MIME through Bun multipart round-trip
		// Use ".hidden_config.txt" to test leading-dot sanitization with preserved MIME
		const form = makeFormData(
			new File(["data"], ".hidden_config.txt", { type: "text/plain" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).toBe(200);

		const call = vi.mocked(db.createAttachment).mock.calls[0]?.[0];
		expect(call?.filename).not.toMatch(/^\./);
	});

	it("clamps very long filenames to ≤ 200 chars (base name)", async () => {
		const config = makeConfig();
		const longName = `${"a".repeat(500)}.txt`;
		const form = makeFormData(
			new File(["x"], longName, { type: "text/plain" }),
		);
		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).toBe(200);

		const call = vi.mocked(db.createAttachment).mock.calls[0]?.[0];
		expect(call?.filename.length).toBeLessThanOrEqual(200);
	});
});

// ── handleUpload — successful upload shape ────────────────────────────────────

describe("handleUpload — successful upload", () => {
	it("returns a complete UploadResult JSON on success", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File(["hello world"], "note.txt", { type: "text/plain" }),
		);

		const res = await handleUpload(makeRequest(form), config);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.id).toBe("00000000-0000-0000-0000-000000000001");
		expect(body.kind).toBe("ephemeral");
		expect(body.mime).toBe("text/plain");
		expect(typeof body.sha256).toBe("string");
		expect(body.sha256).toHaveLength(64);
		expect(body.size_bytes).toBeGreaterThan(0);
	});

	it("persists the attachment via db.createAttachment", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File(["data"], "doc.txt", { type: "text/plain" }),
		);
		await handleUpload(makeRequest(form), config);
		expect(db.createAttachment).toHaveBeenCalledOnce();
	});

	it("removes the written file when persistence fails", async () => {
		vi.mocked(db.createAttachment).mockRejectedValueOnce(
			new Error("database unavailable"),
		);
		const config = makeConfig();
		const form = makeFormData(
			new File(["data"], "orphan.txt", { type: "text/plain" }),
		);

		await expect(handleUpload(makeRequest(form), config)).rejects.toThrow(
			"database unavailable",
		);
		const writtenPath = vi.mocked(db.createAttachment).mock.calls[0]?.[0].path;
		expect(unlink).toHaveBeenCalledWith(writtenPath);
	});

	it("creates the target directory", async () => {
		const config = makeConfig();
		const form = makeFormData(new File(["x"], "f.txt", { type: "text/plain" }));
		await handleUpload(makeRequest(form), config);
		expect(mkdir).toHaveBeenCalledWith(expect.any(String), {
			recursive: true,
			mode: 0o700,
		});
	});

	it("calls onUploaded callback with the new attachment id", async () => {
		const config = makeConfig();
		const form = makeFormData(new File(["y"], "g.txt", { type: "text/plain" }));
		const onUploaded = vi.fn();
		await handleUpload(makeRequest(form), config, onUploaded);
		expect(onUploaded).toHaveBeenCalledWith(
			"00000000-0000-0000-0000-000000000001",
			"ephemeral",
		);
	});

	it("sets session_id from form field", async () => {
		const config = makeConfig();
		const form = makeFormData(
			new File(["hello"], "note.txt", { type: "text/plain" }),
			{ session_id: "sess-abc" },
		);
		await handleUpload(makeRequest(form), config);
		const call = vi.mocked(db.createAttachment).mock.calls[0]?.[0];
		expect(call?.session_id).toBe("sess-abc");
	});

	it("sets session_id to null when not provided", async () => {
		const config = makeConfig();
		const form = makeFormData(new File(["x"], "z.txt", { type: "text/plain" }));
		await handleUpload(makeRequest(form), config);
		const call = vi.mocked(db.createAttachment).mock.calls[0]?.[0];
		expect(call?.session_id).toBeNull();
	});
});

// ── unlinkPaths ───────────────────────────────────────────────────────────────

describe("unlinkPaths", () => {
	it("is a no-op for an empty array", async () => {
		await unlinkPaths([]);
		expect(unlink).not.toHaveBeenCalled();
	});

	it("calls unlink for each path", async () => {
		vi.mocked(unlink).mockResolvedValue(undefined);
		await unlinkPaths(["/tmp/a.txt", "/tmp/b.txt"]);
		expect(unlink).toHaveBeenCalledTimes(2);
		expect(unlink).toHaveBeenCalledWith("/tmp/a.txt");
		expect(unlink).toHaveBeenCalledWith("/tmp/b.txt");
	});

	it("silently ignores ENOENT errors (file already gone)", async () => {
		const enoent = Object.assign(new Error("no such file"), {
			code: "ENOENT",
		});
		vi.mocked(unlink).mockRejectedValueOnce(enoent);
		await expect(unlinkPaths(["/tmp/missing.txt"])).resolves.toBeUndefined();
	});

	it("does not throw for mixed success and ENOENT", async () => {
		const enoent = Object.assign(new Error("no such file"), {
			code: "ENOENT",
		});
		vi.mocked(unlink)
			.mockResolvedValueOnce(undefined) // first path succeeds
			.mockRejectedValueOnce(enoent); // second path ENOENT
		await expect(
			unlinkPaths(["/tmp/ok.txt", "/tmp/gone.txt"]),
		).resolves.toBeUndefined();
	});
});

// ── removeAttachment ──────────────────────────────────────────────────────────

describe("removeAttachment", () => {
	it("returns 404 when attachment id is not in DB", async () => {
		vi.mocked(db.getAttachment).mockResolvedValueOnce(null);
		const res = await removeAttachment("nonexistent-id");
		expect(res.status).toBe(404);
	});

	it("deletes DB row and unlinks file for ephemeral attachment", async () => {
		vi.mocked(db.getAttachment).mockResolvedValueOnce({
			id: "att-1",
			path: "/tmp/test-vault/.hlid/attachments/_unsessioned/note.txt",
			filename: "note.txt",
			mime: "text/plain",
			kind: "ephemeral",
			size_bytes: 5,
			sha256: "abc",
			session_id: null,
			created_at: 0,
		} as never);
		vi.mocked(unlink).mockResolvedValueOnce(undefined);

		const res = await removeAttachment("att-1");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.id).toBe("att-1");
		expect(db.deleteAttachment).toHaveBeenCalledWith("att-1");
		expect(unlink).toHaveBeenCalled();
	});

	it("deletes DB row but does NOT unlink file for vault attachment (default config)", async () => {
		vi.mocked(db.getAttachment).mockResolvedValueOnce({
			id: "att-v",
			path: "/vault/notes/important.md",
			filename: "important.md",
			mime: "text/markdown",
			kind: "vault",
			size_bytes: 100,
			sha256: "def",
			session_id: "s1",
			created_at: 0,
		} as never);

		const res = await removeAttachment("att-v");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(db.deleteAttachment).toHaveBeenCalledWith("att-v");
		// Must NOT delete vault files — they exist independently in the vault
		expect(unlink).not.toHaveBeenCalled();
	});

	it("does NOT unlink vault file when delete_vault_attachments is false", async () => {
		vi.mocked(db.getAttachment).mockResolvedValueOnce({
			id: "att-v",
			path: "/vault/notes/important.md",
			filename: "important.md",
			mime: "text/markdown",
			kind: "vault",
			size_bytes: 100,
			sha256: "def",
			session_id: "s1",
			created_at: 0,
		} as never);

		const config = makeConfig();
		// Explicitly set false (the default)
		config.vault.delete_vault_attachments = false;

		const res = await removeAttachment("att-v", config);
		expect(res.status).toBe(200);
		expect(db.deleteAttachment).toHaveBeenCalledWith("att-v");
		expect(unlink).not.toHaveBeenCalled();
	});

	it("DOES unlink vault file when delete_vault_attachments is true", async () => {
		vi.mocked(db.getAttachment).mockResolvedValueOnce({
			id: "att-v",
			path: "/vault/notes/important.md",
			filename: "important.md",
			mime: "text/markdown",
			kind: "vault",
			size_bytes: 100,
			sha256: "def",
			session_id: "s1",
			created_at: 0,
		} as never);
		vi.mocked(unlink).mockResolvedValueOnce(undefined);

		const config = makeConfig();
		config.vault.delete_vault_attachments = true;

		const res = await removeAttachment("att-v", config);
		expect(res.status).toBe(200);
		expect(db.deleteAttachment).toHaveBeenCalledWith("att-v");
		expect(unlink).toHaveBeenCalledWith("/vault/notes/important.md");
	});

	it("ephemeral attachment always unlinks regardless of delete_vault_attachments", async () => {
		vi.mocked(db.getAttachment).mockResolvedValueOnce({
			id: "att-e",
			path: "/tmp/.hlid/attachments/s1/file.txt",
			filename: "file.txt",
			mime: "text/plain",
			kind: "ephemeral",
			size_bytes: 10,
			sha256: "ghi",
			session_id: "s1",
			created_at: 0,
		} as never);
		vi.mocked(unlink).mockResolvedValueOnce(undefined);

		// delete_vault_attachments=false should NOT affect ephemeral behavior
		const config = makeConfig();
		config.vault.delete_vault_attachments = false;

		const res = await removeAttachment("att-e", config);
		expect(res.status).toBe(200);
		expect(unlink).toHaveBeenCalledWith("/tmp/.hlid/attachments/s1/file.txt");
	});
});
