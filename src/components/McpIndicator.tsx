import { Plug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { McpServerEntry } from "#/lib/mcp";

const STATUS_ORDER: Record<McpServerEntry["status"], number> = {
	failed: 0,
	"needs-auth": 1,
	pending: 2,
	connected: 3,
	disabled: 4,
	unknown: 5,
};

function dotClass(status: McpServerEntry["status"]): string {
	switch (status) {
		case "connected":
			return "bg-green-500/80";
		case "needs-auth":
			return "bg-amber-400/80";
		case "failed":
			return "bg-red-500/80";
		case "pending":
			return "bg-orange-500/70 animate-pulse";
		default:
			return "bg-muted-foreground/35";
	}
}

function aggregateStatus(servers: McpServerEntry[]): McpServerEntry["status"] {
	if (servers.length === 0) return "unknown";
	return [...servers].sort(
		(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
	)[0].status;
}

export function mobilePopoverOffset(
	viewportWidth: number,
	anchorLeft: number,
	popoverWidth = 288,
	margin = 16,
): number {
	const width = Math.min(popoverWidth, Math.max(0, viewportWidth - margin * 2));
	const absoluteLeft = Math.max(
		margin,
		Math.min(anchorLeft, viewportWidth - margin - width),
	);
	return absoluteLeft - anchorLeft;
}

export function McpIndicator({
	servers,
	align = "right",
	label = "MCP runtime · active provider",
}: {
	servers: McpServerEntry[];
	align?: "left" | "right" | "mobile-left";
	label?: string;
}) {
	const [open, setOpen] = useState(false);
	const [mobileOffset, setMobileOffset] = useState<number | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const sorted = [...servers].sort(
		(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
	);
	const connected = servers.filter(
		(server) => server.status === "connected",
	).length;
	const status = aggregateStatus(servers);

	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);

	useEffect(() => {
		if (!open || align !== "mobile-left") {
			setMobileOffset(null);
			return;
		}
		const reposition = () => {
			const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
			if (viewportWidth >= 768) {
				setMobileOffset(null);
				return;
			}
			const anchorLeft = rootRef.current?.getBoundingClientRect().left;
			if (anchorLeft === undefined) return;
			setMobileOffset(mobilePopoverOffset(viewportWidth, anchorLeft));
		};
		reposition();
		window.addEventListener("resize", reposition);
		window.visualViewport?.addEventListener("resize", reposition);
		return () => {
			window.removeEventListener("resize", reposition);
			window.visualViewport?.removeEventListener("resize", reposition);
		};
	}, [align, open]);

	return (
		<div ref={rootRef} className="relative shrink-0">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className={`flex items-center gap-1.5 text-[9px] tracking-widest uppercase transition-colors ${open ? "text-primary" : "text-muted-foreground/50 hover:text-foreground/75"}`}
				aria-expanded={open}
				aria-pressed={open}
				aria-label="MCP server status"
			>
				<Plug className="w-3 h-3" />
				<span>MCP</span>
				<span className={`w-1.5 h-1.5 rounded-full ${dotClass(status)}`} />
				<span className="tabular-nums">
					{servers.length ? `${connected}/${servers.length}` : "0"}
				</span>
			</button>
			{open && (
				<div
					className={`absolute bottom-full z-50 mb-2 w-72 max-w-[calc(100vw-2rem)] border border-border bg-card shadow-xl ${align === "right" ? "right-0" : align === "left" ? "left-0" : "left-0 md:left-auto md:right-0"}`}
					style={
						align === "mobile-left" && mobileOffset !== null
							? { left: `${mobileOffset}px` }
							: undefined
					}
				>
					<div className="px-3 py-2 border-b border-border/60 text-[9px] tracking-widest uppercase text-muted-foreground/50">
						{label}
					</div>
					{sorted.length === 0 ? (
						<div className="px-3 py-3 text-[10px] text-muted-foreground/50">
							No servers reported for this context.
						</div>
					) : (
						<div className="max-h-64 overflow-y-auto">
							{sorted.map((server) => (
								<div
									key={`${server.providerId ?? "active"}:${server.name}`}
									className="px-3 py-2 border-b border-border/40 last:border-b-0"
								>
									<div className="flex items-center gap-2">
										<span
											className={`w-1.5 h-1.5 rounded-full ${dotClass(server.status)}`}
										/>
										<span className="min-w-0 flex-1 truncate text-[10px] text-foreground/80">
											{server.displayName}
										</span>
										<span className="text-[8px] tracking-widest uppercase text-muted-foreground/40">
											{server.status}
										</span>
									</div>
									<div className="pl-3.5 mt-1 text-[8px] tracking-wider text-muted-foreground/35">
										{server.providerId ?? "provider"} · {server.source}
									</div>
									{server.error && (
										<div className="pl-3.5 mt-1 text-[9px] text-destructive/70 line-clamp-2">
											{server.error}
										</div>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
