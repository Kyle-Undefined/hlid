import type { ProviderInfo } from "#/lib/providerTypes";

/** cwd/context mode toggle plus the provider button row (when more than one provider exists). */
export function ModeProviderPicker({
	mode,
	provider,
	providers,
	unavailableReason,
	onModeChange,
	onProviderChange,
}: {
	mode: "cwd" | "context";
	provider: string;
	providers: ProviderInfo[];
	unavailableReason: string | null;
	onModeChange: (mode: "cwd" | "context") => void;
	onProviderChange: (provider: string) => void;
}) {
	return (
		<>
			<div className="flex items-center gap-2 flex-wrap">
				<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0">
					Mode
				</span>
				<div className="flex border border-border">
					<button
						type="button"
						onClick={() => onModeChange("cwd")}
						className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors ${
							mode === "cwd"
								? "bg-primary/10 text-primary"
								: "text-muted-foreground/60 hover:text-foreground"
						}`}
					>
						CWD
					</button>
					<button
						type="button"
						onClick={() => onModeChange("context")}
						className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors border-l border-border ${
							mode === "context"
								? "bg-primary/10 text-primary"
								: "text-muted-foreground/60 hover:text-foreground"
						}`}
					>
						CONTEXT
					</button>
				</div>
				<span className="text-[9px] text-muted-foreground/40 leading-snug">
					{mode === "cwd"
						? "runs in agent's directory"
						: "stays in vault, loads AGENTS.md or CLAUDE.md as persona"}
				</span>
			</div>

			{providers.length > 0 && (
				<div className="flex items-center gap-2">
					<span className="text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0">
						Provider
					</span>
					<div className="flex border border-border">
						{providers.map((p, index) => (
							<button
								key={p.id}
								type="button"
								onClick={() => onProviderChange(p.id)}
								className={`text-[10px] tracking-widest px-2.5 py-1 uppercase transition-colors ${index > 0 ? "border-l border-border" : ""} ${
									provider === p.id
										? "bg-primary/10 text-primary"
										: "text-muted-foreground/60 hover:text-foreground"
								}`}
							>
								{p.label}
							</button>
						))}
					</div>
					{unavailableReason && (
						<span className="text-[9px] text-destructive/70">
							{unavailableReason}
						</span>
					)}
				</div>
			)}
		</>
	);
}
