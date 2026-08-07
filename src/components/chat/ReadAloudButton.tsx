import {
	ChevronDown,
	LoaderCircle,
	Pause,
	Play,
	Square,
	Volume2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
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
	const codexStreaming = preferences.provider === "codex";
	const visibleError = active ? state.error : null;
	const errorId = useId();
	const errorResetKey = `${messageId}\0${visibleError ?? ""}`;
	const [errorDisclosure, setErrorDisclosure] = useState({
		key: errorResetKey,
		expanded: false,
	});
	const errorExpanded =
		errorDisclosure.key === errorResetKey && errorDisclosure.expanded;
	const buttonStateClass = visibleError
		? "text-destructive/70 opacity-100"
		: loading || playing || paused
			? "text-primary/70 opacity-100"
			: "text-muted-foreground/40";
	const [supported, setSupported] = useState(false);
	const engineName = (() => {
		switch (preferences.provider) {
			case "microsoft":
				return "Microsoft speech on the Hlid host";
			case "neural":
				return "local neural speech on the Hlid host";
			case "codex":
				return "Codex realtime";
			default:
				return "a local voice on this device";
		}
	})();

	useEffect(() => {
		setSupported(readAloudSupported(preferences.provider));
		return () => stopReadAloudMessage(messageId);
	}, [messageId, preferences.provider]);

	useEffect(() => {
		setErrorDisclosure({ key: errorResetKey, expanded: false });
	}, [errorResetKey]);

	const label =
		active && state.error
			? "Retry read aloud"
			: loading
				? "Cancel reading"
				: playing
					? codexStreaming
						? "Stop reading"
						: "Pause reading"
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
				aria-describedby={visibleError ? errorId : undefined}
				title={
					visibleError
						? visibleError
						: supported
							? `${label} using ${engineName}`
							: `${engineName} is unavailable`
				}
				className={`p-1 transition-all hover:text-muted-foreground/80 disabled:opacity-30 ${buttonStateClass}`}
			>
				{loading ? (
					<LoaderCircle aria-hidden className="w-3 h-3 animate-spin" />
				) : playing && !codexStreaming ? (
					<Pause aria-hidden className="w-3 h-3" />
				) : playing ? (
					<Square aria-hidden className="w-3 h-3" />
				) : paused ? (
					<Play aria-hidden className="w-3 h-3" />
				) : (
					<Volume2 aria-hidden className="w-3 h-3" />
				)}
			</button>
			{visibleError && (
				<button
					type="button"
					onClick={() =>
						setErrorDisclosure({
							key: errorResetKey,
							expanded: !errorExpanded,
						})
					}
					aria-expanded={errorExpanded}
					aria-label={
						errorExpanded
							? "Collapse read aloud error"
							: "Show full read aloud error"
					}
					title={visibleError}
					className="ml-1 inline-flex min-w-0 max-w-[min(16rem,50vw)] items-start text-left text-[9px] leading-tight text-destructive/80 hover:text-destructive"
				>
					<span
						id={errorId}
						role="alert"
						className={`min-w-0 ${
							errorExpanded ? "whitespace-normal break-words" : "truncate"
						}`}
					>
						{visibleError}
					</span>
					<ChevronDown
						aria-hidden
						className={`ml-0.5 h-2.5 w-2.5 shrink-0 transition-transform ${
							errorExpanded ? "rotate-180" : ""
						}`}
					/>
				</button>
			)}
			{!codexStreaming && (playing || paused) && (
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
