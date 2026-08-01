/**
 * ingestVisualizationHtml — validates and consumes trusted Visualize output
 * from Hlid-owned staging without linking it into the message transcript.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
	createAttachment: vi.fn().mockResolvedValue(undefined),
	linkAttachmentToMessage: vi.fn().mockResolvedValue(true),
	deleteAttachment: vi.fn().mockResolvedValue(null),
}));

const visualizationRoot = "/hlid/library/staging/visualizations";
const sourcePath = `${visualizationRoot}/job-1/rendered.html`;
const fsState = {
	lstatResult: { isFile: () => true, size: 100 } as {
		isFile: () => boolean;
		size: number;
	},
	realpathResult: sourcePath,
	readFileResult: Buffer.from("<!doctype html><title>Visual</title>"),
};

vi.mock("node:fs/promises", () => ({
	copyFile: vi.fn().mockResolvedValue(undefined),
	lstat: vi.fn(async () => fsState.lstatResult),
	realpath: vi.fn(async (path: string) =>
		path === visualizationRoot ? visualizationRoot : fsState.realpathResult,
	),
	readFile: vi.fn(async () => fsState.readFileResult),
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	unlink: vi.fn().mockResolvedValue(undefined),
	readdir: vi.fn().mockResolvedValue([]),
	rmdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
	constants: { COPYFILE_EXCL: 1 },
	realpathSync: vi.fn().mockImplementation((path: string) => path),
}));

vi.mock("./libraryStore", () => ({
	artifactDirectory: (id: string) => `/hlid/library/artifacts/${id}`,
	artifactPath: (id: string, filename: string) =>
		`/hlid/library/artifacts/${id}/${filename}`,
	planStagingDirectory: () => "/hlid/library/staging/plans",
	prepareLibrary: vi.fn().mockResolvedValue(undefined),
	storageKey: (path: string) => path.replace("/hlid/library/", ""),
	visualizationStagingDirectory: () => visualizationRoot,
}));

vi.mock("node:crypto", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
	const actual = require("node:crypto") as typeof import("node:crypto");
	return {
		...actual,
		randomUUID: vi.fn().mockReturnValue("00000000-0000-0000-0000-000000000043"),
	};
});

import { unlink, writeFile } from "node:fs/promises";
import * as db from "../db";
import {
	applyVisualizationZoomRelay,
	ingestVisualizationHtml,
} from "./attachments";

const baseOpts = {
	sourcePath,
	sessionId: "sess-1",
	title: "Latency Explorer",
	agentCwd: "/workspace/project",
};

afterEach(() => {
	vi.clearAllMocks();
	fsState.lstatResult = { isFile: () => true, size: 100 };
	fsState.realpathResult = sourcePath;
	fsState.readFileResult = Buffer.from("<!doctype html><title>Visual</title>");
});

describe("ingestVisualizationHtml", () => {
	it("creates a session-scoped generated attachment without a message link", async () => {
		const result = await ingestVisualizationHtml(baseOpts);

		expect(result).toEqual({
			id: "00000000-0000-0000-0000-000000000043",
			filename: "latency-explorer.html",
		});
		expect(db.createAttachment).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "00000000-0000-0000-0000-000000000043",
				session_id: "sess-1",
				kind: "ephemeral",
				filename: "latency-explorer.html",
				mime: "text/html",
				category: "visualization",
				retention: "session",
				origin: "generated",
				agent_cwd: "/workspace/project",
			}),
		);
		expect(db.linkAttachmentToMessage).not.toHaveBeenCalled();
		expect(unlink).toHaveBeenCalledWith(sourcePath);
	});

	it("persists a bounded zoom relay inside the rendered shell", async () => {
		fsState.readFileResult = Buffer.from(
			"<!doctype html><html><body><iframe></iframe></body></html>",
		);

		await expect(ingestVisualizationHtml(baseOpts)).resolves.not.toBeNull();
		const persistedBytes = vi.mocked(writeFile).mock.calls[0]?.[1];
		expect(Buffer.isBuffer(persistedBytes)).toBe(true);
		const persistedHtml = (persistedBytes as Buffer).toString("utf-8");

		expect(persistedHtml).toContain("data-hlid-visualization-zoom-relay");
		expect(persistedHtml).toContain("data.type === MESSAGE_TYPE");
		expect(persistedHtml).toContain("event.source !== parent");
		expect(persistedHtml).toContain("data.zoom >= 0.5");
		expect(persistedHtml).toContain("data.zoom <= 1.5");
		expect(persistedHtml).toContain(
			'frame.contentWindow?.postMessage(lastZoom, "*")',
		);
		expect(
			persistedHtml.indexOf("data-hlid-visualization-zoom-relay"),
		).toBeLessThan(persistedHtml.indexOf("</body>"));
	});

	it("appends the zoom relay when the renderer omits a body wrapper", () => {
		const html = "<!doctype html><title>Visual</title>";
		const result = applyVisualizationZoomRelay(html);

		expect(result.startsWith(html)).toBe(true);
		expect(result).toContain("data-hlid-visualization-zoom-relay");
	});

	it("uses the staged basename when no title is provided", async () => {
		const result = await ingestVisualizationHtml({
			sourcePath,
			sessionId: "sess-1",
		});

		expect(result?.filename).toBe("rendered.html");
	});

	it.each([
		["a non-regular source", { isFile: () => false, size: 100 }],
		["an empty source", { isFile: () => true, size: 0 }],
		[
			"a source above the hard cap",
			{ isFile: () => true, size: 16 * 1024 * 1024 + 1 },
		],
	])("rejects %s", async (_label, stat) => {
		fsState.lstatResult = stat;

		await expect(ingestVisualizationHtml(baseOpts)).resolves.toBeNull();
		expect(db.createAttachment).not.toHaveBeenCalled();
	});

	it("rejects a real path outside visualization staging", async () => {
		fsState.realpathResult = "/tmp/rendered.html";

		await expect(ingestVisualizationHtml(baseOpts)).resolves.toBeNull();
		expect(db.createAttachment).not.toHaveBeenCalled();
	});

	it("rechecks the hard cap after reading the source", async () => {
		fsState.readFileResult = Buffer.alloc(16 * 1024 * 1024 + 1);

		await expect(ingestVisualizationHtml(baseOpts)).resolves.toBeNull();
		expect(db.createAttachment).not.toHaveBeenCalled();
	});

	it("removes the copied file when attachment persistence fails", async () => {
		vi.mocked(db.createAttachment).mockRejectedValueOnce(
			new Error("database unavailable"),
		);

		await expect(ingestVisualizationHtml(baseOpts)).resolves.toBeNull();
		expect(unlink).toHaveBeenCalledWith(
			"/hlid/library/artifacts/00000000-0000-0000-0000-000000000043/latency-explorer.html",
		);
		expect(unlink).not.toHaveBeenCalledWith(sourcePath);
	});
});
