import type { WeekdayHourBucket } from "#/db";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour));

function fmtHour(hour: number): string {
	if (hour === 0) return "12a";
	if (hour < 12) return `${hour}a`;
	if (hour === 12) return "12p";
	return `${hour - 12}p`;
}

export function HourOfDayChart({ data }: { data: WeekdayHourBucket[] }) {
	const counts = new Map(
		data.map((row) => [`${row.weekday}:${row.hour}`, row.count]),
	);
	const max = Math.max(1, ...data.map((row) => row.count));
	const total = data.reduce((sum, row) => sum + row.count, 0);
	const timezone =
		Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
	return (
		<div className="border border-border bg-card">
			<div className="border-b border-border px-4 py-3">
				<div className="flex items-baseline justify-between gap-3">
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Weekday × hour
					</div>
					<div className="text-[9px] tabular-nums text-muted-foreground/60">
						{total} queries
					</div>
				</div>
				<div className="mt-1 text-[9px] text-muted-foreground/50">
					Timezone: {timezone}
				</div>
			</div>
			{total === 0 ? (
				<div className="grid min-h-36 place-items-center text-[10px] tracking-widest text-muted-foreground/40 uppercase">
					No query timestamps recorded
				</div>
			) : (
				<div className="overflow-x-auto p-3">
					<div className="min-w-[34rem]">
						<div className="mb-1 grid grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-0.5">
							<span />
							{HOURS.map((hourKey) => {
								const hour = Number(hourKey);
								return (
									<span
										key={hourKey}
										className="text-center text-[7px] text-muted-foreground/40"
									>
										{hour % 3 === 0 ? fmtHour(hour) : ""}
									</span>
								);
							})}
						</div>
						{DAYS.map((day, weekday) => (
							<div
								key={day}
								className="mb-0.5 grid grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-0.5"
							>
								<span className="pr-1 text-right text-[8px] text-muted-foreground/60">
									{day}
								</span>
								{HOURS.map((hourKey) => {
									const hour = Number(hourKey);
									const count = counts.get(`${weekday}:${hour}`) ?? 0;
									return (
										<div
											key={hourKey}
											className="h-4 bg-[var(--data)]"
											style={{
												opacity:
													count === 0 ? 0.05 : 0.18 + (count / max) * 0.82,
											}}
											title={`${day} ${fmtHour(hour)} · ${count} queries`}
										/>
									);
								})}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
