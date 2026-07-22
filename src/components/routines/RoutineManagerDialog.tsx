import { Archive, FileText, History, Play, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialogFocus } from "#/hooks/useDialogFocus";
import type { CommandDescriptor } from "#/lib/commands";
import {
	defaultEffortFor,
	effortOptionsFor,
	modelOptions,
} from "#/lib/providerOptions";
import type { ProviderInfo } from "#/lib/providerTypes";
import { localTimeInTimezone } from "#/lib/routineSchedule";
import type {
	RoutineDefinition,
	RoutineDelivery,
	RoutineGrantCapability,
	RoutinePermissionGrantInput,
	RoutineSchedule,
	RoutineSummary,
} from "#/lib/routines";
import {
	archiveRoutineFn,
	createRoutineFn,
	getRoutineRunsFn,
	previewRoutineScheduleFn,
	runRoutineNowFn,
	setRoutineEnabledFn,
	updateRoutineFn,
} from "#/lib/serverFns/routines";
import {
	searchRelicReferencesFn,
	searchVaultReferencesFn,
} from "#/lib/serverFns/vaultReferences";
import type { Skill } from "#/lib/skills";
import {
	MAX_RELIC_REFERENCES,
	MAX_VAULT_REFERENCES,
	type RelicReferenceItem,
	type VaultReferenceItem,
} from "#/lib/vaultReferences";

export type RoutineTarget = {
	path: string;
	name: string;
	providerId: string;
	model: string;
	effort: string;
};

const CAPABILITIES: Array<{
	value: RoutineGrantCapability;
	label: string;
}> = [
	{ value: "fs.read", label: "Read files" },
	{ value: "fs.write", label: "Write files" },
	{ value: "shell.exec", label: "Run command" },
	{ value: "obsidian.call", label: "Obsidian tool" },
	{ value: "mcp.call", label: "MCP tool" },
	{ value: "hlid.call", label: "Hlid tool" },
	{ value: "tool.call", label: "Other exact tool" },
];

const WEEKDAYS = [
	[1, "Mon"],
	[2, "Tue"],
	[3, "Wed"],
	[4, "Thu"],
	[5, "Fri"],
	[6, "Sat"],
	[7, "Sun"],
] as const;

function formatTimestamp(value: number | null): string {
	if (value === null) return "not scheduled";
	return new Date(value * 1_000).toLocaleString();
}

function dateTimeLocal(iso: string): string {
	const date = new Date(iso);
	const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
	return local.toISOString().slice(0, 16);
}

function localToIso(value: string): string {
	return new Date(value).toISOString();
}

function scheduleLabel(schedule: RoutineSchedule, timezone: string): string {
	switch (schedule.kind) {
		case "once":
			return `Once, ${new Date(schedule.at).toLocaleString()}`;
		case "interval":
			return `Every ${schedule.everyMinutes} minutes`;
		case "daily":
			return `Daily at ${schedule.time} (${timezone})`;
		case "weekly":
			return `Weekly at ${schedule.time} (${timezone})`;
	}
}

function Toggle({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
}) {
	return (
		<label className="flex items-center gap-2 text-[10px] tracking-wider text-muted-foreground uppercase">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
			/>
			{label}
		</label>
	);
}

function ScheduleFields({
	definition,
	setDefinition,
}: {
	definition: RoutineDefinition;
	setDefinition: React.Dispatch<React.SetStateAction<RoutineDefinition>>;
}) {
	const schedule = definition.schedule;
	const changeKind = (kind: RoutineSchedule["kind"]) => {
		const now = new Date();
		const future = new Date(now.getTime() + 60 * 60_000);
		const time = localTimeInTimezone(definition.timezone, now.getTime());
		const next: RoutineSchedule =
			kind === "once"
				? { kind, at: future.toISOString() }
				: kind === "interval"
					? { kind, everyMinutes: 60, anchorAt: future.toISOString() }
					: kind === "daily"
						? { kind, time }
						: { kind, time, weekdays: [1] };
		setDefinition((current) => ({ ...current, schedule: next }));
	};
	return (
		<div className="grid gap-3 md:grid-cols-2">
			<label className="space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase">
				Schedule
				<select
					value={schedule.kind}
					onChange={(event) =>
						changeKind(event.target.value as RoutineSchedule["kind"])
					}
					className="mt-1 w-full border border-border bg-secondary px-2 py-2 text-xs text-foreground"
				>
					<option value="once">Once</option>
					<option value="interval">Interval</option>
					<option value="daily">Daily</option>
					<option value="weekly">Weekly</option>
				</select>
			</label>
			<label className="space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase">
				Timezone
				<input
					value={definition.timezone}
					onChange={(event) =>
						setDefinition((current) => ({
							...current,
							timezone: event.target.value,
						}))
					}
					className="mt-1 w-full border border-border bg-secondary px-2 py-2 text-xs text-foreground"
				/>
			</label>
			{schedule.kind === "once" && (
				<label className="space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase md:col-span-2">
					Run at
					<input
						type="datetime-local"
						value={dateTimeLocal(schedule.at)}
						onChange={(event) =>
							setDefinition((current) => ({
								...current,
								schedule: { kind: "once", at: localToIso(event.target.value) },
							}))
						}
						className="mt-1 w-full border border-border bg-secondary px-2 py-2 text-xs text-foreground"
					/>
				</label>
			)}
			{schedule.kind === "interval" && (
				<label className="space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase md:col-span-2">
					Every minutes
					<input
						type="number"
						min={1}
						value={schedule.everyMinutes}
						onChange={(event) =>
							setDefinition((current) => ({
								...current,
								schedule: {
									...schedule,
									everyMinutes: Math.max(1, Number(event.target.value)),
								},
							}))
						}
						className="mt-1 w-full border border-border bg-secondary px-2 py-2 text-xs text-foreground"
					/>
				</label>
			)}
			{(schedule.kind === "daily" || schedule.kind === "weekly") && (
				<label className="space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase">
					Local time
					<input
						type="time"
						value={schedule.time}
						onChange={(event) =>
							setDefinition((current) => ({
								...current,
								schedule: { ...schedule, time: event.target.value },
							}))
						}
						className="mt-1 w-full border border-border bg-secondary px-2 py-2 text-xs text-foreground"
					/>
				</label>
			)}
			{schedule.kind === "weekly" && (
				<div className="flex flex-wrap items-end gap-2 pb-2">
					{WEEKDAYS.map(([day, label]) => (
						<Toggle
							key={day}
							label={label}
							checked={schedule.weekdays.includes(day)}
							onChange={(checked) =>
								setDefinition((current) => ({
									...current,
									schedule: {
										...schedule,
										weekdays: checked
											? [...schedule.weekdays, day].sort()
											: schedule.weekdays.filter((value) => value !== day),
									},
								}))
							}
						/>
					))}
				</div>
			)}
			<div className="space-y-2 border-t border-border pt-3 md:col-span-2">
				<div className="flex flex-wrap gap-5">
					<Toggle
						label="Enabled"
						checked={definition.enabled}
						onChange={(enabled) =>
							setDefinition((current) => ({ ...current, enabled }))
						}
					/>
					<Toggle
						label="No overlap"
						checked={definition.noOverlap}
						onChange={(noOverlap) =>
							setDefinition((current) => ({ ...current, noOverlap }))
						}
					/>
				</div>
				<p className="text-[9px] text-muted-foreground">
					Enabled runs it automatically. No overlap skips a scheduled occurrence
					while the previous run is still active.
				</p>
			</div>
		</div>
	);
}

function GrantEditor({
	grants,
	onChange,
}: {
	grants: RoutinePermissionGrantInput[];
	onChange: (grants: RoutinePermissionGrantInput[]) => void;
}) {
	const update = (index: number, grant: RoutinePermissionGrantInput) =>
		onChange(
			grants.map((current, itemIndex) =>
				itemIndex === index ? grant : current,
			),
		);
	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<div>
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Preapproved actions
					</div>
					<p className="mt-1 text-[10px] text-muted-foreground/60">
						Exact grants are checked for every unattended tool call. Umbod must
						allow the action too.
					</p>
				</div>
				<button
					type="button"
					onClick={() =>
						onChange([...grants, { capability: "fs.read", pathPrefix: "" }])
					}
					className="border border-border px-2 py-1 text-[9px] tracking-widest uppercase hover:border-primary/50"
				>
					<Plus className="mr-1 inline h-3 w-3" /> Add
				</button>
			</div>
			{grants.map((grant, index) => (
				<div
					key={grant.id ?? `${grant.capability}-${index}`}
					className="grid gap-2 border border-border/70 bg-secondary/30 p-2 md:grid-cols-[160px_1fr_auto]"
				>
					<select
						value={grant.capability}
						onChange={(event) =>
							update(index, {
								capability: event.target.value as RoutineGrantCapability,
							})
						}
						className="border border-border bg-secondary px-2 py-1.5 text-xs"
					>
						{CAPABILITIES.map((item) => (
							<option key={item.value} value={item.value}>
								{item.label}
							</option>
						))}
					</select>
					{grant.capability === "shell.exec" ? (
						<input
							value={grant.command ?? ""}
							onChange={(event) =>
								update(index, { ...grant, command: event.target.value })
							}
							placeholder="Exact command"
							className="border border-border bg-secondary px-2 py-1.5 text-xs"
						/>
					) : grant.capability === "fs.read" ||
						grant.capability === "fs.write" ? (
						<input
							value={grant.pathPrefix ?? grant.path ?? ""}
							onChange={(event) =>
								update(index, {
									...grant,
									pathPrefix: event.target.value,
									path: undefined,
								})
							}
							placeholder="Approved path or directory"
							className="border border-border bg-secondary px-2 py-1.5 text-xs"
						/>
					) : (
						<input
							value={grant.tool ?? ""}
							onChange={(event) =>
								update(index, { ...grant, tool: event.target.value })
							}
							placeholder="Exact tool name"
							className="border border-border bg-secondary px-2 py-1.5 text-xs"
						/>
					)}
					<button
						type="button"
						onClick={() =>
							onChange(grants.filter((_, itemIndex) => itemIndex !== index))
						}
						aria-label="Remove grant"
						className="px-2 text-muted-foreground hover:text-destructive"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				</div>
			))}
		</div>
	);
}

function DeliveryEditor({
	deliveries,
	onChange,
}: {
	deliveries: RoutineDelivery[];
	onChange: (deliveries: RoutineDelivery[]) => void;
}) {
	const has = (kind: RoutineDelivery["kind"]) =>
		deliveries.some((item) => item.kind === kind);
	const toggle = (
		kind: "relic" | "daily_append" | "capture",
		checked: boolean,
	) =>
		onChange(
			checked
				? [...deliveries, { kind }]
				: deliveries.filter((item) => item.kind !== kind),
		);
	const note = deliveries.find(
		(item): item is Extract<RoutineDelivery, { kind: "note_append" }> =>
			item.kind === "note_append",
	);
	const setNotePath = (path: string) =>
		onChange(
			deliveries.map((item) =>
				item.kind === "note_append" ? { ...item, path } : item,
			),
		);
	return (
		<div className="space-y-2">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
				Delivery
			</div>
			<div className="flex flex-wrap gap-4">
				<Toggle
					label="Markdown Relic"
					checked={has("relic")}
					onChange={(checked) => toggle("relic", checked)}
				/>
				<Toggle
					label="Daily note"
					checked={has("daily_append")}
					onChange={(checked) => toggle("daily_append", checked)}
				/>
				<Toggle
					label="New inbox note"
					checked={has("capture")}
					onChange={(checked) => toggle("capture", checked)}
				/>
				<Toggle
					label="Exact vault note"
					checked={Boolean(note)}
					onChange={(checked) =>
						onChange(
							checked
								? [...deliveries, { kind: "note_append", path: "" }]
								: deliveries.filter((item) => item.kind !== "note_append"),
						)
					}
				/>
			</div>
			{note && <VaultNoteSelector value={note.path} onSelect={setNotePath} />}
		</div>
	);
}

function VaultNoteSelector({
	value,
	onSelect,
}: {
	value: string;
	onSelect: (path: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [items, setItems] = useState<VaultReferenceItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const requestId = useRef(0);
	useEffect(() => {
		if (!open) return;
		const currentRequest = ++requestId.current;
		setLoading(true);
		setError(null);
		const timer = window.setTimeout(
			() => {
				void searchVaultReferencesFn({
					data: { query: query.trim(), limit: 40, notesOnly: true },
				})
					.then((result) => {
						if (requestId.current === currentRequest) setItems(result.items);
					})
					.catch((cause) => {
						if (requestId.current !== currentRequest) return;
						setItems([]);
						setError(
							cause instanceof Error
								? cause.message
								: "Could not search the vault",
						);
					})
					.finally(() => {
						if (requestId.current === currentRequest) setLoading(false);
					});
			},
			query.trim() ? 120 : 0,
		);
		return () => {
			window.clearTimeout(timer);
			if (requestId.current === currentRequest) requestId.current++;
		};
	}, [open, query]);
	return (
		<div className="space-y-2">
			<div className="flex min-w-0 gap-2">
				<div
					className="min-w-0 flex-1 truncate border border-border bg-secondary px-2 py-2 font-mono text-xs text-foreground"
					title={value || undefined}
				>
					{value || "No vault note selected"}
				</div>
				<button
					type="button"
					onClick={() => setOpen((current) => !current)}
					aria-expanded={open}
					className="shrink-0 border border-border px-3 py-2 text-[9px] tracking-widest uppercase hover:border-primary/50"
				>
					{value ? "Change note" : "Choose note"}
				</button>
			</div>
			{open && (
				<div className="space-y-2 border border-border bg-secondary/20 p-2">
					<div className="flex gap-2">
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							aria-label="Search vault notes"
							placeholder="Search vault notes"
							className="min-w-0 flex-1 border border-border bg-secondary px-2 py-1.5 text-xs"
						/>
						<button
							type="button"
							onClick={() => setOpen(false)}
							aria-label="Close vault note selector"
							className="border border-border px-2 text-muted-foreground hover:text-foreground"
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</div>
					{error ? (
						<div className="text-[10px] text-destructive">{error}</div>
					) : loading ? (
						<div className="text-[10px] text-muted-foreground">
							Searching vault notes…
						</div>
					) : items.length === 0 ? (
						<div className="text-[10px] text-muted-foreground">
							No matching vault notes.
						</div>
					) : (
						<div className="max-h-48 overflow-y-auto border border-border">
							{items.map((item) => (
								<button
									type="button"
									key={item.relativePath}
									onClick={() => {
										onSelect(item.relativePath);
										setOpen(false);
										setQuery("");
									}}
									aria-label={`Select ${item.relativePath}`}
									className="flex w-full min-w-0 items-center gap-2 border-b border-border px-2 py-2 text-left last:border-b-0 hover:bg-primary/5"
								>
									<FileText className="h-3.5 w-3.5 shrink-0 text-primary/60" />
									<span className="min-w-0 truncate font-mono text-[10px]">
										{item.relativePath}
									</span>
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function RoutineInputSelector({
	definition,
	setDefinition,
}: {
	definition: RoutineDefinition;
	setDefinition: React.Dispatch<React.SetStateAction<RoutineDefinition>>;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [vaultItems, setVaultItems] = useState<VaultReferenceItem[]>([]);
	const [relicItems, setRelicItems] = useState<RelicReferenceItem[]>([]);
	const [selectedRelics, setSelectedRelics] = useState<
		Record<string, RelicReferenceItem>
	>({});
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const requestId = useRef(0);

	useEffect(() => {
		if (definition.relicIds.length === 0) return;
		let current = true;
		void searchRelicReferencesFn({
			data: { ids: definition.relicIds, retainedOnly: true },
		})
			.then((result) => {
				if (!current) return;
				setSelectedRelics((known) => ({
					...known,
					...Object.fromEntries(result.items.map((item) => [item.id, item])),
				}));
			})
			.catch(() => undefined);
		return () => {
			current = false;
		};
	}, [definition.relicIds]);

	useEffect(() => {
		if (!open) return;
		const currentRequest = ++requestId.current;
		setLoading(true);
		setError(null);
		const timer = window.setTimeout(
			() => {
				void Promise.all([
					searchVaultReferencesFn({
						data: { query: query.trim(), limit: 32, notesOnly: true },
					}),
					searchRelicReferencesFn({
						data: { query: query.trim(), limit: 20, retainedOnly: true },
					}),
				])
					.then(([vaultResult, relicResult]) => {
						if (requestId.current !== currentRequest) return;
						const selectedPaths = new Set(definition.vaultReferences);
						const selectedIds = new Set(definition.relicIds);
						setVaultItems(
							vaultResult.items.filter(
								(item) => !selectedPaths.has(item.relativePath),
							),
						);
						setRelicItems(
							relicResult.items.filter((item) => !selectedIds.has(item.id)),
						);
					})
					.catch((cause) => {
						if (requestId.current !== currentRequest) return;
						setVaultItems([]);
						setRelicItems([]);
						setError(
							cause instanceof Error
								? cause.message
								: "Could not search inputs",
						);
					})
					.finally(() => {
						if (requestId.current === currentRequest) setLoading(false);
					});
			},
			query.trim() ? 120 : 0,
		);
		return () => {
			window.clearTimeout(timer);
			if (requestId.current === currentRequest) requestId.current++;
		};
	}, [definition.relicIds, definition.vaultReferences, open, query]);

	const addVault = (item: VaultReferenceItem) => {
		setDefinition((current) => ({
			...current,
			vaultReferences: [
				...new Set([...current.vaultReferences, item.relativePath]),
			].slice(0, MAX_VAULT_REFERENCES),
		}));
	};
	const addRelic = (item: RelicReferenceItem) => {
		setSelectedRelics((current) => ({ ...current, [item.id]: item }));
		setDefinition((current) => ({
			...current,
			relicIds: [...new Set([...current.relicIds, item.id])].slice(
				0,
				MAX_RELIC_REFERENCES,
			),
		}));
	};
	const selectedCount =
		definition.vaultReferences.length + definition.relicIds.length;
	return (
		<div className="space-y-2">
			<div className="flex items-end justify-between gap-3">
				<div>
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Inputs
					</div>
					<p className="mt-1 text-[9px] text-muted-foreground">
						Exact vault notes are read through Obsidian. Retained Relics are
						attached to every run.
					</p>
				</div>
				<button
					type="button"
					onClick={() => setOpen((current) => !current)}
					aria-expanded={open}
					className="shrink-0 border border-border px-3 py-2 text-[9px] tracking-widest uppercase hover:border-primary/50"
				>
					{open ? "Close inputs" : "Add inputs"}
				</button>
			</div>
			{selectedCount > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{definition.vaultReferences.map((path) => (
						<div
							key={`vault:${path}`}
							className="flex min-w-0 max-w-full items-center gap-1.5 border border-primary/25 bg-primary/5 px-2 py-1"
						>
							<FileText className="h-3 w-3 shrink-0 text-primary/60" />
							<span className="max-w-72 truncate font-mono text-[9px]">
								{path}
							</span>
							<button
								type="button"
								onClick={() =>
									setDefinition((current) => ({
										...current,
										vaultReferences: current.vaultReferences.filter(
											(item) => item !== path,
										),
									}))
								}
								aria-label={`Remove vault input ${path}`}
							>
								<X className="h-3 w-3" />
							</button>
						</div>
					))}
					{definition.relicIds.map((id) => (
						<div
							key={`relic:${id}`}
							className="flex min-w-0 max-w-full items-center gap-1.5 border border-amber-500/30 bg-amber-500/5 px-2 py-1"
						>
							<Archive className="h-3 w-3 shrink-0 text-amber-500/70" />
							<span className="max-w-72 truncate font-mono text-[9px]">
								{selectedRelics[id]?.filename ?? `Relic ${id.slice(0, 8)}`}
							</span>
							<button
								type="button"
								onClick={() =>
									setDefinition((current) => ({
										...current,
										relicIds: current.relicIds.filter((item) => item !== id),
									}))
								}
								aria-label={`Remove Relic input ${selectedRelics[id]?.filename ?? id}`}
							>
								<X className="h-3 w-3" />
							</button>
						</div>
					))}
				</div>
			)}
			{open && (
				<div className="space-y-2 border border-border bg-secondary/20 p-2">
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						aria-label="Search Routine inputs"
						placeholder="Search vault notes and retained Relics"
						className="w-full border border-border bg-secondary px-2 py-1.5 text-xs"
					/>
					{error ? (
						<div className="text-[10px] text-destructive">{error}</div>
					) : loading ? (
						<div className="text-[10px] text-muted-foreground">
							Searching inputs…
						</div>
					) : vaultItems.length === 0 && relicItems.length === 0 ? (
						<div className="text-[10px] text-muted-foreground">
							No matching inputs.
						</div>
					) : (
						<div className="max-h-56 overflow-y-auto border border-border">
							{vaultItems.length > 0 && (
								<div className="border-b border-border bg-muted/20 px-2 py-1 text-[8px] tracking-widest text-muted-foreground uppercase">
									Vault
								</div>
							)}
							{vaultItems.map((item) => (
								<button
									type="button"
									key={`vault-result:${item.relativePath}`}
									onClick={() => addVault(item)}
									aria-label={`Add vault input ${item.relativePath}`}
									className="flex w-full items-center gap-2 border-b border-border px-2 py-2 text-left hover:bg-primary/5"
								>
									<FileText className="h-3.5 w-3.5 shrink-0 text-primary/60" />
									<span className="min-w-0 truncate font-mono text-[10px]">
										{item.relativePath}
									</span>
								</button>
							))}
							{relicItems.length > 0 && (
								<div className="border-b border-border bg-muted/20 px-2 py-1 text-[8px] tracking-widest text-muted-foreground uppercase">
									Retained Relics
								</div>
							)}
							{relicItems.map((item) => (
								<button
									type="button"
									key={`relic-result:${item.id}`}
									onClick={() => addRelic(item)}
									aria-label={`Add Relic input ${item.filename}`}
									className="flex w-full items-center gap-2 border-b border-border px-2 py-2 text-left hover:bg-amber-500/5"
								>
									<Archive className="h-3.5 w-3.5 shrink-0 text-amber-500/70" />
									<span className="min-w-0">
										<span className="block truncate font-mono text-[10px]">
											{item.filename}
										</span>
										<span className="block truncate text-[8px] text-muted-foreground">
											{item.mime}
										</span>
									</span>
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function RoutineSkillSelector({
	skills,
	commands,
	definition,
	setDefinition,
}: {
	skills: Skill[];
	commands: CommandDescriptor[];
	definition: RoutineDefinition;
	setDefinition: React.Dispatch<React.SetStateAction<RoutineDefinition>>;
}) {
	const [query, setQuery] = useState("");
	const normalizedQuery = query.trim().toLowerCase();
	const availableSkills = [...skills];
	for (const command of commands) {
		if (
			command.execution.kind !== "prompt" ||
			command.source !== "provider" ||
			!command.providerId ||
			availableSkills.some(
				(skill) =>
					skill.providerId === command.providerId &&
					skill.name === command.name,
			)
		) {
			continue;
		}
		availableSkills.push({
			file: `provider:${command.id}`,
			filePath: `provider:${command.id}`,
			name: command.name,
			description: command.description,
			content: "",
			providerId: command.providerId,
			source: "provider",
		});
	}
	const compatible = availableSkills
		.filter(
			(skill) =>
				!skill.providerId || skill.providerId === definition.providerId,
		)
		.filter(
			(skill) =>
				!normalizedQuery ||
				skill.name.toLowerCase().includes(normalizedQuery) ||
				skill.description.toLowerCase().includes(normalizedQuery),
		)
		.sort((left, right) => {
			const sourceRank = (skill: Skill) => {
				if (skill.providerId) return 2;
				return skill.source === "hlid" ? 1 : 0;
			};
			return (
				sourceRank(left) - sourceRank(right) ||
				left.name.localeCompare(right.name)
			);
		});
	const isSelected = (skill: Skill) =>
		skill.providerId
			? definition.providerCommands.includes(skill.name)
			: definition.skillContexts.includes(skill.filePath);
	const toggleSkill = (skill: Skill, checked: boolean) => {
		setDefinition((current) => {
			if (skill.providerId) {
				return {
					...current,
					providerCommands: checked
						? [...new Set([...current.providerCommands, skill.name])]
						: current.providerCommands.filter((name) => name !== skill.name),
				};
			}
			return {
				...current,
				skillContexts: checked
					? [...new Set([...current.skillContexts, skill.filePath])]
					: current.skillContexts.filter((path) => path !== skill.filePath),
			};
		});
	};
	const selectedCount =
		definition.skillContexts.length + definition.providerCommands.length;
	return (
		<div className="space-y-2">
			<div className="flex items-end justify-between gap-3">
				<div>
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Skills
					</div>
					<p className="mt-1 text-[9px] text-muted-foreground">
						Vault and Hlid skills are attached as context. Harness skills use
						the selected provider&apos;s native invocation.
					</p>
				</div>
				<span className="shrink-0 text-[9px] text-muted-foreground">
					{selectedCount} selected
				</span>
			</div>
			<input
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				aria-label="Search Routine skills"
				placeholder="Search available skills"
				className="w-full border border-border bg-secondary px-2 py-1.5 text-xs"
			/>
			<div className="max-h-52 overflow-y-auto border border-border">
				{compatible.length === 0 ? (
					<div className="p-3 text-[10px] text-muted-foreground">
						No compatible skills found.
					</div>
				) : (
					compatible.map((skill) => {
						const checked = isSelected(skill);
						const atLimit = skill.providerId
							? definition.providerCommands.length >= 16
							: definition.skillContexts.length >= 16;
						return (
							<label
								key={`${skill.providerId ?? "context"}:${skill.filePath}`}
								className="flex cursor-pointer items-start gap-2 border-b border-border px-2 py-2 last:border-b-0 hover:bg-primary/5"
							>
								<input
									type="checkbox"
									checked={checked}
									disabled={!checked && atLimit}
									onChange={(event) => toggleSkill(skill, event.target.checked)}
									className="mt-0.5"
								/>
								<span className="min-w-0">
									<span className="block text-[10px] font-medium">
										{skill.name}
										<span className="ml-2 text-[8px] tracking-wider text-muted-foreground uppercase">
											{skill.providerId
												? `${skill.providerId} native`
												: skill.source === "hlid"
													? "Hlid"
													: "Vault"}
										</span>
									</span>
									{skill.description && (
										<span className="mt-0.5 block text-[9px] text-muted-foreground">
											{skill.description}
										</span>
									)}
								</span>
							</label>
						);
					})
				)}
			</div>
			<p className="text-[9px] text-muted-foreground">
				You can still type a native <code>/command</code> directly in the prompt
				when the harness exposes one that Hlid cannot discover ahead of time.
			</p>
		</div>
	);
}

function RoutineIdentityFields({
	definition,
	setDefinition,
	targets,
	providers,
}: {
	definition: RoutineDefinition;
	setDefinition: React.Dispatch<React.SetStateAction<RoutineDefinition>>;
	targets: RoutineTarget[];
	providers: ProviderInfo[];
}) {
	const activeProvider = providers.find(
		(provider) => provider.id === definition.providerId,
	);
	const models = modelOptions(activeProvider);
	const efforts = effortOptionsFor(activeProvider, definition.model);
	const providerChoices = useMemo(() => {
		const choices = [...providers];
		for (const target of targets) {
			if (!choices.some((provider) => provider.id === target.providerId)) {
				choices.push({
					id: target.providerId,
					label: target.providerId,
					available: true,
				});
			}
		}
		if (!choices.some((provider) => provider.id === definition.providerId)) {
			choices.push({
				id: definition.providerId,
				label: definition.providerId,
				available: true,
			});
		}
		return choices;
	}, [definition.providerId, providers, targets]);
	const changeProvider = (providerId: string) => {
		const provider = providers.find((candidate) => candidate.id === providerId);
		const nextModels = modelOptions(provider);
		const model =
			nextModels.find((candidate) => candidate.isDefault)?.value ??
			nextModels[0]?.value ??
			"";
		const nextEfforts = effortOptionsFor(provider, model);
		const effort =
			defaultEffortFor(provider, model) ?? nextEfforts[0]?.value ?? "";
		setDefinition((current) => ({
			...current,
			providerId,
			model,
			effort,
			providerCommands:
				current.providerId === providerId ? current.providerCommands : [],
		}));
	};
	const changeTarget = (path: string) => {
		const target = targets.find((candidate) => candidate.path === path);
		if (!target) return;
		setDefinition((current) => ({
			...current,
			agentCwd: target.path,
			agentName: target.name,
			providerId: target.providerId,
			model: target.model,
			effort: target.effort,
			providerCommands:
				current.providerId === target.providerId
					? current.providerCommands
					: [],
		}));
	};
	return (
		<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
			<label className="space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase">
				Workspace
				<select
					value={definition.agentCwd}
					onChange={(event) => changeTarget(event.target.value)}
					className="mt-1 w-full min-w-0 border border-border bg-secondary px-2 py-2 text-xs normal-case tracking-normal text-foreground"
				>
					{targets.map((target) => (
						<option key={target.path} value={target.path}>
							{target.name}
						</option>
					))}
				</select>
			</label>
			<label className="space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase">
				Harness
				<select
					value={definition.providerId}
					onChange={(event) => changeProvider(event.target.value)}
					className="mt-1 w-full min-w-0 border border-border bg-secondary px-2 py-2 text-xs normal-case tracking-normal text-foreground"
				>
					{providerChoices.map((provider) => (
						<option key={provider.id} value={provider.id}>
							{provider.label}
							{provider.available ? "" : " (unavailable)"}
						</option>
					))}
				</select>
			</label>
			<label
				htmlFor="routine-model"
				className="space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase"
			>
				Model
				{models.length > 0 ? (
					<select
						id="routine-model"
						value={definition.model}
						onChange={(event) => {
							const model = event.target.value;
							const nextEfforts = effortOptionsFor(activeProvider, model);
							setDefinition((current) => ({
								...current,
								model,
								effort: nextEfforts.some(
									(option) => option.value === current.effort,
								)
									? current.effort
									: (defaultEffortFor(activeProvider, model) ??
										nextEfforts[0]?.value ??
										""),
							}));
						}}
						className="mt-1 w-full min-w-0 border border-border bg-secondary px-2 py-2 text-xs normal-case tracking-normal text-foreground"
					>
						<option value="">Provider default</option>
						{definition.model &&
							!models.some((model) => model.value === definition.model) && (
								<option value={definition.model}>{definition.model}</option>
							)}
						{models.map((model) => (
							<option key={model.value} value={model.value}>
								{model.label}
								{model.isDefault ? " (default)" : ""}
							</option>
						))}
					</select>
				) : (
					<input
						id="routine-model"
						value={definition.model}
						onChange={(event) =>
							setDefinition((current) => ({
								...current,
								model: event.target.value,
							}))
						}
						placeholder="Provider default"
						className="mt-1 w-full min-w-0 border border-border bg-secondary px-2 py-2 text-xs normal-case tracking-normal text-foreground"
					/>
				)}
			</label>
			<label
				htmlFor="routine-effort"
				className="space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase"
			>
				Effort
				{efforts.length > 0 ? (
					<select
						id="routine-effort"
						value={definition.effort}
						onChange={(event) =>
							setDefinition((current) => ({
								...current,
								effort: event.target.value,
							}))
						}
						className="mt-1 w-full min-w-0 border border-border bg-secondary px-2 py-2 text-xs normal-case tracking-normal text-foreground"
					>
						<option value="">Provider default</option>
						{definition.effort &&
							!efforts.some((effort) => effort.value === definition.effort) && (
								<option value={definition.effort}>{definition.effort}</option>
							)}
						{efforts.map((effort) => (
							<option key={effort.value} value={effort.value}>
								{effort.label}
								{effort.isDefault ? " (default)" : ""}
							</option>
						))}
					</select>
				) : (
					<input
						id="routine-effort"
						value={definition.effort}
						onChange={(event) =>
							setDefinition((current) => ({
								...current,
								effort: event.target.value,
							}))
						}
						placeholder="Provider default"
						className="mt-1 w-full min-w-0 border border-border bg-secondary px-2 py-2 text-xs normal-case tracking-normal text-foreground"
					/>
				)}
			</label>
			<div className="text-[10px] text-muted-foreground sm:col-span-2 lg:col-span-4">
				{definition.agentCwd}
				{activeProvider?.available === false && activeProvider.unavailableReason
					? ` · ${activeProvider.unavailableReason}`
					: ""}
			</div>
		</div>
	);
}

function RoutineEditor({
	initial,
	id,
	targets,
	providers,
	skills,
	commands,
	onCancel,
	onSaved,
}: {
	initial: RoutineDefinition;
	id?: string;
	targets: RoutineTarget[];
	providers: ProviderInfo[];
	skills: Skill[];
	commands: CommandDescriptor[];
	onCancel: () => void;
	onSaved: () => Promise<void>;
}) {
	const [definition, setDefinition] = useState(initial);
	const [preview, setPreview] = useState<number[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fullAccessConfirmed, setFullAccessConfirmed] = useState(false);
	useEffect(() => {
		let current = true;
		void previewRoutineScheduleFn({
			data: { schedule: definition.schedule, timezone: definition.timezone },
		})
			.then((values) => {
				if (current) setPreview(values);
			})
			.catch(() => {
				if (current) setPreview([]);
			});
		return () => {
			current = false;
		};
	}, [definition.schedule, definition.timezone]);
	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			if (definition.permissionMode === "full_access" && !fullAccessConfirmed) {
				throw new Error("Confirm full unattended access before saving");
			}
			if (
				definition.permissionMode === "preapproved" &&
				definition.grants.length === 0
			) {
				throw new Error("Add at least one exact grant, or choose read only");
			}
			if (id) await updateRoutineFn({ data: { id, definition } });
			else await createRoutineFn({ data: definition });
			await onSaved();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not save Routine",
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="space-y-5">
			<div className="grid gap-3">
				<label className="space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase">
					Name
					<input
						value={definition.name}
						onChange={(event) =>
							setDefinition((current) => ({
								...current,
								name: event.target.value,
							}))
						}
						className="mt-1 w-full border border-border bg-secondary px-2 py-2 text-xs normal-case tracking-normal text-foreground"
					/>
				</label>
			</div>
			<RoutineIdentityFields
				definition={definition}
				setDefinition={setDefinition}
				targets={targets}
				providers={providers}
			/>
			<label className="block space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase">
				Prompt
				<textarea
					rows={6}
					value={definition.prompt}
					onChange={(event) =>
						setDefinition((current) => ({
							...current,
							prompt: event.target.value,
						}))
					}
					className="mt-1 w-full resize-y border border-border bg-secondary px-2 py-2 text-xs normal-case tracking-normal text-foreground"
				/>
			</label>
			<RoutineSkillSelector
				skills={skills}
				commands={commands}
				definition={definition}
				setDefinition={setDefinition}
			/>
			<RoutineInputSelector
				definition={definition}
				setDefinition={setDefinition}
			/>
			<ScheduleFields definition={definition} setDefinition={setDefinition} />
			{preview.length > 0 && (
				<div className="text-[10px] text-muted-foreground">
					Next:{" "}
					{preview
						.map((value) => new Date(value * 1_000).toLocaleString())
						.join(" · ")}
				</div>
			)}
			<div className="max-w-md">
				<label className="space-y-1 text-[9px] tracking-widest text-muted-foreground uppercase">
					Unattended permissions
					<select
						value={definition.permissionMode}
						onChange={(event) =>
							setDefinition((current) => ({
								...current,
								permissionMode: event.target
									.value as RoutineDefinition["permissionMode"],
							}))
						}
						className="mt-1 w-full border border-border bg-secondary px-2 py-2 text-xs text-foreground"
					>
						<option value="read_only">Read only</option>
						<option value="preapproved">Exact preapprovals</option>
						<option value="full_access">Full access</option>
					</select>
				</label>
			</div>
			{definition.permissionMode === "full_access" && (
				<div className="space-y-3 border border-amber-500/40 bg-amber-500/5 p-3 text-[10px] text-amber-700 dark:text-amber-300">
					<p>
						Full access removes the Routine grant boundary. Umbod policy still
						applies and can block the run.
					</p>
					<Toggle
						label="I approve full unattended access for this Routine"
						checked={fullAccessConfirmed}
						onChange={setFullAccessConfirmed}
					/>
				</div>
			)}
			{definition.permissionMode === "preapproved" && (
				<GrantEditor
					grants={definition.grants}
					onChange={(grants) =>
						setDefinition((current) => ({ ...current, grants }))
					}
				/>
			)}
			<DeliveryEditor
				deliveries={definition.deliveries}
				onChange={(deliveries) =>
					setDefinition((current) => ({ ...current, deliveries }))
				}
			/>
			{error && (
				<div
					role="alert"
					className="border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
				>
					{error}
				</div>
			)}
			<div className="flex justify-end gap-2">
				<button
					type="button"
					onClick={onCancel}
					className="border border-border px-3 py-2 text-[10px] tracking-widest uppercase"
				>
					Cancel
				</button>
				<button
					type="button"
					disabled={
						busy ||
						!definition.name.trim() ||
						(!definition.prompt.trim() &&
							definition.skillContexts.length === 0 &&
							definition.providerCommands.length === 0)
					}
					onClick={() => void save()}
					className="bg-primary px-3 py-2 text-[10px] font-bold tracking-widest text-primary-foreground uppercase disabled:opacity-30"
				>
					{busy ? "Saving…" : id ? "Save changes" : "Create Routine"}
				</button>
			</div>
		</div>
	);
}

export function RoutineManagerDialog({
	routines,
	initialDefinition,
	watchDefinition,
	defaultDefinition,
	targets,
	providers,
	skills,
	commands,
	onClose,
	onRefresh,
}: {
	routines: RoutineSummary[];
	initialDefinition: RoutineDefinition | null;
	watchDefinition?: RoutineDefinition | null;
	defaultDefinition: RoutineDefinition;
	targets: RoutineTarget[];
	providers: ProviderInfo[];
	skills: Skill[];
	commands: CommandDescriptor[];
	onClose: () => void;
	onRefresh: () => Promise<void>;
}) {
	const [editing, setEditing] = useState<RoutineSummary | "new" | null>(
		initialDefinition ? "new" : null,
	);
	const [newDefinition, setNewDefinition] = useState<RoutineDefinition | null>(
		initialDefinition,
	);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [history, setHistory] = useState<
		Record<string, Awaited<ReturnType<typeof getRoutineRunsFn>>>
	>({});
	const close = useCallback(() => {
		if (editing) {
			setEditing(null);
			return;
		}
		onClose();
	}, [editing, onClose]);
	const { dialogRef, onDialogKeyDown } = useDialogFocus<HTMLDivElement>(close);
	const editDefinition = useMemo(() => {
		if (editing === "new") return newDefinition ?? defaultDefinition;
		if (!editing) return null;
		const {
			id: _id,
			revision: _revision,
			archived: _archived,
			nextRunAt: _nextRunAt,
			pausedReason: _pausedReason,
			authorizationFingerprint: _fingerprint,
			createdAt: _createdAt,
			updatedAt: _updatedAt,
			lastRun: _lastRun,
			...definition
		} = editing;
		return definition;
	}, [defaultDefinition, editing, newDefinition]);
	const act = async (id: string, action: () => Promise<unknown>) => {
		setBusyId(id);
		setError(null);
		try {
			await action();
			await onRefresh();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Routine action failed",
			);
		} finally {
			setBusyId(null);
		}
	};
	const toggleHistory = async (id: string) => {
		if (history[id]) {
			setHistory((current) => {
				const next = { ...current };
				delete next[id];
				return next;
			});
			return;
		}
		setBusyId(id);
		setError(null);
		try {
			const runs = await getRoutineRunsFn({ data: { id, limit: 10 } });
			setHistory((current) => ({ ...current, [id]: runs }));
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not load run history",
			);
		} finally {
			setBusyId(null);
		}
	};
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-2 backdrop-blur-sm md:p-6">
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="routine-dialog-title"
				tabIndex={-1}
				onKeyDown={onDialogKeyDown}
				className="flex max-h-full w-full max-w-4xl flex-col border border-border bg-card shadow-2xl"
			>
				<header className="flex items-center justify-between border-b border-border px-4 py-3">
					<div>
						<h2
							id="routine-dialog-title"
							className="text-sm font-semibold tracking-wider uppercase"
						>
							Routines
						</h2>
						<p className="mt-1 text-[10px] text-muted-foreground">
							Scheduled Claude, Codex, and ACP runs with frozen provider
							settings.
						</p>
					</div>
					<button
						type="button"
						onClick={close}
						aria-label={editing ? "Back to Routines" : "Close Routines"}
					>
						<X className="h-4 w-4" />
					</button>
				</header>
				<div className="overflow-y-auto p-4">
					{editDefinition ? (
						<RoutineEditor
							initial={editDefinition}
							id={editing === "new" ? undefined : editing?.id}
							targets={targets}
							providers={providers}
							skills={skills}
							commands={commands}
							onCancel={() => setEditing(null)}
							onSaved={async () => {
								setEditing(null);
								await onRefresh();
							}}
						/>
					) : (
						<div className="space-y-3">
							<div className="flex flex-wrap gap-2">
								<button
									type="button"
									onClick={() => {
										setNewDefinition(defaultDefinition);
										setEditing("new");
									}}
									className="border border-primary/40 px-3 py-2 text-[10px] tracking-widest text-primary uppercase"
								>
									<Plus className="mr-1 inline h-3 w-3" /> New Routine
								</button>
								{watchDefinition && (
									<button
										type="button"
										onClick={() => {
											setNewDefinition(watchDefinition);
											setEditing("new");
										}}
										className="border border-border px-3 py-2 text-[10px] tracking-widest uppercase hover:border-primary/50"
									>
										New from Watch
									</button>
								)}
							</div>
							{routines.length === 0 ? (
								<div className="border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
									No Routines configured. Create one here or schedule the
									current Watch prompt.
								</div>
							) : (
								routines.map((routine) => (
									<article
										key={routine.id}
										className="border border-border p-3"
									>
										<div className="flex flex-wrap items-start justify-between gap-3">
											<div>
												<button
													type="button"
													onClick={() => setEditing(routine)}
													className="text-left text-sm font-medium hover:text-primary"
												>
													{routine.name}
												</button>
												<div className="mt-1 text-[10px] text-muted-foreground">
													{scheduleLabel(routine.schedule, routine.timezone)} ·{" "}
													{routine.providerId} · {routine.agentName}
												</div>
												<div className="mt-1 text-[10px] text-muted-foreground">
													Next: {formatTimestamp(routine.nextRunAt)}
													{routine.lastRun
														? ` · Last: ${routine.lastRun.status}`
														: ""}
												</div>
												{routine.pausedReason && (
													<div className="mt-2 text-[10px] text-amber-600">
														Paused: {routine.pausedReason}
													</div>
												)}
											</div>
											<div className="flex gap-2">
												<button
													type="button"
													disabled={busyId === routine.id}
													onClick={() => void toggleHistory(routine.id)}
													className="border border-border p-2 hover:border-primary/50"
													title="Run history"
												>
													<History className="h-3.5 w-3.5" />
												</button>
												<button
													type="button"
													disabled={busyId === routine.id}
													onClick={() =>
														void act(routine.id, () =>
															runRoutineNowFn({ data: routine.id }),
														)
													}
													className="border border-border p-2 hover:border-primary/50"
													title="Run now"
												>
													<Play className="h-3.5 w-3.5" />
												</button>
												<button
													type="button"
													disabled={busyId === routine.id}
													onClick={() =>
														void act(routine.id, () =>
															setRoutineEnabledFn({
																data: {
																	id: routine.id,
																	enabled: !routine.enabled,
																},
															}),
														)
													}
													className={`border px-2 py-1 text-[9px] tracking-widest uppercase ${routine.enabled ? "border-primary/50 text-primary" : "border-border text-muted-foreground"}`}
												>
													{routine.enabled ? "Enabled" : "Paused"}
												</button>
												<button
													type="button"
													disabled={busyId === routine.id}
													onClick={() =>
														void act(routine.id, () =>
															archiveRoutineFn({ data: routine.id }),
														)
													}
													className="border border-border p-2 text-muted-foreground hover:text-destructive"
													title="Archive"
												>
													<Archive className="h-3.5 w-3.5" />
												</button>
											</div>
										</div>
										{history[routine.id] && (
											<div className="mt-3 space-y-1 border-t border-border/60 pt-3">
												{history[routine.id].length === 0 ? (
													<div className="text-[10px] text-muted-foreground">
														No runs yet.
													</div>
												) : (
													history[routine.id].map((run) => (
														<div
															key={run.id}
															className="flex flex-wrap items-center justify-between gap-2 bg-secondary/30 px-2 py-1.5 text-[10px]"
														>
															<span>
																<strong className="font-medium text-foreground">
																	{run.status}
																</strong>{" "}
																·{" "}
																{new Date(
																	run.scheduled_for * 1_000,
																).toLocaleString()}{" "}
																· {run.trigger}
															</span>
															<span className="flex items-center gap-2">
																{run.action_required || run.error ? (
																	<span className="max-w-md text-amber-600">
																		{run.action_required ?? run.error}
																	</span>
																) : null}
																{run.session_id && (
																	<a
																		href={`/raven?session=${encodeURIComponent(run.session_id)}`}
																		className="text-primary hover:underline"
																	>
																		Open Raven
																	</a>
																)}
															</span>
														</div>
													))
												)}
											</div>
										)}
									</article>
								))
							)}
							{error && (
								<div
									role="alert"
									className="border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
								>
									{error}
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
