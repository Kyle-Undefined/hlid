import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
	Bot,
	ChevronDown,
	ChevronRight,
	MessageSquare,
	Pencil,
	Plus,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import { FolderBrowser } from "#/components/wizard/FolderBrowser";
import type { Agent } from "#/config";
import { getConfig } from "#/config";
import { writeConfig } from "#/lib/config-writer";
import { expandTilde, samePath } from "#/lib/paths";
import { uid } from "#/lib/utils";

// ─── server fns ──────────────────────────────────────────────────────────────

type AgentEntry = {
	path: string;
	name: string;
	mode: "cwd" | "context";
	hasClaudemd: boolean;
	dirExists: boolean;
};

function deriveAgentName(p: string): string {
	return basename(p)
		.split(/[-_\s]+/)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

const getAgentsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<AgentEntry[]> => {
		const config = await getConfig();
		return (config.agents ?? []).map((agent) => {
			const resolved = expandTilde(agent.path);
			return {
				path: agent.path,
				name: agent.name ?? deriveAgentName(resolved),
				mode: agent.mode ?? "cwd",
				hasClaudemd: existsSync(join(resolved, "CLAUDE.md")),
				dirExists: existsSync(resolved),
			};
		});
	},
);

const validateAgentPathFn = createServerFn({ method: "GET" })
	.inputValidator((agentPath: string) => agentPath)
	.handler(async ({ data: agentPath }) => {
		const config = await getConfig();
		const resolved = resolve(expandTilde(agentPath));
		const vaultPath = config.vault.path
			? resolve(expandTilde(config.vault.path))
			: "";
		let inVault = false;
		if (vaultPath) {
			const rel = relative(vaultPath, resolved);
			inVault =
				samePath(resolved, vaultPath) ||
				(!rel.startsWith("..") && !isAbsolute(rel));
		}
		return {
			dirExists: existsSync(resolved),
			hasClaudemd: existsSync(join(resolved, "CLAUDE.md")),
			suggestedName: deriveAgentName(resolved),
			inVault,
			externalAllowed: config.server.allow_external_agents,
			resolvedPath: resolved,
		};
	});

const saveAgentsFn = createServerFn({ method: "POST" })
	.inputValidator((data: Agent[]) => data)
	.handler(async ({ data: agentList }) => {
		const config = await getConfig();
		writeConfig({ ...config, agents: agentList });
	});

const readClaudemdFn = createServerFn({ method: "GET" })
	.inputValidator((agentPath: string) => agentPath)
	.handler(async ({ data: agentPath }) => {
		const config = await getConfig();
		const allowedPaths = (config.agents ?? []).map((a) =>
			resolve(expandTilde(a.path)),
		);
		const requested = resolve(expandTilde(agentPath));
		if (!allowedPaths.some((p) => samePath(p, requested)))
			throw new Error("Unauthorized");
		const claudemdPath = join(requested, "CLAUDE.md");
		if (!existsSync(claudemdPath)) return null;
		return readFileSync(claudemdPath, "utf-8");
	});

// ─── route ───────────────────────────────────────────────────────────────────

const getExternalAllowedFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const config = await getConfig();
		return config.server.allow_external_agents;
	},
);

type LoaderData = { agents: AgentEntry[]; externalAllowed: boolean };

export const Route = createFileRoute("/einherjar")({
	loader: async (): Promise<LoaderData> => ({
		agents: await getAgentsFn(),
		externalAllowed: await getExternalAllowedFn(),
	}),
	component: EinherjarPage,
});

// ─── component ───────────────────────────────────────────────────────────────

function EinherjarPage() {
	const { agents: initialAgents, externalAllowed } = Route.useLoaderData();
	const router = useRouter();
	const navigate = useNavigate();

	const [agents, setAgents] = useState<AgentEntry[]>(initialAgents);
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
	const [editingPath, setEditingPath] = useState<string | null>(null);
	const [editName, setEditName] = useState("");
	const [editMode, setEditMode] = useState<"cwd" | "context">("cwd");
	const [showAdd, setShowAdd] = useState(false);
	const [addPath, setAddPath] = useState("");
	const [addName, setAddName] = useState("");
	const [addMode, setAddMode] = useState<"cwd" | "context">("cwd");
	const [addError, setAddError] = useState<string | null>(null);
	const [addBrowseOpen, setAddBrowseOpen] = useState(false);
	const [expandedPath, setExpandedPath] = useState<string | null>(null);
	const [expandedContent, setExpandedContent] = useState<
		Record<string, string>
	>({});
	const [saving, setSaving] = useState(false);

	async function handleRemove(path: string) {
		setConfirmRemove(null);
		const next = agents.filter((a) => a.path !== path);
		await saveAgentsFn({
			data: next.map((a) => ({ path: a.path, name: a.name, mode: a.mode })),
		});
		setAgents(next);
		await router.invalidate();
	}

	function startEdit(agent: AgentEntry) {
		setEditingPath(agent.path);
		setEditName(agent.name);
		setEditMode(agent.mode);
		setConfirmRemove(null);
	}

	function cancelEdit() {
		setEditingPath(null);
		setEditName("");
		setEditMode("cwd");
	}

	async function saveEdit(originalPath: string) {
		const trimmedName = editName.trim();
		const prevAgents = agents;
		const next = agents.map((a) =>
			a.path === originalPath
				? { ...a, name: trimmedName || a.name, mode: editMode }
				: a,
		);
		setAgents(next);
		cancelEdit();
		try {
			await saveAgentsFn({
				data: next.map((a) => ({ path: a.path, name: a.name, mode: a.mode })),
			});
			await router.invalidate();
		} catch {
			setAgents(prevAgents);
		}
	}

	async function handleModeChange(path: string, mode: "cwd" | "context") {
		const prevAgents = agents;
		const next = agents.map((a) => (a.path === path ? { ...a, mode } : a));
		setAgents(next);
		try {
			await saveAgentsFn({
				data: next.map((a) => ({ path: a.path, name: a.name, mode: a.mode })),
			});
			await router.invalidate();
		} catch {
			setAgents(prevAgents);
		}
	}

	async function handleAdd() {
		if (!addPath.trim()) {
			setAddError("Path required");
			return;
		}
		const trimmed = addPath.trim();
		if (agents.some((a) => a.path === trimmed)) {
			setAddError("Agent already added");
			return;
		}
		setSaving(true);
		setAddError(null);
		try {
			const validation = await validateAgentPathFn({ data: trimmed });
			if (!validation.dirExists) {
				setAddError("Directory not found");
				return;
			}
			if (!validation.inVault && !validation.externalAllowed) {
				setAddError(
					"Directory outside vault. Enable 'Allow external agents' in Server settings.",
				);
				return;
			}

			const name = addName.trim() || validation.suggestedName;
			const next: Agent[] = [
				...agents.map((a) => ({ path: a.path, name: a.name, mode: a.mode })),
				{ path: trimmed, name, mode: addMode },
			];
			await saveAgentsFn({ data: next });
			await router.invalidate();
			const refreshed = await getAgentsFn();
			setAgents(refreshed);
			setAddPath("");
			setAddName("");
			setAddMode("cwd");
			setShowAdd(false);
		} catch (err) {
			setAddError(err instanceof Error ? err.message : "Failed to add agent");
		} finally {
			setSaving(false);
		}
	}

	async function handleToggleView(agent: AgentEntry) {
		if (expandedPath === agent.path) {
			setExpandedPath(null);
			return;
		}
		setExpandedPath(agent.path);
		if (!(agent.path in expandedContent)) {
			const text = await readClaudemdFn({ data: agent.path });
			if (text != null) {
				setExpandedContent((prev) => ({ ...prev, [agent.path]: text }));
			}
		}
	}

	function handleChat(agent: AgentEntry) {
		const sessionId = uid();
		void navigate({
			to: "/raven",
			search: {
				session: sessionId,
				agent: agent.path,
			},
		});
	}

	return (
		<div className="flex flex-col h-full">
			<div className="flex-1 overflow-auto p-5 space-y-6">
				{/* Header */}
				<div className="flex items-center justify-between">
					<div>
						<div className="text-[10px] tracking-widest text-muted-foreground uppercase">
							Einherjar
						</div>
						<div className="text-[9px] tracking-widest text-muted-foreground/40 mt-0.5">
							chosen warriors · vault agents
						</div>
					</div>
					<button
						type="button"
						onClick={() => {
							setShowAdd((v) => !v);
							setAddError(null);
						}}
						className="flex items-center gap-1.5 text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase"
					>
						<Plus className="w-3 h-3" />
						ADD
					</button>
				</div>

				{/* Add form */}
				{showAdd && (
					<div className="border border-border bg-card p-4 space-y-3">
						<div className="text-[9px] tracking-widest text-muted-foreground/60 uppercase">
							Register Agent Directory
						</div>
						<div className="space-y-2">
							<div className="flex items-center gap-2">
								<input
									type="text"
									value={addPath}
									onChange={(e) => {
										setAddPath(e.target.value);
										setAddError(null);
									}}
									placeholder="/path/to/agent-dir"
									className="flex-1 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
								/>
								<button
									type="button"
									onClick={() => setAddBrowseOpen(true)}
									className="text-[10px] tracking-widest px-2 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 uppercase"
								>
									BROWSE
								</button>
							</div>
							<input
								type="text"
								value={addName}
								onChange={(e) => setAddName(e.target.value)}
								placeholder="Display name (optional)"
								className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
							/>
							<div className="flex items-center gap-2">
								<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0">
									Mode
								</span>
								<div className="flex border border-border">
									<button
										type="button"
										onClick={() => setAddMode("cwd")}
										className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors ${
											addMode === "cwd"
												? "bg-primary/10 text-primary"
												: "text-muted-foreground/60 hover:text-foreground"
										}`}
									>
										CWD
									</button>
									<button
										type="button"
										onClick={() => setAddMode("context")}
										className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors border-l border-border ${
											addMode === "context"
												? "bg-primary/10 text-primary"
												: "text-muted-foreground/60 hover:text-foreground"
										}`}
									>
										CONTEXT
									</button>
								</div>
								<span className="text-[9px] text-muted-foreground/40 leading-snug">
									{addMode === "cwd"
										? "claude runs in agent's directory"
										: "claude stays in vault, loads CLAUDE.md as persona"}
								</span>
							</div>
						</div>
						{addError && (
							<div className="text-[10px] text-destructive/80">{addError}</div>
						)}
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => void handleAdd()}
								disabled={saving}
								className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/50 text-primary/70 hover:bg-primary/5 hover:text-primary transition-colors uppercase disabled:opacity-40"
							>
								{saving ? "ADDING..." : "ADD AGENT"}
							</button>
							<button
								type="button"
								onClick={() => {
									setShowAdd(false);
									setAddPath("");
									setAddName("");
									setAddMode("cwd");
									setAddError(null);
								}}
								className="text-[10px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground transition-colors uppercase"
							>
								CANCEL
							</button>
						</div>
					</div>
				)}

				{/* Agent list */}
				<div className="border border-border bg-card divide-y divide-border/50">
					{agents.length === 0 ? (
						<div className="px-4 py-8 flex flex-col items-center gap-2">
							<Bot className="w-6 h-6 text-muted-foreground/20" />
							<div className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
								No agents registered
							</div>
						</div>
					) : (
						agents.map((agent) => (
							<div key={agent.path} className="divide-y divide-border/50">
								<div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-3 hover:bg-accent transition-colors">
									<button
										type="button"
										onClick={() => void handleToggleView(agent)}
										disabled={!agent.hasClaudemd}
										className="flex flex-1 items-center gap-3 text-left min-w-0 disabled:cursor-default"
									>
										<span className="shrink-0 text-muted-foreground/40 transition-colors">
											{expandedPath === agent.path ? (
												<ChevronDown className="w-3.5 h-3.5" />
											) : (
												<ChevronRight className="w-3.5 h-3.5 opacity-40" />
											)}
										</span>
										<div className="flex-1 min-w-0">
											<div className="flex items-center gap-2">
												<PrivacyMask
													inline
													className="text-[11px] tracking-wide text-foreground"
												>
													{agent.name}
												</PrivacyMask>
												{!agent.dirExists && (
													<TriangleAlert className="w-3 h-3 text-yellow-500/70 shrink-0" />
												)}
											</div>
											<PrivacyMask className="text-[9px] font-mono text-muted-foreground/40 truncate mt-0.5">
												{agent.path}
											</PrivacyMask>
											{!agent.dirExists && (
												<div className="text-[9px] text-destructive/60 mt-0.5">
													directory missing
												</div>
											)}
										</div>
									</button>
									<div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
										<div className="flex border border-border/50">
											<button
												type="button"
												onClick={() => void handleModeChange(agent.path, "cwd")}
												title="Run claude in agent's directory"
												className={`text-[9px] tracking-widest px-1.5 py-0.5 uppercase transition-colors ${
													agent.mode === "cwd"
														? "bg-primary/10 text-primary"
														: "text-muted-foreground/40 hover:text-foreground"
												}`}
											>
												CWD
											</button>
											<button
												type="button"
												onClick={() =>
													void handleModeChange(agent.path, "context")
												}
												title="Stay in vault, load CLAUDE.md as persona"
												className={`text-[9px] tracking-widest px-1.5 py-0.5 uppercase transition-colors border-l border-border/50 ${
													agent.mode === "context"
														? "bg-primary/10 text-primary"
														: "text-muted-foreground/40 hover:text-foreground"
												}`}
											>
												CTX
											</button>
										</div>
										<button
											type="button"
											onClick={() => handleChat(agent)}
											title="Chat with agent"
											className="text-muted-foreground/40 hover:text-primary transition-colors"
										>
											<MessageSquare className="w-3.5 h-3.5" />
										</button>
										<button
											type="button"
											onClick={() => startEdit(agent)}
											title="Edit agent"
											className="text-muted-foreground/40 hover:text-primary transition-colors"
										>
											<Pencil className="w-3.5 h-3.5" />
										</button>
										{confirmRemove === agent.path ? (
											<div className="flex items-center gap-1.5">
												<span className="text-[9px] text-muted-foreground/50">
													remove?
												</span>
												<button
													type="button"
													onClick={() => void handleRemove(agent.path)}
													className="text-[9px] tracking-widest text-destructive/60 hover:text-destructive transition-colors"
												>
													confirm
												</button>
												<button
													type="button"
													onClick={() => setConfirmRemove(null)}
													className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors"
												>
													cancel
												</button>
											</div>
										) : (
											<button
												type="button"
												onClick={() => setConfirmRemove(agent.path)}
												className="text-muted-foreground/30 hover:text-destructive transition-colors text-base leading-none"
											>
												×
											</button>
										)}
									</div>
								</div>
								{editingPath === agent.path && (
									<div className="px-4 py-3 bg-secondary/30 space-y-2">
										<div className="text-[9px] tracking-widest text-muted-foreground/60 uppercase">
											Edit Agent
										</div>
										<input
											type="text"
											value={editName}
											onChange={(e) => setEditName(e.target.value)}
											placeholder="Display name"
											className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
										/>
										<div className="flex items-center gap-2 flex-wrap">
											<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0">
												Mode
											</span>
											<div className="flex border border-border">
												<button
													type="button"
													onClick={() => setEditMode("cwd")}
													className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors ${
														editMode === "cwd"
															? "bg-primary/10 text-primary"
															: "text-muted-foreground/60 hover:text-foreground"
													}`}
												>
													CWD
												</button>
												<button
													type="button"
													onClick={() => setEditMode("context")}
													className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors border-l border-border ${
														editMode === "context"
															? "bg-primary/10 text-primary"
															: "text-muted-foreground/60 hover:text-foreground"
													}`}
												>
													CONTEXT
												</button>
											</div>
											<span className="text-[9px] text-muted-foreground/40 leading-snug">
												{editMode === "cwd"
													? "claude runs in agent's directory"
													: "claude stays in vault, loads CLAUDE.md as persona"}
											</span>
										</div>
										<div className="flex items-center gap-2 pt-1">
											<button
												type="button"
												onClick={() => void saveEdit(agent.path)}
												className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/50 text-primary/70 hover:bg-primary/5 hover:text-primary transition-colors uppercase"
											>
												SAVE
											</button>
											<button
												type="button"
												onClick={cancelEdit}
												className="text-[10px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground transition-colors uppercase"
											>
												CANCEL
											</button>
										</div>
									</div>
								)}
								{expandedPath === agent.path &&
									expandedContent[agent.path] != null && (
										<div className="px-6 py-4 bg-secondary/30 text-xs text-foreground/80 leading-relaxed">
											<PrivacyMask>
												<MarkdownBody content={expandedContent[agent.path]} />
											</PrivacyMask>
										</div>
									)}
							</div>
						))
					)}
				</div>
			</div>

			{/* Folder browser modal */}
			{addBrowseOpen && (
				<div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4">
					<div className="w-full max-w-md bg-card border border-border shadow-2xl p-5 space-y-4">
						<div className="flex items-center justify-between">
							<div className="text-[10px] tracking-widest text-muted-foreground uppercase">
								SELECT AGENT DIRECTORY
							</div>
							<button
								type="button"
								onClick={() => setAddBrowseOpen(false)}
								className="text-[10px] tracking-widest text-muted-foreground hover:text-foreground transition-colors uppercase"
							>
								CANCEL
							</button>
						</div>
						<FolderBrowser
							initialPath={addPath || undefined}
							external={externalAllowed}
							onSelect={(path) => {
								setAddPath(path);
								setAddBrowseOpen(false);
								setAddError(null);
							}}
						/>
					</div>
				</div>
			)}
		</div>
	);
}
