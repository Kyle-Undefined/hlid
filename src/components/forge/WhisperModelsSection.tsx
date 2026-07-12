import {
	cancelVoiceDownloadFn,
	deleteVoiceModelFn,
	getVoiceInfoFn,
	startVoiceDownloadFn,
	type VoiceInfo,
} from "#/lib/serverFns/voice";
import { Section } from "./fields";
import type { VoiceForm } from "./VoiceSection";

function size(bytes: number): string {
	return bytes >= 1024 ** 3
		? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
		: `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function WhisperModelRow({
	model,
	info,
	selected,
	busy,
	onSelect,
	onBusyChange,
	onError,
	onInfoChange,
}: {
	model: VoiceInfo["models"][number];
	info: VoiceInfo;
	selected: boolean;
	busy: string | null;
	onSelect: () => void;
	onBusyChange: (modelId: string | null) => void;
	onError: (message: string | null) => void;
	onInfoChange: (info: VoiceInfo) => void;
}) {
	const progress =
		info.status.download?.model === model.id ? info.status.download : null;

	async function refresh(): Promise<void> {
		onInfoChange(await getVoiceInfoFn());
		onBusyChange(null);
	}

	return (
		<div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
			<div>
				<div className="text-sm text-foreground">
					{model.label}
					{model.recommended ? " · recommended" : ""}
				</div>
				<div className="text-xs text-muted-foreground">
					{size(model.sizeBytes)} ·{" "}
					{model.multilingual ? "multilingual" : "English only"}
					{model.quantized ? " · quantized" : ""}
				</div>
				{progress && (
					<div className="text-xs text-primary mt-1" aria-live="polite">
						{size(progress.received)}
						{progress.total ? ` / ${size(progress.total)}` : " downloaded"}
					</div>
				)}
			</div>
			<div className="flex items-center gap-2">
				{model.installed ? (
					<>
						<button
							type="button"
							disabled={selected}
							onClick={onSelect}
							className="px-2.5 py-1.5 text-[10px] tracking-widest border border-border hover:bg-accent disabled:text-primary uppercase"
						>
							{selected ? "SELECTED" : "SELECT"}
						</button>
						<button
							type="button"
							disabled={info.status.loadedModel === model.id}
							onClick={() => {
								onBusyChange(model.id);
								void deleteVoiceModelFn({ data: model.id })
									.then(refresh)
									.catch((e) => {
										onError(e.message);
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
						onClick={() => void cancelVoiceDownloadFn().then(refresh)}
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
							void startVoiceDownloadFn({ data: model.id })
								.then(() => getVoiceInfoFn())
								.then(onInfoChange)
								.catch((e) => {
									onError(e.message);
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
}

/** Per-model download/select/delete controls for the local Whisper transcription models. */
export function WhisperModelsSection({
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
	info: VoiceInfo;
	onInfoChange: (info: VoiceInfo) => void;
	busy: string | null;
	onBusyChange: (modelId: string | null) => void;
	error: string | null;
	onError: (message: string | null) => void;
}) {
	return (
		<Section title="Whisper models">
			{info.models.map((model) => (
				<WhisperModelRow
					key={model.id}
					model={model}
					info={info}
					selected={voice.model === model.id}
					busy={busy}
					onSelect={() => onChange({ model: model.id })}
					onBusyChange={onBusyChange}
					onError={onError}
					onInfoChange={onInfoChange}
				/>
			))}
			{error && (
				<div className="px-4 py-3 text-xs text-destructive" role="alert">
					{error}
				</div>
			)}
		</Section>
	);
}
