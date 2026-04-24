import { resolve } from "node:path";

const DB_PATH = resolve(process.cwd(), "hlid.db");

let _initPromise: Promise<import("bun:sqlite").Database> | null = null;

export function getDb(): Promise<import("bun:sqlite").Database> {
	if (!_initPromise) {
		_initPromise = (async () => {
			const { Database } = await import("bun:sqlite");
			const db = new Database(DB_PATH);
			db.run("PRAGMA journal_mode=WAL");
			initSchema(db);
			return db;
		})();
	}
	return _initPromise;
}

function initSchema(db: import("bun:sqlite").Database): void {
	db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
	db.run(`
    CREATE TABLE IF NOT EXISTS env_vars (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}
