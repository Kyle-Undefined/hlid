import type {
	AskQuestion,
	AskUserQuestionAnswers,
	AskUserQuestionNotes,
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
};

export type AssistantMessage = {
	id: string;
	role: "assistant";
	text: string;
	toolEvents: ToolEventMessage[];
	streaming: boolean;
	cost: number | null;
	recap?: string;
};

export type PermissionMessage = {
	id: string;
	role: "permission";
	toolName: string;
	title: string;
	displayName?: string;
	description?: string;
	input?: Record<string, unknown>;
	decision: "pending" | PermissionDecision;
};

export type AskUserQuestionChatMessage = {
	id: string;
	role: "ask_user_question";
	questions: AskQuestion[];
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

export type Action =
	| {
			type: "ADD_USER";
			id: string;
			text: string;
			attachments?: ChatAttachment[];
	  }
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
	| { type: "APPEND_CHUNK"; id: string; text: string }
	| { type: "ADD_TOOL_EVENT"; id: string; event: ToolEventMessage }
	| {
			type: "UPDATE_TOOL_EVENT";
			toolUseId: string;
			subagent: NonNullable<ToolEventMessage["subagent"]>;
	  }
	| {
			type: "ADD_TOOL_RESULT";
			toolUseId: string;
			content: string;
			isError?: boolean;
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
	| { type: "DONE"; id: string; cost: number | null }
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
			items: Array<
				| {
						kind: "message";
						id: string;
						role: string;
						text: string;
						toolEvents?: ToolEventMessage[];
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
						answers: AskUserQuestionAnswers | null;
						notes?: AskUserQuestionNotes;
				  }
			>;
	  }
	| {
			type: "ADD_ASK_USER_QUESTION";
			id: string;
			questions: AskQuestion[];
	  }
	| {
			type: "RESOLVE_ASK_USER_QUESTION";
			id: string;
			answers: AskUserQuestionAnswers;
			notes?: AskUserQuestionNotes;
	  }
	| { type: "CLEAR" };

type HistoryItem = Extract<Action, { type: "LOAD_HISTORY" }>["items"][number];

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
		touched = true;
		return patch(message as Extract<ChatMessage, { role: R }>);
	});
	return touched ? next : state;
}

function historyItemToMessage(item: HistoryItem): ChatMessage {
	if (item.kind === "ask_user_question") {
		return {
			id: item.id,
			role: "ask_user_question",
			questions: item.questions,
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
		};
	}
	if (item.role === "assistant") {
		return {
			id: item.id,
			role: "assistant",
			text: item.text,
			toolEvents: item.toolEvents ?? [],
			streaming: false,
			cost: null,
			recap: item.recap ?? undefined,
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

export function reducer(state: ChatMessage[], action: Action): ChatMessage[] {
	switch (action.type) {
		case "ADD_USER":
			return [
				...state,
				{
					id: action.id,
					role: "user",
					text: action.text,
					attachments: action.attachments,
				},
			];
		case "REMOVE_USER":
			return state.filter((m) => !(m.id === action.id && m.role === "user"));
		case "PROMOTE_USER": {
			return promoteUser(state, action.turnId, action.pendingTurnIds);
		}
		case "ADD_ASSISTANT": {
			const placeholder: ChatMessage = {
				id: action.id,
				role: "assistant",
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
		case "APPEND_CHUNK":
			return patchMessage(state, action.id, "assistant", (m) => ({
				...m,
				text: m.text + action.text,
			}));
		case "ADD_TOOL_EVENT":
			return patchMessage(state, action.id, "assistant", (m) => ({
				...m,
				toolEvents: [...m.toolEvents, action.event],
			}));
		case "UPDATE_TOOL_EVENT": {
			let matched = false;
			const next = state.map((m) => {
				if (m.role !== "assistant") return m;
				let touched = false;
				const toolEvents = m.toolEvents.map((te) => {
					if (te.id !== action.toolUseId) return te;
					matched = true;
					touched = true;
					return { ...te, subagent: action.subagent };
				});
				return touched ? { ...m, toolEvents } : m;
			});
			return matched ? next : state;
		}
		case "ADD_TOOL_RESULT": {
			let matched = false;
			const next = state.map((m) => {
				if (m.role !== "assistant") return m;
				let touched = false;
				const toolEvents = m.toolEvents.map((te) => {
					if (te.id !== action.toolUseId) return te;
					touched = true;
					return {
						...te,
						result: action.content,
						...(action.isError !== undefined
							? { isError: action.isError }
							: {}),
					};
				});
				if (!touched) return m;
				matched = true;
				return { ...m, toolEvents };
			});
			return matched ? next : state;
		}
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
			}));
		case "SET_RECAP":
			return patchMessage(state, action.id, "assistant", (m) => ({
				...m,
				recap: action.recap,
			}));
		case "ADD_PERMISSION":
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
		case "LOAD_HISTORY":
			return action.items.map(historyItemToMessage);
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
