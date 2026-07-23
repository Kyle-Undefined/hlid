import { resolve } from "node:path";
import {
	applySessionCostDriftRepair,
	planSessionCostDriftRepair,
	type SessionCostDriftManifest,
} from "../src/db/sessionCostDriftRepair";
import {
	countByReason,
	finalizeMaintenanceDatabase,
	type MaintenanceCliOptions,
	openPlanningDatabase,
	prepareMaintenanceRun,
	prettyJson,
} from "../src/db/usageMaintenanceCli";

function usage(): never {
	throw new Error(
		[
			"Usage:",
			"  bun scripts/repair-session-cost-drift.ts --db <hlid.db>",
			"    [--manifest <report.json>] [--apply] [--backup-dir <dir>]",
			"",
			"Copies authoritative usage_queries cost/token values back onto stale",
			"queries rows and rebuilds session totals for sessions whose cached",
			"totals drifted from the immutable usage ledger.",
			"",
			"Dry-run is the default. --apply always creates and verifies a standalone",
			"SQLite backup before changing the database.",
		].join("\n"),
	);
}

function parseArgs(argv: string[]): MaintenanceCliOptions {
	let dbPath = "";
	let manifestPath: string | null = null;
	let backupDir: string | null = null;
	let apply = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = () => {
			const next = argv[++index];
			if (!next || next.startsWith("--")) usage();
			return next;
		};
		if (arg === "--db") dbPath = value();
		else if (arg === "--manifest") manifestPath = resolve(value());
		else if (arg === "--backup-dir") backupDir = resolve(value());
		else if (arg === "--apply") apply = true;
		else usage();
	}
	if (!dbPath) usage();
	return { dbPath: resolve(dbPath), roots: {}, manifestPath, backupDir, apply };
}

function summarize(manifest: SessionCostDriftManifest): Record<string, unknown> {
	return {
		version: manifest.version,
		driftedSessions: manifest.sessions.length,
		repairableRows: manifest.rows.length,
		totalDrift: manifest.sessions.reduce(
			(sum, session) => sum + session.driftBefore,
			0,
		),
		unresolvedSessions: manifest.unresolved.length,
		unresolvedByReason: countByReason(manifest.unresolved),
	};
}

const options = parseArgs(process.argv.slice(2));
const planningDb = openPlanningDatabase(options.dbPath);
const manifest = planSessionCostDriftRepair(planningDb, options.dbPath);
planningDb.close();

const { db, manifestPath, backupPath } = await prepareMaintenanceRun({
	options,
	manifest,
	operationSlug: "session-cost-drift-repair",
	summarize,
});
const result = applySessionCostDriftRepair(db, manifest);
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
