import type { ModelSplitEntry } from "#/db";
import { fmtModel } from "#/lib/formatters";
import { RankedBreakdown } from "./RankedBreakdown";

export function ModelSplitDonut({
	data,
	onSelect,
}: {
	data: ModelSplitEntry[];
	onSelect?: (model: string) => void;
}) {
	const rows = data.map((d) => ({
		key: d.model,
		label: fmtModel(d.model),
		value: d.count,
	}));
	const total = rows.reduce((sum, row) => sum + row.value, 0);

	return (
		<RankedBreakdown
			title="Model split"
			subtitle={`${total} sessions · ${data.length} models`}
			rows={rows}
			emptyMessage="No model metadata recorded"
			valueLabel={(value) => `${value} sessions`}
			onSelect={onSelect}
		/>
	);
}
