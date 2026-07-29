// fallow-ignore-file unused-file
/** Shared helpers for Bun-runtime db tests (bun:sqlite). */
import { Database } from "bun:sqlite";
import { setDbForTest } from "./schema";

/** Fresh in-memory database registered as the active test db. */
export function freshDb(): Database {
	const db = new Database(":memory:");
	setDbForTest(db);
	return db;
}
