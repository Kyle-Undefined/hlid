import {
	Bot,
	Camera,
	ExternalLink,
	LoaderCircle,
	Maximize2,
	Minimize2,
	RefreshCw,
	RotateCcw,
	ScrollText,
	Square,
	X,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { ProjectPreviewFeedbackModal } from "#/components/chat/ProjectPreviewFeedbackModal";
import { ClickableImage } from "#/components/ImageViewerModal";
import { useProjectPreviewActions } from "#/hooks/useProjectPreviewActions";
import { enqueueChat } from "#/hooks/wsStore";
import {
	captureProjectPreviewFeedbackFn,
	getProjectPreviewAgentFrameFn,
	type ProjectPreviewAgentFrame,
	type ProjectPreviewSnapshot,
	saveProjectPreviewFeedbackFn,
} from "#/lib/serverFns/projectPreviews";
import { uid } from "#/lib/utils";

type PreviewViewState = {
	path: string;
	width: number;
	height: number;
	scrollX: number;
	scrollY: number;
};

const FALLBACK_VIEWPORTS = {
	desktop: { width: 1440, height: 1000 },
	tablet: { width: 768, height: 1024 },
	mobile: { width: 390, height: 844 },
} as const;

function boundedInt(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.round(value)));
}

function namedViewportForWidth(
	viewport: "fit" | "desktop" | "tablet" | "mobile",
	width: number,
): "desktop" | "tablet" | "mobile" {
	if (viewport !== "fit") return viewport;
	if (width <= 480) return "mobile";
	if (width <= 1024) return "tablet";
	return "desktop";
}

export function ProjectPreviewPane({
	preview,
	onClose,
	maximized = false,
	onToggleMaximize,
	className = "",
	style,
}: {
	preview: ProjectPreviewSnapshot;
	onClose?: () => void;
	maximized?: boolean;
	onToggleMaximize?: () => void;
	className?: string;
	style?: CSSProperties;
}) {
	const [frameKey, setFrameKey] = useState(0);
	const [frameTarget, setFrameTarget] = useState(() => ({
		previewId: preview.id,
		path: preview.path,
	}));
	const [surface, setSurface] = useState<"user" | "agent" | "logs">("user");
	const [agentFrame, setAgentFrame] = useState<ProjectPreviewAgentFrame | null>(
		null,
	);
	const [agentFrameError, setAgentFrameError] = useState<string | null>(null);
	const [viewport, setViewport] = useState<
		"fit" | "desktop" | "tablet" | "mobile"
	>("fit");
	const {
		clearError,
		error,
		pendingAction,
		reportError,
		runAction: act,
	} = useProjectPreviewActions(preview);
	const [feedbackFrame, setFeedbackFrame] =
		useState<ProjectPreviewAgentFrame | null>(null);
	const [feedbackCapturing, setFeedbackCapturing] = useState(false);
	const [feedbackSaving, setFeedbackSaving] = useState(false);
	const [feedbackError, setFeedbackError] = useState<string | null>(null);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const previewViewStateRef = useRef<PreviewViewState | null>(null);
	const isReady = preview.state === "ready";
	useEffect(() => {
		if (!isReady || surface !== "agent") return;
		let cancelled = false;
		const load = () => {
			void getProjectPreviewAgentFrameFn({
				data: {
					sessionId: preview.session_id,
					previewId: preview.id,
					...(agentFrame?.frame_id
						? { afterFrameId: agentFrame.frame_id }
						: {}),
				},
			})
				.then((frame) => {
					if (cancelled) return;
					if (frame) setAgentFrame(frame);
					setAgentFrameError(null);
				})
				.catch((cause) => {
					if (cancelled) return;
					setAgentFrameError(
						cause instanceof Error ? cause.message : String(cause),
					);
				});
		};
		load();
		const timer = window.setInterval(load, 1_500);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [agentFrame?.frame_id, isReady, preview.id, preview.session_id, surface]);
	const previewUrl = (() => {
		if (typeof window === "undefined") return preview.url;
		try {
			const url = new URL(preview.relay_url, window.location.origin);
			const path =
				frameTarget.previewId === preview.id ? frameTarget.path : preview.path;
			const route = new URL(path, "http://preview.invalid");
			const relayRoot = url.pathname.match(/^(.*\/relay)(?:\/.*)?$/)?.[1];
			if (relayRoot) {
				url.pathname = `${relayRoot}${route.pathname}`;
				url.search = route.search;
				url.hash = route.hash;
			}
			const uiPort = Number(
				window.location.port ||
					(window.location.protocol === "https:" ? "443" : "80"),
			);
			url.port = String(uiPort + 1);
			// Select the preview on the isolated origin, then redirect to its
			// clean app-local path. Client routers hydrate against location.pathname;
			// leaving the relay prefix visible makes an SSR /login document hydrate
			// as /api/project-previews/:id/relay/login and crash before rendering.
			url.searchParams.set("__hlid_preview_open", "1");
			return url.toString();
		} catch {
			return preview.relay_url;
		}
	})();
	useEffect(() => {
		previewViewStateRef.current = null;
		let expectedOrigin: string;
		try {
			expectedOrigin = new URL(previewUrl, window.location.origin).origin;
		} catch {
			return;
		}
		const receiveState = (event: MessageEvent) => {
			const frameWindow = iframeRef.current?.contentWindow;
			if (
				!frameWindow ||
				event.source !== frameWindow ||
				event.origin !== expectedOrigin
			) {
				return;
			}
			const data = event.data as Record<string, unknown> | null;
			if (
				!data ||
				data.type !== "hlid:project-preview-state" ||
				data.version !== 1 ||
				data.preview_id !== preview.id ||
				typeof data.path !== "string" ||
				data.path.length > 2_048 ||
				!data.path.startsWith("/") ||
				data.path.startsWith("//") ||
				data.path.includes("\\") ||
				typeof data.width !== "number" ||
				typeof data.height !== "number" ||
				typeof data.scroll_x !== "number" ||
				typeof data.scroll_y !== "number" ||
				![data.width, data.height, data.scroll_x, data.scroll_y].every(
					Number.isFinite,
				)
			) {
				return;
			}
			previewViewStateRef.current = {
				path: data.path,
				width: boundedInt(data.width, 240, 3_840),
				height: boundedInt(data.height, 240, 2_160),
				scrollX: boundedInt(data.scroll_x, 0, 100_000),
				scrollY: boundedInt(data.scroll_y, 0, 100_000),
			};
		};
		window.addEventListener("message", receiveState);
		return () => window.removeEventListener("message", receiveState);
	}, [preview.id, previewUrl]);

	const captureFeedback = async () => {
		setFeedbackCapturing(true);
		setFeedbackError(null);
		clearError();
		try {
			const iframe = iframeRef.current;
			let expectedOrigin = "*";
			try {
				expectedOrigin = new URL(previewUrl, window.location.origin).origin;
			} catch {}
			iframe?.contentWindow?.postMessage(
				{ type: "hlid:project-preview-state-request" },
				expectedOrigin,
			);
			await new Promise((resolve) => window.setTimeout(resolve, 50));
			const reported = previewViewStateRef.current;
			const namedFallback =
				viewport === "fit"
					? FALLBACK_VIEWPORTS.desktop
					: FALLBACK_VIEWPORTS[viewport];
			const fallback = {
				width: iframe?.clientWidth || namedFallback.width,
				height: iframe?.clientHeight || namedFallback.height,
			};
			const width = boundedInt(reported?.width ?? fallback.width, 240, 3_840);
			const height = boundedInt(
				reported?.height ?? fallback.height,
				240,
				2_160,
			);
			const frame = await captureProjectPreviewFeedbackFn({
				data: {
					sessionId: preview.session_id,
					previewId: preview.id,
					path: reported?.path ?? preview.path,
					viewport: namedViewportForWidth(viewport, width),
					width,
					height,
					...(reported
						? { scrollX: reported.scrollX, scrollY: reported.scrollY }
						: {}),
				},
			});
			setFeedbackFrame(frame);
		} catch (cause) {
			reportError(cause);
		} finally {
			setFeedbackCapturing(false);
		}
	};

	const saveFeedback = async (blob: Blob, comment: string) => {
		setFeedbackSaving(true);
		setFeedbackError(null);
		try {
			const form = new FormData();
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			form.append(
				"file",
				new File([blob], `preview-feedback-${timestamp}.png`, {
					type: "image/png",
				}),
			);
			form.append("session_id", preview.session_id);
			const uploadResponse = await fetch("/api/attachments/upload", {
				method: "POST",
				body: form,
			});
			if (!uploadResponse.ok) {
				const detail = await uploadResponse.text().catch(() => "");
				throw new Error(
					detail ||
						`Preview feedback upload failed (${uploadResponse.status}).`,
				);
			}
			const upload = (await uploadResponse.json()) as { id?: string };
			if (!upload.id)
				throw new Error("Preview feedback upload returned no id.");

			const saved = await saveProjectPreviewFeedbackFn({
				data: {
					sessionId: preview.session_id,
					previewId: preview.id,
					frameId: feedbackFrame?.frame_id ?? "",
					attachmentId: upload.id,
					comment,
				},
			});
			enqueueChat({
				id: uid(),
				session_id: preview.session_id,
				text:
					comment || "Please review this annotated Project Preview capture.",
				attachments: [saved.attachment],
			});
			setFeedbackFrame(null);
		} catch (cause) {
			setFeedbackError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setFeedbackSaving(false);
		}
	};

	return (
		<section
			aria-label="Project Preview"
			className={`min-h-0 min-w-0 bg-background flex flex-col ${className}`}
			style={style}
		>
			<header className="h-10 shrink-0 border-b border-border/50 px-3 flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<div className="text-[10px] tracking-widest uppercase text-foreground/80 truncate">
						{preview.label}
					</div>
					<div className="text-[9px] text-muted-foreground/45 truncate">
						{preview.state === "ready"
							? `${previewUrl} · expires ${new Date(preview.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
							: preview.state}
					</div>
				</div>
				{isReady && (
					<>
						<button
							type="button"
							onClick={() => void captureFeedback()}
							disabled={feedbackCapturing}
							aria-label="Capture Preview feedback"
							title="Capture feedback at the current Preview size"
							className="p-1.5 text-muted-foreground/55 hover:text-foreground disabled:opacity-30"
						>
							{feedbackCapturing ? (
								<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Camera className="h-3.5 w-3.5" />
							)}
						</button>
						<button
							type="button"
							onClick={() => {
								const path = previewViewStateRef.current?.path ?? preview.path;
								previewViewStateRef.current = null;
								setFrameTarget({ previewId: preview.id, path });
								setFrameKey((key) => key + 1);
							}}
							aria-label="Reload preview"
							title="Reload preview"
							className="p-1.5 text-muted-foreground/55 hover:text-foreground"
						>
							<RefreshCw className="h-3.5 w-3.5" />
						</button>
						<button
							type="button"
							onClick={() =>
								window.open(previewUrl, "_blank", "noopener,noreferrer")
							}
							aria-label="Open preview in browser"
							title="Open in browser"
							className="p-1.5 text-muted-foreground/55 hover:text-foreground"
						>
							<ExternalLink className="h-3.5 w-3.5" />
						</button>
					</>
				)}
				<button
					type="button"
					onClick={() =>
						setSurface((current) => (current === "agent" ? "user" : "agent"))
					}
					aria-label={
						surface === "agent" ? "Show user preview" : "Show agent view"
					}
					title={surface === "agent" ? "User view" : "Agent view"}
					className={`p-1.5 hover:text-foreground ${
						surface === "agent" ? "text-primary" : "text-muted-foreground/55"
					}`}
				>
					<Bot className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					onClick={() =>
						setSurface((current) => (current === "logs" ? "user" : "logs"))
					}
					aria-label={surface === "logs" ? "Show preview" : "Show preview logs"}
					title={surface === "logs" ? "Show preview" : "Logs"}
					className={`p-1.5 hover:text-foreground ${
						surface === "logs" ? "text-primary" : "text-muted-foreground/55"
					}`}
				>
					<ScrollText className="h-3.5 w-3.5" />
				</button>
				<select
					value={viewport}
					onChange={(event) =>
						setViewport(
							event.target.value as "fit" | "desktop" | "tablet" | "mobile",
						)
					}
					aria-label="Preview viewport"
					title="Preview viewport"
					className="h-6 max-w-20 border border-border/50 bg-background px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
				>
					<option value="fit">Fit</option>
					<option value="desktop">1440</option>
					<option value="tablet">768</option>
					<option value="mobile">390</option>
				</select>
				{onToggleMaximize && (
					<button
						type="button"
						onClick={onToggleMaximize}
						aria-label={maximized ? "Restore preview pane" : "Maximize preview"}
						title={maximized ? "Restore" : "Maximize"}
						className="p-1.5 text-muted-foreground/55 hover:text-foreground"
					>
						{maximized ? (
							<Minimize2 className="h-3.5 w-3.5" />
						) : (
							<Maximize2 className="h-3.5 w-3.5" />
						)}
					</button>
				)}
				<button
					type="button"
					onClick={() => void act("restart")}
					disabled={pendingAction !== null}
					aria-label="Restart preview"
					title="Restart preview"
					className="p-1.5 text-muted-foreground/55 hover:text-foreground disabled:opacity-30"
				>
					{pendingAction === "restart" ? (
						<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
					) : (
						<RotateCcw className="h-3.5 w-3.5" />
					)}
				</button>
				{preview.state !== "stopped" && (
					<button
						type="button"
						onClick={() => void act("stop")}
						disabled={pendingAction !== null}
						aria-label="Stop preview"
						title="Stop preview"
						className="p-1.5 text-muted-foreground/55 hover:text-destructive disabled:opacity-30"
					>
						{pendingAction === "stop" ? (
							<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
						) : (
							<Square className="h-3.5 w-3.5" />
						)}
					</button>
				)}
				{onClose && (
					<button
						type="button"
						onClick={onClose}
						aria-label="Close preview pane"
						title="Close pane"
						className="p-1.5 text-muted-foreground/55 hover:text-foreground"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				)}
			</header>
			{error && (
				<div className="shrink-0 border-b border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
					{error}
				</div>
			)}
			<div className="relative min-h-0 flex-1 overflow-auto bg-muted/20">
				{isReady && (
					<div
						className={`mx-auto h-full bg-white ${
							surface === "user" ? "block" : "hidden"
						}`}
						style={{
							width:
								viewport === "desktop"
									? 1440
									: viewport === "tablet"
										? 768
										: viewport === "mobile"
											? 390
											: "100%",
						}}
					>
						<iframe
							key={`${preview.id}:${frameKey}`}
							ref={iframeRef}
							title={preview.label}
							src={previewUrl}
							onLoad={() => {
								previewViewStateRef.current = null;
								let expectedOrigin = "*";
								try {
									expectedOrigin = new URL(previewUrl, window.location.origin)
										.origin;
								} catch {}
								iframeRef.current?.contentWindow?.postMessage(
									{ type: "hlid:project-preview-state-request" },
									expectedOrigin,
								);
							}}
							referrerPolicy="no-referrer"
							sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin"
							className="h-full w-full border-0 bg-white"
						/>
					</div>
				)}
				{isReady && surface === "agent" ? (
					<div className="absolute inset-0 overflow-auto p-3">
						{agentFrame ? (
							<div className="mx-auto max-w-full">
								<div className="mb-2 flex items-center justify-between gap-3 text-[9px] uppercase tracking-widest text-muted-foreground/60">
									<span className="truncate">
										Agent view · {agentFrame.last_action ?? "observed"} ·{" "}
										{agentFrame.viewport} · {agentFrame.path}
									</span>
									<span className="shrink-0">
										{new Date(agentFrame.captured_at).toLocaleTimeString()}
									</span>
								</div>
								<ClickableImage
									src={`data:${agentFrame.mime};base64,${agentFrame.image_base64}`}
									alt={`Agent browser at ${agentFrame.path}`}
									className="mx-auto block w-fit max-w-full"
									imageClassName="max-w-full border border-border/40 bg-white"
								/>
								{(agentFrame.console_messages.length > 0 ||
									agentFrame.failed_requests.length > 0) && (
									<div className="mt-3 border border-border/40 bg-background/80 p-2 font-mono text-[9px] leading-4 text-muted-foreground/70">
										{[
											...agentFrame.console_messages,
											...agentFrame.failed_requests,
										]
											.slice(-10)
											.map((message) => (
												<div key={message}>{message}</div>
											))}
									</div>
								)}
							</div>
						) : (
							<div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground/50">
								<div>
									<Bot className="mx-auto mb-2 h-5 w-5" />
									<p>No agent frame yet.</p>
									<p className="mt-1 text-[10px]">
										The next capture or control action will appear here.
									</p>
									{agentFrameError && (
										<p className="mt-2 text-destructive">{agentFrameError}</p>
									)}
								</div>
							</div>
						)}
					</div>
				) : !isReady || surface === "logs" ? (
					<div className="absolute inset-0 overflow-auto p-4">
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							{preview.state === "starting" && (
								<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
							)}
							<span className="uppercase tracking-widest">{preview.state}</span>
						</div>
						{preview.error && (
							<p className="mt-3 text-xs text-destructive">{preview.error}</p>
						)}
						{preview.logs.length > 0 ? (
							<pre className="mt-4 whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-muted-foreground/70">
								{preview.logs.join("\n")}
							</pre>
						) : (
							<p className="mt-4 text-xs text-muted-foreground/45">
								No preview logs yet.
							</p>
						)}
					</div>
				) : null}
			</div>
			{feedbackFrame && (
				<ProjectPreviewFeedbackModal
					frame={feedbackFrame}
					saving={feedbackSaving}
					error={feedbackError}
					onClose={() => {
						if (!feedbackSaving) {
							setFeedbackFrame(null);
							setFeedbackError(null);
						}
					}}
					onSave={saveFeedback}
				/>
			)}
		</section>
	);
}
