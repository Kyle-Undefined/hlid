import { stat } from "node:fs/promises";
import type { Manifest } from "@umbod/core";
import UMBOD_ANALYTICS_WORKER_SOURCE from "../../build/embed-assets/umbod/analytics-worker-source.generated";
import type {
	UmbodAnalyticsSnapshot,
	UmbodAnalyticsWorkerRequest,
	UmbodAnalyticsWorkerResponse,
} from "./umbodAnalyticsWorkerProtocol";
import { WorkerRpcClient } from "./workerRpcClient";

const WORKER_TIMEOUT_MS = 30_000;
const ANALYTICS_MAX_AGE_MS = 60 * 60_000;

type WorkerRequestWithoutId =
	| Omit<Extract<UmbodAnalyticsWorkerRequest, { kind: "snapshot" }>, "id">
	| Omit<Extract<UmbodAnalyticsWorkerRequest, { kind: "calls" }>, "id">;

const analyticsWorker = new WorkerRpcClient<
	WorkerRequestWithoutId,
	UmbodAnalyticsWorkerRequest,
	UmbodAnalyticsWorkerResponse,
	unknown
>({
	label: "Umbod analytics",
	source: UMBOD_ANALYTICS_WORKER_SOURCE,
	timeoutMs: WORKER_TIMEOUT_MS,
	buildRequest: (id, request) => ({ ...request, id }),
	adaptResponse: (response) =>
		response.error
			? { ok: false, error: response.error }
			: { ok: true, result: response.result },
});
let cached:
	| {
			key: string;
			fetchedAt: number;
			value: UmbodAnalyticsSnapshot;
	  }
	| undefined;
let inFlight:
	| {
			key: string;
			promise: Promise<UmbodAnalyticsSnapshot>;
	  }
	| undefined;

function runWorker(request: WorkerRequestWithoutId): Promise<unknown> {
	return analyticsWorker.run(request);
}

async function fileFingerprint(path: string): Promise<string> {
	const metadata = await stat(path).catch(() => null);
	return metadata ? `${metadata.size}:${metadata.mtimeMs}` : "missing";
}

async function analyticsKey(
	manifest: Manifest,
	databasePath: string,
): Promise<string> {
	const database = await fileFingerprint(databasePath);
	return `${JSON.stringify(manifest)}\0${databasePath}:${database}`;
}

/**
 * Compute Umbod's expensive SQLite analytics in an isolated JS thread. Results
 * are reused while the active policy and database are unchanged, with a
 * time-based safety refresh for the rolling recent-days window.
 */
export async function readUmbodAnalytics(
	manifest: Manifest,
	databasePath: string,
	refresh = false,
): Promise<UmbodAnalyticsSnapshot> {
	const key = await analyticsKey(manifest, databasePath);
	if (
		!refresh &&
		cached?.key === key &&
		Date.now() - cached.fetchedAt < ANALYTICS_MAX_AGE_MS
	) {
		return cached.value;
	}
	if (inFlight?.key === key) return inFlight.promise;
	const promise = runWorker({
		kind: "snapshot",
		manifest,
		databasePath,
	}).then(async (result) => {
		const value = result as UmbodAnalyticsSnapshot;
		// Umbod initializes its schema when opening the analytics connection,
		// which can update SQLite metadata even for an otherwise read-only pass.
		// Fingerprint after that initialization so the next read is a true hit.
		cached = {
			key: await analyticsKey(manifest, databasePath),
			fetchedAt: Date.now(),
			value,
		};
		return value;
	});
	inFlight = { key, promise };
	return promise.finally(() => {
		if (inFlight?.promise === promise) inFlight = undefined;
	});
}

export function readUmbodCalls(
	manifest: Manifest,
	databasePath: string,
	searchParams: URLSearchParams,
): Promise<unknown> {
	return runWorker({
		kind: "calls",
		manifest,
		databasePath,
		searchParams: searchParams.toString(),
	});
}

export function invalidateUmbodAnalytics(): void {
	cached = undefined;
	inFlight = undefined;
	analyticsWorker.close("Umbod analytics invalidated");
}
