import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setDbForTest } from "./schema";
import {
	runPostUpgradeStorageMaintenance,
	sanitizeDurableToolResult,
} from "./storageMaintenance";

let database: Database;

beforeEach(() => {
	database = new Database(":memory:");
	setDbForTest(database);
});

afterEach(() => database.close());

describe("post-upgrade storage maintenance", () => {
	it("compacts duplicate Codex history and embedded tool images idempotently", async () => {
		database.run(
			`INSERT INTO sessions (id, label, started_at) VALUES ('s1', 'storage', 1)`,
		);
		database.run(
			`INSERT INTO provider_history_transcripts
			 (provider_id, native_session_id, subpath, source_path, source_hash,
			  payload_json, entry_count)
			 VALUES
			 ('codex', 'codex-1', '', 'rollout.jsonl', 'hash-1', ?, 1),
			 ('claude', 'claude-1', '', 'session.jsonl', 'hash-2', ?, 1)`,
			[JSON.stringify([{ codex: "x".repeat(1000) }]), '[{"claude":true}]'],
		);
		const embedded = JSON.stringify({
			contentItems: [
				{ type: "inputText", text: "capture" },
				{
					type: "inputImage",
					imageUrl: `data:image/png;base64,${"A".repeat(1000)}`,
				},
			],
		});
		database.run(
			`INSERT INTO tool_events
			 (session_id, assistant_seq, tool_id, name, input_json, result_text)
			 VALUES ('s1', 1, 'capture-1', 'capture_project_preview', '{}', ?)`,
			[embedded],
		);

		const result = await runPostUpgradeStorageMaintenance();

		expect(result).toEqual({
			codexTranscriptsCompacted: 1,
			toolImagesSanitized: 1,
			toolSummariesBackfilled: 0,
			managedImagesProcessed: 0,
			managedImageBytesSaved: 0,
		});
		expect(
			database
				.query<{ payload_json: string }, []>(
					"SELECT payload_json FROM provider_history_transcripts WHERE provider_id = 'codex'",
				)
				.get()?.payload_json,
		).toBe("[]");
		expect(
			database
				.query<{ payload_json: string }, []>(
					"SELECT payload_json FROM provider_history_transcripts WHERE provider_id = 'claude'",
				)
				.get()?.payload_json,
		).toBe('[{"claude":true}]');
		const tool = database
			.query<
				{
					result_text: string;
					result_length: number;
					result_preview: string;
				},
				[]
			>(
				`SELECT result_text, result_length, result_preview
				 FROM tool_events WHERE tool_id = 'capture-1'`,
			)
			.get();
		expect(tool?.result_text).not.toContain("data:image/");
		expect(tool?.result_text).toContain("image omitted");
		expect(tool?.result_length).toBe(tool?.result_text.length);
		expect(tool?.result_preview).toBe(tool?.result_text.slice(0, 256));
		expect(await runPostUpgradeStorageMaintenance()).toEqual({
			codexTranscriptsCompacted: 0,
			toolImagesSanitized: 0,
			toolSummariesBackfilled: 0,
			managedImagesProcessed: 0,
			managedImageBytesSaved: 0,
		});
	});

	it("backfills summary columns for ordinary historical tool results", async () => {
		database.run(
			`INSERT INTO sessions (id, label, started_at) VALUES ('s1', 'storage', 1)`,
		);
		database.run(
			`INSERT INTO tool_events
			 (session_id, assistant_seq, tool_id, name, input_json, result_text)
			 VALUES ('s1', 1, 'tool-1', 'Bash', '{}', ?)`,
			["x".repeat(500)],
		);

		const result = await runPostUpgradeStorageMaintenance();

		expect(result.toolSummariesBackfilled).toBe(1);
		expect(
			database
				.query<{ result_length: number; result_preview: string }, []>(
					`SELECT result_length, result_preview FROM tool_events WHERE tool_id = 'tool-1'`,
				)
				.get(),
		).toEqual({ result_length: 500, result_preview: "x".repeat(256) });
	});

	it("leaves non-image result text unchanged", () => {
		expect(sanitizeDurableToolResult('{"path":"capture.png"}')).toBe(
			'{"path":"capture.png"}',
		);
		expect(
			sanitizeDurableToolResult("AND instr(result_text, 'data:image/') > 0"),
		).toBe("AND instr(result_text, 'data:image/') > 0");
		expect(sanitizeDurableToolResult(String.raw`data:image\/[^\"']+`)).toBe(
			String.raw`data:image\/[^\"']+`,
		);
	});

	it("skips textual image references without stranding later maintenance", async () => {
		database.run(
			`INSERT INTO sessions (id, label, started_at) VALUES ('s1', 'storage', 1)`,
		);
		database.run(
			`INSERT INTO tool_events
			 (session_id, assistant_seq, tool_id, name, input_json, result_text)
			 VALUES
			 ('s1', 1, 'source-1', 'fileChange', '{}', ?),
			 ('s1', 2, 'capture-1', 'capture_project_preview', '{}', ?)`,
			[
				"AND instr(result_text, 'data:image/') > 0",
				'{"imageUrl":"data:image/png;base64,AQID"}',
			],
		);

		const result = await runPostUpgradeStorageMaintenance();

		expect(result.toolImagesSanitized).toBe(1);
		expect(result.toolSummariesBackfilled).toBe(1);
		expect(
			database
				.query<{ result_text: string }, []>(
					"SELECT result_text FROM tool_events WHERE tool_id = 'source-1'",
				)
				.get()?.result_text,
		).toBe("AND instr(result_text, 'data:image/') > 0");
		expect(
			database
				.query<{ result_text: string }, []>(
					"SELECT result_text FROM tool_events WHERE tool_id = 'capture-1'",
				)
				.get()?.result_text,
		).toContain("image omitted");
		expect(await runPostUpgradeStorageMaintenance()).toEqual({
			codexTranscriptsCompacted: 0,
			toolImagesSanitized: 0,
			toolSummariesBackfilled: 0,
			managedImagesProcessed: 0,
			managedImageBytesSaved: 0,
		});
	});
});
