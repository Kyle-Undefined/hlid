import { Pause, Play, Square, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
	readAloudSupported,
	stopReadAloud,
	stopReadAloudMessage,
	toggleReadAloud,
	useReadAloudState,
} from "#/hooks/readAloudStore";
import { cn } from "#/lib/utils";

export function ReadAloudButton({
	messageId,
	text,
	className,
}: {
	messageId: string;
	text: string;
	className?: string;
}) {
	const state = useReadAloudState();
	const active = state.messageId === messageId;
	const playing = active && state.phase === "speaking";
	const paused = active && state.phase === "paused";
	const [supported, setSupported] = useState(false);

	useEffect(() => {
		setSupported(readAloudSupported());
		return () => stopReadAloudMessage(messageId);
	}, [messageId]);

	const label = playing
		? "Pause reading"
		: paused
			? "Resume reading"
			: "Read aloud";
	return (
		<>
			<button
				type="button"
				onClick={() => toggleReadAloud(messageId, text)}
				disabled={!supported}
				aria-label={label}
				title={
					active && state.error
						? state.error
						: supported
							? `${label} using a local voice on this device`
							: "Read aloud is not supported by this browser"
				}
				className={cn(
					"p-1 text-muted-foreground/40 transition-all hover:text-muted-foreground/80 disabled:opacity-30",
					(playing || paused) && "text-primary/70 opacity-100",
					className,
				)}
			>
				{playing ? (
					<Pause aria-hidden className="w-3 h-3" />
				) : paused ? (
					<Play aria-hidden className="w-3 h-3" />
				) : (
					<Volume2 aria-hidden className="w-3 h-3" />
				)}
			</button>
			{(playing || paused) && (
				<button
					type="button"
					onClick={stopReadAloud}
					aria-label="Stop reading"
					title="Stop reading"
					className="p-1 text-muted-foreground/40 opacity-100 transition-all hover:text-muted-foreground/80"
				>
					<Square aria-hidden className="w-2.5 h-2.5" />
				</button>
			)}
		</>
	);
}
