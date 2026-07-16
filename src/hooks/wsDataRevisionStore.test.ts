import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	changedDataDomains,
	EMPTY_DATA_REVISIONS,
	getDataRevisionSnapshot,
	replaceDataRevisions,
	resetDataRevisionsForTesting,
	subscribeDataRevisionSnapshot,
} from "./wsDataRevisionStore";

beforeEach(resetDataRevisionsForTesting);

describe("ws data revision store", () => {
	it("notifies only when a server revision changes", () => {
		const subscriber = vi.fn();
		subscribeDataRevisionSnapshot(subscriber);
		replaceDataRevisions({ ...EMPTY_DATA_REVISIONS });
		replaceDataRevisions({ ...EMPTY_DATA_REVISIONS, stats: 1 });

		expect(subscriber).toHaveBeenCalledOnce();
		expect(getDataRevisionSnapshot().stats).toBe(1);
	});

	it("reports the domains that changed", () => {
		expect(
			changedDataDomains(EMPTY_DATA_REVISIONS, {
				...EMPTY_DATA_REVISIONS,
				relics: 2,
				vault: 1,
			}),
		).toEqual(["relics", "vault"]);
	});
});
