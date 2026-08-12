import { useEffect, useMemo, useRef, useState } from "react";
import {
	duplicateEffectiveNavigationLabelIds,
	hasForbiddenNavigationLabelCharacters,
	hasVisibleNavigationLabelCharacters,
	NAVIGATION_LABEL_MAX_GRAPHEMES,
	NAVIGATION_NAME_DEFINITIONS,
	type NavigationId,
	type NavigationNamesConfig,
	navigationLabelGraphemeCount,
	normalizeNavigationLabel,
	resolveNavigationLabels,
} from "#/lib/navigationNames";
import { normalizeSearchText } from "#/lib/search";
import { Section } from "./fields";

type NavigationNameDrafts = Partial<Record<NavigationId, string>>;

const PRESET_OPTIONS = [
	{
		value: "hlid" as const,
		label: "Hlið",
		description: "Hlið's native navigation names",
	},
	{
		value: "plain" as const,
		label: "Plain language",
		description: "Familiar names for finding each feature",
	},
];

const secondaryButtonClass =
	"min-h-9 border border-border px-2.5 py-1.5 text-[10px] tracking-wider text-muted-foreground uppercase transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";

function duplicateChangeMessage(config: NavigationNamesConfig): string | null {
	const duplicateIds = duplicateEffectiveNavigationLabelIds(config);
	if (duplicateIds.length === 0) return null;
	const labels = resolveNavigationLabels(config);
	const names = Array.from(new Set(duplicateIds.map((id) => labels[id]))).join(
		", ",
	);
	return `That change would use ${names} for more than one menu item. Change or clear the conflicting custom name first.`;
}

function draftsFromLabels(
	labels: NavigationNamesConfig["labels"],
): NavigationNameDrafts {
	return Object.fromEntries(
		NAVIGATION_NAME_DEFINITIONS.map(({ id }) => [id, labels[id] ?? ""]),
	) as NavigationNameDrafts;
}

function individualValidationMessage(raw: string): string | null {
	if (raw === "") return null;
	if (hasForbiddenNavigationLabelCharacters(raw)) {
		return "Remove control or direction-changing characters.";
	}
	const normalized = normalizeNavigationLabel(raw);
	if (!hasVisibleNavigationLabelCharacters(normalized)) {
		return "Enter a visible name, or clear the field to use the base name.";
	}
	const count = navigationLabelGraphemeCount(normalized);
	if (count > NAVIGATION_LABEL_MAX_GRAPHEMES) {
		return `${count} of ${NAVIGATION_LABEL_MAX_GRAPHEMES} characters. Shorten this name.`;
	}
	return null;
}

function draftConfig(
	config: NavigationNamesConfig,
	drafts: NavigationNameDrafts,
): NavigationNamesConfig {
	const labels = { ...config.labels };
	for (const { id } of NAVIGATION_NAME_DEFINITIONS) {
		const raw = drafts[id] ?? labels[id] ?? "";
		if (raw === "") {
			delete labels[id];
			continue;
		}
		if (individualValidationMessage(raw)) continue;
		labels[id] = normalizeNavigationLabel(raw);
	}
	return { ...config, labels };
}

export function NavigationNamesSection({
	value,
	onChange,
}: {
	value: NavigationNamesConfig;
	onChange: (next: NavigationNamesConfig) => void;
}) {
	const [drafts, setDrafts] = useState<NavigationNameDrafts>(() =>
		draftsFromLabels(value.labels),
	);
	const [changeError, setChangeError] = useState<string | null>(null);
	const latestValue = useRef(value);
	const previousLabels = useRef(value.labels);
	const editBaselines = useRef<
		Partial<Record<NavigationId, string | undefined>>
	>({});

	useEffect(() => {
		latestValue.current = value;
	}, [value]);
	useEffect(() => {
		const previous = previousLabels.current;
		setDrafts((existing) => {
			const next = { ...existing };
			for (const { id } of NAVIGATION_NAME_DEFINITIONS) {
				if ((existing[id] ?? "") === (previous[id] ?? "")) {
					next[id] = value.labels[id] ?? "";
				}
			}
			return next;
		});
		previousLabels.current = value.labels;
	}, [value.labels]);

	const previewConfig = useMemo(
		() => draftConfig(value, drafts),
		[value, drafts],
	);
	const effectiveLabels = useMemo(
		() => resolveNavigationLabels(previewConfig),
		[previewConfig],
	);
	const duplicateIds = useMemo(
		() => new Set(duplicateEffectiveNavigationLabelIds(previewConfig)),
		[previewConfig],
	);

	function emit(next: NavigationNamesConfig) {
		latestValue.current = next;
		onChange(next);
	}

	function clearOverride(id: NavigationId) {
		const current = latestValue.current;
		const labels = { ...current.labels };
		delete labels[id];
		setDrafts((existing) => ({ ...existing, [id]: "" }));
		delete editBaselines.current[id];
		setChangeError(null);
		emit({ ...current, labels });
	}

	function updateDraft(id: NavigationId, raw: string) {
		if (!Object.hasOwn(editBaselines.current, id)) {
			editBaselines.current[id] = latestValue.current.labels[id];
		}
		const nextDrafts = { ...drafts, [id]: raw };
		setDrafts(nextDrafts);
		if (individualValidationMessage(raw)) {
			restoreEditBaseline(id);
			return;
		}
		const current = latestValue.current;
		const allDrafts = draftConfig(current, nextDrafts);
		if (duplicateEffectiveNavigationLabelIds(allDrafts).length === 0) {
			for (const { id: draftId } of NAVIGATION_NAME_DEFINITIONS) {
				if (
					draftId !== id &&
					allDrafts.labels[draftId] !== current.labels[draftId]
				) {
					editBaselines.current[draftId] = allDrafts.labels[draftId];
				}
			}
			setChangeError(null);
			emit(allDrafts);
			return;
		}

		const labels = { ...current.labels };
		const normalized = normalizeNavigationLabel(raw);
		if (normalized === "") delete labels[id];
		else labels[id] = normalized;
		const changedDraft = { ...current, labels };
		if (duplicateEffectiveNavigationLabelIds(changedDraft).length > 0) {
			restoreEditBaseline(id);
			return;
		}
		setChangeError(null);
		emit(changedDraft);
	}

	function restoreEditBaseline(id: NavigationId) {
		if (!Object.hasOwn(editBaselines.current, id)) return;
		const current = latestValue.current;
		const labels = { ...current.labels };
		const baseline = editBaselines.current[id];
		if (baseline === undefined) delete labels[id];
		else labels[id] = baseline;
		if (labels[id] === current.labels[id]) return;
		const next = { ...current, labels };
		if (duplicateEffectiveNavigationLabelIds(next).length > 0) return;
		emit(next);
	}

	function cancelDraft(id: NavigationId) {
		if (!Object.hasOwn(editBaselines.current, id)) return;
		const baseline = editBaselines.current[id];
		const current = latestValue.current;
		const labels = { ...current.labels };
		if (baseline === undefined) delete labels[id];
		else labels[id] = baseline;
		const next = { ...current, labels };
		if (duplicateEffectiveNavigationLabelIds(next).length > 0) {
			const persisted = current.labels[id] ?? "";
			setDrafts((existing) => ({ ...existing, [id]: persisted }));
			delete editBaselines.current[id];
			return;
		}
		setDrafts((existing) => ({ ...existing, [id]: baseline ?? "" }));
		emit(next);
		delete editBaselines.current[id];
	}

	function commitDraft(id: NavigationId) {
		const raw = drafts[id] ?? "";
		if (individualValidationMessage(raw) || duplicateIds.has(id)) return;
		const normalized = normalizeNavigationLabel(raw);
		const current = latestValue.current;
		const labels = { ...current.labels };
		if (normalized === "") delete labels[id];
		else labels[id] = normalized;
		setDrafts((existing) => ({ ...existing, [id]: normalized }));
		setChangeError(null);
		emit({ ...current, labels });
		delete editBaselines.current[id];
	}

	function changePreset(preset: NavigationNamesConfig["preset"]) {
		const current = latestValue.current;
		const next = { ...current, preset };
		const error = duplicateChangeMessage(next);
		if (error) {
			setChangeError(error);
			return;
		}
		setChangeError(null);
		emit(next);
	}

	function clearCustomNames() {
		const current = latestValue.current;
		setDrafts(draftsFromLabels({}));
		editBaselines.current = {};
		setChangeError(null);
		emit({ ...current, labels: {} });
	}

	function restoreHlidNames() {
		const next: NavigationNamesConfig = { preset: "hlid", labels: {} };
		setDrafts(draftsFromLabels(next.labels));
		editBaselines.current = {};
		setChangeError(null);
		emit(next);
	}

	return (
		<Section
			title="Navigation names"
			id="forge-section-navigation-names"
			description="Choose the words shown in primary navigation. Routes and features do not change, and page terminology stays Hlið-native."
		>
			<div className="space-y-3 px-4 py-3">
				<div>
					<div
						id="navigation-name-preset-label"
						className="text-sm text-foreground"
					>
						Base names
					</div>
					<p className="mt-0.5 text-xs text-muted-foreground">
						Custom names take priority over this base. Switching bases keeps
						your custom names.
					</p>
				</div>
				<fieldset
					aria-labelledby="navigation-name-preset-label"
					aria-describedby={
						changeError ? "navigation-name-change-error" : undefined
					}
					className="grid grid-cols-1 gap-2 @lg:grid-cols-2"
				>
					{PRESET_OPTIONS.map((option) => (
						<button
							key={option.value}
							type="button"
							onClick={() => changePreset(option.value)}
							aria-pressed={value.preset === option.value}
							className={`flex flex-col gap-1 border p-3 text-left transition-colors ${
								value.preset === option.value
									? "border-primary bg-primary/5"
									: "border-border hover:bg-accent"
							}`}
						>
							<span className="text-sm font-medium text-foreground">
								{option.label}
							</span>
							<span className="text-xs text-muted-foreground">
								{option.description}
							</span>
						</button>
					))}
				</fieldset>
				{changeError && (
					<p
						id="navigation-name-change-error"
						role="alert"
						className="text-[10px] text-status-warning"
					>
						{changeError}
					</p>
				)}
			</div>

			{NAVIGATION_NAME_DEFINITIONS.map((definition) => {
				const raw = drafts[definition.id] ?? "";
				const individualError = individualValidationMessage(raw);
				const error =
					individualError ??
					(duplicateIds.has(definition.id)
						? "This name is already used by another navigation item."
						: null);
				const errorId = `navigation-name-${definition.id}-error`;
				const effectiveId = `navigation-name-${definition.id}-effective`;
				const baseName =
					value.preset === "plain"
						? definition.plainLabel
						: definition.hlidLabel;

				return (
					<div
						key={definition.id}
						data-forge-setting-label={normalizeSearchText(
							`${definition.hlidLabel} ${definition.plainLabel} navigation name`,
						)}
						tabIndex={-1}
						className="grid min-w-0 scroll-mt-4 gap-3 px-4 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @3xl:items-center @3xl:gap-6"
					>
						<div className="min-w-0">
							<div className="text-sm text-foreground">
								{definition.hlidLabel}
							</div>
							<div className="mt-0.5 break-words text-xs text-muted-foreground">
								{definition.meaning}
							</div>
							<div className="mt-1 text-[10px] text-muted-foreground/70">
								Hlið: {definition.hlidLabel} · Plain: {definition.plainLabel}
							</div>
						</div>
						<div className="min-w-0 space-y-1.5 @3xl:justify-self-end">
							<div className="flex min-w-0 flex-col gap-2 @sm:flex-row">
								<input
									type="text"
									value={raw}
									onChange={(event) =>
										updateDraft(definition.id, event.target.value)
									}
									onBlur={() => commitDraft(definition.id)}
									onKeyDown={(event) => {
										if (event.key === "Enter") event.currentTarget.blur();
										if (
											event.key === "Escape" &&
											Object.hasOwn(editBaselines.current, definition.id)
										) {
											cancelDraft(definition.id);
										}
									}}
									placeholder={`Base: ${baseName}`}
									aria-label={`${definition.hlidLabel} custom name`}
									aria-invalid={error ? true : undefined}
									aria-describedby={`${effectiveId}${error ? ` ${errorId}` : ""}`}
									className="min-h-10 min-w-0 flex-1 border border-border bg-input px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none @sm:w-52"
								/>
								<button
									type="button"
									onClick={() => clearOverride(definition.id)}
									aria-label={`Use base name for ${definition.hlidLabel}`}
									className={secondaryButtonClass}
								>
									Use base name
								</button>
							</div>
							<div
								id={effectiveId}
								data-testid={`navigation-effective-${definition.id}`}
								className="truncate text-[10px] text-muted-foreground"
								title={effectiveLabels[definition.id]}
							>
								Effective: {effectiveLabels[definition.id]}
							</div>
							{error && (
								<div
									id={errorId}
									role="alert"
									className="text-[10px] text-status-warning"
								>
									{error}
								</div>
							)}
						</div>
					</div>
				);
			})}

			<div className="space-y-3 px-4 py-3">
				<div className="flex flex-wrap gap-2">
					<button
						type="button"
						onClick={clearCustomNames}
						className={secondaryButtonClass}
					>
						Clear custom names
					</button>
					<button
						type="button"
						onClick={restoreHlidNames}
						className={secondaryButtonClass}
					>
						Restore Hlið names
					</button>
				</div>

				<div className="grid gap-3 border border-border bg-background/40 p-3 @xl:grid-cols-[11rem_minmax(0,1fr)]">
					<div className="min-w-0">
						<div className="mb-2 text-[9px] tracking-widest text-muted-foreground uppercase">
							Desktop preview
						</div>
						<div className="w-40 space-y-1 border border-sidebar-border bg-sidebar p-2">
							{NAVIGATION_NAME_DEFINITIONS.map(({ id }) => (
								<div
									key={id}
									className="truncate text-[10px] tracking-wider text-sidebar-foreground/70"
									title={effectiveLabels[id]}
								>
									{effectiveLabels[id]}
								</div>
							))}
						</div>
					</div>
					<div className="w-full max-w-sm min-w-0 self-end">
						<div className="mb-2 text-[9px] tracking-widest text-muted-foreground uppercase">
							Mobile preview
						</div>
						<div className="grid grid-cols-7 border border-sidebar-border bg-sidebar p-1">
							{NAVIGATION_NAME_DEFINITIONS.map(({ id }) => (
								<div
									key={id}
									className="min-w-0 truncate px-0.5 text-center text-[7px] tracking-tight text-sidebar-foreground/70"
									title={effectiveLabels[id]}
								>
									{effectiveLabels[id]}
								</div>
							))}
						</div>
					</div>
					<p className="text-[10px] text-muted-foreground @xl:col-span-2">
						Long names are shortened visually in navigation. Their full text
						remains available in tooltips and to assistive technology.
					</p>
				</div>
			</div>
		</Section>
	);
}
