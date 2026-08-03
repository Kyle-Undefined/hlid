import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { ProviderBackgroundActivity } from "../server/agentProvider";
import {
	listProviderBackgroundActivities,
	replaceSessionBackgroundActivities,
} from "./providerBackgroundActivities";
import { setDbForTest } from "./schema";
import { createSession, deleteSession } from "./sessions";

const running: ProviderBackgroundActivity = {
	providerId: "codex",
	providerSessionId: "thread-1",
	activityId: "item-1",
	processId: "process-1",
	kind: "terminal",
	status: "running",
	command: "python3 -m http.server",
	cwd: "/tmp/project",
	recentOutput: "Serving on 8000",
	osPid: 42,
	cpuPercent: 1.25,
	rssKb: 2048,
	startedAtMs: 100,
	updatedAtMs: 200,
	capabilities: { terminate: true, clean: true },
};

describe("provider background activities", () => {
	beforeEach(() => {
		setDbForTest(new Database(":memory:"));
	});

	it("restores a persisted running process as non-live", async () => {
		await createSession("session-1", "Background", "gpt-test");
		await replaceSessionBackgroundActivities("session-1", [running]);

		expect(await listProviderBackgroundActivities("session-1")).toEqual([
			{
				...running,
				status: "unknown",
				capabilities: {},
			},
		]);
	});

	it("replaces the bounded provider snapshot and cascades with its session", async () => {
		await createSession("session-1", "Background", "gpt-test");
		await replaceSessionBackgroundActivities("session-1", [running]);
		await replaceSessionBackgroundActivities("session-1", [
			{
				...running,
				activityId: "item-2",
				processId: undefined,
				status: "completed",
				updatedAtMs: 300,
				endedAtMs: 300,
				capabilities: {},
			},
		]);

		expect(
			(await listProviderBackgroundActivities("session-1")).map(
				(activity) => activity.activityId,
			),
		).toEqual(["item-2"]);
		await replaceSessionBackgroundActivities("session-1", []);
		expect(await listProviderBackgroundActivities("session-1")).toEqual([]);

		await replaceSessionBackgroundActivities("session-1", [running]);
		await deleteSession("session-1");
		expect(await listProviderBackgroundActivities("session-1")).toEqual([]);
	});
});
