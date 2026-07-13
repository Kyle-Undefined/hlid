import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
	ChevronDown,
	ChevronRight,
	File as FileIcon,
	Search,
	Trash2,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import {
	ClickableImage,
	ImageViewerModal,
} from "#/components/ImageViewerModal";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { AttachmentRow } from "#/db";
import { useWs } from "#/hooks/useWs";
import { dbFetch } from "#/lib/dbClient";
import { fmtBytes } from "#/lib/formatters";
import { ROUTE_SCROLL_RESTORATION_IDS } from "#/lib/scrollContainers";
import type { ServerMessage } from "#/server/protocol";

type ListResult = {
	rows: AttachmentRow[];
	total: number;
	total_bytes: number;
};

type ListAttachments = (input: {
	data: {
		search?: string;
		session_id?: string;
		limit: number;
		offset: number;
	};
}) => Promise<ListResult>;

const listAttachmentsFn = createServerFn({ method: "POST" })
	.validator(
		(data: {
			search?: string;
			session_id?: string;
			limit: number;
			offset: number;
		}) => data,
	)
	.handler(async ({ data }) => {
		const params = new URLSearchParams();
		if (data.search) params.set("search", data.search);
		if (data.session_id) params.set("session_id", data.session_id);
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

function formatDate(unix: number): string {
	return new Date(unix * 1000).toLocaleString();
}

const PAGE_SIZE = 50;

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
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setRows(initial.rows);
		setTotal(initial.total);
		setTotalBytes(initial.total_bytes);
		setPage(1);
		setSelected(new Set());
	}, [initial]);

	const reload = useCallback(
		async (nextPage: number, nextSearch: string = search) => {
			setBusy(true);
			setError(null);
			try {
				const res = await listAttachments({
					data: {
						search: nextSearch.trim() || undefined,
						limit: PAGE_SIZE,
						offset: (nextPage - 1) * PAGE_SIZE,
					},
				});
				setRows(res.rows);
				setTotal(res.total);
				setTotalBytes(res.total_bytes);
				setPage(nextPage);
				setSelected(new Set());
			} catch (e) {
				setError(e instanceof Error ? e.message : "load failed");
			} finally {
				setBusy(false);
			}
		},
		[search, listAttachments],
	);

	const handleWsMessage = useCallback(
		(msg: ServerMessage) => {
			if (msg.type === "attachment_created") void reload(1);
		},
		[reload],
	);
	useWs(handleWsMessage);

	return {
		rows,
		total,
		totalBytes,
		page,
		search,
		setSearch,
		selected,
		setSelected,
		busy,
		setBusy,
		error,
		setError,
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

function RelicsHeader({ list }: { list: RelicsList }) {
	const { total, totalBytes, search, setSearch, busy, error, reload } = list;
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
					<div className="flex items-center border border-border">
						<Search className="w-3 h-3 mx-2 text-muted-foreground/60" />
						<input
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void reload(1);
							}}
							placeholder="filename…"
							className="bg-transparent text-[11px] py-1.5 pr-2 w-28 md:w-44 focus:outline-none"
						/>
					</div>
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
			{error && (
				<div className="mt-2 text-[11px] text-destructive/80">{error}</div>
			)}
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
				{count} selected
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

function RelicNameCell({
	row,
	expanded,
	onView,
}: {
	row: AttachmentRow;
	expanded: boolean;
	onView: (img: ViewerImage) => void;
}) {
	const rawUrl = `/api/attachments/${row.id}/raw`;
	const isImage = row.mime.startsWith("image/");
	const view = (e: React.MouseEvent) => {
		e.stopPropagation();
		onView({ src: rawUrl, alt: row.filename });
	};
	return (
		<td className="px-3 py-2">
			<div className="flex items-center gap-1.5">
				{expanded ? (
					<ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground/50" />
				) : (
					<ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground/50" />
				)}
				{isImage ? (
					<button
						type="button"
						className="shrink-0 hover:opacity-75 transition-opacity cursor-zoom-in"
						aria-label={`View ${row.filename}`}
						onClick={view}
					>
						<img
							src={rawUrl}
							alt={row.filename}
							className="w-6 h-6 object-cover"
						/>
					</button>
				) : (
					<FileIcon className="w-3 h-3 shrink-0 opacity-60" />
				)}
				<PrivacyMask inline>
					{isImage ? (
						<button
							type="button"
							onClick={view}
							className="font-mono truncate max-w-[260px] text-foreground hover:text-primary cursor-zoom-in"
						>
							{row.filename}
						</button>
					) : (
						<a
							href={rawUrl}
							target="_blank"
							rel="noreferrer"
							onClick={(e) => e.stopPropagation()}
							className="font-mono truncate max-w-[260px] text-foreground hover:text-primary"
						>
							{row.filename}
						</a>
					)}
				</PrivacyMask>
			</div>
		</td>
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
	const { selected, setSelected, busy } = list;
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
				<input
					type="checkbox"
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
			</td>
			<RelicNameCell row={row} expanded={expanded} onView={onView} />
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
				{row.session_id ? (
					<Link
						to="/raven"
						search={{ session: row.session_id, agent: undefined }}
						className="hover:text-primary transition-colors"
					>
						{row.session_id.slice(0, 12)}
					</Link>
				) : (
					"?"
				)}
			</td>
			<td className="px-3 py-2 text-muted-foreground/70 tabular-nums">
				{formatDate(row.created_at)}
			</td>
			<td className="px-3 py-2 text-right" {...stop}>
				<ConfirmAction
					className="justify-end"
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
			</td>
		</tr>
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
					<th className="px-3 py-2 text-right w-24">Size</th>
					<th className="px-3 py-2 text-left w-40">Type</th>
					<th className="px-3 py-2 text-left w-44">Session</th>
					<th className="px-3 py-2 text-left w-44">Created</th>
					<th className="px-3 py-2 w-12" />
				</tr>
			</thead>
			<tbody>
				{rows.length === 0 ? (
					<tr>
						<td
							colSpan={7}
							className="px-3 py-12 text-center text-muted-foreground/50"
						>
							no relics
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

	return (
		<div className="h-full flex flex-col">
			<RelicsHeader list={list} />
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
				<RelicsTable
					list={list}
					expandedId={expandedId}
					setExpandedId={setExpandedId}
					onView={setViewerImg}
					onDelete={(id) => void deleteOne(id)}
				/>
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
