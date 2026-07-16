import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	bumpDataRevision,
	getDataRevisions,
	resetDataRevisionsForTesting,
	subscribeDataRevisions,
} from "./dataRevision";

beforeEach(resetDataRevisionsForTesting);

describe("data revisions", () => {
	it("increments only affected domains and publishes one coherent snapshot", () => {
		const subscriber = vi.fn();
		subscribeDataRevisions(subscriber);

		bumpDataRevision("stats", "sessions", "stats");

		expect(getDataRevisions()).toMatchObject({ stats: 1, sessions: 1 });
		expect(subscriber).toHaveBeenCalledOnce();
		expect(subscriber).toHaveBeenCalledWith(
			expect.objectContaining({ stats: 1, sessions: 1, relics: 0 }),
		);
	});

	it("returns snapshots that callers cannot mutate", () => {
		const snapshot = getDataRevisions();
		snapshot.stats = 99;

		expect(getDataRevisions().stats).toBe(0);
	});
});
