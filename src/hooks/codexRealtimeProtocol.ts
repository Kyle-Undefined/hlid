import type { ServerMessage } from "#/server/protocol";

export type CorrelatedRealtimeMessage = Extract<
	ServerMessage,
	{
		type:
			| "realtime_state"
			| "realtime_sdp"
			| "realtime_audio"
			| "realtime_transcript"
			| "realtime_error";
	}
>;

type RealtimeCorrelation = {
	sessionId: string;
	requestId: string;
	mode: CorrelatedRealtimeMessage["mode"];
};

export function matchRealtimeMessage(
	message: ServerMessage,
	correlation: RealtimeCorrelation,
): CorrelatedRealtimeMessage | null {
	if (
		message.type !== "realtime_state" &&
		message.type !== "realtime_sdp" &&
		message.type !== "realtime_audio" &&
		message.type !== "realtime_transcript" &&
		message.type !== "realtime_error"
	) {
		return null;
	}
	return message.session_id === correlation.sessionId &&
		message.mode === correlation.mode &&
		(message.request_id === undefined ||
			message.request_id === correlation.requestId)
		? message
		: null;
}

export type RealtimeDataEvent = {
	type: string;
	sessionId: string | null;
	role: "user" | "assistant" | null;
};

export function parseRealtimeDataEvent(
	data: unknown,
): RealtimeDataEvent | null {
	if (typeof data !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(data);
		if (!parsed || typeof parsed !== "object") return null;
		const message = parsed as {
			type?: unknown;
			session?: { id?: unknown };
			role?: unknown;
			turn?: { role?: unknown };
		};
		if (typeof message.type !== "string") return null;
		const candidateRole =
			message.type === "turn.done"
				? (message.turn?.role ?? message.role)
				: (message.role ?? message.turn?.role);
		return {
			type: message.type,
			sessionId:
				typeof message.session?.id === "string" && message.session.id
					? message.session.id
					: null,
			role:
				candidateRole === "user" || candidateRole === "assistant"
					? candidateRole
					: null,
		};
	} catch {
		return null;
	}
}
