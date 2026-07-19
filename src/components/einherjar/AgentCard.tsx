import { Bot } from "lucide-react";
import { useState } from "react";
import { AgentMcpSection } from "#/components/forge/McpSection";
import { InstructionFilesPanel } from "#/components/instructions/InstructionFilesPanel";
import type { AgentInstructionFileName } from "#/lib/agentInstructions";
import type { InstructionFileTarget } from "#/lib/instructionFileTypes";
import type { ProviderInfo } from "#/lib/providerTypes";
import {
	AgentCardEditForm,
	type EditState,
	editStateFromAgent,
} from "./AgentCardEditForm";
import { AgentCardHeader } from "./AgentCardHeader";

export type AgentEntry = {
	path: string;
	name: string;
	mode: "cwd" | "context";
	provider: string;
	instructionFile: AgentInstructionFileName | null;
	dirExists: boolean;
	model?: string;
	effort?: string;
	maxTurns?: string;
	permissionMode?: string;
	recapModel?: string;
	interactiveMode?: boolean;
};

export type AgentProviderSettings = {
	model?: string;
	effort?: string;
	maxTurns?: string;
	permissionMode?: string;
	recapModel?: string;
	interactiveMode?: boolean;
};

export function AgentCard({
	agent,
	onRemove,
	onModeChange,
	onChat,
	onSaveEdit,
	instructionTargets,
	providers,
}: {
	agent: AgentEntry;
	onRemove: () => void;
	onModeChange: (mode: "cwd" | "context") => void;
	onChat: () => void;
	onSaveEdit: (
		name: string,
		mode: "cwd" | "context",
		provider: string,
		settings: AgentProviderSettings,
	) => Promise<void>;
	instructionTargets: InstructionFileTarget[];
	providers: ProviderInfo[];
}) {
	const [editing, setEditing] = useState<EditState | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [showMcp, setShowMcp] = useState(false);

	function handleToggleView() {
		setExpanded((current) => !current);
	}

	async function handleSaveEdit() {
		if (!editing) return;
		const trimmedName = editing.name.trim();
		try {
			await onSaveEdit(
				trimmedName || agent.name,
				editing.mode,
				editing.provider,
				{
					model: editing.model || undefined,
					effort: editing.effort || undefined,
					maxTurns: editing.maxTurns || undefined,
					permissionMode: editing.permissionMode || undefined,
					recapModel: editing.recapModel || undefined,
					interactiveMode:
						editing.provider === "claude"
							? editing.interactiveMode || undefined
							: undefined,
				},
			);
			setEditing(null);
		} catch (err) {
			console.error("AgentCard: failed to save edit:", err);
		}
	}

	return (
		<div className="divide-y divide-border/50">
			<AgentCardHeader
				agent={agent}
				expanded={expanded}
				showMcp={showMcp}
				onToggleView={handleToggleView}
				onModeChange={onModeChange}
				onChat={onChat}
				onEdit={() => setEditing(editStateFromAgent(agent))}
				onToggleMcp={() => setShowMcp((v) => !v)}
				onRemove={onRemove}
			/>

			{editing && (
				<AgentCardEditForm
					editing={editing}
					providers={providers}
					onChange={(patch) =>
						setEditing((current) => current && { ...current, ...patch })
					}
					onSave={() => void handleSaveEdit()}
					onCancel={() => setEditing(null)}
				/>
			)}

			{expanded && (
				<div className="bg-secondary/10">
					{instructionTargets.length > 0 ? (
						<InstructionFilesPanel targets={instructionTargets} />
					) : (
						<div className="px-6 py-4 text-xs text-muted-foreground">
							Discovering instruction files…
						</div>
					)}
				</div>
			)}

			{agent.mode === "cwd" && agent.dirExists && showMcp && (
				<div className="border-t border-border/50 px-4 py-3">
					<AgentMcpSection agentPath={agent.path} />
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
