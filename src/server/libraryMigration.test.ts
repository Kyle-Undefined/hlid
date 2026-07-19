import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	listLegacyManagedAttachments: vi.fn(),
	moveAttachmentIntoLibrary: vi.fn().mockResolvedValue(true),
}));

vi.mock("../db", () => dbMocks);
vi.mock("./libraryStore", () => ({
	prepareLibrary: async () => {
		mkdirSync(process.env.HLID_TEST_MIGRATION_LIBRARY as string, {
			recursive: true,
		});
	},
	artifactPath: (id: string, filename: string) =>
		join(process.env.HLID_TEST_MIGRATION_LIBRARY as string, id, filename),
	storageKey: (path: string) =>
		path
			.slice((process.env.HLID_TEST_MIGRATION_LIBRARY as string).length + 1)
			.replace(/\\/g, "/"),
}));

import { migrateLegacyAttachmentsToLibrary } from "./libraryMigration";

let root: string;
let source: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hlid-library-migration-"));
	process.env.HLID_TEST_MIGRATION_LIBRARY = join(root, "library");
	source = join(root, "agent", ".hlid", "attachments", "s1", "plan.html");
	mkdirSync(join(root, "agent", ".hlid", "attachments", "s1"), {
		recursive: true,
	});
	writeFileSync(source, "<h1>Plan</h1>");
	const sha256 = createHash("sha256").update("<h1>Plan</h1>").digest("hex");
	dbMocks.listLegacyManagedAttachments.mockResolvedValue([
		{
			id: "a1",
			session_id: "s1",
			message_seq: 2,
			kind: "ephemeral",
			filename: "plan.html",
			path: source,
			mime: "text/html",
			size_bytes: 13,
			sha256,
			created_at: 1,
		},
	]);
	dbMocks.moveAttachmentIntoLibrary.mockResolvedValue(true);
});

afterEach(() => {
	vi.clearAllMocks();
	rmSync(root, { recursive: true, force: true });
	delete process.env.HLID_TEST_MIGRATION_LIBRARY;
});

describe("migrateLegacyAttachmentsToLibrary", () => {
	it("copies, verifies, updates metadata, then removes the legacy file", async () => {
		expect(await migrateLegacyAttachmentsToLibrary()).toBe(1);
		const target = join(
			process.env.HLID_TEST_MIGRATION_LIBRARY as string,
			"a1",
			"plan.html",
		);
		expect(existsSync(target)).toBe(true);
		expect(existsSync(source)).toBe(false);
		expect(dbMocks.moveAttachmentIntoLibrary).toHaveBeenCalledWith(
			"a1",
			expect.objectContaining({
				path: target,
				category: "plan",
				retention: "retained",
				origin: "legacy",
			}),
		);
	});

	it("keeps the legacy source when verification fails", async () => {
		dbMocks.listLegacyManagedAttachments.mockResolvedValueOnce([
			{
				...(await dbMocks.listLegacyManagedAttachments())[0],
				sha256: "wrong",
			},
		]);
		expect(await migrateLegacyAttachmentsToLibrary()).toBe(0);
		expect(existsSync(source)).toBe(true);
		expect(
			existsSync(
				join(
					process.env.HLID_TEST_MIGRATION_LIBRARY as string,
					"a1",
					"plan.html",
				),
			),
		).toBe(false);
		expect(dbMocks.moveAttachmentIntoLibrary).not.toHaveBeenCalled();
	});
});
