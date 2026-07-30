import { type FSWatcher, watch } from "node:fs";
import { resolve } from "node:path";
import type { HlidConfig } from "../config";
import { loadConfig } from "./config";
import {
	bumpDataRevision,
	getDataRevisions,
	subscribeDataRevisions,
} from "./dataRevision";
import { managedSkillsDirectory } from "./libraryStore";
import { safeErrorSummary } from "./requestDiagnostics";
import {
	buildSnapshotData,
	CLAUDE_SKILLS_DIR,
	emptySnapshotData,
	snapshotContentKey,
	VAULT_FOLDER_KEYS,
	type VaultRouteSnapshot,
	type VaultSnapshotData,
} from "./vaultSnapshotBuilder";
import { buildVaultSnapshotOffMainThread } from "./vaultSnapshotWorkerClient";

export type { VaultRouteSnapshot } from "./vaultSnapshotBuilder";

export type VaultSnapshot = {
	revision: number;
	refreshedAt: number;
	vault: VaultRouteSnapshot;
	cockpit: VaultSnapshotData["cockpit"];
};

export type VaultSnapshotRefreshStatus =
	| { status: "refreshed"; snapshot: VaultSnapshot }
	| {
			status: "degraded";
			snapshot: VaultSnapshot;
			error: string;
			retryAt: number;
	  };

const SNAPSHOT_TTL_MS = 5_000;
const WATCH_DEBOUNCE_MS = 200;
const SNAPSHOT_FAILURE_RETRY_MS = 30_000;

type SnapshotRecord = VaultSnapshot & {
	configKey: string;
	contentKey: string;
};

type InternalSnapshotRefreshStatus =
	| {
			status: "refreshed";
			snapshot: SnapshotRecord;
			completedGeneration: number;
	  }
	| {
			status: "degraded";
			snapshot: SnapshotRecord;
			error: string;
			retryAt: number;
			completedGeneration: number;
	  };

let current: SnapshotRecord | null = null;
let inflight: Promise<InternalSnapshotRefreshStatus> | null = null;
let dirty = false;
let invalidationGeneration = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pendingConfig: HlidConfig | null = null;
let retryAfter = 0;
let lastRefreshFailure: { error: string; retryAt: number } | null = null;
let watchSignature = "";
let watchers: FSWatcher[] = [];

function configKey(config: HlidConfig): string {
	return JSON.stringify({
		vault: config.vault,
		statusVocabulary: config.status_vocabulary,
		hideSkillsIndex: config.ui.hide_skills_index,
	});
}

function configuredWatchPaths(config: HlidConfig): string[] {
	const paths = new Set<string>([CLAUDE_SKILLS_DIR, managedSkillsDirectory()]);
	if (config.vault.path) {
		paths.add(resolve(config.vault.path));
		for (const key of VAULT_FOLDER_KEYS) {
			const folder = config.vault[key];
			if (typeof folder === "string") {
				paths.add(resolve(config.vault.path, folder));
			}
		}
	}
	return [...paths].sort();
}

function closeWatchers(): void {
	for (const watcher of watchers) watcher.close();
	watchers = [];
}

function installWatchers(config: HlidConfig): void {
	const paths = configuredWatchPaths(config);
	const signature = paths.join("\0");
	if (signature === watchSignature) return;
	closeWatchers();
	watchSignature = signature;

	for (const path of paths) {
		try {
			const watcher = watch(path, { recursive: true, persistent: false }, () =>
				invalidateVaultSnapshot("filesystem"),
			);
			watcher.on("error", () => watcher.close());
			watchers.push(watcher);
		} catch {
			try {
				const watcher = watch(path, { persistent: false }, () =>
					invalidateVaultSnapshot("filesystem"),
				);
				watcher.on("error", () => watcher.close());
				watchers.push(watcher);
			} catch {
				// Missing folders and platforms without usable watchers are covered by
				// the short safety TTL checked by every server snapshot read.
			}
		}
	}
}

function emitChange(record: SnapshotRecord): void {
	void record;
	bumpDataRevision("vault");
}

function scheduleRefresh(config?: HlidConfig): void {
	if (config) pendingConfig = config;
	if (!current || refreshTimer) return;
	const delay = Math.max(WATCH_DEBOUNCE_MS, retryAfter - Date.now());
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		const nextConfig = pendingConfig ?? loadConfig();
		pendingConfig = null;
		void refreshSnapshot(nextConfig).finally(() => {
			if (dirty) scheduleRefresh();
		});
	}, delay);
}

async function refreshSnapshotStatus(
	config: HlidConfig,
): Promise<InternalSnapshotRefreshStatus> {
	if (inflight) return inflight;
	const startedGeneration = invalidationGeneration;
	const nextConfigKey = configKey(config);
	const promise = Promise.resolve()
		.then(() =>
			process.env.NODE_ENV === "test"
				? (() => {
						const data = buildSnapshotData(config);
						const contentKey = snapshotContentKey(nextConfigKey, data);
						return current?.contentKey === contentKey
							? ({ changed: false, contentKey } as const)
							: ({ changed: true, contentKey, data } as const);
					})()
				: buildVaultSnapshotOffMainThread(
						config,
						nextConfigKey,
						current?.contentKey,
					),
		)
		.then((result) => {
			retryAfter = 0;
			lastRefreshFailure = null;
			if (!result.changed && current?.configKey === nextConfigKey) {
				const record = { ...current, refreshedAt: Date.now() };
				current = record;
				dirty = invalidationGeneration !== startedGeneration;
				installWatchers(config);
				return {
					status: "refreshed",
					snapshot: record,
					completedGeneration: startedGeneration,
				} as const;
			}
			if (!result.changed) {
				throw new Error("Vault snapshot worker omitted changed snapshot data");
			}
			const { contentKey, data } = result;
			const changed = current?.contentKey !== contentKey;
			const record: SnapshotRecord = {
				...data,
				revision: changed
					? (current?.revision ?? 0) + 1
					: (current?.revision ?? 1),
				refreshedAt: Date.now(),
				configKey: nextConfigKey,
				contentKey,
			};
			current = record;
			dirty = invalidationGeneration !== startedGeneration;
			installWatchers(config);
			if (changed) emitChange(record);
			return {
				status: "refreshed",
				snapshot: record,
				completedGeneration: startedGeneration,
			} as const;
		})
		.catch((error) => {
			// Snapshot inventory is optional route enrichment. Preserve a last-good
			// snapshot (or a safe empty shell on first boot) and retry later instead
			// of turning a slow/unavailable filesystem into an app error boundary.
			console.warn(
				`[vaultSnapshot] refresh failed: ${safeErrorSummary(error)}`,
			);
			const errorMessage =
				error instanceof Error ? error.message : safeErrorSummary(error);
			retryAfter = Date.now() + SNAPSHOT_FAILURE_RETRY_MS;
			lastRefreshFailure = { error: errorMessage, retryAt: retryAfter };
			dirty = false;
			let record = current;
			if (record?.configKey !== nextConfigKey) {
				const data = emptySnapshotData(config);
				record = {
					...data,
					revision: (current?.revision ?? 0) + 1,
					refreshedAt: Date.now(),
					configKey: nextConfigKey,
					contentKey: snapshotContentKey(nextConfigKey, data),
				};
				current = record;
				installWatchers(config);
			}
			return {
				status: "degraded",
				snapshot: record,
				error: errorMessage,
				retryAt: retryAfter,
				completedGeneration: startedGeneration,
			} as const;
		})
		.finally(() => {
			inflight = null;
		});
	inflight = promise;
	return promise;
}

async function refreshSnapshot(config: HlidConfig): Promise<SnapshotRecord> {
	return (await refreshSnapshotStatus(config)).snapshot;
}

/**
 * Force a snapshot rebuild for a mutation that must distinguish a fresh view
 * from the normal last-good fallback. Ordinary snapshot readers intentionally
 * keep receiving the fallback without handling refresh status.
 */
export async function refreshVaultSnapshotWithStatus(
	_reason = "explicit",
	config: HlidConfig = loadConfig(),
): Promise<VaultSnapshotRefreshStatus> {
	dirty = true;
	const requestedGeneration = ++invalidationGeneration;
	if (current && Date.now() < retryAfter) {
		scheduleRefresh(config);
		return {
			status: "degraded",
			snapshot: current,
			error:
				lastRefreshFailure?.error ??
				"Vault snapshot refresh is waiting to retry",
			retryAt: lastRefreshFailure?.retryAt ?? retryAfter,
		};
	}

	let result = await refreshSnapshotStatus(config);
	while (
		result.status === "refreshed" &&
		result.completedGeneration < requestedGeneration
	) {
		result = await refreshSnapshotStatus(config);
	}
	if (result.status === "degraded") {
		scheduleRefresh(config);
		return {
			status: result.status,
			snapshot: result.snapshot,
			error: result.error,
			retryAt: result.retryAt,
		};
	}
	return { status: result.status, snapshot: result.snapshot };
}

/**
 * Return the server's last-good Vault/Cockpit view immediately. A missing
 * snapshot is built once; stale or invalidated snapshots refresh in one
 * background flight and notify subscribers only when their contents change.
 */
export async function getVaultSnapshot(options: { refresh?: boolean } = {}) {
	const config = loadConfig();
	const nextConfigKey = configKey(config);
	if (!current) return refreshSnapshot(config);
	if (Date.now() < retryAfter) return current;

	if (options.refresh) {
		dirty = true;
		invalidationGeneration++;
		return refreshSnapshot(config);
	}

	if (
		current.configKey !== nextConfigKey ||
		Date.now() - current.refreshedAt >= SNAPSHOT_TTL_MS
	) {
		dirty = true;
		invalidationGeneration++;
		scheduleRefresh(config);
	}
	return current;
}

/** Mark the shared snapshot stale and coalesce a background rebuild. */
export function invalidateVaultSnapshot(
	_reason = "explicit",
	config?: HlidConfig,
): void {
	dirty = true;
	invalidationGeneration++;
	scheduleRefresh(config);
}

/** Prime the shared snapshot during server boot without delaying startup. */
export function warmVaultSnapshot(): void {
	void getVaultSnapshot().catch((error) =>
		console.warn("[vaultSnapshot] warm-up failed:", error),
	);
}

let observedConfigRevision = getDataRevisions().config;
subscribeDataRevisions((revisions) => {
	if (revisions.config === observedConfigRevision) return;
	observedConfigRevision = revisions.config;
	invalidateVaultSnapshot("config");
});
