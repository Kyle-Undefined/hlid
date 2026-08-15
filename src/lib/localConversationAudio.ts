export { voiceAudioToWav as localConversationAudioToWav } from "./voiceAudio";

import { readVoiceTranscriptionResponse } from "./voiceTranscription";

export type LocalConversationVadConfig = {
	/** Root-mean-square signal level required to count as speech. */
	threshold: number;
	/** Speech must remain above the threshold for this long before capture starts. */
	speechStartMs: number;
	/** Capture closes after the signal remains below the threshold for this long. */
	silenceMs: number;
};

export const DEFAULT_LOCAL_CONVERSATION_VAD: LocalConversationVadConfig = {
	threshold: 0.025,
	speechStartMs: 80,
	silenceMs: 800,
};

export type LocalConversationVadBoundary = "start" | "stop" | null;

/**
 * Small stateful energy detector. It intentionally owns no browser resources so
 * its timing and reset behavior stay deterministic and independently testable.
 */
export class LocalConversationVadDetector {
	readonly config: LocalConversationVadConfig;
	private speechSince: number | null = null;
	private silenceSince: number | null = null;
	private capturing = false;

	constructor(config: Partial<LocalConversationVadConfig> = {}) {
		this.config = {
			threshold: Math.max(
				0,
				config.threshold ?? DEFAULT_LOCAL_CONVERSATION_VAD.threshold,
			),
			speechStartMs: Math.max(
				0,
				config.speechStartMs ?? DEFAULT_LOCAL_CONVERSATION_VAD.speechStartMs,
			),
			silenceMs: Math.max(
				0,
				config.silenceMs ?? DEFAULT_LOCAL_CONVERSATION_VAD.silenceMs,
			),
		};
	}

	// fallow-ignore-next-line unused-class-member -- Called by the persistent microphone animation-frame loop in useLocalConversationMic.
	observe(level: number, nowMs: number): LocalConversationVadBoundary {
		const speech = level >= this.config.threshold;
		if (!this.capturing) {
			if (!speech) {
				this.speechSince = null;
				return null;
			}
			this.speechSince ??= nowMs;
			if (nowMs - this.speechSince < this.config.speechStartMs) return null;
			this.capturing = true;
			this.silenceSince = null;
			return "start";
		}

		if (speech) {
			this.silenceSince = null;
			return null;
		}
		this.silenceSince ??= nowMs;
		if (nowMs - this.silenceSince < this.config.silenceMs) return null;
		this.reset();
		return "stop";
	}

	reset(): void {
		this.speechSince = null;
		this.silenceSince = null;
		this.capturing = false;
	}
}

export function calculateAudioRms(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (const sample of samples) sum += sample * sample;
	return Math.sqrt(sum / samples.length);
}

export async function transcribeLocalConversationAudio(
	audio: Blob,
	language: string,
	signal: AbortSignal,
): Promise<string> {
	const form = new FormData();
	form.set("audio", audio, "recording.wav");
	form.set("language", language);
	const response = await fetch("/api/voice/transcribe", {
		method: "POST",
		body: form,
		signal,
	});
	return (await readVoiceTranscriptionResponse(response)).text;
}
