import {
	applyClaudeUsageRepair,
	claudeTokenTotal,
	planClaudeUsageRepair,
	type ClaudeUsageRepairManifest,
} from "../src/db/claudeUsageRepair";
import {
	countByReason,
	finalizeMaintenanceDatabase,
	openPlanningDatabase,
	parseMaintenanceArgs,
	prepareMaintenanceRun,
	prettyJson,
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

const { db, manifestPath, backupPath } = await prepareMaintenanceRun({
	options,
	manifest,
	operationSlug: "claude-usage-repair",
	summarize,
});
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
