import { dirname, join } from "node:path";
import {
	applyProviderHistoryImport,
	historyTokenTotal,
	planProviderHistoryImport,
	type ProviderHistoryImportManifest,
} from "../src/db/providerHistoryImport";
import { initializeSchema } from "../src/db/schema";
import {
	countByReason,
	createVerifiedBackup,
	finalizeMaintenanceDatabase,
	openPlanningDatabase,
	openWritableDatabase,
	parseMaintenanceArgs,
	prettyJson,
	timestampSlug,
	writeJsonManifest,
} from "../src/db/usageMaintenanceCli";

function usage(): never {
	throw new Error(
		[
			"Usage:",
			"  bun scripts/import-provider-history.ts --db <hlid.db>",
			"    [--codex-root <sessions-or-archive-dir> ...]",
			"    [--claude-root <projects-dir> ...]",
			"    [--manifest <report.json>] [--apply] [--backup-dir <dir>]",
			"",
			"At least one provider root is required. Dry-run is the default.",
			"--apply verifies every planned source hash and a standalone SQLite",
			"backup before importing any rows.",
		].join("\n"),
	);
}

function summarize(manifest: ProviderHistoryImportManifest): Record<string, unknown> {
	const byProvider = Object.fromEntries(
		(["codex", "claude"] as const).map((providerId) => {
			const sessions = manifest.sessions.filter(
				(session) => session.providerId === providerId,
			);
			const queries = sessions.flatMap((session) => session.queries);
			return [
				providerId,
				{
					sessions: sessions.length,
					queries: queries.length,
					tokens: queries.reduce(
						(total, query) => total + historyTokenTotal(query.usage),
						0,
					),
				},
			];
		}),
	);
	return {
		version: manifest.version,
		scanned: manifest.scanned,
		plannedSessions: manifest.sessions.length,
		plannedQueries: manifest.totals.queries,
		plannedTokens: historyTokenTotal(manifest.totals),
		plannedTurns: manifest.totals.turns,
		byProvider,
		alreadyImported: manifest.alreadyImported,
		skipped: countByReason(manifest.skipped),
	};
}

const options = parseMaintenanceArgs(process.argv.slice(2), {
	rootFlags: ["--codex-root", "--claude-root"],
	usage,
});
const planningDb = openPlanningDatabase(options.dbPath);
const manifest = await planProviderHistoryImport({
	db: planningDb,
	codexRoots: options.roots["--codex-root"],
	claudeRoots: options.roots["--claude-root"],
	databasePath: options.dbPath,
});
planningDb.close();

const defaultManifestPath = join(
	options.backupDir ?? dirname(options.dbPath),
	`provider-history-import-${timestampSlug()}.json`,
);
const manifestPath = options.manifestPath ?? defaultManifestPath;
await writeJsonManifest(manifest, manifestPath);

if (!options.apply) {
	console.log(
		prettyJson({ mode: "dry-run", manifestPath, ...summarize(manifest) }),
	);
	process.exit(0);
}

const db = openWritableDatabase(options.dbPath, { foreignKeys: true });
const backupDir = options.backupDir ?? join(dirname(options.dbPath), "backups");
const backupPath = await createVerifiedBackup(
	db,
	options.dbPath,
	backupDir,
	"provider-history-import",
);
initializeSchema(db);
const result = await applyProviderHistoryImport(db, manifest);
finalizeMaintenanceDatabase(db);

console.log(
	prettyJson({
		mode: "applied",
		manifestPath,
		backupPath,
		...summarize(manifest),
		...result,
	}),
);
