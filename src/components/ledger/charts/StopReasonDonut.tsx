import type { StopReasonEntry } from "#/db";
import { RankedBreakdown } from "./RankedBreakdown";

/** Format an Anthropic stop_reason for display by replacing underscores with spaces. */
function fmtReason(r: string): string {
	return r.replace(/_/g, " ");
}

export function StopReasonDonut({
	data,
	onSelect,
}: {
	data: StopReasonEntry[];
	onSelect?: (reason: string) => void;
}) {
	const rows = data.map((d) => ({
		key: d.reason,
		label: fmtReason(d.reason),
		value: d.count,
	}));
	const total = rows.reduce((sum, row) => sum + row.value, 0);

	return (
		<RankedBreakdown
			title="Stop reason"
			subtitle={`${total} queries`}
			rows={rows}
			emptyMessage="No stop reasons recorded"
			valueLabel={(value) => `${value} queries`}
			onSelect={onSelect}
		/>
	);
}
