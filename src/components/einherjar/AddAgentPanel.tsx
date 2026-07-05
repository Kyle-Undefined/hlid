import { useState } from "react";
import type { AgentProviderSettings } from "#/components/einherjar/AgentCard";
import { FolderBrowser } from "#/components/wizard/FolderBrowser";
import {
	effortOptionsFor,
	modelOptions as getModelOptions,
} from "#/lib/providerOptions";
import type { ProviderInfo } from "#/lib/serverFns";

type AddForm = {
	path: string;
	name: string;
	mode: "cwd" | "context";
	provider: string;
	model: string;
	effort: string;
	maxTurns: string;
	permissionMode: string;
	recapModel: string;
};

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
	const [form, setForm] = useState<AddForm>(() => ({
		...DEFAULT_ADD,
		provider: providers[0]?.id ?? "claude",
	}));
	const [error, setError] = useState<string | null>(null);
	const [browseOpen, setBrowseOpen] = useState(false);
	const [saving, setSaving] = useState(false);

	// Options come from the selected provider's declared capabilities — the
	// provider chosen in this form, never the vault-level provider (a new
	// agent can use a different provider than the vault default).
	const activeProvider = providers.find((p) => p.id === form.provider);
	const modelOptions = getModelOptions(activeProvider);
	const effortOptions = effortOptionsFor(activeProvider, form.model);
	const permissionOptions = activeProvider?.permissionModes ?? [];
	const isClaudeProvider = activeProvider?.id === "claude";
	// Show provider-specific settings only when the selected provider declares
	// capabilities (mirrors ClaudeSection's gating for the vault-level form).
	const hasProviderOptions =
		modelOptions.length > 0 ||
		effortOptions.length > 0 ||
		permissionOptions.length > 0;

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
			setForm({ ...DEFAULT_ADD, provider: providers[0]?.id ?? "claude" });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to add agent");
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<form
				className="border border-border bg-card p-4 space-y-3"
				onSubmit={(e) => {
					e.preventDefault();
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
							onChange={(e) => {
								setForm((f) => ({ ...f, path: e.target.value }));
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
						onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
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
								onClick={() => setForm((f) => ({ ...f, mode: "cwd" }))}
								className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors ${
									form.mode === "cwd"
										? "bg-primary/10 text-primary"
										: "text-muted-foreground/60 hover:text-foreground"
								}`}
							>
								CWD
							</button>
							<button
								type="button"
								onClick={() => setForm((f) => ({ ...f, mode: "context" }))}
								className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors border-l border-border ${
									form.mode === "context"
										? "bg-primary/10 text-primary"
										: "text-muted-foreground/60 hover:text-foreground"
								}`}
							>
								CONTEXT
							</button>
						</div>
						<span className="text-[9px] text-muted-foreground/40 leading-snug">
							{form.mode === "cwd"
								? "claude runs in agent's directory"
								: "claude stays in vault, loads CLAUDE.md as persona"}
						</span>
					</div>
					{providers.length > 0 && (
						<div className="flex items-center gap-2">
							<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0">
								Provider
							</span>
							<div className="flex border border-border">
								{providers.map((p, i) => (
									<button
										key={p.id}
										type="button"
										onClick={() => setForm((f) => ({ ...f, provider: p.id }))}
										className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors ${i > 0 ? "border-l border-border" : ""} ${
											form.provider === p.id
												? "bg-primary/10 text-primary"
												: "text-muted-foreground/60 hover:text-foreground"
										}`}
									>
										{p.label}
									</button>
								))}
							</div>
							{providers.find((p) => p.id === form.provider)?.available ===
								false && (
								<span className="text-[9px] text-destructive/70">
									{providers.find((p) => p.id === form.provider)
										?.unavailableReason ?? "unavailable"}
								</span>
							)}
						</div>
					)}
					{hasProviderOptions && (
						<div className="space-y-2 pt-1">
							<div className="flex items-center gap-2">
								<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0 w-24">
									Model
								</span>
								<select
									value={form.model}
									onChange={(e) => {
										const model = e.target.value;
										const newEffortOptions = effortOptionsFor(
											activeProvider,
											model,
										);
										setForm((f) => ({
											...f,
											model,
											effort:
												f.effort !== "" &&
												!newEffortOptions.some((o) => o.value === f.effort)
													? ""
													: f.effort,
										}));
									}}
									className="flex-1 bg-secondary border border-border px-2 py-1 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
								>
									<option value="">— vault default —</option>
									{modelOptions.map((m) => (
										<option key={m.value} value={m.value} title={m.description}>
											{m.label}
											{m.isDefault ? " (default)" : ""}
										</option>
									))}
								</select>
							</div>
							<div className="flex items-center gap-2">
								<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0 w-24">
									Effort
								</span>
								<select
									value={form.effort}
									onChange={(e) =>
										setForm((f) => ({ ...f, effort: e.target.value }))
									}
									className="flex-1 bg-secondary border border-border px-2 py-1 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
								>
									<option value="">— vault default —</option>
									{effortOptions.map((o) => (
										<option key={o.value} value={o.value}>
											{o.label}
											{o.isDefault ? " (default)" : ""}
										</option>
									))}
								</select>
							</div>
							<div className="flex items-center gap-2">
								<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0 w-24">
									Permissions
								</span>
								<select
									value={form.permissionMode}
									onChange={(e) =>
										setForm((f) => ({ ...f, permissionMode: e.target.value }))
									}
									className="flex-1 bg-secondary border border-border px-2 py-1 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
								>
									<option value="">— vault default —</option>
									{permissionOptions.map((o) => (
										<option key={o.value} value={o.value}>
											{o.label}
										</option>
									))}
								</select>
							</div>
							<div className="flex items-center gap-2">
								<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0 w-24">
									Max turns
								</span>
								<input
									type="number"
									min={1}
									value={form.maxTurns}
									onChange={(e) => {
										const raw = e.target.value;
										if (raw === "") {
											setForm((f) => ({ ...f, maxTurns: "" }));
										} else {
											const n = parseInt(raw, 10);
											setForm((f) => ({
												...f,
												maxTurns: Number.isFinite(n)
													? String(Math.max(1, n))
													: "",
											}));
										}
									}}
									placeholder="vault default"
									className="flex-1 bg-secondary border border-border px-2 py-1 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
								/>
							</div>
							<div className="flex items-center gap-2">
								<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0 w-24">
									Recap model
								</span>
								<select
									value={form.recapModel}
									onChange={(e) =>
										setForm((f) => ({ ...f, recapModel: e.target.value }))
									}
									className="flex-1 bg-secondary border border-border px-2 py-1 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
								>
									<option value="">
										{isClaudeProvider
											? "— default (haiku) —"
											: "— provider default —"}
									</option>
									{modelOptions.map((m) => (
										<option key={m.value} value={m.value} title={m.description}>
											{m.label}
											{m.isDefault ? " (default)" : ""}
										</option>
									))}
								</select>
							</div>
						</div>
					)}
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
						onClick={() => {
							setForm({
								...DEFAULT_ADD,
								provider: providers[0]?.id ?? "claude",
							});
							setError(null);
							onCancel();
						}}
						className="text-[10px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground transition-colors uppercase"
					>
						CANCEL
					</button>
				</div>
			</form>

			{browseOpen && (
				<div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4">
					<div
						role="dialog"
						aria-modal="true"
						aria-labelledby="browse-agent-dialog-title"
						className="w-full max-w-md bg-card border border-border shadow-2xl p-5 space-y-4"
						onKeyDown={(e) => {
							if (e.key === "Escape") setBrowseOpen(false);
						}}
					>
						<div className="flex items-center justify-between">
							<div
								id="browse-agent-dialog-title"
								className="text-[10px] tracking-widest text-muted-foreground uppercase"
							>
								SELECT AGENT DIRECTORY
							</div>
							<button
								type="button"
								onClick={() => setBrowseOpen(false)}
								className="text-[10px] tracking-widest text-muted-foreground hover:text-foreground transition-colors uppercase"
							>
								CANCEL
							</button>
						</div>
						<FolderBrowser
							initialPath={form.path || undefined}
							external={externalAllowed}
							onSelect={(path) => {
								setForm((f) => ({ ...f, path }));
								setBrowseOpen(false);
								setError(null);
							}}
						/>
					</div>
				</div>
			)}
		</>
	);
}
