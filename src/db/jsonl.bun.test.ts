import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asJsonObject, readJsonlObjects } from "./jsonl";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("JSONL reader", () => {
	test("preserves source text while ignoring blank and malformed lines", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hlid-jsonl-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "transcript.jsonl");
		const text = '{"id":1}\n\n42\n{"id":2}\n{"partial":';
		await Bun.write(path, text);

		expect(await readJsonlObjects(path)).toEqual({
			text,
			records: [{ id: 1 }, {}, { id: 2 }],
		});
	});

	test("normalizes non-object JSON values", () => {
		expect(asJsonObject(null)).toEqual({});
		expect(asJsonObject("value")).toEqual({});
		expect(asJsonObject({ ok: true })).toEqual({ ok: true });
	});
});
