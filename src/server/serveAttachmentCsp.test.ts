import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentCategory, AttachmentRow } from "../db/types";

const { getAttachment, readFile } = vi.hoisted(() => ({
	getAttachment: vi.fn(),
	readFile: vi.fn(),
}));

vi.mock("../db", () => ({ getAttachment }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, readFile };
});

import { serveAttachment } from "./attachments";

const HTML = Buffer.from("<!doctype html><div>visual</div>");

function attachment(category: AttachmentCategory): AttachmentRow {
	return {
		id: "attachment-1",
		session_id: "session-1",
		message_seq: null,
		kind: "ephemeral",
		filename: "visual.html",
		path: "/hlid/library/artifacts/attachment-1/visual.html",
		mime: "text/html",
		size_bytes: HTML.byteLength,
		sha256: createHash("sha256").update(HTML).digest("hex"),
		created_at: 1,
		category,
		retention: category === "visualization" ? "session" : "retained",
		origin: "generated",
	};
}

beforeEach(() => {
	readFile.mockResolvedValue(HTML);
	const file = Object.assign(new Blob(["<!doctype html>"]), {
		exists: vi.fn().mockResolvedValue(true),
	});
	vi.stubGlobal("Bun", {
		file: vi.fn().mockReturnValue(file),
	});
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("serveAttachment HTML CSP", () => {
	it("leaves the plan HTML policy unchanged", async () => {
		getAttachment.mockResolvedValueOnce(attachment("plan"));

		const response = await serveAttachment("attachment-1");

		expect(response.headers.get("content-security-policy")).toBe(
			"sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:",
		);
	});

	it("mirrors the bundled Visualize shell policy and static origins", async () => {
		getAttachment.mockResolvedValueOnce(attachment("visualization"));

		const response = await serveAttachment("attachment-1", {
			visualizationSessionId: "session-1",
		});
		const csp = response.headers.get("content-security-policy") ?? "";

		expect(csp).toContain("sandbox allow-scripts");
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain(
			"script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
		);
		expect(csp).toContain("worker-src blob:");
		expect(csp).toContain("connect-src blob: data:");
		expect(csp).toContain("frame-src 'self'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("base-uri 'none'");
		expect(csp).toContain("form-action 'none'");
		for (const origin of [
			"https://cdnjs.cloudflare.com",
			"https://esm.sh",
			"https://cdn.jsdelivr.net",
			"https://unpkg.com",
			"https://fonts.googleapis.com",
			"https://fonts.gstatic.com",
			"https://fonts.bunny.net",
		]) {
			expect(csp).toContain(origin);
		}
	});

	it("does not serve a visualization without an owning session", async () => {
		getAttachment.mockResolvedValueOnce(attachment("visualization"));

		const response = await serveAttachment("attachment-1");

		expect(response.status).toBe(404);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("serves an intact visualization only to its owning session", async () => {
		getAttachment.mockResolvedValueOnce(attachment("visualization"));

		const response = await serveAttachment("attachment-1", {
			visualizationSessionId: "session-1",
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(HTML.toString());
	});

	it("hides a visualization from another session", async () => {
		getAttachment.mockResolvedValueOnce(attachment("visualization"));

		const response = await serveAttachment("attachment-1", {
			visualizationSessionId: "session-2",
		});

		expect(response.status).toBe(404);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("rejects a changed visualization artifact", async () => {
		getAttachment.mockResolvedValueOnce({
			...attachment("visualization"),
			sha256: "0".repeat(64),
		});

		const response = await serveAttachment("attachment-1", {
			visualizationSessionId: "session-1",
		});

		expect(response.status).toBe(410);
	});
});
