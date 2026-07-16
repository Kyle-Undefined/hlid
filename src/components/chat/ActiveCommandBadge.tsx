import { X } from "lucide-react";
import type { CommandDescriptor } from "#/lib/commands";

export function ActiveCommandBadge({
	command,
	onClear,
}: {
	command: CommandDescriptor;
	onClear: () => void;
}) {
	const kind = command.execution.kind === "skill" ? "skill" : "command";
	return (
		<div
			className="flex min-w-0 items-center gap-2 border-b border-primary/20 bg-primary/5 px-3 py-1.5"
			data-testid="active-command"
		>
			<span className="shrink-0 text-[8px] font-bold tracking-widest text-primary/55 uppercase">
				{kind}
			</span>
			<span className="min-w-0 truncate font-mono text-[11px] text-primary/85">
				/{command.name}
			</span>
			{command.description && (
				<span className="hidden min-w-0 flex-1 truncate text-[9px] text-muted-foreground/50 sm:block">
					{command.description}
				</span>
			)}
			<button
				type="button"
				onClick={onClear}
				className="ml-auto shrink-0 text-primary/45 transition-colors hover:text-primary"
				aria-label={`Clear selected ${kind} /${command.name}`}
				title={`Clear /${command.name}`}
			>
				<X className="h-3 w-3" />
			</button>
		</div>
	);
}
