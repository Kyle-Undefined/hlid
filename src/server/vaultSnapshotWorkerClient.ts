import VAULT_SNAPSHOT_WORKER_SOURCE from "../../build/embed-assets/vault/vault-worker-source.generated";
import type { HlidConfig } from "../config";
import type { buildSnapshotData } from "./vaultSnapshotBuilder";
import type {
	VaultSnapshotWorkerRequest,
	VaultSnapshotWorkerResponse,
} from "./vaultSnapshotWorkerProtocol";
import { WorkerRpcClient } from "./workerRpcClient";

type VaultSnapshotData = ReturnType<typeof buildSnapshotData>;
export type VaultSnapshotWorkerResult =
	| { changed: false; contentKey: string }
	| { changed: true; contentKey: string; data: VaultSnapshotData };
const WORKER_TIMEOUT_MS = 30_000;
type VaultSnapshotWorkerInput = Omit<VaultSnapshotWorkerRequest, "id">;

const snapshotWorker = new WorkerRpcClient<
	VaultSnapshotWorkerInput,
	VaultSnapshotWorkerRequest,
	VaultSnapshotWorkerResponse,
	VaultSnapshotWorkerResult
>({
	label: "Vault snapshot",
	// The generated bundle is self-contained and loaded from memory. This avoids
	// Bun's standalone worker-entry resolver, which cannot consistently match a
	// source entry when this module is present in both main and SSR bundles.
	source: VAULT_SNAPSHOT_WORKER_SOURCE,
	timeoutMs: WORKER_TIMEOUT_MS,
	buildRequest: (id, request) => ({ ...request, id }),
	adaptResponse: (response) => {
		if (response.error) return { ok: false, error: response.error };
		if (!response.contentKey) {
			return {
				ok: false,
				error: "Vault snapshot worker returned no fingerprint",
			};
		}
		if (response.unchanged) {
			return {
				ok: true,
				result: { changed: false, contentKey: response.contentKey },
			};
		}
		if (response.data === undefined) {
			return {
				ok: false,
				error: "Vault snapshot worker returned no snapshot",
			};
		}
		return {
			ok: true,
			result: {
				changed: true,
				contentKey: response.contentKey,
				data: response.data as VaultSnapshotData,
			},
		};
	},
});

/** Run filesystem-heavy Vault scanning in a reusable isolated JS thread. */
export async function buildVaultSnapshotOffMainThread(
	config: HlidConfig,
	configKey: string,
	previousContentKey?: string,
): Promise<VaultSnapshotWorkerResult> {
	return snapshotWorker.run({
		config,
		configKey,
		previousContentKey,
	});
}
