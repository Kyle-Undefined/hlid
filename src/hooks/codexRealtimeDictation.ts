type DictationTranscriptMessage = {
	role: string;
	text: string;
	done: boolean;
};

type DictationLifecycleOptions = {
	isActive: () => boolean;
	isNativeStopRequested: () => boolean;
	isInputStopped: () => boolean;
	muteInput: () => void;
	stopInput: () => void;
	requestNativeStop: () => void;
	onTranscript: (text: string) => void;
	onStopping: () => void;
	onFinished: (text: string) => void;
	onFail: (message: string) => void;
};

export type CodexDictationLifecycle = {
	beginDrain: () => void;
	beforeNativeStop: () => void;
	cancel: () => void;
	dispose: () => void;
	handleClosed: () => void;
	handleTranscript: (message: DictationTranscriptMessage) => void;
	isDraining: () => boolean;
	isSettled: () => boolean;
	onInputReady: () => void;
};

const STOP_TIMEOUT_MS = 15_000;
const INPUT_DRAIN_GRACE_MS = 750;
const NATIVE_STOP_FALLBACK_MS = 8_000;
const CLOSE_TAIL_GRACE_MS = 1_000;

function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function createCodexDictationLifecycle(
	options: DictationLifecycleOptions,
): CodexDictationLifecycle {
	const segments: string[] = [];
	let draft = "";
	let settled = false;
	let closed = false;
	let draining = false;
	let stopTimer: ReturnType<typeof setTimeout> | undefined;
	let nativeStopTimer: ReturnType<typeof setTimeout> | undefined;
	let inputStopTimer: ReturnType<typeof setTimeout> | undefined;

	const finalizedText = () => normalizeText(segments.join(" "));
	const visibleText = () =>
		normalizeText([finalizedText(), draft].filter(Boolean).join(" "));
	const promoteDraft = () => {
		const promoted = normalizeText(draft);
		draft = "";
		if (promoted) segments.push(promoted);
	};
	const finish = () => {
		if (!options.isActive() || settled) return;
		const text = finalizedText();
		if (!text) {
			options.onFail("Codex dictation ended without a transcript.");
			return;
		}
		settled = true;
		options.onFinished(text);
	};
	const scheduleStopTimeout = () => {
		if (!options.isActive() || stopTimer !== undefined) return;
		stopTimer = setTimeout(() => {
			stopTimer = undefined;
			if (!options.isActive() || settled) return;
			options.onFail(
				visibleText()
					? "Codex dictation did not finish closing after transcription."
					: "Codex dictation did not return a transcript before timing out.",
			);
		}, STOP_TIMEOUT_MS);
	};
	const scheduleCloseTailGrace = () => {
		if (!options.isActive()) return;
		if (stopTimer !== undefined) clearTimeout(stopTimer);
		stopTimer = setTimeout(() => {
			stopTimer = undefined;
			if (!options.isActive() || settled) return;
			promoteDraft();
			if (finalizedText()) {
				finish();
				return;
			}
			options.onFail("Codex dictation ended without a transcript.");
		}, CLOSE_TAIL_GRACE_MS);
	};
	const scheduleNativeStop = () => {
		if (
			!options.isActive() ||
			options.isNativeStopRequested() ||
			nativeStopTimer !== undefined
		) {
			return;
		}
		nativeStopTimer = setTimeout(() => {
			nativeStopTimer = undefined;
			if (!options.isActive() || settled) return;
			options.requestNativeStop();
		}, NATIVE_STOP_FALLBACK_MS);
	};
	const scheduleInputStop = () => {
		if (
			!options.isActive() ||
			options.isInputStopped() ||
			inputStopTimer !== undefined
		) {
			return;
		}
		inputStopTimer = setTimeout(() => {
			inputStopTimer = undefined;
			if (options.isActive() && !settled) options.stopInput();
		}, INPUT_DRAIN_GRACE_MS);
	};

	return {
		beginDrain: () => {
			if (draining) return;
			draining = true;
			options.muteInput();
			options.onStopping();
			scheduleStopTimeout();
			scheduleInputStop();
			scheduleNativeStop();
		},
		beforeNativeStop: () => {
			if (nativeStopTimer === undefined) return;
			clearTimeout(nativeStopTimer);
			nativeStopTimer = undefined;
		},
		cancel: () => {
			settled = true;
		},
		dispose: () => {
			for (const timer of [stopTimer, nativeStopTimer, inputStopTimer]) {
				if (timer !== undefined) clearTimeout(timer);
			}
		},
		handleClosed: () => {
			if (!options.isActive()) return;
			closed = true;
			promoteDraft();
			if (finalizedText()) {
				finish();
				return;
			}
			options.onStopping();
			scheduleCloseTailGrace();
		},
		handleTranscript: (message) => {
			if (message.role === "assistant") return;
			if (!message.done) {
				draft = `${draft}${message.text}`;
				options.onTranscript(visibleText());
				return;
			}
			const segment = normalizeText(message.text || draft || "");
			draft = "";
			if (segment) segments.push(segment);
			options.onTranscript(finalizedText());
			if (draining) options.requestNativeStop();
			if (closed && segment) finish();
		},
		isDraining: () => draining,
		isSettled: () => settled,
		onInputReady: () => {
			if (draining) options.muteInput();
		},
	};
}
