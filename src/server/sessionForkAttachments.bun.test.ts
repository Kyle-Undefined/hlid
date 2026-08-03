import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const libraryState = vi.hoisted(() => ({ root: "" }));

vi.mock("./libraryStore", () => ({
	artifactsDirectory: () => `${libraryState.root}/artifacts`,
	artifactDirectory: (id: string) => `${libraryState.root}/artifacts/${id}`,
	artifactPath: (id: string, filename: string) =>
		`${libraryState.root}/artifacts/${id}/${filename}`,
	prepareLibrary: vi.fn().mockResolvedValue(undefined),
	storageKey: (path: string) =>
		path.slice(`${libraryState.root}/`.length).replaceAll("\\", "/"),
}));

import {
	createAttachment,
	getAttachment,
	linkAttachmentToMessage,
} from "../db/attachments";
import { freshDb } from "../db/db.test-utils";
import {
	appendMessage,
	appendToolEvent,
	copyForkedSessionTranscript,
	getSessionToolEventDetail,
	setToolEventResult,
} from "../db/messages";
import {
	createForkedSessionRow,
	createSession,
	deleteSession,
} from "../db/sessions";
import {
	copyForkedGeneratedMediaAttachments,
	copyForkedVisualizationAttachments,
} from "./sessionForkAttachments";

let database: Database;
let libraryRoot = "";

beforeEach(async () => {
	database = freshDb();
	libraryRoot = await mkdtemp(join(tmpdir(), "hlid-fork-visualization-"));
	libraryState.root = libraryRoot;
	await mkdir(`${libraryRoot}/artifacts`, { recursive: true });
});

afterEach(async () => {
	database.close();
	await rm(libraryRoot, { recursive: true, force: true });
});

describe("copyForkedVisualizationAttachments", () => {
	it("keeps a forked iframe valid after the source session and artifact are deleted", async () => {
		await createSession("source", "Source", "gpt-5.6-sol", {
			providerId: "codex",
		});
		await appendMessage("source", 1, "assistant", "Visualization ready");
		await appendToolEvent(
			"source",
			1,
			"visualization-tool-1",
			"create_visualization",
			{ request: "Show latency" },
		);

		const sourceAttachmentId = "visualization-source";
		const sourceDirectory = `${libraryRoot}/artifacts/${sourceAttachmentId}`;
		const sourcePath = `${sourceDirectory}/visualization.html`;
		const html = "<!doctype html><title>Latency</title><p>42 ms</p>";
		await mkdir(sourceDirectory, { recursive: true });
		await writeFile(sourcePath, html);
		await createAttachment({
			id: sourceAttachmentId,
			session_id: "source",
			kind: "ephemeral",
			filename: "visualization.html",
			path: sourcePath,
			mime: "text/html",
			size_bytes: Buffer.byteLength(html),
			sha256: createHash("sha256").update(html).digest("hex"),
			storage_key: `artifacts/${sourceAttachmentId}/visualization.html`,
			category: "visualization",
			retention: "session",
			origin: "generated",
			agent_cwd: "/work/project",
		});
		const sourceResult = JSON.stringify({
			type: "hlid_visualization",
			attachment_id: sourceAttachmentId,
			filename: "visualization.html",
			title: "Latency",
		});
		await setToolEventResult(
			"source",
			"visualization-tool-1",
			sourceResult,
			false,
		);

		await createForkedSessionRow("source", "fork", "native-fork", {
			forkKind: "exact",
		});
		await copyForkedSessionTranscript("source", "fork");
		expect(await copyForkedVisualizationAttachments("source", "fork")).toBe(1);

		const forkResultText = (
			await getSessionToolEventDetail("fork", "visualization-tool-1")
		)?.result_text;
		expect(forkResultText).not.toBeNull();
		const forkResult = JSON.parse(forkResultText ?? "{}") as {
			attachment_id: string;
		};
		expect(forkResult.attachment_id).not.toBe(sourceAttachmentId);
		const forkAttachment = await getAttachment(forkResult.attachment_id);
		expect(forkAttachment).toMatchObject({
			session_id: "fork",
			kind: "ephemeral",
			filename: "visualization.html",
			mime: "text/html",
			category: "visualization",
			retention: "session",
			origin: "generated",
			agent_cwd: "/work/project",
		});
		expect(forkAttachment?.path).not.toBe(sourcePath);
		expect(await readFile(forkAttachment?.path ?? "", "utf8")).toBe(html);

		const { ephemeralPaths } = await deleteSession("source");
		await Promise.all(ephemeralPaths.map((path) => unlink(path)));

		expect(await getAttachment(sourceAttachmentId)).toBeNull();
		await expect(readFile(sourcePath)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await getAttachment(forkResult.attachment_id)).not.toBeNull();
		expect(await readFile(forkAttachment?.path ?? "", "utf8")).toBe(html);
		expect(
			(await getSessionToolEventDetail("fork", "visualization-tool-1"))
				?.result_text,
		).toBe(forkResultText);
	});
});

describe("copyForkedGeneratedMediaAttachments", () => {
	it("keeps a forked generated image valid after the source session is deleted", async () => {
		await createSession("source", "Source", "gpt-5.6-sol", {
			providerId: "codex",
		});
		await appendMessage("source", 1, "assistant", "Image ready");
		await appendToolEvent("source", 1, "image-tool-1", "ImageGeneration", {
			type: "imageGeneration",
			status: "inProgress",
		});

		const sourceAttachmentId = "generated-image-source";
		const sourceDirectory = `${libraryRoot}/artifacts/${sourceAttachmentId}`;
		const sourcePath = `${sourceDirectory}/image-tool-1.png`;
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
		await mkdir(sourceDirectory, { recursive: true });
		await writeFile(sourcePath, png);
		await createAttachment({
			id: sourceAttachmentId,
			session_id: "source",
			kind: "ephemeral",
			filename: "image-tool-1.png",
			path: sourcePath,
			mime: "image/png",
			size_bytes: png.byteLength,
			sha256: createHash("sha256").update(png).digest("hex"),
			storage_key: `artifacts/${sourceAttachmentId}/image-tool-1.png`,
			category: "media",
			retention: "retained",
			origin: "generated",
			agent_cwd: "/work/project",
			image_optimized_at: 123,
			original_size_bytes: png.byteLength,
		});
		expect(await linkAttachmentToMessage(sourceAttachmentId, "source", 1)).toBe(
			true,
		);
		const sourceResult = JSON.stringify({
			type: "hlid_generated_media",
			version: 1,
			status: "ready",
			provider: "codex",
			provider_item_id: "image-tool-1",
			attachment_id: sourceAttachmentId,
			filename: "image-tool-1.png",
			mime: "image/png",
			size_bytes: png.byteLength,
			width: 1,
			height: 1,
		});
		await setToolEventResult("source", "image-tool-1", sourceResult, false);

		await createForkedSessionRow("source", "fork", "native-fork", {
			forkKind: "exact",
		});
		await copyForkedSessionTranscript("source", "fork");
		expect(await copyForkedGeneratedMediaAttachments("source", "fork")).toBe(1);

		const forkResultText = (
			await getSessionToolEventDetail("fork", "image-tool-1")
		)?.result_text;
		const forkResult = JSON.parse(forkResultText ?? "{}") as {
			attachment_id: string;
		};
		expect(forkResult.attachment_id).not.toBe(sourceAttachmentId);
		const forkAttachment = await getAttachment(forkResult.attachment_id);
		expect(forkAttachment).toMatchObject({
			session_id: "fork",
			message_seq: 1,
			kind: "ephemeral",
			filename: "image-tool-1.png",
			mime: "image/png",
			category: "media",
			retention: "retained",
			origin: "generated",
			agent_cwd: "/work/project",
			image_optimized_at: 123,
			original_size_bytes: png.byteLength,
		});
		expect(await readFile(forkAttachment?.path ?? "")).toEqual(png);

		const { ephemeralPaths } = await deleteSession("source");
		await Promise.all(ephemeralPaths.map((path) => unlink(path)));
		expect(await getAttachment(sourceAttachmentId)).toBeNull();
		expect(await getAttachment(forkResult.attachment_id)).not.toBeNull();
		expect(await readFile(forkAttachment?.path ?? "")).toEqual(png);
	});
});
