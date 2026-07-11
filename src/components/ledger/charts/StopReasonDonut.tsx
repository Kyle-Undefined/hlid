import type { StopReasonEntry } from "#/db";
import { BreakdownDonut } from "./BreakdownDonut";

/** Format an Anthropic stop_reason for display by replacing underscores with spaces. */
function fmtReason(r: string): string {
	return r.replace(/_/g, " ");
}

export function StopReasonDonut({ data }: { data: StopReasonEntry[] }) {
	const rows = data.map((d) => ({
		key: d.reason,
		label: fmtReason(d.reason),
		value: d.count,
	}));
	const total = rows.reduce((sum, row) => sum + row.value, 0);

	return (
		<BreakdownDonut
			title="Stop reason"
			subtitle={`${total} queries`}
			height={200}
			emptyMessage="No completed queries yet"
			innerRadius="50%"
			rows={rows}
		/>
	);
}
