import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type HlidConfig,
	MAX_VOICE_PRONUNCIATION_LENGTH,
	MAX_VOICE_PRONUNCIATIONS,
	type VoicePronunciation,
} from "#/config";
import type { TtsInfo } from "#/lib/serverFns/tts";
import { applySpeechPronunciations } from "#/lib/speechPronunciations";
import { Field } from "./fields";

type VoiceConfig = HlidConfig["voice"];
type PreviewPhase = "idle" | "loading" | "playing";
type PreviewTarget = number | "sentence";
type PronunciationDraft = VoicePronunciation & { id: string };
const MAX_PRONUNCIATION_TEST_CHARS = 300;

function isComplete(entry: VoicePronunciation): boolean {
	return Boolean(entry.written.trim() && entry.spoken.trim());
}

function normalizedPronunciations(
	pronunciations: readonly PronunciationDraft[],
): VoicePronunciation[] {
	return pronunciations.map((entry) => ({
		written: entry.written.trim(),
		spoken: entry.spoken.trim(),
	}));
}

function duplicateWrittenIndexes(
	pronunciations: readonly PronunciationDraft[],
): Set<number> {
	const indexesByWritten = new Map<string, number[]>();
	for (const [index, entry] of pronunciations.entries()) {
		const written = entry.written.trim().normalize("NFC").toLowerCase();
		if (!written) continue;
		const indexes = indexesByWritten.get(written) ?? [];
		indexes.push(index);
		indexesByWritten.set(written, indexes);
	}

	const duplicates = new Set<number>();
	for (const indexes of indexesByWritten.values()) {
		if (indexes.length < 2) continue;
		for (const index of indexes) duplicates.add(index);
	}
	return duplicates;
}

async function previewResponseError(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error.trim()) {
			return body.error.trim();
		}
	} catch {
		// Fall through to a bounded status message when the response is not JSON.
	}
	return `Preview could not be prepared (${response.status})`;
}

function usePronunciationPreview() {
	const [activeTarget, setActiveTarget] = useState<PreviewTarget | null>(null);
	const [phase, setPhase] = useState<PreviewPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const objectUrlRef = useRef<string | null>(null);

	const releaseAudio = useCallback(() => {
		audioRef.current?.pause();
		audioRef.current = null;
		if (objectUrlRef.current) {
			URL.revokeObjectURL(objectUrlRef.current);
			objectUrlRef.current = null;
		}
	}, []);

	const finish = useCallback(() => {
		releaseAudio();
		setActiveTarget(null);
		setPhase("idle");
	}, [releaseAudio]);

	const stop = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		finish();
		setError(null);
	}, [finish]);

	useEffect(
		() => () => {
			abortRef.current?.abort();
			abortRef.current = null;
			releaseAudio();
		},
		[releaseAudio],
	);

	const play = useCallback(
		async (
			target: PreviewTarget,
			text: string,
			voiceId: string,
			rate: number,
		) => {
			abortRef.current?.abort();
			abortRef.current = new AbortController();
			releaseAudio();
			setActiveTarget(target);
			setPhase("loading");
			setError(null);
			const abort = abortRef.current;
			try {
				const response = await fetch("/api/speech/synthesize", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						text,
						voice_id: voiceId,
						rate,
					}),
					signal: abort.signal,
				});
				if (!response.ok) throw new Error(await previewResponseError(response));
				const objectUrl = URL.createObjectURL(await response.blob());
				if (abort.signal.aborted) {
					URL.revokeObjectURL(objectUrl);
					return;
				}
				objectUrlRef.current = objectUrl;
				const audio = new Audio(objectUrl);
				audioRef.current = audio;
				audio.onplaying = () => {
					if (audioRef.current === audio) setPhase("playing");
				};
				audio.onended = () => {
					if (audioRef.current === audio) finish();
				};
				audio.onerror = () => {
					if (audioRef.current !== audio) return;
					finish();
					setError("Preview playback failed");
				};
				await audio.play();
			} catch (cause) {
				if (abort.signal.aborted) return;
				finish();
				setError(cause instanceof Error ? cause.message : "Preview failed");
			} finally {
				if (abortRef.current === abort) abortRef.current = null;
			}
		},
		[finish, releaseAudio],
	);

	return { activeTarget, phase, error, play, stop };
}

function neuralPreviewSelection(
	voice: VoiceConfig,
	ttsInfo: TtsInfo | undefined,
): {
	voiceId: string;
	ready: boolean;
	modelMismatch: boolean;
} {
	const model =
		ttsInfo?.models.find((item) => item.id === voice.tts_model) ??
		ttsInfo?.models.find((item) => item.recommended);
	const voiceId =
		model?.voices.find((candidate) => candidate.id === voice.tts_voice)?.id ??
		model?.voices[0]?.id ??
		"";
	const loadedModelId =
		ttsInfo?.status.loadedModel ??
		(ttsInfo?.status.state === "ready" ? ttsInfo.status.model : "");
	const modelId = model?.id ?? "";
	const modelMismatch = Boolean(
		ttsInfo?.status.state === "ready" &&
			modelId &&
			loadedModelId &&
			modelId !== loadedModelId,
	);
	return {
		voiceId,
		ready:
			ttsInfo?.status.state === "ready" &&
			Boolean(modelId && voiceId) &&
			!modelMismatch,
		modelMismatch,
	};
}

export function PronunciationsField({
	voice,
	onChange,
	ttsInfo,
}: {
	voice: VoiceConfig;
	onChange: (patch: Partial<VoiceConfig>) => void;
	ttsInfo?: TtsInfo;
}) {
	const nextDraftIdRef = useRef(0);
	const nextDraftId = useCallback(() => {
		nextDraftIdRef.current += 1;
		return `pronunciation-draft-${nextDraftIdRef.current}`;
	}, []);
	const [drafts, setDrafts] = useState<PronunciationDraft[]>(() =>
		voice.pronunciations.map((entry) => ({ ...entry, id: nextDraftId() })),
	);
	const preview = usePronunciationPreview();
	const previewSelection = neuralPreviewSelection(voice, ttsInfo);
	const { voiceId } = previewSelection;
	const previewReady = previewSelection.ready;
	const previewUnavailableMessage = previewSelection.modelMismatch
		? "The selected local neural model is not loaded. Resolve its model error before playing pronunciation previews."
		: ttsInfo?.status.state === "loading"
			? "Local neural speech is loading before pronunciation previews can play."
			: "Choose and load a local neural model before playing pronunciation previews.";
	const duplicateIndexes = useMemo(
		() => duplicateWrittenIndexes(drafts),
		[drafts],
	);
	const hasDuplicateDraft = duplicateIndexes.size > 0;
	const [testSentence, setTestSentence] = useState("");
	const previewSettingsRef = useRef({ voiceId, rate: voice.read_aloud_rate });
	useEffect(() => {
		const previous = previewSettingsRef.current;
		previewSettingsRef.current = { voiceId, rate: voice.read_aloud_rate };
		if (
			previous.voiceId !== voiceId ||
			previous.rate !== voice.read_aloud_rate
		) {
			preview.stop();
		}
	}, [preview.stop, voice.read_aloud_rate, voiceId]);
	useEffect(() => {
		setDrafts((current) =>
			voice.pronunciations.map((entry, index) => ({
				...entry,
				id: current[index]?.id ?? nextDraftId(),
			})),
		);
	}, [voice.pronunciations, nextDraftId]);

	const commit = (next: PronunciationDraft[]) => {
		if (!next.every(isComplete) || duplicateWrittenIndexes(next).size > 0) {
			return;
		}
		const normalizedDrafts = next.map((entry) => ({
			...entry,
			written: entry.written.trim(),
			spoken: entry.spoken.trim(),
		}));
		setDrafts(normalizedDrafts);
		onChange({ pronunciations: normalizedPronunciations(normalizedDrafts) });
	};
	const updateDraft = (
		index: number,
		field: keyof VoicePronunciation,
		value: string,
	) => {
		preview.stop();
		setDrafts((current) =>
			current.map((entry, candidate) =>
				candidate === index
					? {
							...entry,
							[field]: value.slice(0, MAX_VOICE_PRONUNCIATION_LENGTH),
						}
					: entry,
			),
		);
	};
	const addEntry = () => {
		if (
			drafts.length >= MAX_VOICE_PRONUNCIATIONS ||
			!drafts.every(isComplete) ||
			hasDuplicateDraft
		) {
			return;
		}
		preview.stop();
		const normalizedDrafts = drafts.map((entry) => ({
			...entry,
			written: entry.written.trim(),
			spoken: entry.spoken.trim(),
		}));
		setDrafts([
			...normalizedDrafts,
			{ id: nextDraftId(), written: "", spoken: "" },
		]);
	};
	const removeEntry = (index: number) => {
		preview.stop();
		const next = drafts
			.filter((_, candidate) => candidate !== index)
			.filter(isComplete)
			.map((entry) => ({
				...entry,
				written: entry.written.trim(),
				spoken: entry.spoken.trim(),
			}));
		setDrafts(next);
		onChange({ pronunciations: normalizedPronunciations(next) });
	};
	const hasIncompleteDraft = drafts.some((entry) => !isComplete(entry));
	const effectivePronunciations = useMemo(
		() => normalizedPronunciations(drafts),
		[drafts],
	);
	const testText = testSentence.trim();
	const spokenTestText = useMemo(
		() => applySpeechPronunciations(testText, effectivePronunciations),
		[testText, effectivePronunciations],
	);
	const testTextIsTooLong =
		spokenTestText.length > MAX_PRONUNCIATION_TEST_CHARS;
	const canTestSentence =
		previewReady &&
		Boolean(testText) &&
		!hasIncompleteDraft &&
		!hasDuplicateDraft &&
		!testTextIsTooLong;
	const sentenceIsActive = preview.activeTarget === "sentence";
	const playTestSentence = () => {
		if (sentenceIsActive) {
			preview.stop();
			return;
		}
		void preview.play(
			"sentence",
			spokenTestText,
			voiceId,
			voice.read_aloud_rate,
		);
	};

	return (
		<Field
			id="forge-setting-pronunciations"
			label="Pronunciations"
			hint="local neural only; enter how a written word should sound without changing the response or transcript"
		>
			<div className="w-full min-w-0 max-w-xl space-y-3">
				<div className="space-y-2">
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Your pronunciations
					</div>
					{drafts.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							No custom pronunciations yet.
						</p>
					) : (
						<div className="space-y-2">
							{drafts.map((entry, index) => {
								const readyToPreview =
									previewReady &&
									!hasDuplicateDraft &&
									Boolean(entry.spoken.trim());
								const isActive = preview.activeTarget === index;
								const isDuplicate = duplicateIndexes.has(index);
								const duplicateMessageId = `${entry.id}-duplicate`;
								return (
									<div
										key={entry.id}
										className={`grid min-w-0 gap-2 border bg-background/30 p-2 sm:grid-cols-2 ${
											isDuplicate ? "border-destructive/60" : "border-border/70"
										}`}
									>
										<label className="min-w-0 space-y-1">
											<span className="block text-[9px] tracking-widest text-muted-foreground uppercase">
												Written
											</span>
											<input
												type="text"
												value={entry.written}
												onChange={(event) =>
													updateDraft(index, "written", event.target.value)
												}
												onBlur={() => commit(drafts)}
												maxLength={MAX_VOICE_PRONUNCIATION_LENGTH}
												placeholder="Hlið"
												aria-label={`Written pronunciation ${index + 1}`}
												aria-invalid={isDuplicate || undefined}
												aria-describedby={
													isDuplicate ? duplicateMessageId : undefined
												}
												className="min-h-11 w-full min-w-0 border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none @lg:min-h-0"
											/>
											{isDuplicate && (
												<span
													id={duplicateMessageId}
													className="block text-[10px] text-destructive"
												>
													Duplicate written form
												</span>
											)}
										</label>
										<label className="min-w-0 space-y-1">
											<span className="block text-[9px] tracking-widest text-muted-foreground uppercase">
												Say as
											</span>
											<input
												type="text"
												value={entry.spoken}
												onChange={(event) =>
													updateDraft(index, "spoken", event.target.value)
												}
												onBlur={() => commit(drafts)}
												maxLength={MAX_VOICE_PRONUNCIATION_LENGTH}
												placeholder="hleeth"
												aria-label={`Say as pronunciation ${index + 1}`}
												className="min-h-11 w-full min-w-0 border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none @lg:min-h-0"
											/>
										</label>
										<div className="flex min-w-0 flex-wrap items-center gap-2 sm:col-span-2">
											<button
												type="button"
												onClick={() =>
													isActive
														? preview.stop()
														: void preview.play(
																index,
																entry.spoken.trim(),
																voiceId,
																voice.read_aloud_rate,
															)
												}
												disabled={
													!isActive &&
													(!readyToPreview || preview.phase !== "idle")
												}
												aria-label={
													isActive
														? `Stop pronunciation preview ${index + 1}`
														: `Preview pronunciation ${index + 1}`
												}
												className="min-h-11 border border-border px-3 py-1.5 text-[10px] tracking-widest uppercase disabled:opacity-40 @lg:min-h-0"
											>
												{isActive && preview.phase === "loading"
													? "Loading…"
													: isActive && preview.phase === "playing"
														? "Playing…"
														: "Play"}
											</button>
											<button
												type="button"
												onClick={() => removeEntry(index)}
												aria-label={`Remove pronunciation ${index + 1}`}
												className="min-h-11 border border-border px-3 py-1.5 text-[10px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground @lg:min-h-0"
											>
												Remove
											</button>
										</div>
									</div>
								);
							})}
						</div>
					)}
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={addEntry}
							disabled={
								drafts.length >= MAX_VOICE_PRONUNCIATIONS ||
								hasIncompleteDraft ||
								hasDuplicateDraft
							}
							className="min-h-11 border border-border px-3 py-1.5 text-[10px] tracking-widest uppercase disabled:opacity-40 @lg:min-h-0"
						>
							Add pronunciation
						</button>
						<span className="text-[10px] text-muted-foreground">
							{drafts.length}/{MAX_VOICE_PRONUNCIATIONS}
						</span>
					</div>
				</div>
				{hasIncompleteDraft && (
					<p className="text-[10px] text-muted-foreground" aria-live="polite">
						Enter both the written form and how it should sound.
					</p>
				)}
				{hasDuplicateDraft && (
					<p className="text-[10px] text-destructive" aria-live="polite">
						Written forms must be unique, ignoring capitalization.
					</p>
				)}
				{preview.error && (
					<p className="text-[10px] text-destructive" aria-live="polite">
						{preview.error}
					</p>
				)}
				{!previewReady && (
					<output className="text-[10px] text-muted-foreground">
						{previewUnavailableMessage}
					</output>
				)}
				<div className="space-y-2 border border-border/70 bg-background/30 p-3">
					<label
						htmlFor="pronunciation-test-sentence"
						className="block text-[9px] tracking-widest text-muted-foreground uppercase"
					>
						Test a sentence
					</label>
					<div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
						<input
							id="pronunciation-test-sentence"
							type="text"
							value={testSentence}
							onChange={(event) => {
								if (sentenceIsActive) preview.stop();
								setTestSentence(
									event.target.value.slice(0, MAX_PRONUNCIATION_TEST_CHARS),
								);
							}}
							maxLength={MAX_PRONUNCIATION_TEST_CHARS}
							placeholder="Open the live logs."
							aria-label="Pronunciation test sentence"
							className="min-h-11 w-full min-w-0 border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none @lg:min-h-0"
						/>
						<button
							type="button"
							onClick={playTestSentence}
							disabled={
								!sentenceIsActive &&
								(!canTestSentence || preview.phase !== "idle")
							}
							aria-label={
								sentenceIsActive
									? "Stop pronunciation test"
									: "Play pronunciation test"
							}
							className="min-h-11 shrink-0 border border-border px-3 py-1.5 text-[10px] tracking-widest uppercase disabled:opacity-40 @lg:min-h-0"
						>
							{sentenceIsActive && preview.phase === "loading"
								? "Loading…"
								: sentenceIsActive && preview.phase === "playing"
									? "Playing…"
									: "Play"}
						</button>
					</div>
					{testText && (
						<p className="max-h-24 overflow-y-auto break-words border border-border/50 p-2 font-mono text-[10px] text-foreground [overflow-wrap:anywhere]">
							<span className="font-sans tracking-widest text-muted-foreground uppercase">
								Text sent to voice:
							</span>{" "}
							{spokenTestText}
						</p>
					)}
					{testTextIsTooLong && (
						<p className="text-[10px] text-destructive" aria-live="polite">
							The effective sentence is {spokenTestText.length} characters.
							Shorten it to {MAX_PRONUNCIATION_TEST_CHARS} or fewer before
							playing.
						</p>
					)}
					<p className="text-[10px] text-muted-foreground">
						Uses the selected local neural voice, speed, and your
						pronunciations. The transcript is unchanged.
					</p>
				</div>
			</div>
		</Field>
	);
}
