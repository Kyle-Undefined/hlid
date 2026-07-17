export function asJsonObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

export async function readJsonlObjects(path: string): Promise<{
	records: Record<string, unknown>[];
	text: string;
}> {
	const text = await Bun.file(path).text();
	const records: Record<string, unknown>[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(asJsonObject(JSON.parse(line)));
		} catch {
			// Live provider transcripts can end with a partially written JSONL line.
			// Callers decide whether the remaining evidence is sufficient and safe.
		}
	}
	return { records, text };
}
