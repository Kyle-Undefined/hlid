import {
	ArrowUpDown,
	Ellipsis,
	Search,
	SlidersHorizontal,
	X,
} from "lucide-react";
import type { ComponentType, CSSProperties, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionCleanupPreview } from "#/db";
import { useAnchoredPopover } from "#/hooks/useAnchoredPopover";
import { fmtBytes } from "#/lib/formatters";
import type { LedgerAgentOption, SessionSortKey } from "#/lib/ledgerState";

const CLEANUP_DAY_OPTIONS = [7, 30, 90] as const;

const SORT_LABELS: Record<SessionSortKey, string> = {
	recent: "recent",
	cost: "cost",
	tokens: "tokens",
};

export type SessionsLedgerFilterControls = {
	search: string;
	onSearchChange?: (query: string) => void;
	agentFilter: string;
	agentOptions: LedgerAgentOption[];
	onAgentFilterChange?: (agent: string) => void;
	modelFilter: string;
	modelOptions: string[];
	onModelFilterChange?: (model: string) => void;
	sort: SessionSortKey;
	onSortChange?: (sort: SessionSortKey) => void;
};

export type SessionsLedgerPageControls = {
	pageSize: number;
	pageSizeOptions: readonly number[];
	onPageSizeChange: (size: number) => void;
};

export type SessionsLedgerSecondaryActions = {
	archived: boolean;
	oldestStartedAt: number | null;
	cleanupReferenceTime: number;
	onCleanup: (days: number) => void;
	onPreviewCleanup?: (days: number) => Promise<SessionCleanupPreview>;
	onExport?: (format: "csv" | "json") => void;
	onImportClaude?: () => void;
	claudeImportStatus?: string | null;
	claudeImportBusy: boolean;
};

type SessionsLedgerControlsProps = {
	total: number;
	archived: boolean;
	onArchivedChange?: (archived: boolean) => void;
	filters: SessionsLedgerFilterControls;
	paging: SessionsLedgerPageControls;
	secondaryActions: SessionsLedgerSecondaryActions;
};

function SessionSearchBox({
	search,
	onSearchChange,
}: {
	search: string;
	onSearchChange: (query: string) => void;
}) {
	const [text, setText] = useState(search);
	const onSearchChangeRef = useRef(onSearchChange);
	onSearchChangeRef.current = onSearchChange;
	const committedRef = useRef(search);

	useEffect(() => {
		if (search !== committedRef.current) {
			committedRef.current = search;
			setText(search);
		}
	}, [search]);

	useEffect(() => {
		const trimmed = text.trim();
		if (trimmed === committedRef.current) return;
		const timer = setTimeout(() => {
			committedRef.current = trimmed;
			onSearchChangeRef.current(trimmed);
		}, 300);
		return () => clearTimeout(timer);
	}, [text]);

	function commitSearch() {
		const trimmed = text.trim();
		committedRef.current = trimmed;
		onSearchChange(trimmed);
	}

	function clearSearch() {
		setText("");
		committedRef.current = "";
		onSearchChange("");
	}

	return (
		<div className="flex min-h-10 w-full min-w-0 items-center border border-border md:min-h-0 md:w-auto">
			<Search className="w-2.5 h-2.5 mx-1.5 text-muted-foreground/60" />
			<input
				type="text"
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") commitSearch();
				}}
				placeholder="label…"
				title="Filters as you type"
				aria-label="Search sessions"
				className="min-w-0 flex-1 bg-transparent py-1 pr-1 text-[10px] focus:outline-none md:w-36 md:flex-none"
			/>
			{(text || search) && (
				<button
					type="button"
					onClick={clearSearch}
					aria-label="Clear session search"
					className="flex h-10 w-10 shrink-0 items-center justify-center text-muted-foreground/50 hover:text-foreground md:h-auto md:w-auto md:px-1"
				>
					<X className="w-2.5 h-2.5" />
				</button>
			)}
		</div>
	);
}

function CleanupControl({
	oldestStartedAt,
	referenceTime,
	onCleanup,
	onPreviewCleanup,
}: {
	oldestStartedAt: number | null;
	referenceTime: number;
	onCleanup: (days: number) => void;
	onPreviewCleanup?: (days: number) => Promise<SessionCleanupPreview>;
}) {
	const [pending, setPending] = useState<{
		days: number;
		preview?: SessionCleanupPreview;
	} | null>(null);
	const [loadingDays, setLoadingDays] = useState<number | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const available = CLEANUP_DAY_OPTIONS.filter(
		(days) =>
			oldestStartedAt != null &&
			referenceTime - oldestStartedAt > days * 86_400,
	);
	if (available.length === 0) return null;

	if (loadingDays != null) {
		return (
			<span className="text-[8px] tracking-widest uppercase text-muted-foreground/50">
				checking {loadingDays}d cleanup…
			</span>
		);
	}

	if (pending != null) {
		const { days, preview } = pending;
		return (
			<div
				aria-live="polite"
				className="flex items-center gap-2 text-[8px] tracking-widest uppercase"
			>
				<span className="text-muted-foreground/50">
					{preview
						? preview.sessions === 0
							? `nothing eligible older than ${days}d`
							: `delete ${preview.sessions} sessions · ${fmtBytes(preview.estimatedDatabaseBytes)} db · ${preview.managedAttachments} relics?`
						: `delete older than ${days}d?`}
				</span>
				{preview?.sessions !== 0 && (
					<button
						type="button"
						onClick={() => {
							onCleanup(days);
							setPending(null);
						}}
						className="text-destructive/60 hover:text-destructive transition-colors"
					>
						confirm
					</button>
				)}
				<button
					type="button"
					onClick={() => setPending(null)}
					className="text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors"
				>
					cancel
				</button>
			</div>
		);
	}

	return (
		<select
			value=""
			onChange={async (event) => {
				const days = Number(event.target.value);
				if (!Number.isFinite(days) || days <= 0) return;
				setPreviewError(null);
				if (!onPreviewCleanup) {
					setPending({ days });
					return;
				}
				setLoadingDays(days);
				try {
					setPending({ days, preview: await onPreviewCleanup(days) });
				} catch (error) {
					setPreviewError(
						error instanceof Error ? error.message : "Cleanup preview failed",
					);
				} finally {
					setLoadingDays(null);
				}
			}}
			aria-label="Clean up old sessions"
			className="bg-transparent border border-border text-[8px] tracking-widest uppercase text-muted-foreground/50 hover:text-muted-foreground/80 px-1.5 py-0.5 focus:outline-none focus:border-primary/50 transition-colors"
		>
			<option value="">clean up…</option>
			{available.map((days) => (
				<option key={days} value={days}>
					older than {days}d
				</option>
			))}
			{previewError && <option disabled>{previewError}</option>}
		</select>
	);
}

function ProviderImportSection({
	onImport,
	status,
	busy,
}: {
	onImport: () => void;
	status?: string | null;
	busy: boolean;
}) {
	return (
		<div>
			<div className="mb-1.5 text-[8px] tracking-widest text-muted-foreground uppercase">
				Provider history
			</div>
			<button
				type="button"
				onClick={onImport}
				disabled={busy}
				className="min-h-9 w-full border border-border px-2 text-[9px] tracking-widest uppercase hover:text-foreground disabled:opacity-40"
			>
				{busy ? "Importing…" : "Import provider history"}
			</button>
			{status && (
				<div className="mt-1.5 text-[9px] text-muted-foreground">{status}</div>
			)}
		</div>
	);
}

function ExportSection({
	onExport,
}: {
	onExport: (format: "csv" | "json") => void;
}) {
	return (
		<div>
			<div className="mb-1.5 text-[8px] tracking-widest text-muted-foreground uppercase">
				Export all sessions
			</div>
			<div className="grid grid-cols-2 gap-2">
				<button
					type="button"
					onClick={() => onExport("csv")}
					className="min-h-9 border border-border text-[9px] tracking-widest uppercase hover:text-foreground"
				>
					CSV
				</button>
				<button
					type="button"
					onClick={() => onExport("json")}
					className="min-h-9 border border-border text-[9px] tracking-widest uppercase hover:text-foreground"
				>
					JSON
				</button>
			</div>
		</div>
	);
}

function SecondaryActionsPanel({
	actions,
	panelRef,
	className,
	style,
}: {
	actions: SessionsLedgerSecondaryActions;
	panelRef?: RefObject<HTMLDivElement | null>;
	className: string;
	style?: CSSProperties;
}) {
	return (
		<div
			ref={panelRef}
			className={className}
			style={style}
			role="dialog"
			aria-label="Session list actions"
		>
			{!actions.archived && (
				<div>
					<div className="mb-1.5 text-[8px] tracking-widest text-muted-foreground uppercase">
						Maintenance
					</div>
					<CleanupControl
						oldestStartedAt={actions.oldestStartedAt}
						referenceTime={actions.cleanupReferenceTime}
						onCleanup={actions.onCleanup}
						onPreviewCleanup={actions.onPreviewCleanup}
					/>
				</div>
			)}
			{actions.onImportClaude && (
				<ProviderImportSection
					onImport={actions.onImportClaude}
					status={actions.claudeImportStatus}
					busy={actions.claudeImportBusy}
				/>
			)}
			{actions.onExport && <ExportSection onExport={actions.onExport} />}
		</div>
	);
}

function SecondaryActionsTrigger({
	buttonRef,
	open,
	onToggle,
	className,
}: {
	buttonRef?: RefObject<HTMLButtonElement | null>;
	open: boolean;
	onToggle: () => void;
	className: string;
}) {
	return (
		<button
			ref={buttonRef}
			type="button"
			onClick={onToggle}
			aria-label="More session list actions"
			aria-expanded={open}
			className={`${className} flex items-center justify-center border border-border text-muted-foreground hover:text-foreground`}
		>
			<Ellipsis className="h-4 w-4" />
		</button>
	);
}

function DesktopSecondaryActionsMenu({
	actions,
}: {
	actions: SessionsLedgerSecondaryActions;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="relative">
			<SecondaryActionsTrigger
				open={open}
				onToggle={() => setOpen((current) => !current)}
				className="h-7 w-7"
			/>
			{open && (
				<SecondaryActionsPanel
					actions={actions}
					className="absolute right-0 top-full z-40 mt-1 w-52 space-y-3 border border-border bg-popover p-3 shadow-lg"
				/>
			)}
		</div>
	);
}

function MobileSecondaryActionsMenu({
	actions,
}: {
	actions: SessionsLedgerSecondaryActions;
}) {
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const position = useAnchoredPopover(open, buttonRef, 320, 280, panelRef);
	return (
		<div className="relative">
			<SecondaryActionsTrigger
				buttonRef={buttonRef}
				open={open}
				onToggle={() => setOpen((current) => !current)}
				className="h-10 w-10"
			/>
			{open &&
				typeof document !== "undefined" &&
				createPortal(
					<>
						<button
							type="button"
							onClick={() => setOpen(false)}
							className="fixed inset-0 z-[60] bg-black/10 md:hidden"
							aria-label="Dismiss session list actions"
						/>
						{position && (
							<SecondaryActionsPanel
								actions={actions}
								panelRef={panelRef}
								className="fixed z-[70] space-y-3 overflow-y-auto border border-border bg-popover p-3 shadow-xl"
								style={{
									left: position.left,
									top: position.top,
									width: position.width,
									maxHeight: position.maxHeight,
								}}
							/>
						)}
					</>,
					document.body,
				)}
		</div>
	);
}

function ArchivedToggle({
	archived,
	onArchivedChange,
}: {
	archived: boolean;
	onArchivedChange: (archived: boolean) => void;
}) {
	return (
		<div className="flex border border-border">
			{[
				{ label: "Active", value: false },
				{ label: "Archived", value: true },
			].map((option) => (
				<button
					key={option.label}
					type="button"
					onClick={() => onArchivedChange(option.value)}
					aria-pressed={archived === option.value}
					className={`px-2 py-1 text-[8px] tracking-widest uppercase ${
						archived === option.value
							? "bg-primary/10 text-primary"
							: "text-muted-foreground hover:text-foreground"
					}`}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

function SessionsLedgerHeading({
	total,
	archived,
	onArchivedChange,
}: Pick<
	SessionsLedgerControlsProps,
	"total" | "archived" | "onArchivedChange"
>) {
	return (
		<div className="flex items-center gap-3">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
				SESSIONS
			</div>
			<span className="text-[9px] tabular-nums text-muted-foreground/40">
				{total}
			</span>
			{onArchivedChange && (
				<ArchivedToggle
					archived={archived}
					onArchivedChange={onArchivedChange}
				/>
			)}
		</div>
	);
}

function DesktopAgentFilter({
	filters,
}: {
	filters: SessionsLedgerFilterControls;
}) {
	return (
		<label className="flex items-center gap-1.5 text-[8px] tracking-widest text-muted-foreground/50 uppercase">
			<span>agent</span>
			<select
				value={filters.agentFilter}
				onChange={(event) => filters.onAgentFilterChange?.(event.target.value)}
				className="max-w-40 bg-transparent border border-border text-[9px] text-foreground/70 px-1.5 py-0.5 focus:outline-none focus:border-primary/50 transition-colors"
				aria-label="Filter sessions by agent"
			>
				<option value="">all</option>
				{filters.agentOptions.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	);
}

function DesktopModelFilter({
	filters,
}: {
	filters: SessionsLedgerFilterControls;
}) {
	return (
		<label className="flex items-center gap-1.5 text-[8px] tracking-widest text-muted-foreground/50 uppercase">
			<span>model</span>
			<select
				value={filters.modelFilter}
				onChange={(event) => filters.onModelFilterChange?.(event.target.value)}
				className="max-w-44 bg-transparent border border-border text-[9px] text-foreground/70 px-1.5 py-0.5 focus:outline-none focus:border-primary/50 transition-colors"
				aria-label="Filter sessions by model"
			>
				<option value="">all</option>
				{filters.modelOptions.map((model) => (
					<option key={model} value={model}>
						{model}
					</option>
				))}
			</select>
		</label>
	);
}

function DesktopSortControl({
	filters,
}: {
	filters: SessionsLedgerFilterControls;
}) {
	return (
		<label className="flex items-center gap-1.5 text-[8px] tracking-widest text-muted-foreground/50 uppercase">
			<span>sort</span>
			<select
				value={filters.sort}
				onChange={(event) =>
					filters.onSortChange?.(event.target.value as SessionSortKey)
				}
				className="bg-transparent border border-border text-[9px] text-foreground/70 px-1.5 py-0.5 focus:outline-none focus:border-primary/50 transition-colors"
				aria-label="Sort sessions"
			>
				{(Object.entries(SORT_LABELS) as [SessionSortKey, string][]).map(
					([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					),
				)}
			</select>
		</label>
	);
}

function DesktopPageSizeControl({
	paging,
}: {
	paging: SessionsLedgerPageControls;
}) {
	return (
		<label className="flex items-center gap-1.5 text-[8px] tracking-widest text-muted-foreground/50 uppercase">
			<span>per page</span>
			<select
				value={paging.pageSize}
				onChange={(event) =>
					paging.onPageSizeChange(Number(event.target.value))
				}
				className="bg-transparent border border-border text-[9px] tabular-nums text-foreground/70 px-1.5 py-0.5 focus:outline-none focus:border-primary/50 transition-colors"
				aria-label="Sessions per page"
			>
				{paging.pageSizeOptions.map((size) => (
					<option key={size} value={size}>
						{size}
					</option>
				))}
			</select>
		</label>
	);
}

function DesktopSessionControls({
	filters,
	paging,
	secondaryActions,
}: Pick<
	SessionsLedgerControlsProps,
	"filters" | "paging" | "secondaryActions"
>) {
	return (
		<div className="hidden md:flex items-center gap-3 flex-wrap">
			{filters.onAgentFilterChange && <DesktopAgentFilter filters={filters} />}
			{filters.onModelFilterChange && <DesktopModelFilter filters={filters} />}
			{filters.onSearchChange && (
				<SessionSearchBox
					search={filters.search}
					onSearchChange={filters.onSearchChange}
				/>
			)}
			{filters.onSortChange && <DesktopSortControl filters={filters} />}
			<DesktopPageSizeControl paging={paging} />
			<DesktopSecondaryActionsMenu actions={secondaryActions} />
		</div>
	);
}

type MobilePanel = "search" | "filter" | "sort" | null;

function MobileControlButton({
	icon: Icon,
	label,
	active,
	onClick,
}: {
	icon: ComponentType<{ className?: string }>;
	label: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`flex min-h-10 flex-1 items-center justify-center gap-1.5 border px-2 text-[9px] tracking-widest uppercase transition-colors ${
				active
					? "border-primary/50 bg-primary/10 text-primary"
					: "border-border text-muted-foreground"
			}`}
		>
			<Icon className="h-3.5 w-3.5" />
			{label}
		</button>
	);
}

function MobileControlStrip({
	panel,
	onPanelChange,
	filters,
}: {
	panel: MobilePanel;
	onPanelChange: (panel: MobilePanel) => void;
	filters: SessionsLedgerFilterControls;
}) {
	function togglePanel(next: Exclude<MobilePanel, null>) {
		onPanelChange(panel === next ? null : next);
	}

	return (
		<div className="flex w-full md:hidden items-center gap-1.5">
			<MobileControlButton
				icon={Search}
				label="Search"
				active={panel === "search"}
				onClick={() => togglePanel("search")}
			/>
			<MobileControlButton
				icon={SlidersHorizontal}
				label="Filter"
				active={
					panel === "filter" ||
					Boolean(filters.agentFilter || filters.modelFilter)
				}
				onClick={() => togglePanel("filter")}
			/>
			<MobileControlButton
				icon={ArrowUpDown}
				label="Sort"
				active={panel === "sort" || filters.sort !== "recent"}
				onClick={() => togglePanel("sort")}
			/>
		</div>
	);
}

function MobileFilterPanel({
	filters,
	paging,
	secondaryActions,
}: Pick<
	SessionsLedgerControlsProps,
	"filters" | "paging" | "secondaryActions"
>) {
	return (
		<div className="grid grid-cols-2 gap-2">
			<select
				value={filters.agentFilter}
				onChange={(event) => filters.onAgentFilterChange?.(event.target.value)}
				aria-label="Filter sessions by agent"
				className="min-h-10 bg-background border border-border px-2 text-xs"
			>
				<option value="">All agents</option>
				{filters.agentOptions.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
			<select
				value={filters.modelFilter}
				onChange={(event) => filters.onModelFilterChange?.(event.target.value)}
				aria-label="Filter sessions by model"
				className="min-h-10 bg-background border border-border px-2 text-xs"
			>
				<option value="">All models</option>
				{filters.modelOptions.map((model) => (
					<option key={model} value={model}>
						{model}
					</option>
				))}
			</select>
			<label className="col-span-1">
				<span className="mb-1 block text-[8px] tracking-widest text-muted-foreground uppercase">
					Per page
				</span>
				<select
					value={paging.pageSize}
					onChange={(event) =>
						paging.onPageSizeChange(Number(event.target.value))
					}
					className="min-h-10 w-full bg-background border border-border px-2 text-xs"
					aria-label="Sessions per page"
				>
					{paging.pageSizeOptions.map((size) => (
						<option key={size} value={size}>
							{size}
						</option>
					))}
				</select>
			</label>
			<div className="col-span-1 flex items-end justify-end">
				<MobileSecondaryActionsMenu actions={secondaryActions} />
			</div>
		</div>
	);
}

function MobileSortPanel({
	filters,
}: {
	filters: SessionsLedgerFilterControls;
}) {
	return (
		<select
			value={filters.sort}
			onChange={(event) =>
				filters.onSortChange?.(event.target.value as SessionSortKey)
			}
			aria-label="Sort sessions"
			className="min-h-10 w-full bg-background border border-border px-2 text-xs"
		>
			{(Object.entries(SORT_LABELS) as [SessionSortKey, string][]).map(
				([value, label]) => (
					<option key={value} value={value}>
						{label}
					</option>
				),
			)}
		</select>
	);
}

function MobileControlPanel({
	panel,
	filters,
	paging,
	secondaryActions,
}: {
	panel: Exclude<MobilePanel, null>;
} & Pick<
	SessionsLedgerControlsProps,
	"filters" | "paging" | "secondaryActions"
>) {
	if (panel === "search") {
		return filters.onSearchChange ? (
			<SessionSearchBox
				search={filters.search}
				onSearchChange={filters.onSearchChange}
			/>
		) : null;
	}
	if (panel === "filter") {
		return (
			<MobileFilterPanel
				filters={filters}
				paging={paging}
				secondaryActions={secondaryActions}
			/>
		);
	}
	return <MobileSortPanel filters={filters} />;
}

export function SessionsLedgerControls(props: SessionsLedgerControlsProps) {
	const { filters, paging, secondaryActions } = props;
	const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
	return (
		<>
			<div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
				<SessionsLedgerHeading
					total={props.total}
					archived={props.archived}
					onArchivedChange={props.onArchivedChange}
				/>
				<DesktopSessionControls
					filters={filters}
					paging={paging}
					secondaryActions={secondaryActions}
				/>
				<MobileControlStrip
					panel={mobilePanel}
					onPanelChange={setMobilePanel}
					filters={filters}
				/>
			</div>
			{mobilePanel && (
				<div className="md:hidden border-b border-border bg-muted/15 p-3">
					<MobileControlPanel
						panel={mobilePanel}
						filters={filters}
						paging={paging}
						secondaryActions={secondaryActions}
					/>
				</div>
			)}
		</>
	);
}
