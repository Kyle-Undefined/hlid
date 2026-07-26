import { stat } from "node:fs/promises";
import type { Manifest } from "@umbod/core";
import UMBOD_ANALYTICS_WORKER_SOURCE from "../../build/embed-assets/umbod/analytics-worker-source.generated";
import type {
	UmbodAnalyticsSnapshot,
	UmbodAnalyticsWorkerRequest,
	UmbodAnalyticsWorkerResponse,
} from "./umbodAnalyticsWorkerProtocol";

const WORKER_TIMEOUT_MS = 30_000;
const ANALYTICS_MAX_AGE_MS = 60 * 60_000;

type PendingRequest = {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};
type WorkerRequestWithoutId =
	| Omit<Extract<UmbodAnalyticsWorkerRequest, { kind: "snapshot" }>, "id">
	| Omit<Extract<UmbodAnalyticsWorkerRequest, { kind: "calls" }>, "id">;

let worker: Worker | null = null;
let workerUrl: string | null = null;
const pending = new Map<string, PendingRequest>();
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

function rejectPending(message: string): void {
	for (const request of pending.values()) {
		clearTimeout(request.timeout);
		request.reject(new Error(message));
	}
	pending.clear();
}

function closeWorker(message: string): void {
	const active = worker;
	worker = null;
	rejectPending(message);
	active?.terminate();
}

function getWorker(): Worker {
	if (worker) return worker;
	workerUrl ??= URL.createObjectURL(
		new Blob([UMBOD_ANALYTICS_WORKER_SOURCE], { type: "text/javascript" }),
	);
	const next = new Worker(workerUrl, {
		type: "module",
		smol: true,
		ref: false,
	});
	next.addEventListener(
		"message",
		(event: MessageEvent<UmbodAnalyticsWorkerResponse>) => {
			const response = event.data;
			const request = pending.get(response.id);
			if (!request) return;
			pending.delete(response.id);
			clearTimeout(request.timeout);
			if (response.error) request.reject(new Error(response.error));
			else request.resolve(response.result);
		},
	);
	next.addEventListener("error", (event) => {
		if (worker !== next) return;
		const detail = event.message?.trim();
		closeWorker(
			`Umbod analytics worker failed${detail ? `: ${detail.slice(0, 300)}` : ""}`,
		);
	});
	next.addEventListener("close", () => {
		if (worker !== next) return;
		worker = null;
		rejectPending("Umbod analytics worker closed unexpectedly");
	});
	worker = next;
	return next;
}

function runWorker(request: WorkerRequestWithoutId): Promise<unknown> {
	const id = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (!pending.has(id)) return;
			closeWorker(
				`Umbod analytics worker timed out after ${WORKER_TIMEOUT_MS}ms`,
			);
		}, WORKER_TIMEOUT_MS);
		pending.set(id, { resolve, reject, timeout });
		getWorker().postMessage({ ...request, id });
	});
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
	closeWorker("Umbod analytics invalidated");
}
