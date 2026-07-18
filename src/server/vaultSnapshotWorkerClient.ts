import VAULT_SNAPSHOT_WORKER_SOURCE from "../../build/embed-assets/vault/vault-worker-source.generated";
import type { HlidConfig } from "../config";
import type { buildSnapshotData } from "./vaultSnapshotBuilder";
import type {
	VaultSnapshotWorkerRequest,
	VaultSnapshotWorkerResponse,
} from "./vaultSnapshotWorkerProtocol";

type VaultSnapshotData = ReturnType<typeof buildSnapshotData>;
export type VaultSnapshotWorkerResult =
	| { changed: false; contentKey: string }
	| { changed: true; contentKey: string; data: VaultSnapshotData };
const WORKER_TIMEOUT_MS = 30_000;
type PendingSnapshot = {
	resolve: (result: VaultSnapshotWorkerResult) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

let worker: Worker | null = null;
let workerUrl: string | null = null;
const pending = new Map<string, PendingSnapshot>();

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
	// The generated bundle is self-contained and loaded from memory. This avoids
	// Bun's standalone worker-entry resolver, which cannot consistently match a
	// source entry when this module is present in both main and SSR bundles.
	workerUrl ??= URL.createObjectURL(
		new Blob([VAULT_SNAPSHOT_WORKER_SOURCE], { type: "text/javascript" }),
	);
	const next = new Worker(workerUrl, {
		type: "module",
		smol: true,
		ref: false,
	});
	next.addEventListener(
		"message",
		(event: MessageEvent<VaultSnapshotWorkerResponse>) => {
			const response = event.data;
			const request = pending.get(response.id);
			if (!request) return;
			pending.delete(response.id);
			clearTimeout(request.timeout);
			if (response.error) {
				request.reject(new Error(response.error));
			} else if (!response.contentKey) {
				request.reject(
					new Error("Vault snapshot worker returned no fingerprint"),
				);
			} else if (response.unchanged) {
				request.resolve({ changed: false, contentKey: response.contentKey });
			} else if (response.data === undefined) {
				request.reject(new Error("Vault snapshot worker returned no snapshot"));
			} else {
				request.resolve({
					changed: true,
					contentKey: response.contentKey,
					data: response.data as VaultSnapshotData,
				});
			}
		},
	);
	next.addEventListener("error", (event) => {
		if (worker === next) {
			const detail = event.message?.trim();
			closeWorker(
				`Vault snapshot worker failed${detail ? `: ${detail.slice(0, 300)}` : ""}`,
			);
		}
	});
	next.addEventListener("close", () => {
		if (worker === next) {
			worker = null;
			rejectPending("Vault snapshot worker closed unexpectedly");
		}
	});
	worker = next;
	return next;
}

/** Run filesystem-heavy Vault scanning in a reusable isolated JS thread. */
export async function buildVaultSnapshotOffMainThread(
	config: HlidConfig,
	configKey: string,
	previousContentKey?: string,
): Promise<VaultSnapshotWorkerResult> {
	const id = crypto.randomUUID();
	return new Promise<VaultSnapshotWorkerResult>((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (!pending.has(id)) return;
			closeWorker(
				`Vault snapshot worker timed out after ${WORKER_TIMEOUT_MS}ms`,
			);
		}, WORKER_TIMEOUT_MS);
		pending.set(id, { resolve, reject, timeout });
		const request: VaultSnapshotWorkerRequest = {
			id,
			config,
			configKey,
			previousContentKey,
		};
		getWorker().postMessage(request);
	});
}
