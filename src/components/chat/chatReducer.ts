import type { ToolEventPageMeta } from "#/db";
import { orderSteeredTranscript } from "#/lib/steeredTranscript";
import type {
	AskQuestion,
	AskUserQuestionAnswers,
	AskUserQuestionNotes,
	AskUserQuestionProvenance,
	ChatAttachment,
	PermissionDecision,
	PermissionRequestMessage,
	ToolEventMessage,
} from "#/server/protocol";

export type UserMessage = {
	id: string;
	role: "user";
	text: string;
	attachments?: ChatAttachment[];
	/** Persisted transcript sequence, available after history hydration. */
	transcriptSeq?: number;
	/** Whether Hlid retained an inspectable context receipt for this turn. */
	hasContextReceipt?: boolean;
	/** Claude captured a provider-native file checkpoint for this turn. */
	hasFileCheckpoint?: boolean;
	/** Assistant transcript sequence this prompt steered. */
	steerTargetSeq?: number;
	/** Live target correlation used until history can hydrate by sequence. */
	steerTargetTurnId?: string;
	/**
	 * Number of raw tool events already present when the provider accepted this
	 * steer. Tools before this boundary render above the receipt; later tools
	 * resume below it.
	 */
	steerToolEventIndex?: number;
};

export type AssistantMessage = {
	id: string;
	role: "assistant";
	/** User turn that opened this live assistant response. */
	turnId?: string;
	text: string;
	toolEvents: ToolEventMessage[];
	/** Bounded historical suffix metadata; omitted for live or specialized responses. */
	toolEventPage?: ToolEventPageMeta;
	streaming: boolean;
	cost: number | null;
	costEstimated?: boolean;
	recap?: string;
	/** Persisted transcript sequence, available after history hydration. */
	transcriptSeq?: number;
	/**
	 * messages.id primary key, once persisted — undefined for messages still
	 * arriving live before the DB row is confirmed. Lets Raven offer "branch
	 * from here" only on rows the fork API can actually resolve.
	 */
	dbId?: number;
};

export type PermissionMessage = {
	id: string;
	role: "permission";
	toolName: string;
	title: string;
	displayName?: string;
	description?: string;
	input?: Record<string, unknown>;
	requester?: PermissionRequestMessage["requester"];
	policy?: PermissionRequestMessage["policy"];
	allowOnce?: boolean;
	allowAlways?: boolean;
	decision: "pending" | PermissionDecision;
};

export type AskUserQuestionChatMessage = {
	id: string;
	role: "ask_user_question";
	questions: AskQuestion[];
	provenance?: AskUserQuestionProvenance;
	/** null = unanswered; map keyed by question text, values arrays for multiSelect */
	answers: AskUserQuestionAnswers | null;
	/** Free-text notes the user attached per question, keyed by question text. */
	notes?: AskUserQuestionNotes;
};

export type PlanProposalDecision =
	| "pending"
	| "approved"
	| "edited"
	| "cancelled";

export type PlanProposalMessage = {
	id: string;
	role: "plan_proposal";
	plan: string;
	decision: PlanProposalDecision;
	/** Attachment id of the HTML plan relic, when the agent rendered one. */
	htmlRelicId?: string;
};

export type LocalCommandOutputChatMessage = {
	id: string;
	role: "local_command_output";
	content: string;
};

export type ChatMessage =
	| UserMessage
	| AssistantMessage
	| PermissionMessage
	| AskUserQuestionChatMessage
	| PlanProposalMessage
	| LocalCommandOutputChatMessage;

export type LoadEarlierToolEvents = (
	responseId: string,
	assistantSeq: number,
	beforeId: number,
) => Promise<number>;

export type HistoryItem =
	| {
			kind: "message";
			id: string;
			/** messages.id primary key. See AssistantMessage.dbId. */
			dbId?: number;
			role: string;
			text: string;
			seq?: number;
			hasContextReceipt?: boolean;
			hasFileCheckpoint?: boolean;
			steerTargetSeq?: number | null;
			steerToolEventIndex?: number | null;
			/** Resolved display cost restored from the linked usage query. */
			cost?: number | null;
			costEstimated?: boolean;
			toolEvents?: ToolEventMessage[];
			toolEventPage?: ToolEventPageMeta;
			attachments?: ChatAttachment[];
			recap?: string | null;
	  }
	| {
			kind: "permission";
			tool_id: string;
			tool_name: string;
			display_name: string | null;
			decision: string;
	  }
	| {
			kind: "plan_proposal";
			id: string;
			plan: string;
			decision: string;
			html_attachment_id?: string | null;
	  }
	| {
			kind: "ask_user_question";
			id: string;
			questions: AskQuestion[];
			provenance?: AskUserQuestionProvenance;
			answers: AskUserQuestionAnswers | null;
			notes?: AskUserQuestionNotes;
	  };

export type Action =
	| {
			type: "ADD_USER";
			id: string;
			text: string;
			attachments?: ChatAttachment[];
	  }
	| { type: "MARK_USER_CONTEXT_RECEIPT"; id: string }
	| { type: "MARK_USER_FILE_CHECKPOINT"; id: string }
	| { type: "REMOVE_USER"; id: string }
	| {
			/**
			 * Slice C polish: move the promoted user msg to position right
			 * before the first OTHER still-pending user msg, so live transcript
			 * order matches server processing order (and DB / refresh).
			 */
			type: "PROMOTE_USER";
			turnId: string;
			pendingTurnIds: string[];
	  }
	| {
			/** Correlate an accepted steer with the exact response it redirected. */
			type: "STEER_USER";
			turnId: string;
			/** Exact originating turn supplied by the server. */
			targetTurnId?: string;
			/** Exact persisted assistant row supplied by the server. */
			targetAssistantSeq?: number;
			/** Persisted sequence of the accepted steering prompt. */
			steerSeq?: number;
			/** Raw tool-event boundary captured when the provider accepted it. */
			steerToolEventIndex?: number;
			/** Compatibility fallback for acknowledgements without a target turn. */
			assistantId?: string;
	  }
	| {
			type: "ADD_ASSISTANT";
			id: string;
			/**
			 * Slice C: when set, insert the assistant placeholder right after
			 * the matching user msg (correlated by user msg id = turn_id).
			 * Without this, multiple queued user msgs would show ADD_ASSISTANT
			 * placeholders all appended at the end, making the transcript
			 * order user/user/user/assistant/assistant/assistant rather than
			 * user/assistant/user/assistant/user/assistant.
			 */
			afterUserId?: string;
	  }
	| {
			/** Correlate a restored in-flight assistant with its running turn. */
			type: "SET_ASSISTANT_TURN";
			id: string;
			turnId: string;
	  }
	| { type: "RESUME_ASSISTANT"; id: string }
	| { type: "APPEND_CHUNK"; id: string; text: string; offset?: number }
	| { type: "REPLACE_TEXT"; id: string; text: string }
	| { type: "ADD_TOOL_EVENT"; id: string; event: ToolEventMessage }
	| {
			type: "UPDATE_TOOL_EVENT";
			toolUseId: string;
			subagent: NonNullable<ToolEventMessage["subagent"]>;
	  }
	| {
			type: "UPDATE_TOOL_ACTIVITY";
			toolUseId: string;
			taskActivity: NonNullable<ToolEventMessage["taskActivity"]>;
	  }
	| {
			type: "ADD_TOOL_RESULT";
			toolUseId: string;
			content: string;
			resultTruncated?: boolean;
			resultLength?: number;
			detailSessionId?: string;
			isError?: boolean;
	  }
	| {
			type: "PREPEND_TOOL_EVENT_PAGE";
			id: string;
			/** Ignore a response that raced a newer page or reconnect snapshot. */
			expectedBeforeId: number;
			events: ToolEventMessage[];
			page: ToolEventPageMeta;
	  }
	| {
			type: "SETTLE_ACTIVE_SUBAGENTS";
			endedAtMs: number;
	  }
	| {
			type: "ADD_PLAN_PROPOSAL";
			id: string;
			plan: string;
			htmlRelicId?: string;
	  }
	| {
			type: "RESOLVE_PLAN_PROPOSAL";
			id: string;
			decision: Exclude<PlanProposalDecision, "pending">;
	  }
	| { type: "ADD_LOCAL_COMMAND_OUTPUT"; id: string; content: string }
	| {
			type: "DONE";
			id: string;
			cost: number | null;
			costEstimated?: boolean;
			/** messages.id primary key — lets this row offer "branch from here" immediately. */
			dbId?: number;
	  }
	| { type: "SET_RECAP"; id: string; recap: string }
	| { type: "ADD_PERMISSION"; msg: PermissionRequestMessage }
	| {
			type: "RESOLVE_PERMISSION";
			id: string;
			decision: PermissionDecision;
	  }
	| {
			type: "RESOLVE_OR_ADD_PERMISSION";
			id: string;
			toolName: string;
			displayName?: string;
			decision: PermissionDecision;
	  }
	| {
			type: "LOAD_HISTORY";
			items: HistoryItem[];
			/** Reconnect snapshots retain already-revealed immutable tool prefixes. */
			preserveToolEventPages?: boolean;
	  }
	| {
			type: "PREPEND_HISTORY";
			items: HistoryItem[];
	  }
	| {
			/** Add optional persisted cards after the base transcript is visible. */
			type: "HYDRATE_HISTORY";
			items: HistoryItem[];
	  }
	| {
			type: "ADD_ASK_USER_QUESTION";
			id: string;
			questions: AskQuestion[];
			provenance?: AskUserQuestionProvenance;
	  }
	| {
			type: "RESOLVE_ASK_USER_QUESTION";
			id: string;
			answers: AskUserQuestionAnswers;
			notes?: AskUserQuestionNotes;
	  }
	| { type: "CLEAR" };

const VALID_PERMISSION_DECISIONS = new Set<PermissionMessage["decision"]>([
	"pending",
	"approved",
	"approved_session",
	"approved_always",
	"denied",
]);
const VALID_PLAN_DECISIONS = new Set<PlanProposalDecision>([
	"pending",
	"approved",
	"edited",
	"cancelled",
]);

function promoteUser(
	state: ChatMessage[],
	turnId: string,
	pendingTurnIds: string[],
): ChatMessage[] {
	const promotedIdx = state.findIndex(
		(message) => message.id === turnId && message.role === "user",
	);
	if (promotedIdx === -1) return state;
	const targetIdx = state.findIndex(
		(message) =>
			message.role === "user" &&
			message.id !== turnId &&
			pendingTurnIds.includes(message.id),
	);
	if (targetIdx === -1 || targetIdx >= promotedIdx) return state;
	const promoted = state[promotedIdx];
	const without = [
		...state.slice(0, promotedIdx),
		...state.slice(promotedIdx + 1),
	];
	return [
		...without.slice(0, targetIdx),
		promoted,
		...without.slice(targetIdx),
	];
}

function steerUser(
	state: ChatMessage[],
	turnId: string,
	targetTurnId?: string,
	targetAssistantSeq?: number,
	steerSeq?: number,
	steerToolEventIndex?: number,
	assistantId?: string,
): ChatMessage[] {
	const userIdx = state.findIndex(
		(message) => message.id === turnId && message.role === "user",
	);
	let assistantIdx =
		targetAssistantSeq === undefined
			? -1
			: state.findIndex(
					(message) =>
						message.role === "assistant" &&
						message.transcriptSeq === targetAssistantSeq,
				);
	if (assistantIdx === -1 && targetTurnId !== undefined) {
		assistantIdx = state.findIndex(
			(message) =>
				message.role === "assistant" && message.turnId === targetTurnId,
		);
	}
	if (assistantIdx === -1 && assistantId !== undefined) {
		assistantIdx = state.findIndex(
			(message) =>
				message.role === "assistant" &&
				message.id === assistantId &&
				// An explicit target must never attach to an unknown or newer turn.
				((targetTurnId === undefined && targetAssistantSeq === undefined) ||
					(targetTurnId !== undefined && message.turnId === targetTurnId) ||
					(targetAssistantSeq !== undefined &&
						message.transcriptSeq === targetAssistantSeq)),
		);
	}
	if (userIdx === -1 || assistantIdx === -1) return state;

	const selected = state[userIdx] as UserMessage;
	const targetAssistant = state[assistantIdx] as AssistantMessage;
	const correlatedTargetTurnId = targetTurnId ?? targetAssistant.turnId;
	const correlatedTargetSeq =
		targetAssistantSeq ?? targetAssistant.transcriptSeq;
	const acceptedToolEventIndex =
		selected.steerToolEventIndex ??
		steerToolEventIndex ??
		targetAssistant.toolEvents.length;
	const needsSteerPatch =
		(correlatedTargetTurnId !== undefined &&
			selected.steerTargetTurnId !== correlatedTargetTurnId) ||
		(correlatedTargetSeq !== undefined &&
			selected.steerTargetSeq !== correlatedTargetSeq) ||
		(steerSeq !== undefined && selected.transcriptSeq !== steerSeq) ||
		selected.steerToolEventIndex !== acceptedToolEventIndex;
	const steered: UserMessage = needsSteerPatch
		? {
				...selected,
				...(correlatedTargetTurnId !== undefined
					? { steerTargetTurnId: correlatedTargetTurnId }
					: {}),
				...(correlatedTargetSeq !== undefined
					? { steerTargetSeq: correlatedTargetSeq }
					: {}),
				...(steerSeq !== undefined ? { transcriptSeq: steerSeq } : {}),
				steerToolEventIndex: acceptedToolEventIndex,
			}
		: selected;
	const sharesTarget = (message: ChatMessage): message is UserMessage =>
		message.role === "user" &&
		message.id !== turnId &&
		((correlatedTargetSeq !== undefined &&
			message.steerTargetSeq === correlatedTargetSeq) ||
			(correlatedTargetTurnId !== undefined &&
				message.steerTargetTurnId === correlatedTargetTurnId));
	const group = state
		.flatMap((message, index) => {
			if (message.id === turnId && message.role === "user") {
				return [{ message: steered, index }];
			}
			return sharesTarget(message) ? [{ message, index }] : [];
		})
		.sort((left, right) => {
			const leftSeq = left.message.transcriptSeq;
			const rightSeq = right.message.transcriptSeq;
			if (
				leftSeq !== undefined &&
				rightSeq !== undefined &&
				leftSeq !== rightSeq
			) {
				return leftSeq - rightSeq;
			}
			return left.index - right.index;
		})
		.map(({ message }) => message);
	const groupedIds = new Set(group.map((message) => message.id));
	const without = state.filter(
		(message) => !(message.role === "user" && groupedIds.has(message.id)),
	);
	const targetIdx = without.findIndex(
		(message) =>
			message.role === "assistant" && message.id === state[assistantIdx].id,
	);
	if (targetIdx === -1) return state;
	const next = [
		...without.slice(0, targetIdx),
		...group,
		...without.slice(targetIdx),
	];
	return next.every((message, index) => message === state[index])
		? state
		: next;
}

/**
 * Replace the message matching id+role via `patch`. Returns the original
 * array (same reference, no re-render) when nothing matched.
 */
function patchMessage<R extends ChatMessage["role"]>(
	state: ChatMessage[],
	id: string,
	role: R,
	patch: (message: Extract<ChatMessage, { role: R }>) => ChatMessage,
): ChatMessage[] {
	let touched = false;
	const next = state.map((message) => {
		if (message.id !== id || message.role !== role) return message;
		const patched = patch(message as Extract<ChatMessage, { role: R }>);
		if (patched === message) return message;
		touched = true;
		return patched;
	});
	return touched ? next : state;
}

/**
 * Patch the ToolEventMessage matching toolUseId inside the assistant message
 * that holds it via `patch`. Returns the original array (same reference, no
 * re-render) when nothing matched.
 */
function patchToolEvent(
	state: ChatMessage[],
	toolUseId: string,
	patch: (event: ToolEventMessage) => ToolEventMessage,
): ChatMessage[] {
	let matched = false;
	const next = state.map((m) => {
		if (m.role !== "assistant") return m;
		let touched = false;
		const toolEvents = m.toolEvents.map((te) => {
			if (te.id !== toolUseId) return te;
			touched = true;
			return patch(te);
		});
		if (!touched) return m;
		matched = true;
		return { ...m, toolEvents };
	});
	return matched ? next : state;
}

const ACTIVE_SUBAGENT_STATUSES = new Set(["pending", "running", "paused"]);

/** Reconcile stale live cards after an idle/error status or reconnect. */
function settleActiveSubagents(
	state: ChatMessage[],
	endedAtMs: number,
): ChatMessage[] {
	let changed = false;
	const next = state.map((message) => {
		if (message.role !== "assistant") return message;
		let messageChanged = false;
		const toolEvents = message.toolEvents.map((event) => {
			if (
				!event.subagent ||
				!ACTIVE_SUBAGENT_STATUSES.has(event.subagent.status)
			) {
				return event;
			}
			changed = true;
			messageChanged = true;
			return {
				...event,
				subagent: {
					...event.subagent,
					status: "interrupted" as const,
					currentStep: "Parent turn is no longer running",
					endedAtMs,
				},
			};
		});
		return messageChanged ? { ...message, toolEvents } : message;
	});
	return changed ? next : state;
}

function historyItemToMessage(item: HistoryItem): ChatMessage {
	if (item.kind === "ask_user_question") {
		return {
			id: item.id,
			role: "ask_user_question",
			questions: item.questions,
			...(item.provenance ? { provenance: item.provenance } : {}),
			answers: item.answers,
			...(item.notes !== undefined ? { notes: item.notes } : {}),
		};
	}
	if (item.kind === "plan_proposal") {
		return {
			id: item.id,
			role: "plan_proposal",
			plan: item.plan,
			decision: VALID_PLAN_DECISIONS.has(item.decision as PlanProposalDecision)
				? (item.decision as PlanProposalDecision)
				: "pending",
			...(item.html_attachment_id
				? { htmlRelicId: item.html_attachment_id }
				: {}),
		};
	}
	if (item.kind === "permission") {
		return {
			id: item.tool_id,
			role: "permission",
			toolName: item.tool_name,
			title: "",
			displayName: item.display_name ?? undefined,
			decision: VALID_PERMISSION_DECISIONS.has(
				item.decision as PermissionMessage["decision"],
			)
				? (item.decision as PermissionMessage["decision"])
				: "pending",
		};
	}
	if (item.role === "user") {
		return {
			id: item.id,
			role: "user",
			text: item.text,
			attachments: item.attachments,
			...(item.seq !== undefined ? { transcriptSeq: item.seq } : {}),
			...(item.hasContextReceipt ? { hasContextReceipt: true } : {}),
			...(item.hasFileCheckpoint ? { hasFileCheckpoint: true } : {}),
			...(item.steerTargetSeq != null
				? { steerTargetSeq: item.steerTargetSeq }
				: {}),
			...(item.steerToolEventIndex != null
				? { steerToolEventIndex: item.steerToolEventIndex }
				: {}),
		};
	}
	if (item.role === "assistant") {
		return {
			id: item.id,
			role: "assistant",
			text: item.text,
			toolEvents: item.toolEvents ?? [],
			...(item.toolEventPage ? { toolEventPage: item.toolEventPage } : {}),
			streaming: false,
			cost: item.cost ?? null,
			...(item.costEstimated ? { costEstimated: true } : {}),
			recap: item.recap ?? undefined,
			dbId: item.dbId,
			...(item.seq !== undefined ? { transcriptSeq: item.seq } : {}),
		};
	}
	return {
		id: item.id,
		role: "assistant",
		text: typeof item.text === "string" ? item.text : "",
		toolEvents: [],
		streaming: false,
		cost: null,
	};
}

function sameToolEventPage(
	left: ToolEventPageMeta | undefined,
	right: ToolEventPageMeta | undefined,
): boolean {
	return (
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			left.total === right.total &&
			left.errorCount === right.errorCount &&
			left.hasEarlier === right.hasEarlier &&
			left.nextBeforeId === right.nextBeforeId)
	);
}

/**
 * A reconnect refreshes the authoritative suffix, but should not discard older
 * immutable pages the user already revealed. The server only marks settled,
 * page-safe responses with toolEventPage, so retaining their prefix cannot race
 * a live tool update.
 */
function preserveLoadedToolEventPage(
	previous: AssistantMessage,
	fresh: AssistantMessage,
): AssistantMessage {
	const page = fresh.toolEventPage;
	if (!page || previous.toolEvents.length <= fresh.toolEvents.length)
		return fresh;
	if (
		previous.toolEvents.length > page.total ||
		(previous.toolEventPage && previous.toolEventPage.total !== page.total) ||
		(!previous.toolEventPage && previous.toolEvents.length !== page.total)
	) {
		return fresh;
	}

	const previousIds = new Set(previous.toolEvents.map((event) => event.id));
	if (!fresh.toolEvents.every((event) => previousIds.has(event.id)))
		return fresh;
	const freshIds = new Set(fresh.toolEvents.map((event) => event.id));
	const retainedPrefix = previous.toolEvents.filter(
		(event) => !freshIds.has(event.id),
	);
	const toolEvents = [...retainedPrefix, ...fresh.toolEvents];
	if (toolEvents.length > page.total) return fresh;

	const priorPage = previous.toolEventPage;
	const toolEventPage: ToolEventPageMeta = {
		...page,
		hasEarlier: priorPage?.hasEarlier ?? toolEvents.length < page.total,
		nextBeforeId:
			priorPage?.nextBeforeId ??
			(toolEvents.length < page.total ? page.nextBeforeId : null),
	};
	return { ...fresh, toolEvents, toolEventPage };
}

function preserveLoadedToolEventPages(
	state: ChatMessage[],
	fresh: ChatMessage[],
): ChatMessage[] {
	const previousAssistants = new Map(
		state.flatMap((message) =>
			message.role === "assistant" ? [[message.id, message] as const] : [],
		),
	);
	return fresh.map((message) => {
		if (message.role !== "assistant" || !message.toolEventPage) return message;
		const previous = previousAssistants.get(message.id);
		return previous ? preserveLoadedToolEventPage(previous, message) : message;
	});
}

function orderPersistedSteers(state: ChatMessage[]): ChatMessage[] {
	const ordered = orderSteeredTranscript(state, {
		role: (message) => message.role,
		sequence: (message) =>
			message.role === "assistant" ? message.transcriptSeq : undefined,
		steerTargetSequence: (message) =>
			message.role === "user" ? message.steerTargetSeq : undefined,
	});
	const assistantBySequence = new Map<number, AssistantMessage>();
	for (const message of ordered) {
		if (message.role === "assistant" && message.transcriptSeq !== undefined) {
			assistantBySequence.set(message.transcriptSeq, message);
		}
	}
	let currentTurnId: string | undefined;
	let changed = false;
	const correlated = ordered.map((message) => {
		if (message.role === "user") {
			if (
				message.steerTargetSeq !== undefined &&
				message.steerToolEventIndex === undefined
			) {
				const target = assistantBySequence.get(message.steerTargetSeq);
				if (target) {
					changed = true;
					return {
						...message,
						// Legacy rows predate the durable boundary. Pin the receipt
						// after the tools restored with this history page so later
						// live tools cannot make it drift.
						steerToolEventIndex: target.toolEvents.length,
					};
				}
			}
			if (message.steerTargetSeq === undefined) currentTurnId = message.id;
			return message;
		}
		if (message.role !== "assistant") return message;
		const next =
			message.turnId === undefined && currentTurnId !== undefined
				? { ...message, turnId: currentTurnId }
				: message;
		if (next !== message) changed = true;
		currentTurnId = undefined;
		return next;
	});
	return changed ? correlated : ordered;
}

function messageKey(message: ChatMessage): string {
	return `${message.role}:${message.id}`;
}

/**
 * Add delayed interaction-card hydration without letting its older snapshot
 * reorder messages that have already been steered or promoted live.
 */
function hydrateHistory(
	state: ChatMessage[],
	items: HistoryItem[],
): ChatMessage[] {
	const hydrated = items.map(historyItemToMessage);
	const hydratedKeys = hydrated.map(messageKey);
	const merged = [...state];

	// key -> index in `merged`, kept in sync as items are spliced in so lookups
	// stay O(1) instead of rescanning `merged` (and recomputing keys) per item.
	const keyIndex = new Map<string, number>();
	merged.forEach((candidate, i) => {
		keyIndex.set(messageKey(candidate), i);
	});
	const reindexFrom = (from: number) => {
		for (let i = from; i < merged.length; i++) {
			keyIndex.set(messageKey(merged[i] as ChatMessage), i);
		}
	};

	let previousHydratedKey: string | null = null;

	for (let index = 0; index < hydrated.length; index++) {
		const message = hydrated[index] as ChatMessage;
		const key = hydratedKeys[index] as string;
		if (keyIndex.has(key)) {
			previousHydratedKey = key;
			continue;
		}

		let insertAt = 0;
		if (previousHydratedKey !== null) {
			const previousIndex = keyIndex.get(previousHydratedKey);
			insertAt =
				previousIndex === undefined ? merged.length : previousIndex + 1;
		} else {
			let nextIndex = -1;
			for (let j = index + 1; j < hydratedKeys.length; j++) {
				const candidateIndex = keyIndex.get(hydratedKeys[j] as string);
				if (candidateIndex !== undefined) {
					nextIndex = candidateIndex;
					break;
				}
			}
			insertAt = nextIndex === -1 ? 0 : nextIndex;
		}
		merged.splice(insertAt, 0, message);
		keyIndex.set(key, insertAt);
		reindexFrom(insertAt + 1);
		previousHydratedKey = key;
	}

	return orderPersistedSteers(merged);
}

export function reducer(state: ChatMessage[], action: Action): ChatMessage[] {
	switch (action.type) {
		case "ADD_USER":
			if (state.some((m) => m.role === "user" && m.id === action.id)) {
				return state;
			}
			{
				const user: UserMessage = {
					id: action.id,
					role: "user",
					text: action.text,
					attachments: action.attachments,
				};
				const correlatedAssistant = state.findIndex(
					(message) =>
						message.role === "assistant" && message.turnId === action.id,
				);
				return correlatedAssistant === -1
					? [...state, user]
					: [
							...state.slice(0, correlatedAssistant),
							user,
							...state.slice(correlatedAssistant),
						];
			}
		case "MARK_USER_CONTEXT_RECEIPT":
			return state.map((message) =>
				message.role === "user" && message.id === action.id
					? { ...message, hasContextReceipt: true }
					: message,
			);
		case "MARK_USER_FILE_CHECKPOINT":
			return state.map((message) =>
				message.role === "user" && message.id === action.id
					? { ...message, hasFileCheckpoint: true }
					: message,
			);
		case "REMOVE_USER":
			return state.filter((m) => !(m.id === action.id && m.role === "user"));
		case "PROMOTE_USER": {
			return promoteUser(state, action.turnId, action.pendingTurnIds);
		}
		case "STEER_USER":
			return steerUser(
				state,
				action.turnId,
				action.targetTurnId,
				action.targetAssistantSeq,
				action.steerSeq,
				action.steerToolEventIndex,
				action.assistantId,
			);
		case "ADD_ASSISTANT": {
			const placeholder: ChatMessage = {
				id: action.id,
				role: "assistant",
				...(action.afterUserId ? { turnId: action.afterUserId } : {}),
				text: "",
				toolEvents: [],
				streaming: true,
				cost: null,
			};
			if (action.afterUserId) {
				const idx = state.findIndex(
					(m) => m.id === action.afterUserId && m.role === "user",
				);
				if (idx !== -1) {
					return [
						...state.slice(0, idx + 1),
						placeholder,
						...state.slice(idx + 1),
					];
				}
			}
			return [...state, placeholder];
		}
		case "SET_ASSISTANT_TURN":
			return patchMessage(state, action.id, "assistant", (message) =>
				message.turnId === action.turnId
					? message
					: { ...message, turnId: action.turnId },
			);
		case "RESUME_ASSISTANT":
			return patchMessage(state, action.id, "assistant", (m) =>
				m.streaming ? m : { ...m, streaming: true },
			);
		case "APPEND_CHUNK":
			return patchMessage(state, action.id, "assistant", (m) => {
				if (action.offset === undefined) {
					return { ...m, text: m.text + action.text };
				}
				const consumed = m.text.length - action.offset;
				if (consumed >= action.text.length) return m;
				// A negative value means an earlier delta is missing. That should not
				// occur in a live stream, but appending the full chunk is safer than
				// silently dropping visible output if a legacy replay buffer was capped.
				const suffix = action.text.slice(Math.max(0, consumed));
				return { ...m, text: m.text + suffix };
			});
		case "REPLACE_TEXT":
			return patchMessage(state, action.id, "assistant", (m) =>
				m.text === action.text ? m : { ...m, text: action.text },
			);
		case "ADD_TOOL_EVENT":
			return patchMessage(state, action.id, "assistant", (m) =>
				m.toolEvents.some((event) => event.id === action.event.id)
					? m
					: { ...m, toolEvents: [...m.toolEvents, action.event] },
			);
		case "UPDATE_TOOL_EVENT":
			return patchToolEvent(state, action.toolUseId, (te) => ({
				...te,
				subagent: action.subagent,
			}));
		case "UPDATE_TOOL_ACTIVITY":
			return patchToolEvent(state, action.toolUseId, (te) => ({
				...te,
				taskActivity: action.taskActivity,
			}));
		case "ADD_TOOL_RESULT":
			return patchToolEvent(state, action.toolUseId, (te) => ({
				...te,
				result: action.content,
				resultTruncated: action.resultTruncated,
				resultLength: action.resultLength,
				detailSessionId: action.detailSessionId,
				...(action.isError !== undefined ? { isError: action.isError } : {}),
			}));
		case "PREPEND_TOOL_EVENT_PAGE":
			return patchMessage(state, action.id, "assistant", (message) => {
				const currentPage = message.toolEventPage;
				if (
					!currentPage ||
					currentPage.nextBeforeId !== action.expectedBeforeId ||
					currentPage.total !== action.page.total
				) {
					return message;
				}
				const existingIds = new Set(
					message.toolEvents.map((event) => event.id),
				);
				const earlier = action.events.filter((event) => {
					if (existingIds.has(event.id)) return false;
					existingIds.add(event.id);
					return true;
				});
				const toolEvents =
					earlier.length > 0
						? [...earlier, ...message.toolEvents]
						: message.toolEvents;
				const complete = toolEvents.length >= action.page.total;
				const toolEventPage: ToolEventPageMeta = complete
					? { ...action.page, hasEarlier: false, nextBeforeId: null }
					: action.page;
				if (
					toolEvents === message.toolEvents &&
					sameToolEventPage(currentPage, toolEventPage)
				) {
					return message;
				}
				return { ...message, toolEvents, toolEventPage };
			});
		case "SETTLE_ACTIVE_SUBAGENTS":
			return settleActiveSubagents(state, action.endedAtMs);
		case "ADD_LOCAL_COMMAND_OUTPUT":
			return [
				...state,
				{
					id: action.id,
					role: "local_command_output" as const,
					content: action.content,
				},
			];
		case "ADD_PLAN_PROPOSAL": {
			const patched = patchMessage(state, action.id, "plan_proposal", (m) => ({
				...m,
				plan: action.plan,
				decision: "pending",
				...(action.htmlRelicId ? { htmlRelicId: action.htmlRelicId } : {}),
			}));
			if (patched !== state) return patched;
			return [
				...state,
				{
					id: action.id,
					role: "plan_proposal" as const,
					plan: action.plan,
					decision: "pending" as const,
					...(action.htmlRelicId ? { htmlRelicId: action.htmlRelicId } : {}),
				},
			];
		}
		case "RESOLVE_PLAN_PROPOSAL":
			return patchMessage(state, action.id, "plan_proposal", (m) => ({
				...m,
				decision: action.decision,
			}));
		case "DONE":
			return patchMessage(state, action.id, "assistant", (m) => ({
				...m,
				streaming: false,
				cost: action.cost,
				costEstimated: action.costEstimated,
				...(action.dbId !== undefined ? { dbId: action.dbId } : {}),
			}));
		case "SET_RECAP":
			return patchMessage(state, action.id, "assistant", (m) => ({
				...m,
				recap: action.recap,
			}));
		case "ADD_PERMISSION":
			if (
				state.some(
					(message) =>
						message.role === "permission" && message.id === action.msg.id,
				)
			) {
				return state;
			}
			return [
				...state,
				{
					id: action.msg.id,
					role: "permission",
					toolName: action.msg.toolName,
					title: action.msg.title,
					displayName: action.msg.displayName,
					description: action.msg.description,
					input: action.msg.input,
					requester: action.msg.requester,
					policy: action.msg.policy,
					allowOnce: action.msg.allowOnce,
					allowAlways: action.msg.allowAlways,
					decision: "pending",
				},
			];
		case "RESOLVE_PERMISSION":
			return patchMessage(state, action.id, "permission", (m) => ({
				...m,
				decision: action.decision,
			}));
		case "RESOLVE_OR_ADD_PERMISSION": {
			const patched = patchMessage(state, action.id, "permission", (m) => ({
				...m,
				decision: action.decision,
			}));
			if (patched !== state) return patched;
			return [
				...state,
				{
					id: action.id,
					role: "permission" as const,
					toolName: action.toolName,
					title: "",
					displayName: action.displayName,
					decision: action.decision,
				},
			];
		}
		case "LOAD_HISTORY": {
			const loaded = orderPersistedSteers(
				action.items.map(historyItemToMessage),
			);
			return action.preserveToolEventPages
				? preserveLoadedToolEventPages(state, loaded)
				: loaded;
		}
		case "PREPEND_HISTORY": {
			const existing = new Set(state.map(messageKey));
			const older = action.items.map(historyItemToMessage).filter((message) => {
				const key = messageKey(message);
				if (existing.has(key)) return false;
				existing.add(key);
				return true;
			});
			return older.length > 0
				? orderPersistedSteers([...older, ...state])
				: state;
		}
		case "HYDRATE_HISTORY": {
			return hydrateHistory(state, action.items);
		}
		case "ADD_ASK_USER_QUESTION": {
			// Dedup: LOAD_HISTORY may have already hydrated this id from DB. The
			// WS server also re-emits pending questions on reconnect (see
			// wsHandlers.ts pending replay). Without this guard the same prompt
			// would render twice.
			const exists = state.some(
				(m) => m.id === action.id && m.role === "ask_user_question",
			);
			if (exists) return state;
			return [
				...state,
				{
					id: action.id,
					role: "ask_user_question" as const,
					questions: action.questions,
					...(action.provenance ? { provenance: action.provenance } : {}),
					answers: null,
				},
			];
		}
		case "RESOLVE_ASK_USER_QUESTION":
			return patchMessage(state, action.id, "ask_user_question", (m) => ({
				...m,
				answers: action.answers,
				...(action.notes !== undefined ? { notes: action.notes } : {}),
			}));
		case "CLEAR":
			return [];
		default:
			return state;
	}
}
