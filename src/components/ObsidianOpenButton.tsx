import { AlertCircle, ExternalLink, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { openObsidianNoteFn } from "#/lib/serverFns/obsidian";

export function ObsidianOpenButton({
	relativePath,
	className = "",
	labeled = false,
}: {
	relativePath: string;
	className?: string;
	labeled?: boolean;
}) {
	const [state, setState] = useState<"idle" | "loading" | "error">("idle");
	const [error, setError] = useState<string | null>(null);

	async function openNote() {
		setState("loading");
		setError(null);
		try {
			await openObsidianNoteFn({ data: relativePath });
			setState("idle");
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not open the note in Obsidian",
			);
			setState("error");
		}
	}

	const label =
		state === "loading"
			? `Opening ${relativePath} in Obsidian`
			: state === "error"
				? `Open in Obsidian failed: ${error}`
				: `Open ${relativePath} in Obsidian`;

	return (
		<button
			type="button"
			onClick={() => void openNote()}
			disabled={state === "loading"}
			aria-label={label}
			title={label}
			className={`${className} shrink-0 transition-colors disabled:opacity-30 ${
				state === "error"
					? "text-destructive"
					: "text-primary/45 hover:text-primary"
			}`}
		>
			<span
				className={labeled ? "inline-flex items-center gap-1.5" : undefined}
			>
				{state === "loading" ? (
					<LoaderCircle className="h-3 w-3 animate-spin" />
				) : state === "error" ? (
					<AlertCircle className="h-3 w-3" />
				) : (
					<ExternalLink className="h-3 w-3" />
				)}
				{labeled && <span>Open in Obsidian</span>}
			</span>
		</button>
	);
}
