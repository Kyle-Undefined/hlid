import { LockKeyhole } from "lucide-react";
import { useState } from "react";

export function LockButton({ mobile = false }: { mobile?: boolean }) {
	const [locking, setLocking] = useState(false);

	async function lock() {
		if (locking) return;
		setLocking(true);
		try {
			await fetch("/api/auth/logout", { method: "POST" });
		} finally {
			window.location.replace("/login");
		}
	}

	return (
		<button
			type="button"
			onClick={() => void lock()}
			disabled={locking}
			title="Lock this device"
			className={
				mobile
					? "min-w-0 flex-1 flex flex-col items-center gap-1 py-2.5 px-0.5 text-muted-foreground hover:text-foreground transition-colors duration-100 disabled:opacity-40"
					: "w-full flex items-center gap-3 px-4 py-2.5 text-[10px] tracking-widest uppercase text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40"
			}
		>
			<LockKeyhole
				className={mobile ? "w-4 h-4 shrink-0" : "w-3.5 h-3.5 shrink-0"}
			/>
			<span
				className={
					mobile
						? "w-full overflow-hidden text-ellipsis whitespace-nowrap text-center text-[clamp(7px,2vw,9px)] tracking-[0.08em]"
						: undefined
				}
			>
				{mobile ? "Lock" : locking ? "Locking…" : "Lock"}
			</span>
		</button>
	);
}
