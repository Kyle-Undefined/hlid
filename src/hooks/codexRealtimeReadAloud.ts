import type { RealtimeDataEvent } from "./codexRealtimeProtocol";
import type { CodexRealtimeTransport } from "./codexRealtimeTransport";

export type ReadAloudCallbacks = {
	onPlaying: () => void;
	onEnded: () => void;
	onError: (message: string) => void;
};

type ReadAloudSpeakMessage = {
	type: "realtime_speak";
	session_id: string;
	request_id: string;
	mode: "read-aloud";
	text: string;
};

type ReadAloudLifecycleOptions = {
	transport: CodexRealtimeTransport;
	sessionId: string;
	requestId: string;
	speech: string;
	callbacks: ReadAloudCallbacks;
	isActive: () => boolean;
	isStopped: () => boolean;
	send: (message: ReadAloudSpeakMessage) => boolean;
	onFail: (message: string, requestNativeStop?: boolean) => void;
	onFinished: () => void;
};

export type CodexReadAloudLifecycle = {
	dispose: () => void;
	handleAudioError: () => void;
	handleAudioPlaying: () => void;
	handleDataEvent: (message: RealtimeDataEvent | null) => void;
	handleRemoteTrack: (track: MediaStreamTrack, stream: MediaStream) => void;
	handleUnexpectedClose: () => boolean;
	isSettled: () => boolean;
	markOutputStarted: () => void;
	markTranscriptDone: (role: string) => void;
	reportFailure: (message: string) => void;
	scheduleReadyTimeout: () => void;
	sendPendingSpeech: () => void;
};

const OUTPUT_START_TIMEOUT_MS = 12_000;
const PLAYBACK_START_TIMEOUT_MS = 5_000;
const OUTPUT_STOP_GRACE_MS = 1_000;
const PLAYOUT_FALLBACK_MIN_MS = 3_000;
const PLAYOUT_FALLBACK_MAX_MS = 60_000;
const READY_TIMEOUT_MS = 8_000;

export function createCodexReadAloudLifecycle(
	options: ReadAloudLifecycleOptions,
): CodexReadAloudLifecycle {
	const { transport } = options;
	let pendingSpeech: string | undefined = options.speech;
	const wordCount = options.speech.trim().split(/\s+/).filter(Boolean).length;
	let remoteAudioTrack: MediaStreamTrack | undefined;
	let remoteAudioUnmuteHandler: (() => void) | undefined;
	let remoteAudioUnmuted: boolean | undefined;
	let remoteAudioStream: MediaStream | undefined;
	let speechSent = false;
	let playingNotified = false;
	let settled = false;
	let audioPlaying = false;
	let audioDrained = false;
	let outputAudioStarted = false;
	let outputAudioStartedAt: number | undefined;
	let outputStartTimer: ReturnType<typeof setTimeout> | undefined;
	let playbackCompletionTimer: ReturnType<typeof setTimeout> | undefined;
	let outputStoppedTimer: ReturnType<typeof setTimeout> | undefined;
	let playbackStartTimer: ReturnType<typeof setTimeout> | undefined;
	let readyTimer: ReturnType<typeof setTimeout> | undefined;

	const finish = () => {
		if (!options.isActive() || options.isStopped() || settled) return;
		settled = true;
		options.callbacks.onEnded();
		options.onFinished();
	};

	const fallbackPlayoutWaitMs = () => {
		const estimatedSpeechMs = Math.max(1, wordCount) * 500 + 2_000;
		const elapsed = outputAudioStartedAt
			? Date.now() - outputAudioStartedAt
			: 0;
		return Math.min(
			PLAYOUT_FALLBACK_MAX_MS,
			Math.max(PLAYOUT_FALLBACK_MIN_MS, estimatedSpeechMs - elapsed),
		);
	};

	const schedulePlaybackCompletionFallback = () => {
		if (!options.isActive() || options.isStopped()) return;
		if (playbackCompletionTimer !== undefined) return;
		playbackCompletionTimer = setTimeout(() => {
			playbackCompletionTimer = undefined;
			finish();
		}, fallbackPlayoutWaitMs());
	};

	const scheduleOutputStoppedCompletion = () => {
		if (
			!options.isActive() ||
			options.isStopped() ||
			outputStoppedTimer !== undefined
		) {
			return;
		}
		outputStoppedTimer = setTimeout(() => {
			outputStoppedTimer = undefined;
			finish();
		}, OUTPUT_STOP_GRACE_MS);
	};

	const scheduleDrained = () => {
		if (
			!options.isActive() ||
			!audioDrained ||
			!outputAudioStarted ||
			!remoteAudioUnmuted ||
			options.isStopped()
		) {
			return;
		}
		if (!audioPlaying) {
			if (playbackStartTimer !== undefined) return;
			playbackStartTimer = setTimeout(() => {
				playbackStartTimer = undefined;
				if (options.isActive() && !audioPlaying) {
					options.onFail("Codex read aloud did not start playing.");
				}
			}, PLAYBACK_START_TIMEOUT_MS);
			return;
		}
		if (playbackStartTimer !== undefined) {
			clearTimeout(playbackStartTimer);
			playbackStartTimer = undefined;
		}
		scheduleOutputStoppedCompletion();
	};

	const notifyPlaying = () => {
		if (
			!options.isActive() ||
			!audioPlaying ||
			!remoteAudioUnmuted ||
			!speechSent ||
			!outputAudioStarted ||
			playingNotified
		) {
			return;
		}
		playingNotified = true;
		options.callbacks.onPlaying();
		// A bounded fallback keeps a lost terminal event from leaving Stop visible.
		schedulePlaybackCompletionFallback();
	};

	const markOutputStarted = () => {
		if (!options.isActive() || !speechSent) return;
		outputAudioStarted = true;
		outputAudioStartedAt ??= Date.now();
		if (outputStartTimer !== undefined) {
			clearTimeout(outputStartTimer);
			outputStartTimer = undefined;
		}
		notifyPlaying();
		if (
			(!audioPlaying || !remoteAudioUnmuted) &&
			playbackStartTimer === undefined
		) {
			playbackStartTimer = setTimeout(() => {
				playbackStartTimer = undefined;
				if (options.isActive() && (!audioPlaying || !remoteAudioUnmuted)) {
					options.onFail("Codex read aloud did not start playing.");
				}
			}, PLAYBACK_START_TIMEOUT_MS);
		}
		scheduleDrained();
	};

	const markDrained = () => {
		audioDrained = true;
		scheduleDrained();
	};

	return {
		dispose: () => {
			for (const timer of [
				playbackCompletionTimer,
				outputStoppedTimer,
				playbackStartTimer,
				outputStartTimer,
				readyTimer,
			]) {
				if (timer !== undefined) clearTimeout(timer);
			}
			if (remoteAudioTrack && remoteAudioUnmuteHandler) {
				remoteAudioTrack.removeEventListener(
					"unmute",
					remoteAudioUnmuteHandler,
				);
			}
			remoteAudioTrack = undefined;
			remoteAudioUnmuteHandler = undefined;
			remoteAudioUnmuted = undefined;
			remoteAudioStream = undefined;
		},
		handleAudioError: () => {
			if (options.isActive()) {
				options.onFail("Codex read aloud playback failed.");
			}
		},
		handleAudioPlaying: () => {
			if (
				!options.isActive() ||
				!remoteAudioStream ||
				transport.audio.srcObject !== remoteAudioStream
			) {
				return;
			}
			audioPlaying = true;
			notifyPlaying();
			scheduleDrained();
		},
		handleDataEvent: (message) => {
			const type = message?.type ?? null;
			if (
				(type === "output_audio.delta" ||
					type === "output_audio_buffer.started") &&
				speechSent
			) {
				markOutputStarted();
				return;
			}
			if (type === "turn.done" && message?.role === "assistant" && speechSent) {
				markDrained();
				return;
			}
			if (type === "output_audio_buffer.stopped" && speechSent) markDrained();
		},
		handleRemoteTrack: (track, stream) => {
			if (!options.isActive()) return;
			if (remoteAudioTrack && remoteAudioUnmuteHandler) {
				remoteAudioTrack.removeEventListener(
					"unmute",
					remoteAudioUnmuteHandler,
				);
			}
			const onUnmute = () => {
				remoteAudioUnmuted = true;
				markOutputStarted();
			};
			remoteAudioTrack = track;
			remoteAudioUnmuteHandler = onUnmute;
			remoteAudioUnmuted = !track.muted;
			track.addEventListener("unmute", onUnmute);
			transport.audio.pause();
			audioPlaying = false;
			remoteAudioStream = stream;
			transport.audio.muted = false;
			transport.audio.volume = 1;
			transport.audio.srcObject = stream;
			void transport.audio.play().catch((error) => {
				if (!options.isActive()) return;
				options.onFail(
					error instanceof Error
						? `Codex read aloud playback failed: ${error.message}`
						: "Codex read aloud playback failed.",
				);
			});
			if (remoteAudioUnmuted) markOutputStarted();
		},
		handleUnexpectedClose: () => {
			if (options.isStopped() || settled) return false;
			options.onFail(
				"Codex read aloud ended before playback completed.",
				false,
			);
			return true;
		},
		isSettled: () => settled,
		markOutputStarted,
		markTranscriptDone: (role) => {
			if (role === "assistant") markDrained();
		},
		reportFailure: (message) => {
			if (settled) return;
			settled = true;
			options.callbacks.onError(message);
		},
		scheduleReadyTimeout: () => {
			if (
				!options.isActive() ||
				options.isStopped() ||
				speechSent ||
				readyTimer !== undefined
			) {
				return;
			}
			readyTimer = setTimeout(() => {
				readyTimer = undefined;
				if (options.isActive() && !speechSent) {
					options.onFail("Codex read aloud did not become ready.");
				}
			}, READY_TIMEOUT_MS);
		},
		sendPendingSpeech: () => {
			if (!options.isActive() || options.isStopped() || !pendingSpeech) return;
			const accepted = options.send({
				type: "realtime_speak",
				session_id: options.sessionId,
				request_id: options.requestId,
				mode: "read-aloud",
				text: pendingSpeech,
			});
			if (!accepted) {
				options.onFail("Codex read aloud lost its Hlid connection.");
				return;
			}
			pendingSpeech = undefined;
			speechSent = true;
			audioDrained = false;
			outputAudioStarted = false;
			notifyPlaying();
			outputStartTimer = setTimeout(() => {
				outputStartTimer = undefined;
				if (options.isActive() && !outputAudioStarted) {
					options.onFail("Codex read aloud did not start producing audio.");
				}
			}, OUTPUT_START_TIMEOUT_MS);
			if (readyTimer !== undefined) {
				clearTimeout(readyTimer);
				readyTimer = undefined;
			}
		},
	};
}
