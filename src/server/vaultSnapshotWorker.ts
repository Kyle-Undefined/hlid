import type { HlidConfig } from "../config";
import { buildSnapshotData, snapshotContentKey } from "./vaultSnapshotBuilder";
import type {
	VaultSnapshotWorkerRequest,
	VaultSnapshotWorkerResponse,
} from "./vaultSnapshotWorkerProtocol";

function errorMessage(error: unknown): string {
	return error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
}

self.onmessage = (event: MessageEvent<VaultSnapshotWorkerRequest>) => {
	const response: VaultSnapshotWorkerResponse = { id: event.data.id };
	try {
		const data = buildSnapshotData(event.data.config as HlidConfig);
		response.contentKey = snapshotContentKey(event.data.configKey, data);
		if (response.contentKey === event.data.previousContentKey) {
			response.unchanged = true;
		} else {
			response.data = data;
		}
	} catch (error) {
		response.error = errorMessage(error);
	}
	self.postMessage(response);
};
