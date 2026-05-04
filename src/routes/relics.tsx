import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
	ChevronDown,
	ChevronRight,
	File as FileIcon,
	Search,
	Trash2,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import { getConfig } from "#/config";
import type { AttachmentRow } from "#/db";
import { useWs } from "#/hooks/useWs";
import type { ServerMessage } from "#/server/protocol";

type ListResult = {
	rows: AttachmentRow[];
	total: number;
	total_bytes: number;
};

const listAttachmentsFn = createServerFn({ method: "POST" })
	.inputValidator(
		(data: {
			search?: string;
			session_id?: string;
			limit: number;
			offset: number;
		}) => data,
	)
	.handler(async ({ data }) => {
		const { server } = await getConfig();
		const params = new URLSearchParams();
		if (data.search) params.set("search", data.search);
		if (data.session_id) params.set("session_id", data.session_id);
		params.set("limit", String(data.limit));
		params.set("offset", String(data.offset));
		const res = await fetch(
			`http://localhost:${server.port + 1}/db/attachments?${params.toString()}`,
		);
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
	component: AttachmentsPage,
});

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(unix: number): string {
	return new Date(unix * 1000).toLocaleString();
}

const PAGE_SIZE = 50;

function RelicPreview({ id, mime }: { id: string; mime: string }) {
	const [text, setText] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const isImage = mime.startsWith("image/");
	const isText = mime.startsWith("text/") || mime === "application/json";
	const isPdf = mime === "application/pdf";

	useEffect(() => {
		if (!isText) return;
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
	}, [id, isText]);

	if (isImage) {
		return (
			<img
				src={`/api/attachments/${id}/raw`}
				alt=""
				className="max-h-96 max-w-full object-contain"
			/>
		);
	}
	if (isPdf) {
		return (
			<iframe
				src={`/api/attachments/${id}/raw`}
				className="w-full h-96 border-0"
				title="pdf preview"
			/>
		);
	}
	if (isText) {
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
	return (
		<span className="text-[11px] text-muted-foreground/50">no preview</span>
	);
}

function AttachmentsPage() {
	const { initial } = Route.useLoaderData();
	const [rows, setRows] = useState<AttachmentRow[]>(initial.rows);
	const [total, setTotal] = useState(initial.total);
	const [totalBytes, setTotalBytes] = useState(initial.total_bytes);
	const [page, setPage] = useState(1);
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const [confirmDeleteBulk, setConfirmDeleteBulk] = useState(false);

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
				const res = await listAttachmentsFn({
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
		[search],
	);

	const handleWsMessage = useCallback(
		(msg: ServerMessage) => {
			if (msg.type === "attachment_created") void reload(1);
		},
		[reload],
	);
	useWs(handleWsMessage);

	const toggle = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleAll = () => {
		setSelected((prev) =>
			prev.size === rows.length
				? new Set<string>()
				: new Set(rows.map((r) => r.id)),
		);
	};

	const deleteOne = async (id: string) => {
		setConfirmDeleteId(null);
		const row = rows.find((r) => r.id === id);
		if (!row) return;
		setBusy(true);
		try {
			const res = await fetch(`/api/attachments/${row.id}`, {
				method: "DELETE",
			});
			if (!res.ok) {
				setError(`delete failed (${res.status})`);
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
		setConfirmDeleteBulk(false);
		setBusy(true);
		try {
			const failures: string[] = [];
			for (const id of ids) {
				const row = rows.find((r) => r.id === id);
				if (!row) continue;
				const res = await fetch(`/api/attachments/${row.id}`, {
					method: "DELETE",
				});
				if (!res.ok) failures.push(row.filename);
			}
			if (failures.length > 0)
				setError(`Delete failed: ${failures.join(", ")}`);
			await reload(page);
		} finally {
			setBusy(false);
		}
	};

	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	return (
		<div className="h-full flex flex-col">
			<div className="px-5 py-4 border-b border-border">
				<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
					<div>
						<div className="text-[11px] tracking-[0.3em] text-muted-foreground uppercase">
							Relics
						</div>
						<PrivacyMask inline className="text-sm font-bold mt-0.5">
							{total} {total === 1 ? "file" : "files"} ·{" "}
							{formatBytes(totalBytes)}
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

			{selected.size > 0 && (
				<div className="px-5 py-2 border-b border-border bg-secondary/30 flex items-center justify-between">
					<span className="text-[11px] tracking-widest uppercase text-foreground">
						{selected.size} selected
					</span>
					{confirmDeleteBulk ? (
						<div className="flex items-center gap-2">
							<span className="text-[9px] text-muted-foreground/50">
								delete {selected.size}?
							</span>
							<button
								type="button"
								onClick={() => void deleteSelected()}
								disabled={busy}
								className="text-[9px] tracking-widest text-destructive/60 hover:text-destructive uppercase transition-colors disabled:opacity-30"
							>
								confirm
							</button>
							<button
								type="button"
								onClick={() => setConfirmDeleteBulk(false)}
								className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
							>
								cancel
							</button>
						</div>
					) : (
						<button
							type="button"
							onClick={() => setConfirmDeleteBulk(true)}
							disabled={busy}
							className="px-3 py-1.5 text-[10px] tracking-widest text-destructive/80 hover:text-destructive border border-destructive/40 uppercase disabled:opacity-30 inline-flex items-center gap-1.5"
						>
							<Trash2 className="w-3 h-3" />
							Delete
						</button>
					)}
				</div>
			)}

			<div className="flex-1 overflow-auto">
				<table className="w-full min-w-[720px] text-[11px]">
					<thead className="text-[9px] tracking-widest uppercase text-muted-foreground/70">
						<tr className="border-b border-border">
							<th className="px-3 py-2 text-left w-8">
								<input
									type="checkbox"
									checked={rows.length > 0 && selected.size === rows.length}
									onChange={toggleAll}
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
									<tr
										className="border-b border-border/40 hover:bg-secondary/20 cursor-pointer"
										onClick={() =>
											setExpandedId(expandedId === r.id ? null : r.id)
										}
									>
										<td
											className="px-3 py-2"
											onClick={(e) => e.stopPropagation()}
											onKeyDown={(e) => e.stopPropagation()}
										>
											<input
												type="checkbox"
												checked={selected.has(r.id)}
												onChange={() => toggle(r.id)}
											/>
										</td>
										<td className="px-3 py-2">
											<div className="flex items-center gap-1.5">
												{expandedId === r.id ? (
													<ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground/50" />
												) : (
													<ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground/50" />
												)}
												{r.mime.startsWith("image/") ? (
													<img
														src={`/api/attachments/${r.id}/raw`}
														alt={r.filename}
														className="w-6 h-6 object-cover shrink-0"
													/>
												) : (
													<FileIcon className="w-3 h-3 shrink-0 opacity-60" />
												)}
												<PrivacyMask inline>
													<a
														href={`/api/attachments/${r.id}/raw`}
														target="_blank"
														rel="noreferrer"
														onClick={(e) => e.stopPropagation()}
														className="font-mono truncate max-w-[260px] text-foreground hover:text-primary"
													>
														{r.filename}
													</a>
												</PrivacyMask>
											</div>
										</td>
										<td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
											<PrivacyMask inline>
												{formatBytes(r.size_bytes)}
											</PrivacyMask>
										</td>
										<td className="px-3 py-2 font-mono text-muted-foreground/70 truncate">
											{r.mime}
										</td>
										<td className="px-3 py-2 font-mono text-muted-foreground/60 truncate">
											{r.session_id ? r.session_id.slice(0, 12) : "?"}
										</td>
										<td className="px-3 py-2 text-muted-foreground/70 tabular-nums">
											{formatDate(r.created_at)}
										</td>
										<td
											className="px-3 py-2 text-right"
											onClick={(e) => e.stopPropagation()}
											onKeyDown={(e) => e.stopPropagation()}
										>
											{confirmDeleteId === r.id ? (
												<div className="flex items-center justify-end gap-1.5">
													<button
														type="button"
														onClick={() => void deleteOne(r.id)}
														className="text-[9px] tracking-widest text-destructive/60 hover:text-destructive uppercase transition-colors"
													>
														confirm
													</button>
													<button
														type="button"
														onClick={() => setConfirmDeleteId(null)}
														className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
													>
														cancel
													</button>
												</div>
											) : (
												<button
													type="button"
													onClick={() => setConfirmDeleteId(r.id)}
													disabled={busy}
													className="text-muted-foreground/50 hover:text-destructive disabled:opacity-30"
													aria-label={`Delete ${r.filename}`}
												>
													<Trash2 className="w-3.5 h-3.5" />
												</button>
											)}
										</td>
									</tr>
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
			</div>

			{totalPages > 1 && (
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
			)}
		</div>
	);
}
