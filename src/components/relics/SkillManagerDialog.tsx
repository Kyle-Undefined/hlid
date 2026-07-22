import { ExternalLink, PackagePlus, Search, X } from "lucide-react";
import { type MouseEvent, useCallback, useEffect, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import { useDialogFocus } from "#/hooks/useDialogFocus";
import { fmtBytes } from "#/lib/formatters";

export type ManagedAgentSkill = {
	id: string;
	name: string;
	description: string;
	source: string;
	sourceUrl: string | null;
	resolvedSha: string | null;
	importedAt: string | null;
	fileCount: number;
	bytes: number;
};

export type RemoteAgentSkill = {
	name: string;
	sourceUrl: string;
	repositoryPath: string;
	alreadyInstalled: boolean;
};

export type RemoteSkillDiscovery = {
	repository: string;
	requestedRef: string;
	resolvedSha: string;
	skills: RemoteAgentSkill[];
};

export type StagedAgentSkill = {
	id: string;
	name: string;
	description: string;
	sourceUrl: string;
	repository: string;
	requestedRef: string;
	resolvedSha: string;
	repositoryPath: string;
	createdAt: string;
	files: Array<{ path: string; bytes: number; readable: boolean }>;
	fileCount: number;
	bytes: number;
	skillDocument: string;
};

type SkillDocument = { id: string; name: string; content: string };

export function SkillManagerDialog({
	onClose,
	onChanged,
	listManaged,
	discoverSkills,
	stageSkill,
	readStagedFile,
	installSkill,
	discardSkill,
	readManagedSkill,
	removeSkill,
}: {
	onClose: () => void;
	onChanged?: (message: string) => void;
	listManaged: () => Promise<{ skills: ManagedAgentSkill[] }>;
	discoverSkills: (input: {
		data: { source: string };
	}) => Promise<{ ok: true; discovery: RemoteSkillDiscovery }>;
	stageSkill: (input: {
		data: { sourceUrl: string };
	}) => Promise<{ ok: true; skill: StagedAgentSkill }>;
	readStagedFile: (input: {
		data: { id: string; path: string };
	}) => Promise<{ path: string; content: string }>;
	installSkill: (input: {
		data: { id: string };
	}) => Promise<{ ok: true; installed: { id: string; name: string } }>;
	discardSkill: (input: { data: { id: string } }) => Promise<{ ok: true }>;
	readManagedSkill: (input: { data: { id: string } }) => Promise<SkillDocument>;
	removeSkill: (input: {
		data: { id: string };
	}) => Promise<{ ok: true; removed: { id: string; name: string } }>;
}) {
	const [managed, setManaged] = useState<ManagedAgentSkill[]>([]);
	const [sourceUrl, setSourceUrl] = useState("");
	const [staged, setStaged] = useState<StagedAgentSkill | null>(null);
	const [selectedFile, setSelectedFile] = useState("SKILL.md");
	const [selectedContent, setSelectedContent] = useState("");
	const [discovery, setDiscovery] = useState<RemoteSkillDiscovery | null>(null);
	const [discoveryQuery, setDiscoveryQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState<string | null>(null);
	const [expandedManaged, setExpandedManaged] = useState<string | null>(null);
	const [managedDocuments, setManagedDocuments] = useState(
		new Map<string, string>(),
	);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const close = useCallback(() => {
		if (busy) return;
		if (staged) {
			void discardSkill({ data: { id: staged.id } }).finally(onClose);
			return;
		}
		onClose();
	}, [busy, discardSkill, onClose, staged]);
	const { dialogRef, onDialogKeyDown } = useDialogFocus<HTMLDivElement>(close);

	const refreshManaged = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setManaged((await listManaged()).skills);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Unable to load skills",
			);
		} finally {
			setLoading(false);
		}
	}, [listManaged]);

	useEffect(() => {
		void refreshManaged();
	}, [refreshManaged]);

	const stageSource = async (url: string, fromDiscovery = false) => {
		if (!url.trim() || (busy && !fromDiscovery)) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await stageSkill({ data: { sourceUrl: url.trim() } });
			setStaged(result.skill);
			setSelectedFile("SKILL.md");
			setSelectedContent(result.skill.skillDocument);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Unable to stage skill",
			);
		} finally {
			setBusy(false);
		}
	};

	const findSkills = async () => {
		if (!sourceUrl.trim() || busy) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await discoverSkills({
				data: { source: sourceUrl.trim() },
			});
			if (result.discovery.skills.length === 1) {
				setBusy(false);
				await stageSource(result.discovery.skills[0]?.sourceUrl ?? "", true);
				return;
			}
			setDiscovery(result.discovery);
			setDiscoveryQuery("");
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Unable to discover skills",
			);
		} finally {
			setBusy(false);
		}
	};

	const decline = async () => {
		if (!staged || busy) return;
		setBusy(true);
		setError(null);
		try {
			await discardSkill({ data: { id: staged.id } });
			setStaged(null);
			setSelectedContent("");
			setNotice(`${staged.name} declined`);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Unable to decline skill",
			);
		} finally {
			setBusy(false);
		}
	};

	const approve = async () => {
		if (!staged || busy) return;
		setBusy(true);
		setError(null);
		try {
			const result = await installSkill({ data: { id: staged.id } });
			const summary = `${result.installed.name} added to Hlid`;
			setStaged(null);
			setSelectedContent("");
			setNotice(summary);
			onChanged?.(summary);
			await refreshManaged();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Unable to add skill");
		} finally {
			setBusy(false);
		}
	};

	const selectFile = async (path: string) => {
		if (!staged || path === selectedFile) return;
		const file = staged.files.find((candidate) => candidate.path === path);
		if (!file?.readable) return;
		setSelectedFile(path);
		if (path === "SKILL.md") {
			setSelectedContent(staged.skillDocument);
			return;
		}
		setSelectedContent("Loading…");
		try {
			const result = await readStagedFile({ data: { id: staged.id, path } });
			setSelectedContent(result.content);
		} catch (cause) {
			setSelectedContent("");
			setError(cause instanceof Error ? cause.message : "Unable to read file");
		}
	};

	const toggleManagedDocument = async (
		event: MouseEvent<HTMLButtonElement>,
		skill: ManagedAgentSkill,
	) => {
		event.preventDefault();
		if (expandedManaged === skill.id) {
			setExpandedManaged(null);
			return;
		}
		setExpandedManaged(skill.id);
		if (managedDocuments.has(skill.id)) return;
		try {
			const document = await readManagedSkill({ data: { id: skill.id } });
			setManagedDocuments((current) =>
				new Map(current).set(skill.id, document.content),
			);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Unable to read SKILL.md",
			);
		}
	};

	const runRemove = async (skill: ManagedAgentSkill) => {
		if (removing) return;
		setRemoving(skill.id);
		setError(null);
		try {
			const result = await removeSkill({ data: { id: skill.id } });
			setManaged((current) => current.filter((item) => item.id !== skill.id));
			const summary = `${result.removed.name} removed from Hlid`;
			setNotice(summary);
			onChanged?.(summary);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Unable to remove skill",
			);
		} finally {
			setRemoving(null);
		}
	};

	const filteredDiscovery = (discovery?.skills ?? []).filter((skill) =>
		`${skill.name} ${skill.repositoryPath}`
			.toLowerCase()
			.includes(discoveryQuery.trim().toLowerCase()),
	);

	return (
		<div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-2 md:p-4">
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-labelledby="skill-manager-title"
				className="w-full max-w-3xl h-[min(90dvh,820px)] bg-card border border-border shadow-2xl flex flex-col overflow-hidden focus:outline-none"
				onKeyDown={onDialogKeyDown}
			>
				<div className="shrink-0 px-4 py-3 border-b border-border flex items-start justify-between gap-4">
					<div>
						<div
							id="skill-manager-title"
							className="text-[10px] tracking-widest uppercase text-foreground"
						>
							Agent skills
						</div>
						<p className="mt-1 text-[10px] text-muted-foreground">
							Review and manage skills Hlid provides to CLI agents.
						</p>
					</div>
					<button
						type="button"
						onClick={close}
						disabled={busy}
						aria-label="Close agent skills"
						className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
					>
						<X className="w-4 h-4" />
					</button>
				</div>

				{staged ? (
					<SkillReview
						skill={staged}
						selectedFile={selectedFile}
						selectedContent={selectedContent}
						busy={busy}
						onSelectFile={(path) => void selectFile(path)}
						onDecline={() => void decline()}
						onApprove={() => void approve()}
					/>
				) : (
					<>
						<div className="shrink-0 p-4 border-b border-border space-y-3">
							<div className="text-[9px] tracking-widest uppercase text-primary">
								Add a skill
							</div>
							<div className="flex flex-col sm:flex-row gap-2">
								<input
									value={sourceUrl}
									onChange={(event) => {
										setSourceUrl(event.target.value);
										setDiscovery(null);
									}}
									placeholder="owner/repo or GitHub or skills.sh URL"
									aria-label="Skill source"
									className="min-w-0 flex-1 bg-background border border-border px-3 py-2 text-[11px] focus:outline-none focus:border-primary/50"
								/>
								<button
									type="button"
									onClick={() => void findSkills()}
									disabled={!sourceUrl.trim() || busy}
									className="px-4 py-2 text-[9px] tracking-widest uppercase border border-primary text-primary hover:bg-primary/10 disabled:opacity-30"
								>
									{busy ? "Finding…" : "Find skills"}
								</button>
							</div>
							<p className="text-[9px] text-muted-foreground/60">
								Paste one skill or a repository. Repositories are scanned for
								SKILL.md packages before anything is downloaded.
							</p>
							{discovery && (
								<div className="border border-border">
									<div className="px-3 py-2 border-b border-border text-[9px] text-muted-foreground/70">
										{discovery.repository} · {discovery.skills.length} skills ·{" "}
										{discovery.resolvedSha.slice(0, 12)}
									</div>
									<div className="flex items-center border-b border-border">
										<Search className="w-3 h-3 mx-2 text-muted-foreground/60" />
										<input
											value={discoveryQuery}
											onChange={(event) =>
												setDiscoveryQuery(event.target.value)
											}
											placeholder="Filter found skills"
											aria-label="Filter found skills"
											className="min-w-0 flex-1 bg-transparent py-2 pr-2 text-[10px] focus:outline-none"
										/>
									</div>
									<div className="max-h-40 overflow-auto divide-y divide-border/60">
										{filteredDiscovery.map((skill) => (
											<div
												key={skill.repositoryPath}
												className="flex items-center justify-between gap-3 px-3 py-2"
											>
												<span className="min-w-0 text-[10px]">
													{skill.name}
													<span className="block text-[8px] text-muted-foreground/50 break-all">
														{skill.repositoryPath}
													</span>
												</span>
												<button
													type="button"
													onClick={() => void stageSource(skill.sourceUrl)}
													disabled={skill.alreadyInstalled || busy}
													className="text-[8px] tracking-widest uppercase text-primary disabled:text-status-success disabled:opacity-70"
												>
													{skill.alreadyInstalled ? "In Hlid" : "Review"}
												</button>
											</div>
										))}
									</div>
								</div>
							)}
						</div>

						<div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-3">
							<div className="flex items-center justify-between">
								<div className="text-[9px] tracking-widest uppercase text-primary">
									In Hlid
								</div>
								<span className="text-[9px] text-muted-foreground/60 tabular-nums">
									{managed.length}
								</span>
							</div>
							{loading ? (
								<div className="py-10 text-center text-[10px] text-muted-foreground">
									Loading managed skills…
								</div>
							) : managed.length === 0 ? (
								<div className="py-10 text-center text-[10px] text-muted-foreground border border-border">
									No agent skills are managed by Hlid yet.
								</div>
							) : (
								<div className="border border-border divide-y divide-border/60">
									{managed.map((skill) => (
										<div key={skill.id} className="p-3">
											<div className="flex items-start justify-between gap-4">
												<span className="min-w-0">
													<span className="text-[11px] text-foreground">
														{skill.name}
													</span>
													{skill.description && (
														<span className="block mt-1 text-[10px] text-muted-foreground">
															{skill.description}
														</span>
													)}
													<span className="block mt-1 text-[9px] text-muted-foreground/50">
														{skill.source} · {skill.fileCount} files ·{" "}
														{fmtBytes(skill.bytes)}
													</span>
												</span>
												<ConfirmAction
													label={`remove ${skill.name}?`}
													confirmText="remove"
													onConfirm={() => void runRemove(skill)}
													trigger={(open) => (
														<button
															type="button"
															onClick={open}
															disabled={Boolean(removing)}
															className="text-[8px] tracking-widest uppercase text-destructive/70 hover:text-destructive disabled:opacity-30"
														>
															{removing === skill.id ? "Removing…" : "Remove"}
														</button>
													)}
												/>
											</div>
											<button
												type="button"
												onClick={(event) =>
													void toggleManagedDocument(event, skill)
												}
												className="mt-2 text-[9px] tracking-widest uppercase text-primary"
											>
												{expandedManaged === skill.id
													? "Hide SKILL.md"
													: "Read SKILL.md"}
											</button>
											{expandedManaged === skill.id && (
												<pre className="mt-2 max-h-64 overflow-auto border border-border bg-background/70 p-3 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed select-text">
													{managedDocuments.get(skill.id) ?? "Loading…"}
												</pre>
											)}
										</div>
									))}
								</div>
							)}
						</div>
					</>
				)}

				{notice && (
					<output className="block shrink-0 px-4 py-2 border-t border-border text-[10px] text-status-success">
						{notice}
					</output>
				)}
				{error && (
					<div className="shrink-0 px-4 py-2 border-t border-border text-[10px] text-destructive/80">
						{error}
					</div>
				)}
			</div>
		</div>
	);
}

function SkillReview({
	skill,
	selectedFile,
	selectedContent,
	busy,
	onSelectFile,
	onDecline,
	onApprove,
}: {
	skill: StagedAgentSkill;
	selectedFile: string;
	selectedContent: string;
	busy: boolean;
	onSelectFile: (path: string) => void;
	onDecline: () => void;
	onApprove: () => void;
}) {
	return (
		<>
			<div className="shrink-0 px-4 py-3 border-b border-border space-y-2">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<PackagePlus className="w-4 h-4 text-primary" />
							<h3 className="text-sm text-foreground">{skill.name}</h3>
						</div>
						{skill.description && (
							<p className="mt-1 text-[10px] text-muted-foreground">
								{skill.description}
							</p>
						)}
					</div>
					<a
						href={skill.sourceUrl}
						target="_blank"
						rel="noreferrer"
						className="p-1 text-muted-foreground hover:text-primary"
						aria-label="Open reviewed source on GitHub"
					>
						<ExternalLink className="w-3.5 h-3.5" />
					</a>
				</div>
				<div className="text-[9px] text-muted-foreground/60 font-mono break-all">
					{skill.repository} · {skill.repositoryPath} ·{" "}
					{skill.resolvedSha.slice(0, 12)}
				</div>
				<div className="text-[9px] text-muted-foreground/60">
					{skill.fileCount} files · {fmtBytes(skill.bytes)} · review is pinned
					to the resolved commit
				</div>
			</div>
			<div className="flex-1 min-h-0 grid grid-cols-[minmax(150px,0.34fr)_minmax(0,1fr)]">
				<div className="overflow-auto border-r border-border p-2">
					{skill.files.map((file) => (
						<button
							key={file.path}
							type="button"
							onClick={() => onSelectFile(file.path)}
							disabled={!file.readable}
							className={`w-full text-left px-2 py-1.5 text-[9px] break-all border-l-2 ${selectedFile === file.path ? "border-primary bg-primary/5 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"} disabled:opacity-40 disabled:hover:text-muted-foreground`}
						>
							<span className="block">{file.path}</span>
							<span className="text-[8px] opacity-60">
								{fmtBytes(file.bytes)}
							</span>
						</button>
					))}
				</div>
				<div className="min-w-0 overflow-auto bg-background/70 p-4">
					<div className="mb-2 text-[9px] tracking-widest uppercase text-primary break-all">
						{selectedFile}
					</div>
					<pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-foreground select-text">
						{selectedContent}
					</pre>
				</div>
			</div>
			<div className="shrink-0 px-4 py-3 border-t border-border flex items-center justify-end gap-2">
				<button
					type="button"
					onClick={onDecline}
					disabled={busy}
					className="px-4 py-2 text-[9px] tracking-widest uppercase border border-border text-muted-foreground hover:text-foreground disabled:opacity-30"
				>
					Decline
				</button>
				<button
					type="button"
					onClick={onApprove}
					disabled={busy}
					className="px-4 py-2 text-[9px] tracking-widest uppercase border border-primary text-primary hover:bg-primary/10 disabled:opacity-30"
				>
					{busy ? "Adding…" : "Add to Hlid"}
				</button>
			</div>
		</>
	);
}
