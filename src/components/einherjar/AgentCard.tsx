import {
	Bot,
	ChevronDown,
	ChevronRight,
	MessageSquare,
	Pencil,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";

export type AgentEntry = {
	path: string;
	name: string;
	mode: "cwd" | "context";
	hasClaudemd: boolean;
	dirExists: boolean;
};

type EditState = { name: string; mode: "cwd" | "context" };

export function AgentCard({
	agent,
	onRemove,
	onModeChange,
	onChat,
	onSaveEdit,
	onReadClaudemd,
}: {
	agent: AgentEntry;
	onRemove: () => void;
	onModeChange: (mode: "cwd" | "context") => void;
	onChat: () => void;
	onSaveEdit: (name: string, mode: "cwd" | "context") => Promise<void>;
	onReadClaudemd: () => Promise<string | null>;
}) {
	const [editing, setEditing] = useState<EditState | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [claudemdContent, setClaudemdContent] = useState<string | null>(null);
	const [claudemdLoaded, setClaudemdLoaded] = useState(false);

	async function handleToggleView() {
		if (expanded) {
			setExpanded(false);
			return;
		}
		if (!claudemdLoaded) {
			try {
				const text = await onReadClaudemd();
				setClaudemdContent(text ?? "");
			} catch {
				setClaudemdContent("");
			} finally {
				setClaudemdLoaded(true);
			}
		}
		setExpanded(true);
	}

	async function handleSaveEdit() {
		if (!editing) return;
		const trimmedName = editing.name.trim();
		try {
			await onSaveEdit(trimmedName || agent.name, editing.mode);
			setEditing(null);
		} catch (err) {
			console.error("AgentCard: failed to save edit:", err);
		}
	}

	return (
		<div className="divide-y divide-border/50">
			<div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-3 hover:bg-accent transition-colors">
				<button
					type="button"
					onClick={() => void handleToggleView()}
					disabled={!agent.hasClaudemd}
					aria-expanded={expanded}
					aria-label={expanded ? "Collapse CLAUDE.md" : "Expand CLAUDE.md"}
					className="flex flex-1 items-center gap-3 text-left min-w-0 disabled:cursor-default"
				>
					<span className="shrink-0 text-muted-foreground/40 transition-colors">
						{expanded ? (
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
							onClick={() => onModeChange("cwd")}
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
							onClick={() => onModeChange("context")}
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
						onClick={onChat}
						title="Chat with agent"
						className="text-muted-foreground/40 hover:text-primary transition-colors"
					>
						<MessageSquare className="w-3.5 h-3.5" />
					</button>
					<button
						type="button"
						onClick={() => setEditing({ name: agent.name, mode: agent.mode })}
						title="Edit agent"
						className="text-muted-foreground/40 hover:text-primary transition-colors"
					>
						<Pencil className="w-3.5 h-3.5" />
					</button>
					<ConfirmAction
						label="remove?"
						onConfirm={onRemove}
						trigger={(open) => (
							<button
								type="button"
								onClick={open}
								className="text-muted-foreground/30 hover:text-destructive transition-colors text-base leading-none"
							>
								×
							</button>
						)}
					/>
				</div>
			</div>

			{editing && (
				<div className="px-4 py-3 bg-secondary/30 space-y-2">
					<div className="text-[9px] tracking-widest text-muted-foreground/60 uppercase">
						Edit Agent
					</div>
					<input
						type="text"
						value={editing.name}
						onChange={(e) =>
							setEditing((s) => s && { ...s, name: e.target.value })
						}
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
								onClick={() => setEditing((s) => s && { ...s, mode: "cwd" })}
								className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors ${
									editing.mode === "cwd"
										? "bg-primary/10 text-primary"
										: "text-muted-foreground/60 hover:text-foreground"
								}`}
							>
								CWD
							</button>
							<button
								type="button"
								onClick={() =>
									setEditing((s) => s && { ...s, mode: "context" })
								}
								className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors border-l border-border ${
									editing.mode === "context"
										? "bg-primary/10 text-primary"
										: "text-muted-foreground/60 hover:text-foreground"
								}`}
							>
								CONTEXT
							</button>
						</div>
						<span className="text-[9px] text-muted-foreground/40 leading-snug">
							{editing.mode === "cwd"
								? "claude runs in agent's directory"
								: "claude stays in vault, loads CLAUDE.md as persona"}
						</span>
					</div>
					<div className="flex items-center gap-2 pt-1">
						<button
							type="button"
							onClick={() => void handleSaveEdit()}
							className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/50 text-primary/70 hover:bg-primary/5 hover:text-primary transition-colors uppercase"
						>
							SAVE
						</button>
						<button
							type="button"
							onClick={() => setEditing(null)}
							className="text-[10px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground transition-colors uppercase"
						>
							CANCEL
						</button>
					</div>
				</div>
			)}

			{expanded && claudemdLoaded && (
				<div className="px-6 py-4 bg-secondary/30 text-xs text-foreground/80 leading-relaxed">
					<PrivacyMask>
						<MarkdownBody content={claudemdContent} />
					</PrivacyMask>
				</div>
			)}
		</div>
	);
}

// Empty state shown when no agents are registered.
export function AgentEmptyState() {
	return (
		<div className="px-4 py-8 flex flex-col items-center gap-2">
			<Bot className="w-6 h-6 text-muted-foreground/20" />
			<div className="text-[9px] tracking-widest text-muted-foreground/40 uppercase">
				No agents registered
			</div>
		</div>
	);
}
