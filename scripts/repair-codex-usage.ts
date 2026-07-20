import {
	applyCodexUsageRepair,
	planCodexUsageRepair,
	tokenBucketTotal,
	type CodexUsageRepairManifest,
} from "../src/db/codexUsageRepair";
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
			"  bun scripts/repair-codex-usage.ts --db <hlid.db>",
			"    --rollout-root <sessions-dir> [--rollout-root <archive-dir> ...]",
			"    [--manifest <report.json>] [--apply] [--backup-dir <dir>]",
			"",
			"Dry-run is the default. --apply always creates and verifies a standalone",
			"SQLite backup before changing the database.",
		].join("\n"),
	);
}

function summarize(manifest: CodexUsageRepairManifest): Record<string, unknown> {
	return {
		version: manifest.version,
		scannedRollouts: manifest.scannedRollouts,
		repairableRows: manifest.rows.length,
		providerLabelCorrections: manifest.providerCorrections.length,
		unresolvedRows: manifest.unresolved.length,
		unresolvedByReason: countByReason(manifest.unresolved),
		coveredTokensBefore: tokenBucketTotal(manifest.totals.before),
		coveredTokensAfter: tokenBucketTotal(manifest.totals.after),
		delta: tokenBucketTotal(manifest.totals.after) - tokenBucketTotal(manifest.totals.before),
	};
}

const options = parseMaintenanceArgs(process.argv.slice(2), {
	rootFlags: ["--rollout-root"],
	usage,
});
const planningDb = openPlanningDatabase(options.dbPath);
const manifest = await planCodexUsageRepair({
	db: planningDb,
	rolloutRoots: options.roots["--rollout-root"],
	databasePath: options.dbPath,
});
planningDb.close();

const { db, manifestPath, backupPath } = await prepareMaintenanceRun({
	options,
	manifest,
	operationSlug: "codex-usage-repair",
	summarize,
});
const result = applyCodexUsageRepair(db, manifest);
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
