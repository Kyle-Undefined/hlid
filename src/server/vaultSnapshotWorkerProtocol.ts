import type { HlidConfig } from "../config";

export type VaultSnapshotWorkerRequest = {
	id: string;
	config: HlidConfig;
	configKey: string;
	previousContentKey?: string;
};

export type VaultSnapshotWorkerResponse = {
	id: string;
	contentKey?: string;
	data?: unknown;
	unchanged?: boolean;
	error?: string;
};
