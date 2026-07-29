import {
	Braces,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	FileText,
	Gauge,
	History,
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
	HlidContextReceipt,
	HlidContextReceiptTarget,
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

const CONTEXT_RECEIPT_PAGE_SIZE = 20;

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
		case "delegation_context":
			return "Delegated visible context";
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

function receiptTimestamp(receipt: HlidContextReceipt): string {
	const recordedAt =
		receipt.context.recordedAt || Math.max(0, receipt.timestamp) * 1_000;
	return new Date(recordedAt).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function receiptTurnLabel(receipt: HlidContextReceipt, index: number): string {
	return receipt.turnNumber
		? `Turn ${receipt.turnNumber}`
		: index === 0
			? "Latest turn"
			: "Earlier turn";
}

function TurnReceiptPicker({
	receipts,
	selectedSeq,
	onSelectReceipt,
	hasMore,
	loadingOlder,
	onLoadOlder,
}: {
	receipts: HlidContextReceipt[];
	selectedSeq: number;
	onSelectReceipt: (seq: number) => void;
	hasMore: boolean;
	loadingOlder: boolean;
	onLoadOlder: () => Promise<HlidContextReceipt[]>;
}) {
	const selectedIndex = Math.max(
		0,
		receipts.findIndex((receipt) => receipt.seq === selectedSeq),
	);
	const selected = receipts[selectedIndex] ?? receipts[0];
	const newer = selectedIndex > 0 ? receipts[selectedIndex - 1] : undefined;
	const older = receipts[selectedIndex + 1];
	const selectOlder = () => {
		if (older) {
			onSelectReceipt(older.seq);
			return;
		}
		if (!hasMore || loadingOlder) return;
		void onLoadOlder().then((loaded) => {
			if (loaded[0]) onSelectReceipt(loaded[0].seq);
		});
	};
	if (!selected) return null;
	return (
		<div className="mb-3 space-y-2 border-b border-border/40 pb-3">
			<div className="grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-stretch border border-border/50 bg-background/35">
				<button
					type="button"
					onClick={() => newer && onSelectReceipt(newer.seq)}
					disabled={!newer}
					aria-label="Newer turn context"
					title="Newer turn"
					className="grid place-items-center border-r border-border/40 text-muted-foreground transition-colors hover:bg-primary/5 hover:text-primary disabled:cursor-default disabled:opacity-20"
				>
					<ChevronUp className="h-4 w-4" />
				</button>
				<div className="min-w-0 px-3 py-2.5">
					<div className="flex min-w-0 items-center gap-2">
						<span className="shrink-0 text-[10px] font-medium text-foreground/75">
							{receiptTurnLabel(selected, selectedIndex)}
						</span>
						{selectedIndex === 0 && (
							<span className="shrink-0 border border-primary/25 bg-primary/5 px-1.5 py-0.5 text-[7px] tracking-widest text-primary/65 uppercase">
								Latest
							</span>
						)}
						<span className="ml-auto truncate font-mono text-[9px] text-muted-foreground/50">
							{receiptTimestamp(selected)}
						</span>
					</div>
					<PrivacyMask className="mt-1 block truncate text-[10px] text-muted-foreground/65">
						{selected.messagePreview || "No message preview retained"}
					</PrivacyMask>
				</div>
				<button
					type="button"
					onClick={selectOlder}
					disabled={(!older && !hasMore) || loadingOlder}
					aria-label="Older turn context"
					title="Older turn"
					className="grid place-items-center border-l border-border/40 text-muted-foreground transition-colors hover:bg-primary/5 hover:text-primary disabled:cursor-default disabled:opacity-20"
				>
					{loadingOlder && !older ? (
						<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
					) : (
						<ChevronDown className="h-4 w-4" />
					)}
				</button>
			</div>

			<details className="group/history border border-border/40 bg-background/20">
				<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-[9px] text-muted-foreground/60 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
					<span className="flex items-center gap-1.5">
						<History className="h-3.5 w-3.5" />
						Browse turns
					</span>
					<span className="font-mono text-[8px]">
						{receipts.length.toLocaleString()} loaded
					</span>
				</summary>
				<div className="max-h-56 overflow-y-auto overscroll-contain border-t border-border/35">
					{receipts.map((receipt, index) => {
						const isSelected = receipt.seq === selectedSeq;
						return (
							<button
								key={receipt.seq}
								type="button"
								aria-current={isSelected ? "true" : undefined}
								onClick={() => onSelectReceipt(receipt.seq)}
								className={`block w-full min-w-0 border-b border-border/25 px-3 py-2 text-left transition-colors last:border-b-0 ${
									isSelected
										? "bg-primary/[0.08]"
										: "hover:bg-primary/5 hover:text-foreground"
								}`}
							>
								<span className="flex items-center justify-between gap-3">
									<span
										className={`text-[9px] font-medium ${
											isSelected ? "text-primary/75" : "text-foreground/65"
										}`}
									>
										{receiptTurnLabel(receipt, index)}
										{index === 0 ? " · Latest" : ""}
									</span>
									<span className="shrink-0 font-mono text-[8px] text-muted-foreground/45">
										{receiptTimestamp(receipt)}
									</span>
								</span>
								<PrivacyMask className="mt-0.5 block truncate text-[9px] text-muted-foreground/55">
									{receipt.messagePreview || "No message preview retained"}
								</PrivacyMask>
							</button>
						);
					})}
					{hasMore && (
						<button
							type="button"
							onClick={() => void onLoadOlder()}
							disabled={loadingOlder}
							className="flex w-full items-center justify-center gap-1.5 px-3 py-2.5 text-[9px] text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground disabled:cursor-wait disabled:opacity-50"
						>
							{loadingOlder && (
								<LoaderCircle className="h-3 w-3 animate-spin" />
							)}
							{loadingOlder ? "Loading older" : "Load older turns"}
						</button>
					)}
				</div>
			</details>
		</div>
	);
}

function LastSentContext({
	context,
	providerUsage,
	receipts,
	selectedSeq,
	onSelectReceipt,
	hasMore,
	loadingOlder,
	onLoadOlder,
}: {
	context: HlidTurnContextManifest;
	providerUsage: ProviderContextUsage;
	receipts: HlidContextReceipt[];
	selectedSeq: number;
	onSelectReceipt: (seq: number) => void;
	hasMore: boolean;
	loadingOlder: boolean;
	onLoadOlder: () => Promise<HlidContextReceipt[]>;
}) {
	const isLatest = receipts[0]?.seq === selectedSeq;
	return (
		<>
			<ContextSection icon={Gauge} title="Turn context receipt">
				<TurnReceiptPicker
					receipts={receipts}
					selectedSeq={selectedSeq}
					onSelectReceipt={onSelectReceipt}
					hasMore={hasMore}
					loadingOlder={loadingOlder}
					onLoadOlder={onLoadOlder}
				/>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
					<ContextMetric
						label="Hlid added"
						value={`${context.hlidAddedChars.toLocaleString()} chars`}
					/>
					<ContextMetric
						label="Rough tokens"
						value={
							context.estimatedHlidTokens === 0
								? "0"
								: `~${context.estimatedHlidTokens.toLocaleString()}`
						}
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
							!isLatest
								? "Historical receipt"
								: providerUsage.used !== null &&
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
									{(isLatest ? providerUsage.actualModel : null) ??
										context.model ??
										"Unknown"}
								</span>
							</div>
							{!isLatest && (
								<div className="flex items-start justify-between gap-3 border-t border-border/35 pt-2">
									<span>Context-window usage</span>
									<span className="max-w-[55%] text-right">
										Not retained for this historical turn
									</span>
								</div>
							)}
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
	initialTarget,
	pending,
	onClose,
}: {
	sessionId: string;
	initialTarget?: HlidContextReceiptTarget | null;
	pending: PendingHlidContext;
	onClose: () => void;
}) {
	const [receipts, setReceipts] = useState<HlidContextReceipt[]>([]);
	const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [nextBeforeSeq, setNextBeforeSeq] = useState<number | null>(null);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [historyError, setHistoryError] = useState<string | null>(null);
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
		const matchesTarget = (receipt: HlidContextReceipt) =>
			(initialTarget?.seq !== undefined && receipt.seq === initialTarget.seq) ||
			(initialTarget?.turnId !== undefined &&
				receipt.turnId === initialTarget.turnId);
		setLoading(true);
		setError(null);
		setHistoryError(null);
		void (async () => {
			const result = await getSessionContextFn({
				data: { sessionId, limit: CONTEXT_RECEIPT_PAGE_SIZE },
			});
			let nextReceipts = result?.hlid_contexts?.length
				? result.hlid_contexts
				: result?.hlid_context
					? [
							{
								seq: -1,
								timestamp: Math.floor(result.hlid_context.recordedAt / 1_000),
								context: result.hlid_context,
							},
						]
					: [];
			let nextHasMore = result?.has_more_contexts ?? false;
			let nextCursor = result?.next_context_before_seq ?? null;
			while (
				initialTarget &&
				!nextReceipts.some(matchesTarget) &&
				nextHasMore &&
				nextCursor !== null
			) {
				const olderResult = await getSessionContextFn({
					data: {
						sessionId,
						beforeSeq: nextCursor,
						limit: CONTEXT_RECEIPT_PAGE_SIZE,
					},
				});
				const olderReceipts = olderResult?.hlid_contexts ?? [];
				const seen = new Set(nextReceipts.map((receipt) => receipt.seq));
				nextReceipts = [
					...nextReceipts,
					...olderReceipts.filter((receipt) => !seen.has(receipt.seq)),
				];
				nextHasMore = olderResult?.has_more_contexts ?? false;
				nextCursor = olderResult?.next_context_before_seq ?? null;
			}
			if (!active) return;
			setReceipts(nextReceipts);
			setSelectedSeq(
				initialTarget
					? (nextReceipts.find(matchesTarget)?.seq ??
							nextReceipts[0]?.seq ??
							null)
					: (nextReceipts[0]?.seq ?? null),
			);
			setHasMore(nextHasMore);
			setNextBeforeSeq(nextCursor);
			setProviderUsage({
				contextWindow: result?.context_window ?? null,
				used: result?.last_context_used ?? null,
				actualModel: result?.actual_model ?? null,
			});
			setLoading(false);
		})().catch((fetchError: unknown) => {
			if (!active) return;
			setError(
				fetchError instanceof Error
					? fetchError.message
					: "Could not read Hlid context.",
			);
			setLoading(false);
		});
		return () => {
			active = false;
		};
	}, [initialTarget, sessionId]);

	const context =
		receipts.find((receipt) => receipt.seq === selectedSeq)?.context ?? null;

	async function loadOlderReceipts(): Promise<HlidContextReceipt[]> {
		if (loadingOlder || nextBeforeSeq === null) return [];
		setLoadingOlder(true);
		setHistoryError(null);
		try {
			const result = await getSessionContextFn({
				data: {
					sessionId,
					beforeSeq: nextBeforeSeq,
					limit: CONTEXT_RECEIPT_PAGE_SIZE,
				},
			});
			const older = result?.hlid_contexts ?? [];
			setReceipts((current) => {
				const seen = new Set(current.map((receipt) => receipt.seq));
				return [
					...current,
					...older.filter((receipt) => !seen.has(receipt.seq)),
				];
			});
			setHasMore(result?.has_more_contexts ?? false);
			setNextBeforeSeq(result?.next_context_before_seq ?? null);
			return older;
		} catch (loadError) {
			setHistoryError(
				loadError instanceof Error
					? loadError.message
					: "Could not load older context receipts.",
			);
			return [];
		} finally {
			setLoadingOlder(false);
		}
	}

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
						<>
							<LastSentContext
								context={context}
								providerUsage={providerUsage}
								receipts={receipts}
								selectedSeq={selectedSeq ?? receipts[0]?.seq ?? -1}
								onSelectReceipt={setSelectedSeq}
								hasMore={hasMore}
								loadingOlder={loadingOlder}
								onLoadOlder={loadOlderReceipts}
							/>
							{historyError && (
								<p role="alert" className="text-[10px] text-destructive/75">
									{historyError}
								</p>
							)}
						</>
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
