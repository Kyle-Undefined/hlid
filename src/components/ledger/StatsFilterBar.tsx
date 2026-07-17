import { fmtModel } from "#/lib/formatters";
import type { LedgerAgentOption, LedgerStatsRange } from "#/lib/ledgerState";

export type StatsFilterState = {
	range: LedgerStatsRange;
	from: string;
	to: string;
	agent: string;
	provider: string;
	model: string;
};

type FilterPatch = Partial<StatsFilterState>;

const RANGE_OPTIONS = [
	{ value: "today", label: "Today" },
	{ value: "7d", label: "Last 7 days" },
	{ value: "30d", label: "Last 30 days" },
	{ value: "90d", label: "Last 90 days" },
	{ value: "all", label: "All time" },
	{ value: "custom", label: "Custom range" },
];

function localDateValue(now = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function rangePatch(
	range: LedgerStatsRange,
	filters: StatsFilterState,
): FilterPatch {
	if (range !== "custom") return { range };
	const today = localDateValue();
	return {
		range,
		from: filters.from || today,
		to: filters.to || today,
	};
}

function hasNonDefaultFilters(filters: StatsFilterState): boolean {
	return Boolean(
		filters.agent ||
			filters.provider ||
			filters.model ||
			filters.range !== "30d",
	);
}

function CustomDateRange({
	filters,
	onChange,
}: {
	filters: StatsFilterState;
	onChange: (patch: FilterPatch) => void;
}) {
	return (
		<div className="flex w-full gap-2 sm:w-auto">
			<DateFilterInput
				label="From"
				value={filters.from}
				max={filters.to || undefined}
				onChange={(from) =>
					onChange({
						from,
						to: filters.to && filters.to < from ? from : filters.to,
					})
				}
			/>
			<DateFilterInput
				label="To"
				value={filters.to}
				min={filters.from || undefined}
				onChange={(to) =>
					onChange({
						from: filters.from && filters.from > to ? to : filters.from,
						to,
					})
				}
			/>
		</div>
	);
}

function StatsDateRangeFilter({
	filters,
	onChange,
}: {
	filters: StatsFilterState;
	onChange: (patch: FilterPatch) => void;
}) {
	return (
		<>
			<FilterSelect
				label="Date range"
				value={filters.range}
				onChange={(value) =>
					onChange(rangePatch(value as LedgerStatsRange, filters))
				}
				options={RANGE_OPTIONS}
			/>
			{filters.range === "custom" && (
				<CustomDateRange filters={filters} onChange={onChange} />
			)}
		</>
	);
}

export function StatsFilterBar({
	filters,
	agentOptions,
	providers,
	models,
	onChange,
}: {
	filters: StatsFilterState;
	agentOptions: LedgerAgentOption[];
	providers: string[];
	models: string[];
	onChange: (patch: FilterPatch) => void;
}) {
	return (
		<div className="sticky top-0 z-20 flex flex-wrap items-end gap-2 border-b border-border bg-background/95 px-3 py-3 backdrop-blur sm:px-5">
			<StatsDateRangeFilter filters={filters} onChange={onChange} />
			<FilterSelect
				label="Agent"
				value={filters.agent}
				onChange={(agent) => onChange({ agent, model: "" })}
				options={[{ value: "", label: "All agents" }, ...agentOptions]}
			/>
			<FilterSelect
				label="Provider"
				value={filters.provider}
				onChange={(provider) => onChange({ provider })}
				options={[
					{ value: "", label: "All providers" },
					...providers.map((value) => ({ value, label: value })),
				]}
			/>
			<FilterSelect
				label="Model"
				value={filters.model}
				onChange={(model) => onChange({ model })}
				options={[
					{ value: "", label: "All models" },
					...models.map((value) => ({ value, label: fmtModel(value) })),
				]}
			/>
			{hasNonDefaultFilters(filters) && (
				<button
					type="button"
					onClick={() =>
						onChange({
							agent: "",
							provider: "",
							model: "",
							range: "30d",
							from: "",
							to: "",
						})
					}
					className="min-h-10 px-2 text-[9px] tracking-widest text-muted-foreground uppercase hover:text-foreground"
				>
					Reset
				</button>
			)}
		</div>
	);
}

function DateFilterInput({
	label,
	value,
	min,
	max,
	onChange,
}: {
	label: string;
	value: string;
	min?: string;
	max?: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="min-w-0 flex-1 sm:flex-none">
			<span className="mb-1 block text-[8px] tracking-widest text-muted-foreground uppercase">
				{label}
			</span>
			<input
				type="date"
				value={value}
				min={min}
				max={max}
				onChange={(event) => onChange(event.target.value)}
				className="min-h-10 w-full border border-border bg-background px-2 text-[10px] text-foreground sm:w-auto"
				aria-label={`${label} date`}
			/>
		</label>
	);
}

function FilterSelect({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
}) {
	return (
		<label className="min-w-[8rem] flex-1 sm:flex-none">
			<span className="mb-1 block text-[8px] tracking-widest text-muted-foreground uppercase">
				{label}
			</span>
			<select
				value={value}
				onChange={(event) => onChange(event.target.value)}
				className="min-h-10 w-full border border-border bg-background px-2 text-[10px] text-foreground sm:w-auto"
				aria-label={label}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	);
}
