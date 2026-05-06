import { RefreshCw } from "lucide-react";
import { MAX_PULL } from "#/hooks/usePullToRefresh";

const THRESHOLD = 80;
const BADGE_PX = 36;
const VISIBLE_Y = 16;

interface Props {
	pullY: number;
	isRefreshing: boolean;
}

export function PullToRefreshIndicator({ pullY, isRefreshing }: Props) {
	if (pullY === 0 && !isRefreshing) return null;

	const progress = Math.min(pullY / THRESHOLD, 1);

	// Slide down from above; fixed so it's always viewport-centered horizontally.
	const minY = -(BADGE_PX + 8);
	const translateY = isRefreshing
		? VISIBLE_Y
		: minY + (VISIBLE_Y - minY) * (pullY / MAX_PULL);

	const ready = progress >= 1;

	return (
		<div
			className="fixed top-0 z-50 pointer-events-none"
			style={{
				left: "50%",
				transform: `translateX(-50%) translateY(${Math.round(translateY)}px)`,
			}}
		>
			<div
				className={`h-9 px-3 rounded-full border shadow-lg flex items-center gap-1.5 transition-colors duration-150 ${
					ready
						? "bg-primary border-primary/40 text-primary-foreground"
						: "bg-card border-border text-muted-foreground"
				}`}
			>
				<RefreshCw
					className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`}
					style={{
						transform: isRefreshing
							? undefined
							: `rotate(${Math.round(progress * 270)}deg)`,
						opacity: isRefreshing ? 1 : 0.4 + progress * 0.6,
					}}
				/>
				<span className="text-[10px] font-medium tracking-wider uppercase">
					{isRefreshing ? "Refreshing" : ready ? "Release" : "Pull"}
				</span>
			</div>
		</div>
	);
}
