import { LoaderCircle, Pause, Play, Square, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
	readAloudSupported,
	stopReadAloud,
	stopReadAloudMessage,
	toggleReadAloud,
	useReadAloudPreferences,
	useReadAloudState,
} from "#/hooks/readAloudStore";

export function ReadAloudButton({
	messageId,
	text,
	dbId,
}: {
	messageId: string;
	text: string;
	dbId?: number;
}) {
	const state = useReadAloudState();
	const preferences = useReadAloudPreferences();
	const active = state.messageId === messageId;
	const loading = active && state.phase === "loading";
	const playing = active && state.phase === "speaking";
	const paused = active && state.phase === "paused";
	const buttonStateClass =
		loading || playing || paused
			? "text-primary/70 opacity-100"
			: "text-muted-foreground/40";
	const [supported, setSupported] = useState(false);
	const engineName =
		preferences.provider === "microsoft"
			? "Microsoft speech on the Hlid host"
			: "a local voice on this device";

	useEffect(() => {
		setSupported(readAloudSupported(preferences.provider));
		return () => stopReadAloudMessage(messageId);
	}, [messageId, preferences.provider]);

	const label = loading
		? "Cancel reading"
		: playing
			? "Pause reading"
			: paused
				? "Resume reading"
				: "Read aloud";
	return (
		<>
			<button
				type="button"
				onClick={() => toggleReadAloud(messageId, text, dbId)}
				disabled={!supported}
				aria-label={label}
				title={
					active && state.error
						? state.error
						: supported
							? `${label} using ${engineName}`
							: `${engineName} is unavailable`
				}
				className={`p-1 transition-all hover:text-muted-foreground/80 disabled:opacity-30 ${buttonStateClass}`}
			>
				{loading ? (
					<LoaderCircle aria-hidden className="w-3 h-3 animate-spin" />
				) : playing ? (
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
