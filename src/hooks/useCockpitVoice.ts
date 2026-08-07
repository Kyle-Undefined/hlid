import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useRef,
} from "react";
import type { HlidConfig } from "#/config";
import { useCodexRealtime } from "#/hooks/codexRealtimeStore";
import type { UseFileUploadReturn } from "#/hooks/useFileUpload";
import { uploadVoiceRecording, useVoiceInput } from "#/hooks/useVoiceInput";
import { insertAtSelection } from "#/lib/composer";
import type { ModelInputAvailability } from "#/lib/providerOptions";
import { codexRealtimeAvailability } from "#/lib/providerOptions";
import type { ProviderInfo } from "#/lib/providerTypes";
import type { VoiceInfo } from "#/lib/serverFns/voice";
import { uid } from "#/lib/utils";
import type { ChatAttachment } from "#/server/protocol";

type CockpitVoiceComposer = {
	prompt: string;
	setPrompt: Dispatch<SetStateAction<string>>;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	selectedAgentPath: string;
};

type CockpitVoiceUpload = Pick<UseFileUploadReturn, "uploadSessionIdRef">;

export function useCockpitVoice(
	config: HlidConfig,
	initialVoiceInfo: VoiceInfo,
	composer: CockpitVoiceComposer,
	upload: CockpitVoiceUpload,
	providerId: string,
	codexProvider: ProviderInfo | undefined,
	codexAudio: ModelInputAvailability,
	handleRun: (
		overrideText?: string,
		overrideAttachments?: ChatAttachment[],
	) => Promise<void>,
) {
	const { prompt, setPrompt, textareaRef } = composer;
	const onTranscription = useCallback(
		(text: string) => {
			if (config.voice.auto_send) {
				void handleRun(text);
				return;
			}
			const el = textareaRef.current;
			const start = el?.selectionStart ?? prompt.length;
			const end = el?.selectionEnd ?? prompt.length;
			setPrompt(insertAtSelection(prompt, text, start, end));
			requestAnimationFrame(() => textareaRef.current?.focus());
		},
		[config.voice.auto_send, handleRun, prompt, setPrompt, textareaRef],
	);
	const dictationContextKey = `${providerId}\0${composer.selectedAgentPath}`;
	const dictationSessionRef = useRef({
		contextKey: dictationContextKey,
		sessionId: uid(),
	});
	if (dictationSessionRef.current.contextKey !== dictationContextKey) {
		dictationSessionRef.current = {
			contextKey: dictationContextKey,
			sessionId: uid(),
		};
	}
	const dictationSessionId = dictationSessionRef.current.sessionId;
	const realtime = useCodexRealtime({
		sessionId: dictationSessionId,
		agentCwd: composer.selectedAgentPath,
		providerId,
		voice: config.voice.codex_voice,
		onDictation: onTranscription,
	});
	const configuredDictation =
		providerId === "codex"
			? codexRealtimeAvailability(
					config.voice.codex_live_mode,
					codexProvider,
					initialVoiceInfo.codexRealtimeBackend,
				)
			: {
					available: false,
					reason: "Dictate with Codex requires the native Codex provider.",
				};
	const realtimeDictationActive = realtime.mode === "dictation";
	return useVoiceInput({
		config: config.voice,
		initialInfo: initialVoiceInfo,
		onTranscription,
		onAudioTurn: async (audio) => {
			if (providerId !== "codex") {
				throw new Error("Talk to Codex requires the native Codex provider");
			}
			const sessionId = upload.uploadSessionIdRef.current ?? uid();
			upload.uploadSessionIdRef.current = sessionId;
			const attachment = await uploadVoiceRecording(audio, {
				sessionId,
				agentCwd: composer.selectedAgentPath,
			});
			await handleRun("Voice message", [attachment]);
		},
		codexTurnAvailable: providerId === "codex" && codexAudio.available,
		codexTurnUnavailableReason: codexAudio.reason,
		codexDictation: {
			available: configuredDictation.available && !realtime.unavailableReason,
			unavailableReason:
				realtime.unavailableReason ??
				(configuredDictation.available
					? undefined
					: configuredDictation.reason),
			phase: realtimeDictationActive ? realtime.phase : "idle",
			error: realtimeDictationActive ? realtime.error : null,
			start: () => realtime.start("dictation"),
			stop: realtime.stop,
			cancel: realtime.cancel,
			clearError: realtime.clearError,
		},
	});
}
