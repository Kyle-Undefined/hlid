import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getDb } from "#/db";
import {
	applyProviderHistoryImport,
	discoverClaudeHistoryRoots,
	discoverCodexHistoryRoots,
	planProviderHistoryImport,
} from "#/db/providerHistoryImport";
import { APP_DIR, parseWslUnc } from "#/lib/paths";
import { runBoundedProcess } from "#/lib/process";
import { loadConfig } from "./config";
import { bumpDataRevision } from "./dataRevision";

const WSL_HISTORY_ROOT_TIMEOUT_MS = 4_000;
const WSL_HISTORY_ROOT_MARKER = "__HLID_PROVIDER_HISTORY_ROOT__";

export type ProviderHistorySyncOptions = {
	includeClaude?: boolean;
	includeCodex?: boolean;
};

export type ProviderHistorySyncResult = {
	roots: { claude: string[]; codex: string[] };
	plannedSessions: number;
	plannedQueries: number;
	createdSessions: number;
	insertedQueries: number;
	transcriptSessions: number;
	insertedMessages: number;
	alreadyImportedSessions: number;
	alreadyImportedQueries: number;
	skipped: Record<string, number>;
	backupPath: string | null;
};

export type ClaudeHistorySyncResult = ProviderHistorySyncResult;

export type ProviderHistorySyncJobStatus =
	| { state: "idle"; jobId: null }
	| { state: "running"; jobId: string; startedAt: number }
	| {
			state: "completed";
			jobId: string;
			startedAt: number;
			completedAt: number;
			result: ProviderHistorySyncResult;
	  }
	| {
			state: "failed";
			jobId: string;
			startedAt: number;
			completedAt: number;
			error: string;
	  };

let inFlight: Promise<ProviderHistorySyncResult> | null = null;
let currentJob: ProviderHistorySyncJobStatus = { state: "idle", jobId: null };

function configuredWslDistros(): string[] {
	if (process.platform !== "win32") return [];
	try {
		const config = loadConfig();
		return [
			...new Set(
				[config.vault.path, ...(config.agents ?? []).map((agent) => agent.path)]
					.map((path) => parseWslUnc(path)?.distro)
					.filter((distro): distro is string => distro != null),
			),
		];
	} catch {
		return [];
	}
}

async function discoverConfiguredWslRoots(
	relativePaths: string[],
): Promise<string[]> {
	const roots = await Promise.all(
		configuredWslDistros().flatMap((distro) =>
			relativePaths.map(async (relativePath) => {
				try {
					const result = await runBoundedProcess(
						"wsl.exe",
						[
							"-d",
							distro,
							"--",
							"sh",
							"-lc",
							`printf '${WSL_HISTORY_ROOT_MARKER}%s' "$HOME/${relativePath}"`,
						],
						{
							timeoutMs: WSL_HISTORY_ROOT_TIMEOUT_MS,
							timeoutError: `Provider history root probe timed out in ${distro}`,
						},
					);
					if (result.code !== 0) return null;
					const markerIndex = result.output.lastIndexOf(
						WSL_HISTORY_ROOT_MARKER,
					);
					if (markerIndex < 0) return null;
					const posixPath = result.output
						.slice(markerIndex + WSL_HISTORY_ROOT_MARKER.length)
						.trim();
					if (!posixPath.startsWith("/") || /[\r\n]/.test(posixPath))
						return null;
					const root = `\\\\wsl.localhost\\${distro}${posixPath.replaceAll("/", "\\")}`;
					return (await stat(root).catch(() => null))?.isDirectory()
						? root
						: null;
				} catch {
					return null;
				}
			}),
		),
	);
	return roots.filter((root): root is string => root != null);
}

function countByReason(
	rows: Iterable<{ reason: string }>,
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const row of rows) counts[row.reason] = (counts[row.reason] ?? 0) + 1;
	return counts;
}

async function createBackup(
	db: Awaited<ReturnType<typeof getDb>>,
	databasePath: string,
): Promise<string> {
	const { mkdir } = await import("node:fs/promises");
	const { basename, join } = await import("node:path");
	const backupDir = resolve(APP_DIR, "backups");
	await mkdir(backupDir, { recursive: true });
	const timestamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
	const backupPath = join(
		backupDir,
		`${basename(databasePath, ".db")}-before-provider-history-import-${timestamp}.db`,
	);
	await Bun.write(backupPath, db.serialize());
	const { Database } = await import("bun:sqlite");
	const backup = new Database(backupPath, { readonly: true });
	try {
		const rows = backup
			.query<{ integrity_check: string }, []>("PRAGMA integrity_check")
			.all();
		if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
			throw new Error("Provider history backup failed SQLite integrity check");
		}
	} finally {
		backup.close();
	}
	return backupPath;
}

async function runProviderHistorySync(
	options: ProviderHistorySyncOptions,
): Promise<ProviderHistorySyncResult> {
	const includeClaude = options.includeClaude ?? true;
	const includeCodex = options.includeCodex ?? true;
	const claudeRoots = includeClaude
		? [
				...new Set([
					...(await discoverClaudeHistoryRoots()),
					...(await discoverConfiguredWslRoots([".claude/projects"])),
				]),
			].sort((a, b) => a.localeCompare(b))
		: [];
	const codexRoots = includeCodex
		? [
				...new Set([
					...(await discoverCodexHistoryRoots()),
					...(await discoverConfiguredWslRoots([
						".codex/sessions",
						".codex/archived_sessions",
					])),
				]),
			].sort((a, b) => a.localeCompare(b))
		: [];
	const databasePath = resolve(APP_DIR, "hlid.db");
	const db = await getDb();
	const manifest = await planProviderHistoryImport({
		db,
		claudeRoots,
		codexRoots,
		databasePath,
	});
	const base = {
		roots: { claude: claudeRoots, codex: codexRoots },
		plannedSessions: manifest.sessions.length,
		plannedQueries: manifest.totals.queries,
		skipped: countByReason(manifest.skipped),
	};
	if (manifest.sessions.length === 0) {
		return {
			...base,
			createdSessions: 0,
			insertedQueries: 0,
			transcriptSessions: 0,
			insertedMessages: 0,
			alreadyImportedSessions: 0,
			alreadyImportedQueries: 0,
			backupPath: null,
		};
	}
	const backupPath = await createBackup(db, databasePath);
	const applied = await applyProviderHistoryImport(db, manifest);
	if (applied.insertedQueries > 0 || applied.insertedMessages > 0) {
		bumpDataRevision("stats", "sessions", "storage");
	}
	return {
		...base,
		...applied,
		backupPath,
	};
}

export function syncProviderHistory(
	options: ProviderHistorySyncOptions = {},
): Promise<ProviderHistorySyncResult> {
	if (inFlight) return inFlight;
	inFlight = runProviderHistorySync(options).finally(() => {
		inFlight = null;
	});
	return inFlight;
}

/** Start a long-running import without holding an HTTP connection open. */
export function startProviderHistorySync(
	options: ProviderHistorySyncOptions = {},
): ProviderHistorySyncJobStatus {
	if (currentJob.state === "running") return currentJob;

	const jobId = crypto.randomUUID();
	const startedAt = Date.now();
	currentJob = { state: "running", jobId, startedAt };
	void syncProviderHistory(options).then(
		(result) => {
			if (currentJob.jobId !== jobId) return;
			currentJob = {
				state: "completed",
				jobId,
				startedAt,
				completedAt: Date.now(),
				result,
			};
		},
		(error: unknown) => {
			if (currentJob.jobId !== jobId) return;
			currentJob = {
				state: "failed",
				jobId,
				startedAt,
				completedAt: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			};
		},
	);
	return currentJob;
}

export function getProviderHistorySyncStatus(
	jobId?: string,
): ProviderHistorySyncJobStatus {
	if (jobId && currentJob.jobId !== jobId) {
		return { state: "idle", jobId: null };
	}
	return currentJob;
}

/** Backward-compatible endpoint behavior for older clients. */
export function syncClaudeProviderHistory(): Promise<ClaudeHistorySyncResult> {
	return syncProviderHistory({
		includeClaude: true,
		includeCodex: false,
	});
}
