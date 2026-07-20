import {
	AlertCircle,
	CalendarPlus,
	Check,
	LoaderCircle,
	NotebookPen,
} from "lucide-react";
import { useState } from "react";
import { appendToObsidianFn } from "#/lib/serverFns/obsidian";

type Destination = "active" | "daily";

export function SaveToObsidianActions({ text }: { text: string }) {
	const [busy, setBusy] = useState<Destination | null>(null);
	const [saved, setSaved] = useState<Destination | null>(null);
	const [error, setError] = useState<string | null>(null);

	function save(destination: Destination) {
		setBusy(destination);
		setSaved(null);
		setError(null);
		void Promise.resolve()
			.then(() => appendToObsidianFn({ data: { destination, content: text } }))
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
		) : (
			<CalendarPlus className="h-3 w-3" />
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
			{error && (
				<span title={error} className="text-destructive">
					<AlertCircle className="h-3 w-3" />
					<span className="sr-only">{error}</span>
				</span>
			)}
		</>
	);
}
