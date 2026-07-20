import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type MaintenanceCliOptions = {
	dbPath: string;
	roots: Record<string, string[]>;
	manifestPath: string | null;
	backupDir: string | null;
	apply: boolean;
};

type ParseMaintenanceArgsOptions = {
	rootFlags: readonly string[];
	usage: () => never;
};

function argumentValue(
	argv: string[],
	index: number,
	usage: () => never,
): string {
	const value = argv[index];
	if (!value || value.startsWith("--")) usage();
	return value;
}

export function parseMaintenanceArgs(
	argv: string[],
	options: ParseMaintenanceArgsOptions,
): MaintenanceCliOptions {
	let dbPath = "";
	const roots = Object.fromEntries(
		options.rootFlags.map((flag) => [flag, [] as string[]]),
	);
	let manifestPath: string | null = null;
	let backupDir: string | null = null;
	let apply = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--db") {
			dbPath = argumentValue(argv, ++index, options.usage);
		} else if (options.rootFlags.includes(arg)) {
			roots[arg].push(resolve(argumentValue(argv, ++index, options.usage)));
		} else if (arg === "--manifest") {
			manifestPath = resolve(argumentValue(argv, ++index, options.usage));
		} else if (arg === "--backup-dir") {
			backupDir = resolve(argumentValue(argv, ++index, options.usage));
		} else if (arg === "--apply") {
			apply = true;
		} else {
			options.usage();
		}
	}
	if (!dbPath || Object.values(roots).every((values) => values.length === 0)) {
		options.usage();
	}
	return {
		dbPath: resolve(dbPath),
		roots,
		manifestPath,
		backupDir,
		apply,
	};
}

export function integrityCheck(db: Database): void {
	const rows = db
		.query<{ integrity_check: string }, []>("PRAGMA integrity_check")
		.all();
	if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
		throw new Error(`SQLite integrity check failed: ${JSON.stringify(rows)}`);
	}
}

export function timestampSlug(date = new Date()): string {
	return date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

export async function writeJsonManifest(
	manifest: unknown,
	path: string,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function createVerifiedBackup(
	db: Database,
	dbPath: string,
	backupDir: string,
	operationSlug: string,
): Promise<string> {
	await mkdir(backupDir, { recursive: true });
	const backupPath = join(
		backupDir,
		`${basename(dbPath, ".db")}-before-${operationSlug}-${timestampSlug()}.db`,
	);
	await Bun.write(backupPath, db.serialize());
	const backup = new Database(backupPath, { readonly: true });
	try {
		integrityCheck(backup);
	} finally {
		backup.close();
	}
	return backupPath;
}

export function openPlanningDatabase(dbPath: string): Database {
	const db = new Database(dbPath, { readonly: true });
	db.run("PRAGMA busy_timeout=5000");
	integrityCheck(db);
	return db;
}

export function openWritableDatabase(
	dbPath: string,
	options: { foreignKeys?: boolean } = {},
): Database {
	const db = new Database(dbPath);
	db.run("PRAGMA busy_timeout=5000");
	if (options.foreignKeys) db.run("PRAGMA foreign_keys=ON");
	integrityCheck(db);
	return db;
}

export async function prepareMaintenanceRun<TManifest>(args: {
	options: MaintenanceCliOptions;
	manifest: TManifest;
	operationSlug: string;
	summarize: (manifest: TManifest) => Record<string, unknown>;
	databaseOptions?: { foreignKeys?: boolean };
}): Promise<{ db: Database; manifestPath: string; backupPath: string }> {
	const { options, manifest, operationSlug } = args;
	const manifestPath =
		options.manifestPath ??
		join(
			options.backupDir ?? dirname(options.dbPath),
			`${operationSlug}-${timestampSlug()}.json`,
		);
	await writeJsonManifest(manifest, manifestPath);
	if (!options.apply) {
		console.log(
			prettyJson({
				mode: "dry-run",
				manifestPath,
				...args.summarize(manifest),
			}),
		);
		process.exit(0);
	}
	const db = openWritableDatabase(options.dbPath, args.databaseOptions);
	const backupPath = await createVerifiedBackup(
		db,
		options.dbPath,
		options.backupDir ?? join(dirname(options.dbPath), "backups"),
		operationSlug,
	);
	return { db, manifestPath, backupPath };
}

export function finalizeMaintenanceDatabase(db: Database): void {
	try {
		const foreignKeys = db.query("PRAGMA foreign_key_check").all();
		if (foreignKeys.length > 0) {
			throw new Error(
				`SQLite foreign-key check failed: ${JSON.stringify(foreignKeys)}`,
			);
		}
		integrityCheck(db);
		// Keep live maintenance non-disruptive while Hlid is still open.
		db.run("PRAGMA wal_checkpoint(PASSIVE)");
	} finally {
		db.close();
	}
}

export function countByReason(
	rows: Iterable<{ reason: string }>,
): Record<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
	}
	return Object.fromEntries([...counts].sort());
}

export function prettyJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
