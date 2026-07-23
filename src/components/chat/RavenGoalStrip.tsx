import { Pause, Pencil, Play, Target, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { GoalState } from "#/server/protocol";

type Props = {
	goal: GoalState | null;
	editorOpen: boolean;
	pending: boolean;
	error: string | null;
	onOpenEditor: () => void;
	onCloseEditor: () => void;
	onSet: (objective: string, tokenBudget?: number | null) => void;
	onPause: () => void;
	onResume: () => void;
	onClear: () => void;
	onDismissError: () => void;
};

const statusLabels: Record<GoalState["status"], string> = {
	active: "Active",
	paused: "Paused",
	blocked: "Blocked",
	usageLimited: "Usage limited",
	budgetLimited: "Budget reached",
	complete: "Complete",
};

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = Math.round(seconds % 60);
	return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

function useLiveGoalDuration(goal: GoalState | null): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (goal?.status !== "active") return;
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [goal?.status]);
	if (!goal) return 0;
	const elapsedSinceSnapshot =
		goal.status === "active"
			? Math.max(0, Math.floor(now / 1_000) - goal.updated_at)
			: 0;
	return goal.time_used_seconds + elapsedSinceSnapshot;
}

function GoalEditor({
	goal,
	pending,
	onClose,
	onSet,
}: Pick<Props, "goal" | "pending" | "onSet"> & { onClose: () => void }) {
	const [objective, setObjective] = useState(goal?.objective ?? "");
	const [budget, setBudget] = useState(
		goal?.token_budget == null ? "" : String(goal.token_budget),
	);
	useEffect(() => {
		setObjective(goal?.objective ?? "");
		setBudget(goal?.token_budget == null ? "" : String(goal.token_budget));
	}, [goal]);
	const parsedBudget = budget ? Number(budget) : null;
	const canSave =
		objective.trim().length > 0 &&
		objective.length <= 4000 &&
		(parsedBudget === null ||
			(Number.isInteger(parsedBudget) && parsedBudget > 0));
	return (
		<form
			className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-center"
			onSubmit={(event) => {
				event.preventDefault();
				if (!canSave) return;
				onSet(objective.trim(), parsedBudget);
			}}
		>
			<input
				aria-label="Goal objective"
				className="min-w-0 flex-1 border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary/60"
				maxLength={4000}
				placeholder="What should Codex keep working toward?"
				value={objective}
				onChange={(event) => setObjective(event.target.value)}
			/>
			<div className="flex items-center gap-1.5">
				<input
					aria-label="Goal token budget"
					className="w-28 border border-border bg-background px-2.5 py-1.5 text-xs tabular-nums text-foreground outline-none focus:border-primary/60"
					min={1}
					placeholder="Token budget"
					type="number"
					value={budget}
					onChange={(event) => setBudget(event.target.value)}
				/>
				<button
					className="bg-primary px-2.5 py-1.5 text-[9px] font-medium tracking-wider text-primary-foreground uppercase disabled:opacity-40"
					disabled={!canSave || pending}
					type="submit"
				>
					{pending ? "Saving" : "Save"}
				</button>
				<button
					aria-label="Close goal editor"
					className="p-1.5 text-muted-foreground/55 hover:text-foreground"
					onClick={onClose}
					type="button"
				>
					<X className="size-3.5" />
				</button>
			</div>
		</form>
	);
}

export function RavenGoalStrip(props: Props) {
	const liveDuration = useLiveGoalDuration(props.goal);
	if (!props.goal && !props.editorOpen && !props.error) return null;
	return (
		<section
			aria-label="Codex goal"
			className="shrink-0 border-b border-border bg-muted/15 px-3 py-2"
		>
			<div className="mx-auto flex w-full max-w-5xl min-w-0 items-start gap-2">
				<Target className="mt-0.5 size-3.5 shrink-0 text-primary/70" />
				{props.editorOpen ? (
					<GoalEditor
						goal={props.goal}
						pending={props.pending}
						onClose={props.onCloseEditor}
						onSet={props.onSet}
					/>
				) : (
					<div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center">
						<div className="min-w-0 flex-1">
							<div className="flex min-w-0 items-center gap-2">
								<span className="shrink-0 text-[8px] font-medium tracking-widest text-muted-foreground/55 uppercase">
									Goal
								</span>
								{props.goal && (
									<>
										<span className="truncate text-xs text-foreground/85">
											{props.goal.objective}
										</span>
										<span className="shrink-0 text-[8px] tracking-wider text-primary/65 uppercase">
											{props.pending
												? "Saving"
												: statusLabels[props.goal.status]}
										</span>
									</>
								)}
							</div>
							{props.goal && (
								<div className="mt-0.5 text-[9px] tabular-nums text-muted-foreground/45">
									{props.goal.tokens_used.toLocaleString()} tokens
									{props.goal.token_budget != null &&
										` / ${props.goal.token_budget.toLocaleString()}`}
									<span className="px-1.5">·</span>
									{formatDuration(liveDuration)}
								</div>
							)}
						</div>
						<div className="flex shrink-0 items-center gap-0.5">
							{props.goal?.status === "active" ? (
								<button
									aria-label="Pause goal"
									className="p-1.5 text-muted-foreground/55 hover:text-foreground disabled:opacity-35"
									disabled={props.pending}
									onClick={props.onPause}
									type="button"
								>
									<Pause className="size-3.5" />
								</button>
							) : props.goal ? (
								<button
									aria-label="Resume goal"
									className="p-1.5 text-muted-foreground/55 hover:text-foreground disabled:opacity-35"
									disabled={props.pending}
									onClick={props.onResume}
									type="button"
								>
									<Play className="size-3.5" />
								</button>
							) : null}
							<button
								aria-label={props.goal ? "Edit goal" : "Set goal"}
								className="p-1.5 text-muted-foreground/55 hover:text-foreground disabled:opacity-35"
								disabled={props.pending}
								onClick={props.onOpenEditor}
								type="button"
							>
								<Pencil className="size-3.5" />
							</button>
							{props.goal && (
								<button
									aria-label="Clear goal"
									className="p-1.5 text-muted-foreground/55 hover:text-destructive disabled:opacity-35"
									disabled={props.pending}
									onClick={props.onClear}
									type="button"
								>
									<Trash2 className="size-3.5" />
								</button>
							)}
						</div>
					</div>
				)}
			</div>
			{props.error && (
				<div className="mx-auto mt-1.5 flex w-full max-w-5xl items-center justify-between gap-2 text-[10px] text-destructive/80">
					<span>{props.error}</span>
					<button
						aria-label="Dismiss goal error"
						className="shrink-0 p-1 hover:text-destructive"
						onClick={props.onDismissError}
						type="button"
					>
						<X className="size-3" />
					</button>
				</div>
			)}
		</section>
	);
}
