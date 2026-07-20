import {
	AlertCircle,
	BookOpenText,
	Check,
	LoaderCircle,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { getActiveObsidianNoteFn } from "#/lib/serverFns/obsidian";
import { TRANSIENT_FEEDBACK_MS } from "#/lib/transientFeedback";
import type { VaultReferenceItem } from "#/lib/vaultReferences";

export function ObsidianActiveNoteError({
	error,
	onDismiss,
}: {
	error: string;
	onDismiss: () => void;
}) {
	return (
		<div
			className="absolute bottom-full left-0 z-30 mb-2 flex max-h-32 w-[min(18rem,calc(100vw-2rem))] items-start gap-2 overflow-auto border border-destructive/40 bg-background p-2 text-[10px] leading-relaxed text-destructive shadow-lg"
			role="alert"
		>
			<span className="min-w-0 flex-1">{error}</span>
			<button
				type="button"
				onClick={onDismiss}
				className="shrink-0 text-destructive/60 hover:text-destructive"
				aria-label="Dismiss active Obsidian note error"
			>
				<X className="h-3 w-3" />
			</button>
		</div>
	);
}

export function ObsidianActiveNoteButton({
	onAdd,
	className = "",
	containerClassName = "",
}: {
	onAdd: (reference: VaultReferenceItem) => void;
	className?: string;
	containerClassName?: string;
}) {
	const [state, setState] = useState<"idle" | "loading" | "added" | "error">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (state !== "added") return;
		const timer = setTimeout(() => setState("idle"), TRANSIENT_FEEDBACK_MS);
		return () => clearTimeout(timer);
	}, [state]);

	function fail(cause: unknown) {
		setError(
			cause instanceof Error
				? cause.message
				: typeof cause === "string" && cause
					? cause
					: "Could not read the active Obsidian note",
		);
		setState("error");
	}

	function addActiveNote() {
		setState("loading");
		setError(null);
		try {
			void getActiveObsidianNoteFn().then((reference) => {
				onAdd(reference);
				setState("added");
			}, fail);
		} catch (cause) {
			fail(cause);
		}
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
		<div className={`relative inline-flex shrink-0 ${containerClassName}`}>
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
			{error && (
				<ObsidianActiveNoteError
					error={error}
					onDismiss={() => {
						setError(null);
						setState("idle");
					}}
				/>
			)}
		</div>
	);
}
