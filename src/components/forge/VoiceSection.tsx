import { useEffect, useState } from "react";
import type { HlidConfig } from "#/config";
import {
	cancelVoiceDownloadFn,
	deleteVoiceModelFn,
	getVoiceInfoFn,
	startVoiceDownloadFn,
	type VoiceInfo,
} from "#/lib/serverFns";
import { displayVoiceHotkey, voiceHotkeyFromEvent } from "#/lib/voiceHotkey";
import { Field, Section } from "./fields";

export type VoiceForm = HlidConfig["voice"];

const LANGUAGES = [
	["auto", "Automatic"],
	["en", "English"],
	["es", "Spanish"],
	["fr", "French"],
	["de", "German"],
	["it", "Italian"],
	["pt", "Portuguese"],
	["ja", "Japanese"],
	["zh", "Chinese"],
] as const;

function size(bytes: number): string {
	return bytes >= 1024 ** 3
		? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
		: `${Math.round(bytes / 1024 ** 2)} MiB`;
}

export function VoiceSection({
	voice,
	onChange,
	initialInfo,
}: {
	voice: VoiceForm;
	onChange: (patch: Partial<VoiceForm>) => void;
	initialInfo: VoiceInfo;
}) {
	const [info, setInfo] = useState(initialInfo);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!busy && !info.status.download && info.status.state !== "loading")
			return;
		const timer = setInterval(
			() =>
				void getVoiceInfoFn().then((next) => {
					setInfo(next);
					if (
						busy &&
						!next.status.download &&
						(next.status.error ||
							next.models.some((model) => model.id === busy && model.installed))
					)
						setBusy(null);
				}),
			750,
		);
		return () => clearInterval(timer);
	}, [busy, info.status.download, info.status.state]);

	// Refresh after the auto-saved config reaches the server and starts a model swap.
	// biome-ignore lint/correctness/useExhaustiveDependencies: voice selection intentionally triggers this status refresh
	useEffect(() => {
		const timer = setTimeout(() => void getVoiceInfoFn().then(setInfo), 1200);
		return () => clearTimeout(timer);
	}, [voice.enabled, voice.model]);

	async function refresh(): Promise<void> {
		setInfo(await getVoiceInfoFn());
		setBusy(null);
	}

	return (
		<div className="space-y-6">
			<Section title="Voice input">
				<Field
					label="Voice"
					hint="transcribe microphone audio locally on this machine"
				>
					<label className="flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							checked={voice.enabled}
							onChange={(e) => onChange({ enabled: e.target.checked })}
							className="w-3.5 h-3.5 accent-primary"
						/>
						<span className="text-xs text-muted-foreground">enabled</span>
					</label>
				</Field>
				<Field label="Runtime status" hint={info.status.error}>
					<span
						className={
							info.status.state === "ready"
								? "text-xs text-green-500"
								: "text-xs text-muted-foreground"
						}
						aria-live="polite"
					>
						{info.status.state}
						{info.status.loadedModel ? ` · ${info.status.loadedModel}` : ""}
					</span>
				</Field>
				<Field
					label="Language"
					hint="automatic detection works with multilingual models"
				>
					<select
						value={voice.language}
						onChange={(e) => onChange({ language: e.target.value })}
						className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
					>
						{LANGUAGES.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</Field>
				<Field
					label="After transcription"
					hint="reviewing first reduces accidental submissions"
				>
					<select
						value={voice.auto_send ? "send" : "review"}
						onChange={(e) => onChange({ auto_send: e.target.value === "send" })}
						className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50"
					>
						<option value="review">Review draft</option>
						<option value="send">Send immediately</option>
					</select>
				</Field>
				<Field
					label="Recording hotkey"
					hint="desktop shortcut; press once to start and again to stop"
				>
					<input
						type="text"
						readOnly
						value={voice.hotkey ? displayVoiceHotkey(voice.hotkey) : ""}
						placeholder="Click and press shortcut"
						onKeyDown={(event) => {
							event.preventDefault();
							if (event.key === "Escape" || event.key === "Backspace") {
								onChange({ hotkey: "" });
								return;
							}
							const hotkey = voiceHotkeyFromEvent(event.nativeEvent);
							if (hotkey) onChange({ hotkey });
						}}
						aria-label="Voice recording hotkey"
						className="w-40 sm:w-52 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 cursor-pointer"
					/>
				</Field>
			</Section>

			<Section title="Whisper models">
				{info.models.map((model) => {
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
									{size(model.sizeBytes)} ·{" "}
									{model.multilingual ? "multilingual" : "English only"}
									{model.quantized ? " · quantized" : ""}
								</div>
								{progress && (
									<div className="text-xs text-primary mt-1" aria-live="polite">
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
											disabled={voice.model === model.id}
											onClick={() => onChange({ model: model.id })}
											className="px-2.5 py-1.5 text-[10px] tracking-widest border border-border hover:bg-accent disabled:text-primary uppercase"
										>
											{voice.model === model.id ? "SELECTED" : "SELECT"}
										</button>
										<button
											type="button"
											disabled={info.status.loadedModel === model.id}
											onClick={() => {
												setBusy(model.id);
												void deleteVoiceModelFn({ data: model.id })
													.then(refresh)
													.catch((e) => {
														setError(e.message);
														setBusy(null);
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
											setBusy(model.id);
											setError(null);
											void startVoiceDownloadFn({ data: model.id })
												.then(() => getVoiceInfoFn())
												.then(setInfo)
												.catch((e) => {
													setError(e.message);
													setBusy(null);
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
		</div>
	);
}
