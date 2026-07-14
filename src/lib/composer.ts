import type { QueuedChatMessage } from "#/hooks/wsChatQueueStore";
import type { ChatAttachment, ClientChatMessage } from "#/server/protocol";

export type ComposerKeyAction =
	| "picker-next"
	| "picker-previous"
	| "picker-close"
	| "picker-select"
	| "submit"
	| null;

export function composerKeyAction(input: {
	key: string;
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	pickerOpen: boolean;
	isTouch: boolean;
	enterToSubmit: boolean;
}): ComposerKeyAction {
	if (input.pickerOpen) {
		if (input.key === "ArrowDown") return "picker-next";
		if (input.key === "ArrowUp") return "picker-previous";
		if (input.key === "Escape") return "picker-close";
		if (input.key === "Tab") return "picker-select";
		if (
			input.key === "Enter" &&
			!input.shiftKey &&
			!input.metaKey &&
			!input.ctrlKey
		) {
			return "picker-select";
		}
	}
	if (input.key !== "Enter" || input.shiftKey) return null;
	if (input.metaKey || input.ctrlKey) return "submit";
	if (!input.isTouch && input.enterToSubmit) return "submit";
	return null;
}

export function insertAtSelection(
	value: string,
	text: string,
	start = value.length,
	end = start,
): string {
	const safeStart = Math.max(0, Math.min(start, value.length));
	const safeEnd = Math.max(safeStart, Math.min(end, value.length));
	const before = value.slice(0, safeStart);
	const after = value.slice(safeEnd);
	const separator = before && !/\s$/.test(before) ? " " : "";
	return `${before}${separator}${text}${after}`;
}

export function resizeComposer(
	element: { scrollHeight: number; style: { height: string } } | null,
	maxHeight: number,
): void {
	if (!element) return;
	element.style.height = "auto";
	element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
}

/**
 * Keep an expanding composer inside the currently visible viewport. Mobile
 * landscape and installed-PWA keyboard transitions can leave far less height
 * than their width suggests, so a width-only 240px cap can push the input row
 * below an overflow-hidden chat shell.
 */
export function responsiveComposerMaxHeight(
	viewportWidth: number,
	viewportHeight: number,
): number {
	const mobile = viewportWidth < 768;
	const fixedMax = mobile ? 240 : 480;
	const viewportShare = mobile ? 0.35 : 0.5;
	return Math.max(
		60,
		Math.min(fixedMax, Math.floor(viewportHeight * viewportShare)),
	);
}

export type ChatSubmission =
	| { kind: "queued"; message: QueuedChatMessage }
	| {
			kind: "immediate";
			user: { id: string; text: string; attachments: ChatAttachment[] };
			message: ClientChatMessage;
			marksAgentContextSent: boolean;
	  };

export function prepareChatSubmission(input: {
	id: string;
	text: string;
	sessionId: string;
	running: boolean;
	skillContext?: string;
	attachments: ChatAttachment[];
	agentCwd?: string;
	agentContextAlreadySent: boolean;
	planMode: boolean;
	planHtml: boolean;
	provider?: string;
	model?: string;
	effort?: string;
	permissionMode?: string;
}): ChatSubmission | null {
	if (!input.text && input.attachments.length === 0) return null;
	const attachments =
		input.attachments.length > 0 ? [...input.attachments] : undefined;
	if (input.running) {
		return {
			kind: "queued",
			message: {
				id: input.id,
				text: input.text,
				session_id: input.sessionId,
				skill_context: input.skillContext,
				attachments,
				agent_cwd: input.agentCwd,
				plan_mode: input.planMode || undefined,
				plan_html: (input.planMode && input.planHtml) || undefined,
				...(input.provider ? { provider: input.provider } : {}),
				...(input.model ? { model: input.model } : {}),
				...(input.effort ? { effort: input.effort } : {}),
				...(input.permissionMode
					? { permission_mode: input.permissionMode }
					: {}),
			},
		};
	}

	const agentCwd =
		input.agentCwd && !input.agentContextAlreadySent
			? input.agentCwd
			: undefined;
	return {
		kind: "immediate",
		user: { id: input.id, text: input.text, attachments: input.attachments },
		message: {
			type: "chat",
			text: input.text,
			session_id: input.sessionId,
			skill_context: input.skillContext,
			attachments,
			agent_cwd: agentCwd,
			plan_mode: input.planMode || undefined,
			plan_html: (input.planMode && input.planHtml) || undefined,
			...(input.provider ? { provider: input.provider } : {}),
			...(input.model ? { model: input.model } : {}),
			...(input.effort ? { effort: input.effort } : {}),
			...(input.permissionMode
				? { permission_mode: input.permissionMode }
				: {}),
		},
		marksAgentContextSent: agentCwd !== undefined,
	};
}
