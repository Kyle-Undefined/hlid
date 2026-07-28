import {
	cancelTtsDownloadFn,
	deleteTtsModelFn,
	getTtsInfoFn,
	startTtsDownloadFn,
	type TtsInfo,
} from "#/lib/serverFns/tts";
import { Section } from "./fields";
import type { VoiceForm } from "./VoiceSection";

function size(bytes: number): string {
	return bytes >= 1024 ** 3
		? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
		: `${Math.round(bytes / 1024 ** 2)} MiB`;
}

export function TtsModelsSection({
	voice,
	onChange,
	info,
	onInfoChange,
	busy,
	onBusyChange,
	error,
	onError,
}: {
	voice: VoiceForm;
	onChange: (patch: Partial<VoiceForm>) => void;
	info: TtsInfo;
	onInfoChange: (info: TtsInfo) => void;
	busy: string | null;
	onBusyChange: (modelId: string | null) => void;
	error: string | null;
	onError: (message: string | null) => void;
}) {
	async function refresh(): Promise<void> {
		onInfoChange(await getTtsInfoFn());
		onBusyChange(null);
	}

	return (
		<Section title="Neural voice model">
			{info.models.length === 0 && (
				<div className="px-4 py-3 text-xs text-muted-foreground">
					{info.status.error ||
						"No compatible local neural speech model is available."}
				</div>
			)}
			{info.models.map((model) => {
				const selected = voice.tts_model === model.id;
				const progress =
					info.status.download?.model === model.id
						? info.status.download
						: null;
				return (
					<div
						key={model.id}
						className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
					>
						<div>
							<div className="text-sm text-foreground">
								{model.label}
								{model.recommended ? " · recommended" : ""}
							</div>
							<div className="text-xs text-muted-foreground">
								{model.description} · {model.tier}
							</div>
							<div className="text-xs text-muted-foreground">
								{size(model.sizeBytes)} model · {size(model.runtimeSizeBytes)}{" "}
								runtime · {model.language}
								{model.quantized ? " · quantized" : ""}
							</div>
							<div className="text-xs text-muted-foreground mt-0.5">
								{model.license}
							</div>
							{progress && (
								<div className="text-xs text-primary mt-1" aria-live="polite">
									{progress.item === "runtime" ? "Runtime" : "Model"}:{" "}
									{size(progress.received)}
									{progress.total
										? ` / ${size(progress.total)}`
										: " downloaded"}
								</div>
							)}
						</div>
						<div className="flex items-center gap-2">
							{model.installed ? (
								<>
									<button
										type="button"
										disabled={selected}
										onClick={() =>
											onChange({
												tts_model: model.id,
												tts_voice: model.voices[0]?.id ?? "",
											})
										}
										className="px-2.5 py-1.5 text-[10px] tracking-widest border border-border hover:bg-accent disabled:text-primary uppercase"
									>
										{selected ? "SELECTED" : "SELECT"}
									</button>
									<button
										type="button"
										disabled={info.status.loadedModel === model.id}
										onClick={() => {
											onBusyChange(model.id);
											onError(null);
											void deleteTtsModelFn({ data: model.id })
												.then(refresh)
												.catch((cause) => {
													onError(
														cause instanceof Error
															? cause.message
															: String(cause),
													);
													onBusyChange(null);
												});
										}}
										className="px-2.5 py-1.5 text-[10px] tracking-widest text-destructive disabled:opacity-30 uppercase"
									>
										DELETE
									</button>
								</>
							) : progress ? (
								<button
									type="button"
									onClick={() => void cancelTtsDownloadFn().then(refresh)}
									className="px-2.5 py-1.5 text-[10px] tracking-widest border border-border uppercase"
								>
									CANCEL
								</button>
							) : (
								<button
									type="button"
									disabled={busy !== null}
									onClick={() => {
										onBusyChange(model.id);
										onError(null);
										void startTtsDownloadFn({ data: model.id })
											.then(() => getTtsInfoFn())
											.then(onInfoChange)
											.catch((cause) => {
												onError(
													cause instanceof Error
														? cause.message
														: String(cause),
												);
												onBusyChange(null);
											});
									}}
									className="px-2.5 py-1.5 text-[10px] tracking-widest border border-border hover:bg-accent disabled:opacity-30 uppercase"
								>
									DOWNLOAD
								</button>
							)}
						</div>
					</div>
				);
			})}
			{error && (
				<div className="px-4 py-3 text-xs text-destructive" role="alert">
					{error}
				</div>
			)}
		</Section>
	);
}
