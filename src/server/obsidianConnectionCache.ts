import type { ObsidianConnection } from "./obsidianCli";
import { testObsidianConnection } from "./obsidianCli";

export type ObsidianConnectionSnapshot = {
	vaultName: string;
	state: "checking" | "connected" | "failed";
	connection: ObsidianConnection | null;
	error: string | null;
	checkedAt: number | null;
};

type CacheStore = {
	snapshot: ObsidianConnectionSnapshot | null;
	inflight: {
		vaultName: string;
		promise: Promise<ObsidianConnection>;
	} | null;
};

const CACHE_KEY = Symbol.for("hlid.obsidianConnectionCache");

function cacheStore(): CacheStore {
	const host = globalThis as typeof globalThis & {
		[CACHE_KEY]?: CacheStore;
	};
	let store = host[CACHE_KEY];
	if (!store) {
		store = { snapshot: null, inflight: null };
		host[CACHE_KEY] = store;
	}
	return store;
}

function failureMessage(cause: unknown): string {
	return cause instanceof Error
		? cause.message
		: "Could not connect to Obsidian";
}

export function getObsidianConnectionSnapshot(
	vaultName: string,
): ObsidianConnectionSnapshot | null {
	const snapshot = cacheStore().snapshot;
	return snapshot?.vaultName === vaultName ? snapshot : null;
}

export async function checkObsidianConnection(
	vaultName: string,
	options: {
		force?: boolean;
		testConnection?: (vaultName: string) => Promise<ObsidianConnection>;
	} = {},
): Promise<ObsidianConnection> {
	const store = cacheStore();
	const existing = getObsidianConnectionSnapshot(vaultName);
	if (
		!options.force &&
		existing?.state === "connected" &&
		existing.connection
	) {
		return existing.connection;
	}
	if (!options.force && existing?.state === "failed") {
		throw new Error(existing.error ?? "Could not connect to Obsidian");
	}
	if (store.inflight?.vaultName === vaultName) {
		return store.inflight.promise;
	}

	store.snapshot = {
		vaultName,
		state: "checking",
		connection: null,
		error: null,
		checkedAt: null,
	};
	const run = (options.testConnection ?? testObsidianConnection)(vaultName)
		.then((connection) => {
			if (store.snapshot?.vaultName === vaultName) {
				store.snapshot = {
					vaultName,
					state: "connected",
					connection,
					error: null,
					checkedAt: Date.now(),
				};
			}
			return connection;
		})
		.catch((cause: unknown) => {
			const error = failureMessage(cause);
			if (store.snapshot?.vaultName === vaultName) {
				store.snapshot = {
					vaultName,
					state: "failed",
					connection: null,
					error,
					checkedAt: Date.now(),
				};
			}
			throw cause;
		})
		.finally(() => {
			if (store.inflight?.promise === run) store.inflight = null;
		});
	store.inflight = { vaultName, promise: run };
	return run;
}

// fallow-ignore-next-line unused-export -- Loaded dynamically by the Obsidian Forge server function to keep host code out of the client bundle.
export async function getOrCheckObsidianConnection(
	vaultName: string,
): Promise<ObsidianConnectionSnapshot> {
	const existing = getObsidianConnectionSnapshot(vaultName);
	if (!existing || existing.state === "checking") {
		try {
			await checkObsidianConnection(vaultName);
		} catch {
			// The cached failed snapshot is the status response.
		}
	}
	return (
		getObsidianConnectionSnapshot(vaultName) ?? {
			vaultName,
			state: "failed",
			connection: null,
			error: "Could not connect to Obsidian",
			checkedAt: Date.now(),
		}
	);
}

/** Prime one process-wide connection result without delaying server startup. */
export function warmObsidianConnection(vaultName: string): void {
	void checkObsidianConnection(vaultName).catch(() => {
		// Connection failures remain available to Forge through the snapshot.
	});
}

// fallow-ignore-next-line unused-export -- test-only reset
export function resetObsidianConnectionCacheForTests(): void {
	const store = cacheStore();
	store.snapshot = null;
	store.inflight = null;
}
