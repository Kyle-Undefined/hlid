import {
	Braces,
	ChevronRight,
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
import type {
	HlidToolLoadingSummary,
	HlidTurnContextManifest,
} from "#/lib/hlidContext";
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

type ProviderContextUsage = {
	contextWindow: number | null;
	used: number | null;
	actualModel: string | null;
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

function ContextDisclosure({
	title,
	meta,
	children,
}: {
	title: string;
	meta: string;
	children: ReactNode;
}) {
	return (
		<details className="group/disclosure border border-border/40 bg-background/20">
			<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-[10px] [&::-webkit-details-marker]:hidden">
				<span className="flex items-center gap-1.5 text-foreground/70 group-open/disclosure:text-primary/70">
					<ChevronRight className="h-3 w-3 transition-transform group-open/disclosure:rotate-90" />
					<span>{title}</span>
				</span>
				<span className="font-mono text-[9px] text-muted-foreground/50">
					{meta}
				</span>
			</summary>
			<div className="border-t border-border/35 px-3 py-2.5">{children}</div>
		</details>
	);
}

function ToolInventory({ namespace }: { namespace: HlidToolLoadingSummary }) {
	if (!namespace.tools?.length) {
		return (
			<p className="text-[9px] text-muted-foreground/45">
				Detailed inventory was not recorded for this turn.
			</p>
		);
	}
	const groups = [
		{
			label: "Loaded",
			tools: namespace.tools.filter((tool) => tool.delivery === "loaded"),
		},
		{
			label: "Deferred",
			tools: namespace.tools.filter((tool) => tool.delivery === "deferred"),
		},
	].filter((group) => group.tools.length > 0);
	return (
		<div className="space-y-3">
			{groups.map((group) => (
				<div key={group.label}>
					<div className="mb-1.5 flex items-center justify-between text-[8px] tracking-widest text-muted-foreground/45 uppercase">
						<span>{group.label}</span>
						<span>{group.tools.length.toLocaleString()}</span>
					</div>
					<div className="divide-y divide-border/25 border border-border/30 bg-card/15">
						{group.tools.map((tool) => (
							<div
								key={tool.name}
								className="px-2.5 py-1.5 font-mono text-[9px] text-foreground/65"
							>
								{tool.name}
							</div>
						))}
					</div>
				</div>
			))}
		</div>
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

function LastSentContext({
	context,
	providerUsage,
}: {
	context: HlidTurnContextManifest;
	providerUsage: ProviderContextUsage;
}) {
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

			<ContextSection icon={Braces} title="Context sources">
				<div className="space-y-2">
					<ContextDisclosure
						title="Hlid context"
						meta={`${context.hlidAddedChars.toLocaleString()} chars`}
					>
						{context.operatingBrief && (
							<div className="mb-3 flex items-center justify-between gap-3 border-b border-border/40 pb-2 text-[10px]">
								<span className="text-foreground/65">
									Operating contract v{context.operatingBrief.version}
									{context.operatingBrief.briefRevision
										? ` · Brief ${context.operatingBrief.briefRevision}`
										: context.operatingBrief.registryRevision
											? ` · Legacy revision ${context.operatingBrief.registryRevision}`
											: ""}
								</span>
								<span className="font-mono text-muted-foreground/50">
									{context.operatingBrief.delivery === "not-delivered"
										? "Not delivered on provider command"
										: context.operatingBrief.included
											? `Included · ${context.operatingBrief.chars.toLocaleString()} chars`
											: "Already established"}
								</span>
							</div>
						)}
						{context.operatingBrief?.preview && (
							<pre className="mb-3 max-h-48 overflow-auto whitespace-pre-wrap border border-border/35 bg-card/25 p-2 font-mono text-[9px] leading-relaxed text-muted-foreground/65">
								{context.operatingBrief.preview}
							</pre>
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
						<p className="mt-3 text-[9px] leading-relaxed text-muted-foreground/45">
							Exact reference identities and selected inputs are itemized below.
							Large selected content is not duplicated into this receipt.
						</p>
					</ContextDisclosure>

					<ContextDisclosure
						title="Provider context"
						meta={
							providerUsage.used !== null &&
							providerUsage.contextWindow !== null
								? `${providerUsage.used.toLocaleString()} / ${providerUsage.contextWindow.toLocaleString()} tokens`
								: "Provider-owned"
						}
					>
						<div className="space-y-2 text-[10px] text-muted-foreground/60">
							<div className="flex justify-between gap-3">
								<span>Visible turn input</span>
								<span className="font-mono">
									{context.providerPromptChars.toLocaleString()} chars
								</span>
							</div>
							<div className="flex justify-between gap-3">
								<span>User message</span>
								<span className="font-mono">
									{context.userMessageChars.toLocaleString()} chars
								</span>
							</div>
							<div className="flex justify-between gap-3">
								<span>Hlid additions</span>
								<span className="font-mono">
									{context.hlidAddedChars.toLocaleString()} chars
								</span>
							</div>
							<div className="flex justify-between gap-3">
								<span>Visible transcript handoff</span>
								<span className="font-mono">
									{context.providerHandoffChars.toLocaleString()} chars
								</span>
							</div>
							<div className="flex justify-between gap-3">
								<span>Actual model</span>
								<span className="font-mono">
									{providerUsage.actualModel ?? context.model ?? "Unknown"}
								</span>
							</div>
							<div className="flex items-start justify-between gap-3 border-t border-border/35 pt-2">
								<span>Native system and hidden session context</span>
								<span className="max-w-[55%] text-right">
									Provider-owned and not exposed to Hlid
								</span>
							</div>
						</div>
					</ContextDisclosure>
				</div>
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

			<ContextSection icon={Puzzle} title="Tool context">
				<div className="space-y-2">
					<ContextDisclosure
						title="Hlid-owned tools"
						meta={`${context.toolLoading.reduce((sum, item) => sum + item.total, 0)} registered`}
					>
						<div className="space-y-2">
							{context.toolLoading.map((namespace) => (
								<details
									key={namespace.namespace}
									className="group/tool border border-border/35"
								>
									<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-2.5 py-2 text-[10px] [&::-webkit-details-marker]:hidden">
										<span className="flex items-center gap-1.5">
											<ChevronRight className="h-3 w-3 transition-transform group-open/tool:rotate-90" />
											<code className="text-foreground/65">
												{namespace.namespace}
											</code>
										</span>
										<span className="text-muted-foreground/50">
											{namespace.deferred === 0
												? `${namespace.total} loaded`
												: `${namespace.deferred} of ${namespace.total} deferred`}
										</span>
									</summary>
									<div className="border-t border-border/30 px-2.5 py-2">
										<ToolInventory namespace={namespace} />
									</div>
								</details>
							))}
						</div>
					</ContextDisclosure>

					<ContextDisclosure
						title="Provider-native tools"
						meta="Provider-owned"
					>
						<p className="text-[10px] leading-relaxed text-muted-foreground/55">
							The active provider owns its native tool catalog and system tool
							schemas. Hlid records provider tool activity in the transcript,
							but the complete native catalog is not exposed to Hlid.
						</p>
					</ContextDisclosure>
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
	const [providerUsage, setProviderUsage] = useState<ProviderContextUsage>({
		contextWindow: null,
		used: null,
		actualModel: null,
	});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { dialogRef, onDialogKeyDown } = useDialogFocus<HTMLDivElement>(
		onClose,
		true,
		"dialog",
	);

	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);
		void getSessionContextFn({ data: sessionId }).then(
			(result) => {
				if (!active) return;
				setContext(result?.hlid_context ?? null);
				setProviderUsage({
					contextWindow: result?.context_window ?? null,
					used: result?.last_context_used ?? null,
					actualModel: result?.actual_model ?? null,
				});
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
				className="flex max-h-[min(88vh,760px)] w-full max-w-3xl flex-col overflow-hidden border border-border bg-background shadow-2xl outline-none focus:outline-none focus-visible:ring-0"
			>
				<header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
					<ShieldCheck className="h-4 w-4 text-primary/65" />
					<div className="min-w-0 flex-1">
						<h2 className="text-sm font-medium text-foreground/85">
							Hlid context
						</h2>
						<p className="mt-0.5 text-[10px] text-muted-foreground/50">
							Hlid additions and provider-reported usage. Hidden provider
							instructions remain provider-owned.
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
						<LastSentContext context={context} providerUsage={providerUsage} />
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
