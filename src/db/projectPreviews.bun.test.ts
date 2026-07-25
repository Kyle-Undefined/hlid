import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	getLatestProjectPreviewForSession,
	getProjectPreview,
	saveProjectPreview,
	stopActiveProjectPreviewsAfterRestart,
} from "./projectPreviews";
import { setDbForTest } from "./schema";

describe("project preview provenance", () => {
	beforeEach(() => {
		setDbForTest(new Database(":memory:"));
	});

	it("persists lifecycle, logs, expiry, and stop reason", async () => {
		await saveProjectPreview({
			id: "preview-1",
			session_id: "session-1",
			label: "Web",
			command: "bun run dev",
			cwd: "/work/web",
			port: 4173,
			path: "/",
			url: "http://127.0.0.1:4173/",
			relay_url: "/api/project-previews/preview-1/relay/",
			state: "ready",
			present: true,
			started_at: "2026-07-24T10:00:00.000Z",
			expires_at: "2026-07-24T14:00:00.000Z",
			logs: ["ready"],
		});
		const running = await getProjectPreview("preview-1");
		if (!running) throw new Error("Expected persisted preview");
		await saveProjectPreview({
			...running,
			state: "stopped",
			ended_at: "2026-07-24T11:00:00.000Z",
			stop_reason: "explicit",
		});

		expect(await getLatestProjectPreviewForSession("session-1")).toMatchObject({
			id: "preview-1",
			state: "stopped",
			stop_reason: "explicit",
			logs: ["ready"],
		});
	});

	it("marks active previews stopped after Hlid restarts", async () => {
		await saveProjectPreview({
			id: "preview-1",
			session_id: "session-1",
			label: "Web",
			command: "bun run dev",
			cwd: "/work/web",
			port: 4173,
			path: "/",
			url: "http://127.0.0.1:4173/",
			relay_url: "/api/project-previews/preview-1/relay/",
			state: "ready",
			present: true,
			started_at: "2026-07-24T10:00:00.000Z",
			expires_at: "2026-07-24T14:00:00.000Z",
			logs: [],
		});
		expect(await stopActiveProjectPreviewsAfterRestart()).toBe(1);
		expect(await getProjectPreview("preview-1")).toMatchObject({
			state: "stopped",
			stop_reason: "hlid_restart",
		});
	});
});
