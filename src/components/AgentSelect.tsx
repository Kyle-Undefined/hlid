import { useId } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";

type AgentEntry = { path: string; name: string };

/**
 * AGENT label + select dropdown. Renders just the label+select pair;
 * caller provides the outer wrapper div with visibility / padding classes.
 *
 * Usage:
 *   <div className="flex items-baseline gap-2 px-4 py-1.5 border-b border-border/40">
 *     <AgentSelect agents={agentList} value={path} onChange={setPath} />
 *   </div>
 */
export function AgentSelect({
	agents,
	value,
	onChange,
	fullWidth = false,
}: {
	agents: AgentEntry[];
	value: string;
	onChange: (value: string) => void;
	/** Expand select to fill remaining space (mobile layout). */
	fullWidth?: boolean;
}) {
	const selectId = useId();
	return (
		<>
			<label
				htmlFor={selectId}
				className="text-xs tracking-widest text-muted-foreground/40 uppercase shrink-0"
			>
				AGENT
			</label>
			<PrivacyMask inline className={fullWidth ? "min-w-0 flex-1" : undefined}>
				<select
					id={selectId}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className={`text-xs tracking-widest text-muted-foreground/60 bg-background border border-border/50 px-2 py-0.5 focus:outline-none focus:border-primary/40 uppercase${fullWidth ? " min-w-0 w-full" : ""}`}
				>
					<option value="">none</option>
					{agents.map((a) => (
						<option key={a.path} value={a.path}>
							{a.name}
						</option>
					))}
				</select>
			</PrivacyMask>
		</>
	);
}
