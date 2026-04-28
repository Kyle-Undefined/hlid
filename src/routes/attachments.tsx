import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { File as FileIcon, Search, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { getConfig } from "#/config";
import type { AttachmentRow } from "#/db";
import { useWs } from "#/hooks/useWs";
import { uid } from "#/lib/utils";

type ListResult = {
	rows: AttachmentRow[];
	total: number;
	total_bytes: number;
};

const listAttachmentsFn = createServerFn({ method: "POST" })
	.inputValidator(
		(data: {
			kind?: "ephemeral" | "vault";
			search?: string;
			session_id?: string;
			limit: number;
			offset: number;
		}) => data,
	)
	.handler(async ({ data }) => {
		const { server } = await getConfig();
		const params = new URLSearchParams();
		if (data.kind) params.set("kind", data.kind);
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

export const Route = createFileRoute("/attachments")({
	loader: async () => {
		const [initial, config] = await Promise.all([
			listAttachmentsFn({ data: { limit: 50, offset: 0 } }),
			getConfig(),
		]);
		return { initial, config };
	},
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

function buildSkillPrompt(opts: {
	dataPort: number;
	vaultPath: string;
	vaultFolder: string;
	skillsFolder: string;
}): string {
	const { dataPort, vaultPath, vaultFolder, skillsFolder } = opts;
	return `Create a vault skill for the hlid attachments API.

Data API base URL: \`http://127.0.0.1:${dataPort}\`

Endpoints:
  POST   /api/attachments/upload          (multipart: file, kind=ephemeral|vault, session_id?)
  GET    /api/attachments/:id/raw         (stream the file)
  DELETE /api/attachments/:id             (vault deletes require ?confirm_vault=1)
  GET    /db/attachments?kind=&session_id=&search=&limit=&offset=
  GET    /db/session-messages?session_id=ID  (each user message includes attachments[])

Storage layout:
  Vault root: \`${vaultPath}\`
  Ephemeral:  \`${vaultPath}/.hlid/attachments/<sessionId>/<filename>\`
  Vault:      \`${vaultPath}/${vaultFolder}/<filename>\`

Cascade behavior:
  Deleting a session removes ephemeral attachment files + rows; vault rows survive with session_id NULL.
  Vault attachments are never auto-deleted.

Create the skill file at \`${skillsFolder}/<skill-name>.md\` with YAML frontmatter containing \`name\` and \`description\` fields. Register it in \`${skillsFolder}/index.md\` under an appropriate section using the pipe table format:
## Section Name
| \`skill-name\` | one-line description |`;
}

function AttachmentsPage() {
	const { initial, config } = Route.useLoaderData();
	const [rows, setRows] = useState<AttachmentRow[]>(initial.rows);
	const [total, setTotal] = useState(initial.total);
	const [totalBytes, setTotalBytes] = useState(initial.total_bytes);
	const [page, setPage] = useState(1);
	const [kind, setKind] = useState<"all" | "ephemeral" | "vault">("all");
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [headerAction, setHeaderAction] = useState<"build" | null>(null);
	const { wsStatus, send } = useWs();
	const connected = wsStatus === "connected";

	const handleBuildSkill = () => {
		const skillsFolder = config.vault.skills
			? `${config.vault.path}/${config.vault.skills}`
			: `${config.vault.path}/.claude/skills`;
		send({
			type: "chat",
			text: buildSkillPrompt({
				dataPort: config.server.port + 1,
				vaultPath: config.vault.path,
				vaultFolder: config.attachments.vault_folder,
				skillsFolder,
			}),
			session_id: uid(),
		});
	};

	const reload = useCallback(
		async (
			nextPage: number,
			nextKind: "all" | "ephemeral" | "vault" = kind,
			nextSearch: string = search,
		) => {
			setBusy(true);
			setError(null);
			try {
				const res = await listAttachmentsFn({
					data: {
						kind: nextKind === "all" ? undefined : nextKind,
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
		[kind, search],
	);

	const changeKind = (k: "all" | "ephemeral" | "vault") => {
		setKind(k);
		void reload(1, k, search);
	};

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

	const deleteOne = async (row: AttachmentRow) => {
		if (
			row.kind === "vault" &&
			!confirm(`Delete vault file ${row.filename}? This cannot be undone.`)
		)
			return;
		const url = `/api/attachments/${row.id}${row.kind === "vault" ? "?confirm_vault=1" : ""}`;
		const res = await fetch(url, { method: "DELETE" });
		if (!res.ok) {
			setError(`delete failed (${res.status})`);
			return;
		}
		await reload(page);
	};

	const deleteSelected = async () => {
		const ids = Array.from(selected);
		if (ids.length === 0) return;
		const vaultRows = rows.filter(
			(r) => selected.has(r.id) && r.kind === "vault",
		);
		if (
			vaultRows.length > 0 &&
			!confirm(
				`${vaultRows.length} vault file(s) selected. Delete all ${ids.length}? This cannot be undone.`,
			)
		)
			return;
		setBusy(true);
		try {
			const failures: string[] = [];
			for (const id of ids) {
				const row = rows.find((r) => r.id === id);
				if (!row) continue;
				const url = `/api/attachments/${row.id}${row.kind === "vault" ? "?confirm_vault=1" : ""}`;
				const res = await fetch(url, { method: "DELETE" });
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
						<div className="text-sm font-bold mt-0.5">
							{total} {total === 1 ? "file" : "files"} ·{" "}
							{formatBytes(totalBytes)}
						</div>
					</div>
					<div className="flex items-center gap-2 flex-wrap">
						<div className="flex border border-border">
							{(["all", "ephemeral", "vault"] as const).map((k) => (
								<button
									type="button"
									key={k}
									onClick={() => changeKind(k)}
									className={`px-3 py-1.5 text-[10px] tracking-widest uppercase ${
										kind === k
											? "bg-primary/10 text-primary"
											: "text-muted-foreground hover:text-foreground"
									}`}
								>
									{k === "all" ? "all" : k === "ephemeral" ? "ref" : "vault"}
								</button>
							))}
						</div>
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
						{connected &&
							(headerAction === null ? (
								<button
									type="button"
									onClick={() => setHeaderAction("build")}
									className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors px-2"
								>
									build skill
								</button>
							) : (
								<div className="flex items-center gap-2 px-2">
									<span className="text-[9px] text-muted-foreground/50">
										send to Claude?
									</span>
									<button
										type="button"
										onClick={() => {
											handleBuildSkill();
											setHeaderAction(null);
										}}
										className="text-[9px] tracking-widest text-primary/60 hover:text-primary uppercase transition-colors"
									>
										confirm
									</button>
									<button
										type="button"
										onClick={() => setHeaderAction(null)}
										className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
									>
										cancel
									</button>
								</div>
							))}
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
					<button
						type="button"
						onClick={deleteSelected}
						disabled={busy}
						className="px-3 py-1.5 text-[10px] tracking-widest text-destructive/80 hover:text-destructive border border-destructive/40 uppercase disabled:opacity-30 inline-flex items-center gap-1.5"
					>
						<Trash2 className="w-3 h-3" />
						Delete
					</button>
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
							<th className="px-3 py-2 text-left w-20">Kind</th>
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
									colSpan={8}
									className="px-3 py-12 text-center text-muted-foreground/50"
								>
									no relics
								</td>
							</tr>
						) : (
							rows.map((r) => (
								<tr
									key={r.id}
									className="border-b border-border/40 hover:bg-secondary/20"
								>
									<td className="px-3 py-2">
										<input
											type="checkbox"
											checked={selected.has(r.id)}
											onChange={() => toggle(r.id)}
										/>
									</td>
									<td className="px-3 py-2">
										<a
											href={`/api/attachments/${r.id}/raw`}
											target="_blank"
											rel="noreferrer"
											className="inline-flex items-center gap-2 text-foreground hover:text-primary"
										>
											{r.mime.startsWith("image/") ? (
												<img
													src={`/api/attachments/${r.id}/raw`}
													alt={r.filename}
													className="w-6 h-6 object-cover shrink-0"
												/>
											) : (
												<FileIcon className="w-3 h-3 shrink-0 opacity-60" />
											)}
											<span className="font-mono truncate max-w-[280px]">
												{r.filename}
											</span>
										</a>
									</td>
									<td className="px-3 py-2 uppercase tracking-widest text-[9px]">
										{r.kind === "vault" ? (
											<span className="text-primary/80">vault</span>
										) : (
											<span className="text-muted-foreground/70">ref</span>
										)}
									</td>
									<td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
										{formatBytes(r.size_bytes)}
									</td>
									<td className="px-3 py-2 font-mono text-muted-foreground/70 truncate">
										{r.mime}
									</td>
									<td className="px-3 py-2 font-mono text-muted-foreground/60 truncate">
										{r.session_id ? r.session_id.slice(0, 12) : "—"}
									</td>
									<td className="px-3 py-2 text-muted-foreground/70 tabular-nums">
										{formatDate(r.created_at)}
									</td>
									<td className="px-3 py-2 text-right">
										<button
											type="button"
											onClick={() => deleteOne(r)}
											disabled={busy}
											className="text-muted-foreground/50 hover:text-destructive disabled:opacity-30"
											aria-label={`Delete ${r.filename}`}
										>
											<Trash2 className="w-3.5 h-3.5" />
										</button>
									</td>
								</tr>
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
