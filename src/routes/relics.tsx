import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
	ArrowUpRight,
	ChevronDown,
	ChevronRight,
	File as FileIcon,
	ListFilter,
	Search,
	Trash2,
	X,
} from "lucide-react";
import {
	Fragment,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import {
	ClickableImage,
	ImageViewerModal,
} from "#/components/ImageViewerModal";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { AttachmentRow } from "#/db";
import { useIsDesktop } from "#/hooks/useIsDesktop";
import { useWs } from "#/hooks/useWs";
import {
	getDataRevisionSnapshot,
	subscribeDataRevisionSnapshot,
} from "#/hooks/wsDataRevisionStore";
import { dbFetch } from "#/lib/dbClient";
import { fmtBytes, fmtDate } from "#/lib/formatters";
import { ROUTE_SCROLL_RESTORATION_IDS } from "#/lib/scrollContainers";
import type { ServerMessage } from "#/server/protocol";

type ListResult = {
	rows: AttachmentRow[];
	total: number;
	total_bytes: number;
};

type TypeFilter = "all" | "image" | "pdf" | "text" | "other";
type SortCol = "created_at" | "size_bytes";
type SortDir = "asc" | "desc";

type ListInput = {
	search?: string;
	session_id?: string;
	type?: Exclude<TypeFilter, "all">;
	sort?: SortCol;
	dir?: SortDir;
	limit: number;
	offset: number;
};

type ListAttachments = (input: { data: ListInput }) => Promise<ListResult>;

const listAttachmentsFn = createServerFn({ method: "POST" })
	.validator((data: ListInput) => data)
	.handler(async ({ data }) => {
		const params = new URLSearchParams();
		if (data.search) params.set("search", data.search);
		if (data.session_id) params.set("session_id", data.session_id);
		if (data.type) params.set("type", data.type);
		if (data.sort) params.set("sort", data.sort);
		if (data.dir) params.set("dir", data.dir);
		params.set("limit", String(data.limit));
		params.set("offset", String(data.offset));
		const res = await dbFetch(`/db/attachments?${params.toString()}`);
		if (!res.ok) {
			throw new Error(`Failed to fetch attachments: ${res.status}`);
		}
		return res.json() as Promise<ListResult>;
	});

export const Route = createFileRoute("/relics")({
	loader: async () => {
		const initial = await listAttachmentsFn({ data: { limit: 50, offset: 0 } });
		return { initial };
	},
	staleTime: 0,
	component: RelicsRoutePage,
});

function RelicsRoutePage() {
	return <AttachmentsPage initial={Route.useLoaderData().initial} />;
}

const PAGE_SIZE = 50;

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "image", label: "Images" },
	{ value: "pdf", label: "PDF" },
	{ value: "text", label: "Text" },
	{ value: "other", label: "Other" },
];

type Filters = {
	search: string;
	type: TypeFilter;
	session: string | null;
	sort: SortCol;
	dir: SortDir;
};

const DEFAULT_FILTERS: Filters = {
	search: "",
	type: "all",
	session: null,
	sort: "created_at",
	dir: "desc",
};

function buildListInput(filters: Filters, page: number): ListInput {
	const input: ListInput = {
		search: filters.search.trim() || undefined,
		limit: PAGE_SIZE,
		offset: (page - 1) * PAGE_SIZE,
	};
	if (filters.type !== "all") input.type = filters.type;
	if (filters.session) input.session_id = filters.session;
	// Default order (created_at desc) omitted so the server default applies.
	if (filters.sort !== "created_at" || filters.dir !== "desc") {
		input.sort = filters.sort;
		input.dir = filters.dir;
	}
	return input;
}

function filtersActive(filters: Filters): boolean {
	return (
		filters.search.trim() !== "" ||
		filters.type !== "all" ||
		filters.session !== null
	);
}

function TextPreview({ id, mime }: { id: string; mime: string }) {
	const [text, setText] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		fetch(`/api/attachments/${id}/raw`, { signal: controller.signal })
			.then((r) => {
				if (!r.ok)
					throw new Error(`fetch failed (${r.status} ${r.statusText})`);
				return r.text();
			})
			.then(setText)
			.catch((e) => {
				if (e instanceof Error && e.name === "AbortError") return;
				setErr(e instanceof Error ? e.message : "fetch failed");
			})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, [id]);

	if (loading)
		return (
			<span className="text-[11px] text-muted-foreground/50">loading…</span>
		);
	if (err)
		return <span className="text-[11px] text-destructive/70">{err}</span>;
	if (text === null) return null;
	if (mime === "text/markdown") return <MarkdownBody content={text} />;
	return (
		<pre className="text-[11px] whitespace-pre-wrap break-words font-mono">
			{text}
		</pre>
	);
}

export function RelicPreview({ id, mime }: { id: string; mime: string }) {
	const rawUrl = `/api/attachments/${id}/raw`;
	if (mime.startsWith("image/")) {
		return (
			<ClickableImage src={rawUrl} alt="" className="max-h-96 max-w-full" />
		);
	}
	if (mime === "application/pdf") {
		return (
			<iframe
				src={rawUrl}
				className="w-full h-96 border-0"
				title="pdf preview"
			/>
		);
	}
	if (mime === "text/html") {
		return (
			<iframe
				src={rawUrl}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				className="w-full h-96 bg-white border-0"
				title="html preview"
			/>
		);
	}
	if (mime.startsWith("text/") || mime === "application/json") {
		return <TextPreview id={id} mime={mime} />;
	}
	return (
		<span className="text-[11px] text-muted-foreground/50">no preview</span>
	);
}

export async function deleteRelicRows(
	ids: Iterable<string>,
	rows: AttachmentRow[],
	request: typeof fetch = fetch,
): Promise<string[]> {
	const failures: string[] = [];
	for (const id of ids) {
		const row = rows.find((candidate) => candidate.id === id);
		if (!row) continue;
		const response = await request(`/api/attachments/${row.id}`, {
			method: "DELETE",
		});
		if (!response.ok) failures.push(row.filename);
	}
	return failures;
}

type ViewerImage = { src: string; alt: string };

function useRelicsList(initial: ListResult, listAttachments: ListAttachments) {
	const [rows, setRows] = useState<AttachmentRow[]>(initial.rows);
	const [total, setTotal] = useState(initial.total);
	const [totalBytes, setTotalBytes] = useState(initial.total_bytes);
	const [page, setPage] = useState(1);
	const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
	const [searchText, setSearchText] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [hasNew, setHasNew] = useState(false);
	const relicsRevision = useSyncExternalStore(
		subscribeDataRevisionSnapshot,
		() => getDataRevisionSnapshot().relics,
		() => 0,
	);
	const initialRelicsRevisionRef = useRef(relicsRevision);
	useEffect(() => {
		if (relicsRevision !== initialRelicsRevisionRef.current) setHasNew(true);
	}, [relicsRevision]);

	useEffect(() => {
		setRows(initial.rows);
		setTotal(initial.total);
		setTotalBytes(initial.total_bytes);
		setPage(1);
		setSelected(new Set());
	}, [initial]);

	const reload = useCallback(
		async (nextPage: number, nextFilters?: Filters) => {
			const effective = nextFilters ?? filters;
			setBusy(true);
			setError(null);
			try {
				const res = await listAttachments({
					data: buildListInput(effective, nextPage),
				});
				setRows(res.rows);
				setTotal(res.total);
				setTotalBytes(res.total_bytes);
				setPage(nextPage);
				setFilters(effective);
				setSelected(new Set());
				setHasNew(false);
			} catch (e) {
				setError(e instanceof Error ? e.message : "load failed");
			} finally {
				setBusy(false);
			}
		},
		[filters, listAttachments],
	);

	const applyFilters = useCallback(
		(patch: Partial<Filters>) => {
			void reload(1, { ...filters, ...patch });
		},
		[filters, reload],
	);

	const clearFilters = useCallback(() => {
		setSearchText("");
		void reload(1, {
			...DEFAULT_FILTERS,
			sort: filters.sort,
			dir: filters.dir,
		});
	}, [filters.sort, filters.dir, reload]);

	const toggleSort = useCallback(
		(col: SortCol) => {
			if (filters.sort === col) {
				applyFilters({ dir: filters.dir === "desc" ? "asc" : "desc" });
			} else {
				applyFilters({ sort: col, dir: "desc" });
			}
		},
		[filters.sort, filters.dir, applyFilters],
	);

	// Live search: commit the box contents after a short pause in typing.
	// SQLite LIKE over the local DB is milliseconds even at thousands of rows,
	// so the only real cost is a reload per pause — 300ms keeps that sane.
	// The ref keeps busy-state re-renders (applyFilters identity changes) from
	// endlessly resetting the timer mid-typing.
	const applyFiltersRef = useRef(applyFilters);
	applyFiltersRef.current = applyFilters;
	useEffect(() => {
		const trimmed = searchText.trim();
		if (trimmed === filters.search.trim()) return;
		const timer = setTimeout(
			() => applyFiltersRef.current({ search: searchText }),
			300,
		);
		return () => clearTimeout(timer);
	}, [searchText, filters.search]);

	// New relics elsewhere → surface a refresh pill instead of yanking the
	// list back to page 1 (which also cleared any in-progress selection).
	const handleWsMessage = useCallback((msg: ServerMessage) => {
		if (msg.type === "attachment_created") setHasNew(true);
	}, []);
	useWs(handleWsMessage);

	return {
		rows,
		total,
		totalBytes,
		page,
		filters,
		searchText,
		setSearchText,
		applyFilters,
		clearFilters,
		toggleSort,
		selected,
		setSelected,
		busy,
		setBusy,
		error,
		setError,
		hasNew,
		reload,
	};
}

type RelicsList = ReturnType<typeof useRelicsList>;

function useRelicDeletes(list: RelicsList, request: typeof fetch) {
	const { rows, page, selected, setBusy, setError, reload } = list;

	const deleteOne = async (id: string) => {
		setBusy(true);
		try {
			const failures = await deleteRelicRows([id], rows, request);
			if (failures.length > 0) {
				setError(`Delete failed: ${failures.join(", ")}`);
				return;
			}
			await reload(page);
		} finally {
			setBusy(false);
		}
	};

	const deleteSelected = async () => {
		const ids = Array.from(selected);
		if (ids.length === 0) return;
		setBusy(true);
		try {
			const failures = await deleteRelicRows(ids, rows, request);
			await reload(page);
			if (failures.length > 0)
				setError(`Delete failed: ${failures.join(", ")}`);
		} finally {
			setBusy(false);
		}
	};

	return { deleteOne, deleteSelected };
}

function RelicsSearchBox({ list }: { list: RelicsList }) {
	const { searchText, setSearchText, applyFilters, filters } = list;
	return (
		<div className="flex items-center border border-border">
			<Search className="w-3 h-3 mx-2 text-muted-foreground/60" />
			<input
				type="text"
				value={searchText}
				onChange={(e) => setSearchText(e.target.value)}
				onKeyDown={(e) => {
					// Live search commits after a pause; Enter forces it now.
					if (e.key === "Enter") applyFilters({ search: searchText });
				}}
				placeholder="filename…"
				title="Filters as you type"
				className="bg-transparent text-[11px] py-1.5 pr-1 w-28 md:w-44 focus:outline-none"
			/>
			{(searchText || filters.search) && (
				<button
					type="button"
					onClick={() => {
						setSearchText("");
						applyFilters({ search: "" });
					}}
					aria-label="Clear search"
					className="px-1.5 text-muted-foreground/50 hover:text-foreground"
				>
					<X className="w-3 h-3" />
				</button>
			)}
		</div>
	);
}

function RelicsHeader({ list }: { list: RelicsList }) {
	const { total, totalBytes, busy, error, reload, filters, applyFilters } =
		list;
	return (
		<div className="px-5 py-4 border-b border-border">
			<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<div>
					<div className="text-[11px] tracking-[0.3em] text-muted-foreground uppercase">
						Relics
					</div>
					<PrivacyMask inline className="text-sm font-bold mt-0.5">
						{total} {total === 1 ? "file" : "files"} · {fmtBytes(totalBytes)}
					</PrivacyMask>
				</div>
				<div className="flex items-center gap-2 flex-wrap">
					<RelicsSearchBox list={list} />
					<button
						type="button"
						onClick={() => void reload(1)}
						disabled={busy}
						className="px-3 py-1.5 text-[10px] tracking-widest text-muted-foreground hover:text-foreground border border-border uppercase disabled:opacity-30"
					>
						Refresh
					</button>
				</div>
			</div>
			<div className="mt-3 flex items-center gap-1.5 flex-wrap">
				{TYPE_FILTERS.map(({ value, label }) => (
					<button
						key={value}
						type="button"
						onClick={() => applyFilters({ type: value })}
						aria-pressed={filters.type === value}
						className={`px-2.5 py-1 text-[9px] tracking-widest uppercase border transition-colors ${
							filters.type === value
								? "border-primary text-primary"
								: "border-border text-muted-foreground hover:text-foreground"
						}`}
					>
						{label}
					</button>
				))}
				{filters.session && (
					<span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[9px] tracking-widest uppercase border border-primary/50 text-primary">
						session
						<span className="font-mono normal-case tracking-normal">
							{filters.session.slice(0, 12)}
						</span>
						<button
							type="button"
							onClick={() => applyFilters({ session: null })}
							aria-label="Clear session filter"
							className="hover:text-foreground"
						>
							<X className="w-3 h-3" />
						</button>
					</span>
				)}
			</div>
			{error && (
				<div className="mt-2 text-[11px] text-destructive/80">{error}</div>
			)}
		</div>
	);
}

function NewRelicsPill({ list }: { list: RelicsList }) {
	const { hasNew, busy, reload } = list;
	if (!hasNew) return null;
	return (
		<div className="px-5 py-2 border-b border-border bg-primary/5">
			<button
				type="button"
				onClick={() => void reload(1)}
				disabled={busy}
				className="text-[10px] tracking-widest uppercase text-primary hover:text-primary/80 disabled:opacity-30"
			>
				new relics — refresh ↻
			</button>
		</div>
	);
}

function SelectionBar({
	count,
	busy,
	onDelete,
}: {
	count: number;
	busy: boolean;
	onDelete: () => void;
}) {
	return (
		<div className="px-5 py-2 border-b border-border bg-secondary/30 flex items-center justify-between">
			<span className="text-[11px] tracking-widest uppercase text-foreground">
				{count} selected · this page
			</span>
			<ConfirmAction
				label={`delete ${count}?`}
				onConfirm={onDelete}
				trigger={(open) => (
					<button
						type="button"
						onClick={open}
						disabled={busy}
						className="px-3 py-1.5 text-[10px] tracking-widest text-destructive/80 hover:text-destructive border border-destructive/40 uppercase disabled:opacity-30 inline-flex items-center gap-1.5"
					>
						<Trash2 className="w-3 h-3" />
						Delete
					</button>
				)}
			/>
		</div>
	);
}

function RelicThumb({
	row,
	onView,
}: {
	row: AttachmentRow;
	onView: (img: ViewerImage) => void;
}) {
	const rawUrl = `/api/attachments/${row.id}/raw`;
	if (!row.mime.startsWith("image/"))
		return <FileIcon className="w-3 h-3 shrink-0 opacity-60" />;
	return (
		<button
			type="button"
			className="shrink-0 hover:opacity-75 transition-opacity cursor-zoom-in"
			aria-label={`View ${row.filename}`}
			onClick={(e) => {
				e.stopPropagation();
				onView({ src: rawUrl, alt: row.filename });
			}}
		>
			<img src={rawUrl} alt={row.filename} className="w-6 h-6 object-cover" />
		</button>
	);
}

function RelicName({
	row,
	onView,
	variant,
}: {
	row: AttachmentRow;
	onView: (img: ViewerImage) => void;
	/** table: inline with a max width; card: block filling the row. */
	variant: "table" | "card";
}) {
	const rawUrl = `/api/attachments/${row.id}/raw`;
	// `truncate` needs a block-ish box — plain inline anchors never clip,
	// which let long filenames run under the delete button on mobile.
	const base = `font-mono truncate text-foreground hover:text-primary ${
		variant === "table"
			? "inline-block align-bottom max-w-[260px]"
			: "block w-full text-left"
	}`;
	return (
		<PrivacyMask
			inline
			className={variant === "card" ? "block min-w-0 flex-1" : undefined}
		>
			{row.mime.startsWith("image/") ? (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onView({ src: rawUrl, alt: row.filename });
					}}
					className={`${base} cursor-zoom-in`}
				>
					{row.filename}
				</button>
			) : (
				<a
					href={rawUrl}
					target="_blank"
					rel="noreferrer"
					onClick={(e) => e.stopPropagation()}
					className={base}
				>
					{row.filename}
				</a>
			)}
		</PrivacyMask>
	);
}

function RelicSessionActions({
	row,
	list,
}: {
	row: AttachmentRow;
	list: RelicsList;
}) {
	if (!row.session_id) return <>?</>;
	const shortId = row.session_id.slice(0, 12);
	return (
		<span className="inline-flex items-center gap-1.5">
			{/* Session id opens the chat — the expected default. Filtering is
			    the explicit funnel icon next to it. */}
			<Link
				to="/raven"
				search={{ session: row.session_id, agent: undefined }}
				title="Open session in Raven"
				className="font-mono hover:text-primary transition-colors inline-flex items-center gap-0.5"
			>
				{shortId}
				<ArrowUpRight className="w-3 h-3 opacity-50" />
			</Link>
			<button
				type="button"
				onClick={() => list.applyFilters({ session: row.session_id })}
				title="Filter by this session"
				aria-label={`Filter relics by session ${shortId}`}
				className="text-muted-foreground/40 hover:text-primary transition-colors"
			>
				<ListFilter className="w-3 h-3" />
			</button>
		</span>
	);
}

function RowCheckbox({ row, list }: { row: AttachmentRow; list: RelicsList }) {
	const { selected, setSelected } = list;
	return (
		<input
			type="checkbox"
			aria-label={`Select ${row.filename}`}
			checked={selected.has(row.id)}
			onChange={() =>
				setSelected((prev) => {
					const next = new Set(prev);
					if (next.has(row.id)) next.delete(row.id);
					else next.add(row.id);
					return next;
				})
			}
		/>
	);
}

function DeleteButton({
	row,
	busy,
	onDelete,
	className,
}: {
	row: AttachmentRow;
	busy: boolean;
	onDelete: () => void;
	className?: string;
}) {
	return (
		<ConfirmAction
			className={className}
			onConfirm={onDelete}
			trigger={(open) => (
				<button
					type="button"
					onClick={open}
					disabled={busy}
					className="text-muted-foreground/50 hover:text-destructive disabled:opacity-30"
					aria-label={`Delete ${row.filename}`}
				>
					<Trash2 className="w-3.5 h-3.5" />
				</button>
			)}
		/>
	);
}

function RelicRow({
	row,
	list,
	expanded,
	onToggleExpand,
	onView,
	onDelete,
}: {
	row: AttachmentRow;
	list: RelicsList;
	expanded: boolean;
	onToggleExpand: () => void;
	onView: (img: ViewerImage) => void;
	onDelete: () => void;
}) {
	const stop = {
		onClick: (e: React.SyntheticEvent) => e.stopPropagation(),
		onKeyDown: (e: React.SyntheticEvent) => e.stopPropagation(),
	};
	return (
		<tr
			className="border-b border-border/40 hover:bg-secondary/20 cursor-pointer"
			onClick={onToggleExpand}
		>
			<td className="px-3 py-2" {...stop}>
				<RowCheckbox row={row} list={list} />
			</td>
			<td className="px-3 py-2">
				<div className="flex items-center gap-1.5">
					{expanded ? (
						<ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground/50" />
					) : (
						<ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground/50" />
					)}
					<RelicThumb row={row} onView={onView} />
					<RelicName row={row} onView={onView} variant="table" />
				</div>
			</td>
			<td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
				<PrivacyMask inline>{fmtBytes(row.size_bytes)}</PrivacyMask>
			</td>
			<td className="px-3 py-2 font-mono text-muted-foreground/70 truncate">
				{row.mime}
			</td>
			<td
				className="px-3 py-2 font-mono text-muted-foreground/60 truncate"
				{...stop}
			>
				<RelicSessionActions row={row} list={list} />
			</td>
			<td className="px-3 py-2 text-muted-foreground/70 tabular-nums">
				{fmtDate(row.created_at)}
			</td>
			<td className="px-3 py-2 text-right" {...stop}>
				<DeleteButton
					row={row}
					busy={list.busy}
					onDelete={onDelete}
					className="justify-end"
				/>
			</td>
		</tr>
	);
}

function SortHeader({
	col,
	label,
	list,
	align = "left",
}: {
	col: SortCol;
	label: string;
	list: RelicsList;
	align?: "left" | "right";
}) {
	const { filters, toggleSort } = list;
	const active = filters.sort === col;
	const arrow = active ? (filters.dir === "desc" ? "▼" : "▲") : "";
	return (
		<button
			type="button"
			onClick={() => toggleSort(col)}
			aria-label={`Sort by ${label}`}
			className={`w-full uppercase tracking-widest hover:text-foreground transition-colors ${
				align === "right" ? "text-right" : "text-left"
			} ${active ? "text-foreground" : ""}`}
		>
			{label}
			{arrow && <span className="ml-1">{arrow}</span>}
		</button>
	);
}

function EmptyState({ list }: { list: RelicsList }) {
	if (!filtersActive(list.filters)) {
		return <span className="text-muted-foreground/50">no relics</span>;
	}
	return (
		<span className="text-muted-foreground/50">
			no relics match filters ·{" "}
			<button
				type="button"
				onClick={list.clearFilters}
				className="text-primary hover:text-primary/80 underline underline-offset-2"
			>
				clear filters
			</button>
		</span>
	);
}

function RelicsTable({
	list,
	expandedId,
	setExpandedId,
	onView,
	onDelete,
}: {
	list: RelicsList;
	expandedId: string | null;
	setExpandedId: (id: string | null) => void;
	onView: (img: ViewerImage) => void;
	onDelete: (id: string) => void;
}) {
	const { rows, selected, setSelected } = list;
	return (
		<table className="w-full min-w-[720px] text-[11px]">
			<thead className="text-[9px] tracking-widest uppercase text-muted-foreground/70">
				<tr className="border-b border-border">
					<th className="px-3 py-2 text-left w-8">
						<input
							type="checkbox"
							aria-label="Select all on page"
							checked={rows.length > 0 && selected.size === rows.length}
							onChange={() =>
								setSelected((prev) =>
									prev.size === rows.length
										? new Set<string>()
										: new Set(rows.map((r) => r.id)),
								)
							}
						/>
					</th>
					<th className="px-3 py-2 text-left">File</th>
					<th className="px-3 py-2 w-24">
						<SortHeader
							col="size_bytes"
							label="Size"
							list={list}
							align="right"
						/>
					</th>
					<th className="px-3 py-2 text-left w-40">Type</th>
					<th className="px-3 py-2 text-left w-44">Session</th>
					<th className="px-3 py-2 w-44">
						<SortHeader col="created_at" label="Created" list={list} />
					</th>
					<th className="px-3 py-2 w-12" />
				</tr>
			</thead>
			<tbody>
				{rows.length === 0 ? (
					<tr>
						<td colSpan={7} className="px-3 py-12 text-center">
							<EmptyState list={list} />
						</td>
					</tr>
				) : (
					rows.map((r) => (
						<Fragment key={r.id}>
							<RelicRow
								row={r}
								list={list}
								expanded={expandedId === r.id}
								onToggleExpand={() =>
									setExpandedId(expandedId === r.id ? null : r.id)
								}
								onView={onView}
								onDelete={() => onDelete(r.id)}
							/>
							{expandedId === r.id && (
								<tr className="border-b border-border/40 bg-secondary/20">
									<td />
									<td colSpan={6} className="px-4 py-4">
										<PrivacyMask>
											<RelicPreview id={r.id} mime={r.mime} />
										</PrivacyMask>
									</td>
								</tr>
							)}
						</Fragment>
					))
				)}
			</tbody>
		</table>
	);
}

function RelicCard({
	row,
	list,
	expanded,
	onToggleExpand,
	onView,
	onDelete,
}: {
	row: AttachmentRow;
	list: RelicsList;
	expanded: boolean;
	onToggleExpand: () => void;
	onView: (img: ViewerImage) => void;
	onDelete: () => void;
}) {
	return (
		<div className="border-b border-border/40">
			<div className="px-4 py-3 flex items-start gap-3">
				<RowCheckbox row={row} list={list} />
				<RelicThumb row={row} onView={onView} />
				{/* No interactive elements nested inside buttons: the chevron and
				    meta line toggle the preview, the name opens the file, and the
				    session actions stay independently tappable. */}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-1.5 min-w-0">
						<button
							type="button"
							onClick={onToggleExpand}
							aria-expanded={expanded}
							aria-label={`Toggle preview for ${row.filename}`}
							className="shrink-0"
						>
							{expanded ? (
								<ChevronDown className="w-3 h-3 text-muted-foreground/50" />
							) : (
								<ChevronRight className="w-3 h-3 text-muted-foreground/50" />
							)}
						</button>
						<RelicName row={row} onView={onView} variant="card" />
					</div>
					<button
						type="button"
						onClick={onToggleExpand}
						className="mt-1 block w-full text-left text-[10px] text-muted-foreground/60 tabular-nums"
					>
						<span className="flex items-center gap-2 flex-wrap">
							<PrivacyMask inline>{fmtBytes(row.size_bytes)}</PrivacyMask>
							<span className="font-mono">{row.mime}</span>
							<span>{fmtDate(row.created_at)}</span>
						</span>
					</button>
					{row.session_id && (
						<div className="mt-1 text-[10px] text-muted-foreground/50">
							<RelicSessionActions row={row} list={list} />
						</div>
					)}
				</div>
				<DeleteButton row={row} busy={list.busy} onDelete={onDelete} />
			</div>
			{expanded && (
				<div className="px-4 pb-4 bg-secondary/20">
					<PrivacyMask>
						<RelicPreview id={row.id} mime={row.mime} />
					</PrivacyMask>
				</div>
			)}
		</div>
	);
}

function RelicsCardList({
	list,
	expandedId,
	setExpandedId,
	onView,
	onDelete,
}: {
	list: RelicsList;
	expandedId: string | null;
	setExpandedId: (id: string | null) => void;
	onView: (img: ViewerImage) => void;
	onDelete: (id: string) => void;
}) {
	const { rows } = list;
	if (rows.length === 0) {
		return (
			<div className="px-4 py-12 text-center text-[11px]">
				<EmptyState list={list} />
			</div>
		);
	}
	return (
		<div className="text-[11px]">
			{rows.map((r) => (
				<RelicCard
					key={r.id}
					row={r}
					list={list}
					expanded={expandedId === r.id}
					onToggleExpand={() =>
						setExpandedId(expandedId === r.id ? null : r.id)
					}
					onView={onView}
					onDelete={() => onDelete(r.id)}
				/>
			))}
		</div>
	);
}

function RelicsPagination({ list }: { list: RelicsList }) {
	const { page, total, busy, reload } = list;
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	if (totalPages <= 1) return null;
	return (
		<div className="px-5 py-3 border-t border-border flex items-center justify-between text-[10px] tracking-widest uppercase text-muted-foreground">
			<button
				type="button"
				onClick={() => void reload(Math.max(1, page - 1))}
				disabled={page === 1 || busy}
				className="hover:text-foreground disabled:opacity-30"
			>
				← prev
			</button>
			<span>
				page {page} / {totalPages}
			</span>
			<button
				type="button"
				onClick={() => void reload(Math.min(totalPages, page + 1))}
				disabled={page === totalPages || busy}
				className="hover:text-foreground disabled:opacity-30"
			>
				next →
			</button>
		</div>
	);
}

export function AttachmentsPage({
	initial,
	listAttachments = listAttachmentsFn as ListAttachments,
	request = fetch,
}: {
	initial: ListResult;
	listAttachments?: ListAttachments;
	request?: typeof fetch;
}) {
	const list = useRelicsList(initial, listAttachments);
	const { deleteOne, deleteSelected } = useRelicDeletes(list, request);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [viewerImg, setViewerImg] = useState<ViewerImage | null>(null);
	const isDesktop = useIsDesktop();

	return (
		<div className="h-full flex flex-col">
			<RelicsHeader list={list} />
			<NewRelicsPill list={list} />
			{list.selected.size > 0 && (
				<SelectionBar
					count={list.selected.size}
					busy={list.busy}
					onDelete={() => void deleteSelected()}
				/>
			)}
			<div
				data-scroll-restoration-id={ROUTE_SCROLL_RESTORATION_IDS.relicsList}
				data-scroll-to-top="route"
				className="flex-1 overflow-auto"
			>
				{isDesktop ? (
					<RelicsTable
						list={list}
						expandedId={expandedId}
						setExpandedId={setExpandedId}
						onView={setViewerImg}
						onDelete={(id) => void deleteOne(id)}
					/>
				) : (
					<RelicsCardList
						list={list}
						expandedId={expandedId}
						setExpandedId={setExpandedId}
						onView={setViewerImg}
						onDelete={(id) => void deleteOne(id)}
					/>
				)}
			</div>
			<RelicsPagination list={list} />
			{viewerImg && (
				<ImageViewerModal
					src={viewerImg.src}
					alt={viewerImg.alt}
					onClose={() => setViewerImg(null)}
				/>
			)}
		</div>
	);
}
