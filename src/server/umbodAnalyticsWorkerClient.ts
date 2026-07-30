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
			generation: number;
			fetchedAt: number;
			value: UmbodAnalyticsSnapshot;
	  }
	| undefined;
let inFlight:
	| {
			key: string;
			generation: number;
			promise: Promise<UmbodAnalyticsSnapshot>;
	  }
	| undefined;
let analyticsGeneration = 0;
let analyticsCloseEpoch = 0;

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
	const databaseFiles = [
		databasePath,
		`${databasePath}-wal`,
		`${databasePath}-shm`,
	];
	const fingerprints = await Promise.all(
		databaseFiles.map((path) => fileFingerprint(path)),
	);
	return `${JSON.stringify(manifest)}\0${databaseFiles
		.map((path, index) => `${path}:${fingerprints[index]}`)
		.join("\0")}`;
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
	const closeEpoch = analyticsCloseEpoch;
	let generation: number;
	let key: string;
	// Do not launch work against an identity assembled across an audit write.
	// SQLite fingerprints are quick, so retry until they belong to one known
	// analytics generation.
	do {
		generation = analyticsGeneration;
		key = await analyticsKey(manifest, databasePath);
		if (analyticsCloseEpoch !== closeEpoch)
			throw new Error("Umbod analytics closed");
	} while (generation !== analyticsGeneration);
	if (
		!refresh &&
		cached?.key === key &&
		cached.generation === generation &&
		Date.now() - cached.fetchedAt < ANALYTICS_MAX_AGE_MS
	) {
		return cached.value;
	}
	if (inFlight) {
		if (inFlight.key === key && inFlight.generation === generation)
			return inFlight.promise;
		const active = inFlight.promise;
		// The worker serializes requests. Wait for an obsolete snapshot to finish
		// and then recompute against the latest generation instead of filling its
		// queue with refreshes that can no longer populate the cache.
		try {
			await active;
		} catch (error) {
			if (analyticsCloseEpoch !== closeEpoch) throw error;
		}
		if (analyticsCloseEpoch !== closeEpoch)
			throw new Error("Umbod analytics closed");
		if (inFlight?.promise === active) inFlight = undefined;
		return readUmbodAnalytics(manifest, databasePath, refresh);
	}
	const promise = runWorker({
		kind: "snapshot",
		manifest,
		databasePath,
	}).then(async (result) => {
		const value = result as UmbodAnalyticsSnapshot;
		// Umbod initializes its schema when opening the analytics connection,
		// which can update SQLite metadata even for an otherwise read-only pass.
		// Fingerprint after that initialization so the next read is a true hit,
		// but never let a request spanning an audited mutation publish under the
		// newer database fingerprint.
		if (analyticsGeneration !== generation) return value;
		const completedKey = await analyticsKey(manifest, databasePath);
		if (analyticsGeneration !== generation) return value;
		cached = {
			key: completedKey,
			generation,
			fetchedAt: Date.now(),
			value,
		};
		return value;
	});
	inFlight = { key, generation, promise };
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

/**
 * Mark cached analytics stale after an audit write without interrupting the
 * worker. A subsequent read waits for obsolete work already running, then
 * coalesces onto one snapshot for the latest generation.
 */
export function markUmbodAnalyticsStale(): void {
	analyticsGeneration++;
	cached = undefined;
}

/** Stop the worker and reject pending reads during Hlid shutdown. */
export function closeUmbodAnalytics(): void {
	analyticsCloseEpoch++;
	markUmbodAnalyticsStale();
	inFlight = undefined;
	analyticsWorker.close("Umbod analytics closed");
}
