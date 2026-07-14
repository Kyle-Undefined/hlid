import type { SessionRow } from "#/db";

/** Ordered export columns — keep in sync with SessionRow. */
const COLUMNS = [
	"id",
	"label",
	"model",
	"started_at",
	"ended_at",
	"query_count",
	"total_cost",
	"total_estimated_cost",
	"unpriced_query_count",
	"total_input_tokens",
	"total_output_tokens",
	"total_cache_read_tokens",
	"total_cache_creation_tokens",
	"total_turns",
] as const satisfies readonly (keyof SessionRow)[];

function csvField(value: unknown): string {
	if (value == null) return "";
	const s = String(value);
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function sessionsToCsv(rows: SessionRow[]): string {
	const header = COLUMNS.join(",");
	const lines = rows.map((row) =>
		COLUMNS.map((col) => csvField(row[col])).join(","),
	);
	return [header, ...lines].join("\n");
}

export function buildSessionExport(
	rows: SessionRow[],
	format: "csv" | "json",
): { content: string; mime: string; filename: string } {
	const stamp = new Date().toISOString().slice(0, 10);
	if (format === "csv") {
		return {
			content: sessionsToCsv(rows),
			mime: "text/csv",
			filename: `hlid-sessions-${stamp}.csv`,
		};
	}
	return {
		content: JSON.stringify(rows, null, 2),
		mime: "application/json",
		filename: `hlid-sessions-${stamp}.json`,
	};
}

/** Trigger a browser download of in-memory content. */
export function downloadContent(
	content: string,
	mime: string,
	filename: string,
): void {
	const url = URL.createObjectURL(new Blob([content], { type: mime }));
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
