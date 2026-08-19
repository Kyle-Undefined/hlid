import { useEffect, useMemo, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import type { HlidConfig } from "#/config";
import {
	DEFAULT_OLLAMA_KEEP_WARM_POLICY,
	OLLAMA_KEEP_WARM_POLICIES,
	type OllamaKeepWarmPolicy,
	OPENCODE_LOCAL_MODEL_MIN_CONTEXT,
} from "#/lib/ollama";
import {
	cancelOllamaPullFn,
	cancelOllamaWindowsSetupDownloadFn,
	deleteOllamaModelFn,
	getOllamaInfoFn,
	getOllamaWindowsSetupInfoFn,
	installOllamaWslFirewallFn,
	isOllamaIntegrationInfo,
	launchOllamaWindowsSetupFn,
	loadOllamaModelFn,
	pullOllamaModelFn,
	removeOllamaWslFirewallFn,
	startOllamaWindowsSetupDownloadFn,
	unloadOllamaModelFn,
} from "#/lib/serverFns/ollama";
import type { OllamaIntegrationInfo } from "#/server/ollamaIntegration";

const PROVIDER_PREFIX = "hlid-ollama/";
const ACTION_CLASS =
	"min-h-11 max-w-full px-1 text-[10px] uppercase lg:min-h-0 disabled:text-muted-foreground/50";
const OLLAMA_WINDOWS_INSTRUCTIONS_URL = "https://ollama.com/download/windows";
const OLLAMA_INFO_CACHE_KEY = "hlid:forge:ollama-info:v1";
const OLLAMA_AUTO_INSPECTION_DELAY_MS = 100;

// Keep the last verified inventory for the lifetime of the Forge SPA. Ollama
// inspection is comparatively expensive, and leaving/re-entering this view
// should not replace known status with an empty manual-check screen. Explicit
// refreshes and every Ollama mutation replace this snapshot.
let cachedOllamaInfo: OllamaIntegrationInfo | null = null;
let pendingOllamaInspection: Promise<OllamaIntegrationInfo> | null = null;

function persistOllamaInfo(info: OllamaIntegrationInfo): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(OLLAMA_INFO_CACHE_KEY, JSON.stringify(info));
	} catch {
		// The in-memory snapshot still preserves ordinary SPA navigation.
	}
}

function restoreOllamaInfo(): OllamaIntegrationInfo | null {
	if (cachedOllamaInfo) return cachedOllamaInfo;
	if (typeof window === "undefined") return null;
	try {
		const raw = window.localStorage.getItem(OLLAMA_INFO_CACHE_KEY);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!isOllamaIntegrationInfo(parsed)) {
			window.localStorage.removeItem(OLLAMA_INFO_CACHE_KEY);
			return null;
		}
		cachedOllamaInfo = parsed;
		return parsed;
	} catch {
		return null;
	}
}

function rememberOllamaInfo(
	info: OllamaIntegrationInfo,
): OllamaIntegrationInfo {
	cachedOllamaInfo = info;
	persistOllamaInfo(info);
	return info;
}

function inspectOllamaInfoOnce(): Promise<OllamaIntegrationInfo> {
	pendingOllamaInspection ??= getOllamaInfoFn()
		.then(rememberOllamaInfo)
		.finally(() => {
			pendingOllamaInspection = null;
		});
	return pendingOllamaInspection;
}

/** @internal Test isolation for the module-scoped SPA navigation cache. */
export function resetOllamaInfoCacheForTesting(): void {
	cachedOllamaInfo = null;
	pendingOllamaInspection = null;
	if (typeof window !== "undefined") {
		window.localStorage.removeItem(OLLAMA_INFO_CACHE_KEY);
	}
}

/** @internal Simulate a document reload while retaining browser storage. */
export function resetOllamaInfoMemoryCacheForTesting(): void {
	cachedOllamaInfo = null;
	pendingOllamaInspection = null;
}

type AcpAgentConfig = NonNullable<HlidConfig["acp_agents"]>[number];

export type OllamaConfig = NonNullable<HlidConfig["ollama"]>;

export type OllamaSectionProps = {
	/** The enabled OpenCode ACP integration. Absence never enables it implicitly. */
	openCode?: AcpAgentConfig;
	/** Canonical Ollama integration selection used by explicit OpenCode linkage. */
	ollama?: OllamaConfig;
	disabled: boolean;
	onChange: (
		nextOllama: OllamaConfig | undefined,
		openCodePatch?: Partial<AcpAgentConfig>,
	) => void;
	onOpenCodeSetup: () => void;
};

function readableBytes(value: number): string {
	if (value < 1024 ** 2) return `${Math.max(0, Math.round(value / 1024))} KB`;
	if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
	return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function OllamaSetupDownloadAction({
	disabled,
	retry = false,
	onConfirm,
}: {
	disabled: boolean;
	retry?: boolean;
	onConfirm: () => void;
}) {
	return (
		<ConfirmAction
			label="The official Windows installer is a large download. Hlid will download and verify it, but will not install or run Ollama without another explicit action."
			confirmText="download"
			variant="primary"
			stacked
			disabled={disabled}
			onConfirm={onConfirm}
			trigger={(open) => (
				<button
					type="button"
					disabled={disabled}
					onClick={open}
					className={`${ACTION_CLASS} text-primary`}
				>
					{retry ? "Retry installer download" : "Download Ollama installer"}
				</button>
			)}
		/>
	);
}

function normalizedModels(models: readonly string[]): string[] {
	return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

type OllamaModelInfo = OllamaIntegrationInfo["models"][number];

function modelIsSelected(
	selected: ReadonlySet<string>,
	model: OllamaModelInfo,
): boolean {
	return selected.has(model.model) || selected.has(model.name);
}

function withoutModelSelection(
	selected: readonly string[],
	model: OllamaModelInfo,
): string[] {
	return selected.filter(
		(candidate) => candidate !== model.model && candidate !== model.name,
	);
}

function loadedModelFor(
	info: OllamaIntegrationInfo,
	model: OllamaModelInfo,
): OllamaIntegrationInfo["loadedModels"][number] | undefined {
	return info.loadedModels.find(
		(candidate) =>
			candidate.digest === model.digest &&
			(candidate.model === model.model ||
				candidate.name === model.model ||
				candidate.model === model.name ||
				candidate.name === model.name),
	);
}

function preparedModelFor(
	info: OllamaIntegrationInfo,
	model: OllamaModelInfo,
): OllamaIntegrationInfo["preparedModels"][number] | undefined {
	return info.preparedModels.find(
		(candidate) =>
			candidate.digest === model.digest &&
			(candidate.model === model.model ||
				candidate.name === model.model ||
				candidate.model === model.name ||
				candidate.name === model.name),
	);
}

function modelDomIdSuffix(model: OllamaModelInfo): string {
	return `${model.digest}-${encodeURIComponent(model.model)}`;
}

function openCodeSelectionPatch(
	openCode: AcpAgentConfig,
	models: readonly string[],
): Partial<AcpAgentConfig> | undefined {
	const selectedIds = models.map((model) => `${PROVIDER_PREFIX}${model}`);
	const selectedSet = new Set(selectedIds);
	const patch: Partial<AcpAgentConfig> = {};
	const filter = openCode.model_filter;

	if (filter) {
		const filterModels =
			filter.mode === "only"
				? normalizedModels([
						...filter.models.filter(
							(model) => !model.startsWith(PROVIDER_PREFIX),
						),
						...selectedIds,
					])
				: filter.models.filter((model) => !selectedSet.has(model));
		patch.model_filter =
			filterModels.length > 0 ? { ...filter, models: filterModels } : undefined;
	}

	if (
		openCode.model?.startsWith(PROVIDER_PREFIX) &&
		!selectedSet.has(openCode.model)
	) {
		patch.model = undefined;
	}
	if (
		openCode.recap_model?.startsWith(PROVIDER_PREFIX) &&
		!selectedSet.has(openCode.recap_model)
	) {
		patch.recap_model = undefined;
	}

	return Object.keys(patch).length > 0 ? patch : undefined;
}

function modelCompatibilityBlocker(model: OllamaModelInfo): string | null {
	if (model.compatibilityInspection.status === "unknown") {
		return "Hlid could not verify compatibility for this model. Refresh Ollama to continue checking.";
	}
	if (!model.capabilities.includes("tools")) {
		return "This model does not advertise tool calling, which Hlid-managed OpenCode requires.";
	}
	if (
		model.details.contextLength === null ||
		model.details.contextLength < OPENCODE_LOCAL_MODEL_MIN_CONTEXT
	) {
		return `This model advertises ${model.details.contextLength?.toLocaleString() ?? "an unknown amount of"} context. Hlid-managed OpenCode requires at least ${OPENCODE_LOCAL_MODEL_MIN_CONTEXT.toLocaleString()}.`;
	}
	return null;
}

export function OllamaSection({
	openCode,
	ollama,
	disabled,
	onChange,
	onOpenCodeSetup,
}: OllamaSectionProps) {
	const [info, setInfo] = useState<OllamaIntegrationInfo | null>(
		cachedOllamaInfo,
	);
	const [modelName, setModelName] = useState("");
	const [operation, setOperation] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const selected = ollama?.models ?? [];
	const keepWarm = ollama?.keep_warm ?? DEFAULT_OLLAMA_KEEP_WARM_POLICY;
	const selectedSet = useMemo(() => new Set(selected), [selected]);
	const availableModelSet = useMemo(
		() => new Set(info?.models.flatMap((model) => [model.model, model.name])),
		[info],
	);
	const missingSelected = info
		? selected.filter((model) => !availableModelSet.has(model))
		: [];
	const selectedForOpenCodeLabel = openCode
		? "Configured for OpenCode"
		: "Selected for OpenCode setup";
	const removeFromOpenCodeLabel = openCode
		? "Remove from OpenCode"
		: "Remove from OpenCode setup";

	async function refresh(): Promise<void> {
		setError(null);
		setOperation("refresh");
		try {
			setInfo(await inspectOllamaInfoOnce());
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not inspect Windows Ollama.",
			);
		} finally {
			setOperation(null);
		}
	}

	async function act(
		label: string,
		action: () => Promise<unknown>,
	): Promise<void> {
		setError(null);
		setOperation(label);
		try {
			await action();
			setInfo(await inspectOllamaInfoOnce());
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : `Ollama ${label} failed.`,
			);
		} finally {
			setOperation(null);
		}
	}

	function changeSelection(models: string[]): void {
		const nextModels = normalizedModels(models);
		onChange(
			nextModels.length > 0
				? { models: nextModels, keep_warm: keepWarm }
				: undefined,
			openCode ? openCodeSelectionPatch(openCode, nextModels) : undefined,
		);
	}

	function changeKeepWarm(next: OllamaKeepWarmPolicy): void {
		if (!ollama) return;
		onChange({ ...ollama, keep_warm: next });
	}

	const pull = info?.pull;
	const pullActive = pull?.state === "running" || pull?.state === "canceling";
	const pullPercent = pullActive ? pull.progress?.percent : null;
	const setupPhase = info?.setup.phase;
	const setupActive =
		setupPhase === "resolving" ||
		setupPhase === "downloading" ||
		setupPhase === "verifying" ||
		setupPhase === "launched";
	const shouldPollSetup = Boolean(
		info?.supported && !info.status.available && setupActive,
	);

	useEffect(() => {
		const restored = restoreOllamaInfo();
		if (restored) {
			setInfo(restored);
			return;
		}
		let stopped = false;
		const timer = window.setTimeout(() => {
			const current = restoreOllamaInfo();
			if (current) {
				if (!stopped) setInfo(current);
				return;
			}
			setOperation("refresh");
			void inspectOllamaInfoOnce()
				.then((next) => {
					if (!stopped) setInfo(next);
				})
				.catch((cause) => {
					if (!stopped) {
						setError(
							cause instanceof Error
								? cause.message
								: "Could not inspect Windows Ollama.",
						);
					}
				})
				.finally(() => {
					if (!stopped) setOperation(null);
				});
		}, OLLAMA_AUTO_INSPECTION_DELAY_MS);
		return () => {
			stopped = true;
			window.clearTimeout(timer);
		};
	}, []);

	useEffect(() => {
		if (!pullActive && !shouldPollSetup) return;
		let stopped = false;
		let timer: number | undefined;
		const inspectNext = async () => {
			if (pullActive) {
				const nextInfo = await getOllamaInfoFn();
				if (!stopped) setInfo(rememberOllamaInfo(nextInfo));
				return;
			}
			const setupInfo = await getOllamaWindowsSetupInfoFn();
			if (setupInfo.status.available) {
				const nextInfo = await getOllamaInfoFn();
				if (!stopped) setInfo(rememberOllamaInfo(nextInfo));
				return;
			}
			if (!stopped) {
				setInfo((current) => {
					const next = current
						? ({
								...current,
								status: setupInfo.status,
								setup: setupInfo.setup,
							} satisfies OllamaIntegrationInfo)
						: current;
					if (next) rememberOllamaInfo(next);
					return next;
				});
			}
		};
		const poll = () => {
			timer = window.setTimeout(() => {
				void inspectNext()
					.then(() => {
						if (!stopped) setError(null);
					})
					.catch((cause) => {
						if (!stopped) {
							setError(
								cause instanceof Error
									? cause.message
									: "Could not inspect Windows Ollama.",
							);
						}
					})
					.finally(() => {
						if (!stopped) poll();
					});
			}, 1_000);
		};
		poll();
		return () => {
			stopped = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [pullActive, shouldPollSetup]);

	function renderWindowsSetupGuidance() {
		if (!info?.supported || info.status.available) return null;
		const setup = info.setup;
		const setupDisabled = disabled || operation !== null;
		const startDownload = () =>
			void act("setup download", () => startOllamaWindowsSetupDownloadFn());
		const retryVerification = () =>
			void act("retry setup verification", () =>
				startOllamaWindowsSetupDownloadFn(),
			);

		switch (setup.phase) {
			case "idle":
				return (
					<>
						<p className="break-words text-muted-foreground">
							Hlid can download and verify Ollama&apos;s official Windows
							installer. You choose whether to launch it and complete Ollama
							Setup.
						</p>
						<OllamaSetupDownloadAction
							disabled={setupDisabled}
							onConfirm={startDownload}
						/>
					</>
				);
			case "resolving":
				return (
					<>
						<p className="break-words">
							Finding the latest official Ollama Windows installer…
						</p>
						<button
							type="button"
							disabled={setupDisabled}
							onClick={() =>
								void act("cancel setup download", () =>
									cancelOllamaWindowsSetupDownloadFn(),
								)
							}
							className={`${ACTION_CLASS} text-status-warning`}
						>
							{operation === "cancel setup download"
								? "Canceling…"
								: "Cancel installer download"}
						</button>
					</>
				);
			case "downloading": {
				const percent =
					setup.total > 0
						? Math.min(100, Math.max(0, (setup.received / setup.total) * 100))
						: 0;
				return (
					<>
						<p className="break-words">
							Downloading Ollama Setup {setup.version}:{" "}
							{readableBytes(setup.received)}
							{" of "}
							{readableBytes(setup.total)} ({Math.round(percent)}%)
						</p>
						<progress
							aria-label="Ollama installer download progress"
							className="block h-1.5 w-full max-w-md accent-primary"
							max={Math.max(1, setup.total)}
							value={setup.received}
						/>
						<button
							type="button"
							disabled={setupDisabled}
							onClick={() =>
								void act("cancel setup download", () =>
									cancelOllamaWindowsSetupDownloadFn(),
								)
							}
							className={`${ACTION_CLASS} text-status-warning`}
						>
							{operation === "cancel setup download"
								? "Canceling…"
								: "Cancel installer download"}
						</button>
					</>
				);
			}
			case "verifying":
				return (
					<p className="break-words">
						Download complete. Hlid is verifying Ollama Setup {setup.version}
						before it can be launched…
					</p>
				);
			case "ready":
				return (
					<>
						<p className="break-words text-status-success">
							Ollama Setup {setup.version} is downloaded and verified. Hlid has
							not run it.
						</p>
						<button
							type="button"
							disabled={setupDisabled}
							onClick={() =>
								void act("launch setup", () => launchOllamaWindowsSetupFn())
							}
							className={`${ACTION_CLASS} text-primary`}
						>
							{operation === "launch setup"
								? "Launching Ollama Setup…"
								: "Launch Ollama Setup"}
						</button>
					</>
				);
			case "verification_failed":
				return (
					<>
						<p className="break-words text-status-error">
							Windows could not complete Ollama&apos;s Authenticode signature
							verification: {setup.reason}
						</p>
						<p className="break-words text-muted-foreground">
							This was a Windows verification infrastructure failure, not a
							confirmed bad installer. The installer matched the official
							SHA-256 digest. Hlid retained this SHA-verified copy of Ollama
							Setup {setup.version} without launching it.
						</p>
						<button
							type="button"
							disabled={setupDisabled}
							onClick={retryVerification}
							className={`${ACTION_CLASS} text-primary`}
						>
							{operation === "retry setup verification"
								? "Retrying installer verification…"
								: "Retry installer verification"}
						</button>
					</>
				);
			case "launched":
				return (
					<>
						<p className="break-words">
							Ollama Setup {setup.version} was launched on Windows. Finish the
							vendor installer there. Hlid is waiting for Ollama to answer…
						</p>
						<button
							type="button"
							disabled={setupDisabled}
							onClick={() =>
								void act("launch setup", () => launchOllamaWindowsSetupFn())
							}
							className={`${ACTION_CLASS} text-primary`}
						>
							{operation === "launch setup"
								? "Launching Ollama Setup…"
								: "Launch Ollama Setup again"}
						</button>
					</>
				);
			case "complete":
				return (
					<p className="break-words">
						Hlid detected Ollama after setup, but it is not answering now. Start
						Ollama on Windows, then refresh.
					</p>
				);
			case "canceled":
				return (
					<>
						<p className="break-words">
							Installer download canceled. No installer was launched.
						</p>
						<OllamaSetupDownloadAction
							disabled={setupDisabled}
							retry
							onConfirm={startDownload}
						/>
					</>
				);
			case "failed":
				return (
					<>
						<p className="break-words text-status-error">
							Ollama setup could not continue: {setup.reason}
						</p>
						<OllamaSetupDownloadAction
							disabled={setupDisabled}
							retry
							onConfirm={startDownload}
						/>
					</>
				);
		}
	}

	return (
		<section
			id="forge-section-ollama"
			aria-labelledby="forge-section-ollama-title"
			className="min-w-0 space-y-4"
		>
			<div className="min-w-0 space-y-1">
				<div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
					<div className="min-w-0">
						<h2 id="forge-section-ollama-title" className="text-sm">
							Windows Ollama
						</h2>
						<p className="break-words text-xs text-muted-foreground">
							Use the Ollama app installed on Windows. Hlid can manage its local
							models without installing an Ollama runtime in WSL.
						</p>
					</div>
					<button
						type="button"
						disabled={disabled || operation !== null}
						onClick={() => void refresh()}
						className={`${ACTION_CLASS} shrink-0 text-primary`}
					>
						{operation === "refresh"
							? "Checking…"
							: info
								? "Refresh Ollama"
								: "Check Windows Ollama"}
					</button>
				</div>

				<output aria-live="polite" className="block min-w-0">
					{info && !info.supported && (
						<p className="break-words text-xs text-status-warning">
							This integration is available when the Hlid server runs on
							Windows.
						</p>
					)}
					{info?.supported && !info.status.available && (
						<div className="space-y-2 text-xs text-status-warning">
							<p className="break-words">
								Ollama is not answering on Windows at 127.0.0.1:11434.
							</p>
							{renderWindowsSetupGuidance()}
							<a
								href={OLLAMA_WINDOWS_INSTRUCTIONS_URL}
								target="_blank"
								rel="noopener noreferrer"
								className={`${ACTION_CLASS} inline-flex items-center text-primary underline underline-offset-2`}
							>
								Open official instructions
							</a>
						</div>
					)}
					{info?.status.available && (
						<p className="break-words text-xs text-status-success">
							Windows Ollama {info.status.version}
							{info.setup.phase === "complete" ? " detected" : ""} ·{" "}
							{info.models.length} local model
							{info.models.length === 1 ? "" : "s"}
							{" · checked "}
							{new Date(info.status.checkedAt).toLocaleTimeString([], {
								hour: "numeric",
								minute: "2-digit",
							})}
						</p>
					)}
				</output>
			</div>

			{info?.status.available && (
				<section aria-labelledby="ollama-models-title" className="space-y-3">
					<div>
						<h3 id="ollama-models-title" className="text-xs text-foreground/80">
							Local models
						</h3>
						<p className="text-[10px] text-muted-foreground">
							Download and remove models from the Windows Ollama runtime.
						</p>
					</div>
					<form
						className="flex min-w-0 flex-col gap-2 @2xl:flex-row"
						onSubmit={(event) => {
							event.preventDefault();
							const model = modelName.trim();
							if (!model || pullActive) return;
							void act("download", async () => {
								await pullOllamaModelFn({ data: model });
								setModelName("");
							});
						}}
					>
						<label className="min-w-0 flex-1 text-[9px] tracking-widest text-muted-foreground uppercase">
							Exact Ollama model name
							<input
								value={modelName}
								disabled={disabled || operation !== null || pullActive}
								onChange={(event) => setModelName(event.target.value)}
								placeholder="qwen3-coder:30b"
								className="mt-1 min-h-11 w-full border border-border bg-input px-2 py-1 text-xs font-mono normal-case lg:min-h-0"
							/>
						</label>
						<button
							type="submit"
							disabled={
								disabled ||
								operation !== null ||
								pullActive ||
								!modelName.trim()
							}
							className={`${ACTION_CLASS} w-full self-end border border-primary/50 px-3 text-primary @2xl:w-auto disabled:border-border`}
						>
							Download model
						</button>
					</form>

					{pull && pull.state !== "idle" && (
						<output
							aria-live="polite"
							className="flex min-w-0 flex-wrap items-center justify-between gap-2 border border-border/70 px-2 py-2 text-[10px]"
						>
							<span className="min-w-0 break-all text-muted-foreground">
								{pullActive
									? `${pull.state === "canceling" ? "Canceling Hlid request" : pull.progress?.status || "Downloading"} · ${pull.model}${pullPercent !== null && pullPercent !== undefined ? ` · ${Math.round(pullPercent * 100)}%` : ""}`
									: `${pull.state} · ${pull.model}${"reason" in pull && pull.reason ? ` · ${pull.reason}` : ""}`}
							</span>
							{pull.state === "running" && (
								<button
									type="button"
									disabled={disabled || operation !== null}
									onClick={() => void act("cancel", () => cancelOllamaPullFn())}
									className={`${ACTION_CLASS} text-status-warning`}
								>
									Cancel Hlid request
								</button>
							)}
							{pull.state === "canceling" || pull.state === "canceled" ? (
								<p className="w-full break-words text-[9px] text-muted-foreground">
									Ollama has no documented global cancel operation. Hlid stops
									waiting, but the vendor may retain partial download data.
								</p>
							) : null}
						</output>
					)}

					{info.models.length > 0 && (
						<ul className="divide-y divide-border/60 border border-border/70">
							{info.models.map((model) => {
								const connected = modelIsSelected(selectedSet, model);
								const loaded = loadedModelFor(info, model);
								const deleteBlockerId = `ollama-delete-blocker-${modelDomIdSuffix(model)}`;
								return (
									<li
										key={`${model.model}:${model.digest}`}
										className="flex min-w-0 flex-col gap-2 px-2 py-2 @2xl:flex-row @2xl:items-center @2xl:justify-between"
									>
										<div className="min-w-0 text-xs">
											<code className="block break-all text-foreground">
												{model.model}
											</code>
											<span className="block break-words text-[9px] text-muted-foreground">
												{readableBytes(model.size)}
												{model.compatibilityInspection.status === "unknown"
													? " · compatibility not verified"
													: model.capabilities.includes("tools")
														? " · tool calling"
														: " · tool calling not supported"}
												{loaded
													? ` · loaded at ${loaded.contextLength.toLocaleString()} context`
													: " · not loaded"}
											</span>
											{connected && (
												<span className="block text-[9px] text-primary">
													{selectedForOpenCodeLabel}
												</span>
											)}
										</div>
										<div className="min-w-0 text-right">
											<ConfirmAction
												label={`Delete ${model.model} from Windows Ollama?`}
												disabled={disabled || operation !== null || connected}
												onConfirm={() =>
													void act("delete", () =>
														deleteOllamaModelFn({ data: model.model }),
													)
												}
												trigger={(open) => (
													<button
														type="button"
														disabled={
															disabled || operation !== null || connected
														}
														onClick={open}
														aria-describedby={
															connected ? deleteBlockerId : undefined
														}
														className={`${ACTION_CLASS} text-destructive disabled:text-muted-foreground/30`}
													>
														Delete
													</button>
												)}
											/>
											{connected && (
												<p
													id={deleteBlockerId}
													className="max-w-xs break-words text-[9px] text-muted-foreground"
												>
													Remove this model from the OpenCode selection before
													deleting it.
												</p>
											)}
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</section>
			)}

			<section
				aria-labelledby="ollama-opencode-title"
				className="min-w-0 space-y-3 border border-primary/25 bg-primary/5 px-3 py-3"
			>
				<div className="min-w-0 space-y-1">
					<h3 id="ollama-opencode-title" className="text-xs text-foreground/80">
						Use with OpenCode
					</h3>
					<p className="break-words text-[10px] text-muted-foreground">
						Hlid adds configured models only to OpenCode launches it manages.
						Ollama stays on Windows and OpenCode files are not changed.
						OpenCode's effective provider policy still decides what its catalog
						advertises.
					</p>
				</div>

				<fieldset
					disabled={disabled || operation !== null || !ollama}
					className="min-w-0 space-y-2 border border-border/70 px-2 py-2"
				>
					<legend className="px-1 text-[10px] text-foreground/80">
						Keep used models warm
					</legend>
					<div className="grid min-w-0 gap-2 @2xl:grid-cols-3">
						{OLLAMA_KEEP_WARM_POLICIES.map((policy) => {
							const copy =
								policy === "5m"
									? {
											label: "5 minutes",
											detail:
												"Release idle GPU memory sooner. Best when voice workloads share the GPU.",
										}
									: policy === "30m"
										? {
												label: "30 minutes",
												detail:
													"Reduce repeat cold starts while still releasing idle GPU memory.",
											}
										: {
												label: "Until OpenCode stops",
												detail:
													"Keep models used by an active Hlid-managed OpenCode runtime resident, then unload them.",
											};
							return (
								<label
									key={policy}
									className="flex min-w-0 cursor-pointer items-start gap-2 text-[10px] disabled:cursor-not-allowed"
								>
									<input
										type="radio"
										name="ollama-keep-warm"
										value={policy}
										checked={keepWarm === policy}
										onChange={() => changeKeepWarm(policy)}
										className="mt-0.5"
									/>
									<span className="min-w-0">
										<span className="block text-foreground/80">
											{copy.label}
										</span>
										<span className="block break-words text-[9px] text-muted-foreground">
											{copy.detail}
										</span>
									</span>
								</label>
							);
						})}
					</div>
					{!ollama && (
						<p className="text-[9px] text-muted-foreground">
							Select an Ollama model to configure its OpenCode warm period.
						</p>
					)}
				</fieldset>

				{!openCode && (
					<div className="flex min-w-0 flex-col items-start gap-2 @2xl:flex-row @2xl:items-center @2xl:justify-between">
						<p className="break-words text-[10px] text-status-warning">
							Set up OpenCode in Hlid before connecting another model. Hlid will
							not enable it or choose an execution environment for you.
						</p>
						<button
							type="button"
							disabled={disabled}
							onClick={onOpenCodeSetup}
							className={`${ACTION_CLASS} shrink-0 border border-primary/50 px-3 text-primary`}
						>
							Set up OpenCode
						</button>
					</div>
				)}

				{info && info.wsl.length > 0 && (
					<ul className="space-y-1 text-[9px] text-muted-foreground">
						{info.wsl.map((network) => (
							<li key={network.distro} className="break-all">
								<span className="text-foreground/70">
									WSL · {network.distro}
								</span>
								{" · "}
								{network.ready
									? `${network.mode} · Windows route ${network.windowsHostAddress}:${info.relay.port}${info.relay.listeners.some((listener) => listener.address === network.windowsHostAddress) ? " · relay active" : " · relay starts when OpenCode launches"}`
									: network.blockedReason}
							</li>
						))}
					</ul>
				)}

				{info?.firewall.supported &&
					(info.firewall.exact ||
						info.wsl.some(
							(network) => network.ready && network.mode === "nat",
						)) && (
						<div className="flex min-w-0 flex-col items-start gap-2 border border-border/70 px-2 py-2 text-[10px] @2xl:flex-row @2xl:items-center @2xl:justify-between">
							<div className="min-w-0">
								<div className="text-foreground/80">WSL OpenCode access</div>
								<p
									className={`break-words ${
										info.firewall.exact
											? "text-status-success"
											: "text-muted-foreground"
									}`}
								>
									{info.firewall.exact
										? `Ready · inbound TCP ${info.firewall.port} is limited to WSL`
										: (info.firewall.blockedReason ??
											"Windows approval is required once for the narrow WSL relay port.")}
								</p>
							</div>
							{info.wsl.some(
								(network) => network.ready && network.mode === "nat",
							) &&
								!info.firewall.exact &&
								!info.firewall.installed &&
								!info.firewall.blockedReason && (
									<ConfirmAction
										label={`Allow only WSL inbound TCP ${info.firewall.port} to Hlid's Ollama relay? Windows will request administrator approval.`}
										confirmText="Request approval"
										variant="primary"
										disabled={disabled || operation !== null}
										onConfirm={() =>
											void act("firewall", () => installOllamaWslFirewallFn())
										}
										trigger={(open) => (
											<button
												type="button"
												disabled={disabled || operation !== null}
												onClick={open}
												className={`${ACTION_CLASS} shrink-0 text-primary`}
											>
												Allow WSL OpenCode access
											</button>
										)}
									/>
								)}
							{info.firewall.exact && (
								<ConfirmAction
									label="Remove Hlid's inbound TCP rule for the Ollama WSL relay? WSL OpenCode will lose local-model access in NAT mode."
									disabled={disabled || operation !== null}
									onConfirm={() =>
										void act("firewall removal", () =>
											removeOllamaWslFirewallFn(),
										)
									}
									trigger={(open) => (
										<button
											type="button"
											disabled={disabled || operation !== null}
											onClick={open}
											className={`${ACTION_CLASS} shrink-0 text-destructive`}
										>
											Remove WSL OpenCode access
										</button>
									)}
								/>
							)}
						</div>
					)}

				{missingSelected.length > 0 && (
					<ul className="divide-y divide-status-warning/30 border border-status-warning/50">
						{missingSelected.map((model) => (
							<li
								key={model}
								className="flex min-w-0 flex-col gap-2 px-2 py-2 @2xl:flex-row @2xl:items-center @2xl:justify-between"
							>
								<div className="min-w-0 text-[10px]">
									<code className="block break-all text-status-warning">
										{model}
									</code>
									<p className="break-words text-muted-foreground">
										{openCode
											? info?.status.available
												? "Configured for OpenCode, but no longer found in Windows Ollama."
												: "Configured for OpenCode, but Windows Ollama is unavailable, so Hlid cannot verify it."
											: info?.status.available
												? "Selected for OpenCode setup, but no longer found in Windows Ollama."
												: "Selected for OpenCode setup, but Windows Ollama is unavailable, so Hlid cannot verify it."}
									</p>
								</div>
								<button
									type="button"
									aria-label={`Remove missing Ollama model ${model} from ${openCode ? "OpenCode" : "OpenCode setup"}`}
									disabled={disabled || operation !== null}
									onClick={() =>
										changeSelection(
											selected.filter((candidate) => candidate !== model),
										)
									}
									className={`${ACTION_CLASS} shrink-0 text-status-warning`}
								>
									{removeFromOpenCodeLabel}
								</button>
							</li>
						))}
					</ul>
				)}

				{info?.models && info.models.length > 0 && (
					<ul className="divide-y divide-border/60 border border-border/70">
						{info.models.map((model) => {
							const connected = modelIsSelected(selectedSet, model);
							const loaded = loadedModelFor(info, model);
							const preparedModel = preparedModelFor(info, model);
							const compatibilityBlocker = modelCompatibilityBlocker(model);
							const prepared =
								Boolean(preparedModel) &&
								(preparedModel?.contextLength ?? 0) >=
									OPENCODE_LOCAL_MODEL_MIN_CONTEXT;
							const selectionLimitReached = !connected && selected.length >= 64;
							const fullModelId = `${PROVIDER_PREFIX}${model.model}`;
							const onlyFilterWouldOverflow =
								!connected &&
								openCode?.model_filter?.mode === "only" &&
								openCode.model_filter.models.filter(
									(candidate) => !candidate.startsWith(PROVIDER_PREFIX),
								).length +
									selected.filter(
										(candidate) =>
											`${PROVIDER_PREFIX}${candidate}` !== fullModelId,
									).length +
									1 >
									256;
							const connectionBlocker = compatibilityBlocker
								? compatibilityBlocker
								: selectionLimitReached
									? "You can connect up to 64 Ollama models."
									: onlyFilterWouldOverflow
										? "The OpenCode model allowlist is full."
										: null;
							const blockerId = `ollama-opencode-blocker-${modelDomIdSuffix(model)}`;

							return (
								<li
									key={`${model.model}:${model.digest}`}
									className="min-w-0 space-y-2 px-2 py-2"
								>
									<div className="flex min-w-0 flex-col gap-2 @2xl:flex-row @2xl:items-center @2xl:justify-between">
										<div className="min-w-0 text-[10px]">
											<code className="block break-all text-foreground">
												{model.model}
											</code>
											<p className="break-words text-muted-foreground">
												{connected
													? selectedForOpenCodeLabel
													: "Not configured"}
												{" · "}
												{prepared
													? `prepared at ${preparedModel?.contextLength.toLocaleString()} context`
													: loaded
														? `base model loaded at ${loaded.contextLength.toLocaleString()} context · OpenCode variant not prepared`
														: "OpenCode variant not prepared"}
											</p>
										</div>
										<div className="flex min-w-0 flex-wrap items-center gap-2">
											{!compatibilityBlocker && (
												<button
													type="button"
													disabled={disabled || operation !== null}
													onClick={() =>
														void act(prepared ? "unload" : "prepare", () =>
															prepared
																? unloadOllamaModelFn({ data: model.model })
																: loadOllamaModelFn({ data: model.model }),
														)
													}
													className={`${ACTION_CLASS} text-primary`}
												>
													{prepared ? "Unload" : "Prepare for OpenCode"}
												</button>
											)}
											{connected ? (
												<button
													type="button"
													disabled={disabled || operation !== null}
													onClick={() =>
														changeSelection(
															withoutModelSelection(selected, model),
														)
													}
													className={`${ACTION_CLASS} text-status-warning`}
												>
													{removeFromOpenCodeLabel}
												</button>
											) : openCode ? (
												<button
													type="button"
													disabled={
														disabled ||
														operation !== null ||
														connectionBlocker !== null
													}
													onClick={() =>
														changeSelection([...selected, model.model])
													}
													aria-describedby={
														connectionBlocker ? blockerId : undefined
													}
													className={`${ACTION_CLASS} text-primary`}
												>
													Use with OpenCode
												</button>
											) : null}
										</div>
									</div>
									{connectionBlocker && !connected && (
										<p
											id={blockerId}
											className="break-words text-[9px] text-status-warning"
										>
											{connectionBlocker}
										</p>
									)}
								</li>
							);
						})}
					</ul>
				)}

				{selected.length > 0 && openCode && (
					<p className="break-words text-[9px] text-muted-foreground">
						Windows and WSL OpenCode receive expiring, process-scoped and
						model-scoped relay credentials. Hlid reaches Ollama through Windows
						loopback and creates a fixed-context Ollama variant for the
						requested model when it is first prepared or used.
					</p>
				)}
				{selected.length > 0 && !openCode && (
					<p className="break-words text-[9px] text-status-warning">
						These models remain selected for OpenCode, but Hlid will not expose
						them until OpenCode setup is complete.
					</p>
				)}
			</section>

			{error && (
				<p role="alert" className="break-all text-[10px] text-status-error">
					{error}
				</p>
			)}
		</section>
	);
}
