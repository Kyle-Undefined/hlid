import {
	applyProviderHistoryImport,
	discoverClaudeHistoryRoots,
	discoverCodexHistoryRoots,
	historyTokenTotal,
	planProviderHistoryImport,
	type ProviderHistoryImportManifest,
} from "../src/db/providerHistoryImport";
import { initializeSchema } from "../src/db/schema";
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
			"  bun scripts/import-provider-history.ts --db <hlid.db>",
			"    [--codex-root <sessions-or-archive-dir> ...]",
			"    [--claude-root <projects-dir> ...]",
			"    [--discover-claude]",
			"    [--discover-codex]",
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

const rawArgs = process.argv.slice(2);
const discoverClaude = rawArgs.includes("--discover-claude");
const discoverCodex = rawArgs.includes("--discover-codex");
const discoveredRoots = discoverClaude ? await discoverClaudeHistoryRoots() : [];
const discoveredCodexRoots = discoverCodex
	? await discoverCodexHistoryRoots()
	: [];
const args = rawArgs.filter(
	(arg) => arg !== "--discover-claude" && arg !== "--discover-codex",
);
for (const root of discoveredRoots) args.push("--claude-root", root);
for (const root of discoveredCodexRoots) args.push("--codex-root", root);
const options = parseMaintenanceArgs(args, {
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

const { db, manifestPath, backupPath } = await prepareMaintenanceRun({
	options,
	manifest,
	operationSlug: "provider-history-import",
	summarize,
	databaseOptions: { foreignKeys: true },
});
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
