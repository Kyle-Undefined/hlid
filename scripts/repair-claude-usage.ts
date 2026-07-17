import { dirname, join } from "node:path";
import {
	applyClaudeUsageRepair,
	claudeTokenTotal,
	planClaudeUsageRepair,
	type ClaudeUsageRepairManifest,
} from "../src/db/claudeUsageRepair";
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
			"  bun scripts/repair-claude-usage.ts --db <hlid.db>",
			"    --transcript-root <claude-projects-dir>",
			"    [--transcript-root <archive-dir> ...]",
			"    [--manifest <report.json>] [--apply] [--backup-dir <dir>]",
			"",
			"Dry-run is the default. --apply always creates and verifies a standalone",
			"SQLite backup before changing the database.",
		].join("\n"),
	);
}

function summarize(manifest: ClaudeUsageRepairManifest): Record<string, unknown> {
	return {
		version: manifest.version,
		scannedRootTranscripts: manifest.scannedRootTranscripts,
		scannedChildTranscripts: manifest.scannedChildTranscripts,
		repairableRows: manifest.rows.length,
		unresolvedRows: manifest.unresolved.length,
		unresolvedByReason: countByReason(manifest.unresolved),
		coveredTokensBefore: claudeTokenTotal(manifest.totals.before),
		coveredTokensAfter: claudeTokenTotal(manifest.totals.after),
		delta:
			claudeTokenTotal(manifest.totals.after) -
			claudeTokenTotal(manifest.totals.before),
	};
}

const options = parseMaintenanceArgs(process.argv.slice(2), {
	rootFlags: ["--transcript-root"],
	usage,
});
const planningDb = openPlanningDatabase(options.dbPath);
const manifest = await planClaudeUsageRepair({
	db: planningDb,
	transcriptRoots: options.roots["--transcript-root"],
	databasePath: options.dbPath,
});
planningDb.close();

const defaultManifestPath = join(
	options.backupDir ?? dirname(options.dbPath),
	`claude-usage-repair-${timestampSlug()}.json`,
);
const manifestPath = options.manifestPath ?? defaultManifestPath;
await writeJsonManifest(manifest, manifestPath);

if (!options.apply) {
	console.log(
		prettyJson({ mode: "dry-run", manifestPath, ...summarize(manifest) }),
	);
	process.exit(0);
}

const db = openWritableDatabase(options.dbPath);
const backupDir = options.backupDir ?? join(dirname(options.dbPath), "backups");
const backupPath = await createVerifiedBackup(
	db,
	options.dbPath,
	backupDir,
	"claude-usage-repair",
);
const result = applyClaudeUsageRepair(db, manifest);
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
