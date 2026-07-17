import {
	ChevronDown,
	ChevronRight,
	MessageSquare,
	Pencil,
	Server,
	TriangleAlert,
} from "lucide-react";
import { ConfirmAction } from "#/components/ConfirmAction";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { AgentEntry } from "./AgentCard";

/** Name/path row, cwd/context toggle, and the chat/edit/mcp/remove action icons. */
export function AgentCardHeader({
	agent,
	expanded,
	showMcp,
	onToggleView,
	onModeChange,
	onChat,
	onEdit,
	onToggleMcp,
	onRemove,
}: {
	agent: AgentEntry;
	expanded: boolean;
	showMcp: boolean;
	onToggleView: () => void;
	onModeChange: (mode: "cwd" | "context") => void;
	onChat: () => void;
	onEdit: () => void;
	onToggleMcp: () => void;
	onRemove: () => void;
}) {
	return (
		<div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-3 hover:bg-accent transition-colors">
			<button
				type="button"
				onClick={onToggleView}
				disabled={!agent.instructionFile}
				aria-expanded={expanded}
				aria-label={
					expanded
						? `Collapse ${agent.instructionFile ?? "instructions"}`
						: `Expand ${agent.instructionFile ?? "instructions"}`
				}
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
			<div className="flex items-center gap-1 shrink-0 self-end sm:self-auto">
				<div className="flex border border-border/50">
					<button
						type="button"
						onClick={() => onModeChange("cwd")}
						title="Run in agent's directory"
						className={`text-[9px] tracking-widest px-2.5 py-1.5 sm:px-1.5 sm:py-0.5 uppercase transition-colors ${
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
						title="Stay in vault, load AGENTS.md or CLAUDE.md as persona"
						className={`text-[9px] tracking-widest px-2.5 py-1.5 sm:px-1.5 sm:py-0.5 uppercase transition-colors border-l border-border/50 ${
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
					className="w-9 h-9 flex items-center justify-center text-muted-foreground/40 hover:text-primary transition-colors"
				>
					<MessageSquare className="w-3.5 h-3.5" />
				</button>
				<button
					type="button"
					onClick={onEdit}
					title="Edit agent"
					className="w-9 h-9 flex items-center justify-center text-muted-foreground/40 hover:text-primary transition-colors"
				>
					<Pencil className="w-3.5 h-3.5" />
				</button>
				{agent.mode === "cwd" && agent.dirExists && (
					<button
						type="button"
						onClick={onToggleMcp}
						title={
							showMcp ? "Hide agent MCP servers" : "Show agent MCP servers"
						}
						aria-label={
							showMcp ? "Hide agent MCP servers" : "Show agent MCP servers"
						}
						className={`w-9 h-9 flex items-center justify-center transition-colors ${
							showMcp
								? "text-primary"
								: "text-muted-foreground/40 hover:text-primary"
						}`}
					>
						<Server className="w-3.5 h-3.5" />
					</button>
				)}
				<ConfirmAction
					label="remove?"
					onConfirm={onRemove}
					trigger={(open) => (
						<button
							type="button"
							onClick={open}
							className="w-9 h-9 flex items-center justify-center text-muted-foreground/30 hover:text-destructive transition-colors text-base leading-none"
						>
							×
						</button>
					)}
				/>
			</div>
		</div>
	);
}
