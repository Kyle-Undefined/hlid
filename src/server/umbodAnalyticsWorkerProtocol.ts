import type { Manifest } from "@umbod/core";

export type UmbodAnalyticsSnapshot = {
	tools?: unknown;
	rules?: unknown;
};

type UmbodAnalyticsWorkerBaseRequest = {
	id: string;
	manifest: Manifest;
	databasePath: string;
};

export type UmbodAnalyticsWorkerRequest =
	| (UmbodAnalyticsWorkerBaseRequest & {
			kind: "snapshot";
	  })
	| (UmbodAnalyticsWorkerBaseRequest & {
			kind: "calls";
			searchParams: string;
	  });

export type UmbodAnalyticsWorkerResponse = {
	id: string;
	result?: unknown;
	error?: string;
};
