import type {
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

export type ChatMessage = UserMessage | AssistantMessage | PermissionMessage;

export type Action =
	| {
			type: "ADD_USER";
			id: string;
			text: string;
			attachments?: ChatAttachment[];
	  }
	| { type: "ADD_ASSISTANT"; id: string }
	| { type: "APPEND_CHUNK"; id: string; text: string }
	| { type: "ADD_TOOL_EVENT"; id: string; event: ToolEventMessage }
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
			>;
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
		case "ADD_ASSISTANT":
			return [
				...state,
				{
					id: action.id,
					role: "assistant",
					text: "",
					toolEvents: [],
					streaming: true,
					cost: null,
				},
			];
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
				"allow_once",
				"allow_always",
				"deny_once",
				"deny_always",
			]);
			return action.items.map((item): ChatMessage => {
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
		case "CLEAR":
			return [];
		default:
			return state;
	}
}
