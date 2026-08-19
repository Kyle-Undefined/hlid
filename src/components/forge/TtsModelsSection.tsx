import { useRef } from "react";
import {
	cancelTtsDownloadFn,
	deleteTtsModelFn,
	getTtsInfoFn,
	installTtsDirectMlRuntimeFn,
	readTtsRuntimeMutationResponse,
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
const DIRECTML_BUSY_ID = "__directml-runtime";

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
				{model.backends.includes("directml")
					? " · DirectML qualified"
					: " · CPU"}
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

function DirectMlRuntimeImport({
	info,
	onInfoChange,
	busy,
	onBusyChange,
	onError,
}: Pick<
	TtsModelActionsProps,
	"info" | "onInfoChange" | "busy" | "onBusyChange" | "onError"
>) {
	const inputRef = useRef<HTMLInputElement>(null);
	const runtime = info.runtime?.directml;
	if (!runtime?.supported) return null;
	if (runtime.installed) {
		return (
			<div className="border-b border-border px-4 py-3 text-xs text-muted-foreground">
				Reviewed DirectML runtime installed and verified.
			</div>
		);
	}
	const downloadAndInstall = async () => {
		onBusyChange(DIRECTML_BUSY_ID);
		onError(null);
		try {
			onInfoChange(await installTtsDirectMlRuntimeFn());
		} catch (cause) {
			onError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			onBusyChange(null);
		}
	};
	const install = async () => {
		const files = [...(inputRef.current?.files ?? [])];
		const archiveName = `${runtime.runtimeId}.zip`;
		const archive = files.find((file) => file.name === archiveName);
		const manifest = files.find(
			(file) => file.name === "runtime-manifest.json",
		);
		if (!archive || !manifest) {
			onError(`Select ${archiveName} and runtime-manifest.json together.`);
			return;
		}
		onBusyChange(DIRECTML_BUSY_ID);
		onError(null);
		try {
			const form = new FormData();
			form.append("archive", archive);
			form.append("manifest", manifest);
			const response = await fetch("/api/tts/runtime/install", {
				method: "POST",
				body: form,
			});
			onInfoChange(await readTtsRuntimeMutationResponse(response));
		} catch (cause) {
			onError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			onBusyChange(null);
		}
	};
	return (
		<div className="space-y-2 border-b border-border px-4 py-3">
			<div className="text-xs text-muted-foreground">
				Download the reviewed DirectML runtime published with this Hlid release
				to enable qualified GPU acceleration. Hlid verifies every file before
				installing it.
			</div>
			<button
				type="button"
				disabled={busy !== null}
				onClick={() => void downloadAndInstall()}
				className="min-h-11 px-2.5 py-1.5 text-[10px] tracking-widest border border-border hover:bg-accent disabled:opacity-30 uppercase @lg:min-h-0"
			>
				{busy === DIRECTML_BUSY_ID
					? "DOWNLOADING AND VERIFYING…"
					: "DOWNLOAD AND INSTALL"}
			</button>
			<details>
				<summary className="w-fit cursor-pointer text-[10px] tracking-widest text-muted-foreground hover:text-foreground uppercase">
					Manual import
				</summary>
				<div className="mt-2 flex max-w-full flex-wrap items-center gap-2">
					<input
						ref={inputRef}
						type="file"
						multiple
						accept=".zip,.json"
						aria-label="Reviewed DirectML runtime files"
						className="min-w-0 max-w-full text-xs text-muted-foreground file:mr-2 file:border file:border-border file:bg-transparent file:px-2.5 file:py-1.5 file:text-[10px] file:tracking-widest file:text-foreground file:uppercase"
					/>
					<button
						type="button"
						disabled={busy !== null}
						onClick={() => void install()}
						className="min-h-11 px-2.5 py-1.5 text-[10px] tracking-widest border border-border hover:bg-accent disabled:opacity-30 uppercase @lg:min-h-0"
					>
						{busy === DIRECTML_BUSY_ID ? "VERIFYING" : "INSTALL FILES"}
					</button>
				</div>
			</details>
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
			<DirectMlRuntimeImport
				info={info}
				onInfoChange={onInfoChange}
				busy={busy}
				onBusyChange={onBusyChange}
				onError={onError}
			/>
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
