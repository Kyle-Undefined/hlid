import { ChevronLeft, ChevronRight } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

export type LedgerPagination = {
	page: number;
	pageSize: number;
	pageSizeOptions: readonly number[];
	totalPages: number;
	onPageChange: (p: number) => void;
	onPageSizeChange: (size: number) => void;
};

/** Pager footer: first/prev/next/last plus a jump-to-page input. */
export function LedgerPaginationBar({
	pagination,
	loading,
}: {
	pagination: LedgerPagination;
	loading: boolean;
}) {
	const { page, totalPages, onPageChange } = pagination;
	const [jumpInput, setJumpInput] = useState("");

	function commitJump() {
		const parsed = parseInt(jumpInput, 10);
		if (Number.isFinite(parsed) && parsed >= 1 && parsed <= totalPages) {
			onPageChange(parsed);
		}
		setJumpInput("");
	}

	function handleJumpKey(e: KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Enter") {
			e.preventDefault();
			commitJump();
		} else if (e.key === "Escape") {
			setJumpInput("");
		}
	}

	return (
		<div className="px-4 py-2.5 border-t border-border flex items-center justify-between gap-3">
			<button
				type="button"
				disabled={page <= 1 || loading}
				onClick={() => onPageChange(1)}
				className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
				aria-label="First page"
			>
				« first
			</button>
			<button
				type="button"
				disabled={page <= 1 || loading}
				onClick={() => onPageChange(page - 1)}
				className="flex items-center gap-0.5 text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
			>
				<ChevronLeft size={10} /> prev
			</button>
			<div className="flex items-center gap-2">
				<span className="text-[9px] tabular-nums text-muted-foreground/30">
					{page} / {totalPages}
				</span>
				<label className="flex items-center gap-1 text-[8px] tracking-widest text-muted-foreground/50 uppercase">
					<span className="sr-only">go to page</span>
					<span aria-hidden="true">go</span>
					<input
						type="number"
						min={1}
						max={totalPages}
						value={jumpInput}
						onChange={(e) => setJumpInput(e.target.value)}
						onKeyDown={handleJumpKey}
						onBlur={() => {
							if (jumpInput) commitJump();
						}}
						placeholder="#"
						className="bg-transparent border border-border w-12 px-1.5 py-0.5 text-[9px] tabular-nums text-foreground/70 focus:outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground/30 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
						aria-label={`Jump to page (1 to ${totalPages})`}
					/>
				</label>
			</div>
			<button
				type="button"
				disabled={page >= totalPages || loading}
				onClick={() => onPageChange(page + 1)}
				className="flex items-center gap-0.5 text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
			>
				next <ChevronRight size={10} />
			</button>
			<button
				type="button"
				disabled={page >= totalPages || loading}
				onClick={() => onPageChange(totalPages)}
				className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
				aria-label="Last page"
			>
				last »
			</button>
		</div>
	);
}
