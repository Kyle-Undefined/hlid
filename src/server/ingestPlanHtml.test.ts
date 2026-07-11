/**
 * ingestPlanHtml — validates and copies an agent-written HTML plan document
 * into the session's attachment dir as an ephemeral relic. Filesystem and DB
 * calls are fully mocked so no disk I/O occurs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
	createAttachment: vi.fn().mockResolvedValue(undefined),
	linkAttachmentToMessage: vi.fn().mockResolvedValue(true),
}));

const fsState = {
	lstatResult: { isFile: () => true, size: 100 } as {
		isFile: () => boolean;
		size: number;
	},
	realpathResult: "/agent/.hlid/plans/plan-sess-1.html",
	readFileResult: Buffer.from("<h1>plan</h1>"),
};

vi.mock("node:fs/promises", () => ({
	lstat: vi.fn(async () => fsState.lstatResult),
	realpath: vi.fn(async () => fsState.realpathResult),
	readFile: vi.fn(async () => fsState.readFileResult),
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	unlink: vi.fn().mockResolvedValue(undefined),
	readdir: vi.fn().mockResolvedValue([]),
	rmdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
	realpathSync: vi.fn().mockImplementation((p: string) => p),
}));

vi.mock("node:crypto", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
	const actual = require("node:crypto") as typeof import("node:crypto");
	return {
		...actual,
		randomUUID: vi.fn().mockReturnValue("00000000-0000-0000-0000-000000000042"),
	};
});

import { unlink } from "node:fs/promises";
import * as db from "../db";
import { ingestPlanHtml } from "./attachments";

const baseOpts = {
	sourcePath: "/agent/.hlid/plans/plan-sess-1.html",
	plansDir: "/agent/.hlid/plans",
	storageRoot: "/agent",
	sessionId: "sess-1",
	planSeq: 3,
	maxBytes: 25 * 1024 * 1024,
};

afterEach(() => {
	vi.clearAllMocks();
	fsState.lstatResult = { isFile: () => true, size: 100 };
	fsState.realpathResult = "/agent/.hlid/plans/plan-sess-1.html";
	fsState.readFileResult = Buffer.from("<h1>plan</h1>");
});

describe("ingestPlanHtml — happy path", () => {
	it("creates an ephemeral text/html attachment and unlinks the source", async () => {
		const id = await ingestPlanHtml(baseOpts);
		expect(id).toBe("00000000-0000-0000-0000-000000000042");
		expect(db.createAttachment).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "00000000-0000-0000-0000-000000000042",
				session_id: "sess-1",
				kind: "ephemeral",
				mime: "text/html",
			}),
		);
		expect(db.linkAttachmentToMessage).toHaveBeenCalledWith(
			"00000000-0000-0000-0000-000000000042",
			"sess-1",
			3,
		);
		expect(unlink).toHaveBeenCalledWith(fsState.realpathResult);
	});
});

describe("ingestPlanHtml — rejections fall back to null", () => {
	it("rejects a non-regular-file source (symlink target)", async () => {
		fsState.lstatResult = { isFile: () => false, size: 100 };
		const id = await ingestPlanHtml(baseOpts);
		expect(id).toBeNull();
		expect(db.createAttachment).not.toHaveBeenCalled();
	});

	it("rejects an empty file", async () => {
		fsState.lstatResult = { isFile: () => true, size: 0 };
		const id = await ingestPlanHtml(baseOpts);
		expect(id).toBeNull();
	});

	it("rejects a file over maxBytes", async () => {
		fsState.lstatResult = { isFile: () => true, size: 6 * 1024 * 1024 };
		const id = await ingestPlanHtml(baseOpts);
		expect(id).toBeNull();
	});

	it("rejects a resolved path outside plansDir", async () => {
		fsState.realpathResult = "/etc/passwd";
		const id = await ingestPlanHtml(baseOpts);
		expect(id).toBeNull();
		expect(db.createAttachment).not.toHaveBeenCalled();
	});

	it("returns null (not throw) when lstat rejects (missing file)", async () => {
		const { lstat } = await import("node:fs/promises");
		vi.mocked(lstat).mockRejectedValueOnce(new Error("ENOENT"));
		const id = await ingestPlanHtml(baseOpts);
		expect(id).toBeNull();
	});
});
