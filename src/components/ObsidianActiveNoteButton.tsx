import { AlertCircle, BookOpenText, Check, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { getActiveObsidianNoteFn } from "#/lib/serverFns/obsidian";
import type { VaultReferenceItem } from "#/lib/vaultReferences";

export function ObsidianActiveNoteButton({
	onAdd,
	className = "",
}: {
	onAdd: (reference: VaultReferenceItem) => void;
	className?: string;
}) {
	const [state, setState] = useState<"idle" | "loading" | "added" | "error">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);

	function addActiveNote() {
		setState("loading");
		setError(null);
		void Promise.resolve()
			.then(() => getActiveObsidianNoteFn())
			.then((reference) => {
				onAdd(reference);
				setState("added");
			})
			.catch((cause: unknown) => {
				setError(
					cause instanceof Error
						? cause.message
						: "Could not read the active Obsidian note",
				);
				setState("error");
			});
	}

	const label =
		state === "loading"
			? "Reading active Obsidian note"
			: state === "added"
				? "Active Obsidian note attached"
				: state === "error"
					? `Active Obsidian note failed: ${error}`
					: "Attach active Obsidian note";

	return (
		<button
			type="button"
			onClick={addActiveNote}
			disabled={state === "loading"}
			aria-label={label}
			title={label}
			className={`${className} transition-colors disabled:opacity-30 ${
				state === "error"
					? "text-destructive"
					: state === "added"
						? "text-primary"
						: "text-muted-foreground/45 hover:text-muted-foreground"
			}`}
		>
			{state === "loading" ? (
				<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
			) : state === "added" ? (
				<Check className="h-3.5 w-3.5" />
			) : state === "error" ? (
				<AlertCircle className="h-3.5 w-3.5" />
			) : (
				<BookOpenText className="h-3.5 w-3.5" />
			)}
		</button>
	);
}
