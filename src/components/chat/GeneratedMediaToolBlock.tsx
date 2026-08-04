import {
	AlertTriangle,
	CheckCircle2,
	ChevronRight,
	Download,
	Images,
	LoaderCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ClickableImage } from "#/components/ImageViewerModal";
import { PrivacyMask } from "#/components/PrivacyMask";
import { loadToolEventDetail } from "#/hooks/toolEventDetailStore";
import { fmtBytes } from "#/lib/formatters";
import { isGeneratedMediaToolName } from "#/lib/toolEventPaging";
import type { ToolEventMessage } from "#/server/protocol";

const ATTACHMENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const GENERATED_IMAGE_FILENAME_RE = /^[a-zA-Z0-9._-]{1,240}\.png$/i;

export type GeneratedMediaResult =
	| {
			type: "hlid_generated_media";
			version: 1;
			status: "ready";
			provider: string;
			provider_item_id: string;
			attachment_id: string;
			filename: string;
			mime: "image/png";
			size_bytes: number;
			width: number;
			height: number;
			prompt?: string;
	  }
	| {
			type: "hlid_generated_media";
			version: 1;
			status: "failed";
			provider: string;
			provider_item_id: string;
			failure_stage: "provider" | "persistence";
			error: string;
	  };

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function boundedString(value: unknown, max: number): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= max
		? value
		: null;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

/** Parse only Hlid's compact attachment-backed generated-media result. */
export function parseGeneratedMediaResult(
	result: string | null | undefined,
): GeneratedMediaResult | null {
	if (!result) return null;
	let value: unknown;
	try {
		value = JSON.parse(result);
	} catch {
		return null;
	}
	const parsed = record(value);
	if (
		parsed?.type !== "hlid_generated_media" ||
		parsed.version !== 1 ||
		(parsed.status !== "ready" && parsed.status !== "failed")
	) {
		return null;
	}
	const provider = boundedString(parsed.provider, 100);
	const providerItemId = boundedString(parsed.provider_item_id, 256);
	if (!provider || !providerItemId) return null;
	if (parsed.status === "failed") {
		const error = boundedString(parsed.error, 1_000);
		if (
			!error ||
			(parsed.failure_stage !== "provider" &&
				parsed.failure_stage !== "persistence")
		) {
			return null;
		}
		return {
			type: "hlid_generated_media",
			version: 1,
			status: "failed",
			provider,
			provider_item_id: providerItemId,
			failure_stage: parsed.failure_stage,
			error,
		};
	}
	const attachmentId = boundedString(parsed.attachment_id, 128);
	const filename = boundedString(parsed.filename, 240);
	const prompt = boundedString(parsed.prompt, 4_000) ?? undefined;
	if (
		!attachmentId ||
		!ATTACHMENT_ID_RE.test(attachmentId) ||
		!filename ||
		!GENERATED_IMAGE_FILENAME_RE.test(filename) ||
		parsed.mime !== "image/png" ||
		!positiveInteger(parsed.size_bytes) ||
		!positiveInteger(parsed.width) ||
		!positiveInteger(parsed.height) ||
		parsed.width * parsed.height > 12_000_000
	) {
		return null;
	}
	return {
		type: "hlid_generated_media",
		version: 1,
		status: "ready",
		provider,
		provider_item_id: providerItemId,
		attachment_id: attachmentId,
		filename,
		mime: "image/png",
		size_bytes: parsed.size_bytes,
		width: parsed.width,
		height: parsed.height,
		...(prompt ? { prompt } : {}),
	};
}

export function isGeneratedMediaToolEvent(event: ToolEventMessage): boolean {
	return isGeneratedMediaToolName(event.name);
}

export function GeneratedMediaToolBlock({
	event,
}: {
	event: ToolEventMessage;
}) {
	const [detailResult, setDetailResult] = useState<string | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [imageExpanded, setImageExpanded] = useState(true);
	const [promptExpanded, setPromptExpanded] = useState(false);
	const needsDetail = Boolean(event.resultTruncated && event.detailSessionId);
	useEffect(() => {
		if (!needsDetail || !event.detailSessionId) return;
		let cancelled = false;
		setDetailResult(null);
		setDetailError(null);
		void loadToolEventDetail(event.detailSessionId, event.id)
			.then((detail) => {
				if (!detail.result) {
					throw new Error("Generated-media receipt is no longer available");
				}
				if (!cancelled) setDetailResult(detail.result);
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setDetailError(
						error instanceof Error
							? error.message
							: "Unable to load generated-media receipt",
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [event.detailSessionId, event.id, needsDetail]);

	const resultText = needsDetail ? detailResult : event.result;
	const result = parseGeneratedMediaResult(resultText);
	if (!event.result || (needsDetail && !detailResult && !detailError)) {
		return (
			<div className="my-2 flex min-w-0 items-center gap-2 border border-border/50 bg-muted/5 px-3 py-2 text-[10px] text-muted-foreground/65">
				<LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary/55" />
				<span>
					{needsDetail ? "Loading generated image…" : "Generating image…"}
				</span>
			</div>
		);
	}
	if (!result || result.status === "failed") {
		return (
			<div className="my-2 flex min-w-0 items-start gap-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-[10px] text-destructive/75">
				<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
				<div className="min-w-0">
					<div className="font-medium">Generated image unavailable</div>
					<PrivacyMask className="mt-0.5 break-words text-[9px] text-destructive/65">
						{detailError ??
							(result?.status === "failed"
								? result.error
								: "Hlid could not read the generated-media receipt.")}
					</PrivacyMask>
				</div>
			</div>
		);
	}

	const rawUrl = `/api/attachments/${encodeURIComponent(result.attachment_id)}/raw`;
	const alt = result.prompt ?? "Generated image";
	const previewId = `generated-media-preview-${result.attachment_id}`;
	const promptId = `generated-media-prompt-${result.attachment_id}`;
	return (
		<PrivacyMask className="my-2 min-w-0 max-w-full overflow-hidden border border-border/50 bg-muted/5">
			<figure data-generated-media={result.attachment_id}>
				<figcaption className="flex min-w-0 items-stretch border-b border-border/40">
					<button
						type="button"
						onClick={() => setImageExpanded((current) => !current)}
						aria-expanded={imageExpanded}
						aria-controls={previewId}
						aria-label={`${imageExpanded ? "Collapse" : "Expand"} generated image preview`}
						title={
							imageExpanded
								? "Collapse generated image preview"
								: "Expand generated image preview"
						}
						className="group flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-primary/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60"
					>
						<ChevronRight
							className={`h-3 w-3 shrink-0 text-primary/50 transition-transform duration-150 group-hover:text-primary/80 ${imageExpanded ? "rotate-90" : ""}`}
							aria-hidden="true"
						/>
						<Images className="h-3.5 w-3.5 shrink-0 text-primary/55" />
						<span className="min-w-0 flex-1 truncate text-[10px] font-medium text-foreground/75">
							Generated image
						</span>
					</button>
					<span className="flex shrink-0 items-center gap-1 px-3 text-[8px] tracking-widest text-status-success/65 uppercase">
						<CheckCircle2 className="h-3 w-3" /> Ready
					</span>
				</figcaption>
				{imageExpanded && (
					<div
						id={previewId}
						className="flex min-h-40 items-center justify-center overflow-hidden bg-background/35 p-2 sm:p-3"
					>
						<ClickableImage
							src={rawUrl}
							alt={alt}
							downloadFilename={result.filename}
							className="flex max-h-[32rem] max-w-full items-center justify-center"
							imageClassName="max-h-[32rem] w-auto object-contain shadow-sm"
						/>
					</div>
				)}
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 px-3 py-2 text-[9px] text-muted-foreground/55">
					<span>
						{result.width.toLocaleString()} × {result.height.toLocaleString()}
					</span>
					<span>{fmtBytes(result.size_bytes)}</span>
					<span className="truncate">{result.provider}</span>
					<div className="ml-auto flex shrink-0 items-center gap-2">
						<a
							href={rawUrl}
							download={result.filename}
							className="inline-flex items-center gap-1 text-primary/65 hover:text-primary"
						>
							<Download className="h-3 w-3" /> Download
						</a>
						<a href="/relics" className="text-primary/65 hover:text-primary">
							Relics
						</a>
					</div>
				</div>
				{result.prompt && (
					<div className="border-t border-border/30">
						<div className="flex min-w-0 items-center gap-2 px-3 pt-2">
							<span className="min-w-0 flex-1 text-[8px] font-medium tracking-widest text-muted-foreground/45 uppercase">
								Prompt
							</span>
							<button
								type="button"
								onClick={() => setPromptExpanded((current) => !current)}
								aria-expanded={promptExpanded}
								aria-controls={promptId}
								aria-label={`${promptExpanded ? "Collapse" : "Expand"} generated image prompt`}
								className="shrink-0 text-[8px] font-medium tracking-wide text-primary/65 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
							>
								{promptExpanded ? "Collapse" : "Show full"}
							</button>
						</div>
						<blockquote
							id={promptId}
							className={`whitespace-pre-wrap break-words px-3 pt-1 pb-2 text-[9px] leading-relaxed text-muted-foreground/55 ${
								promptExpanded
									? "max-h-44 touch-pan-y overflow-y-auto overscroll-contain sm:max-h-64"
									: "line-clamp-3"
							}`}
						>
							{result.prompt}
						</blockquote>
					</div>
				)}
			</figure>
		</PrivacyMask>
	);
}
