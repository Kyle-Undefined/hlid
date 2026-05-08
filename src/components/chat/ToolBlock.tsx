import { Check, ChevronRight } from "lucide-react";
import { useState } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { ToolEventMessage } from "#/server/protocol";

export function ToolBlock({
	event,
	permissionLabel,
}: {
	event: ToolEventMessage;
	permissionLabel?: string;
}) {
	const [open, setOpen] = useState(false);
	const pills = Object.entries(event.input ?? {}).slice(0, 3);

	return (
		<div className="my-0.5">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				className="flex items-center gap-2.5 w-full px-3 py-1.5 group hover:bg-primary/[0.03] transition-colors text-left"
			>
				<ChevronRight
					className={`w-3 h-3 shrink-0 text-primary/50 group-hover:text-primary/80 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
				/>
				<PrivacyMask
					inline
					className="text-[11px] font-medium tracking-wider text-primary/70 group-hover:text-primary/90 shrink-0"
				>
					{event.name}
				</PrivacyMask>
				<PrivacyMask className="flex gap-1.5 flex-wrap">
					{pills.map(([k, v]) => (
						<span
							key={k}
							className="text-[9px] tracking-wide border border-primary/20 text-primary/50 px-1.5 py-0.5 font-mono break-all"
						>
							{k}: {typeof v === "string" ? v : JSON.stringify(v)}
						</span>
					))}
				</PrivacyMask>
			</button>
			{permissionLabel && (
				<div className="flex items-center gap-1.5 pl-8 pr-3 pb-1 -mt-0.5 text-[9px] tracking-widest text-muted-foreground/55 uppercase">
					<Check className="w-2.5 h-2.5 text-green-600/55" />
					<span>{permissionLabel}</span>
				</div>
			)}
			{open && (
				<PrivacyMask className="mx-3 mb-1.5 border border-[var(--tool-panel-border)] bg-[var(--tool-panel)]">
					<div className="text-[11px] text-primary/60 font-mono leading-relaxed p-3 overflow-auto max-h-48 space-y-1">
						{Object.entries(event.input ?? {}).map(([k, v]) => (
							<div key={k} className="flex gap-1.5 min-w-0">
								<span className="text-primary/40 shrink-0">{k}:</span>
								{typeof v === "string" ? (
									<span className="whitespace-pre-wrap break-words min-w-0">
										{v}
									</span>
								) : (
									<span className="whitespace-pre-wrap break-words min-w-0">
										{JSON.stringify(v, null, 2)}
									</span>
								)}
							</div>
						))}
					</div>
				</PrivacyMask>
			)}
		</div>
	);
}
