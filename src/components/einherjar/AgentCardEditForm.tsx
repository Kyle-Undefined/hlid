import { AgentConfigurationFields } from "#/components/einherjar/AgentConfigurationFields";
import type { ProviderInfo } from "#/lib/providerTypes";
import type { AgentEntry } from "./AgentCard";

export type EditState = {
	name: string;
	mode: "cwd" | "context";
	provider: string;
	model: string;
	effort: string;
	maxTurns: string;
	permissionMode: string;
	recapModel: string;
	interactiveMode: boolean;
};

export function editStateFromAgent(agent: AgentEntry): EditState {
	return {
		name: agent.name,
		mode: agent.mode,
		provider: agent.provider,
		model: agent.model ?? "",
		effort: agent.effort ?? "",
		maxTurns: agent.maxTurns ?? "",
		permissionMode: agent.permissionMode ?? "",
		recapModel: agent.recapModel ?? "",
		interactiveMode: agent.interactiveMode ?? false,
	};
}

/** Inline name + provider settings form shown while an agent is being edited. */
export function AgentCardEditForm({
	editing,
	providers,
	onChange,
	onSave,
	onCancel,
}: {
	editing: EditState;
	providers: ProviderInfo[];
	onChange: (patch: Partial<EditState>) => void;
	onSave: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="px-4 py-3 bg-secondary/30 space-y-2">
			<div className="text-[9px] tracking-widest text-muted-foreground/60 uppercase">
				Edit Agent
			</div>
			<input
				type="text"
				value={editing.name}
				onChange={(e) => onChange({ name: e.target.value })}
				placeholder="Display name"
				className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
			/>
			<AgentConfigurationFields
				value={editing}
				providers={providers}
				includeInteractive
				onChange={onChange}
			/>
			<div className="flex items-center gap-2 pt-1">
				<button
					type="button"
					onClick={onSave}
					className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/50 text-primary/70 hover:bg-primary/5 hover:text-primary transition-colors uppercase"
				>
					SAVE
				</button>
				<button
					type="button"
					onClick={onCancel}
					className="text-[10px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground transition-colors uppercase"
				>
					CANCEL
				</button>
			</div>
		</div>
	);
}
