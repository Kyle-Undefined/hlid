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
};

export type ChatMessage =
	| UserMessage
	| AssistantMessage
	| PermissionMessage
	| AskUserQuestionChatMessage
	| PlanProposalMessage;

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
			type: "ADD_TOOL_RESULT";
			toolUseId: string;
			content: string;
			isError?: boolean;
	  }
	| { type: "ADD_PLAN_PROPOSAL"; id: string; plan: string }
	| {
			type: "RESOLVE_PLAN_PROPOSAL";
			id: string;
			decision: Exclude<PlanProposalDecision, "pending">;
	  }
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
			const { turnId, pendingTurnIds } = action;
			const promotedIdx = state.findIndex(
				(m) => m.id === turnId && m.role === "user",
			);
			if (promotedIdx === -1) return state;
			// Find earliest pending-and-not-promoted user msg → that's where
			// the promoted msg should land (right before it).
			const targetIdx = state.findIndex(
				(m) =>
					m.role === "user" && m.id !== turnId && pendingTurnIds.includes(m.id),
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
			return state.map((m) => {
				if (m.id !== action.id || m.role !== "assistant") return m;
				return { ...m, text: m.text + action.text };
			});
		case "ADD_TOOL_EVENT":
			return state.map((m) =>
				m.id === action.id && m.role === "assistant"
					? { ...m, toolEvents: [...m.toolEvents, action.event] }
					: m,
			);
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
		case "ADD_PLAN_PROPOSAL":
			return [
				...state,
				{
					id: action.id,
					role: "plan_proposal" as const,
					plan: action.plan,
					decision: "pending" as const,
				},
			];
		case "RESOLVE_PLAN_PROPOSAL": {
			const exists = state.some(
				(m) => m.id === action.id && m.role === "plan_proposal",
			);
			if (!exists) return state;
			return state.map((m) =>
				m.id === action.id && m.role === "plan_proposal"
					? { ...m, decision: action.decision }
					: m,
			);
		}
		case "DONE":
			return state.map((m) =>
				m.id === action.id && m.role === "assistant"
					? { ...m, streaming: false, cost: action.cost }
					: m,
			);
		case "SET_RECAP":
			return state.map((m) =>
				m.id === action.id && m.role === "assistant"
					? { ...m, recap: action.recap }
					: m,
			);
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
			return state.map((m) =>
				m.id === action.id && m.role === "permission"
					? { ...m, decision: action.decision }
					: m,
			);
		case "RESOLVE_OR_ADD_PERMISSION": {
			const exists = state.some(
				(m) => m.id === action.id && m.role === "permission",
			);
			if (exists) {
				return state.map((m) =>
					m.id === action.id && m.role === "permission"
						? { ...m, decision: action.decision }
						: m,
				);
			}
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
			const validDecisions = new Set<PermissionMessage["decision"]>([
				"pending",
				"approved",
				"approved_session",
				"approved_always",
				"denied",
			]);
			const validPlanDecisions = new Set<PlanProposalDecision>([
				"pending",
				"approved",
				"edited",
				"cancelled",
			]);
			return action.items.map((item): ChatMessage => {
				if (item.kind === "plan_proposal") {
					const decision = validPlanDecisions.has(
						item.decision as PlanProposalDecision,
					)
						? (item.decision as PlanProposalDecision)
						: "pending";
					return {
						id: item.id,
						role: "plan_proposal",
						plan: item.plan,
						decision,
					};
				}
				if (item.kind === "permission") {
					const decision = validDecisions.has(
						item.decision as PermissionMessage["decision"],
					)
						? (item.decision as PermissionMessage["decision"])
						: "pending";
					return {
						id: item.tool_id,
						role: "permission",
						toolName: item.tool_name,
						title: "",
						displayName: item.display_name ?? undefined,
						decision,
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
				// Unknown role — normalize to assistant to avoid silent breakage
				return {
					id: item.id,
					role: "assistant",
					text: typeof item.text === "string" ? item.text : "",
					toolEvents: [],
					streaming: false,
					cost: null,
				};
			});
		}
		case "ADD_ASK_USER_QUESTION":
			return [
				...state,
				{
					id: action.id,
					role: "ask_user_question" as const,
					questions: action.questions,
					answers: null,
				},
			];
		case "RESOLVE_ASK_USER_QUESTION":
			return state.map((m) =>
				m.id === action.id && m.role === "ask_user_question"
					? {
							...m,
							answers: action.answers,
							...(action.notes !== undefined ? { notes: action.notes } : {}),
						}
					: m,
			);
		case "CLEAR":
			return [];
		default:
			return state;
	}
}
