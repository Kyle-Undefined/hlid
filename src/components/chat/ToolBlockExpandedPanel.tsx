import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import { semanticStatusClass } from "#/lib/themeClasses";

const LARGE_TOOL_TEXT_CHARS = 20_000;

export type ToolDiffChange = {
	path: string;
	kind?: string;
	diff: string;
};

export type ToolResultMeta = [label: string, value: string];

function formatInputValue(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2) ?? String(value);
}

function LargeToolText({
	text,
	label,
	isError = false,
}: {
	text: string;
	label: string;
	isError?: boolean;
}) {
	return (
		<textarea
			aria-label={label}
			className={`block h-64 w-full resize-none overflow-auto whitespace-pre border-0 bg-transparent px-3 pb-3 text-[11px] font-mono leading-relaxed outline-none ${
				isError ? "text-destructive/80" : "text-primary/70"
			}`}
			defaultValue={text}
			readOnly
			spellCheck={false}
			wrap="off"
		/>
	);
}

type DiffLineTone = "addition" | "deletion" | "hunk" | "header" | "context";

type DiffLineCounts = {
	additions: number;
	deletions: number;
};

function diffLineTone(line: string): DiffLineTone {
	if (line.startsWith("+") && !line.startsWith("+++")) return "addition";
	if (line.startsWith("-") && !line.startsWith("---")) return "deletion";
	if (line.startsWith("@@")) return "hunk";
	if (
		line.startsWith("diff ") ||
		line.startsWith("index ") ||
		line.startsWith("---") ||
		line.startsWith("+++")
	)
		return "header";
	return "context";
}

function diffLineClass(tone: DiffLineTone): string {
	switch (tone) {
		case "addition":
			return `${semanticStatusClass.success.textMuted} bg-status-success/5`;
		case "deletion":
			return `${semanticStatusClass.danger.textMuted} bg-destructive/5`;
		case "hunk":
			return `${semanticStatusClass.info.textMuted} bg-status-info/5`;
		case "header":
			return "text-muted-foreground/65 bg-muted/30";
		default:
			return "text-primary/65";
	}
}

function diffLineCounts(diff: string): DiffLineCounts {
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		const tone = diffLineTone(line);
		if (tone === "addition") additions++;
		if (tone === "deletion") deletions++;
	}
	return { additions, deletions };
}

function diffCountLabel(count: number, singular: string): string {
	return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function DiffText({ change }: { change: ToolDiffChange }) {
	if (change.diff.length > LARGE_TOOL_TEXT_CHARS) {
		return <LargeToolText text={change.diff} label={`${change.path} diff`} />;
	}
	return (
		<section
			aria-label={`${change.path} diff`}
			className="max-h-80 overflow-auto overscroll-contain font-mono text-[10px] leading-relaxed sm:max-h-[28rem]"
		>
			<div data-diff-scroll-canvas className="min-w-full w-max">
				{change.diff.split("\n").map((line, index) => (
					<span
						// A diff can repeat identical lines; its position is the stable identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: ordered immutable diff lines
						key={index}
						className={`block w-full whitespace-pre px-3 ${diffLineClass(diffLineTone(line))}`}
					>
						{line || " "}
					</span>
				))}
			</div>
		</section>
	);
}

function DiffChangeSection({
	change,
	defaultOpen,
}: {
	change: ToolDiffChange;
	defaultOpen: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const regionId = useId();
	const counts = diffLineCounts(change.diff);
	const countLabel = `${diffCountLabel(counts.additions, "addition")}, ${diffCountLabel(counts.deletions, "deletion")}`;
	return (
		<section>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={regionId}
				aria-label={`${open ? "Collapse" : "Expand"} diff for ${change.path}, ${countLabel}`}
				onClick={() => setOpen((current) => !current)}
				className="group flex min-h-9 w-full min-w-0 items-center gap-2 border-b border-[var(--tool-panel-border)] bg-muted/20 px-3 py-1.5 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/55"
			>
				<ChevronRight
					className={`h-3 w-3 shrink-0 text-primary/45 transition-transform duration-150 group-hover:text-primary/75 ${open ? "rotate-90" : ""}`}
					aria-hidden="true"
				/>
				<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-primary/75">
					{change.path}
				</span>
				<span
					aria-hidden="true"
					className="flex shrink-0 items-center gap-1.5 font-mono text-[9px] tabular-nums"
				>
					<span className={semanticStatusClass.success.textMuted}>
						+{counts.additions}
					</span>
					<span className={semanticStatusClass.danger.textMuted}>
						-{counts.deletions}
					</span>
				</span>
				{change.kind && (
					<span className="shrink-0 text-[8px] uppercase tracking-widest text-muted-foreground/55">
						{change.kind}
					</span>
				)}
			</button>
			{open && (
				<div id={regionId}>
					<DiffText change={change} />
				</div>
			)}
		</section>
	);
}

function DiffResult({ changes }: { changes: ToolDiffChange[] }) {
	const defaultOpen = changes.length === 1;
	return (
		<div className="divide-y divide-[var(--tool-panel-border)]">
			{changes.map((change) => (
				<DiffChangeSection
					key={change.path}
					change={change}
					defaultOpen={defaultOpen}
				/>
			))}
		</div>
	);
}

/** Expanded tool-call detail: input args (if any) followed by the result/error/reasoning body. */
export function ToolBlockExpandedPanel({
	inputEntries,
	hasResult,
	isError,
	isReasoning,
	renderResultAsMarkdown,
	strippedResult,
	resultLabel,
	resultMeta = [],
	diffChanges = [],
}: {
	inputEntries: [string, unknown][];
	hasResult: boolean;
	isError?: boolean;
	isReasoning: boolean;
	renderResultAsMarkdown: boolean;
	strippedResult: string;
	resultLabel?: string;
	resultMeta?: ToolResultMeta[];
	diffChanges?: ToolDiffChange[];
}) {
	const largeResult = strippedResult.length > LARGE_TOOL_TEXT_CHARS;
	const heading =
		diffChanges.length > 0 && resultLabel
			? resultLabel
			: isError
				? "Error"
				: (resultLabel ?? (isReasoning ? "Reasoning" : "Result"));
	return (
		<PrivacyMask className="mx-3 mb-1.5 min-w-0 max-w-[calc(100%_-_1.5rem)] overflow-hidden border border-[var(--tool-panel-border)] bg-[var(--tool-panel)]">
			{inputEntries.length > 0 && (
				<section>
					<div className="px-3 pb-1 pt-2 text-[9px] uppercase tracking-widest text-muted-foreground/50">
						Call
					</div>
					<div className="max-h-48 min-w-0 max-w-full space-y-1 overflow-x-hidden overflow-y-auto px-3 pb-3 font-mono text-[11px] leading-relaxed text-primary/65">
						{inputEntries.map(([k, v]) => {
							const text = formatInputValue(v);
							return (
								<div key={k} className="flex min-w-0 gap-1.5">
									<span className="shrink-0 text-primary/40">{k}:</span>
									{text.length > LARGE_TOOL_TEXT_CHARS ? (
										<textarea
											aria-label={`${k} tool input`}
											className="h-40 min-w-0 flex-1 resize-none overflow-auto whitespace-pre border-0 bg-transparent p-0 text-primary/65 outline-none"
											defaultValue={text}
											readOnly
											spellCheck={false}
											wrap="off"
										/>
									) : (
										<span className="min-w-0 max-w-full flex-1 overflow-hidden whitespace-pre-wrap break-all">
											{text}
										</span>
									)}
								</div>
							);
						})}
					</div>
				</section>
			)}
			{hasResult && (
				<div
					className={
						inputEntries.length > 0
							? "border-t border-[var(--tool-panel-border)]"
							: undefined
					}
				>
					<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-1 pt-2">
						<span
							className={`text-[9px] uppercase tracking-widest ${
								isError ? "text-destructive/70" : "text-muted-foreground/50"
							}`}
						>
							{heading}
						</span>
						{resultMeta.map(([label, value]) => (
							<span
								key={label}
								className="font-mono text-[8px] text-muted-foreground/55"
							>
								{label} {value}
							</span>
						))}
					</div>
					{diffChanges.length > 0 ? (
						<>
							<DiffResult changes={diffChanges} />
							{strippedResult.length > 0 && (
								<div className="border-t border-[var(--tool-panel-border)]">
									<div
										className={`px-3 pb-1 pt-2 text-[9px] uppercase tracking-widest ${
											isError
												? "text-destructive/70"
												: "text-muted-foreground/50"
										}`}
									>
										{isError ? "Error" : "Result"}
									</div>
									{largeResult ? (
										<LargeToolText
											text={strippedResult}
											label="Full tool result"
											isError={isError}
										/>
									) : (
										<pre
											className={`max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-[11px] leading-relaxed ${
												isError ? "text-destructive/80" : "text-primary/70"
											}`}
										>
											{strippedResult}
										</pre>
									)}
								</div>
							)}
						</>
					) : largeResult ? (
						<LargeToolText
							text={strippedResult}
							label="Full tool result"
							isError={isError}
						/>
					) : renderResultAsMarkdown ? (
						<div className="px-3 pb-3 overflow-auto max-h-64 text-[12px] text-primary/80 leading-relaxed">
							<MarkdownBody content={strippedResult} />
						</div>
					) : strippedResult.length > 0 ? (
						<pre
							className={`text-[11px] font-mono leading-relaxed px-3 pb-3 overflow-auto max-h-64 whitespace-pre-wrap break-words ${
								isError ? "text-destructive/80" : "text-primary/70"
							}`}
						>
							{strippedResult}
						</pre>
					) : (
						<div className="px-3 pb-3 font-mono text-[10px] text-muted-foreground/50">
							(no output)
						</div>
					)}
				</div>
			)}
		</PrivacyMask>
	);
}
