/** Database storage stats and optimization server fns. */
import { createServerFn } from "@tanstack/react-start";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";

export type StorageStats = import("#/db").StorageStats;

const EMPTY_STORAGE_STATS: StorageStats = {
	databaseBytes: 0,
	walBytes: 0,
	reclaimableBytes: 0,
	trackedAttachmentBytes: 0,
	trackedAttachments: 0,
	libraryBytes: 0,
	sessions: 0,
	messages: 0,
	usageQueries: 0,
};

export const getStorageStatsFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<StorageStats>("/db/storage", EMPTY_STORAGE_STATS),
);

export const optimizeStorageFn = createServerFn({ method: "POST" }).handler(
	async () => {
		const response = await dbFetch("/db/storage/optimize", { method: "POST" });
		await requireDbOk(response, "Optimize storage");
		return (await response.json()) as StorageStats;
	},
);
