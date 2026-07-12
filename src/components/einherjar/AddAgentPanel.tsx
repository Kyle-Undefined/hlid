import { useState } from "react";
import type { AgentProviderSettings } from "#/components/einherjar/AgentCard";
import {
	AgentConfigurationFields,
	type AgentConfigurationValue,
} from "#/components/einherjar/AgentConfigurationFields";
import type { ProviderInfo } from "#/lib/providerTypes";
import { AgentFolderBrowseModal } from "./AgentFolderBrowseModal";

type AddForm = AgentConfigurationValue & { path: string; name: string };

const DEFAULT_ADD: AddForm = {
	path: "",
	name: "",
	mode: "cwd",
	provider: "claude",
	model: "",
	effort: "",
	maxTurns: "",
	permissionMode: "",
	recapModel: "",
};

function initialForm(providers: ProviderInfo[]): AddForm {
	return { ...DEFAULT_ADD, provider: providers[0]?.id ?? "claude" };
}

export function AddAgentPanel({
	externalAllowed,
	onAdd,
	onCancel,
	providers,
}: {
	externalAllowed: boolean;
	onAdd: (
		path: string,
		name: string,
		mode: "cwd" | "context",
		provider: string,
		settings: AgentProviderSettings,
	) => Promise<void>;
	onCancel: () => void;
	providers: ProviderInfo[];
}) {
	const [form, setForm] = useState<AddForm>(() => initialForm(providers));
	const [error, setError] = useState<string | null>(null);
	const [browseOpen, setBrowseOpen] = useState(false);
	const [saving, setSaving] = useState(false);

	async function handleSubmit() {
		if (!form.path.trim()) {
			setError("Path required");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await onAdd(
				form.path.trim(),
				form.name.trim(),
				form.mode,
				form.provider,
				{
					model: form.model || undefined,
					effort: form.effort || undefined,
					maxTurns: form.maxTurns || undefined,
					permissionMode: form.permissionMode || undefined,
					recapModel: form.recapModel || undefined,
				},
			);
			setForm(initialForm(providers));
		} catch (submitError) {
			setError(
				submitError instanceof Error
					? submitError.message
					: "Failed to add agent",
			);
		} finally {
			setSaving(false);
		}
	}

	function cancel() {
		setForm(initialForm(providers));
		setError(null);
		onCancel();
	}

	return (
		<>
			<form
				className="border border-border bg-card p-4 space-y-3"
				onSubmit={(event) => {
					event.preventDefault();
					void handleSubmit();
				}}
			>
				<div className="text-[9px] tracking-widest text-muted-foreground/60 uppercase">
					Register Agent Directory
				</div>
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<label htmlFor="add-agent-path" className="sr-only">
							Agent directory path
						</label>
						<input
							type="text"
							id="add-agent-path"
							value={form.path}
							onChange={(event) => {
								setForm((current) => ({
									...current,
									path: event.target.value,
								}));
								setError(null);
							}}
							placeholder="/path/to/agent-dir"
							className="flex-1 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
						/>
						<button
							type="button"
							onClick={() => setBrowseOpen(true)}
							className="text-[10px] tracking-widest px-2 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 uppercase"
						>
							BROWSE
						</button>
					</div>
					<label htmlFor="add-agent-name" className="sr-only">
						Display name
					</label>
					<input
						type="text"
						id="add-agent-name"
						value={form.name}
						onChange={(event) =>
							setForm((current) => ({ ...current, name: event.target.value }))
						}
						placeholder="Display name (optional)"
						className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
					/>
					<AgentConfigurationFields
						value={form}
						providers={providers}
						onChange={(patch) =>
							setForm((current) => ({ ...current, ...patch }))
						}
					/>
				</div>
				{error && (
					<div className="text-[10px] text-destructive/80">{error}</div>
				)}
				<div className="flex items-center gap-2">
					<button
						type="submit"
						disabled={saving}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/50 text-primary/70 hover:bg-primary/5 hover:text-primary transition-colors uppercase disabled:opacity-40"
					>
						{saving ? "ADDING..." : "ADD AGENT"}
					</button>
					<button
						type="button"
						onClick={cancel}
						className="text-[10px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground transition-colors uppercase"
					>
						CANCEL
					</button>
				</div>
			</form>

			{browseOpen && (
				<AgentFolderBrowseModal
					initialPath={form.path || undefined}
					externalAllowed={externalAllowed}
					onSelect={(path) => {
						setForm((current) => ({ ...current, path }));
						setBrowseOpen(false);
						setError(null);
					}}
					onClose={() => setBrowseOpen(false)}
				/>
			)}
		</>
	);
}
