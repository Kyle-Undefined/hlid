import type { ModelSplitEntry } from "#/db";
import { fmtModel } from "#/lib/formatters";
import { BreakdownDonut } from "./BreakdownDonut";

export function ModelSplitDonut({ data }: { data: ModelSplitEntry[] }) {
	const rows = data.map((d) => ({
		key: d.model,
		label: fmtModel(d.model),
		value: d.count,
	}));
	const total = rows.reduce((sum, row) => sum + row.value, 0);

	return (
		<BreakdownDonut
			title="Model split"
			subtitle={`${total} sessions · ${data.length} models`}
			height={220}
			emptyMessage="No model metadata recorded"
			innerRadius="55%"
			rows={rows}
			formatTooltipValue={(value) => `${value} sessions`}
		/>
	);
}
