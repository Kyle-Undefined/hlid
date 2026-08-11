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

type TtsModel = TtsInfo["models"][number];
type TtsDownload = NonNullable<TtsInfo["status"]["download"]>;

type TtsModelActionsProps = {
	model: TtsModel;
	selected: boolean;
	info: TtsInfo;
	busy: string | null;
	onChange: (patch: Partial<VoiceForm>) => void;
	onInfoChange: (info: TtsInfo) => void;
	onBusyChange: (modelId: string | null) => void;
	onError: (message: string | null) => void;
};

type InstalledModelActionsProps = Pick<
	TtsModelActionsProps,
	| "model"
	| "selected"
	| "info"
	| "onChange"
	| "onInfoChange"
	| "onBusyChange"
	| "onError"
>;

type DownloadModelActionProps = Pick<
	TtsModelActionsProps,
	"model" | "busy" | "onInfoChange" | "onBusyChange" | "onError"
>;

function ModelDetails({
	model,
	progress,
}: {
	model: TtsModel;
	progress: TtsDownload | null;
}) {
	return (
		<div className="min-w-0">
			<div className="break-words text-sm text-foreground">
				{model.label}
				{model.recommended ? " · recommended" : ""}
			</div>
			<div className="break-words text-xs text-muted-foreground">
				{model.description} · {model.tier}
			</div>
			<div className="text-xs text-muted-foreground">
				{size(model.sizeBytes)} model · {size(model.runtimeSizeBytes)} runtime ·{" "}
				{model.language}
				{model.quantized ? " · quantized" : ""}
			</div>
			<div className="text-xs text-muted-foreground mt-0.5">
				{model.license}
			</div>
			{progress && (
				<div className="text-xs text-primary mt-1" aria-live="polite">
					{progress.item === "runtime" ? "Runtime" : "Model"}:{" "}
					{size(progress.received)}
					{progress.total ? ` / ${size(progress.total)}` : " downloaded"}
				</div>
			)}
		</div>
	);
}

function InstalledModelActions(props: InstalledModelActionsProps) {
	const { model, selected, info, onChange, onBusyChange, onError } = props;
	const remove = async () => {
		onBusyChange(model.id);
		onError(null);
		try {
			await deleteTtsModelFn({ data: model.id });
			props.onInfoChange(await getTtsInfoFn());
		} catch (cause) {
			onError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			onBusyChange(null);
		}
	};
	return (
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
				className="min-h-11 px-2.5 py-1.5 text-[10px] tracking-widest border border-border hover:bg-accent disabled:text-primary uppercase @lg:min-h-0"
			>
				{selected ? "SELECTED" : "SELECT"}
			</button>
			<button
				type="button"
				disabled={info.status.loadedModel === model.id}
				onClick={() => void remove()}
				className="min-h-11 px-2.5 py-1.5 text-[10px] tracking-widest text-destructive disabled:opacity-30 uppercase @lg:min-h-0"
			>
				DELETE
			</button>
		</>
	);
}

function DownloadModelAction(props: DownloadModelActionProps) {
	const { model, busy, onInfoChange, onBusyChange, onError } = props;
	const download = async () => {
		onBusyChange(model.id);
		onError(null);
		try {
			await startTtsDownloadFn({ data: model.id });
			onInfoChange(await getTtsInfoFn());
		} catch (cause) {
			onError(cause instanceof Error ? cause.message : String(cause));
			onBusyChange(null);
		}
	};
	return (
		<button
			type="button"
			disabled={busy !== null}
			onClick={() => void download()}
			className="min-h-11 px-2.5 py-1.5 text-[10px] tracking-widest border border-border hover:bg-accent disabled:opacity-30 uppercase @lg:min-h-0"
		>
			DOWNLOAD
		</button>
	);
}

function TtsModelActions({
	progress,
	...props
}: TtsModelActionsProps & { progress: TtsDownload | null }) {
	const refresh = async () => {
		props.onInfoChange(await getTtsInfoFn());
		props.onBusyChange(null);
	};
	if (props.model.installed) return <InstalledModelActions {...props} />;
	if (!progress) return <DownloadModelAction {...props} />;
	return (
		<button
			type="button"
			onClick={() => void cancelTtsDownloadFn().then(refresh)}
			className="min-h-11 px-2.5 py-1.5 text-[10px] tracking-widest border border-border uppercase @lg:min-h-0"
		>
			CANCEL
		</button>
	);
}

function TtsModelRow(props: TtsModelActionsProps) {
	const progress =
		props.info.status.download?.model === props.model.id
			? props.info.status.download
			: null;
	return (
		<div className="flex min-w-0 flex-col justify-between gap-3 px-4 py-3 @2xl:flex-row @2xl:items-center">
			<ModelDetails model={props.model} progress={progress} />
			<div className="flex max-w-full flex-wrap items-center gap-2">
				<TtsModelActions {...props} progress={progress} />
			</div>
		</div>
	);
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
	return (
		<Section title="Neural voice model" id="forge-section-voice-models">
			{info.models.length === 0 && (
				<div className="px-4 py-3 text-xs text-muted-foreground">
					{info.status.error ||
						"No compatible local neural speech model is available."}
				</div>
			)}
			{info.models.map((model) => (
				<TtsModelRow
					key={model.id}
					model={model}
					selected={voice.tts_model === model.id}
					info={info}
					busy={busy}
					onChange={onChange}
					onInfoChange={onInfoChange}
					onBusyChange={onBusyChange}
					onError={onError}
				/>
			))}
			{error && (
				<div
					className="break-words [overflow-wrap:anywhere] px-4 py-3 text-xs text-destructive"
					role="alert"
				>
					{error}
				</div>
			)}
		</Section>
	);
}
