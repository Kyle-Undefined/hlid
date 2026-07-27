import {
	Braces,
	FileText,
	Gauge,
	LoaderCircle,
	Paperclip,
	Puzzle,
	ShieldCheck,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PrivacyMask } from "#/components/PrivacyMask";
import { useDialogFocus } from "#/hooks/useDialogFocus";
import type { HlidTurnContextManifest } from "#/lib/hlidContext";
import { getSessionContextFn } from "#/lib/serverFns/sessions";

export type PendingHlidContext = {
	providerId?: string;
	model?: string;
	effort?: string;
	permissionMode?: string;
	agentCwd?: string;
	skills: string[];
	attachments: Array<{ filename: string; mime: string }>;
	vaultReferences: string[];
	workspaceReferences: Array<{
		relativePath: string;
		mime: string;
		sha256: string;
	}>;
	planMode: boolean;
};

function formatCount(value: number, singular: string, plural = `${singular}s`) {
	return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

function deliveryLabel(
	delivery: HlidTurnContextManifest["vaultReferences"][number]["delivery"],
) {
	switch (delivery) {
		case "inline":
			return "Inlined";
		case "inline-truncated":
			return "Inlined, truncated";
		case "metadata":
			return "Identity only";
		case "unavailable":
			return "Unavailable";
	}
}

function blockLabel(
	kind: HlidTurnContextManifest["blocks"][number]["kind"],
): string {
	switch (kind) {
		case "operating_brief":
			return "Operating brief";
		case "workspace_instruction":
			return "Workspace instruction";
		case "attachments":
			return "Attachment paths";
		case "vault":
			return "Vault operating context";
		case "vault_references":
			return "Exact Vault notes";
		case "workspace_references":
			return "Workspace references";
		case "skills":
			return "Skills";
		case "plan":
			return "HTML plan instructions";
	}
}

function ContextMetric({ label, value }: { label: string; value: string }) {
	return (
		<div className="border border-border/50 bg-card/35 px-3 py-2.5">
			<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase">
				{label}
			</div>
			<div className="mt-1 font-mono text-[11px] text-foreground/75">
				{value}
			</div>
		</div>
	);
}

function ContextSection({
	icon: Icon,
	title,
	children,
}: {
	icon: typeof FileText;
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="border border-border/50 bg-card/20">
			<header className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
				<Icon className="h-3.5 w-3.5 text-primary/55" />
				<h3 className="text-[9px] font-medium tracking-widest text-primary/65 uppercase">
					{title}
				</h3>
			</header>
			<div className="p-3">{children}</div>
		</section>
	);
}

function PendingContextSummary({ context }: { context: PendingHlidContext }) {
	const itemCount =
		context.skills.length +
		context.attachments.length +
		context.vaultReferences.length +
		context.workspaceReferences.length;
	return (
		<ContextSection icon={Braces} title="Next turn selection">
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				<ContextMetric
					label="Vault"
					value={formatCount(context.vaultReferences.length, "note")}
				/>
				<ContextMetric
					label="Workspace"
					value={formatCount(context.workspaceReferences.length, "file")}
				/>
				<ContextMetric
					label="Attachments"
					value={formatCount(context.attachments.length, "item")}
				/>
				<ContextMetric
					label="Skills"
					value={formatCount(context.skills.length, "skill")}
				/>
			</div>
			<p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/55">
				{itemCount === 0
					? "Nothing is selected in the composer. Hlid will still apply the session and vault operating contract."
					: "These are the current Raven selections. Exact delivery and truncation are recorded server-side after the turn is assembled."}
			</p>
			<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[9px] text-muted-foreground/50">
				<span>{context.providerId ?? "provider pending"}</span>
				{context.model && <span>{context.model}</span>}
				{context.effort && <span>{context.effort}</span>}
				{context.permissionMode && <span>{context.permissionMode}</span>}
				{context.planMode && <span>plan mode</span>}
			</div>
		</ContextSection>
	);
}

function LastSentContext({ context }: { context: HlidTurnContextManifest }) {
	return (
		<>
			<ContextSection icon={Gauge} title="Last Hlid context sent">
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
					<ContextMetric
						label="Hlid added"
						value={`${context.hlidAddedChars.toLocaleString()} chars`}
					/>
					<ContextMetric
						label="Rough tokens"
						value={`~${context.estimatedHlidTokens.toLocaleString()}`}
					/>
					<ContextMetric
						label="Provider prompt"
						value={`${context.providerPromptChars.toLocaleString()} chars`}
					/>
					<ContextMetric
						label="Contract"
						value={`v${context.contractVersion}`}
					/>
				</div>
				<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[9px] text-muted-foreground/50">
					<span>{context.providerId}</span>
					{context.model && <span>{context.model}</span>}
					{context.effort && <span>{context.effort}</span>}
					{context.permissionMode && <span>{context.permissionMode}</span>}
					<span>{context.delivery}</span>
					{context.providerHandoffChars > 0 && (
						<span>
							{context.providerHandoffChars.toLocaleString()} handoff chars
						</span>
					)}
				</div>
			</ContextSection>

			<ContextSection icon={Braces} title="Hlid additions">
				{context.operatingBrief && (
					<div className="mb-3 flex items-center justify-between gap-3 border-b border-border/40 pb-2 text-[10px]">
						<span className="text-foreground/65">
							Operating contract v{context.operatingBrief.version}
						</span>
						<span className="font-mono text-muted-foreground/50">
							{context.operatingBrief.included
								? `Included · ${context.operatingBrief.chars.toLocaleString()} chars`
								: "Already established"}
						</span>
					</div>
				)}
				{context.blocks.length === 0 ? (
					<p className="text-[10px] text-muted-foreground/50">
						No Hlid-owned context blocks were added.
					</p>
				) : (
					<div className="space-y-2">
						{context.blocks.map((block) => (
							<div
								key={block.kind}
								className="flex items-center justify-between gap-3 text-[10px]"
							>
								<span className="text-foreground/65">
									{blockLabel(block.kind)}
								</span>
								<span className="font-mono text-muted-foreground/50">
									{block.chars.toLocaleString()} chars ·{" "}
									{formatCount(block.count, "item")}
								</span>
							</div>
						))}
					</div>
				)}
			</ContextSection>

			<ContextSection icon={FileText} title="Exact references">
				{context.vaultReferences.length === 0 &&
					context.workspaceReferences.length === 0 && (
						<p className="text-[10px] text-muted-foreground/50">
							No exact Vault or Workspace references were sent.
						</p>
					)}
				<div className="space-y-2">
					{context.vaultReferences.map((reference) => (
						<div
							key={`vault:${reference.path}`}
							className="flex min-w-0 items-start justify-between gap-3"
						>
							<PrivacyMask className="min-w-0 break-all font-mono text-[10px] text-foreground/65">
								{reference.path}
							</PrivacyMask>
							<span className="shrink-0 text-[9px] text-muted-foreground/50">
								{deliveryLabel(reference.delivery)}
								{reference.includedChars > 0
									? ` · ${reference.includedChars.toLocaleString()} chars`
									: ""}
							</span>
						</div>
					))}
					{context.workspaceReferences.map((reference) => (
						<div
							key={`workspace:${reference.path}:${reference.sha256}`}
							className="flex min-w-0 items-start justify-between gap-3"
						>
							<PrivacyMask className="min-w-0 break-all font-mono text-[10px] text-foreground/65">
								{reference.path}
							</PrivacyMask>
							<span className="shrink-0 text-[9px] text-muted-foreground/50">
								Identity · {reference.mime}
							</span>
						</div>
					))}
				</div>
			</ContextSection>

			<ContextSection icon={Paperclip} title="Instructions and inputs">
				<div className="space-y-2 text-[10px] text-muted-foreground/60">
					<div className="flex justify-between gap-3">
						<span>Workspace instruction</span>
						<PrivacyMask className="min-w-0 break-all text-right font-mono">
							{context.instructionFile ?? "None"}
						</PrivacyMask>
					</div>
					<div className="flex justify-between gap-3">
						<span>Skills</span>
						<span>{context.skills.length}</span>
					</div>
					<div className="flex justify-between gap-3">
						<span>Attachments</span>
						<span>{context.attachments.length}</span>
					</div>
					<div className="flex justify-between gap-3">
						<span>HTML plan instructions</span>
						<span>{context.planHtml ? "Included" : "Not included"}</span>
					</div>
				</div>
			</ContextSection>

			<ContextSection icon={Puzzle} title="Hlid tool loading">
				<div className="space-y-2">
					{context.toolLoading.map((namespace) => (
						<div
							key={namespace.namespace}
							className="flex items-center justify-between gap-3 text-[10px]"
						>
							<code className="text-foreground/65">{namespace.namespace}</code>
							<span className="text-muted-foreground/50">
								{namespace.deferred === 0
									? `${namespace.total} loaded`
									: `${namespace.deferred} of ${namespace.total} deferred`}
							</span>
						</div>
					))}
				</div>
			</ContextSection>
		</>
	);
}

export function ContextInspectorDialog({
	sessionId,
	pending,
	onClose,
}: {
	sessionId: string;
	pending: PendingHlidContext;
	onClose: () => void;
}) {
	const [context, setContext] = useState<HlidTurnContextManifest | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { dialogRef, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose);

	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);
		void getSessionContextFn({ data: sessionId }).then(
			(result) => {
				if (!active) return;
				setContext(result?.hlid_context ?? null);
				setLoading(false);
			},
			(fetchError) => {
				if (!active) return;
				setError(
					fetchError instanceof Error
						? fetchError.message
						: "Could not read Hlid context.",
				);
				setLoading(false);
			},
		);
		return () => {
			active = false;
		};
	}, [sessionId]);

	return createPortal(
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the focused dialog
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop pattern
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-3 backdrop-blur-sm sm:p-5"
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="Hlid context"
				onClick={(event) => event.stopPropagation()}
				onKeyDown={onDialogKeyDown}
				className="flex max-h-[min(88vh,760px)] w-full max-w-3xl flex-col overflow-hidden border border-border bg-background shadow-2xl"
			>
				<header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
					<ShieldCheck className="h-4 w-4 text-primary/65" />
					<div className="min-w-0 flex-1">
						<h2 className="text-sm font-medium text-foreground/85">
							Hlid context
						</h2>
						<p className="mt-0.5 text-[10px] text-muted-foreground/50">
							Hlid-owned additions only. Provider system instructions remain
							provider-owned.
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close Hlid context"
						className="grid h-9 w-9 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<X className="h-4 w-4" />
					</button>
				</header>

				<div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4">
					<PendingContextSummary context={pending} />
					{loading ? (
						<div className="flex min-h-32 items-center justify-center gap-2 text-[10px] text-muted-foreground/50">
							<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
							Loading last sent context
						</div>
					) : error ? (
						<p role="alert" className="text-[10px] text-destructive/75">
							{error}
						</p>
					) : context ? (
						<LastSentContext context={context} />
					) : (
						<div className="border border-border/50 px-3 py-5 text-center text-[10px] text-muted-foreground/50">
							No persisted Hlid context exists yet. Send a normal turn, then
							reopen <code>/context</code>.
						</div>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
