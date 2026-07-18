import type { AutoSleepForm } from "#/lib/settingsForm";
import { Field, Section } from "./fields";

function NumberInput({
	value,
	onChange,
	min,
	max,
	unit,
	ariaLabel,
	disabled,
}: {
	value: string;
	onChange: (v: string) => void;
	min: number;
	max: number;
	unit: string;
	ariaLabel: string;
	disabled?: boolean;
}) {
	return (
		<label
			className={`flex items-center gap-2 ${disabled ? "opacity-50" : ""}`}
		>
			<input
				type="number"
				value={value}
				min={min}
				max={max}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
				aria-label={ariaLabel}
				className="w-20 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
			/>
			<span className="text-xs text-muted-foreground">{unit}</span>
		</label>
	);
}

export function AutoSleepSection({
	value,
	onChange,
}: {
	value: AutoSleepForm;
	onChange: (patch: Partial<AutoSleepForm>) => void;
}) {
	return (
		<Section
			title="Auto-sleep on usage limit"
			description="Pause running sessions when the preferred usage window fills up, then resume automatically after it resets. Hlid uses weekly usage when a five-hour window is unavailable."
		>
			<Field
				label="Auto-sleep"
				hint="a hard limit-reached signal always triggers a sleep while enabled"
			>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={value.enabled}
						onChange={(e) => onChange({ enabled: e.target.checked })}
						className="w-3.5 h-3.5 accent-primary"
					/>
					<span className="text-xs text-muted-foreground">enabled</span>
				</label>
			</Field>
			<Field
				label="Utilization threshold"
				hint="sleep near this much of the active budget; Hlid reserves up to 1% so an in-flight request does not overshoot the limit"
			>
				<NumberInput
					value={value.thresholdPercent}
					onChange={(thresholdPercent) => onChange({ thresholdPercent })}
					min={1}
					max={100}
					unit="%"
					ariaLabel="Auto-sleep utilization threshold percent"
					disabled={!value.enabled}
				/>
			</Field>
			<Field
				label="Maximum sleep"
				hint="past this cap the session proceeds anyway instead of waiting for the reset"
			>
				<NumberInput
					value={value.maxSleepMinutes}
					onChange={(maxSleepMinutes) => onChange({ maxSleepMinutes })}
					min={1}
					max={1440}
					unit="minutes"
					ariaLabel="Auto-sleep maximum sleep minutes"
					disabled={!value.enabled}
				/>
			</Field>
			<Field
				label="Resume buffer"
				hint="extra wait past the reset time to absorb clock skew"
			>
				<NumberInput
					value={value.resumeBufferSeconds}
					onChange={(resumeBufferSeconds) => onChange({ resumeBufferSeconds })}
					min={0}
					max={600}
					unit="seconds"
					ariaLabel="Auto-sleep resume buffer seconds"
					disabled={!value.enabled}
				/>
			</Field>
		</Section>
	);
}
