import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
} from "./usageMaintenanceCli";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hlid-maintenance-cli-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

function usage(): never {
	throw new Error("usage");
}

describe("usage maintenance CLI helpers", () => {
	test("parses common flags and repeated provider roots", () => {
		const options = parseMaintenanceArgs(
			[
				"--db",
				"data/hlid.db",
				"--codex-root",
				"codex/sessions",
				"--claude-root",
				"claude/projects",
				"--codex-root",
				"codex/archive",
				"--manifest",
				"reports/repair.json",
				"--backup-dir",
				"backups",
				"--apply",
			],
			{ rootFlags: ["--codex-root", "--claude-root"], usage },
		);

		expect(options).toEqual({
			dbPath: resolve("data/hlid.db"),
			roots: {
				"--codex-root": [resolve("codex/sessions"), resolve("codex/archive")],
				"--claude-root": [resolve("claude/projects")],
			},
			manifestPath: resolve("reports/repair.json"),
			backupDir: resolve("backups"),
			apply: true,
		});
	});

	test("accepts any configured root but rejects absent roots and bad values", () => {
		expect(
			parseMaintenanceArgs(["--db", "hlid.db", "--claude-root", "projects"], {
				rootFlags: ["--codex-root", "--claude-root"],
				usage,
			}).roots["--claude-root"],
		).toEqual([resolve("projects")]);
		expect(() =>
			parseMaintenanceArgs(["--db", "hlid.db"], {
				rootFlags: ["--codex-root"],
				usage,
			}),
		).toThrow("usage");
		expect(() =>
			parseMaintenanceArgs(["--db", "--apply", "--codex-root", "sessions"], {
				rootFlags: ["--codex-root"],
				usage,
			}),
		).toThrow("usage");
		expect(() =>
			parseMaintenanceArgs(
				["--db", "hlid.db", "--codex-root", "sessions", "--wat"],
				{ rootFlags: ["--codex-root"], usage },
			),
		).toThrow("usage");
	});

	test("writes stable JSON and counts sorted reasons", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "nested", "manifest.json");
		await writeJsonManifest({ ok: true }, path);

		expect(await readFile(path, "utf8")).toBe('{\n  "ok": true\n}\n');
		expect(
			countByReason([{ reason: "z" }, { reason: "a" }, { reason: "z" }]),
		).toEqual({ a: 1, z: 2 });
		expect(prettyJson({ ok: true })).toBe('{\n  "ok": true\n}');
		expect(timestampSlug(new Date("2026-07-17T12:34:56.789Z"))).toBe(
			"20260717T123456Z",
		);
	});

	test("creates an integrity-checked standalone backup", async () => {
		const directory = await temporaryDirectory();
		const dbPath = join(directory, "hlid.db");
		const db = new Database(dbPath);
		db.run("CREATE TABLE sample (value TEXT NOT NULL)");
		db.run("INSERT INTO sample (value) VALUES ('kept')");

		const backupPath = await createVerifiedBackup(
			db,
			dbPath,
			join(directory, "backups"),
			"usage-repair",
		);
		db.close();

		expect(backupPath).toMatch(/hlid-before-usage-repair-\d{8}T\d{6}Z\.db$/);
		const backup = new Database(backupPath, { readonly: true });
		expect(
			backup.query<{ value: string }, []>("SELECT value FROM sample").get(),
		).toEqual({ value: "kept" });
		backup.close();
	});

	test("opens planning and writable databases with expected safety settings", async () => {
		const directory = await temporaryDirectory();
		const dbPath = join(directory, "hlid.db");
		const seed = new Database(dbPath);
		seed.run("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
		seed.run("CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))");
		seed.close();

		const planning = openPlanningDatabase(dbPath);
		expect(() => planning.run("INSERT INTO parent (id) VALUES (1)")).toThrow();
		planning.close();

		const writable = openWritableDatabase(dbPath, { foreignKeys: true });
		expect(writable.query("PRAGMA foreign_keys").get()).toEqual({
			foreign_keys: 1,
		});
		finalizeMaintenanceDatabase(writable);
	});
});
