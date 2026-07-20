import {
	AlertCircle,
	CalendarPlus,
	Check,
	Inbox,
	LoaderCircle,
	NotebookPen,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ObsidianCaptureDestination } from "#/lib/obsidianCapture";
import {
	appendToObsidianFn,
	captureReplyToObsidianFn,
} from "#/lib/serverFns/obsidian";
import { TRANSIENT_FEEDBACK_MS } from "#/lib/transientFeedback";

type Destination = "active" | "daily" | "capture";

export function SaveToObsidianActions({
	text,
	capture,
}: {
	text: string;
	capture?: ObsidianCaptureDestination | null;
}) {
	const [busy, setBusy] = useState<Destination | null>(null);
	const [saved, setSaved] = useState<Destination | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!saved) return;
		const timer = setTimeout(() => setSaved(null), TRANSIENT_FEEDBACK_MS);
		return () => clearTimeout(timer);
	}, [saved]);

	function save(destination: Destination) {
		setBusy(destination);
		setSaved(null);
		setError(null);
		void Promise.resolve()
			.then(() =>
				destination === "capture"
					? captureReplyToObsidianFn({ data: { content: text } })
					: appendToObsidianFn({ data: { destination, content: text } }),
			)
			.then(() => setSaved(destination))
			.catch((cause: unknown) => {
				setError(
					cause instanceof Error
						? cause.message
						: "Could not save the reply to Obsidian",
				);
			})
			.finally(() => setBusy(null));
	}

	function icon(destination: Destination) {
		if (busy === destination)
			return <LoaderCircle className="h-3 w-3 animate-spin" />;
		if (saved === destination) return <Check className="h-3 w-3" />;
		return destination === "active" ? (
			<NotebookPen className="h-3 w-3" />
		) : destination === "daily" ? (
			<CalendarPlus className="h-3 w-3" />
		) : (
			<Inbox className="h-3 w-3" />
		);
	}

	return (
		<>
			<button
				type="button"
				onClick={() => save("active")}
				disabled={busy !== null}
				aria-label="Append reply to active Obsidian note"
				title="Append reply to active Obsidian note"
				className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 disabled:opacity-40 text-muted-foreground/50 hover:text-foreground transition-opacity"
			>
				{icon("active")}
			</button>
			<button
				type="button"
				onClick={() => save("daily")}
				disabled={busy !== null}
				aria-label="Append reply to today's Obsidian daily note"
				title="Append reply to today's Obsidian daily note"
				className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 disabled:opacity-40 text-muted-foreground/50 hover:text-foreground transition-opacity"
			>
				{icon("daily")}
			</button>
			{capture && (
				<button
					type="button"
					onClick={() => save("capture")}
					disabled={busy !== null}
					aria-label={`Send reply to Obsidian ${capture.label}`}
					title={`Send to ${capture.label}\n${capture.vaultName}/${capture.folder}`}
					className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 disabled:opacity-40 text-muted-foreground/50 hover:text-foreground transition-opacity"
				>
					{icon("capture")}
				</button>
			)}
			{error && (
				<span
					title={error}
					className="inline-flex max-w-48 items-start gap-1 text-[9px] leading-tight text-destructive"
					role="alert"
				>
					<AlertCircle className="h-3 w-3" />
					<span>{error}</span>
				</span>
			)}
			{saved && (
				<output className="whitespace-nowrap text-[9px] text-primary/70">
					saved to{" "}
					{saved === "active"
						? "active note"
						: saved === "daily"
							? "daily note"
							: capture?.label}
				</output>
			)}
		</>
	);
}
